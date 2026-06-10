import { z } from 'zod';

// Why: as-const arrays instead of TS enums (CLAUDE.md convention) — the
// actual DB-level enforcement uses pgEnum; these arrays are the API boundary
// guard and the source of the TS union types below.
export const outcomes = ['went_well', 'needs_followup', 'no_progress', 'prefer_not_to_say'] as const;
export const cardHelpfulOptions = ['used_helpful', 'used_not_helpful', 'not_used'] as const;
export const willUseNextOptions = ['definitely', 'maybe', 'depends', 'no'] as const;

export const submitSurveySchema = z.object({
  projectId: z.string().uuid(),
  meetingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD'),
  // Why: companyNameHash is SHA-256 hex (64 chars). Storing only the hash
  // means we never hold the plain company name on the server (3.5 privacy).
  companyNameHash: z
    .string()
    .length(64)
    .regex(/^[0-9a-f]{64}$/, 'must be lowercase sha256 hex')
    .optional(),
  outcome: z.enum(outcomes),
  cardHelpful: z.enum(cardHelpfulOptions),
  willUseNext: z.enum(willUseNextOptions),
  freeText: z.string().max(500).optional(),
});

export type SubmitSurveyInput = z.infer<typeof submitSurveySchema>;
export type Outcome = (typeof outcomes)[number];
export type CardHelpful = (typeof cardHelpfulOptions)[number];
export type WillUseNext = (typeof willUseNextOptions)[number];
