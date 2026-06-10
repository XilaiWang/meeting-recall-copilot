// Why: reverse direction of the Obsidian importer — turn extracted cards back into
// browsable Obsidian notes (one .md per card + an index), so a user can keep their
// meeting prep inside their own knowledge base. Pure string builders here; the fs
// writes + dialog live in ipc/export.ts.

import type { CardRow, CardType } from '../db/schema.js';

// Mirror of the labels used by the PDF / cheat-sheet export so card type names are
// consistent across every export surface.
const TYPE_LABEL: Record<CardType, string> = {
  result_impact: '结果影响',
  data_metric: '数据指标',
  difficulty_solution: '难点解法',
  decision_tradeoff: '决策权衡',
  tech_principle: '技术原理',
  process_method: '流程方法',
  domain_fact: '领域知识',
};

const TYPE_ORDER: CardType[] = [
  'result_impact', 'data_metric', 'difficulty_solution',
  'decision_tradeoff', 'tech_principle', 'process_method', 'domain_fact',
];

export function typeLabel(type: string): string {
  return TYPE_LABEL[type as CardType] ?? type;
}

// Characters illegal in filenames on Windows/macOS plus the ones Obsidian itself
// treats specially in links/tags ([ ] # ^ |). Collapsed to spaces, not dropped, so
// "A/B test" stays readable as "A B test".
const ILLEGAL_FILENAME = /[\\/:*?"<>|#^[\]]/g;

// Why: derive a safe, unique .md basename (no extension) from a card title.
// `used` carries lowercased names already taken in this export so collisions get a
// numeric suffix instead of silently overwriting a sibling note.
export function obsidianFilename(title: string, used: Set<string>): string {
  let base = (title || '')
    .replace(ILLEGAL_FILENAME, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '') // no leading dot (hidden file) or space
    .trim()
    .slice(0, 80)
    .trim();
  if (!base) base = '卡片';
  let name = base;
  let i = 2;
  while (used.has(name.toLowerCase())) name = `${base} ${i++}`;
  used.add(name.toLowerCase());
  return name;
}

// Why: most values are safe bare YAML scalars; quote (as a JSON double-quoted
// string, which is valid YAML) only when a char would break the scalar, so the
// frontmatter stays human-readable in the common case.
function yamlScalar(s: string): string {
  if (s === '' || /[:#[\]{}",&*!|>%@`]/.test(s) || /^[\s?-]/.test(s) || /\s$/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

// Obsidian tags can't contain spaces; collapse them to hyphens and drop empties.
function normalizeTag(t: string): string {
  return t.trim().replace(/\s+/g, '-').replace(/^#+/, '');
}

function uniq(arr: string[]): string[] {
  return [...new Set(arr.filter(Boolean))];
}

export interface ExportableCard {
  id: string;
  type: string;
  title: string;
  summary: string;
  details: string;
  tags: string[];
  isImportant: boolean;
  userVerified: boolean;
}

// Why: one note per card with YAML frontmatter (type/important/verified/tags +
// provenance) so the card stays filterable inside Obsidian; body is title → summary
// callout → details, matching how the card reads in-app.
export function buildObsidianNote(card: ExportableCard, project: { name: string }): string {
  const tags = uniq(['qa-matching', card.type, ...(card.tags ?? [])].map(normalizeTag));
  const fm: string[] = ['---'];
  fm.push(`title: ${yamlScalar(card.title)}`);
  fm.push(`type: ${yamlScalar(typeLabel(card.type))}`);
  fm.push(`important: ${card.isImportant}`);
  fm.push(`verified: ${card.userVerified}`);
  fm.push(`project: ${yamlScalar(project.name)}`);
  fm.push('tags:');
  for (const t of tags) fm.push(`  - ${yamlScalar(t)}`);
  fm.push('generated_by: QA Matching');
  fm.push(`card_id: ${card.id}`);
  fm.push('---');

  const body: string[] = [
    '',
    `# ${card.title}`,
    '',
    `> [!question] ${card.summary}`,
    '',
    card.details.trim(),
    '',
  ];
  return `${fm.join('\n')}\n${body.join('\n')}`;
}

export interface IndexEntry {
  type: string;
  filename: string; // basename without .md
  title: string;
  important: boolean;
}

// Why: a single index note links every exported card via [[wikilinks]], grouped by
// type, so the user has one entry point to the whole project's cards in Obsidian.
export function buildObsidianIndexNote(project: { name: string; targetRole?: string | null }, entries: IndexEntry[]): string {
  const lines: string[] = ['---', `title: ${yamlScalar(`${project.name} · 会议卡片索引`)}`, 'tags:', '  - qa-matching', '  - qa-matching-index', 'generated_by: QA Matching', '---', ''];
  lines.push(`# ${project.name} · 会议卡片索引`);
  const role = (project.targetRole || '').split('\n')[0]!.trim().slice(0, 80);
  if (role) lines.push(`**会议主题：** ${role}`);
  lines.push('');
  lines.push(`共 ${entries.length} 张卡片。`);
  lines.push('');

  const byType = new Map<string, IndexEntry[]>();
  for (const e of entries) {
    const g = byType.get(e.type) ?? [];
    g.push(e);
    byType.set(e.type, g);
  }
  // Known types first in meeting-priority order, then any unknown types.
  const orderedTypes = [...TYPE_ORDER.filter((t) => byType.has(t)), ...[...byType.keys()].filter((t) => !TYPE_ORDER.includes(t as CardType))];
  for (const type of orderedTypes) {
    const group = byType.get(type);
    if (!group?.length) continue;
    lines.push(`## ${typeLabel(type)}`);
    for (const e of group) lines.push(`- ${e.important ? '★ ' : ''}[[${e.filename}]]`);
    lines.push('');
  }
  lines.push('---');
  lines.push('*由 QA Matching 导出*');
  return lines.join('\n');
}

export function cardToExportable(card: CardRow): ExportableCard {
  return {
    id: card.id,
    type: card.type,
    title: card.title,
    summary: card.summary,
    details: card.details,
    tags: Array.isArray(card.tags) ? card.tags : [],
    isImportant: card.isImportant,
    userVerified: card.userVerified,
  };
}
