import { ipcMain, dialog } from 'electron';
import { eq, desc, and } from 'drizzle-orm';
import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { getDb } from '../db/client.js';
import { materials, projects, type MaterialRow, type MaterialType } from '../db/schema.js';
import { parseGithubUrl } from '../lib/parsers/github.js';
import { parseZip } from '../lib/parsers/zip.js';
import { parseFilePath } from '../lib/parsers/file.js';
import { parseWebUrl, parseCompanyUrl } from '../lib/parsers/url.js';
import { parseObsidianVault, scanVaultNotes, summarizeScope, classifyNoteStatus, type NoteStatus } from '../lib/parsers/obsidian.js';

async function insertMaterial(projectId: string, type: MaterialType, rawContent: string, sourceRef?: string, fileSize?: number, category: 'project' | 'company' = 'project', sourceMtime?: Date): Promise<MaterialRow> {
  const db = getDb();
  const [row] = await db.insert(materials).values({
    projectId, type, category, rawContent, sourceRef: sourceRef ?? null,
    fileSize: fileSize ?? null, sourceMtime: sourceMtime ?? null, uploadedAt: new Date(),
  }).returning();
  if (!row) throw new Error('Insert returned no row');
  // bump project updatedAt
  await db.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, projectId));
  return row;
}

export interface ObsidianScanNote {
  relPath: string;
  sizeKB: number;
  folder: string;
  tags: string[];
  status: NoteStatus;
}

export interface ObsidianScanResult {
  count: number;
  newCount: number;
  changedCount: number;
  unchangedCount: number;
  notes: ObsidianScanNote[];
  folders: { name: string; count: number }[];
  tags: { name: string; count: number }[];
}

// Why: map a project's already-imported Obsidian notes to their stored source
// mtime (in seconds, SQLite precision) so a re-scan can mark each note
// new / changed / unchanged. Keyed by relPath (the material's sourceRef).
async function priorObsidianMtimes(projectId: string): Promise<Map<string, number | null>> {
  const rows = await getDb()
    .select()
    .from(materials)
    .where(and(eq(materials.projectId, projectId), eq(materials.type, 'obsidian')));
  const map = new Map<string, number | null>();
  for (const r of rows) {
    if (r.sourceRef) map.set(r.sourceRef, r.sourceMtime ? Math.floor(r.sourceMtime.getTime() / 1000) : null);
  }
  return map;
}

// Why: import one picked/dropped file into a material. A per-file try/catch means a
// moved/deleted/unreadable file (statSync ENOENT/EACCES, or a parse failure) is
// SKIPPED with a progress note instead of aborting the whole batch and losing every
// subsequent file. Abort/cancel still propagates so the "取消" button works.
async function importOneFile(projectId: string, fp: string, ac: AbortController, send: (msg: string) => void): Promise<MaterialRow | null> {
  const name = basename(fp);
  try {
    const stat = statSync(fp);
    if (name.toLowerCase().endsWith('.zip')) {
      const content = await parseZip(fp, { signal: ac.signal, onProgress: send });
      return await insertMaterial(projectId, 'zip', content, name, stat.size);
    }
    const content = await parseFilePath(fp);
    return await insertMaterial(projectId, 'file', content, name, stat.size);
  } catch (e) {
    if ((e as Error).name === 'AbortError' || (e as Error).message === '已取消') throw e;
    send(`跳过无法读取的文件：${name}`);
    return null;
  }
}

// Why: single shared controller so the renderer's "取消" button can abort
// whatever long-running upload is currently in progress without needing an ID.
let currentUpload: AbortController | null = null;

function cancelCurrentUpload() {
  currentUpload?.abort();
  currentUpload = null;
}

