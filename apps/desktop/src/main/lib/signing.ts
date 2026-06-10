import { createHmac } from 'node:crypto';
import { getDeviceId } from './device-id.js';

// Why: deriving the HMAC key from the machine ID makes signatures machine-
// specific. Copying the SQLite file to another device → key mismatch → cache
// treated as unsigned and ignored. HKDF-lite: PRK = HMAC-SHA256(salt, IKM).
function getSigningKey(): string {
  return createHmac('sha256', 'qa-matching-signing-v1')
    .update(getDeviceId())
    .digest('hex');
}

export function signJson(data: unknown): string {
  const payload = JSON.stringify(data);
  const sig = createHmac('sha256', getSigningKey()).update(payload).digest('hex');
  return JSON.stringify({ payload, sig });
}

// Returns the parsed data if the signature is valid, or null if tampered / malformed.
export function verifyJson<T>(raw: string): T | null {
  try {
    const wrapper = JSON.parse(raw) as unknown;
    if (
      typeof wrapper !== 'object' || wrapper === null ||
      !('payload' in wrapper) || !('sig' in wrapper) ||
      typeof (wrapper as Record<string, unknown>).payload !== 'string' ||
      typeof (wrapper as Record<string, unknown>).sig !== 'string'
    ) return null;
    const { payload, sig } = wrapper as { payload: string; sig: string };
    const expected = createHmac('sha256', getSigningKey()).update(payload).digest('hex');
    // Constant-time compare to avoid timing oracle (academic risk here, but cheap).
    if (sig.length !== expected.length) return null;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    if (diff !== 0) return null;
    return JSON.parse(payload) as T;
  } catch {
    return null;
  }
}
