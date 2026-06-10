import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanObsidianMarkdown, collectMarkdownFiles, parseObsidianVault, folderOf, summarizeScope, classifyNoteStatus, scanVaultNotes } from './obsidian.js';
import { sep } from 'node:path';

describe('cleanObsidianMarkdown', () => {
  it('extracts frontmatter title and inline-array tags, drops the frontmatter block', () => {
    const raw = `---\ntitle: 数据库为何用 WAL\ntags: [sqlite, 并发]\n---\n正文内容在这里。`;
    const { title, tags, cleanText } = cleanObsidianMarkdown(raw);
    expect(title).toBe('数据库为何用 WAL');
    expect(tags).toEqual(['sqlite', '并发']);
    expect(cleanText).toContain('# 数据库为何用 WAL');
    expect(cleanText).toContain('标签：sqlite、并发');
    expect(cleanText).toContain('正文内容在这里。');
    expect(cleanText).not.toContain('---');
  });

  it('parses block-style tag lists', () => {
    const raw = `---\ntags:\n  - ai\n  - 会议\n---\n内容`;
    expect(cleanObsidianMarkdown(raw).tags).toEqual(['ai', '会议']);
  });

  it('strips %% comments %% including multi-line', () => {
    const raw = `保留这段 %% 这是注释 %% 文本。\n%%\n跨行注释\n%%\n结尾。`;
    const out = cleanObsidianMarkdown(raw).cleanText;
    expect(out).not.toContain('注释');
    expect(out).toContain('保留这段');
    expect(out).toContain('结尾。');
  });

  it('removes embeds and images but keeps surrounding text', () => {
    const raw = `开头 ![[别的笔记]] 中间 ![图](pic.png) 结尾`;
    const out = cleanObsidianMarkdown(raw).cleanText;
    expect(out).not.toContain('别的笔记');
    expect(out).not.toContain('pic.png');
    expect(out).toContain('开头');
    expect(out).toContain('结尾');
  });

  it('converts wikilinks to their display text', () => {
    expect(cleanObsidianMarkdown('见 [[索引]]').cleanText).toContain('见 索引');
    expect(cleanObsidianMarkdown('见 [[索引|首页]]').cleanText).toContain('见 首页');
    expect(cleanObsidianMarkdown('见 [[索引#小节]]').cleanText).toContain('见 索引');
  });

  it('converts markdown links to text and unwraps highlights', () => {
    expect(cleanObsidianMarkdown('看 [文档](https://x.com)').cleanText).toContain('看 文档');
    expect(cleanObsidianMarkdown('==重点==内容').cleanText).toContain('重点内容');
  });

  it('handles markdown link URLs containing parentheses without leaving a stray )', () => {
    const out = cleanObsidianMarkdown('看 [文档](https://x.com/Foo_(bar)) 结束').cleanText;
    expect(out).toContain('看 文档 结束');
    expect(out).not.toContain(')');
    expect(out).not.toContain('Foo_');
  });

  it('flattens callouts, keeping the title and body', () => {
    const raw = `> [!note] 提示标题\n> 第一行\n> 第二行`;
    const out = cleanObsidianMarkdown(raw).cleanText;
    expect(out).toContain('提示标题');
    expect(out).toContain('第一行');
    expect(out).toContain('第二行');
    expect(out).not.toContain('[!note]');
    expect(out).not.toContain('>');
  });

  it('keeps task text but removes the checkbox marker', () => {
    const out = cleanObsidianMarkdown('- [ ] 待办事项\n- [x] 已完成').cleanText;
    expect(out).toContain('- 待办事项');
    expect(out).toContain('- 已完成');
    expect(out).not.toContain('[ ]');
    expect(out).not.toContain('[x]');
  });

  it('falls back to the first H1 for title when frontmatter has none', () => {
    expect(cleanObsidianMarkdown('# 我的标题\n正文').title).toBe('我的标题');
  });
});

