import { z } from 'zod';

// Why: 8+ chars with at least 1 digit is reasonable default (OWASP).
// Not pretending to be a strong policy; password managers handle the rest.
export const signupSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128).regex(/\d/, 'password must contain at least 1 digit'),
  displayName: z.string().max(100).optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// Why: refresh tokens are opaque "${uuid}-${uuid}" strings (73 chars currently),
// and the column allows up to 128. We only enforce length/type bounds here;
// real validation is the DB lookup. No format/regex check on purpose, so the
// token shape can evolve without a coupled client release.
export const refreshSchema = z.object({
  refreshToken: z.string().min(64).max(128),
});

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
