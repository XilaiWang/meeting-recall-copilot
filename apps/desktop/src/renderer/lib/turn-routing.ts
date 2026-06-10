// Pure role-routing for the dual-channel meeting pipeline. Keeps the "what to
// do with a finalized segment" decision testable and out of the React component.

export type SpeechRole = 'self' | 'speaker';
export type SegmentAction = 'classify' | 'display-only';

// When the system (speaker) channel works, ONLY the other speaker's audio drives
// classification + card matching — your own speech is display-only, so
// you talking never triggers a match (the false-positive we set out to
// fix). When the system channel is unavailable we normally classify NOTHING (role
// can't be trusted), UNLESS single-mic gating is active: the CoreML speaker gate
// has labelled this mic segment as the other speaker, so role is again
// trustworthy and the speaker's audio may drive classification.
export function routeSegment(
  role: SpeechRole,
  opts: { systemAvailable: boolean; gating?: 'off' | 'active' },
): SegmentAction {
  return role === 'speaker' && (opts.systemAvailable || opts.gating === 'active')
    ? 'classify'
    : 'display-only';
}

// Only the speaker's segments may become the "last detected question" used to give
// anaphoric follow-ups their context.
export function shouldUpdateLastQuestion(role: SpeechRole): boolean {
  return role === 'speaker';
}

// Normalize a possibly-absent role from the helper event (backward compatible:
// no role → self, matching SpeechHelper's default).
export function normalizeRole(role: string | undefined): SpeechRole {
  return role === 'speaker' ? 'speaker' : 'self';
}
