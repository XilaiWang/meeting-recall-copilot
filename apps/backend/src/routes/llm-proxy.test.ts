// Why: LLM vendor calls are mocked via vi.spyOn(global, 'fetch') so tests
// run without real API keys and don't burn quota. DB operations (quota
// check, proxy_calls insert) hit the real test PostgreSQL — same pattern
// as other route tests in this file tree.
import 'dotenv/config';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { eq, like, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users, proxyCalls } from '../db/schema.js';
import { hashPassword, signAccessToken } from '../services/auth-service.js';
import { llmProxyRoutes } from './llm-proxy.js';
import { COLD_START_QUOTA_MAX } from '@qa-matching/shared/constants';

const TEST_EMAIL_PREFIX = 'llm-proxy-test-';

interface Envelope<T = unknown> {
  ok: boolean;
  data: T | null;
  error: { code: string; message: string } | null;
}

function makeApp() {
  const app = new Hono();
  app.route('/v1/llm', llmProxyRoutes);
  return app;
}

async function createTestUser(quotaUsed = 0) {
  const email = `${TEST_EMAIL_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const passwordHash = await hashPassword('test-pass-12345');
  const [user] = await db
    .insert(users)
    .values({ email, passwordHash, coldStartQuotaUsed: quotaUsed })
    .returning();
  if (!user) throw new Error('failed to insert test user');
  return user;
}

async function tokenFor(userId: string, email: string) {
  return signAccessToken({ sub: userId, email, licenseStatus: 'none' });
}

// Why: returns a minimal fetch mock that looks like a successful Anthropic response.
function mockAnthropicSuccess(content = 'Mocked LLM response') {
  return vi.spyOn(global, 'fetch').mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        content: [{ type: 'text', text: content }],
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
}

function mockVendorFailure(status = 500) {
  return vi.spyOn(global, 'fetch').mockResolvedValueOnce(
    new Response('Internal Server Error', { status }),
  );
}

describe('routes/llm-proxy', () => {
  beforeEach(async () => {
    const testUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(like(users.email, `${TEST_EMAIL_PREFIX}%`));
    const userIds = testUsers.map((u) => u.id);
    if (userIds.length > 0) {
      await db.delete(proxyCalls).where(inArray(proxyCalls.userId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------- Auth ----------

  it('401 TOKEN_INVALID without bearer token', async () => {
    const app = makeApp();
    const res = await app.request('/v1/llm/proxy/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Envelope;
    expect(body.error?.code).toBe('TOKEN_INVALID');
  });

  // ---------- Validation ----------

  it('400 VALIDATION_ERROR on empty prompt', async () => {
    const user = await createTestUser();
    const token = await tokenFor(user.id, user.email);
    const app = makeApp();
    const res = await app.request('/v1/llm/proxy/extract', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ prompt: '' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Envelope;
    expect(body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('400 VALIDATION_ERROR when maxTokens exceeds 8000', async () => {
    const user = await createTestUser();
    const token = await tokenFor(user.id, user.email);
    const app = makeApp();
    const res = await app.request('/v1/llm/proxy/extract', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ prompt: 'test', maxTokens: 9000 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Envelope;
    expect(body.error?.code).toBe('VALIDATION_ERROR');
  });

  // ---------- Quota exceeded ----------

  it('422 QUOTA_EXCEEDED when user has used all quota', async () => {
    const user = await createTestUser(COLD_START_QUOTA_MAX);
    const token = await tokenFor(user.id, user.email);
    const app = makeApp();
    const res = await app.request('/v1/llm/proxy/extract', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ prompt: 'extract my project details' }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as Envelope;
    expect(body.error?.code).toBe('QUOTA_EXCEEDED');
  });

  // ---------- Happy path ----------

  it('200 returns content + usage + remainingQuota on success', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mockAnthropicSuccess('Here are your project cards: ...');

    const user = await createTestUser(0);
    const token = await tokenFor(user.id, user.email);
    const app = makeApp();
    const res = await app.request('/v1/llm/proxy/extract', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ prompt: 'extract my project details' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<{
      content: string;
      usage: { inputTokens: number; outputTokens: number };
      remainingQuota: number;
    }>;
    expect(body.ok).toBe(true);
    expect(body.data?.content).toBe('Here are your project cards: ...');
    expect(body.data?.usage.inputTokens).toBe(100);
    expect(body.data?.usage.outputTokens).toBe(50);
    expect(body.data?.remainingQuota).toBe(COLD_START_QUOTA_MAX - 1);

    // Verify quota was decremented in DB
    const [updated] = await db.select({ q: users.coldStartQuotaUsed }).from(users).where(eq(users.id, user.id));
    expect(updated?.q).toBe(1);

    // Verify proxy_calls row was inserted
    const calls = await db.select().from(proxyCalls).where(eq(proxyCalls.userId, user.id));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe('success');
    expect(calls[0]?.inputTokens).toBe(100);
  });

  // ---------- Vendor failure ----------

  it('503 VENDOR_ERROR when LLM returns non-ok and quota is compensated', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mockVendorFailure(500);

    const user = await createTestUser(0);
    const token = await tokenFor(user.id, user.email);
    const app = makeApp();
    const res = await app.request('/v1/llm/proxy/extract', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ prompt: 'extract my project details' }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as Envelope;
    expect(body.error?.code).toBe('VENDOR_ERROR');

    // Quota must be compensated back to 0
    const [updated] = await db.select({ q: users.coldStartQuotaUsed }).from(users).where(eq(users.id, user.id));
    expect(updated?.q).toBe(0);

    // Failed call is logged
    const calls = await db.select().from(proxyCalls).where(eq(proxyCalls.userId, user.id));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe('failed');
  });
});