describe('collectMarkdownFiles / parseObsidianVault (real fs)', () => {
  const vault = mkdtempSync(join(tmpdir(), 'obsidian-vault-'));
  mkdirSync(join(vault, 'sub'));
  mkdirSync(join(vault, '.obsidian'));
  mkdirSync(join(vault, '.trash'));
  writeFileSync(join(vault, 'note1.md'), '# 笔记一\n内容一，足够长的文本。');
  writeFileSync(join(vault, 'sub', 'note2.md'), '---\ntags: [x]\n---\n[[wiki]] 内容二，足够长。');
  writeFileSync(join(vault, '.obsidian', 'config.md'), '应被排除的配置');
  writeFileSync(join(vault, '.trash', 'old.md'), '应被排除的废纸篓');
  writeFileSync(join(vault, 'image.png'), 'binary-not-md');
  writeFileSync(join(vault, 'empty.md'), '   '); // 清洗后过短，导入时应跳过

  afterAll(() => rmSync(vault, { recursive: true, force: true }));

  it('collects only .md files, excluding .obsidian / .trash / non-md', () => {
    const found = collectMarkdownFiles(vault).map((n) => n.relPath);
    expect(found).toContain('note1.md');
    expect(found).toContain(join('sub', 'note2.md'));
    expect(found.some((p) => p.includes('.obsidian'))).toBe(false);
    expect(found.some((p) => p.includes('.trash'))).toBe(false);
    expect(found.some((p) => p.endsWith('.png'))).toBe(false);
  });

  it('parses notes into per-note payloads and skips empty ones', () => {
    const parsed = parseObsidianVault(vault, undefined, {});
    const paths = parsed.map((p) => p.relPath);
    expect(paths).toContain('note1.md');
    expect(paths).toContain(join('sub', 'note2.md'));
    expect(paths).not.toContain('empty.md'); // 清洗后过短被跳过
    const n2 = parsed.find((p) => p.relPath === join('sub', 'note2.md'))!;
    expect(n2.cleanText).toContain('wiki'); // wikilink 转纯文本
    expect(n2.cleanText).toContain('标签：x');
    expect(n2.mtimeMs).toBeGreaterThan(0); // 携带 mtime 供增量导入
  });

  it('scanVaultNotes returns folder + frontmatter tags + mtime per note', () => {
    const notes = scanVaultNotes(vault);
    const root = notes.find((n) => n.relPath === 'note1.md')!;
    const sub = notes.find((n) => n.relPath === join('sub', 'note2.md'))!;
    expect(root.folder).toBe('');         // 根目录笔记
    expect(root.tags).toEqual([]);
    expect(sub.folder).toBe('sub');       // 顶层文件夹
    expect(sub.tags).toEqual(['x']);      // 从 frontmatter 读到的标签
    expect(sub.mtimeMs).toBeGreaterThan(0);
  });
});

describe('folderOf', () => {
  it('returns top-level folder, or empty string for root notes', () => {
    expect(folderOf('note.md')).toBe('');
    expect(folderOf(['a', 'note.md'].join(sep))).toBe('a');
    expect(folderOf(['a', 'b', 'note.md'].join(sep))).toBe('a'); // 仅顶层
  });
});

describe('summarizeScope', () => {
  it('counts folders and tags, sorted by count desc then name', () => {
    const notes = [
      { folder: 'tech', tags: ['ai', 'db'] },
      { folder: 'tech', tags: ['ai'] },
      { folder: '', tags: ['life'] },
    ];
    const { folders, tags } = summarizeScope(notes);
    expect(folders).toEqual([
      { name: 'tech', count: 2 },
      { name: '', count: 1 },
    ]);
    expect(tags[0]).toEqual({ name: 'ai', count: 2 });
    expect(tags.map((t) => t.name)).toEqual(['ai', 'db', 'life']);
  });

  it('dedupes repeated tags within a single note', () => {
    const { tags } = summarizeScope([{ folder: '', tags: ['ai', 'ai', 'ai'] }]);
    expect(tags).toEqual([{ name: 'ai', count: 1 }]);
  });
});

describe('classifyNoteStatus', () => {
  it('marks never-imported notes as new', () => {
    expect(classifyNoteStatus(1_000_000_000_000, undefined)).toBe('new');
  });
  it('marks notes imported before mtime tracking as changed (re-import once)', () => {
    expect(classifyNoteStatus(1_000_000_000_000, null)).toBe('changed');
  });
  it('compares at second precision: newer mtime → changed, same/older → unchanged', () => {
    const priorSec = 1_700_000_000; // seconds
    expect(classifyNoteStatus(priorSec * 1000 + 500, priorSec)).toBe('unchanged'); // sub-second 不算变化
    expect(classifyNoteStatus((priorSec + 1) * 1000, priorSec)).toBe('changed');
    expect(classifyNoteStatus((priorSec - 5) * 1000, priorSec)).toBe('unchanged');
  });
});
