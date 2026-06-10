import { ipcMain } from 'electron';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { usersLocal } from '../db/schema.js';
import { getSession, setSession } from '../store/session.js';
import { getDeviceId } from '../lib/device-id.js';
import { computeOfflineGrace } from '../lib/license-grace.js';
import { apiGet } from '../api/client.js';
import type { ApiEnvelope } from '@qa-matching/shared';

const GRACE_DAYS = 7;
// Why: 5 s timeout prevents a frozen launch screen on captive portals or
// lossy networks. Long enough for a slow 3G response; short enough to
// feel instant on failure.
const ONLINE_CHECK_TIMEOUT_MS = 5_000;

interface LicenseStatusData {
  status: 'active' | 'expired' | 'none' | 'revoked';
  tier: string;
  deviceRecognized: boolean;
  expiresAt: string | null;
  cacheUntil: string;
}

async function tryFetchLicenseStatus(
  accessToken: string,
): Promise<ApiEnvelope<LicenseStatusData> | null> {
  const deviceId = getDeviceId();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ONLINE_CHECK_TIMEOUT_MS);
  });
  const attempt = apiGet<LicenseStatusData>('/v1/license/status', accessToken, {
    'X-Device-Id': deviceId,
  }).catch(() => null);
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Why: grace period only applies to users whose last-known license was active.
// Non-active users don't need a grace window — their cached status already
// reflects reality (expired/none). This prevents grace from masking a truly
// inactive license when the network is down.
export async function checkLicenseGrace(
  userId: string,
  accessToken: string,
): Promise<{ offlineDaysLeft: number | null }> {
  const db = getDb();
  const [user] = await db.select().from(usersLocal).where(eq(usersLocal.id, userId));
  if (!user || user.licenseStatus !== 'active') return { offlineDaysLeft: null };

  const res = await tryFetchLicenseStatus(accessToken);

  if (res?.ok && res.data) {
    // Online — refresh local cache and clear any outstanding grace period.
    // Narrow 'revoked' (not in local enum) to 'none' so the DB write is always valid.
    const validStatus = (
      ['active', 'expired', 'none'] as const
    ).includes(res.data.status as 'active' | 'expired' | 'none')
      ? (res.data.status as 'active' | 'expired' | 'none')
      : 'none';
    // Advance the monotonic clock high-water mark, persist the server's cacheUntil
    // alongside the refreshed status, and clear any outstanding grace window.
    const effectiveNowMs = Math.max(Date.now(), user.maxSeenWallClock?.getTime() ?? 0);
    await db
      .update(usersLocal)
      .set({
        licenseStatus: validStatus,
        licenseCacheFetchedAt: new Date(),
        licenseCacheUntil: res.data.cacheUntil ? new Date(res.data.cacheUntil) : null,
        licenseGraceStart: null,
        maxSeenWallClock: new Date(effectiveNowMs),
      })
      .where(eq(usersLocal.id, userId));
    // Sync in-memory session so the current auth:session response is not stale.
    const session = getSession();
    if (session && session.userId === userId && session.licenseStatus !== validStatus) {
      setSession({ ...session, licenseStatus: validStatus });
    }
    return { offlineDaysLeft: null };
  }

  // Network failure or timeout — manage the 7-day grace period using a monotonic
  // clock, so rolling the system clock back cannot extend or reset the window.
  const { effectiveNowMs, graceStartMs, offlineDaysLeft } = computeOfflineGrace({
    nowMs: Date.now(),
    maxSeenWallClockMs: user.maxSeenWallClock?.getTime() ?? 0,
    graceStartMs: user.licenseGraceStart?.getTime() ?? null,
    graceDays: GRACE_DAYS,
  });
  await db
    .update(usersLocal)
    .set({
      licenseGraceStart: new Date(graceStartMs),
      maxSeenWallClock: new Date(effectiveNowMs),
    })
    .where(eq(usersLocal.id, userId));
  return { offlineDaysLeft };
}

export function registerLicenseIpcHandlers() {
  // Why: on-demand re-check lets the renderer refresh status after the user
  // restores their network connection without requiring a full app restart.
  ipcMain.handle('license:check', async () => {
    const session = getSession();
    if (!session) return { offlineDaysLeft: null };
    return checkLicenseGrace(session.userId, session.accessToken);
  });
}
