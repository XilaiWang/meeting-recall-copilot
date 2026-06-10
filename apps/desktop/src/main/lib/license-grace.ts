// Why: the offline license grace window must be tamper-resistant against
// system-clock rollback. A user who rolls their clock back must NOT be able to
// extend (or reset) the 7-day offline window — otherwise the grace period is
// trivially renewable forever. We keep a persisted monotonic high-water mark of
// the wall clock and always measure elapsed time against max(now, high-water),
// so "now" can never effectively move backwards across runs.

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface OfflineGraceInput {
  /** Raw system clock, e.g. Date.now(). */
  nowMs: number;
  /** Persisted high-water mark of every `now` ever seen (0 if never recorded). */
  maxSeenWallClockMs: number;
  /** When the current offline window began, or null if not yet in grace. */
  graceStartMs: number | null;
  /** Length of the grace window in days. */
  graceDays: number;
}

export interface OfflineGraceResult {
  /** Monotonic "now" to persist back as the new high-water mark. */
  effectiveNowMs: number;
  /** Grace start to persist (newly stamped if the window just began). */
  graceStartMs: number;
  /** Whole days of grace remaining (never negative). */
  offlineDaysLeft: number;
}

// Why: pure + fully deterministic so the clock-rollback behaviour is unit-tested
// without a DB, Electron, or the network (mirrors how matching/extract are tested).
export function computeOfflineGrace(input: OfflineGraceInput): OfflineGraceResult {
  // Monotonic clock: never let effective time drop below the highest seen.
  const effectiveNowMs = Math.max(input.nowMs, input.maxSeenWallClockMs);
  // First offline event stamps the window start at the (monotonic) current time.
  const graceStartMs = input.graceStartMs ?? effectiveNowMs;
  const elapsedDays = Math.floor((effectiveNowMs - graceStartMs) / DAY_MS);
  const offlineDaysLeft = Math.max(0, input.graceDays - elapsedDays);
  return { effectiveNowMs, graceStartMs, offlineDaysLeft };
}
