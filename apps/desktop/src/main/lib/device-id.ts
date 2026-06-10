import { createHash } from 'node:crypto';
import { machineIdSync } from 'node-machine-id';

// Why: cache so the (slightly expensive) OS syscall runs only once per process.
let _cached: string | null = null;

// Why: SHA-256 over the raw machine ID so we send a fixed-length, opaque
// identifier to the backend without exposing the underlying OS-level UUID.
// The backend only needs a stable string that identifies this hardware; the
// specific value doesn't matter for security — uniqueness does.
export function getDeviceId(): string {
  if (_cached) return _cached;
  const raw = machineIdSync(true); // true = return original OS UUID, not hashed
  _cached = createHash('sha256').update(raw).digest('hex');
  return _cached;
}
