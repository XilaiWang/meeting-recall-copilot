import { ipcMain, dialog, clipboard } from 'electron';
import { eq, desc } from 'drizzle-orm';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '../db/client.js';
import { cards, projects, type CardRow } from '../db/schema.js';
import { buildPdfHtml, printHtmlToPdf, type PdfTemplate } from '../lib/pdf.js';
import { buildObsidianNote, buildObsidianIndexNote, obsidianFilename, cardToExportable, type IndexEntry } from '../lib/obsidian-export.js';

export type CardRange = 'auto' | 'all' | 'important';

const TYPE_LABEL: Record<string, string> = {
  result_impact: '结果影响',
  data_metric: '数据指标',
  difficulty_solution: '难点解法',
  decision_tradeoff: '决策权衡',
  tech_principle: '技术原理',
  process_method: '流程方法',
  domain_fact: '领域知识',
};

// Why: result/metric cards answer "what did you achieve" — highest meeting value.
// Process/domain cards are supporting detail — lower priority for a tight cheat sheet.
const TYPE_PRIORITY: Record<string, number> = {
  result_impact: 0,
  data_metric: 1,
  difficulty_solution: 2,
  decision_tradeoff: 3,
  tech_principle: 4,
  process_method: 5,
  domain_fact: 6,
};

function selectCards(all: CardRow[]): CardRow[] {
  const important = all.filter((c) => c.isImportant);
  const pool = important.length >= 3 ? important : all;
  return pool
    .slice()
    .sort((a, b) => (TYPE_PRIORITY[a.type] ?? 9) - (TYPE_PRIORITY[b.type] ?? 9))
    .slice(0, 25);
}

function selectCardsForRange(all: CardRow[], range: CardRange): CardRow[] {
  if (range === 'important') {
    const imp = all.filter((c) => c.isImportant);
    return imp.sort((a, b) => (TYPE_PRIORITY[a.type] ?? 9) - (TYPE_PRIORITY[b.type] ?? 9));
  }
  if (range === 'all') {
    return all.slice().sort((a, b) => (TYPE_PRIORITY[a.type] ?? 9) - (TYPE_PRIORITY[b.type] ?? 9));
  }
  return selectCards(all); // auto
}

function buildMarkdown(project: { name: string; targetRole: string; jdText?: string | null }, selected: CardRow[]): string {
  // Why: targetRole may contain a long legacy description; take only the first line as the short name.
  const roleLabel = (project.targetRole || '').split('\n')[0]!.trim().slice(0, 80);
  const lines: string[] = [];
  const date = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });

  lines.push(`# ${project.name} · 会议备忘录`);
  lines.push(`**会议主题：** ${roleLabel}    **生成日期：** ${date}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Group by type
  const grouped = new Map<string, CardRow[]>();
  for (const card of selected) {
    const group = grouped.get(card.type) ?? [];
    group.push(card);
    grouped.set(card.type, group);
  }

  const typeOrder = Object.keys(TYPE_PRIORITY).sort((a, b) => (TYPE_PRIORITY[a] ?? 9) - (TYPE_PRIORITY[b] ?? 9));
  for (const type of typeOrder) {
    const group = grouped.get(type);
    if (!group?.length) continue;

    lines.push(`## ${TYPE_LABEL[type] ?? type}`);
    lines.push('');
    for (const card of group) {
      lines.push(`### ${card.isImportant ? '★ ' : ''}${card.title}`);
      lines.push(`> ${card.summary}`);
      lines.push('');
      lines.push(card.details);
      if (Array.isArray(card.tags) && card.tags.length > 0) {
        lines.push('');
        lines.push(`*关键词：${card.tags.join(' · ')}*`);
      }
      lines.push('');
    }
  }

  lines.push('---');
  lines.push(`*共 ${selected.length} 张卡片 · 由 QA Matching 生成*`);
  return lines.join('\n');
}

