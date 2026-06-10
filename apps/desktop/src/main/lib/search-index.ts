import { eq, inArray, desc } from 'drizzle-orm';
import type { Database } from 'better-sqlite3';
import { getDb, getRawSqlite, isVecAvailable } from '../db/client.js';
import { cards, projects, type CardRow } from '../db/schema.js';
import { embeddingService } from './embedding.js';
import {
  injectBigrams, buildFtsMatchQuery, tokenize, countMatchedTokens,
  rrfFuse, passesGate, cardContentHash, buildPassageText,
} from './hybrid-retrieval.js';

// Why: the I/O layer of hybrid retrieval. FTS5 (fts_cards) + vec0 (vec_cards) are
// virtual tables Drizzle can't model, so this module issues raw prepared statements
// against the handle from getRawSqlite() — the one justified raw-SQL exception. Pure
// scoring/fusion/gate logic lives in hybrid-retrieval.ts; embedding in embedding.ts.

// Over-fetch each arm well beyond top-k so the fusion + per-project filtering still
// has candidates; the DBs here are small (hundreds–low thousands of cards).
const VEC_K = 64;
const FTS_LIMIT = 64;
const MEETING_TOP_K = 5;

// ── prepared statements (lazy: getRawSqlite() is only valid after getDb()) ──
// Why: vec_cards is a vec0 virtual table — its statements can only be prepared when the
// sqlite-vec extension loaded successfully. If we eagerly prepare them alongside FTS5
// statements and vec0 isn't available, the entire stmts() call throws, FTS5 is never
// usable either, and every search returns zero results. Keep them separate + nullable.
interface Stmts {
  ftsDelete: import('better-sqlite3').Statement;
  ftsInsert: import('better-sqlite3').Statement;
  vecDelete: import('better-sqlite3').Statement | null;
  vecInsert: import('better-sqlite3').Statement | null;
  stateGet: import('better-sqlite3').Statement;
  stateUpsert: import('better-sqlite3').Statement;
  stateDelete: import('better-sqlite3').Statement;
  ftsSearch: import('better-sqlite3').Statement;
  vecSearch: import('better-sqlite3').Statement | null;
}
let _stmts: Stmts | null = null;
let _stmtDb: Database | null = null;
function stmts(): Stmts {
  const db = getRawSqlite();
  if (_stmts && _stmtDb === db) return _stmts;
  _stmtDb = db;
  const vecOk = isVecAvailable();
  _stmts = {
    ftsDelete: db.prepare('DELETE FROM fts_cards WHERE card_id = ?'),
    ftsInsert: db.prepare('INSERT INTO fts_cards(card_id, title, summary, details, tags) VALUES (?, ?, ?, ?, ?)'),
    vecDelete: vecOk ? db.prepare('DELETE FROM vec_cards WHERE card_id = ?') : null,
    vecInsert: vecOk ? db.prepare('INSERT INTO vec_cards(card_id, embedding) VALUES (?, ?)') : null,
    stateGet: db.prepare('SELECT content_hash FROM card_embed_state WHERE card_id = ?'),
    stateUpsert: db.prepare(
      'INSERT INTO card_embed_state(card_id, content_hash, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(card_id) DO UPDATE SET content_hash = excluded.content_hash, updated_at = excluded.updated_at',
    ),
    stateDelete: db.prepare('DELETE FROM card_embed_state WHERE card_id = ?'),
    // bm25 column weights mirror the prior Orama boosts: title 3, summary 2, details 1, tags 2.
    ftsSearch: db.prepare(
      'SELECT card_id, bm25(fts_cards, 3.0, 2.0, 1.0, 2.0) AS score FROM fts_cards ' +
      'WHERE fts_cards MATCH ? ORDER BY score LIMIT ?',
    ),
    vecSearch: vecOk ? db.prepare('SELECT card_id, distance FROM vec_cards WHERE embedding MATCH ? AND k = ?') : null,
  };
  return _stmts;
}

