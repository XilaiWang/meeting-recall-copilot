import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users, refreshTokens, type User } from '../db/schema.js';
import {
  hashPassword,
  verifyPassword,
  needsRehash,
  signAccessToken,
  generateRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  InvalidRefreshTokenError,
} from '../services/auth-service.js';
import { signupSchema, loginSchema, refreshSchema } from '@qa-matching/shared/schemas';
import { REFRESH_TOKEN_TTL } from '@qa-matching/shared/constants';
import { envelopeValidationHook } from '../lib/validation-hook.js';
import { isPgUniqueViolation } from '../lib/pg-errors.js';
import { ipRateLimit } from '../middleware/rate-limit.js';
import { resolveUserLicenseStatus } from '../services/license-service.js';

// Limits per 3.4 §5: signup 5/IP/min, login 10/IP/min, refresh 60/IP/h.
const signupLimit = ipRateLimit({ max: 5, windowMs: 60_000, prefix: 'signup' });
const loginLimit = ipRateLimit({ max: 10, windowMs: 60_000, prefix: 'login' });
const refreshLimit = ipRateLimit({ max: 60, windowMs: 60 * 60_000, prefix: 'refresh' });

export const authRoutes = new Hono();

authRoutes.post('/signup', signupLimit, zValidator('json', signupSchema, envelopeValidationHook), async (c) => {
  const { email, password, displayName } = c.req.valid('json');

  // Check uniqueness (best-effort; the DB constraint is the true guard)
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing.length > 0) {
    return c.json(
      { ok: false, data: null, error: { code: 'EMAIL_EXISTS', message: '该邮箱已注册' } },
      409,
    );
  }

  const passwordHash = await hashPassword(password);

  // Why: catch PG unique violation (code 23505) so concurrent signups
  // with the same email get a clean EMAIL_EXISTS, not a raw 500.
  // The select-then-insert above is not atomic, so the DB constraint
  // is the real guard.
  let created: User;
  try {
    const rows = await db
      .insert(users)
      .values({ email, passwordHash, displayName })
      .returning();
    const row = rows[0];
    if (!row) {
      return c.json(
        { ok: false, data: null, error: { code: 'INTERNAL_ERROR', message: 'Failed to create user' } },
        500,
      );
    }
    created = row;
  } catch (err: unknown) {
    if (isPgUniqueViolation(err)) {
      return c.json(
        { ok: false, data: null, error: { code: 'EMAIL_EXISTS', message: '该邮箱已注册' } },
        409,
      );
    }
    throw err;
  }

  const accessToken = await signAccessToken({
    sub: created.id,
    email: created.email,
    licenseStatus: 'none',
  });

  // Why: issue refresh token at signup so the user stays logged in for 30d.
  // Without this, the 1h access token being the only credential means they
  // get locked out on expiry — can't refresh, can't re-register (email taken).
  const refreshTokenValue = generateRefreshToken();
  await db.insert(refreshTokens).values({
    userId: created.id,
    token: refreshTokenValue,
    family: crypto.randomUUID(), // new login session = new family lineage
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL * 1000),
  });

  return c.json({
    ok: true,
    data: {
      user: {
        id: created.id,
        email: created.email,
        displayName: created.displayName,
        licenseStatus: 'none' as const,
      },
      accessToken,
      refreshToken: refreshTokenValue,
    },
    error: null,
  });
});

// Why: generic "invalid credentials" message prevents user enumeration.
// Don't reveal whether the email doesn't exist or the password is wrong.
authRoutes.post('/login', loginLimit, zValidator('json', loginSchema, envelopeValidationHook), async (c) => {
  const { email, password } = c.req.valid('json');

  const rows = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  const user = rows[0];

  if (!user) {
    return c.json(
      { ok: false, data: null, error: { code: 'INVALID_CREDENTIALS', message: '邮箱或密码错误' } },
      401,
    );
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return c.json(
      { ok: false, data: null, error: { code: 'INVALID_CREDENTIALS', message: '邮箱或密码错误' } },
      401,
    );
  }

  // Why: transparently upgrade bcrypt hashes to Argon2id on first successful
  // login. Fire-and-forget — a failure here must never block the login response.
  if (needsRehash(user.passwordHash)) {
    hashPassword(password)
      .then((newHash) => db.update(users).set({ passwordHash: newHash }).where(eq(users.id, user.id)))
      .catch(() => null);
  }

  // Why: reflect the user's real license in both the JWT claim and the response
  // so the desktop offline-grace flow (armed only when status==='active') works.
  const licenseStatus = await resolveUserLicenseStatus(user.id);
  const accessToken = await signAccessToken({
    sub: user.id,
    email: user.email,
    licenseStatus,
  });

  const refreshTokenValue = generateRefreshToken();
  await db.insert(refreshTokens).values({
    userId: user.id,
    token: refreshTokenValue,
    family: crypto.randomUUID(), // new login session = new family lineage
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL * 1000),
  });

  return c.json({
    ok: true,
    data: {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        licenseStatus,
      },
      accessToken,
      refreshToken: refreshTokenValue,
    },
    error: null,
  });
});

// POST /v1/auth/refresh — one-time-use refresh-token rotation.
// Body: { refreshToken }; Response: { accessToken, refreshToken } (new pair).
// Why one-time-use: a leaked refresh token shortens its useful window to
// "until next refresh"; the legitimate client always sees a fresh pair, so
// reuse of the old token (intentional replay or attacker) hits the revoked
// row and returns 401. Reuse-detection (revoke the whole user) is deferred
// per Sprint 0 scope.
authRoutes.post('/refresh', refreshLimit, zValidator('json', refreshSchema, envelopeValidationHook), async (c) => {
  const { refreshToken } = c.req.valid('json');
  try {
    const result = await rotateRefreshToken(refreshToken);
    return c.json({
      ok: true,
      data: {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      },
      error: null,
    });
  } catch (err: unknown) {
    if (err instanceof InvalidRefreshTokenError) {
      const { reason } = err;
      const code =
        reason === 'expired'        ? 'TOKEN_EXPIRED'       :
        reason === 'reuse_detected' ? 'TOKEN_REUSE_DETECTED' :
                                     'TOKEN_INVALID';
      const message =
        reason === 'expired'        ? 'Refresh token has expired' :
        reason === 'reuse_detected' ? 'Security alert: token reuse detected. All sessions revoked.' :
                                     'Refresh token is invalid';
      return c.json({ ok: false, data: null, error: { code, message } }, 401);
    }
    throw err;
  }
});

// POST /v1/auth/logout — revokes the supplied refresh token server-side.
// No access token required: the client may call this after the access token
// has already expired. Always 200 so the endpoint can't be used to probe
// whether a given token string exists (§2.5).
authRoutes.post(
  '/logout',
  ipRateLimit({ max: 20, windowMs: 60_000, prefix: 'logout' }),
  zValidator('json', refreshSchema, envelopeValidationHook),
  async (c) => {
    const { refreshToken } = c.req.valid('json');
    await revokeRefreshToken(refreshToken);
    return c.json({ ok: true, data: { loggedOut: true }, error: null });
  },
);
