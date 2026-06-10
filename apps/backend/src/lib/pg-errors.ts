// Why: drizzle-orm v0.45+ wraps PG errors in DrizzleQueryError with a `cause`
// property. Checking recursively handles both the direct PG error shape and
// the wrapped form so callers never need to know which drizzle version is running.
export function isPgUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  if ('code' in err && (err as Record<string, unknown>).code === '23505') return true;
  if ('cause' in err) return isPgUniqueViolation((err as Record<string, unknown>).cause);
  return false;
}
