import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requireAuth, type AuthVars } from '../middleware/auth.js';
import {
  activateLicense,
  getLicenseStatus,
  maskLicenseKey,
  unbindDevice,
  MAX_DEVICES_PER_USER,
  LicenseNotFoundError,
  LicenseAlreadyUsedError,
  LicenseExpiredError,
  DeviceLimitExceededError,
} from '../services/license-service.js';
import { activateLicenseSchema, unbindDeviceSchema } from '@qa-matching/shared/schemas';
import { envelopeValidationHook } from '../lib/validation-hook.js';
import { userRateLimit } from '../middleware/rate-limit.js';

// Limits per 3.4 §5: activate 3/user/h, status 60/user/h, unbind 5/user/day.
const activateLimit = userRateLimit({ max: 3, windowMs: 60 * 60_000, prefix: 'activate' });
const statusLimit = userRateLimit({ max: 60, windowMs: 60 * 60_000, prefix: 'lic-status' });
const unbindLimit = userRateLimit({ max: 5, windowMs: 24 * 60 * 60_000, prefix: 'unbind' });

export const licenseRoutes = new Hono<{ Variables: AuthVars }>();

// Why: every license endpoint requires a valid access token. Applying
// requireAuth here (rather than per-route) keeps the route handlers focused
// on business logic; the middleware already returns the standard 401
// envelope with TOKEN_EXPIRED / TOKEN_INVALID per 3.4 §3.2.
licenseRoutes.use('*', requireAuth);

// Why: cache-until guidance per 3.4 §4.5. Active licenses cache for 7 days
// (we don't expect status flips often). Non-active states cache for 1 hour
// so a user who just purchased a key sees `status: active` on next launch
// instead of waiting a week for the cache to clear.
const CACHE_ACTIVE_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_OTHER_MS = 60 * 60 * 1000;

// Why: X-Device-Id is required by 3.4 §1.6 for /activate and /status. Not
// in middleware because /unbind takes deviceId in the body (the user is
// telling us which device to drop, not which device they're on).
function readDeviceId(c: Context): string | null {
  const v = c.req.header('X-Device-Id');
  if (!v || v.trim().length === 0) return null;
  return v.trim();
}

function missingDeviceIdResponse(c: Context) {
  return c.json(
    {
      ok: false,
      data: null,
      error: { code: 'INVALID_INPUT', message: 'X-Device-Id header is required' },
    },
    400,
  );
}

// POST /v1/license/activate — bind license to current user + register device.
// Errors from service layer map 1:1 to documented codes (3.4 §3.2, §4.4).
licenseRoutes.post(
  '/activate',
  activateLimit,
  zValidator('json', activateLicenseSchema, envelopeValidationHook),
  async (c) => {
    const deviceId = readDeviceId(c);
    if (!deviceId) return missingDeviceIdResponse(c);

    const userId = c.get('userId');
    const { licenseKey, platform, appVersion } = c.req.valid('json');

    try {
      const result = await activateLicense({
        key: licenseKey,
        userId,
        deviceId,
        platform,
        appVersion: appVersion ?? null,
      });
      return c.json({
        ok: true,
        data: {
          license: {
            keyMasked: maskLicenseKey(result.license.key),
            status: result.license.status,
            tier: result.license.tier,
            purchasedAt: result.license.purchasedAt,
            expiresAt: result.license.expiresAt,
            devices: result.devices.map((d) => ({
              deviceId: d.deviceId,
              platform: d.platform,
              appVersion: d.appVersion,
              firstSeen: d.firstSeenAt,
              lastSeen: d.lastSeenAt,
            })),
          },
        },
        error: null,
      });
    } catch (err: unknown) {
      if (err instanceof LicenseNotFoundError) {
        return c.json(
          {
            ok: false,
            data: null,
            error: { code: 'LICENSE_NOT_FOUND', message: 'License key not found' },
          },
          404,
        );
      }
      if (err instanceof LicenseAlreadyUsedError) {
        return c.json(
          {
            ok: false,
            data: null,
            error: {
              code: 'LICENSE_ALREADY_USED',
              message: 'License is already bound to another account',
            },
          },
          422,
        );
      }
      if (err instanceof LicenseExpiredError) {
        return c.json(
          {
            ok: false,
            data: null,
            error: {
              code: 'LICENSE_EXPIRED',
              message: err.reason === 'revoked' ? 'License has been revoked' : 'License has expired',
            },
          },
          422,
        );
      }
      if (err instanceof DeviceLimitExceededError) {
        return c.json(
          {
            ok: false,
            data: null,
            error: {
              code: 'DEVICE_LIMIT_EXCEEDED',
              message: `Device limit reached (${MAX_DEVICES_PER_USER}). Unbind a device first.`,
            },
          },
          422,
        );
      }
      throw err;
    }
  },
);

// GET /v1/license/status — high-frequency boot-time check (3.4 §4.5).
// Returns cacheUntil so the client can avoid hammering this endpoint on
// every launch. statusLimit caps it at 60/user/h; the limiter is GLOBAL across
// instances when UPSTASH_REDIS_REST_URL/TOKEN are set, else per-instance in-memory
// (single-machine deploy). See middleware/rate-limit.ts.
licenseRoutes.get('/status', statusLimit, async (c) => {
  const deviceId = readDeviceId(c);
  if (!deviceId) return missingDeviceIdResponse(c);

  const userId = c.get('userId');
  const result = await getLicenseStatus({ userId, deviceId });

  const cacheMs = result.status === 'active' ? CACHE_ACTIVE_MS : CACHE_OTHER_MS;
  const cacheUntil = new Date(Date.now() + cacheMs);

  return c.json({
    ok: true,
    data: {
      status: result.status,
      tier: result.tier,
      deviceRecognized: result.deviceRecognized,
      expiresAt: result.expiresAt,
      cacheUntil,
    },
    error: null,
  });
});

// POST /v1/license/unbind — user releases a device slot. Idempotent:
// unbinding an already-removed (or never-bound) device returns 200 with
// the current remaining list. Why no 404 for missing device: the user's
// goal is "this device is no longer bound to me", which is already true.
licenseRoutes.post(
  '/unbind',
  unbindLimit,
  zValidator('json', unbindDeviceSchema, envelopeValidationHook),
  async (c) => {
    const userId = c.get('userId');
    const { deviceId } = c.req.valid('json');
    const result = await unbindDevice({ userId, deviceId });
    return c.json({
      ok: true,
      data: {
        remainingDevices: result.remainingDevices.map((d) => ({
          deviceId: d.deviceId,
          platform: d.platform,
          appVersion: d.appVersion,
          firstSeen: d.firstSeenAt,
          lastSeen: d.lastSeenAt,
        })),
      },
      error: null,
    });
  },
);
