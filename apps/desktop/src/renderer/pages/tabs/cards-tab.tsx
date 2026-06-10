import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
// 去 emoji 化:用 Phosphor glyph 替换原 ★/✓/✕/✏️/🃏/🗂️ 文本符号图标。
import { Star, Check, X, PencilSimple, Cards, Stack, CaretUp, CaretDown, CaretRight } from '@phosphor-icons/react';
import type { Card, CardType } from '../../env.js';
// 复用共享 UX 原语(toast/二次确认)与 a11y 类常量,避免自造。
import { useToast } from '../../components/ui/toast.js';
import { useConfirm } from '../../components/ui/confirm-dialog.js';
import Spinner from '../../components/ui/spinner.js';
import { FOCUS_RING, FOCUS_RING_LIGHT, DISABLED } from '../../lib/ui.js';
import CountUp from '../../components/ui/reactbits/count-up.js';
import FadeContent from '../../components/ui/reactbits/fade-content.js';

const TYPE_LABEL: Record<CardType, string> = {
  tech_principle: '技术原理',
  domain_fact: '领域知识',
  data_metric: '数据指标',
  process_method: '流程方法',
  decision_tradeoff: '决策权衡',
  difficulty_solution: '难点解法',
  result_impact: '结果影响',
};

const TYPE_COLOR: Record<CardType, string> = {
  tech_principle: 'bg-blue-50 text-blue-700 border-blue-100',
  domain_fact: 'bg-purple-50 text-purple-700 border-purple-100',
  data_metric: 'bg-green-50 text-green-700 border-green-100',
  process_method: 'bg-yellow-50 text-yellow-700 border-yellow-100',
  decision_tradeoff: 'bg-orange-50 text-orange-700 border-orange-100',
  difficulty_solution: 'bg-red-50 text-red-700 border-red-100',
  result_impact: 'bg-teal-50 text-teal-700 border-teal-100',
};

