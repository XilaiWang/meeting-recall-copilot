import { useEffect, useLayoutEffect, useRef, useState } from 'react';
// 去 emoji 化: 用 Phosphor glyph 替换 emoji / 文本符号图标
import { Buildings, Check, Star, CaretLeft, CaretRight } from '@phosphor-icons/react';
import type { Card } from '../env.js';
// Why: 深色浮窗的键盘焦点环用白色描边变体, 保证半透明背景上可见。
import { FOCUS_RING_LIGHT } from '../lib/ui.js';

const TYPE_LABEL: Record<string, string> = {
  result_impact: '结果影响', data_metric: '数据指标', difficulty_solution: '难点解法',
  decision_tradeoff: '决策权衡', tech_principle: '技术原理', process_method: '流程方法', domain_fact: '领域知识',
};
const TYPE_DOT: Record<string, string> = {
  result_impact: 'bg-green-400', data_metric: 'bg-blue-400', difficulty_solution: 'bg-red-400',
  decision_tradeoff: 'bg-amber-400', tech_principle: 'bg-purple-400', process_method: 'bg-cyan-400', domain_fact: 'bg-gray-500',
};

function extractKeySentences(details: string, max = 2): string {
  const parts = details.split(/(?<=[。！？.!?])\s*/u);
  const valid = parts.map((s) => s.trim()).filter((s) => s.length >= 15);
  if (valid.length === 0) return details.slice(0, 80) + '…';
  return valid.slice(0, max).join('');
}

// Why: DynamicIsland shape — concave top corners (inward quadratic curves matching
// the macOS notch edge) and convex bottom corners. Fixed w=340 (FLOAT_WIDTH).
function makeDIPath(h: number, t = 8, br = 18, w = 340): string {
  return `path('M 0 0 Q ${t} 0 ${t} ${t} L ${t} ${h-br} Q ${t} ${h} ${t+br} ${h} L ${w-t-br} ${h} Q ${w-t} ${h} ${w-t} ${h-br} L ${w-t} ${t} Q ${w-t} 0 ${w} 0 Z')`;
}

const AUTO_INTERVALS = [3, 5, 8] as const;
const LONG_PRESS_MS = 500;

function CompanyBriefPanel({ brief }: { brief: string }) {
  const [open, setOpen] = useState(false);
  // Extract company name from the first heading or use a generic label.
  const lines = brief.split('\n');
  const firstHeading = lines.find((l) => l.startsWith('##'))?.replace(/^#+\s*/, '').replace(/^[🎯📰🎁]\s*/u, '') ?? '会议方背景';
  return (
    <div className="mt-2 rounded-xl bg-white/10 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-white/70 hover:text-white transition-colors"
      >
        {/* 去 emoji: 🏢 -> Buildings */}
        <Buildings size={14} />
        <span className="font-medium flex-1 truncate">{firstHeading}</span>
        <span className="text-white/40">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 text-xs text-white/80 whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto">
          {brief}
        </div>
      )}
    </div>
  );
}

