import type { Context } from 'hono';
import type { ZodError } from 'zod';

// Why: @hono/zod-validator returns its own { success, error: { issues } }
// shape on validation failure. Transform to the project's standard
// { ok, data, error: { code, message } } envelope so every client can
// always check `response.ok` first without special-casing validation errors.
export function envelopeValidationHook(
  result: { success: true; data: unknown } | { success: false; error: ZodError; data: unknown },
  c: Context,
): Response | void {
  if (!result.success) {
    return c.json(
      {
        ok: false,
        data: null,
        error: {
          code: 'VALIDATION_ERROR',
          message: result.error.issues.map((i) => i.message).join('; '),
        },
      },
      400,
    );
  }
}
