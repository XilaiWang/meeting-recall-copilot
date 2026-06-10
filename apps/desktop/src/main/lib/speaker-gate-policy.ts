// Why: pure (no electron/db) decision logic for the single-mic speaker gate, so
// vitest can exercise the activation truth table and voiceprint validation in a
// plain Node env without spawning Swift or opening SQLite. meeting.ts wires the
// I/O (spawn / appSettings); this module owns only the rules.

// Why: 'as const' union (project bans enum). 'active' = mic channel is classifying
// self vs speaker; 'off' = today's plain mic-only behaviour.
export type GateMode = 'off' | 'active';

// Why: the on-disk shape persisted under appSettings['speaker_voiceprint'] — the
// CAM++ embedding (base64) plus its dimensionality, mirrored from the Swift helper's
// 'voiceprint' stdout event { data, dim }.
export type StoredVoiceprint = { data: string; dim: number };

// Why: appSettings.valueJson is parsed as unknown; validate before trusting it so a
// corrupted/legacy row degrades to "no voiceprint" instead of arming the gate with
// garbage. Accepts only a non-empty base64 string + a positive-integer dimension.
export function parseStoredVoiceprint(raw: unknown): StoredVoiceprint | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const { data, dim } = obj;
  if (typeof data !== 'string' || data.length === 0) return null;
  if (typeof dim !== 'number' || !Number.isInteger(dim) || dim <= 0) return null;
  return { data, dim };
}

// Why: single serialization point so the persisted JSON shape stays in lockstep
// with parseStoredVoiceprint above.
export function serializeVoiceprint(v: StoredVoiceprint): string {
  return JSON.stringify(v);
}

// Why: the gate only arms as a SINGLE-MIC FALLBACK — exactly when the system tap is
// unavailable AND we have a usable voiceprint AND the CoreML model is present. In
// every other case we keep today's behaviour (dual-channel, or plain mic-only).
export function decideGateActivation(input: {
  systemAvailable: boolean;
  hasVoiceprint: boolean;
  modelAvailable: boolean;
}): GateMode {
  return !input.systemAvailable && input.hasVoiceprint && input.modelAvailable ? 'active' : 'off';
}

// Why: when the system tap RECOVERS after a single-mic fallback was armed, the gate
// must DISARM so the live system channel — not the mic voiceprint — labels the
// speaker; otherwise both channels classify the speaker at once ("双分类").
// Only a fallback-armed gate disarms: an active gate from a deliberate enrollment
// session (fallbackArmed=false) is left intact, since the user opted into it.
export function shouldDisarmOnSystemRecovery(input: {
  gating: GateMode;
  fallbackArmed: boolean;
}): boolean {
  return input.gating === 'active' && input.fallbackArmed;
}

// Why: the renderer-facing gate status — "enrolled" requires BOTH a persisted
// voiceprint AND the model file present, since a voiceprint without the model can
// never be loaded/classified, and a model without a voiceprint can never gate.
export function gateStatus(input: {
  hasVoiceprint: boolean;
  modelAvailable: boolean;
  gating: GateMode;
}): { enrolled: boolean; modelAvailable: boolean; gating: GateMode } {
  return {
    enrolled: input.hasVoiceprint && input.modelAvailable,
    modelAvailable: input.modelAvailable,
    gating: input.gating,
  };
}
