// Why: tests rotateRefreshToken — the Day-3 addition with non-trivial branching
// and transactional semantics. Uses real PostgreSQL because SELECT ... FOR UPDATE
// + drizzle transaction behavior is the actual SUT; mocking it would test mocks.
//
// Requires `DATABASE_URL` and `JWT_ACCESS_SECRET` in the env (loaded from .env).
import 'dotenv/config';

import { describe, it, expect, beforeEach } from 'vitest';
import { eq, like, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users, refreshTokens, licenses } from '../db/schema.js';
import {
  rotateRefreshToken,
  InvalidRefreshTokenError,
  hashPassword,
  generateRefreshToken,
  verifyAccessToken,
} from './auth-service.js';

const TEST_EMAIL_PREFIX = 'rotate-test-';

async function createUserWithRefresh(opts: { revoked?: boolean; expiresAt?: Date } = {}) {
  const email = `${TEST_EMAIL_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const passwordHash = await hashPassword('test-pass-12345');
  const [user] = await db.insert(users).values({ email, passwordHash }).returning();
  if (!user) throw new Error('failed to insert test user');

  const token = generateRefreshToken();
  await db.insert(refreshTokens).values({
    userId: user.id,
    token,
    revoked: opts.revoked ?? false,
    expiresAt: opts.expiresAt ?? new Date(Date.now() + 30 * 24 * 3600 * 1000),
  });
  return { user, token };
}

// Why: seed a license row so we can assert the rotated access token reflects the
// user's REAL license status — regression guard against the old hardcoded 'none'.
async function seedLicense(
  userId: string,
  status: 'active' | 'expired' | 'pending' = 'active',
  expiresAt: Date | null = null,
) {
  const key = `TESTKEY-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`.slice(0, 32);
  await db.insert(licenses).values({ key, userId, status, purchasedAt: new Date(), expiresAt });
}

describe('rotateRefreshToken', () => {
  beforeEach(async () => {
    // Clean only rows this test file created
    const testUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(like(users.email, `${TEST_EMAIL_PREFIX}%`));
    const ids = testUsers.map((u) => u.id);
    if (ids.length > 0) {
      await db.delete(refreshTokens).where(inArray(refreshTokens.userId, ids));
      // licenses.userId has no ON DELETE CASCADE, so clear it before users.
      await db.delete(licenses).where(inArray(licenses.userId, ids));
      await db.delete(users).where(inArray(users.id, ids));
    }
  });

  it('rotates valid refresh: returns new pair, marks old revoked', async () => {
    const { user, token } = await createUserWithRefresh();
    const result = await rotateRefreshToken(token);

    expect(result.userId).toBe(user.id);
    expect(result.refreshToken).not.toBe(token);
    expect(result.refreshToken).toMatch(/^[0-9a-f-]+-[0-9a-f-]+$/);
    expect(result.accessToken.split('.')).toHaveLength(3);

    const oldRow = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.token, token))
      .limit(1);
    expect(oldRow[0]?.revoked).toBe(true);

    const newRow = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.token, result.refreshToken))
      .limit(1);
    expect(newRow[0]).toBeDefined();
    expect(newRow[0]?.userId).toBe(user.id);
    expect(newRow[0]?.revoked).toBe(false);

    const payload = await verifyAccessToken(result.accessToken);
    expect(payload.sub).toBe(user.id);
    expect(payload.email).toBe(user.email);
  });

  it('throws InvalidRefreshTokenError("not_found") for unknown token', async () => {
    const unknown = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
    await expect(rotateRefreshToken(unknown)).rejects.toMatchObject({
      name: 'InvalidRefreshTokenError',
      reason: 'not_found',
    });
  });

  it('throws InvalidRefreshTokenError("reuse_detected") when a revoked token is presented', async () => {
    // Why: a legit client only ever holds the newest token in the chain, so a
    // revoked token coming back signals replay/theft — reuse detection (#20),
    // not a plain "revoked".
    const { token } = await createUserWithRefresh({ revoked: true });
    await expect(rotateRefreshToken(token)).rejects.toMatchObject({
      name: 'InvalidRefreshTokenError',
      reason: 'reuse_detected',
    });
  });

  it('reuse detection revokes the whole token family, not just the reused token', async () => {
    // Why: cutting off only the replayed token leaves any forked attacker session
    // alive. RTRD must revoke every token sharing the lineage (family).
    const email = `${TEST_EMAIL_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const passwordHash = await hashPassword('test-pass-12345');
    const [user] = await db.insert(users).values({ email, passwordHash }).returning();
    if (!user) throw new Error('failed to insert test user');

    const family = crypto.randomUUID();
    const reusedToken = generateRefreshToken();
    const siblingToken = generateRefreshToken();
    const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    await db.insert(refreshTokens).values([
      { userId: user.id, token: reusedToken, family, revoked: true, expiresAt },
      { userId: user.id, token: siblingToken, family, revoked: false, expiresAt },
    ]);

    await expect(rotateRefreshToken(reusedToken)).rejects.toMatchObject({
      name: 'InvalidRefreshTokenError',
      reason: 'reuse_detected',
    });

    // The active sibling in the same family must also be revoked — the whole point
    // of reuse detection. (Regression guard: throwing inside the tx must not roll
    // this write back.)
    const sibling = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.token, siblingToken))
      .limit(1);
    expect(sibling[0]?.revoked).toBe(true);
  });

  it('throws InvalidRefreshTokenError("expired") for past expiresAt', async () => {
    const { token } = await createUserWithRefresh({
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(rotateRefreshToken(token)).rejects.toMatchObject({
      name: 'InvalidRefreshTokenError',
      reason: 'expired',
    });
  });

  it('typed error is an InvalidRefreshTokenError instance', async () => {
    try {
      await rotateRefreshToken('definitely-not-a-real-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidRefreshTokenError);
    }
  });

  it('reflects an active license in the new access token licenseStatus claim', async () => {
    // Why: rotate previously hardcoded licenseStatus:'none' (Day-4 TODO), which
    // silently downgraded active users on refresh and disabled offline-grace.
    // Guard that a real active license now surfaces as 'active' in the claim.
    const { user, token } = await createUserWithRefresh();
    await seedLicense(user.id, 'active');

    const result = await rotateRefreshToken(token);
    const payload = await verifyAccessToken(result.accessToken);
    expect(payload.licenseStatus).toBe('active');
  });

  it("defaults licenseStatus to 'none' when the user has no license", async () => {
    // Why: complements the active-license guard — confirm the claim isn't blindly
    // forced to 'active' either; a user without a license must stay 'none'.
    const { token } = await createUserWithRefresh();
    const result = await rotateRefreshToken(token);
    const payload = await verifyAccessToken(result.accessToken);
    expect(payload.licenseStatus).toBe('none');
  });
});
