import { describe, it, expect } from 'vitest';
import { obsidianFilename, buildObsidianNote, buildObsidianIndexNote, typeLabel, type ExportableCard, type IndexEntry } from './obsidian-export.js';

function card(over: Partial<ExportableCard> = {}): ExportableCard {
  return {
    id: 'c1',
    type: 'tech_principle',
    title: '为什么用 WAL',
    summary: '提升并发写入',
    details: 'WAL 模式让读写并发，写不阻塞读。',
    tags: ['sqlite', '并发'],
    isImportant: false,
    userVerified: false,
    ...over,
  };
}

describe('obsidianFilename', () => {
  it('strips illegal filename / Obsidian-special chars to spaces', () => {
    const name = obsidianFilename('A/B: test? #tag [x]', new Set());
    expect(name).not.toMatch(/[\\/:*?"<>|#^[\]]/);
    expect(name).toContain('A B test');
  });

  it('dedupes collisions with a numeric suffix (case-insensitive)', () => {
    const used = new Set<string>();
    expect(obsidianFilename('卡片', used)).toBe('卡片');
    expect(obsidianFilename('卡片', used)).toBe('卡片 2');
    expect(obsidianFilename('卡片', used)).toBe('卡片 3');
  });

  it('falls back when the title is empty or only illegal/leading chars', () => {
    expect(obsidianFilename('', new Set())).toBe('卡片');
    expect(obsidianFilename('   ', new Set())).toBe('卡片');
    expect(obsidianFilename('...hidden', new Set())).toBe('hidden'); // 去掉前导点, 不生成隐藏文件
  });
});

describe('buildObsidianNote', () => {
  it('emits valid frontmatter with type label, flags, deduped tags and provenance', () => {
    const md = buildObsidianNote(card({ isImportant: true, userVerified: true }), { name: '我的项目' });
    expect(md.startsWith('---\n')).toBe(true);
    expect(md).toContain(`type: ${typeLabel('tech_principle')}`);
    expect(md).toContain('important: true');
    expect(md).toContain('verified: true');
    expect(md).toContain('generated_by: QA Matching');
    expect(md).toContain('card_id: c1');
    // tags: qa-matching + 类型 key + 卡片标签
    expect(md).toContain('  - qa-matching');
    expect(md).toContain('  - tech_principle');
    expect(md).toContain('  - sqlite');
    // 正文含标题/摘要/详情
    expect(md).toContain('# 为什么用 WAL');
    expect(md).toContain('> [!question] 提升并发写入');
    expect(md).toContain('WAL 模式让读写并发');
  });

  it('converts spaces in tags to hyphens (Obsidian tags forbid spaces)', () => {
    const md = buildObsidianNote(card({ tags: ['machine learning'] }), { name: 'p' });
    expect(md).toContain('  - machine-learning');
    expect(md).not.toContain('  - machine learning');
  });

  it('quotes a project name containing YAML-special characters', () => {
    const md = buildObsidianNote(card(), { name: 'a: b #c' });
    expect(md).toContain('project: "a: b #c"');
  });
});

describe('buildObsidianIndexNote', () => {
  it('groups wikilinks by type in meeting-priority order, marking important', () => {
    const entries: IndexEntry[] = [
      { type: 'tech_principle', filename: '原理卡', title: '原理卡', important: false },
      { type: 'result_impact', filename: '结果卡', title: '结果卡', important: true },
    ];
    const md = buildObsidianIndexNote({ name: '我的项目', targetRole: '后端工程师\n其他' }, entries);
    expect(md).toContain('# 我的项目 · 会议卡片索引');
    expect(md).toContain('**会议主题：** 后端工程师'); // 仅取第一行
    expect(md).toContain('共 2 张卡片。');
    expect(md).toContain('[[结果卡]]');
    expect(md).toContain('★ [[结果卡]]'); // 重要卡带星
    expect(md).toContain('[[原理卡]]');
    // 结果影响优先级高于技术原理 → 结果卡分组在前
    expect(md.indexOf(`## ${typeLabel('result_impact')}`)).toBeLessThan(md.indexOf(`## ${typeLabel('tech_principle')}`));
  });
});