export function registerExportIpcHandlers() {
  ipcMain.handle('export:copy-clipboard', async (_event, projectId: string, range: CardRange = 'auto'): Promise<number> => {
    const db = getDb();
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) throw new Error('项目不存在');
    const allCards = await db.select().from(cards).where(eq(cards.projectId, projectId)).orderBy(desc(cards.createdAt));
    const selected = selectCardsForRange(allCards, range);
    clipboard.writeText(buildMarkdown(project, selected));
    return selected.length;
  });

  ipcMain.handle('export:save-file', async (_event, projectId: string, range: CardRange = 'auto'): Promise<string | null> => {
    const db = getDb();
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) throw new Error('项目不存在');

    const { filePath, canceled } = await dialog.showSaveDialog({
      title: '保存 Cheat Sheet',
      defaultPath: `${project.name}-会议备忘录.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'Text', extensions: ['txt'] }],
    });
    if (canceled || !filePath) return null;

    const allCards = await db.select().from(cards).where(eq(cards.projectId, projectId)).orderBy(desc(cards.createdAt));
    const selected = selectCardsForRange(allCards, range);
    writeFileSync(filePath, buildMarkdown(project, selected), 'utf8');
    return filePath;
  });

  ipcMain.handle('export:generate-pdf', async (
    _event,
    projectId: string,
    template: PdfTemplate,
    range: CardRange,
  ): Promise<string | null> => {
    const db = getDb();
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) throw new Error('项目不存在');

    const allCards = await db.select().from(cards).where(eq(cards.projectId, projectId)).orderBy(desc(cards.createdAt));
    if (allCards.length === 0) throw new Error('没有卡片可导出');

    const selected = selectCardsForRange(allCards, range);
    if (selected.length === 0) throw new Error('没有符合条件的卡片（没有标记重要的卡片？）');

    const roleLabel = (project.targetRole || '').split('\n')[0]!.trim().slice(0, 80);
    const { filePath, canceled } = await dialog.showSaveDialog({
      title: '保存 PDF',
      defaultPath: `${project.name}-会议速记.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return null;

    const html = buildPdfHtml(template, project.name, roleLabel, selected);
    await printHtmlToPdf(html, filePath);
    return filePath;
  });

  // Why: reverse-export cards into the user's Obsidian vault as one note per card
  // plus an index. We only ever WRITE into a namespaced "QA Matching/<project>/"
  // subfolder (created if missing) — never touch or delete the user's other notes.
  ipcMain.handle('export:obsidian', async (_event, projectId: string, range: CardRange = 'auto'): Promise<{ folder: string; count: number } | null> => {
    const db = getDb();
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) throw new Error('项目不存在');

    const allCards = await db.select().from(cards).where(eq(cards.projectId, projectId)).orderBy(desc(cards.createdAt));
    if (allCards.length === 0) throw new Error('没有卡片可导出');
    const selected = selectCardsForRange(allCards, range);
    if (selected.length === 0) throw new Error('没有符合条件的卡片（没有标记重要的卡片？）');

    const { filePaths, canceled } = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: '选择 Obsidian Vault 或目标文件夹',
      buttonLabel: '导出到此处',
    });
    if (canceled || !filePaths[0]) return null;

    const projectFolderName = obsidianFilename(project.name, new Set());
    const dir = join(filePaths[0], 'QA Matching', projectFolderName);
    mkdirSync(dir, { recursive: true });

    const used = new Set<string>();
    const entries: IndexEntry[] = [];
    for (const card of selected) {
      const filename = obsidianFilename(card.title, used);
      writeFileSync(join(dir, `${filename}.md`), buildObsidianNote(cardToExportable(card), project), 'utf8');
      entries.push({ type: card.type, filename, title: card.title, important: card.isImportant });
    }
    const indexName = obsidianFilename(`${projectFolderName} · 索引`, used);
    writeFileSync(join(dir, `${indexName}.md`), buildObsidianIndexNote(project, entries), 'utf8');

    return { folder: dir, count: selected.length };
  });

  ipcMain.handle('export:card-counts', async (_event, projectId: string): Promise<{ auto: number; all: number; important: number }> => {
    const db = getDb();
    const allCards = await db.select().from(cards).where(eq(cards.projectId, projectId)).orderBy(desc(cards.createdAt));
    return {
      auto: selectCards(allCards).length,
      all: allCards.length,
      important: allCards.filter((c) => c.isImportant).length,
    };
  });

}
