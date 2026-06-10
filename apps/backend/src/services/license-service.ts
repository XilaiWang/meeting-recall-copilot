import { randomInt } from 'node:crypto';
import { and, eq, lt, sql } from 'drizzle-orm';

// Why: 90 days without a check-in is treated as an abandoned device slot.
// Automatically freeing stale slots means users don't need to manually unbind
// a machine they've stopped using — the cap only blocks truly active devices.
const STALE_DEVICE_DAYS = 90;
import { db } from '../db/client.js';
import {
  licenses,
  devices,
  type License,
  type Device,
  type Platform,
} from '../db/schema.js';

// ---------- Errors ----------
// Why: typed errors so the route layer can map cleanly to the documented
// codes in 3.4 §4.4 (LICENSE_NOT_FOUND / LICENSE_ALREADY_USED /
// LICENSE_EXPIRED / DEVICE_LIMIT_EXCEEDED) without re-inspecting strings.

export class LicenseNotFoundError extends Error {
  override readonly name = 'LicenseNotFoundError';
  constructor() {
    super('license not found');
  }
}

export class LicenseAlreadyUsedError extends Error {
  override readonly name = 'LicenseAlreadyUsedError';
  constructor() {
    super('license is already bound to another user');
  }
}

export class LicenseExpiredError extends Error {
  override readonly name = 'LicenseExpiredError';
  constructor(public readonly reason: 'expired' | 'revoked') {
    super(`license ${reason}`);
  }
}

export class DeviceLimitExceededError extends Error {
  override readonly name = 'DeviceLimitExceededError';
  constructor(public readonly limit: number) {
    super(`device limit ${limit} exceeded`);
  }
}

// ---------- Key generation ----------

// Why: unambiguous alphabet (no 0/O/1/I/L/U) so users transcribing keys
// from receipts/emails don't mistype. 30 chars × 24 slots ≈ 117 bits of
// entropy — far more than needed to make brute force infeasible.
const KEY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const KEY_PREFIX = 'QM-2026-';
const KEY_BODY_LEN = 32 - KEY_PREFIX.length;

// Why: randomInt is uniform within [min, max), so picking one char per slot
// avoids modulo-bias that `Math.floor(Math.random() * len)` would have.
export function generateLicenseKey(): string {
  let body = '';
  for (let i = 0; i < KEY_BODY_LEN; i++) {
    body += KEY_ALPHABET[randomInt(0, KEY_ALPHABET.length)];
  }
  return `${KEY_PREFIX}${body}`;
}

// Why: docs show `QM-2026-****-XXXX` style (3.4 §4.4 response). Keep first
// 8 chars (prefix) and last 4 chars so users can recognise the right key,
// without exposing the rest of the secret in logs/UI.
export function maskLicenseKey(key: string): string {
  if (key.length !== 32) return key; // defensive: don't mangle unexpected input
  return `${key.slice(0, 8)}****${key.slice(-4)}`;
}

// ---------- Service surface ----------

export const MAX_DEVICES_PER_USER = 2;

export interface CreateLicenseInput {
  tier?: License['tier'];
  notes?: string | null;
  // Why: caller may set purchasedAt to a real purchase time (e.g. Gumroad
  // webhook). Defaults to now for ad-hoc admin creation.
  purchasedAt?: Date;
}

export async function createLicense(input: CreateLicenseInput = {}): Promise<License> {
  const key = generateLicenseKey();
  const [row] = await db
    .insert(licenses)
    .values({
      key,
      tier: input.tier ?? 'lifetime',
      status: 'pending',
      notes: input.notes ?? null,
      purchasedAt: input.purchasedAt ?? new Date(),
    })
    .returning();
  if (!row) throw new Error('failed to insert license');
  return row;
}

export interface ActivateLicenseInput {
  key: string;
  userId: string;
  deviceId: string;
  platform: Platform;
  appVersion?: string | null;
}

export interface ActivateLicenseResult {
  license: License;
  devices: Device[];
}

