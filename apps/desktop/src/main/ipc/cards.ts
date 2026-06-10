import { ipcMain } from 'electron';
import { eq, desc, or, isNull, lte, and, inArray } from 'drizzle-orm';
import { createEmptyCard, fsrs, type Card as FsrsCard, type Grade } from 'ts-fsrs';
import { getDb } from '../db/client.js';
import { cards, materials, projects, type CardRow } from '../db/schema.js';
import { extractCardsStream, summarizeCompany, type ExtractionContext } from '../lib/extract.js';
import { getLlmConfig } from './settings.js';
import { indexCards, unindexCards } from '../lib/search-index.js';

const scheduler = fsrs();

// Why: guard against a second extraction for the SAME project running concurrently
// (e.g. user switches back to the materials tab mid-stream and clicks extract again).
// Without this, both runs snapshot the same oldCardIds and each streams + inserts a
// full set, leaving duplicate cards and racing the old-card delete. Keyed by
// projectId so different projects can still extract in parallel.
const extractingProjects = new Set<string>();

function rowToFsrsCard(row: CardRow): FsrsCard {
  if (row.fsrsState === null || row.fsrsState === undefined) return createEmptyCard();
  return {
    due:           row.fsrsDue           ?? new Date(),
    stability:     row.fsrsStability     ?? 0,
    difficulty:    row.fsrsDifficulty    ?? 0,
    elapsed_days:  row.fsrsElapsedDays   ?? 0,
    scheduled_days: row.fsrsScheduledDays ?? 0,
    reps:          row.fsrsReps          ?? 0,
    lapses:        row.fsrsLapses        ?? 0,
    learning_steps: row.fsrsLearningSteps ?? 0,
    state:         row.fsrsState,
  };
}

