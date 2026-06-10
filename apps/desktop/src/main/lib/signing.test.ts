import { vi, describe, it, expect } from 'vitest';
import { signJson, verifyJson } from './signing.js';

// Mock the device id so signing is deterministic and the test never shells out
// to node-machine-id (which would fail in a headless CI environment).
// vi.mock is hoisted above the imports by vitest, so the mock is in place first.
vi.mock('./device-id.js', () => ({ getDeviceId: () => 'test-device-id-fixed' }));

const data = { userId: 'u1', licenseStatus: 'active', accessToken: 'abc', refreshToken: 'def' };

describe('signJson / verifyJson', () => {
  it('round-trips the original object', () => {
    expect(verifyJson(signJson(data))).toEqual(data);
  });

  it('rejects a tampered payload (HMAC mismatch)', () => {
    const w = JSON.parse(signJson(data)) as { payload: string; sig: string };
    w.payload = JSON.stringify({ ...data, licenseStatus: 'expired' }); // escalate license
    expect(verifyJson(JSON.stringify(w))).toBeNull();
  });

  it('rejects a tampered signature (same length, one char flipped)', () => {
    const w = JSON.parse(signJson(data)) as { payload: string; sig: string };
    const last = w.sig.slice(-1);
    w.sig = w.sig.slice(0, -1) + (last === '0' ? '1' : '0');
    expect(verifyJson(JSON.stringify(w))).toBeNull();
  });

  it('returns null for non-JSON input', () => {
    expect(verifyJson('not json at all')).toBeNull();
  });

  it('returns null when the wrapper is missing payload/sig', () => {
    expect(verifyJson('{}')).toBeNull();
    expect(verifyJson('{"payload":"x"}')).toBeNull();
  });

  it('produces different signatures for different data', () => {
    const a = JSON.parse(signJson({ x: 1 })) as { sig: string };
    const b = JSON.parse(signJson({ x: 2 })) as { sig: string };
    expect(a.sig).not.toBe(b.sig);
  });
});
