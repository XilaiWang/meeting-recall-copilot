// Why: license-service has the most branching of any Day-4 code:
// 4 error paths + idempotent re-activation + 2-device cap. Real PostgreSQL
// because activation's transaction + `FOR UPDATE` + ON CONFLICT idempotency
// are the actual SUT.
import 'dotenv/config';

import { describe, it, expect, beforeEach } from 'vitest';
import { eq, like, inArray, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users, licenses, devices } from '../db/schema.js';
import { hashPassword } from './auth-service.js';
import {
  activateLicense,
  createLicense,
  generateLicenseKey,
  getLicenseStatus,
  maskLicenseKey,
  unbindDevice,
  LicenseNotFoundError,
  LicenseAlreadyUsedError,
  LicenseExpiredError,
  DeviceLimitExceededError,
  MAX_DEVICES_PER_USER,
  pickBestLicense,
} from './license-service.js';

// Pure selection logic (no DB) — guards against the non-deterministic limit(1).
describe('pickBestLicense', () => {
  const NOW = 1_700_000_000_000;
  const day = 86_400_000;
  it('returns null for no rows', () => {
    expect(pickBestLicense([], NOW)).toBeNull();
  });
  it('prefers a currently-active license over expired/pending/revoked', () => {
    const rows = [
      { status: 'revoked' as const, expiresAt: null, activatedAt: new Date(NOW) },
      { status: 'active' as const, expiresAt: null, activatedAt: new Date(NOW - day) },
      { status: 'expired' as const, expiresAt: new Date(NOW - day), activatedAt: new Date(NOW) },
    ];
    expect(pickBestLicense(rows, NOW)?.status).toBe('active');
  });
  it('treats an active row past its expiresAt as not-active (falls to expired)', () => {
    const rows = [
      { status: 'active' as const, expiresAt: new Date(NOW - day), activatedAt: new Date(NOW) },
      { status: 'expired' as const, expiresAt: new Date(NOW - 2 * day), activatedAt: new Date(NOW - day) },
    ];
    // both map to 'expired'; tiebreak picks the most recently activated
    expect(pickBestLicense(rows, NOW)?.activatedAt?.getTime()).toBe(NOW);
  });
  it('tiebreaks same-rank rows by most recent activatedAt deterministically', () => {
    const older = { status: 'active' as const, expiresAt: null, activatedAt: new Date(NOW - 2 * day) };
    const newer = { status: 'active' as const, expiresAt: null, activatedAt: new Date(NOW - day) };
    expect(pickBestLicense([older, newer], NOW)).toBe(newer);
    expect(pickBestLicense([newer, older], NOW)).toBe(newer); // order-independent
  });
});

const TEST_EMAIL_PREFIX = 'license-test-';
// Why: tag every test-created license so beforeEach can clean rows whose
// userId never got set (e.g. the revoked-license test fails activation,
// leaving a dangling pending row with userId=null).
const TEST_LICENSE_TAG = 'license-service-test';