// Why: activation is a 4-step transaction:
//   1) lock the license row (SELECT ... FOR UPDATE) so two concurrent
//      activations of the same key cannot both succeed
//   2) validate key state (exists / not revoked / not bound to another user)
//   3) enforce device cap — count user's devices; if at cap AND this device
//      is new, throw DeviceLimitExceededError
//   4) upsert the device row (idempotent re-activation just refreshes
//      lastSeenAt + appVersion) and update the license row to active
export async function activateLicense(
  input: ActivateLicenseInput,
): Promise<ActivateLicenseResult> {
  return db.transaction(async (tx) => {
    const found = await tx
      .select()
      .from(licenses)
      .where(eq(licenses.key, input.key))
      .for('update')
      .limit(1);
    const license = found[0];
    if (!license) throw new LicenseNotFoundError();

    if (license.status === 'revoked') throw new LicenseExpiredError('revoked');
    if (license.status === 'expired') throw new LicenseExpiredError('expired');
    if (license.expiresAt && license.expiresAt.getTime() <= Date.now()) {
      throw new LicenseExpiredError('expired');
    }
    if (license.userId && license.userId !== input.userId) {
      throw new LicenseAlreadyUsedError();
    }

    // Auto-release stale device slots before the cap check.
    const staleDate = new Date(Date.now() - STALE_DEVICE_DAYS * 24 * 60 * 60 * 1000);
    await tx.delete(devices)
      .where(and(
        eq(devices.userId, input.userId),
        lt(devices.lastSeenAt, staleDate),
        // Keep the current device even if stale; it's about to be refreshed.
        sql`${devices.deviceId} != ${input.deviceId}`,
      ));

    const userDevices = await tx
      .select()
      .from(devices)
      .where(eq(devices.userId, input.userId));
    const alreadyBound = userDevices.some((d) => d.deviceId === input.deviceId);
    if (!alreadyBound && userDevices.length >= MAX_DEVICES_PER_USER) {
      throw new DeviceLimitExceededError(MAX_DEVICES_PER_USER);
    }

    // Upsert device (insert or refresh lastSeenAt / appVersion / platform).
    // Why: same physical device re-activating should not duplicate rows
    // (uq_devices_user_id_device_id would reject it anyway). ON CONFLICT
    // keeps the original `firstSeenAt`.
    await tx
      .insert(devices)
      .values({
        userId: input.userId,
        deviceId: input.deviceId,
        platform: input.platform,
        appVersion: input.appVersion ?? null,
      })
      .onConflictDoUpdate({
        target: [devices.userId, devices.deviceId],
        set: {
          platform: input.platform,
          appVersion: input.appVersion ?? null,
          lastSeenAt: sql`now()`,
        },
      });

    const [updatedLicense] = await tx
      .update(licenses)
      .set({
        userId: input.userId,
        status: 'active',
        activatedAt: license.activatedAt ?? new Date(),
      })
      .where(eq(licenses.id, license.id))
      .returning();
    if (!updatedLicense) throw new Error('failed to update license');

    const finalDevices = await tx
      .select()
      .from(devices)
      .where(eq(devices.userId, input.userId));

    return { license: updatedLicense, devices: finalDevices };
  });
}

export interface LicenseStatusInput {
  userId: string;
  deviceId: string;
}

export interface LicenseStatusResult {
  status: License['status'] | 'none';
  tier: License['tier'] | 'none';
  deviceRecognized: boolean;
  expiresAt: Date | null;
}

