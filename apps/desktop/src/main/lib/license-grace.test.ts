import { describe, it, expect } from 'vitest';
import { computeOfflineGrace, DAY_MS } from './license-grace.js';

const GRACE = 7;
const T0 = 1_000_000_000_000; // fixed reference instant (ms)

describe('computeOfflineGrace', () => {
  it('first offline event stamps grace start and returns the full window', () => {
    const r = computeOfflineGrace({ nowMs: T0, maxSeenWallClockMs: 0, graceStartMs: null, graceDays: GRACE });
    expect(r.graceStartMs).toBe(T0);
    expect(r.effectiveNowMs).toBe(T0);
    expect(r.offlineDaysLeft).toBe(GRACE);
  });

  it('counts down whole days elapsed since grace start', () => {
    const now = T0 + 3 * DAY_MS;
    const r = computeOfflineGrace({ nowMs: now, maxSeenWallClockMs: now, graceStartMs: T0, graceDays: GRACE });
    expect(r.offlineDaysLeft).toBe(GRACE - 3);
  });

  it('clamps remaining days to 0 once the window fully elapses', () => {
    const now = T0 + 10 * DAY_MS;
    const r = computeOfflineGrace({ nowMs: now, maxSeenWallClockMs: now, graceStartMs: T0, graceDays: GRACE });
    expect(r.offlineDaysLeft).toBe(0);
  });

  it('clock rollback cannot extend or reset the window (monotonic guard)', () => {
    // We've already observed 5 days into the window...
    const maxSeen = T0 + 5 * DAY_MS;
    // ...then the user rolls the system clock back to the grace start.
    const r = computeOfflineGrace({ nowMs: T0, maxSeenWallClockMs: maxSeen, graceStartMs: T0, graceDays: GRACE });
    // Elapsed is measured against the high-water mark, so it stays at 5 days in.
    expect(r.effectiveNowMs).toBe(maxSeen);
    expect(r.offlineDaysLeft).toBe(GRACE - 5);
  });

  it('clock rollback cannot resurrect an already-expired window', () => {
    const maxSeen = T0 + 9 * DAY_MS; // already blown past the 7-day window
    const r = computeOfflineGrace({ nowMs: T0, maxSeenWallClockMs: maxSeen, graceStartMs: T0, graceDays: GRACE });
    expect(r.offlineDaysLeft).toBe(0);
  });

  it('advances the high-water mark when the clock legitimately moves forward', () => {
    const maxSeen = T0 + 2 * DAY_MS;
    const now = T0 + 4 * DAY_MS; // real time progressed beyond what we'd seen
    const r = computeOfflineGrace({ nowMs: now, maxSeenWallClockMs: maxSeen, graceStartMs: T0, graceDays: GRACE });
    expect(r.effectiveNowMs).toBe(now);
    expect(r.offlineDaysLeft).toBe(GRACE - 4);
  });
});
