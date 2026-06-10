import { ipcMain } from 'electron';
import { desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/client.js';
import { projects, materials, cards, type ProjectRow, type CardRow } from '../db/schema.js';
import { indexCards, unindexCards } from '../lib/search-index.js';
import { summarizeCompany } from '../lib/extract.js';
import { getLlmConfig } from './settings.js';

export interface CreateProjectInput {
  name: string;
  targetRole: string;
  jdText?: string;
}

export function registerProjectIpcHandlers() {
  // Applications only — the personal-corpus project is excluded (see get-or-create-profile).
  ipcMain.handle('project:list', async (): Promise<ProjectRow[]> => {
    const db = getDb();
    return db.select().from(projects).where(eq(projects.isProfile, false)).orderBy(desc(projects.updatedAt));
  });

  // The singleton personal-corpus project (resume/theses/past projects). Created
  // lazily on first access; reuses the normal material/card/extraction pipeline.
  ipcMain.handle('project:get-or-create-profile', async (): Promise<ProjectRow> => {
    const db = getDb();
    const [existing] = await db.select().from(projects).where(eq(projects.isProfile, true));
    if (existing) return existing;
    const now = new Date();
    const [created] = await db.insert(projects).values({
      isProfile: true,
      name: '我的资料库',
      targetRole: '个人资料 · 文档 · 项目沉淀', // display-only; excluded from project list
      status: 'ready',
      createdAt: now,
      updatedAt: now,
    }).returning();
    if (!created) throw new Error('Insert returned no row');
    return created;
  });

  ipcMain.handle('project:create', async (_event, input: CreateProjectInput): Promise<ProjectRow> => {
    const db = getDb();
    const now = new Date();
    const [created] = await db
      .insert(projects)
      .values({
        name: input.name.trim(),
        targetRole: input.targetRole.trim(),
        jdText: input.jdText?.trim() || null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!created) throw new Error('Insert returned no row');
    return created;
  });

  ipcMain.handle('project:delete', async (_event, id: string): Promise<void> => {
    const db = getDb();
    // Why: parentProjectId 外键未配置级联，若有副本以本项目为来源，直接删会触发
    // FK 约束失败。先把这些子副本的 parent 置空（仅元数据链接，置空无副作用），
    // 再删除项目。素材/卡片已配 onDelete: cascade，会随项目自动清除。
    await db.update(projects).set({ parentProjectId: null }).where(eq(projects.parentProjectId, id));
    // FTS5 / vec0 are virtual tables without FK cascade; clean them explicitly before the
    // project delete cascades to cards, or orphan rows accumulate permanently.
    const cardIds = await db.select({ id: cards.id }).from(cards).where(eq(cards.projectId, id));
    try { unindexCards(cardIds.map((c) => c.id)); } catch { /* best-effort search cleanup */ }
    await db.delete(projects).where(eq(projects.id, id));
  });

  ipcMain.handle('project:get', async (_event, id: string): Promise<ProjectRow | null> => {
    const db = getDb();
    const [row] = await db.select().from(projects).where(eq(projects.id, id));
    return row ?? null;
  });

  ipcMain.handle('project:regenerate-company-brief', async (event, projectId: string): Promise<{ companyName: string; brief: string }> => {
    const cfg = await getLlmConfig();
    if (!cfg) throw new Error('请先在设置中配置 LLM API Key');
    const db = getDb();
    const companyMats = await db.select().from(materials)
      .where(eq(materials.projectId, projectId))
      .then((rows) => rows.filter((m) => m.category === 'company'));
    if (companyMats.length === 0) throw new Error('没有会议方背景素材，请先上传相关 URL');
    const { companyName, brief } = await summarizeCompany(companyMats, cfg);
    await db.update(projects).set({
      companyName, companyBrief: brief,
      companyBriefGeneratedAt: new Date(), updatedAt: new Date(),
    }).where(eq(projects.id, projectId));
    if (!event.sender.isDestroyed()) {
      event.sender.send('project:company-brief-updated', { companyName, brief });
    }
    return { companyName, brief };
  });

  // Why: clone copies all materials + cards so the user gets a full starting
  // point for a second meeting without re-uploading and re-extracting.
  // FSRS progress is intentionally reset — cloned cards start fresh.
  ipcMain.handle('project:clone', async (_event, sourceId: string): Promise<ProjectRow> => {
    const db = getDb();
    const now = new Date();

    const [source] = await db.select().from(projects).where(eq(projects.id, sourceId));
    if (!source) throw new Error('Source project not found');

    const [cloned] = await db
      .insert(projects)
      .values({
        parentProjectId: sourceId,
        name: `${source.name}（副本）`,
        targetRole: source.targetRole,
        jdText: source.jdText,
        status: 'draft',
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!cloned) throw new Error('Clone insert returned no row');

    // Copy materials, keeping a map from old id → new id for card FK rewrite.
    const sourceMats = await db.select().from(materials).where(eq(materials.projectId, sourceId));
    const matIdMap = new Map<string, string>();
    for (const m of sourceMats) {
      const newId = randomUUID();
      matIdMap.set(m.id, newId);
      await db.insert(materials).values({
        id: newId,
        projectId: cloned.id,
        type: m.type,
        category: m.category,
        sourceRef: m.sourceRef,
        rawContent: m.rawContent,
        fileSize: m.fileSize,
        uploadedAt: now,
      });
    }

    // Copy cards, rewriting sourceMaterialId to the new material id.
    const sourceCards = await db.select().from(cards).where(eq(cards.projectId, sourceId));
    const insertedCards: CardRow[] = [];
    for (const c of sourceCards) {
      const [inserted] = await db.insert(cards).values({
        projectId: cloned.id,
        sourceMaterialId: c.sourceMaterialId ? (matIdMap.get(c.sourceMaterialId) ?? null) : null,
        type: c.type,
        title: c.title,
        summary: c.summary,
        details: c.details,
        tags: c.tags,
        language: c.language,
        confidence: c.confidence,
        userVerified: false,
        isImportant: c.isImportant,
        createdAt: now,
        updatedAt: now,
        // FSRS state deliberately omitted — cloned cards restart as New.
      }).returning();
      if (inserted) insertedCards.push(inserted);
    }
    // Why: cards inserted via clone must be searchable immediately in the same session;
    // without this, the cloned project returns zero matches until the next app restart
    // when backfillIndex() eventually catches them.
    if (insertedCards.length > 0) {
      void indexCards(insertedCards).catch((e: unknown) =>
        console.warn('[projects] clone: indexCards failed (best-effort)', e),
      );
    }

    return cloned;
  });
}
