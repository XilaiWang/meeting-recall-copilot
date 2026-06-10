// Why: middleware itself has the only place that maps jose's JWTExpired →
// TOKEN_EXPIRED. Without this test, a silent regression could downgrade
// TOKEN_EXPIRED to TOKEN_INVALID, breaking the client's "auto-refresh on
// expiry" logic.
import 'dotenv/config';

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { signAccessToken } from '../services/auth-service.js';
import { requireAuth, type AuthVars } from './auth.js';

function makeApp() {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use('/whoami', requireAuth);
  app.get('/whoami', (c) =>
    c.json({
      ok: true,
      data: {
        userId: c.get('userId'),
        email: c.get('email'),
        licenseStatus: c.get('licenseStatus'),
      },
      error: null,
    }),
  );
  return app;
}

describe('requireAuth', () => {
  it('returns 401 TOKEN_INVALID when Authorization header is missing', async () => {
    const app = makeApp();
    const res = await app.request('/whoami');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: { code: 'TOKEN_INVALID' } });
  });

  it('returns 401 TOKEN_INVALID when scheme is not Bearer', async () => {
    const app = makeApp();
    const res = await app.request('/whoami', { headers: { Authorization: 'Basic abc' } });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: { code: 'TOKEN_INVALID' } });
  });

  it('returns 401 TOKEN_INVALID for a malformed token', async () => {
    const app = makeApp();
    const res = await app.request('/whoami', { headers: { Authorization: 'Bearer not.a.jwt' } });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: { code: 'TOKEN_INVALID' } });
  });

  it('returns 401 TOKEN_EXPIRED when the JWT is expired', async () => {
    const secret = new TextEncoder().encode(process.env.JWT_ACCESS_SECRET ?? '');
    const expired = await new SignJWT({
      sub: 'user-1',
      email: 'a@b.com',
      licenseStatus: 'none',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(secret);

    const app = makeApp();
    const res = await app.request('/whoami', { headers: { Authorization: `Bearer ${expired}` } });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: { code: 'TOKEN_EXPIRED' } });
  });

  it('passes through and sets context vars for a valid token', async () => {
    const token = await signAccessToken({
      sub: 'user-abc',
      email: 'hello@example.com',
      licenseStatus: 'active',
    });
    const app = makeApp();
    const res = await app.request('/whoami', { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      data: { userId: 'user-abc', email: 'hello@example.com', licenseStatus: 'active' },
      error: null,
    });
  });
});
