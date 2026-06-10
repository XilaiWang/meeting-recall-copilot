// Why: full route + middleware coverage with real PostgreSQL — same pattern
// as license.test.ts. Each test gets a fresh user; beforeEach cleans up
// all rows created by this test file so tests never bleed into each other.
import 'dotenv/config';

import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { like, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users, surveyResponses } from '../db/schema.js';
import { hashPassword, signAccessToken } from '../services/auth-service.js';
import { surveyRoutes } from './survey.js';

const TEST_EMAIL_PREFIX = 'survey-route-test-';

interface Envelope<T = unknown> {
  ok: boolean;
  data: T | null;
  error: { code: string; message: string } | null;
}

function makeApp() {
  const app = new Hono();
  app.route('/v1/survey', surveyRoutes);
  return app;
}

async function createTestUser() {
  const email = `${TEST_EMAIL_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const passwordHash = await hashPassword('test-pass-12345');
  const [user] = await db.insert(users).values({ email, passwordHash }).returning();
  if (!user) throw new Error('failed to insert test user');
  return user;
}

async function tokenFor(userId: string, email: string) {
  return signAccessToken({ sub: userId, email, licenseStatus: 'none' });
}

const validPayload = {
  projectId: '11111111-1111-1111-1111-111111111111',
  meetingDate: '2026-05-15',
  outcome: 'went_well' as const,
  cardHelpful: 'used_helpful' as const,
  willUseNext: 'definitely' as const,
};

describe('routes/survey', () => {
  beforeEach(async () => {
    const testUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(like(users.email, `${TEST_EMAIL_PREFIX}%`));
    const userIds = testUsers.map((u) => u.id);

    if (userIds.length > 0) {
      await db.delete(surveyResponses).where(inArray(surveyResponses.userId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
  });

  // ---------- Auth gating ----------

  it('401 TOKEN_INVALID without bearer token', async () => {
    const app = makeApp();
    const res = await app.request('/v1/survey/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validPayload),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Envelope;
    expect(body).toMatchObject({ ok: false, error: { code: 'TOKEN_INVALID' } });
  });

  // ---------- Validation ----------

  it('400 VALIDATION_ERROR on missing required fields', async () => {
    const user = await createTestUser();
    const token = await tokenFor(user.id, user.email);
    const app = makeApp();
    const res = await app.request('/v1/survey/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ projectId: validPayload.projectId }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Envelope;
    expect(body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('400 VALIDATION_ERROR on invalid outcome value', async () => {
    const user = await createTestUser();
    const token = await tokenFor(user.id, user.email);
    const app = makeApp();
    const res = await app.request('/v1/survey/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ ...validPayload, outcome: 'won_the_lottery' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Envelope;
    expect(body.error?.code).toBe('VALIDATION_ERROR');
  });

  // ---------- Happy path ----------

  it('200 submitted:true on valid payload', async () => {
    const user = await createTestUser();
    const token = await tokenFor(user.id, user.email);
    const app = makeApp();
    const res = await app.request('/v1/survey/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(validPayload),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<{ submitted: boolean }>;
    expect(body).toMatchObject({ ok: true, data: { submitted: true }, error: null });
  });

  it('200 accepts optional companyNameHash and freeText', async () => {
    const user = await createTestUser();
    const token = await tokenFor(user.id, user.email);
    const app = makeApp();
    const res = await app.request('/v1/survey/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        ...validPayload,
        companyNameHash: 'a'.repeat(64),
        freeText: '会议很顺利，卡片帮助很大',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<{ submitted: boolean }>;
    expect(body.data?.submitted).toBe(true);
  });

  // ---------- Duplicate ----------

  it('409 DUPLICATE_SURVEY on same user + project + date', async () => {
    const user = await createTestUser();
    const token = await tokenFor(user.id, user.email);
    const app = makeApp();
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };

    const r1 = await app.request('/v1/survey/submit', {
      method: 'POST',
      headers,
      body: JSON.stringify(validPayload),
    });
    expect(r1.status).toBe(200);

    const r2 = await app.request('/v1/survey/submit', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...validPayload, willUseNext: 'maybe' }),
    });
    expect(r2.status).toBe(409);
    const body = (await r2.json()) as Envelope;
    expect(body.error?.code).toBe('DUPLICATE_SURVEY');
  });

  it('200 allows same user to submit for a different meeting date', async () => {
    const user = await createTestUser();
    const token = await tokenFor(user.id, user.email);
    const app = makeApp();
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };

    const r1 = await app.request('/v1/survey/submit', {
      method: 'POST',
      headers,
      body: JSON.stringify(validPayload),
    });
    expect(r1.status).toBe(200);

    const r2 = await app.request('/v1/survey/submit', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...validPayload, meetingDate: '2026-05-20' }),
    });
    expect(r2.status).toBe(200);
  });
});