// Why: split(capturing-group) interleaves non-matches (even idx) and matches (odd idx).
// Wrapping odd-index parts in <mark> gives safe, XSS-free highlight without innerHTML.
function highlightMatches(text: string, query: string): React.ReactNode[] {
  const terms = query.trim().split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return [text];
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(${escaped.join('|')})`, 'gi');
  const parts = text.split(pattern);
  return parts.map((part, i) =>
    i % 2 === 1
      ? <mark key={i} className="bg-yellow-200 text-yellow-900 rounded-sm px-0.5 not-italic">{part}</mark>
      : part,
  );
}

// ── Sorting ────────────────────────────────────────────────────────────────────

type SortKey = 'newest' | 'oldest' | 'confidence-desc' | 'confidence-asc' | 'important' | 'review-due';

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'newest',          label: '最新' },
  { key: 'oldest',          label: '最早' },
  { key: 'confidence-desc', label: '置信度高到低' },
  { key: 'confidence-asc',  label: '置信度低到高' },
  { key: 'important',       label: '重点优先' },
  { key: 'review-due',      label: '复习到期' },
];

function sortCards(list: Card[], key: SortKey): Card[] {
  const arr = [...list];
  switch (key) {
    case 'newest':
      return arr.sort((a, b) => new Date(b.createdAt as unknown as string).getTime() - new Date(a.createdAt as unknown as string).getTime());
    case 'oldest':
      return arr.sort((a, b) => new Date(a.createdAt as unknown as string).getTime() - new Date(b.createdAt as unknown as string).getTime());
    case 'confidence-desc':
      return arr.sort((a, b) => b.confidence - a.confidence);
    case 'confidence-asc':
      return arr.sort((a, b) => a.confidence - b.confidence);
    case 'important':
      return arr.sort((a, b) => (b.isImportant ? 1 : 0) - (a.isImportant ? 1 : 0));
    case 'review-due':
      return arr.sort((a, b) => {
        const da = a.fsrsDue ? new Date(a.fsrsDue as unknown as string).getTime() : 0;
        const db_ = b.fsrsDue ? new Date(b.fsrsDue as unknown as string).getTime() : 0;
        return da - db_;
      });
  }
}

// ── FSRS review session ───────────────────────────────────────────────────────

const RATING_OPTIONS = [
  { rating: 1, label: '忘了',   cls: 'bg-red-50 text-red-700 hover:bg-red-100 border border-red-100' },
  { rating: 2, label: '有点难', cls: 'bg-orange-50 text-orange-700 hover:bg-orange-100 border border-orange-100' },
  { rating: 3, label: '记得',   cls: 'bg-green-50 text-green-700 hover:bg-green-100 border border-green-100' },
  { rating: 4, label: '很熟',   cls: 'bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-100' },
] as const;

interface ReviewSessionProps {
  queue: Card[];
  onCardReviewed: (updated: Card) => void;
  onDone: () => void;
}

function ReviewSession({ queue, onCardReviewed, onDone }: ReviewSessionProps) {
  const [idx, setIdx]           = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy]         = useState(false);
  const [done, setDone]         = useState(0);

  const card = queue[idx];

  // 键盘快捷键:未揭示答案时空格/回车显示答案,揭示后按 1-4 对应四档评分。
  // 必须在任何提前 return 之前调用以遵守 Hooks 规则;退出复习/卸载时清理监听。
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // 编辑输入框聚焦时不拦截,以免误触发评分。
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (!revealed) {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setRevealed(true); }
        return;
      }
      if (e.key >= '1' && e.key <= '4' && !busy) {
        e.preventDefault();
        void rate(Number(e.key));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [revealed, busy, idx]);

  if (!card) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4 text-center">
        {/* 生产力工具去掉 🎉 emoji,改纯文案传达完成状态。 */}
        <p className="text-base font-semibold text-gray-900">今日复习完成</p>
        <p className="text-sm text-gray-500">共复习了 {done} 张卡片</p>
        <button
          onClick={onDone}
          className={`mt-2 px-5 py-2 bg-gray-900 text-white rounded-xl text-sm hover:bg-gray-700 transition-colors ${FOCUS_RING}`}
        >
          返回卡片库
        </button>
      </div>
    );
  }

  async function rate(rating: number) {
    if (busy || !card) return;
    setBusy(true);
    try {
      const updated = await window.api.cards.review(card.id, rating);
      onCardReviewed(updated);
      setDone((n) => n + 1);
      setIdx((i) => i + 1);
      setRevealed(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-sm text-gray-500 tabular-nums">{idx + 1} / {queue.length}</span>
        <button onClick={onDone} className={`text-xs text-gray-400 hover:text-gray-600 rounded ${FOCUS_RING}`}>退出复习</button>
      </div>

      {/* Progress bar — 进度条从灰改为灰→绿渐变,正向反馈复习推进。 */}
      <div className="h-1 bg-gray-100 rounded-full overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-gray-400 to-green-500 rounded-full transition-all duration-300"
          style={{ width: `${(idx / queue.length) * 100}%` }}
        />
      </div>

      {/* Card face */}
      <div className="border border-gray-200 rounded-2xl bg-white overflow-hidden">
        <div className="px-6 py-5">
          <div className="flex items-center gap-2 mb-3">
            <span className={`px-2 py-0.5 rounded-md text-xs font-medium border ${TYPE_COLOR[card.type]}`}>
              {TYPE_LABEL[card.type]}
            </span>
            {/* ★ 重点指示:Star fill + 文案,inline-flex 对齐。 */}
            {card.isImportant && <span className="inline-flex items-center gap-1.5 text-xs text-amber-500"><Star size={14} weight="fill" className="text-amber-500" /> 重点</span>}
            {typeof card.fsrsReps === 'number' && card.fsrsReps > 0 && (
              <span className="ml-auto text-xs text-gray-300 tabular-nums">复习 {card.fsrsReps} 次</span>
            )}
          </div>
          <p className="text-base font-semibold text-gray-900 leading-snug">{card.title}</p>
          {card.summary && (
            <p className="text-sm text-gray-500 mt-1.5 leading-relaxed">{card.summary}</p>
          )}
        </div>

        {revealed ? (
          <div className="px-6 pb-5 border-t border-gray-100 pt-4 bg-gray-50/40">
            <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">{card.details}</p>
            {card.tags.length > 0 && (
              <div className="flex gap-1.5 flex-wrap mt-3">
                {card.tags.map((t) => (
                  <span key={t} className="px-2 py-0.5 bg-gray-100 text-gray-500 rounded text-xs">{t}</span>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="px-6 pb-5 flex justify-center border-t border-gray-100 pt-4">
            <button
              onClick={() => setRevealed(true)}
              className={`px-6 py-2 bg-gray-900 text-white rounded-xl text-sm hover:bg-gray-700 transition-colors ${FOCUS_RING_LIGHT}`}
            >
              显示答案
            </button>
          </div>
        )}
      </div>

      {/* Rating buttons — only after reveal。按钮上数字角标提示对应 1-4 快捷键。 */}
      {revealed && (
        <div className="flex gap-2.5">
          {RATING_OPTIONS.map(({ rating, label, cls }) => (
            <button
              key={rating}
              onClick={() => void rate(rating)}
              disabled={busy}
              aria-disabled={busy}
              aria-label={`${label}（快捷键 ${rating}）`}
              className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors ${DISABLED} ${FOCUS_RING} ${cls}`}
            >
              <span className="opacity-50 mr-1 tabular-nums">{rating}</span>{label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Edit state ────────────────────────────────────────────────────────────────

interface EditState {
  title: string;
  summary: string;
  details: string;
  tagsRaw: string;
}

interface CardItemProps {
  card: Card;
  expanded: boolean;
  selected: boolean;
  onToggle: () => void;
  onSelect: (checked: boolean) => void;
  onUpdate: (updated: Card) => void;
  onDelete: (id: string) => void;
  // highlight is a no-op when query is empty (returns bare string node).
  highlight: (text: string) => React.ReactNode[];
}

function CardItem({ card, expanded, selected, onToggle, onSelect, onUpdate, onDelete, highlight }: CardItemProps) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [edit, setEdit] = useState<EditState>({
    title: card.title,
    summary: card.summary,
    details: card.details,
    tagsRaw: card.tags.join(', '),
  });
  const detailsRef = useRef<HTMLTextAreaElement>(null);

  function startEdit() {
    setEdit({ title: card.title, summary: card.summary, details: card.details, tagsRaw: card.tags.join(', ') });
    setEditing(true);
    setTimeout(() => detailsRef.current?.focus(), 50);
  }

  function cancelEdit() {
    setEditing(false);
  }

  // 保存可用性守卫:标题/详情非空且未在保存中(与保存按钮 disabled 条件一致,供键盘快捷键复用)。
  const canSave = !saving && !!edit.title.trim() && !!edit.details.trim();

  async function saveEdit() {
    if (!canSave) return;
    setSaving(true);
    try {
      const tags = edit.tagsRaw.split(',').map((t) => t.trim()).filter(Boolean);
      const updated = await window.api.cards.updateContent(card.id, {
        title: edit.title,
        summary: edit.summary,
        details: edit.details,
        tags,
      });
      onUpdate(updated);
      setEditing(false);
      // 保存成功反馈:与全局其它保存动作一致用 success toast。
      toast('已保存', { variant: 'success' });
    } finally {
      setSaving(false);
    }
  }

  // 编辑态内 Cmd/Ctrl+S 保存;仅编辑期间绑定,退出编辑/卸载时清理。
  useEffect(() => {
    if (!editing) return;
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        void saveEdit();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, canSave, edit]);

  // 单卡删除:二次确认后再调父级 onDelete(IPC 删除),避免误删不可撤销。
  async function confirmDelete() {
    if (!(await confirm({ title: '删除这张卡片？', body: '此操作不可撤销', danger: true }))) return;
    onDelete(card.id);
  }

  async function toggleImportant() {
    await window.api.cards.setImportant(card.id, !card.isImportant);
    onUpdate({ ...card, isImportant: !card.isImportant });
  }

  async function toggleVerified() {
    await window.api.cards.setVerified(card.id, !card.userVerified);
    onUpdate({ ...card, userVerified: !card.userVerified });
  }

  const confidencePct = Math.round(card.confidence * 100);
  const confidenceColor = card.confidence >= 0.9 ? 'text-gray-300' : card.confidence >= 0.7 ? 'text-amber-400' : 'text-red-400';

  return (
    <div className={`border rounded-xl overflow-hidden transition-colors group ${selected ? 'border-blue-200 bg-blue-50/30' : card.userVerified ? 'border-green-200 bg-green-50/20' : 'border-gray-100 bg-white'}`}>
      {/* Header row — always visible */}
      <div className="flex items-start gap-3 px-4 py-3 cursor-pointer" onClick={editing ? undefined : onToggle}>
        {/* Checkbox — visible when selected or on hover */}
        <div
          className={`shrink-0 mt-0.5 transition-opacity ${selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-60'}`}
          onClick={(e) => { e.stopPropagation(); onSelect(!selected); }}
        >
          <input
            type="checkbox"
            checked={selected}
            readOnly
            className="w-3.5 h-3.5 rounded cursor-pointer accent-gray-800"
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className={`px-2 py-0.5 rounded-md text-xs font-medium border ${TYPE_COLOR[card.type]}`}>
              {TYPE_LABEL[card.type]}
            </span>
            {/* ★ 重点指示:Star fill + 文案,inline-flex 对齐。 */}
            {card.isImportant && <span className="inline-flex items-center gap-1.5 text-xs text-amber-500 font-medium"><Star size={14} weight="fill" className="text-amber-500" /> 重点</span>}
            {/* ✓ 已确认指示:Check + 绿色文案,inline-flex 对齐。 */}
            {card.userVerified && <span className="inline-flex items-center gap-1.5 text-xs text-green-600 font-medium"><Check size={14} className="text-green-600" /> 已确认</span>}
            <span className={`text-xs ml-auto font-mono ${confidenceColor}`}>{confidencePct}%</span>
          </div>

          {editing ? (
            <input
              className="w-full text-sm font-semibold text-gray-900 border border-gray-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-gray-400"
              value={edit.title}
              onChange={(e) => setEdit((s) => ({ ...s, title: e.target.value }))}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <p className="text-sm font-semibold text-gray-900 leading-snug">{highlight(card.title)}</p>
          )}

          {!editing && (
            <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{highlight(card.summary)}</p>
          )}
        </div>
        {/* ▲/▼ 展开/收起指示:Caret 图标,继承灰色。 */}
        {!editing && (
          <span className="text-gray-300 shrink-0 mt-0.5 inline-flex items-center">{expanded ? <CaretUp size={14} /> : <CaretDown size={14} />}</span>
        )}
      </div>

      {/* Expanded body */}
      {expanded && (
        <div className="px-4 pb-4 border-t border-gray-100 pt-3 flex flex-col gap-3">
          {editing ? (
            <>
              <div>
                <label className="text-xs text-gray-400 mb-1 block">摘要</label>
                <input
                  className="w-full text-sm text-gray-700 border border-gray-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-gray-400"
                  value={edit.summary}
                  onChange={(e) => setEdit((s) => ({ ...s, summary: e.target.value }))}
                />
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1 block">详细内容</label>
                <textarea
                  ref={detailsRef}
                  rows={6}
                  className="w-full text-sm text-gray-700 border border-gray-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-gray-400 resize-none leading-relaxed"
                  value={edit.details}
                  onChange={(e) => setEdit((s) => ({ ...s, details: e.target.value }))}
                />
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1 block">标签（逗号分隔）</label>
                <input
                  className="w-full text-sm text-gray-700 border border-gray-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-gray-400 font-mono"
                  value={edit.tagsRaw}
                  onChange={(e) => setEdit((s) => ({ ...s, tagsRaw: e.target.value }))}
                />
              </div>
              <div className="flex gap-2 justify-end pt-1">
                <button onClick={cancelEdit} className={`px-3 py-1.5 text-sm text-gray-400 hover:text-gray-600 rounded-lg ${FOCUS_RING}`}>取消</button>
                <button
                  onClick={saveEdit}
                  disabled={!canSave}
                  className={`px-4 py-1.5 bg-gray-900 text-white text-sm rounded-lg hover:bg-gray-700 transition-colors inline-flex items-center gap-1.5 ${DISABLED} ${FOCUS_RING}`}
                >
                  {saving && <Spinner className="w-4 h-4" />}
                  {saving ? '保存中…' : '保存'}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">{highlight(card.details)}</p>
              {card.tags.length > 0 && (
                <div className="flex gap-1.5 flex-wrap">
                  {card.tags.map((tag) => (
                    <span key={tag} className="px-2 py-0.5 bg-gray-100 text-gray-500 rounded text-xs">{highlight(tag)}</span>
                  ))}
                </div>
              )}
              <div className="flex gap-2 pt-2 border-t border-gray-100 flex-wrap">
                {/* ✏️ 编辑:PencilSimple + 文案,容器 inline-flex 对齐。 */}
                <button onClick={startEdit}
                  className={`px-3 py-1.5 rounded-lg text-xs bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors inline-flex items-center gap-1.5 ${FOCUS_RING}`}>
                  <PencilSimple size={14} /> 编辑
                </button>
                {/* ★ 标记重点:非激活态 Star fill 图标 + 文案;容器 inline-flex 对齐。 */}
                <button onClick={toggleImportant}
                  className={`px-3 py-1.5 rounded-lg text-xs transition-colors inline-flex items-center gap-1.5 ${FOCUS_RING} ${card.isImportant ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>
                  {card.isImportant ? '取消重点' : <><Star size={14} weight="fill" className="text-amber-500" /> 标记重点</>}
                </button>
                {/* ✓ 标记确认:非激活态 Check 绿色图标 + 文案;容器 inline-flex 对齐。 */}
                <button onClick={toggleVerified}
                  className={`px-3 py-1.5 rounded-lg text-xs transition-colors inline-flex items-center gap-1.5 ${FOCUS_RING} ${card.userVerified ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>
                  {card.userVerified ? '取消确认' : <><Check size={14} className="text-green-600" /> 标记确认</>}
                </button>
                {/* 删除走二次确认(confirmDelete),不可撤销操作前拦一道。 */}
                <button onClick={() => void confirmDelete()}
                  className={`px-3 py-1.5 rounded-lg text-xs bg-gray-100 text-gray-500 hover:bg-red-100 hover:text-red-600 transition-colors ml-auto ${FOCUS_RING}`}>
                  删除
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface Props {
  projectId: string;
  refresh?: number;
  extracting?: boolean;
  extractError?: string;
}

export default function CardsTab({ projectId, refresh, extracting, extractError }: Props) {
  const confirm = useConfirm();
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<CardType | 'all'>('all');
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('newest');
  const [showReview, setShowReview] = useState(false);
  const [reviewQueue, setReviewQueue] = useState<Card[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);

  // Ranked card ids from the main-process FTS5 search (null = no active query).
  const [rankedIds, setRankedIds] = useState<string[] | null>(null);

  useEffect(() => {
    setLoading(true);
    window.api.cards.list(projectId)
      .then((c) => { setCards(c); setLoading(false); })
      .catch(() => setLoading(false));
  }, [projectId, refresh]);

  // Append cards streamed from the LLM extraction pipeline in real time.
  useEffect(() => {
    window.api.cards.onCardExtracted((card) => {
      setCards((prev) => {
        if (prev.some((c) => c.id === (card as Card).id)) return prev;
        return [(card as Card), ...prev];
      });
    });
    return () => { window.api.cards.offCardExtracted(); };
  }, [projectId]);

  // Debounced search: 250ms after typing stops, run the main-process FTS5 search
  // (bm25-ranked, Chinese handled by the index's bigram injection). Stale responses
  // are dropped via the `alive` guard so fast typing can't show an old result set.
  useEffect(() => {
    if (!query.trim()) { setRankedIds(null); return; }
    let alive = true;
    const timer = setTimeout(async () => {
      const ranked = await window.api.retrieval.cardSearch(projectId, query).catch(() => [] as Card[]);
      if (alive) setRankedIds(ranked.map((c) => c.id));
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [query, projectId]);

  // highlight is memoised per query to avoid CardItem re-renders on unrelated state changes.
  const highlight = useCallback(
    (text: string) => highlightMatches(text, query),
    [query],
  );

  // Why: IPC serialises Date → ISO string; use string comparison which works correctly.
  const dueCards = useMemo(() => {
    const now = Date.now();
    return cards.filter((c) =>
      c.fsrsState === null || c.fsrsState === undefined ||
      (c.fsrsDue !== null && c.fsrsDue !== undefined && new Date(c.fsrsDue as unknown as string).getTime() <= now),
    );
  }, [cards]);

  function startReview() {
    setReviewQueue([...dueCards]);
    setShowReview(true);
  }

  function handleReviewDone() {
    setShowReview(false);
    setReviewQueue([]);
  }

  function handleCardReviewed(updated: Card) {
    setCards((prev) => prev.map((c) => c.id === updated.id ? updated : c));
  }

  function toggleSelect(id: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  }

  function selectAll() {
    setSelectedIds(new Set(filtered.map((c) => c.id)));
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  async function handleDeleteBatch() {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    // 批量删除前二次确认,标题含数量,强调不可撤销。
    if (!(await confirm({ title: `删除 ${ids.length} 张卡片？`, body: `将删除 ${ids.length} 张卡片，不可撤销`, danger: true }))) return;
    setBatchBusy(true);
    try {
      await window.api.cards.deleteBatch(ids);
      setCards((prev) => prev.filter((c) => !selectedIds.has(c.id)));
      if (ids.includes(expanded ?? '')) setExpanded(null);
      clearSelection();
    } finally { setBatchBusy(false); }
  }

  async function handleImportantBatch(v: boolean) {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setBatchBusy(true);
    try {
      await window.api.cards.setImportantBatch(ids, v);
      setCards((prev) => prev.map((c) => selectedIds.has(c.id) ? { ...c, isImportant: v } : c));
      clearSelection();
    } finally { setBatchBusy(false); }
  }

  async function handleVerifiedBatch(v: boolean) {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setBatchBusy(true);
    try {
      await window.api.cards.setVerifiedBatch(ids, v);
      setCards((prev) => prev.map((c) => selectedIds.has(c.id) ? { ...c, userVerified: v } : c));
      clearSelection();
    } finally { setBatchBusy(false); }
  }

  function handleUpdate(updated: Card) {
    setCards((prev) => prev.map((c) => c.id === updated.id ? updated : c));
  }

  async function handleDelete(id: string) {
    await window.api.cards.delete(id);
    setCards((prev) => prev.filter((c) => c.id !== id));
    if (expanded === id) setExpanded(null);
  }

  const typeCounts = useMemo(
    () => cards.reduce<Partial<Record<CardType, number>>>((acc, c) => {
      acc[c.type] = (acc[c.type] ?? 0) + 1;
      return acc;
    }, {}),
    [cards],
  );

  const filtered = useMemo(() => {
    let result = filterType === 'all' ? cards : cards.filter((c) => c.type === filterType);

    if (rankedIds !== null) {
      // Search active: keep BM25 order, type filter already applied above.
      const idSet = new Set(rankedIds);
      result = result.filter((c) => idSet.has(c.id));
      result = [...result].sort((a, b) => rankedIds.indexOf(a.id) - rankedIds.indexOf(b.id));
    } else {
      // No search: apply selected sort dimension.
      result = sortCards(result, sortBy);
    }

    return result;
  }, [cards, filterType, rankedIds, sortBy]);

  if (loading) {
    return <div className="flex items-center justify-center py-16 text-gray-400 text-sm">加载中…</div>;
  }

  if (cards.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        {extracting && (
          <div className="flex items-center gap-3 bg-blue-50 border border-blue-100 rounded-xl px-4 py-4">
            <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin shrink-0" />
            <p className="text-sm text-blue-700 font-medium">AI 正在提取卡片…</p>
          </div>
        )}
        {extractError && (
          <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg" role="alert" aria-live="polite">{extractError}</p>
        )}
        {!extracting && !extractError && (
          // 空态三层化:状态标题 + 卡片用途说明 + 明确下一步指引(纯文案,不做跨 tab 跳转)。
          // FadeContent: 空态柔和淡入(首屏在视口内自动触发)。
          <FadeContent duration={500} className="flex flex-col items-center justify-center py-16 gap-2 text-center max-w-sm mx-auto">
            {/* 🃏 空态图:Cards 大图标继承空态灰色。 */}
            <Cards size={40} className="text-gray-300" />
            <p className="text-gray-700 text-sm font-medium">还没有卡片</p>
            <p className="text-gray-500 text-xs leading-relaxed">卡片是从你的素材里提取的知识点，用来复习和召回项目细节。</p>
            <p className="text-gray-400 text-xs leading-relaxed">请先切换到上方「素材」标签上传内容，再点击「提取卡片」开始。</p>
          </FadeContent>
        )}
      </div>
    );
  }

  if (showReview) {
    return (
      <ReviewSession
        queue={reviewQueue}
        onCardReviewed={handleCardReviewed}
        onDone={handleReviewDone}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {extracting && (
        <div className="flex items-center gap-3 bg-blue-50 border border-blue-100 rounded-xl px-4 py-3">
          <div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin shrink-0" />
          <p className="text-sm text-blue-700">AI 正在提取… 已得到 {cards.length} 张</p>
        </div>
      )}
      {extractError && (
        <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg" role="alert" aria-live="polite">{extractError}</p>
      )}
      {/* Today's review CTA */}
      {dueCards.length > 0 && (
        <button
          onClick={startReview}
          className={`flex items-center gap-3 w-full px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-left hover:bg-amber-100 transition-colors ${FOCUS_RING}`}
        >
          {/* 🗂️ 待复习提示图标:Stack 继承当前文字色。 */}
          <Stack size={18} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-amber-800">今日复习</p>
            <p className="text-xs text-amber-600">{dueCards.length} 张卡片待复习</p>
          </div>
          {/* › 进入复习指示:CaretRight,继承琥珀色。 */}
          <span className="text-amber-400 inline-flex items-center"><CaretRight size={14} /></span>
        </button>
      )}
      {/* Search bar — 右侧清除按钮,query 非空时出现,一键清空搜索。 */}
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索卡片标题、内容、标签…"
          className={`w-full pl-4 pr-9 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-gray-300 bg-white ${FOCUS_RING}`}
        />
        {query && (
          <button
            onClick={() => setQuery('')}
            aria-label="清除搜索"
            className={`absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center rounded-full text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors ${FOCUS_RING}`}
          >
            {/* ✕ 清除搜索图标。 */}
            <X size={14} />
          </button>
        )}
      </div>

      {/* Type filter chips + sort control */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => setFilterType('all')}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${FOCUS_RING} ${filterType === 'all' ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
        >
          全部 {cards.length}
        </button>
        {(Object.keys(TYPE_LABEL) as CardType[])
          .filter((t) => typeCounts[t])
          .map((type) => (
            <button
              key={type}
              onClick={() => setFilterType(filterType === type ? 'all' : type)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${FOCUS_RING} ${filterType === type ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >
              {TYPE_LABEL[type]} {typeCounts[type]}
            </button>
          ))}
        {/* Sort control — hidden while search is active (BM25 order takes priority) */}
        {!query.trim() && (
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortKey)}
            aria-label="排序方式"
            className={`ml-auto text-xs px-2 py-1.5 border border-gray-200 rounded-lg bg-white text-gray-600 cursor-pointer ${FOCUS_RING}`}
          >
            {SORT_OPTIONS.map(({ key, label }) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
        )}
      </div>

      {/* Search result hint */}
      {query && (
        <p className="text-xs text-gray-400">
          找到 <CountUp to={filtered.length} duration={0.4} /> 张 / 共 {cards.length} 张 · 按相关度排序
        </p>
      )}

      {/* Card list */}
      {filtered.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-8">没有匹配的卡片</p>
      ) : (
        <div className="space-y-3">
          {filtered.map((card) => (
            <CardItem
              key={card.id}
              card={card}
              expanded={expanded === card.id}
              selected={selectedIds.has(card.id)}
              onToggle={() => setExpanded(expanded === card.id ? null : card.id)}
              onSelect={(checked) => toggleSelect(card.id, checked)}
              onUpdate={handleUpdate}
              onDelete={handleDelete}
              highlight={highlight}
            />
          ))}
        </div>
      )}

      {/* Batch selection toolbar */}
      {selectedIds.size > 0 && (
        <div className="sticky bottom-0 flex items-center gap-2 px-4 py-3 bg-gray-900 text-white rounded-2xl shadow-xl">
          <span className="text-sm font-medium tabular-nums">已选 {selectedIds.size} 张</span>
          <button
            onClick={selectAll}
            className={`text-xs px-2 py-1 bg-white/10 rounded hover:bg-white/20 transition-colors ${FOCUS_RING_LIGHT}`}
          >
            全选 ({filtered.length})
          </button>
          <button
            onClick={clearSelection}
            className={`text-xs px-2 py-1 bg-white/10 rounded hover:bg-white/20 transition-colors ${FOCUS_RING_LIGHT}`}
          >
            取消
          </button>
          <div className="flex-1" />
          {/* 深色工具栏:焦点环用浅色变体;禁用态用 DISABLED 取代 opacity-40。 */}
          {/* ★ 批量标重点:Star fill + 文案;深色工具栏内继承当前 amber-300 文字色。 */}
          <button
            onClick={() => void handleImportantBatch(true)}
            disabled={batchBusy}
            className={`inline-flex items-center gap-1.5 text-xs px-2 py-1 bg-amber-500/20 text-amber-300 rounded hover:bg-amber-500/30 transition-colors ${DISABLED} ${FOCUS_RING_LIGHT}`}
          >
            <Star size={14} weight="fill" /> 标重点
          </button>
          {/* ✓ 批量标确认:Check + 文案;深色工具栏内继承当前 green-300 文字色。 */}
          <button
            onClick={() => void handleVerifiedBatch(true)}
            disabled={batchBusy}
            className={`inline-flex items-center gap-1.5 text-xs px-2 py-1 bg-green-500/20 text-green-300 rounded hover:bg-green-500/30 transition-colors ${DISABLED} ${FOCUS_RING_LIGHT}`}
          >
            <Check size={14} /> 标确认
          </button>
          <button
            onClick={() => void handleDeleteBatch()}
            disabled={batchBusy}
            className={`text-xs px-2 py-1 bg-red-500/20 text-red-300 rounded hover:bg-red-500/30 transition-colors ${DISABLED} ${FOCUS_RING_LIGHT}`}
          >
            删除
          </button>
        </div>
      )}
    </div>
  );
}
