import { describe, it, expect } from 'vitest';
import {
  parseStoredVoiceprint,
  serializeVoiceprint,
  decideGateActivation,
  shouldDisarmOnSystemRecovery,
  gateStatus,
  type StoredVoiceprint,
} from './speaker-gate-policy.js';

describe('parseStoredVoiceprint', () => {
  it('accepts a well-formed voiceprint', () => {
    expect(parseStoredVoiceprint({ data: 'YWJj', dim: 192 })).toEqual({ data: 'YWJj', dim: 192 });
  });

  it('ignores extra keys but keeps the validated fields', () => {
    expect(parseStoredVoiceprint({ data: 'YWJj', dim: 192, extra: 'x' })).toEqual({ data: 'YWJj', dim: 192 });
  });

  it('rejects non-object inputs', () => {
    expect(parseStoredVoiceprint(null)).toBeNull();
    expect(parseStoredVoiceprint(undefined)).toBeNull();
    expect(parseStoredVoiceprint('YWJj')).toBeNull();
    expect(parseStoredVoiceprint(42)).toBeNull();
    expect(parseStoredVoiceprint([])).toBeNull();
  });

  it('rejects a missing or empty data string', () => {
    expect(parseStoredVoiceprint({ dim: 192 })).toBeNull();
    expect(parseStoredVoiceprint({ data: '', dim: 192 })).toBeNull();
  });

  it('rejects non-string data', () => {
    expect(parseStoredVoiceprint({ data: 123, dim: 192 })).toBeNull();
    expect(parseStoredVoiceprint({ data: null, dim: 192 })).toBeNull();
  });

  it('rejects non-positive, non-integer, or non-number dim', () => {
    expect(parseStoredVoiceprint({ data: 'YWJj', dim: 0 })).toBeNull();
    expect(parseStoredVoiceprint({ data: 'YWJj', dim: -1 })).toBeNull();
    expect(parseStoredVoiceprint({ data: 'YWJj', dim: 1.5 })).toBeNull();
    expect(parseStoredVoiceprint({ data: 'YWJj', dim: '192' })).toBeNull();
    expect(parseStoredVoiceprint({ data: 'YWJj', dim: NaN })).toBeNull();
  });
});

describe('serializeVoiceprint', () => {
  it('round-trips through parseStoredVoiceprint', () => {
    const v: StoredVoiceprint = { data: 'YWJj', dim: 192 };
    const parsed = parseStoredVoiceprint(JSON.parse(serializeVoiceprint(v)));
    expect(parsed).toEqual(v);
  });

  it('produces JSON with exactly the data and dim fields', () => {
    expect(serializeVoiceprint({ data: 'abc', dim: 256 })).toBe('{"data":"abc","dim":256}');
  });
});

describe('decideGateActivation', () => {
  // Truth table: 'active' ONLY when the system tap is unavailable AND we have an
  // enrolled voiceprint AND the model is present.
  it('arms when system unavailable + voiceprint + model', () => {
    expect(decideGateActivation({ systemAvailable: false, hasVoiceprint: true, modelAvailable: true })).toBe('active');
  });

  it('stays off when the system tap is available (dual-channel preferred)', () => {
    expect(decideGateActivation({ systemAvailable: true, hasVoiceprint: true, modelAvailable: true })).toBe('off');
  });

  it('stays off without a voiceprint', () => {
    expect(decideGateActivation({ systemAvailable: false, hasVoiceprint: false, modelAvailable: true })).toBe('off');
  });

  it('stays off without the model', () => {
    expect(decideGateActivation({ systemAvailable: false, hasVoiceprint: true, modelAvailable: false })).toBe('off');
  });

  it('stays off in the fully-disabled case', () => {
    expect(decideGateActivation({ systemAvailable: false, hasVoiceprint: false, modelAvailable: false })).toBe('off');
  });
});

describe('shouldDisarmOnSystemRecovery', () => {
  it('disarms a fallback-armed active gate when the system tap recovers', () => {
    expect(shouldDisarmOnSystemRecovery({ gating: 'active', fallbackArmed: true })).toBe(true);
  });

  it('leaves an enrollment-driven active gate (not fallback) intact', () => {
    expect(shouldDisarmOnSystemRecovery({ gating: 'active', fallbackArmed: false })).toBe(false);
  });

  it('is a no-op when the gate is already off', () => {
    expect(shouldDisarmOnSystemRecovery({ gating: 'off', fallbackArmed: true })).toBe(false);
    expect(shouldDisarmOnSystemRecovery({ gating: 'off', fallbackArmed: false })).toBe(false);
  });
});

describe('gateStatus', () => {
  it('reports enrolled only when both voiceprint and model are present', () => {
    expect(gateStatus({ hasVoiceprint: true, modelAvailable: true, gating: 'active' })).toEqual({
      enrolled: true,
      modelAvailable: true,
      gating: 'active',
    });
  });

  it('is not enrolled with a voiceprint but no model', () => {
    expect(gateStatus({ hasVoiceprint: true, modelAvailable: false, gating: 'off' })).toEqual({
      enrolled: false,
      modelAvailable: false,
      gating: 'off',
    });
  });

  it('is not enrolled with a model but no voiceprint', () => {
    expect(gateStatus({ hasVoiceprint: false, modelAvailable: true, gating: 'off' })).toEqual({
      enrolled: false,
      modelAvailable: true,
      gating: 'off',
    });
  });

  it('passes the gating mode through unchanged', () => {
    expect(gateStatus({ hasVoiceprint: false, modelAvailable: false, gating: 'off' }).gating).toBe('off');
  });
});
