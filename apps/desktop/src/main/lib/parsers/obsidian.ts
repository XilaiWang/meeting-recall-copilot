import { readFileSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join, relative, basename, sep } from 'node:path';
import { truncate } from './common.js';
import type { ParseOptions } from './github.js';

// Why: an Obsidian vault is just a folder of markdown notes; these subdirs hold
// app config / deleted notes / VCS / binary attachments and must never be ingested.
const EXCLUDED_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules']);
// Why: skip pathologically large single notes (pasted dumps) and cap total notes
// so a giant vault can't hang the synchronous walk/import on the main process.
const MAX_NOTE_BYTES = 1024 * 1024; // 1 MB per note
const MAX_NOTES = 1000;
// Why: frontmatter lives at the very top of a note; reading the first 16 KB is
// enough to extract tags for the import filter without slurping a whole 1 MB note.
const FRONTMATTER_PROBE_BYTES = 16 * 1024;

export interface VaultNoteMeta {
  absPath: string;
  relPath: string;
  sizeKB: number;
  // Why: file modification time (ms) drives incremental import — a re-scan can
  // skip notes whose mtime hasn't advanced since they were last imported.
  mtimeMs: number;
}

export interface CleanedNote {
  title: string;
  tags: string[];
  cleanText: string;
}

export interface ParsedNote {
  relPath: string;
  title: string;
  cleanText: string;
  mtimeMs: number;
}

// Why: mirrors file.ts collectFiles — synchronous recursion is fine for a local
// vault and keeps fs off the renderer; we only walk .md and prune Obsidian's
// own folders / hidden dirs.
export function collectMarkdownFiles(vaultPath: string): VaultNoteMeta[] {
  const out: VaultNoteMeta[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 8 || out.length >= MAX_NOTES) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= MAX_NOTES) break;
      if (entry.name.startsWith('.') || EXCLUDED_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        const st = statSync(full);
        if (st.size > 0 && st.size <= MAX_NOTE_BYTES) {
          out.push({ absPath: full, relPath: relative(vaultPath, full), sizeKB: Math.max(1, Math.round(st.size / 1024)), mtimeMs: st.mtimeMs });
        }
      }
    }
  };
  walk(vaultPath, 0);
  return out;
}

// Why: an Obsidian note carries YAML frontmatter we parse with a tiny regex
// (no yaml dep, per project "don't add deps" rule) — only title/tags are useful
// as LLM hints; everything else is dropped.
function splitFrontmatter(raw: string): { fm: string; body: string } {
  // Strip a leading UTF-8 BOM (0xFEFF) so the frontmatter fence still matches at ^.
  const s = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const m = s.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: '', body: s };
  return { fm: m[1] ?? '', body: s.slice(m[0].length) };
}

