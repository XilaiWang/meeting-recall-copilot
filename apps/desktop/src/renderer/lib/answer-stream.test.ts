import { describe, it, expect } from 'vitest';
import { startAnswer, applyAnswerDelta, finishAnswer, IDLE_ANSWER } from './answer-stream.js';

describe('answer-stream session guard', () => {
  it('startAnswer resets text and marks streaming', () => {
    expect(startAnswer(5)).toEqual({ requestId: 5, text: '', status: 'streaming' });
  });

  it('accumulates deltas for the matching requestId', () => {
    let s = startAnswer(1);
    s = applyAnswerDelta(s, { requestId: 1, delta: 'Hel' });
    s = applyAnswerDelta(s, { requestId: 1, delta: 'lo' });
    expect(s.text).toBe('Hello');
    expect(s.status).toBe('streaming');
  });

  it('DROPS a stale delta from a superseded question (the core guard)', () => {
    let s = startAnswer(2);
    s = applyAnswerDelta(s, { requestId: 1, delta: 'old-question-token' }); // stale
    s = applyAnswerDelta(s, { requestId: 2, delta: 'new' });
    expect(s.text).toBe('new'); // the stale token never bled in
  });

  it('finishAnswer marks done for the current stream', () => {
    const s = finishAnswer(startAnswer(3), { requestId: 3, ok: true });
    expect(s.status).toBe('done');
  });

  it('finishAnswer ignores a stale done event', () => {
    const s = applyAnswerDelta(startAnswer(4), { requestId: 4, delta: 'partial' });
    const after = finishAnswer(s, { requestId: 1, ok: true }); // stale
    expect(after.status).toBe('streaming'); // unchanged
  });

  it('ok=false with no text yet → error; with partial text → keep (done)', () => {
    expect(finishAnswer(startAnswer(6), { requestId: 6, ok: false }).status).toBe('error');
    const partial = applyAnswerDelta(startAnswer(7), { requestId: 7, delta: 'x' });
    expect(finishAnswer(partial, { requestId: 7, ok: false }).status).toBe('done');
  });

  it('IDLE_ANSWER deltas (requestId 0) are dropped after reset to idle', () => {
    const s = applyAnswerDelta(IDLE_ANSWER, { requestId: 9, delta: 'late' });
    expect(s.text).toBe(''); // idle has requestId 0, so a real stream's deltas are ignored
  });
});
