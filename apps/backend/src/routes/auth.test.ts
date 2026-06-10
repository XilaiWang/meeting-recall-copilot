import 'dotenv/config';

import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { like, inArray, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users, refreshTokens } from '../db/schema.js';
import { hashPassword, generateRefreshToken } from '../services/auth-service.js';
import { authRoutes } from './auth.js';
import { REFRESH_TOKEN_TTL } from '@qa-matching/shared/constants';

const TEST_EMAIL_PREFIX = 'auth-route-test-';

interface Envelope<T = unknown> {
  ok: boolean;
  data: T | null;
  error: { code: string; message: string } | null;
}

function makeApp() {
  const app = new Hono();
  app.route('/v1/auth', authRoutes);
  return app;
}

async function createTestUser() {
  const email = `${TEST_EMAIL_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const passwordHash = await hashPassword('TestPass1');
  const [user] = await db.insert(users).values({ email, passwordHash }).returning();
  if (!user) throw new Error('failed to insert test user');
  return user;
}

async function createRefreshToken(userId: string, opts: { revoked?: boolean } = {}) {
  const token = generateRefreshToken();
  const [row] = await db
    .insert(refreshTokens)
    .values({
      userId,
      token,
      revoked: opts.revoked ?? false,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL * 1000),
    })
    .returning();
  if (!row) throw new Error('failed to insert refresh token');
  return row;
}

describe('routes/auth', () => {
  beforeEach(async () => {
    const testUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(like(users.email, `${TEST_EMAIL_PREFIX}%`));
    const userIds = testUsers.map((u) => u.id);
    if (userIds.length > 0) {
      await db.delete(refreshTokens).where(inArray(refreshTokens.userId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
  });

  // ---------- POST /logout ----------

  describe('POST /v1/auth/logout', () => {
    it('200 loggedOut:true for a valid refresh token', async () => {
      const user = await createTestUser();
      const rt = await createRefreshToken(user.id);
      const app = makeApp();

      const res = await app.request('/v1/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt.token }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Envelope<{ loggedOut: boolean }>;
      expect(body).toMatchObject({ ok: true, data: { loggedOut: true }, error: null });

      // Token must be revoked in DB
      const [row] = await db.select().from(refreshTokens).where(eq(refreshTokens.id, rt.id));
      expect(row?.revoked).toBe(true);
    });

    it('200 idempotent: already-revoked token still returns loggedOut:true', async () => {
      const user = await createTestUser();
      const rt = await createRefreshToken(user.id, { revoked: true });
      const app = makeApp();

      const res = await app.request('/v1/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt.token }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Envelope<{ loggedOut: boolean }>;
      expect(body.data?.loggedOut).toBe(true);
    });

    it('200 for a token that does not exist in DB', async () => {
      const app = makeApp();
      const fakeToken = `${crypto.randomUUID()}-${crypto.randomUUID()}`;

      const res = await app.request('/v1/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: fakeToken }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Envelope<{ loggedOut: boolean }>;
      expect(body.data?.loggedOut).toBe(true);
    });

    it('400 VALIDATION_ERROR when refreshToken is too short', async () => {
      const app = makeApp();
      const res = await app.request('/v1/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: 'too-short' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Envelope;
      expect(body.error?.code).toBe('VALIDATION_ERROR');
    });

    it('revoked token cannot be used to refresh after logout', async () => {
      const user = await createTestUser();
      const rt = await createRefreshToken(user.id);
      const app = makeApp();

      await app.request('/v1/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt.token }),
      });

      const refreshRes = await app.request('/v1/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt.token }),
      });
      expect(refreshRes.status).toBe(401);
    });
  });
});