function fmField(fm: string, key: string): string | null {
  const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  if (!m) return null;
  return m[1]!.trim().replace(/^["']|["']$/g, '').trim() || null;
}

function fmTags(fm: string): string[] {
  // inline: `tags: [a, b]` or `tags: a, b` — only same-line whitespace so a
  // block list (`tags:\n  - a`) doesn't get greedily swallowed across the newline.
  const inline = fm.match(/^tags:[ \t]*(\[.*\]|[^\n[].*)$/m);
  if (inline) {
    const body = inline[1]!.trim().replace(/^\[|\]$/g, '');
    return body.split(/[,\s]+/).map((t) => t.replace(/^["'#]+|["']+$/g, '').trim()).filter(Boolean);
  }
  // block list: `tags:\n  - a\n  - b`
  const block = fm.match(/^tags:\s*\r?\n((?:[ \t]*-[ \t]*.+\r?\n?)+)/m);
  if (block) {
    return block[1]!.split(/\r?\n/).map((l) => l.replace(/^[ \t]*-[ \t]*/, '').replace(/^["'#]+|["']+$/g, '').trim()).filter(Boolean);
  }
  return [];
}

// Why: strip Obsidian-specific syntax into clean prose so the LLM sees the
// knowledge, not the markup. Order matters: callout titles are pulled out
// before the blockquote prefix is removed; embeds/images go before plain links.
export function cleanObsidianMarkdown(raw: string): CleanedNote {
  const { fm, body } = splitFrontmatter(raw);
  const fmTitle = fmField(fm, 'title');
  const tags = fmTags(fm);

  let t = body;
  // 1. Obsidian comments %% ... %% (may span lines)
  t = t.replace(/%%[\s\S]*?%%/g, '');
  // 2. embeds ![[...]] and images ![alt](url) — non-expandable / non-textual
  t = t.replace(/!\[\[[^\]]*\]\]/g, '');
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  // 3. wikilinks → display text: [[note|alias]]→alias, [[note#heading]]→note
  t = t.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
  t = t.replace(/\[\[([^\]|#^]+)(?:[#^][^\]|]*)?\]\]/g, '$1');
  // 4. markdown links [text](url) → text. The URL part allows one level of nested
  // parens so wiki-style URLs like https://x.com/Foo_(bar) don't leave a stray ')'.
  t = t.replace(/\[([^\]]+)\]\([^()]*(?:\([^()]*\)[^()]*)*\)/g, '$1');
  // 5. callout header line `> [!type] Title` → Title (keep the title text)
  t = t.replace(/^>\s*\[![^\]]+\][+-]?\s*(.*)$/gm, '$1');
  // 6. drop remaining blockquote / callout body prefix `> `
  t = t.replace(/^>\s?/gm, '');
  // 7. highlights ==text== → text
  t = t.replace(/==([^=]+)==/g, '$1');
  // 8. task/list checkboxes `- [ ] x` → `- x` (keep the item text)
  t = t.replace(/^(\s*[-*])\s+\[[ xX/>?!-]\]\s+/gm, '$1 ');
  // 9. collapse 3+ blank lines
  t = t.replace(/\n{3,}/g, '\n\n').trim();

  const title = fmTitle || (body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? '');
  const header: string[] = [];
  if (title) header.push(`# ${title}`);
  if (tags.length) header.push(`标签：${tags.join('、')}`);
  const cleanText = (header.length ? `${header.join('\n')}\n\n` : '') + t;
  return { title, tags, cleanText };
}

// Why: read + clean each selected note into its own material payload. We keep
// notes as separate materials (not one blob) because extract.ts truncates each
// material to 12K chars — merging the whole vault would silently drop content.
export function parseObsidianVault(
  vaultPath: string,
  relPaths: string[] | undefined,
  opts: ParseOptions = {},
): ParsedNote[] {
  const { signal, onProgress } = opts;
  const all = collectMarkdownFiles(vaultPath);
  const wanted = relPaths && relPaths.length ? all.filter((n) => relPaths.includes(n.relPath)) : all;
  if (wanted.length === 0) throw new Error('未在该 vault 中找到 .md 笔记');

  const out: ParsedNote[] = [];
  for (let i = 0; i < wanted.length; i++) {
    if (signal?.aborted) throw new Error('已取消');
    const note = wanted[i]!;
    onProgress?.(`正在读取笔记 ${i + 1}/${wanted.length}：${note.relPath}`);
    let cleaned: CleanedNote;
    try {
      cleaned = cleanObsidianMarkdown(readFileSync(note.absPath, 'utf8'));
    } catch {
      continue; // skip a single unreadable/odd-encoded note rather than fail the whole import
    }
    if (cleaned.cleanText.trim().length < 10) continue; // skip empty notes
    out.push({
      relPath: note.relPath,
      title: cleaned.title || basename(note.relPath, '.md'),
      cleanText: truncate(cleaned.cleanText),
      mtimeMs: note.mtimeMs,
    });
  }
  if (out.length === 0) throw new Error('这些笔记清洗后没有可用文本');
  return out;
}

// ── Import-filter support (folder / tag scoping + incremental status) ──

export interface ScanNote {
  relPath: string;
  sizeKB: number;
  mtimeMs: number;
  folder: string;
  tags: string[];
}

// Why: group notes by their top-level vault folder so the import UI can offer a
// "only import folder X" filter; root-level notes report '' (rendered as 根目录).
export function folderOf(relPath: string): string {
  const i = relPath.indexOf(sep);
  return i === -1 ? '' : relPath.slice(0, i);
}

// Why: read only the first 16 KB to pull frontmatter tags for the import filter —
// a bounded partial read keeps the scan fast even on a 1000-note vault.
function readNoteTags(absPath: string): string[] {
  let fd: number | null = null;
  try {
    fd = openSync(absPath, 'r');
    const buf = Buffer.alloc(FRONTMATTER_PROBE_BYTES);
    const n = readSync(fd, buf, 0, FRONTMATTER_PROBE_BYTES, 0);
    const { fm } = splitFrontmatter(buf.toString('utf8', 0, n));
    return fm ? fmTags(fm) : [];
  } catch {
    return [];
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* already closed */ }
  }
}

// Why: metadata-only scan (size/mtime/folder/tags) powering the pre-import
// confirmation + filters, without reading or cleaning each note's full body.
export function scanVaultNotes(vaultPath: string): ScanNote[] {
  return collectMarkdownFiles(vaultPath).map((n) => ({
    relPath: n.relPath,
    sizeKB: n.sizeKB,
    mtimeMs: n.mtimeMs,
    folder: folderOf(n.relPath),
    tags: readNoteTags(n.absPath),
  }));
}

export interface ScopeFacet { name: string; count: number }

// Why: pure aggregation of available folders + tags (with counts) so the UI can
// render filter chips; sorted by count desc then name for a stable, useful order.
export function summarizeScope(notes: { folder: string; tags: string[] }[]): { folders: ScopeFacet[]; tags: ScopeFacet[] } {
  const folderCounts = new Map<string, number>();
  const tagCounts = new Map<string, number>();
  for (const n of notes) {
    folderCounts.set(n.folder, (folderCounts.get(n.folder) ?? 0) + 1);
    for (const t of new Set(n.tags)) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  }
  const toSorted = (m: Map<string, number>): ScopeFacet[] =>
    [...m.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { folders: toSorted(folderCounts), tags: toSorted(tagCounts) };
}

export type NoteStatus = 'new' | 'changed' | 'unchanged';

// Why: incremental-import classification. `prior` is the stored source mtime in
// SECONDS (SQLite timestamp precision): undefined = never imported (new),
// null = imported before mtime tracking (treat as changed so it re-imports once),
// number = compare at second precision to avoid sub-second false "changed".
export function classifyNoteStatus(mtimeMs: number, prior: number | null | undefined): NoteStatus {
  if (prior === undefined) return 'new';
  if (prior === null) return 'changed';
  return Math.floor(mtimeMs / 1000) > prior ? 'changed' : 'unchanged';
}
