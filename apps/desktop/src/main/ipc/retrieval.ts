import { ipcMain } from 'electron';
import { eq, desc } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { cards, type CardRow } from '../db/schema.js';
import { searchMeeting, searchLexical, type MeetingSearchResult } from '../lib/search-index.js';

// Why: hybrid retrieval lives in the main process (next to the DB + embedding worker),
// so the renderer asks for results over IPC instead of building an in-memory index.

export function registerRetrievalIpcHandlers(): void {
  // Live meeting search: semantic + lexical, RRF-fused, gated. Returns the matched
  // cards (top-k) and whether the match is low-confidence so the overlay can suppress.
  ipcMain.handle(
    'retrieval:meeting-search',
    async (_event, projectId: string, query: string): Promise<MeetingSearchResult> => {
      if (!query || !query.trim()) return { cards: [], lowConfidence: true };
      return searchMeeting(projectId, query);
    },
  );

  // Card-library lexical search (user-typed box). Restricted to the project's cards,
  // ranked by FTS5 bm25. Empty query → all project cards (newest first, like before).
  ipcMain.handle(
    'retrieval:card-search',
    async (_event, projectId: string, query: string): Promise<CardRow[]> => {
      const db = getDb();
      const all = await db.select().from(cards).where(eq(cards.projectId, projectId)).orderBy(desc(cards.createdAt));
      if (!query || !query.trim()) return all;
      const ranked = searchLexical(all.map((c) => c.id), query, all.length);
      const byId = new Map(all.map((c) => [c.id, c]));
      return ranked.map((id) => byId.get(id)!).filter(Boolean);
    },
  );
}
