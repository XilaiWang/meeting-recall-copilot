// Why: full route + middleware coverage with real PostgreSQL — Hono
// app.request() drives the same code path a real HTTP request would, just
// in-process. We rebuild a minimal app per test rather than importing the
// real index.ts so we don't double-bind the http server port.
import 'dotenv/config';

import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { eq, like, inArray, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users, licenses, devices } from '../db/schema.js';
import { hashPassword, signAccessToken } from '../services/auth-service.js';
import { createLicense, MAX_DEVICES_PER_USER } from '../services/license-service.js';
import { licenseRoutes } from './license.js';

const TEST_EMAIL_PREFIX = 'license-route-test-';
const TEST_LICENSE_TAG = 'license-route-test';

interface Envelope<T = unknown> {
  ok: boolean;
  data: T | null;
  error: { code: string; message: string } | null;
}

function makeApp() {
  // Why: license routes are mounted under /v1/license in index.ts; mirror
  // that here so URLs in tests are realistic (and so request middleware
  // chains line up).
  const app = new Hono();
  app.route('/v1/license', licenseRoutes);
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

async function createTestLicense(opts: { tier?: 'lifetime' | 'trial' } = {}) {
  return createLicense({ tier: opts.tier ?? 'lifetime', notes: TEST_LICENSE_TAG });
}

describe('routes/license', () => {
  beforeEach(async () => {
    // Why: mirror license-service.test.ts cleanup — delete devices first
    // (FK to users), then licenses tagged by this test file OR bound to
    // any test user, then the users themselves.
    const testUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(like(users.email, `${TEST_EMAIL_PREFIX}%`));
    const userIds = testUsers.map((u) => u.id);

    if (userIds.length > 0) {
      await db.delete(devices).where(inArray(devices.userId, userIds));
    }

    const testLicenses = await db
      .select({ id: licenses.id })
      .from(licenses)
      .where(
        userIds.length > 0
          ? or(inArray(licenses.userId, userIds), eq(licenses.notes, TEST_LICENSE_TAG))
          : eq(licenses.notes, TEST_LICENSE_TAG),
      );
    const licIds = testLicenses.map((l) => l.id);
    if (licIds.length > 0) {
      await db.delete(licenses).where(inArray(licenses.id, licIds));
    }

    if (userIds.length > 0) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
  });

  // ---------- Auth + header gating ----------

  describe('auth + X-Device-Id gating', () => {
    it('POST /activate → 401 TOKEN_INVALID without bearer token', async () => {
      const app = makeApp();
      const res = await app.request('/v1/license/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'd1' },
        body: JSON.stringify({ licenseKey: 'QM-2026-AAAAAAAAAAAAAAAAAAAAAAAA', platform: 'macos_arm' }),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as Envelope;
      expect(body).toMatchObject({ ok: false, error: { code: 'TOKEN_INVALID' } });
    });

    it('POST /activate → 400 INVALID_INPUT when X-Device-Id missing', async () => {
      const user = await createTestUser();
      const token = await tokenFor(user.id, user.email);
      const license = await createTestLicense();
      const app = makeApp();
      const res = await app.request('/v1/license/activate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ licenseKey: license.key, platform: 'macos_arm' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Envelope;
      expect(body.error?.code).toBe('INVALID_INPUT');
    });

    it('GET /status → 400 INVALID_INPUT when X-Device-Id missing', async () => {
      const user = await createTestUser();
      const token = await tokenFor(user.id, user.email);
      const app = makeApp();
      const res = await app.request('/v1/license/status', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Envelope;
      expect(body.error?.code).toBe('INVALID_INPUT');
    });

    it('POST /activate → 400 VALIDATION_ERROR on malformed licenseKey', async () => {
      const user = await createTestUser();
      const token = await tokenFor(user.id, user.email);
      const app = makeApp();
      const res = await app.request('/v1/license/activate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Device-Id': 'd1',
        },
        body: JSON.stringify({ licenseKey: 'too-short', platform: 'macos_arm' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Envelope;
      expect(body.error?.code).toBe('VALIDATION_ERROR');
    });
  });

  // ---------- Activate happy + error paths ----------

  describe('POST /v1/license/activate', () => {
    it('binds license + registers device → 200 with masked key', async () => {
      const user = await createTestUser();
      const token = await tokenFor(user.id, user.email);
      const license = await createTestLicense();
      const app = makeApp();
      const res = await app.request('/v1/license/activate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Device-Id': 'd-laptop',
        },
        body: JSON.stringify({
          licenseKey: license.key,
          platform: 'macos_arm',
          appVersion: '0.0.1',
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Envelope<{
        license: {
          keyMasked: string;
          status: string;
          tier: string;
          devices: Array<{ deviceId: string; platform: string; appVersion: string | null }>;
        };
      }>;
      expect(body.ok).toBe(true);
      expect(body.data?.license.status).toBe('active');
      expect(body.data?.license.tier).toBe('lifetime');
      // Masked: QM-2026-****<last 4>
      expect(body.data?.license.keyMasked).toMatch(/^QM-2026-\*\*\*\*[A-Z0-9]{4}$/);
      expect(body.data?.license.keyMasked).toHaveLength(16);
      // Real key NEVER leaks — defence in depth against accidental logging
      expect(JSON.stringify(body)).not.toContain(license.key);
      expect(body.data?.license.devices).toHaveLength(1);
      expect(body.data?.license.devices[0]).toMatchObject({
        deviceId: 'd-laptop',
        platform: 'macos_arm',
        appVersion: '0.0.1',
      });
    });

    it('idempotent: same device re-activation returns same single-device list', async () => {
      const user = await createTestUser();
      const token = await tokenFor(user.id, user.email);
      const license = await createTestLicense();
      const app = makeApp();
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Device-Id': 'd1',
      };
      const body = JSON.stringify({ licenseKey: license.key, platform: 'macos_arm' });

      const r1 = await app.request('/v1/license/activate', { method: 'POST', headers, body });
      expect(r1.status).toBe(200);
      const r2 = await app.request('/v1/license/activate', { method: 'POST', headers, body });
      expect(r2.status).toBe(200);
      const b2 = (await r2.json()) as Envelope<{ license: { devices: unknown[] } }>;
      expect(b2.data?.license.devices).toHaveLength(1);
    });

    it('404 LICENSE_NOT_FOUND for unknown key', async () => {
      const user = await createTestUser();
      const token = await tokenFor(user.id, user.email);
      const app = makeApp();
      const res = await app.request('/v1/license/activate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Device-Id': 'd1',
        },
        body: JSON.stringify({
          licenseKey: 'QM-2026-XXXXXXXXXXXXXXXXXXXXXXXX',
          platform: 'macos_arm',
        }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as Envelope;
      expect(body.error?.code).toBe('LICENSE_NOT_FOUND');
    });

    it('422 LICENSE_ALREADY_USED when key is bound to a different user', async () => {
      const a = await createTestUser();
      const b = await createTestUser();
      const license = await createTestLicense();
      const app = makeApp();

      // user A activates first
      const aToken = await tokenFor(a.id, a.email);
      const r1 = await app.request('/v1/license/activate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aToken}`,
          'X-Device-Id': 'd-a',
        },
        body: JSON.stringify({ licenseKey: license.key, platform: 'macos_arm' }),
      });
      expect(r1.status).toBe(200);

      // user B tries to activate the same key
      const bToken = await tokenFor(b.id, b.email);
      const r2 = await app.request('/v1/license/activate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bToken}`,
          'X-Device-Id': 'd-b',
        },
        body: JSON.stringify({ licenseKey: license.key, platform: 'windows' }),
      });
      expect(r2.status).toBe(422);
      const body = (await r2.json()) as Envelope;
      expect(body.error?.code).toBe('LICENSE_ALREADY_USED');
    });

    it('422 LICENSE_EXPIRED when license is revoked', async () => {
      const user = await createTestUser();
      const token = await tokenFor(user.id, user.email);
      const license = await createTestLicense();
      await db.update(licenses).set({ status: 'revoked' }).where(eq(licenses.id, license.id));

      const app = makeApp();
      const res = await app.request('/v1/license/activate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Device-Id': 'd1',
        },
        body: JSON.stringify({ licenseKey: license.key, platform: 'macos_arm' }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as Envelope;
      expect(body.error?.code).toBe('LICENSE_EXPIRED');
    });

    it('422 DEVICE_LIMIT_EXCEEDED when a 3rd new device tries to activate', async () => {
      const user = await createTestUser();
      const token = await tokenFor(user.id, user.email);
      const license = await createTestLicense();
      const app = makeApp();

      // Bind 2 devices first
      for (let i = 0; i < MAX_DEVICES_PER_USER; i++) {
        const res = await app.request('/v1/license/activate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'X-Device-Id': `d-${i}`,
          },
          body: JSON.stringify({ licenseKey: license.key, platform: 'macos_arm' }),
        });
        expect(res.status).toBe(200);
      }

      const res3 = await app.request('/v1/license/activate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Device-Id': 'd-overflow',
        },
        body: JSON.stringify({ licenseKey: license.key, platform: 'windows' }),
      });
      expect(res3.status).toBe(422);
      const body = (await res3.json()) as Envelope;
      expect(body.error?.code).toBe('DEVICE_LIMIT_EXCEEDED');
    });
  });

  // ---------- Status ----------

  describe('GET /v1/license/status', () => {
    it('returns status=none for a fresh user with cacheUntil ~1h out', async () => {
      const user = await createTestUser();
      const token = await tokenFor(user.id, user.email);
      const app = makeApp();
      const before = Date.now();
      const res = await app.request('/v1/license/status', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, 'X-Device-Id': 'd1' },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Envelope<{
        status: string;
        tier: string;
        deviceRecognized: boolean;
        expiresAt: string | null;
        cacheUntil: string;
      }>;
      expect(body.data?.status).toBe('none');
      expect(body.data?.tier).toBe('none');
      expect(body.data?.deviceRecognized).toBe(false);
      expect(body.data?.expiresAt).toBeNull();
      // Non-active → 1h cache. Allow generous bounds for test execution delay.
      const cacheMs = new Date(body.data!.cacheUntil).getTime() - before;
      expect(cacheMs).toBeGreaterThan(50 * 60 * 1000);
      expect(cacheMs).toBeLessThan(70 * 60 * 1000);
    });

    it('returns status=active + deviceRecognized=true after activation, with ~7d cache', async () => {
      const user = await createTestUser();
      const token = await tokenFor(user.id, user.email);
      const license = await createTestLicense();
      const app = makeApp();

      await app.request('/v1/license/activate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Device-Id': 'd-here',
        },
        body: JSON.stringify({ licenseKey: license.key, platform: 'macos_arm' }),
      });

      const before = Date.now();
      const res = await app.request('/v1/license/status', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, 'X-Device-Id': 'd-here' },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Envelope<{
        status: string;
        tier: string;
        deviceRecognized: boolean;
        cacheUntil: string;
      }>;
      expect(body.data?.status).toBe('active');
      expect(body.data?.tier).toBe('lifetime');
      expect(body.data?.deviceRecognized).toBe(true);
      const cacheMs = new Date(body.data!.cacheUntil).getTime() - before;
      // Active → 7d cache
      expect(cacheMs).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
      expect(cacheMs).toBeLessThan(7.1 * 24 * 60 * 60 * 1000);
    });

    it('deviceRecognized=false when X-Device-Id is not in the bound list', async () => {
      const user = await createTestUser();
      const token = await tokenFor(user.id, user.email);
      const license = await createTestLicense();
      const app = makeApp();

      await app.request('/v1/license/activate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Device-Id': 'd-original',
        },
        body: JSON.stringify({ licenseKey: license.key, platform: 'macos_arm' }),
      });

      const res = await app.request('/v1/license/status', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, 'X-Device-Id': 'd-different' },
      });
      const body = (await res.json()) as Envelope<{ status: string; deviceRecognized: boolean }>;
      expect(body.data?.status).toBe('active');
      expect(body.data?.deviceRecognized).toBe(false);
    });
  });

  // ---------- Unbind ----------

  describe('POST /v1/license/unbind', () => {
    it('removes the named device and frees a slot for a new activation', async () => {
      const user = await createTestUser();
      const token = await tokenFor(user.id, user.email);
      const license = await createTestLicense();
      const app = makeApp();
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      };

      // Fill both slots
      await app.request('/v1/license/activate', {
        method: 'POST',
        headers: { ...headers, 'X-Device-Id': 'd1' },
        body: JSON.stringify({ licenseKey: license.key, platform: 'macos_arm' }),
      });
      await app.request('/v1/license/activate', {
        method: 'POST',
        headers: { ...headers, 'X-Device-Id': 'd2' },
        body: JSON.stringify({ licenseKey: license.key, platform: 'windows' }),
      });

      // Unbind d1
      const unbind = await app.request('/v1/license/unbind', {
        method: 'POST',
        headers,
        body: JSON.stringify({ deviceId: 'd1' }),
      });
      expect(unbind.status).toBe(200);
      const unbindBody = (await unbind.json()) as Envelope<{
        remainingDevices: Array<{ deviceId: string }>;
      }>;
      expect(unbindBody.data?.remainingDevices).toHaveLength(1);
      expect(unbindBody.data?.remainingDevices[0]?.deviceId).toBe('d2');

      // d3 can now activate (slot freed)
      const d3 = await app.request('/v1/license/activate', {
        method: 'POST',
        headers: { ...headers, 'X-Device-Id': 'd3' },
        body: JSON.stringify({ licenseKey: license.key, platform: 'macos_intel' }),
      });
      expect(d3.status).toBe(200);
    });

    it('unbinding a non-bound device is idempotent (200, current list)', async () => {
      const user = await createTestUser();
      const token = await tokenFor(user.id, user.email);
      const app = makeApp();
      const res = await app.request('/v1/license/unbind', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ deviceId: 'never-bound' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Envelope<{ remainingDevices: unknown[] }>;
      expect(body.data?.remainingDevices).toEqual([]);
    });

    it('400 VALIDATION_ERROR on empty deviceId', async () => {
      const user = await createTestUser();
      const token = await tokenFor(user.id, user.email);
      const app = makeApp();
      const res = await app.request('/v1/license/unbind', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ deviceId: '' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Envelope;
      expect(body.error?.code).toBe('VALIDATION_ERROR');
    });
  });
});