async function createTestUser() {
  const email = `${TEST_EMAIL_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const passwordHash = await hashPassword('test-pass-12345');
  const [user] = await db.insert(users).values({ email, passwordHash }).returning();
  if (!user) throw new Error('failed to insert test user');
  return user;
}

async function createTestLicense(opts: { tier?: 'lifetime' | 'trial' } = {}) {
  return createLicense({ tier: opts.tier ?? 'lifetime', notes: TEST_LICENSE_TAG });
}

describe('generateLicenseKey + maskLicenseKey', () => {
  it('produces a 32-char key with the QM-2026- prefix', () => {
    const key = generateLicenseKey();
    expect(key).toHaveLength(32);
    expect(key.startsWith('QM-2026-')).toBe(true);
  });

  it('uses unambiguous alphabet only (no 0/O/1/I/L/U)', () => {
    const key = generateLicenseKey();
    const body = key.slice('QM-2026-'.length);
    expect(body).toMatch(/^[ABCDEFGHJKMNPQRSTVWXYZ23456789]+$/);
  });

  it('produces unique keys across calls', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 50; i++) keys.add(generateLicenseKey());
    expect(keys.size).toBe(50);
  });

  it('masks the middle of the key, keeps prefix + last 4 chars', () => {
    // 32-char input: "QM-2026-" (8) + "ABCDEFGHJKMNPQRSTVWXYZ23" (24)
    const masked = maskLicenseKey('QM-2026-ABCDEFGHJKMNPQRSTVWXYZ23');
    expect(masked).toBe('QM-2026-****YZ23');
    expect(masked).toHaveLength(16);
  });

  it('mask is idempotent on unexpected length', () => {
    expect(maskLicenseKey('short')).toBe('short');
  });
});

describe('license-service (DB)', () => {
  beforeEach(async () => {
    // Clean only the rows this test file created. Two cohorts to catch:
    //   1) licenses bound to a test user (userId set)
    //   2) licenses created by tests that never bound (userId still null —
    //      e.g. the revoked-license test) — found via notes tag
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

  it('activate happy path: binds license to user, registers device, marks active', async () => {
    const user = await createTestUser();
    const license = await createTestLicense({ tier: 'lifetime' });

    const result = await activateLicense({
      key: license.key,
      userId: user.id,
      deviceId: 'test-device-1',
      platform: 'macos_arm',
      appVersion: '0.0.1',
    });

    expect(result.license.userId).toBe(user.id);
    expect(result.license.status).toBe('active');
    expect(result.license.activatedAt).toBeInstanceOf(Date);
    expect(result.devices).toHaveLength(1);
    expect(result.devices[0]?.deviceId).toBe('test-device-1');
    expect(result.devices[0]?.platform).toBe('macos_arm');
  });

  it('activate is idempotent: same user + same device twice updates lastSeenAt, no dup row', async () => {
    const user = await createTestUser();
    const license = await createTestLicense();
    await activateLicense({
      key: license.key,
      userId: user.id,
      deviceId: 'idem-device',
      platform: 'macos_arm',
    });
    const second = await activateLicense({
      key: license.key,
      userId: user.id,
      deviceId: 'idem-device',
      platform: 'macos_arm',
      appVersion: '0.0.2',
    });
    expect(second.devices).toHaveLength(1);
    expect(second.devices[0]?.appVersion).toBe('0.0.2');
  });

  it('LICENSE_NOT_FOUND: unknown key throws', async () => {
    const user = await createTestUser();
    await expect(
      activateLicense({
        key: 'QM-2026-NOPENOPENOPENOPENOPENOPE',
        userId: user.id,
        deviceId: 'd',
        platform: 'windows',
      }),
    ).rejects.toBeInstanceOf(LicenseNotFoundError);
  });

  it('LICENSE_ALREADY_USED: another user activated first', async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    const license = await createTestLicense();

    await activateLicense({
      key: license.key,
      userId: userA.id,
      deviceId: 'a-device',
      platform: 'macos_intel',
    });

    await expect(
      activateLicense({
        key: license.key,
        userId: userB.id,
        deviceId: 'b-device',
        platform: 'windows',
      }),
    ).rejects.toBeInstanceOf(LicenseAlreadyUsedError);
  });

  it('DEVICE_LIMIT_EXCEEDED: 3rd new device for same user is rejected', async () => {
    const user = await createTestUser();
    const license = await createTestLicense();
    await activateLicense({
      key: license.key,
      userId: user.id,
      deviceId: 'd1',
      platform: 'macos_arm',
    });
    await activateLicense({
      key: license.key,
      userId: user.id,
      deviceId: 'd2',
      platform: 'macos_arm',
    });
    await expect(
      activateLicense({
        key: license.key,
        userId: user.id,
        deviceId: 'd3',
        platform: 'windows',
      }),
    ).rejects.toBeInstanceOf(DeviceLimitExceededError);

    const finalDevices = await db
      .select()
      .from(devices)
      .where(eq(devices.userId, user.id));
    expect(finalDevices).toHaveLength(MAX_DEVICES_PER_USER);
  });

  it('LICENSE_EXPIRED: revoked license cannot activate', async () => {
    const user = await createTestUser();
    const license = await createTestLicense();
    await db.update(licenses).set({ status: 'revoked' }).where(eq(licenses.id, license.id));

    await expect(
      activateLicense({
        key: license.key,
        userId: user.id,
        deviceId: 'd',
        platform: 'macos_arm',
      }),
    ).rejects.toMatchObject({ name: 'LicenseExpiredError', reason: 'revoked' });
  });

  it('getLicenseStatus: no license → status none, device not recognized', async () => {
    const user = await createTestUser();
    const result = await getLicenseStatus({ userId: user.id, deviceId: 'whatever' });
    expect(result).toEqual({
      status: 'none',
      tier: 'none',
      deviceRecognized: false,
      expiresAt: null,
    });
  });

  it('getLicenseStatus: active license + known device → recognized', async () => {
    const user = await createTestUser();
    const license = await createTestLicense();
    await activateLicense({
      key: license.key,
      userId: user.id,
      deviceId: 'known',
      platform: 'macos_arm',
    });
    const result = await getLicenseStatus({ userId: user.id, deviceId: 'known' });
    expect(result.status).toBe('active');
    expect(result.tier).toBe('lifetime');
    expect(result.deviceRecognized).toBe(true);
  });

  it('getLicenseStatus: active license + unknown device → recognized=false', async () => {
    const user = await createTestUser();
    const license = await createTestLicense();
    await activateLicense({
      key: license.key,
      userId: user.id,
      deviceId: 'known',
      platform: 'macos_arm',
    });
    const result = await getLicenseStatus({ userId: user.id, deviceId: 'other' });
    expect(result.status).toBe('active');
    expect(result.deviceRecognized).toBe(false);
  });

  it('unbindDevice: removes the row, leaves others, opens slot', async () => {
    const user = await createTestUser();
    const license = await createTestLicense();
    await activateLicense({
      key: license.key,
      userId: user.id,
      deviceId: 'd1',
      platform: 'macos_arm',
    });
    await activateLicense({
      key: license.key,
      userId: user.id,
      deviceId: 'd2',
      platform: 'windows',
    });

    const result = await unbindDevice({ userId: user.id, deviceId: 'd1' });
    expect(result.remainingDevices).toHaveLength(1);
    expect(result.remainingDevices[0]?.deviceId).toBe('d2');

    // Slot freed: activating a 3rd device now succeeds
    const after = await activateLicense({
      key: license.key,
      userId: user.id,
      deviceId: 'd3',
      platform: 'macos_intel',
    });
    expect(after.devices).toHaveLength(2);
  });

  it('LicenseExpiredError is also a regular Error instance', () => {
    const err = new LicenseExpiredError('expired');
    expect(err).toBeInstanceOf(Error);
    expect(err.reason).toBe('expired');
  });
});
