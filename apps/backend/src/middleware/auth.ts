import type { MiddlewareHandler } from 'hono';
import { errors as joseErrors } from 'jose';
import { verifyAccessToken, type LicenseStatus } from '../services/auth-service.js';

// Why: typed Hono variables so downstream handlers can call
// `c.get('userId')` with the right type instead of stringly-typed access.
export interface AuthVars {
  userId: string;
  email: string;
  licenseStatus: LicenseStatus;
}

// Why: opt-in middleware. Protected routes call `.use(requireAuth)`;
// signup/login/refresh stay open. Extracts `Authorization: Bearer <token>`,
// verifies via the existing service (which already owns the JWT_ACCESS_SECRET),
// then stores claims in the Hono context.
//
// jose v5 throws distinct error classes; we surface `TOKEN_EXPIRED` so the
// client knows it should call /refresh, and `TOKEN_INVALID` for everything
// else (bad signature, malformed, missing). Both → 401 per 3.4 §3.2.
export const requireAuth: MiddlewareHandler<{ Variables: AuthVars }> = async (c, next) => {
  const header = c.req.header('Authorization');
  if (!header || !header.startsWith('Bearer ')) {
    return c.json(
      {
        ok: false,
        data: null,
        error: { code: 'TOKEN_INVALID', message: 'Missing or malformed Authorization header' },
      },
      401,
    );
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    return c.json(
      {
        ok: false,
        data: null,
        error: { code: 'TOKEN_INVALID', message: 'Empty bearer token' },
      },
      401,
    );
  }

  try {
    const payload = await verifyAccessToken(token);
    c.set('userId', payload.sub);
    c.set('email', payload.email);
    c.set('licenseStatus', payload.licenseStatus);
  } catch (err: unknown) {
    if (err instanceof joseErrors.JWTExpired) {
      return c.json(
        {
          ok: false,
          data: null,
          error: { code: 'TOKEN_EXPIRED', message: 'Access token has expired' },
        },
        401,
      );
    }
    return c.json(
      {
        ok: false,
        data: null,
        error: { code: 'TOKEN_INVALID', message: 'Invalid access token' },
      },
      401,
    );
  }

  await next();
};