export default function MeetingFloat() {
  const [cards, setCards] = useState<Card[]>([]);
  const [companyBrief, setCompanyBrief] = useState<string | null>(null);
  const [idx, setIdx]         = useState(0);
  const [pillH, setPillH]     = useState(120);
  const [expanding, setExpanding] = useState(true);
  const [autoPlay, setAutoPlay]   = useState(false);
  const [autoIvIdx, setAutoIvIdx] = useState(1); // default 5s
  const [showPicker, setShowPicker] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const pillRef        = useRef<HTMLDivElement>(null);
  const longPressRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Why: ref prevents stale closure in the ESC handler without adding dismissing to deps.
  const dismissRef   = useRef<() => void>(() => {});
  dismissRef.current = () => {
    if (dismissing) return;
    setDismissing(true);
    // Why: 480ms matches the full dismiss animation (contentFadeOut 0.15s +
    // floatCollapse 0.3s delayed 0.15s = 0.45s). Add 30ms buffer.
    setTimeout(() => { window.api.meeting.closeFloat(); }, 480);
  };
  const autoSecs = AUTO_INTERVALS[autoIvIdx]!;

  useLayoutEffect(() => {
    const el = pillRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height ?? 0;
      if (h > 0) setPillH(h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setExpanding(false), 400);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    window.api.meeting.onCardsUpdated((incoming: Card[]) => {
      setCards(incoming);
      setIdx(0);
      setShowPicker(false);
    });
    window.api.meeting.onCompanyBriefUpdated((brief) => {
      setCompanyBrief(brief);
    });
    return () => {
      window.api.meeting.offCardsUpdated();
      window.api.meeting.offCompanyBriefUpdated();
    };
  }, []);

  // Classic mode: auto-cycle through matched cards
  useEffect(() => {
    if (!autoPlay || cards.length <= 1) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % cards.length), autoSecs * 1000);
    return () => clearInterval(t);
  }, [autoPlay, autoSecs, cards.length]);

  // Why: ESC closes page picker first; second ESC closes the float window.
  // Mirrors Textream's installKeyMonitor() behaviour.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (showPicker) { setShowPicker(false); return; }
      dismissRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showPicker]);

  const card  = cards[idx];
  const total = cards.length;

  function prev() { setIdx((i) => Math.max(0, i - 1)); }
  function next() { setIdx((i) => Math.min(total - 1, i + 1)); }

  // Long-press (500ms) on nav buttons → open page picker; short press → navigate
  function onNavDown() {
    longPressRef.current = setTimeout(() => {
      longPressRef.current = null;
      setShowPicker(true);
    }, LONG_PRESS_MS);
  }
  function onNavUp(dir: 'prev' | 'next') {
    if (!longPressRef.current) return; // long-press already fired
    clearTimeout(longPressRef.current);
    longPressRef.current = null;
    if (dir === 'prev') prev(); else next();
  }

  const diPath = makeDIPath(pillH);

  return (
    <div className="w-full h-full" style={{ background: 'transparent' }}>
      <div>
        <div
          ref={pillRef}
          className="w-full select-none relative"
          style={{
            background: '#000',
            clipPath: diPath,
            transformOrigin: 'top center',
            animation: dismissing
              ? 'floatCollapse 0.3s ease-in 0.15s forwards'
              : expanding ? 'floatExpand 0.35s ease-out forwards' : undefined,
          } as React.CSSProperties}
        >
          {/* Why: key=card?.id re-mounts on card switch triggering fade-in.
              expand delay (0.35s) syncs content appearance with container expand.
              dismiss plays contentFadeOut before container collapses. */}
          <div key={card?.id ?? 'empty'} style={{
            animation: dismissing
              ? 'contentFadeOut 0.15s ease-in forwards'
              : expanding
              ? 'cardFadeIn 0.25s ease-out 0.35s both'
              : 'cardFadeIn 0.15s ease-out',
          }}>

          {showPicker && (
            <div
              className="absolute inset-0 px-3 py-2 overflow-y-auto"
              style={{ background: 'rgba(10,10,10,0.98)', zIndex: 20, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            >
              {/* Why: 顶部展示总数, 让用户在挑选时有"共多少张"的上下文。 */}
              <p className="text-[9px] uppercase tracking-wide mb-1.5 px-1 flex items-center justify-between" style={{ color: 'rgba(255,255,255,0.35)' }}>
                <span>选择卡片</span>
                <span className="tabular-nums">共 {total} 张</span>
              </p>
              {cards.map((c, i) => (
                <button key={c.id} onClick={() => { setIdx(i); setShowPicker(false); }}
                  aria-current={i === idx}
                  className={`w-full text-left px-2 py-1.5 rounded text-[11px] mb-0.5 flex items-center gap-1.5 transition-colors ${FOCUS_RING_LIGHT} ${
                    i === idx ? 'text-yellow-300 bg-white/10' : 'text-white/55 hover:text-white/80 hover:bg-white/5'
                  }`}>
                  <span className="text-[9px] opacity-45 tabular-nums">{i + 1}</span>
                  <span className="flex-1 truncate">{c.title}</span>
                  {/* Why: 当前项用 ✓ 标记, 比单纯变色更易识别。去 emoji: ✓ -> Check */}
                  {i === idx && <Check size={10} className="shrink-0" />}
                </button>
              ))}
            </div>
          )}

          {card ? (
            <div className="px-4 pt-3 pb-3">
              <div className="flex items-center justify-between mb-1.5"
                style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${TYPE_DOT[card.type] ?? 'bg-gray-500'}`} />
                  <span className="text-[10px] font-semibold uppercase tracking-wide truncate"
                    style={{ color: 'rgba(255,255,255,0.45)' }}>
                    {TYPE_LABEL[card.type] ?? card.type}
                  </span>
                  {/* 去 emoji: ★ -> Star(fill), 保留 amber 色 */}
                  {card.isImportant && <Star size={10} weight="fill" className="text-amber-400 shrink-0" />}
                </div>
                <div className="flex items-center gap-0.5 shrink-0">
                  {autoPlay && (
                    <button onClick={() => setAutoIvIdx((i) => (i + 1) % AUTO_INTERVALS.length)}
                      className={`text-[10px] tabular-nums px-1 rounded ${FOCUS_RING_LIGHT}`}
                      title={`每 ${autoSecs} 秒切换 · 点击换间隔`} aria-label={`轮播间隔 ${autoSecs} 秒, 点击切换`}
                      style={{ color: 'rgba(255,255,255,0.5)' }}>{autoSecs}s</button>
                  )}
                  {total > 1 && (
                    // Why: title 写清楚"自动 Ns 轮播/暂停", 比单字"轮播"更直观。
                    <button onClick={() => setAutoPlay((v) => !v)}
                      className={`w-6 h-6 flex items-center justify-center text-xs ${FOCUS_RING_LIGHT}`}
                      style={{ color: autoPlay ? 'rgba(255,220,80,0.95)' : 'rgba(255,255,255,0.55)' }}
                      title={autoPlay ? '暂停自动轮播' : `自动每 ${autoSecs} 秒轮播`}
                      aria-label={autoPlay ? '暂停自动轮播' : `开始自动每 ${autoSecs} 秒轮播`}>
                      {autoPlay ? '⏸' : '▶'}
                    </button>
                  )}
                  {total > 1 && (<>
                    {/* Why: 按钮放大到 w-6 h-6 更易点; 对比度从 0.4 提到 0.65 避免过淡。 */}
                    <button onMouseDown={onNavDown} onMouseUp={() => onNavUp('prev')}
                      onMouseLeave={() => { if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = null; } }}
                      disabled={idx === 0}
                      className={`w-6 h-6 flex items-center justify-center disabled:opacity-30 text-sm ${FOCUS_RING_LIGHT}`}
                      style={{ color: 'rgba(255,255,255,0.65)' }}
                      aria-label="上一张卡片"
                      title={idx > 0 ? `← ${cards[idx - 1]!.title}` : '上一张'}>
                      {/* 去符号: ‹ -> CaretLeft, title 里的 ← 保持不动 */}
                      <CaretLeft size={14} />
                    </button>
                    {/* Dot indicator — each dot is a card; active dot widens to a pill */}
                    <div className="flex items-center gap-[3px]">
                      {cards.map((_, i) => (
                        <button
                          key={i}
                          onClick={() => setIdx(i)}
                          style={{
                            width: i === idx ? 14 : 5,
                            height: 5,
                            borderRadius: 3,
                            background: i === idx ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.25)',
                            transition: 'width 0.2s, background 0.2s',
                            border: 'none',
                            cursor: 'pointer',
                            padding: 0,
                          }}
                          title={cards[i]!.title}
                        />
                      ))}
                    </div>
                    <button onMouseDown={onNavDown} onMouseUp={() => onNavUp('next')}
                      onMouseLeave={() => { if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = null; } }}
                      disabled={idx === total - 1}
                      className={`w-6 h-6 flex items-center justify-center disabled:opacity-30 text-sm ${FOCUS_RING_LIGHT}`}
                      style={{ color: 'rgba(255,255,255,0.65)' }}
                      aria-label="下一张卡片"
                      title={idx < total - 1 ? `${cards[idx + 1]!.title} →` : '下一张'}>
                      {/* 去符号: › -> CaretRight, title 里的 → 保持不动 */}
                      <CaretRight size={14} />
                    </button>
                  </>)}
                  {/* Why: 关闭键放大并把静态对比度提到 0.55(原 opacity-20 过淡难辨)。 */}
                  <button onClick={() => dismissRef.current()}
                    className={`w-6 h-6 flex items-center justify-center text-sm ml-0.5 opacity-55 hover:opacity-100 transition-opacity ${FOCUS_RING_LIGHT}`}
                    style={{ color: 'rgba(255,255,255,0.9)' } as React.CSSProperties}
                    aria-label="关闭浮窗（ESC）" title="关闭（ESC）">×</button>
                </div>
              </div>
              <p className="text-[13px] font-bold leading-snug mb-1 line-clamp-1"
                style={{ color: 'rgba(255,255,255,0.95)' }}>{card.title}</p>
              <p className="text-[11px] leading-relaxed line-clamp-3"
                style={{ color: 'rgba(255,255,255,0.55)' }}>{extractKeySentences(card.details, 2)}</p>
            </div>
          ) : (
            <div className="flex items-center justify-between py-4 px-4">
              <p className="text-[11px]" style={{ color: 'rgba(255,255,255,0.2)' }}>等待匹配…</p>
              <button onClick={() => dismissRef.current()}
                className={`w-6 h-6 flex items-center justify-center text-sm opacity-55 hover:opacity-100 transition-opacity ${FOCUS_RING_LIGHT}`}
                style={{ color: 'rgba(255,255,255,0.9)', WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                aria-label="关闭浮窗（ESC）" title="关闭（ESC）">×</button>
            </div>
          )}

          {companyBrief && (
            <div className="px-4 pb-3">
              <CompanyBriefPanel brief={companyBrief} />
            </div>
          )}
          </div>{/* end content animation wrapper */}
        </div>
      </div>
    </div>
  );
}
