import { z } from 'zod';

// Why: license keys are exactly 32 chars and start with the QM-2026- prefix
// (see apps/backend/src/services/license-service.ts:KEY_PREFIX). The body
// alphabet check (no 0/O/1/I/L/U) is enforced at generation time; we don't
// re-check it here because (a) typos are caught by the DB lookup returning
// LICENSE_NOT_FOUND with a clear error, and (b) baking the alphabet into the
// public API contract would couple clients to that internal detail.
export const activateLicenseSchema = z.object({
  licenseKey: z.string().length(32).startsWith('QM-2026-'),
  platform: z.enum(['macos_intel', 'macos_arm', 'windows']),
  appVersion: z.string().max(20).optional(),
});

// Why: deviceId is the same opaque client-generated string the `devices.device_id`
// column stores (varchar(64)). Min 1 rejects empty strings; max 64 matches the
// DB column so over-long values fail at the API boundary, not in pg.
export const unbindDeviceSchema = z.object({
  deviceId: z.string().min(1).max(64),
});

export type ActivateLicenseInput = z.infer<typeof activateLicenseSchema>;
export type UnbindDeviceInput = z.infer<typeof unbindDeviceSchema>;
