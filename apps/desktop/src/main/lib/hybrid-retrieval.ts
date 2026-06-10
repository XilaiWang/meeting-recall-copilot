import { createHash } from 'node:crypto';

// Why: PURE retrieval logic (no electron/db/onnx imports) so vitest can exercise RRF
// fusion, the false-positive gate, tokenization and FTS query building in plain Node.
// search-index.ts wires these to sqlite-vec / FTS5 / the embedding service.

// ── Tokenization (ported from renderer matching.ts so the main-process search layer
//    reuses the SAME lexical logic — "复用 not 保留两套") ───────────────────────────

// Why: inject adjacent CJK bigrams as space-separated tokens so FTS5's default
// tokenizer (which treats a whole Han run as one opaque token) can match 2-char
// Chinese terms like "缓存". Mirrors the prior Orama zhBigrams approach.
export function zhBigrams(text: string): string {
  const out: string[] = [];
  for (const phrase of text.match(/[一-鿿]+/g) ?? []) {
    for (let i = 0; i < phrase.length - 1; i++) out.push(phrase.slice(i, i + 2));
  }
  return out.join(' ');
}

// Why: distinct lexical tokens — Latin words ≥3 chars + CJK single chars and bigrams.
// Used both for the lexical-overlap gate signal and to build FTS MATCH queries.
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const result = new Set<string>();
  for (const w of lower.match(/[a-z0-9]{3,}/g) ?? []) result.add(w);
  for (const phrase of lower.match(/[一-鿿]+/g) ?? []) {
    for (let i = 0; i < phrase.length; i++) {
      result.add(phrase[i]!);
      if (i + 1 < phrase.length) result.add(phrase.slice(i, i + 2));
    }
  }
  return [...result].filter((t) => t.length >= 2);
}

// Why: the indexed FTS text = raw + injected bigrams, so both English words and
// 2-char Chinese terms are matchable. Applied per card field at ingest time.
export function injectBigrams(raw: string): string {
  const bg = zhBigrams(raw);
  return bg ? `${raw} ${bg}` : raw;
}

// Why: turn arbitrary ASR/user text into a SAFE FTS5 MATCH query. Raw text can't go
// into MATCH directly — characters like " * : ( ) are FTS5 operators and would throw
// or mis-parse. We extract tokens (incl. CJK bigrams), double-quote each (escaping
// inner quotes), and OR them. Returns '' when there are no usable tokens.
export function buildFtsMatchQuery(text: string): string {
  const tokens = tokenize(text);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

// Why: count DISTINCT query tokens a card's text actually contains — the absolute
// lexical-overlap signal the false-positive gate uses (a sharp binary-ish signal that
// semantic cosine lacks). cardText should be title+summary+details+tags lowercased.
export function countMatchedTokens(cardText: string, queryTokens: string[]): number {
  const hay = cardText.toLowerCase();
  let n = 0;
  for (const t of queryTokens) if (hay.includes(t)) n++;
  return n;
}

// ── RRF fusion ──────────────────────────────────────────────────────────────────

// Why: Reciprocal Rank Fusion merges the semantic (vec KNN) and lexical (FTS bm25)
// ranked lists without needing comparable scores — each list contributes 1/(k+rank).
// k=60 is the standard RRF constant (dampens the weight of top ranks just enough).
export const RRF_K = 60;

export interface FusedHit {
  cardId: string;
  rrf: number;
  vecRank: number | null; // 0-based rank in the vector list, null if absent
  ftsRank: number | null; // 0-based rank in the lexical list, null if absent
}

// rankedLists: each is an ordered array of cardIds (best first). Returns hits sorted
// by descending RRF score. Pure — no ties broken by anything but insertion order via sort stability.
export function rrfFuse(vecList: string[], ftsList: string[], k: number = RRF_K): FusedHit[] {
  const acc = new Map<string, FusedHit>();
  const add = (id: string, rank: number, which: 'vec' | 'fts') => {
    const cur = acc.get(id) ?? { cardId: id, rrf: 0, vecRank: null, ftsRank: null };
    cur.rrf += 1 / (k + rank + 1); // +1 → 1-based rank in the RRF formula
    if (which === 'vec') cur.vecRank = rank;
    else cur.ftsRank = rank;
    acc.set(id, cur);
  };
  vecList.forEach((id, i) => add(id, i, 'vec'));
  ftsList.forEach((id, i) => add(id, i, 'fts'));
  return [...acc.values()].sort((a, b) => b.rrf - a.rrf);
}

// ── False-positive gate (decision B: hybrid lexical-OR-high-cosine) ───────────────

// Why: the product's core promise is "don't fire on your own rambling".
// e5 cosines are compressed (~0.85 baseline) so an absolute cosine threshold alone is
// a knife-edge; lexical overlap is a sharp signal but misses pure paraphrases. So we
// gate on EITHER: enough literal token overlap, OR a high-confidence semantic cosine.
// Thresholds are starting points to be calibrated on real meeting audio.
export const GATE_MIN_LEXICAL_TOKENS = 2; // ≥ this many distinct query tokens matched
export const GATE_HIGH_COSINE = 0.9; // OR cosine ≥ this (TODO calibrate on device)

export interface GateInput {
  topMatchedTokens: number; // countMatchedTokens for the top fused card
  queryTokenCount: number; // tokenize(query).length
  topCosine: number | null; // cosine sim of the top card (null if no vector hit)
}

// A normal multi-token query must match ≥ GATE_MIN_LEXICAL_TOKENS distinct tokens, OR
// the top card must clear the high-cosine bar. A 1-token query (single distinctive
// keyword) only needs its one token to land, so we don't over-suppress those.
export function passesGate({ topMatchedTokens, queryTokenCount, topCosine }: GateInput): boolean {
  if (queryTokenCount <= 0) return false;
  const requiredLexical = Math.min(GATE_MIN_LEXICAL_TOKENS, queryTokenCount);
  if (topMatchedTokens >= requiredLexical) return true;
  if (topCosine !== null && topCosine >= GATE_HIGH_COSINE) return true;
  return false;
}

// ── Content hash for incremental ingestion ───────────────────────────────────────

// Why: re-embed a card only when its searchable text changes. Hash the exact fields
// we embed/index (title+summary+details+tags) so an unrelated edit (e.g. isImportant)
// doesn't trigger a needless re-embed.
export function cardContentHash(fields: { title: string; summary: string; details: string; tags: string[] }): string {
  const joined = [fields.title, fields.summary, fields.details, (fields.tags ?? []).join(',')].join('');
  return createHash('sha1').update(joined).digest('hex');
}

// Why: the canonical "passage" text we embed — title + summary + details (decision D3).
// e5-small caps at 512 tokens; we trim very long details so the tail doesn't get
// silently truncated mid-word by the tokenizer (lexical FTS still indexes full details).
const MAX_PASSAGE_CHARS = 1800;
export function buildPassageText(fields: { title: string; summary: string; details: string }): string {
  const t = [fields.title, fields.summary, fields.details].filter(Boolean).join('。');
  return t.length > MAX_PASSAGE_CHARS ? t.slice(0, MAX_PASSAGE_CHARS) : t;
}
