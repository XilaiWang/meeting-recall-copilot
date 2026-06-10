// Why: when no card confidently matches a question (see matching.ts gate), we
// stream a short LLM "fallback answer" grounded in the closest cards. Meetings
// are rapid-fire, so a previous question's late tokens must never bleed into the
// new question's answer. This module is the session guard: every delta carries the
// requestId it belongs to, and we drop any whose id != the current stream's.

export type AnswerStatus = 'idle' | 'streaming' | 'done' | 'error';

export interface AnswerState {
  requestId: number;
  text: string;
  status: AnswerStatus;
}

export const IDLE_ANSWER: AnswerState = { requestId: 0, text: '', status: 'idle' };

// Begin a new stream for requestId — resets text. The bumped requestId is what
// invalidates any still-in-flight older stream's deltas.
export function startAnswer(requestId: number): AnswerState {
  return { requestId, text: '', status: 'streaming' };
}

// Append a streamed delta, but ONLY if it belongs to the current stream.
export function applyAnswerDelta(state: AnswerState, evt: { requestId: number; delta: string }): AnswerState {
  if (evt.requestId !== state.requestId) return state; // stale delta from a superseded question
  return { ...state, text: state.text + evt.delta, status: 'streaming' };
}

// Finalise the current stream. ok=false with no text so far → error (e.g. no LLM
// configured / request failed); ok=false after partial text → keep what we have.
export function finishAnswer(state: AnswerState, evt: { requestId: number; ok: boolean }): AnswerState {
  if (evt.requestId !== state.requestId) return state;
  if (evt.ok) return { ...state, status: 'done' };
  return { ...state, status: state.text ? 'done' : 'error' };
}