function ftsFields(c: CardRow): [string, string, string, string] {
  return [
    injectBigrams(c.title),
    injectBigrams(c.summary),
    injectBigrams(c.details),
    injectBigrams((c.tags ?? []).join(' ')),
  ];
}

// ── Ingestion ──────────────────────────────────────────────────────────────────

// Why: (re)index only cards whose embedded text changed (hash compare). FTS5 is
// rebuilt every time (cheap, lexical); the vector is recomputed only when the embed
// worker is ready (else FTS-only until backfill catches it). Embeds are batched.
export async function indexCards(rows: CardRow[]): Promise<void> {
  if (rows.length === 0) return;
  const s = stmts();
  // Filter to cards whose content hash differs from what's indexed.
  const changed = rows.filter((c) => {
    const hash = cardContentHash(c);
    const prev = s.stateGet.get(c.id) as { content_hash: string } | undefined;
    return prev?.content_hash !== hash;
  });
  if (changed.length === 0) return;

  // FTS first (always available) — synchronous, fast.
  const now = Date.now();
  const writeFts = getRawSqlite().transaction((items: CardRow[]) => {
    for (const c of items) {
      s.ftsDelete.run(c.id);
      s.ftsInsert.run(c.id, ...ftsFields(c));
    }
  });
  writeFts(changed);

  // Vectors (best-effort): embed all changed passages in one worker round-trip.
  let vectors: number[][] | null = null;
  if (isVecAvailable()) {
    try { await embeddingService.whenReady(); } catch { /* model unavailable → FTS-only */ }
    if (embeddingService.isReady) {
      vectors = await embeddingService.embedPassages(changed.map((c) => buildPassageText(c)));
    }
  }
  const writeVecAndState = getRawSqlite().transaction((items: CardRow[]) => {
    for (let i = 0; i < items.length; i++) {
      const c = items[i]!;
      if (vectors && vectors[i]) {
        s.vecDelete?.run(c.id);
        s.vecInsert?.run(c.id, JSON.stringify(vectors[i]));
      }
      // Only mark state embedded when the vector landed (or vec is unavailable, so FTS
      // alone is the steady state); if embedding failed transiently, leave it for backfill.
      if ((vectors && vectors[i]) || !isVecAvailable()) {
        s.stateUpsert.run(c.id, cardContentHash(c), now);
      }
    }
  });
  writeVecAndState(changed);
}

export function unindexCards(cardIds: string[]): void {
  if (cardIds.length === 0) return;
  const s = stmts();
  const tx = getRawSqlite().transaction((ids: string[]) => {
    for (const id of ids) {
      s.ftsDelete.run(id);
      s.vecDelete?.run(id);
      s.stateDelete.run(id);
    }
  });
  tx(cardIds);
}

// Why: at startup, embed any cards not yet vector-indexed (new install with existing
// cards, or cards inserted while the model was still loading). Lexical FTS is filled
// eagerly elsewhere; this fills the vectors once the worker is warm.
export async function backfillIndex(): Promise<void> {
  const all = await getDb().select().from(cards);
  if (all.length === 0) return;
  // indexCards is hash-gated, so already-indexed cards are skipped cheaply.
  await indexCards(all);
}

// ── Retrieval ────────────────────────────────────────────────────────────────────

export interface MeetingSearchResult {
  // The top-k RRF-fused closest cards (ALWAYS returned, even when low-confidence) so
  // the renderer can ground an LLM fallback answer on them; lowConfidence tells the UI
  // whether to TRUST them as a shown match or treat them as a no-match.
  cards: CardRow[];
  lowConfidence: boolean;
}

async function candidateCards(projectId: string): Promise<CardRow[]> {
  const db = getDb();
  const [profile] = await db.select({ id: projects.id }).from(projects).where(eq(projects.isProfile, true));
  const ids = profile && profile.id !== projectId ? [projectId, profile.id] : [projectId];
  return db.select().from(cards).where(inArray(cards.projectId, ids)).orderBy(desc(cards.createdAt));
}

