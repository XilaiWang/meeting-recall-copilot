import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
// Why: 去 emoji 化, 返回按钮箭头改用 Phosphor 图标库 glyph
import { ArrowLeft } from '@phosphor-icons/react';
import { useProjectStore } from '../store/project-store.js';
import MaterialsTab from './tabs/materials-tab.js';
import CardsTab from './tabs/cards-tab.js';
import ExportTab from './tabs/export-tab.js';
import MeetingTab from './tabs/meeting-tab.js';
import ObsidianTab from './tabs/obsidian-tab.js';
import type { Card, Project } from '../env.js';
import OfflineGraceBanner from '../components/offline-grace-banner.js';
import { FOCUS_RING } from '../lib/ui.js';

type Tab = 'materials' | 'obsidian' | 'cards' | 'meeting' | 'export';

const TABS: { id: Tab; label: string }[] = [
  { id: 'materials', label: '素材' },
  // Why: Obsidian 紧邻「素材」, 它本质是又一种素材来源(笔记→提取)
  { id: 'obsidian', label: 'Obsidian' },
  { id: 'cards', label: '卡片库' },
  // Why: 去掉 emoji 与其余纯文字 tab 对齐, 保持专业一致的标签风格
  { id: 'meeting', label: '会议' },
  { id: 'export', label: '导出' },
];

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  materializing: '上传素材',
  extracting: 'AI 提取中',
  needs_review: '待审核',
  ready: '就绪',
  exported: '已导出',
  archived: '已归档',
};

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const storeProject = useProjectStore((s) => s.projects.find((p) => p.id === id));
  const [fetched, setFetched] = useState<Project | null>(null);
  const [fetchTried, setFetchTried] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>('materials');
  const [cardRefresh, setCardRefresh] = useState(0);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState('');

  // The personal-corpus project is excluded from project:list, so fall back to a
  // direct fetch by id when it isn't in the store.
  useEffect(() => {
    if (storeProject || !id) return;
    let alive = true;
    void window.api.projects.get(id).then((p) => { if (alive) { setFetched(p); setFetchTried(true); } });
    return () => { alive = false; };
  }, [storeProject, id]);

  const project = storeProject ?? fetched;

  if (!project) {
    if (!fetchTried) {
      return (
        <div className="min-h-screen flex items-center justify-center">
          {/* Why: 文案更具体并加 aria-live 让读屏播报加载状态 */}
          <span className="text-gray-400 text-sm" role="status" aria-live="polite">正在加载项目…</span>
        </div>
      );
    }
    return (
      <div className="min-h-screen flex items-center justify-center">
        {/* Why: 文案更口语友好; role=alert 让读屏即时播报未找到 */}
        <div className="text-center" role="alert" aria-live="polite">
          <p className="text-gray-500 mb-4">没有找到这个项目</p>
          <button onClick={() => navigate('/')} className={`text-sm text-gray-900 underline rounded ${FOCUS_RING}`}>返回首页</button>
        </div>
      </div>
    );
  }

  function handleExtractStart() {
    setExtracting(true);
    setExtractError('');
    setActiveTab('cards');
  }

  function handleExtracted(cards: Card[]) {
    setCardRefresh((n) => n + 1);
    setExtracting(false);
    void cards;
  }

  function handleExtractError(msg: string) {
    setExtracting(false);
    setExtractError(msg);
  }

  return (
    // Why: h-screen + overflow-hidden 给整页一个确定的视口高度，使 <main> 被界定、
    // 内部可滚动；否则 min-h-screen 会随内容(如会议转译)向下生长，撑破三栏高度约束。
    <div className="h-screen overflow-hidden bg-gray-50 flex flex-col">
      {/* Why: pl-20 (80px) leaves room for macOS traffic light buttons under titleBarStyle hiddenInset */}
      <header
        className="bg-white border-b border-gray-100 pl-20 pr-6 py-4 flex items-center gap-3 select-none"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <button
          onClick={() => navigate('/')}
          /* Why: 浅背景交互元素追加 FOCUS_RING 满足键盘可达性 a11y 通则; inline-flex 对齐图标与文字 */
          className={`inline-flex items-center gap-1 text-gray-400 hover:text-gray-700 text-sm transition-colors shrink-0 rounded ${FOCUS_RING}`}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {/* Why: 去 emoji 化, ← 改 Phosphor ArrowLeft, 文案保留「返回」 */}
          <ArrowLeft size={16} weight="regular" />
          返回
        </button>
        <span className="text-gray-200">|</span>
        <h1 className="font-semibold text-gray-900 truncate">{project.name}</h1>
        <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full ml-1 shrink-0">
          {STATUS_LABEL[project.status] ?? project.status}
        </span>
      </header>

      {/* Tabs */}
      <div className="bg-white border-b border-gray-100 pl-20 pr-6">
        <div className="flex gap-6">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              /* Why: tab 按钮追加 FOCUS_RING 让键盘用户可见焦点 (浅背景) */
              className={`py-3 text-sm font-medium border-b-2 transition-colors rounded-sm ${FOCUS_RING} ${activeTab === t.id ? 'border-gray-900 text-gray-900' : 'border-transparent text-gray-400 hover:text-gray-600'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <OfflineGraceBanner />

      {/* Why: 全宽填高的 app 壳；各 tab 按内容性质选宽度(表单适中/卡片更宽/会议近全宽且填满高度)，
          替代过去统一的 max-w-3xl(768px) —— 宽窗下不再两侧大留白，会议不再固定 460 留白。
          main 自身可滚动，长内容(卡片库)在此滚动，会议则用 flex-1 填满本区高度。 */}
      <main className="flex-1 min-h-0 w-full px-8 py-6 flex flex-col overflow-y-auto">
        {activeTab === 'materials' && (
          <div className="w-full max-w-4xl mx-auto">
            <MaterialsTab
              projectId={project.id}
              onExtractStart={handleExtractStart}
              onExtract={handleExtracted}
              onExtractError={handleExtractError}
            />
          </div>
        )}
        {activeTab === 'obsidian' && (
          <div className="w-full max-w-4xl mx-auto">
            {/* 导入后切回「素材」让用户看到新增的 obsidian 素材 */}
            <ObsidianTab projectId={project.id} onImported={() => setActiveTab('materials')} />
          </div>
        )}
        {activeTab === 'cards' && (
          <div className="w-full max-w-5xl mx-auto">
            <CardsTab
              projectId={project.id}
              refresh={cardRefresh}
              extracting={extracting}
              extractError={extractError}
            />
          </div>
        )}
        {activeTab === 'meeting' && (
          <div className="w-full max-w-6xl mx-auto flex-1 min-h-0 flex flex-col">
            <MeetingTab projectId={project.id} />
          </div>
        )}
        {activeTab === 'export' && (
          <div className="w-full max-w-4xl mx-auto">
            <ExportTab projectId={project.id} />
          </div>
        )}
      </main>
    </div>
  );
}
