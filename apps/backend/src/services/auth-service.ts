import bcrypt from 'bcryptjs';
import argon2 from 'argon2';
import { SignJWT, jwtVerify } from 'jose';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users, refreshTokens } from '../db/schema.js';
import { REFRESH_TOKEN_TTL } from '@qa-matching/shared/constants';
import { resolveUserLicenseStatus } from './license-service.js';


// Why these Argon2id params: OWASP minimum (64 MB RAM, 3 iterations, 4 threads).
// Memory-hard algorithm makes GPU-based cracking 100-1000× more expensive than bcrypt.
const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 } as const;

// ---------- Secret loaders ----------
// Why lazy: env may not be loaded at import time depending on order

function getAccessSecret(): Uint8Array {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new Error('JWT_ACCESS_SECRET is required');
  return new TextEncoder().encode(secret);
}

// ---------- Password ----------

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTIONS);
}

// Why dual-verify: existing users still have bcrypt hashes ($2b$ prefix).
// New hashes are Argon2id ($argon2id$ prefix). Detect by prefix so both can coexist.
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (hash.startsWith('$2b$') || hash.startsWith('$2a$')) {
    return bcrypt.compare(plain, hash);
  }
  return argon2.verify(hash, plain);
}

// Why: caller can transparently re-hash bcrypt passwords to Argon2id on next login
// without forcing users to reset. Returns true only for bcrypt hashes.
export function needsRehash(hash: string): boolean {
  return hash.startsWith('$2b$') || hash.startsWith('$2a$');
}

// ---------- JWT ----------

export type LicenseStatus = 'active' | 'expired' | 'none';

export interface AccessTokenPayload {
  sub: string;        // user id
  email: string;
  licenseStatus: LicenseStatus;
}

// Why 1h access token TTL: short window minimizes blast radius if token leaks.
// Refresh token (30d) handles user UX so they don't re-login frequently.
export async function signAccessToken(payload: AccessTokenPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(getAccessSecret());
}

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload> {
  const { payload } = await jwtVerify(token, getAccessSecret());
  return payload as unknown as AccessTokenPayload;
}

// Refresh token is a random opaque string, stored in DB. Why not a JWT?
// → simpler to revoke (DB delete). The cryptographic value of a JWT here is null.
export function generateRefreshToken(): string {
  // crypto.randomUUID() gives 128 bits; concat two for 256-bit entropy
  return `${crypto.randomUUID()}-${crypto.randomUUID()}`;
}

// ---------- Refresh token rotation ----------

// 'reuse_detected' = a previously-rotated token was re-presented; the whole
// token family is revoked so any attacker session is immediately invalidated.
export type InvalidRefreshReason = 'not_found' | 'revoked' | 'expired' | 'reuse_detected';

// Why: typed error so the route layer can map reason → HTTP envelope code
// (`TOKEN_INVALID` vs `TOKEN_EXPIRED`) without re-inspecting strings.
// The message is intentionally generic; the route layer chooses what to expose.
export class InvalidRefreshTokenError extends Error {
  override readonly name = 'InvalidRefreshTokenError';
  constructor(public readonly reason: InvalidRefreshReason) {
    super(`refresh token ${reason}`);
  }
}

export interface RotatedTokens {
  accessToken: string;
  refreshToken: string;
  userId: string;
}

// Why: one-time-use rotation in a single transaction. The `SELECT ... FOR UPDATE`
// row lock prevents two concurrent /refresh calls from both succeeding with the
// same input — the second waits, then sees `revoked=true` after the first commits
// and throws. Old row is revoked (not deleted) so a cron + audit query can still
// see the history. New row carries a fresh 30d expiry.
//
// Token strings are never logged here (PII per 4.2 §10.2).
export async function rotateRefreshToken(oldToken: string): Promise<RotatedTokens> {
  // Why: the reuse-detection branch must COMMIT its family-wide revocation, so it
  // can't just throw inside the transaction — that would roll the revocation back
  // and defeat RTRD. The tx returns a discriminated result instead, and we raise
  // the reuse error only after the tx has committed.
  const outcome = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.token, oldToken))
      .for('update')
      .limit(1);
    const existing = rows[0];
    if (!existing) throw new InvalidRefreshTokenError('not_found');

    // Why: if the token is already revoked, a legitimate client would never
    // present it (they always hold the newest token in the chain). Reuse of a
    // rotated token therefore signals either replay or token theft. We revoke
    // the entire family to cut off any forked attacker session, then signal the
    // error after this write commits (see the throw below the transaction).
    if (existing.revoked) {
      await tx.update(refreshTokens)
        .set({ revoked: true })
        .where(eq(refreshTokens.family, existing.family));
      return { reuse: true as const };
    }

    if (existing.expiresAt.getTime() <= Date.now()) {
      throw new InvalidRefreshTokenError('expired');
    }

    // Need email + (future) license_status for the new access token claims
    const userRows = await tx
      .select()
      .from(users)
      .where(eq(users.id, existing.userId))
      .limit(1);
    const user = userRows[0];
    // Should be unreachable due to FK ON DELETE CASCADE, but guard anyway.
    if (!user) throw new InvalidRefreshTokenError('not_found');

    await tx
      .update(refreshTokens)
      .set({ revoked: true })
      .where(eq(refreshTokens.id, existing.id));

    const newRefresh = generateRefreshToken();
    await tx.insert(refreshTokens).values({
      userId: user.id,
      token: newRefresh,
      family: existing.family, // propagate lineage for RTRD tracking
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL * 1000),
    });

    // Why: reflect the user's real license so a refresh doesn't silently
    // downgrade an active license to 'none' (which disabled offline-grace).
    const accessToken = await signAccessToken({
      sub: user.id,
      email: user.email,
      licenseStatus: await resolveUserLicenseStatus(user.id),
    });

    return {
      reuse: false as const,
      tokens: { accessToken, refreshToken: newRefresh, userId: user.id },
    };
  });

  // Raised post-commit so the family-wide revocation above actually persists.
  if (outcome.reuse) throw new InvalidRefreshTokenError('reuse_detected');
  return outcome.tokens;
}

// Why: idempotent — token not found or already revoked both succeed. The
// caller's goal is "this token should no longer work", which is already true
// in either case. Not throwing also prevents logout from being used as an
// oracle to detect whether a given token string is valid.
export async function revokeRefreshToken(token: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revoked: true })
    .where(eq(refreshTokens.token, token));
}