export function registerMaterialIpcHandlers() {
  ipcMain.handle('material:list', async (_event, projectId: string): Promise<MaterialRow[]> => {
    return getDb().select().from(materials).where(eq(materials.projectId, projectId)).orderBy(desc(materials.uploadedAt));
  });

  ipcMain.handle('material:add-text', async (_event, projectId: string, text: string): Promise<MaterialRow> => {
    if (text.trim().length < 10) throw new Error('输入太短，请至少输入 10 个字符');
    const preview = text.trim().slice(0, 50).replace(/\n/g, ' ');
    return insertMaterial(projectId, 'text', text.trim(), preview);
  });

  ipcMain.handle('material:add-github-url', async (event, projectId: string, url: string): Promise<MaterialRow> => {
    cancelCurrentUpload();
    const ac = new AbortController();
    currentUpload = ac;
    const send = (msg: string) => { if (!event.sender.isDestroyed()) event.sender.send('material:progress', msg); };
    try {
      const content = await parseGithubUrl(url, { signal: ac.signal, onProgress: send });
      return insertMaterial(projectId, 'github_url', content, url);
    } catch (e) {
      if ((e as Error).name === 'AbortError' || (e as Error).message === '已取消') throw new Error('已取消');
      throw e;
    } finally {
      if (currentUpload === ac) currentUpload = null;
    }
  });

  ipcMain.handle('material:add-company-url', async (event, projectId: string, url: string): Promise<MaterialRow> => {
    cancelCurrentUpload();
    const ac = new AbortController();
    currentUpload = ac;
    const send = (msg: string) => { if (!event.sender.isDestroyed()) event.sender.send('material:progress', msg); };
    try {
      send('正在检测公司信息…');
      const { companyName, content } = await parseCompanyUrl(url, { signal: ac.signal });
      let hostname = '';
      try { hostname = new URL(url).hostname.replace(/^www\./, ''); } catch { hostname = url; }
      const sourceRef = companyName
        ? `${companyName} (${hostname})`
        : hostname;
      return insertMaterial(projectId, 'company_url', content, sourceRef, undefined, 'company');
    } catch (e) {
      if ((e as Error).name === 'AbortError' || (e as Error).message === '已取消') throw new Error('已取消');
      throw e;
    } finally {
      if (currentUpload === ac) currentUpload = null;
    }
  });

  ipcMain.handle('material:add-url', async (event, projectId: string, url: string): Promise<MaterialRow> => {
    cancelCurrentUpload();
    const ac = new AbortController();
    currentUpload = ac;
    const send = (msg: string) => { if (!event.sender.isDestroyed()) event.sender.send('material:progress', msg); };
    try {
      send('正在抓取网页内容…');
      const content = await parseWebUrl(url, { signal: ac.signal });
      return insertMaterial(projectId, 'url', content, url);
    } catch (e) {
      if ((e as Error).name === 'AbortError' || (e as Error).message === '已取消') throw new Error('已取消');
      throw e;
    } finally {
      if (currentUpload === ac) currentUpload = null;
    }
  });

  // Why: file dialog runs in main process so it has proper OS integration
  // and the renderer never needs fs access.
  ipcMain.handle('material:pick-files', async (event, projectId: string): Promise<MaterialRow[]> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Documents', extensions: ['pdf', 'docx', 'doc', 'pptx', 'ppt'] },
        { name: 'Code & Text', extensions: ['md','txt','py','js','ts','tsx','jsx','java','go','rs','cpp','c','sql','ipynb','yml','yaml','json','toml','html','htm'] },
        { name: 'ZIP', extensions: ['zip'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return [];

    cancelCurrentUpload();
    const ac = new AbortController();
    currentUpload = ac;
    const send = (msg: string) => { if (!event.sender.isDestroyed()) event.sender.send('material:progress', msg); };

    const rows: MaterialRow[] = [];
    try {
      for (let i = 0; i < result.filePaths.length; i++) {
        if (ac.signal.aborted) break;
        const fp = result.filePaths[i]!;
        send(`正在处理 ${i + 1}/${result.filePaths.length}：${basename(fp)}`);
        const row = await importOneFile(projectId, fp, ac, send);
        if (row) rows.push(row);
      }
    } finally {
      if (currentUpload === ac) currentUpload = null;
    }
    return rows;
  });

  // drag-and-drop handler: renderer sends file paths directly
  ipcMain.handle('material:add-dropped-files', async (event, projectId: string, filePaths: string[]): Promise<MaterialRow[]> => {
    cancelCurrentUpload();
    const ac = new AbortController();
    currentUpload = ac;
    const send = (msg: string) => { if (!event.sender.isDestroyed()) event.sender.send('material:progress', msg); };

    const rows: MaterialRow[] = [];
    try {
      for (let i = 0; i < filePaths.length; i++) {
        if (ac.signal.aborted) break;
        const fp = filePaths[i]!;
        send(`正在处理 ${i + 1}/${filePaths.length}：${basename(fp)}`);
        const row = await importOneFile(projectId, fp, ac, send);
        if (row) rows.push(row);
      }
    } finally {
      if (currentUpload === ac) currentUpload = null;
    }
    return rows;
  });

  // Why: an Obsidian vault is a folder of markdown notes; the OS dialog runs in
  // the main process so the renderer never touches fs.
  ipcMain.handle('material:obsidian-pick-vault', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: '选择 Obsidian Vault 文件夹',
      buttonLabel: '选择',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0]!;
  });

  // Why: fast metadata-only scan powers the "找到 N 篇" pre-import confirmation
  // plus folder/tag filters and incremental new/changed/unchanged status (when a
  // projectId is given) — without reading/cleaning every note's full content.
  ipcMain.handle('material:obsidian-scan', async (_event, vaultPath: string, projectId?: string): Promise<ObsidianScanResult> => {
    const scanned = scanVaultNotes(vaultPath);
    const prior = projectId ? await priorObsidianMtimes(projectId) : new Map<string, number | null>();
    let newCount = 0, changedCount = 0, unchangedCount = 0;
    const notes: ObsidianScanNote[] = scanned.map((n) => {
      // undefined when this project has no projectId context or never imported the note.
      const status = projectId ? classifyNoteStatus(n.mtimeMs, prior.has(n.relPath) ? prior.get(n.relPath)! : undefined) : 'new';
      if (status === 'new') newCount++; else if (status === 'changed') changedCount++; else unchangedCount++;
      return { relPath: n.relPath, sizeKB: n.sizeKB, folder: n.folder, tags: n.tags, status };
    });
    const { folders, tags } = summarizeScope(scanned);
    return { count: scanned.length, newCount, changedCount, unchangedCount, notes, folders, tags };
  });

  // Why: one material per note (not one blob) — extract.ts truncates each material
  // to 12K chars, so merging the whole vault would silently drop content. Upsert by
  // relPath: a changed note UPDATEs its existing material in place (preserving any
  // cards already extracted from it) rather than piling up duplicates.
  ipcMain.handle('material:add-obsidian', async (event, projectId: string, vaultPath: string, relPaths?: string[]): Promise<MaterialRow[]> => {
    cancelCurrentUpload();
    const ac = new AbortController();
    currentUpload = ac;
    const send = (msg: string) => { if (!event.sender.isDestroyed()) event.sender.send('material:progress', msg); };
    try {
      send('正在扫描 Obsidian vault…');
      const notes = parseObsidianVault(vaultPath, relPaths, { signal: ac.signal, onProgress: send });
      const db = getDb();
      // Existing obsidian materials for this project, keyed by relPath, for upsert.
      const priorRows = await db.select().from(materials).where(and(eq(materials.projectId, projectId), eq(materials.type, 'obsidian')));
      const priorByRef = new Map<string, MaterialRow>();
      for (const r of priorRows) if (r.sourceRef) priorByRef.set(r.sourceRef, r);

      const rows: MaterialRow[] = [];
      let touched = false;
      for (let i = 0; i < notes.length; i++) {
        if (ac.signal.aborted) break;
        const n = notes[i]!;
        send(`正在导入 ${i + 1}/${notes.length}：${n.relPath}`);
        const bytes = Buffer.byteLength(n.cleanText, 'utf8');
        const existing = priorByRef.get(n.relPath);
        if (existing) {
          const [updated] = await db.update(materials)
            .set({ rawContent: n.cleanText, fileSize: bytes, sourceMtime: new Date(n.mtimeMs), uploadedAt: new Date() })
            .where(eq(materials.id, existing.id))
            .returning();
          if (updated) rows.push(updated);
          touched = true;
        } else {
          rows.push(await insertMaterial(projectId, 'obsidian', n.cleanText, n.relPath, bytes, 'project', new Date(n.mtimeMs)));
        }
      }
      // insertMaterial bumps the project on insert; bump once more to cover the
      // update-only path (re-import where every note already existed).
      if (touched) await db.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, projectId));
      return rows;
    } catch (e) {
      if ((e as Error).name === 'AbortError' || (e as Error).message === '已取消') throw new Error('已取消');
      throw e;
    } finally {
      if (currentUpload === ac) currentUpload = null;
    }
  });

  ipcMain.handle('material:cancel', (): void => {
    cancelCurrentUpload();
  });

  ipcMain.handle('material:delete', async (_event, id: string): Promise<void> => {
    await getDb().delete(materials).where(eq(materials.id, id));
  });
}
