import type { Card } from '../env.js';

// Why: the lexical matching/BM25/Levenshtein logic that used to live here was replaced
// by the main-process hybrid-retrieval engine (FTS5 + sqlite-vec, RRF). Only the two
// renderer-side helpers that aren't retrieval remain: ASR locale detection and
// contextual-keyword extraction (fed back to the Swift recognizer as hot words).

export interface ScoredCard extends Card { score: number }

// Why: pull a few high-signal keywords (tags + title words) from the top matched cards
// to prime the Swift SFSpeechRecognizer's contextualStrings, improving transcription of
// domain terms the speaker is likely to use next.
export function extractContextWords(cards: ScoredCard[]): string[] {
  const words = new Set<string>();
  for (const card of cards.slice(0, 3)) {
    for (const tag of card.tags) { if (tag.length >= 2) words.add(tag); }
    for (const w of card.title.split(/[\s,，、·]+/)) { if (w.length >= 2) words.add(w); }
  }
  return [...words].slice(0, 50);
}

// Why: Chinese char ratio ≥ 30% → zh-CN; below that → en-US.
// Sampling the last 500 chars avoids stale early-session bias.
export function detectAsrLocale(sample: string): string {
  const zh = (sample.match(/[一-鿿]/g) ?? []).length;
  const en = (sample.match(/[a-zA-Z]/g) ?? []).length;
  const total = zh + en;
  if (total < 5) return 'zh-CN';
  return zh / total >= 0.3 ? 'zh-CN' : 'en-US';
}