// Why: route 4.5 GET /v1/license/status — high-frequency endpoint called at
// app boot. Returns a snapshot for the (user, device) pair. Lifetime tier
// has `expiresAt = null`; trial tier may have one set. Caller (Day 5 route)
// adds `cacheUntil` based on the answer.
export async function getLicenseStatus(input: LicenseStatusInput): Promise<LicenseStatusResult> {
  // Why: a user may hold >1 license row (userId has no unique constraint), so fetch
  // all and pick deterministically — a bare limit(1) without ORDER BY could randomly
  // return an expired/pending row and downgrade an actually-active user.
  const found = await db
    .select()
    .from(licenses)
    .where(eq(licenses.userId, input.userId));
  const license = pickBestLicense(found);
  if (!license) {
    return { status: 'none', tier: 'none', deviceRecognized: false, expiresAt: null };
  }

  const deviceRows = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.userId, input.userId), eq(devices.deviceId, input.deviceId)))
    .limit(1);

  const status: License['status'] =
    license.expiresAt && license.expiresAt.getTime() <= Date.now()
      ? 'expired'
      : license.status;

  return {
    status,
    tier: license.tier,
    deviceRecognized: deviceRows.length > 0,
    expiresAt: license.expiresAt,
  };
}

// Why: maps a user's license row to the access-token claim shape used by
// login/refresh. Pure + `now` injectable so it is unit-testable without a DB.
// An expired expiresAt overrides stored status; pending/revoked have no usable
// license so they collapse to 'none' (mirrors the desktop client's narrowing).
export function mapLicenseToClaim(
  status: License['status'],
  expiresAt: Date | null,
  now: number = Date.now(),
): 'active' | 'expired' | 'none' {
  if (expiresAt && expiresAt.getTime() <= now) return 'expired';
  if (status === 'active') return 'active';
  if (status === 'expired') return 'expired';
  return 'none';
}

// Why: licenses.userId has no unique constraint, so a user CAN hold multiple license
// rows. Selecting with a bare limit(1) + no ORDER BY then returns a non-deterministic
// row (PostgreSQL doesn't guarantee order), which could randomly downgrade an active
// user. Pick the row granting the BEST access deterministically: a currently-valid
// active license wins, then expired, then the most recently activated/created row as
// a stable tiebreaker. Pure + `now` injectable for unit tests.
export function pickBestLicense<
  T extends { status: License['status']; expiresAt: Date | null; activatedAt?: Date | null; createdAt?: Date | null },
>(rows: T[], now: number = Date.now()): T | null {
  if (rows.length === 0) return null;
  const rank = (r: T): number => {
    const claim = mapLicenseToClaim(r.status, r.expiresAt, now);
    return claim === 'active' ? 2 : claim === 'expired' ? 1 : 0;
  };
  return rows.slice().sort((a, b) => {
    const byRank = rank(b) - rank(a);
    if (byRank !== 0) return byRank;
    const ta = (a.activatedAt ?? a.createdAt)?.getTime() ?? 0;
    const tb = (b.activatedAt ?? b.createdAt)?.getTime() ?? 0;
    return tb - ta;
  })[0]!;
}

// Why: resolves the JWT licenseStatus claim for a user. login/refresh previously
// hardcoded 'none', so the desktop client never saw an active license and the
// offline-grace flow (which only arms when status==='active') never fired.
export async function resolveUserLicenseStatus(
  userId: string,
): Promise<'active' | 'expired' | 'none'> {
  const found = await db
    .select({ status: licenses.status, expiresAt: licenses.expiresAt, activatedAt: licenses.activatedAt, createdAt: licenses.createdAt })
    .from(licenses)
    .where(eq(licenses.userId, userId));
  const lic = pickBestLicense(found);
  if (!lic) return 'none';
  return mapLicenseToClaim(lic.status, lic.expiresAt);
}

export interface UnbindDeviceInput {
  userId: string;
  deviceId: string;
}

export interface UnbindDeviceResult {
  remainingDevices: Device[];
}

// Why: lets a user free up a slot when they hit the 2-device cap on a new
// machine. We delete the row rather than soft-delete because the cap is
// "currently active devices", not historical.
export async function unbindDevice(input: UnbindDeviceInput): Promise<UnbindDeviceResult> {
  await db
    .delete(devices)
    .where(and(eq(devices.userId, input.userId), eq(devices.deviceId, input.deviceId)));
  const remainingDevices = await db
    .select()
    .from(devices)
    .where(eq(devices.userId, input.userId));
  return { remainingDevices };
}