// Why: the live meeting hybrid search. Embed the query, KNN the vectors + bm25 the
// FTS, restrict to this project's (+ personal-corpus) cards, fuse with RRF, then apply
// the false-positive gate. Returns the top-k matched card rows and whether the match
// is low-confidence (gate failed) so the UI can suppress the overlay.
export async function searchMeeting(projectId: string, query: string): Promise<MeetingSearchResult> {
  const t0 = performance.now();
  const cand = await candidateCards(projectId);
  if (cand.length === 0) return { cards: [], lowConfidence: true };
  const byId = new Map(cand.map((c) => [c.id, c]));
  const candIds = new Set(byId.keys());

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return { cards: [], lowConfidence: true };

  const s = stmts();

  // Lexical arm (always available).
  const tFts = performance.now();
  const ftsQ = buildFtsMatchQuery(query);
  let ftsList: string[] = [];
  if (ftsQ) {
    try {
      const rows = s.ftsSearch.all(ftsQ, FTS_LIMIT) as { card_id: string; score: number }[];
      ftsList = rows.map((r) => r.card_id).filter((id) => candIds.has(id));
    } catch { /* malformed MATCH — skip lexical arm */ }
  }
  const ftsMs = performance.now() - tFts;

  // Semantic arm (best-effort). cosineById maps card_id → cosine similarity (1 - distance).
  const vecList: string[] = [];
  const cosineById = new Map<string, number>();
  let embedMs = 0;
  let vecMs = 0;
  if (isVecAvailable() && embeddingService.isReady) {
    const tEmbed = performance.now();
    const qvec = await embeddingService.embedQuery(query);
    embedMs = performance.now() - tEmbed;
    if (qvec && s.vecSearch) {
      const tVec = performance.now();
      const rows = s.vecSearch.all(JSON.stringify(qvec), VEC_K) as { card_id: string; distance: number }[];
      vecMs = performance.now() - tVec;
      for (const r of rows) {
        if (!candIds.has(r.card_id)) continue;
        vecList.push(r.card_id);
        cosineById.set(r.card_id, 1 - r.distance);
      }
    }
  }
  // Telemetry: lets the user evaluate the 1-2s budget + whether to upgrade the model.
  console.warn(`[retrieval] embed=${embedMs.toFixed(0)}ms vec=${vecMs.toFixed(0)}ms fts=${ftsMs.toFixed(0)}ms total=${(performance.now() - t0).toFixed(0)}ms (cand=${cand.length})`);

  const fused = rrfFuse(vecList, ftsList);
  if (fused.length === 0) return { cards: [], lowConfidence: true };

  // Gate on the top fused card: lexical overlap OR a high semantic cosine.
  const top = fused[0]!;
  const topCard = byId.get(top.cardId)!;
  const topText = [topCard.title, topCard.summary, topCard.details, (topCard.tags ?? []).join(' ')].join(' ');
  const ok = passesGate({
    topMatchedTokens: countMatchedTokens(topText, queryTokens),
    queryTokenCount: queryTokens.length,
    topCosine: cosineById.has(top.cardId) ? cosineById.get(top.cardId)! : null,
  });

  // Always return the top-k closest (so a low-confidence result can still ground an
  // LLM fallback answer); lowConfidence flags whether to trust them as a shown match.
  const resultCards = fused.slice(0, MEETING_TOP_K).map((h) => byId.get(h.cardId)!).filter(Boolean);
  return { cards: resultCards, lowConfidence: !ok };
}

// Why: lexical-only ranked search for the card-library tab (user-typed search box,
// not real-time). Restricted to the given project's cards. Returns card ids best-first.
export function searchLexical(candidateIds: string[], query: string, limit: number): string[] {
  const ftsQ = buildFtsMatchQuery(query);
  if (!ftsQ || candidateIds.length === 0) return [];
  const candSet = new Set(candidateIds);
  try {
    const rows = stmts().ftsSearch.all(ftsQ, Math.max(limit, FTS_LIMIT)) as { card_id: string }[];
    return rows.map((r) => r.card_id).filter((id) => candSet.has(id)).slice(0, limit);
  } catch {
    return [];
  }
}