export function registerCardIpcHandlers() {
  ipcMain.handle('card:list', async (_event, projectId: string): Promise<CardRow[]> => {
    return getDb().select().from(cards)
      .where(eq(cards.projectId, projectId))
      .orderBy(desc(cards.createdAt));
  });

  // Meeting matching scope: the application's own cards UNION the personal-corpus
  // cards (your reusable experience). The speaker's questions match against
  // both. The personal-corpus project is resolved lazily; absent → application only.
  ipcMain.handle('card:list-for-meeting', async (_event, projectId: string): Promise<CardRow[]> => {
    const db = getDb();
    const [profile] = await db.select({ id: projects.id }).from(projects).where(eq(projects.isProfile, true));
    const ids = profile && profile.id !== projectId ? [projectId, profile.id] : [projectId];
    return db.select().from(cards).where(inArray(cards.projectId, ids)).orderBy(desc(cards.createdAt));
  });

  ipcMain.handle('card:delete', async (_event, id: string): Promise<void> => {
    await getDb().delete(cards).where(eq(cards.id, id));
    try { unindexCards([id]); } catch { /* best-effort search cleanup */ }
  });

  ipcMain.handle('card:update-verified', async (_event, id: string, verified: boolean): Promise<void> => {
    await getDb().update(cards).set({ userVerified: verified, updatedAt: new Date() }).where(eq(cards.id, id));
  });

  ipcMain.handle('card:update-important', async (_event, id: string, important: boolean): Promise<void> => {
    await getDb().update(cards).set({ isImportant: important, updatedAt: new Date() }).where(eq(cards.id, id));
  });

  ipcMain.handle('card:update-content', async (
    _event,
    id: string,
    patch: { title?: string; summary?: string; details?: string; tags?: string[] },
  ): Promise<CardRow> => {
    const now = new Date();
    const set: Partial<typeof cards.$inferInsert> = { updatedAt: now };
    if (patch.title !== undefined) set.title = patch.title.trim().slice(0, 100);
    if (patch.summary !== undefined) set.summary = patch.summary.trim().slice(0, 300);
    if (patch.details !== undefined) set.details = patch.details.trim().slice(0, 2000);
    if (patch.tags !== undefined) set.tags = patch.tags;
    const [row] = await getDb().update(cards).set(set).where(eq(cards.id, id)).returning();
    if (!row) throw new Error('卡片不存在');
    // Re-index the edited card (hash-gated, so a no-op if the searchable text is same).
    void indexCards([row]).catch((e) => console.error('[retrieval] index after edit failed:', e));
    return row;
  });

  ipcMain.handle('project:extract-cards', async (event, projectId: string): Promise<CardRow[]> => {
    if (extractingProjects.has(projectId)) throw new Error('该项目正在提取卡片，请等待本次提取完成');
    extractingProjects.add(projectId);
    try {
    const cfg = await getLlmConfig();
    if (!cfg) throw new Error('请先在设置中配置 LLM API Key');

    const db = getDb();
    const mats = await db.select().from(materials).where(eq(materials.projectId, projectId));
    if (mats.length === 0) throw new Error('项目没有素材，请先上传素材');

    const projectMats = mats.filter((m) => m.category === 'project');
    const companyMats = mats.filter((m) => m.category === 'company');

    if (projectMats.length === 0) throw new Error('项目没有项目素材，请先上传 GitHub/文件/文本等项目相关素材');

    const [proj] = await db.select().from(projects).where(eq(projects.id, projectId));
    const ctx: ExtractionContext = { targetRole: proj?.targetRole, jdText: proj?.jdText };

    await db.update(projects).set({ status: 'extracting', updatedAt: new Date() }).where(eq(projects.id, projectId));

    // Why: capture old card ids but DON'T delete them up-front. Deleting before
    // streaming means a mid-stream LLM/network failure wipes the user's previously
    // extracted cards with nothing to replace them. We instead drop these only
    // after the first new card is safely persisted (see onCard below), so a failed
    // re-extraction leaves the existing cards intact.
    const oldCardIds = (await db
      .select({ id: cards.id })
      .from(cards)
      .where(eq(cards.projectId, projectId))).map((r) => r.id);
    let oldCleared = false;

    const inserted: CardRow[] = [];
    const now = new Date();
    const send = (ch: string, data: unknown) => { if (!event.sender.isDestroyed()) event.sender.send(ch, data); };

    // Why: run company brief generation in parallel with card streaming so the user
    // doesn't wait extra time — they're independent LLM calls on different content.
    const companyBriefPromise = companyMats.length > 0
      ? summarizeCompany(companyMats, cfg)
          .then(async ({ companyName, brief }) => {
            await db.update(projects).set({
              companyName, companyBrief: brief,
              companyBriefGeneratedAt: new Date(), updatedAt: new Date(),
            }).where(eq(projects.id, projectId));
            send('project:company-brief-updated', { companyName, brief });
          })
          .catch(() => { /* non-fatal — project cards still proceed */ })
      : Promise.resolve();

    try {
      // Why: streaming extraction lets the renderer show each card as soon as it's
      // parsed instead of waiting for all cards to finish (30-60s for large corpora).
      await extractCardsStream(projectMats, cfg, ctx, async (c) => {
        const [row] = await db.insert(cards).values({
          projectId, type: c.type, title: c.title, summary: c.summary,
          details: c.details, tags: c.tags, language: c.language,
          confidence: c.confidence, createdAt: now, updatedAt: now,
        }).returning();
        if (row) {
          // First successfully-persisted new card → now it is safe to drop the
          // previous cards. Until this point oldCleared stays false, so a failed
          // extraction (LLM/network error, zero cards) keeps the old cards.
          if (!oldCleared) {
            if (oldCardIds.length > 0) await db.delete(cards).where(inArray(cards.id, oldCardIds));
            oldCleared = true;
          }
          inserted.push(row);
          send('card:extracted', row); // push to renderer immediately
        }
      });
    } catch (err) {
      await db.update(projects).set({ status: 'materializing', updatedAt: new Date() }).where(eq(projects.id, projectId));
      throw err;
    }

    await companyBriefPromise;

    if (inserted.length === 0) throw new Error('AI 没有提取到任何卡片，请检查素材内容');
    await db.update(projects).set({ status: 'needs_review', updatedAt: new Date() }).where(eq(projects.id, projectId));
    // Sync the search index: drop the replaced cards, embed + index the new ones.
    // Fire-and-forget — failures are caught by the startup backfill, and search must
    // never block or break extraction.
    if (oldCardIds.length > 0) { try { unindexCards(oldCardIds); } catch { /* best-effort */ } }
    void indexCards(inserted).catch((e) => console.error('[retrieval] index after extract failed:', e));
    return inserted;
    } finally {
      extractingProjects.delete(projectId);
    }
  });

  // ── Batch operations ──

  ipcMain.handle('card:delete-batch', async (_event, ids: string[]): Promise<void> => {
    if (ids.length === 0) return;
    await getDb().delete(cards).where(inArray(cards.id, ids));
    try { unindexCards(ids); } catch { /* best-effort search cleanup */ }
  });

  ipcMain.handle('card:update-important-batch', async (_event, ids: string[], v: boolean): Promise<void> => {
    if (ids.length === 0) return;
    await getDb().update(cards).set({ isImportant: v, updatedAt: new Date() }).where(inArray(cards.id, ids));
  });

  ipcMain.handle('card:update-verified-batch', async (_event, ids: string[], v: boolean): Promise<void> => {
    if (ids.length === 0) return;
    await getDb().update(cards).set({ userVerified: v, updatedAt: new Date() }).where(inArray(cards.id, ids));
  });

  // ── FSRS spaced repetition ──

  ipcMain.handle('card:review', async (_event, id: string, rating: number): Promise<CardRow> => {
    // Why: validate the renderer-supplied rating (defence in depth per CLAUDE.md
    // "don't trust renderer input"). ts-fsrs Grade is 1..4 and its checkGrade throws
    // FSRSValidationError on anything else — catch it here with a friendly message
    // instead of leaking a raw library error if a future UI ever passes 0/5/NaN.
    if (!Number.isInteger(rating) || rating < 1 || rating > 4) throw new Error('无效的复习评分');

    const db = getDb();
    const [existing] = await db.select().from(cards).where(eq(cards.id, id));
    if (!existing) throw new Error('卡片不存在');

    const fsrsCard = rowToFsrsCard(existing);
    const now = new Date();
    const rated = scheduler.next(fsrsCard, now, rating as Grade);
    const next = rated.card;

    const [updated] = await db.update(cards).set({
      fsrsDue:           next.due,
      fsrsStability:     next.stability,
      fsrsDifficulty:    next.difficulty,
      fsrsElapsedDays:   next.elapsed_days,
      fsrsScheduledDays: next.scheduled_days,
      fsrsReps:          next.reps,
      fsrsLapses:        next.lapses,
      fsrsLearningSteps: next.learning_steps,
      fsrsState:         next.state,
      updatedAt: now,
    }).where(eq(cards.id, id)).returning();
    if (!updated) throw new Error('更新失败');
    return updated;
  });

  // Why: include new cards (fsrsState IS NULL) and cards whose due date has passed.
  // NULL sorts first in SQLite, so new cards appear before scheduled reviews.
  ipcMain.handle('card:due-review', async (_event, projectId: string): Promise<CardRow[]> => {
    const now = new Date();
    return getDb().select().from(cards)
      .where(and(
        eq(cards.projectId, projectId),
        or(isNull(cards.fsrsState), lte(cards.fsrsDue, now)),
      ))
      .orderBy(cards.fsrsDue);
  });
}
