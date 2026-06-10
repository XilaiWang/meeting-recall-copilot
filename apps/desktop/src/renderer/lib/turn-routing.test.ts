import { describe, it, expect } from 'vitest';
import { routeSegment, shouldUpdateLastQuestion, normalizeRole } from './turn-routing.js';

describe('routeSegment', () => {
  it('classifies the speaker audio when the system channel is available', () => {
    expect(routeSegment('speaker', { systemAvailable: true })).toBe('classify');
  });

  it('never classifies your own audio — display only (no false matches on own speech)', () => {
    expect(routeSegment('self', { systemAvailable: true })).toBe('display-only');
  });

  it('degrades to display-only for everything when the system channel is unavailable', () => {
    // The point: do NOT fall back to single-mic full classification.
    expect(routeSegment('self', { systemAvailable: false })).toBe('display-only');
    expect(routeSegment('speaker', { systemAvailable: false })).toBe('display-only');
  });

  it('gating off + system unavailable still degrades to display-only', () => {
    expect(routeSegment('speaker', { systemAvailable: false, gating: 'off' })).toBe('display-only');
    expect(routeSegment('self', { systemAvailable: false, gating: 'off' })).toBe('display-only');
  });

  it('classifies the speaker audio when single-mic gating is active even though system is unavailable', () => {
    // Single-mic fallback: the CoreML speaker gate vouches for the role.
    expect(routeSegment('speaker', { systemAvailable: false, gating: 'active' })).toBe('classify');
  });

  it('never classifies your own audio even when gating is active', () => {
    expect(routeSegment('self', { systemAvailable: false, gating: 'active' })).toBe('display-only');
    expect(routeSegment('self', { systemAvailable: true, gating: 'active' })).toBe('display-only');
  });
});

describe('shouldUpdateLastQuestion', () => {
  it('only the speaker segments update the follow-up context', () => {
    expect(shouldUpdateLastQuestion('speaker')).toBe(true);
    expect(shouldUpdateLastQuestion('self')).toBe(false);
  });
});

describe('normalizeRole', () => {
  it('maps speaker through and defaults everything else to self', () => {
    expect(normalizeRole('speaker')).toBe('speaker');
    expect(normalizeRole('self')).toBe('self');
    expect(normalizeRole(undefined)).toBe('self');
    expect(normalizeRole('weird')).toBe('self');
  });
});
