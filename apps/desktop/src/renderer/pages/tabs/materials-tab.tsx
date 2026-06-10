import { useEffect, useRef, useState } from 'react';
import type { Material, Project, LlmConfigPublic } from '../../env.js';
import LlmSetupModal from '../../components/llm-setup-modal.js';
import { useOfflineDaysLeft } from '../../store/auth-store.js';
// 复用共享原语: toast 反馈 / 二次确认 / a11y 类常量, 避免自造
import { useToast } from '../../components/ui/toast.js';
import { useConfirm } from '../../components/ui/confirm-dialog.js';
import { FOCUS_RING, FOCUS_RING_LIGHT, DISABLED } from '../../lib/ui.js';
// 去 emoji 化: 用 Phosphor glyph 替换原 emoji 图标
import {
  GithubLogo, FileZip, FileText, LinkSimple, Note, Notebook, Buildings,
  ChatCircleText, Lightbulb, Check, ClipboardText, FolderSimple,
  ArrowsClockwise, Sparkle, type Icon,
} from '@phosphor-icons/react';

// 改存 Phosphor 组件而非 emoji 字符, 渲染处取组件再 <Icon size={16}/>
const TYPE_ICON: Record<Material['type'], Icon> = {
  github_url: GithubLogo, zip: FileZip, file: FileText, url: LinkSimple, text: Note, company_url: Buildings, obsidian: Notebook,
};

const SUGGESTIONS: Array<{
  icon: Icon;
  title: string;
  desc: string;
  types: Material['type'][];
  category?: Material['category'];
}> = [
  { icon: GithubLogo, title: 'GitHub 仓库 URL', desc: 'AI 可直接读代码，提取技术决策与实现细节', types: ['github_url'] },
  { icon: FileZip, title: 'ZIP 压缩包', desc: '私有仓库或离线代码，打包上传', types: ['zip'] },
  { icon: FileText, title: 'README / 项目文档', desc: '快速建立项目全貌：技术栈、功能范围、架构说明', types: ['file'] },
  { icon: ChatCircleText, title: '与 AI 的对话记录', desc: '思考过程、踩坑经历和决策背景，是最被低估的素材', types: ['text'] },
  { icon: Buildings, title: '会议方背景', desc: '对方主页/介绍/新闻/产品，AI 生成结构化 brief 供会议参考', types: ['company_url'], category: 'company' },
  { icon: LinkSimple, title: '个人网站 / 主页链接', desc: '补充项目列表和过往工作经历概览', types: ['url'] },
];

function UploadChecklist({ uploadedTypes, uploadedCategories, isEmpty, isProfile }: { uploadedTypes: Set<Material['type']>; uploadedCategories: Set<Material['category']>; isEmpty: boolean; isProfile: boolean }) {
  // Personal corpus suggests personal materials; an application suggests company intel.
  const items = SUGGESTIONS.filter((s) => (isProfile ? s.category !== 'company' : s.category === 'company'));
  const checkedCount = items.filter((s) =>
    s.category ? uploadedCategories.has(s.category) : s.types.some((t) => uploadedTypes.has(t))
  ).length;
  return (
    <div className={`rounded-2xl border transition-all ${isEmpty ? 'border-blue-100 bg-blue-50/60 p-5' : 'border-gray-100 bg-gray-50 p-4'}`}>
      <div className="flex items-center justify-between mb-3">
        {/* 💡 改 Lightbulb, 图标紧邻文字: inline-flex 对齐 */}
        <p className={`inline-flex items-center gap-1.5 font-medium ${isEmpty ? 'text-blue-800 text-sm' : 'text-gray-600 text-xs'}`}>
          <Lightbulb size={16} weight="regular" />建议上传的素材
        </p>
        {!isEmpty && (
          <span className="text-xs text-gray-400">{checkedCount} / {items.length} 已覆盖</span>
        )}
      </div>
      {/* 2 列网格：在更宽的容器里填满宽度，避免每行右侧大量留白(移动端回退单列)。 */}
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
        {items.map((s) => {
          const done = s.category ? uploadedCategories.has(s.category) : s.types.some((t) => uploadedTypes.has(t));
          return (
            <li key={s.title} className="flex items-start gap-2.5">
              {/* ✓ 改 Check: done 时绿底白勾, 未 done 时空心圆点 */}
              <span className={`mt-0.5 w-4 h-4 shrink-0 rounded-full flex items-center justify-center ${done ? 'bg-green-500 text-white' : 'border border-gray-300'}`}>
                {done && <Check size={10} weight="regular" />}
              </span>
              <div className={done ? 'opacity-50' : ''}>
                {/* 素材类型图标改 Phosphor 组件, inline-flex 与文字对齐 */}
                <p className={`inline-flex items-center gap-1.5 text-sm font-medium leading-tight ${isEmpty ? 'text-gray-800' : 'text-gray-700'}`}>
                  {(() => { const Ic = s.icon; return <Ic size={18} weight="regular" />; })()} {s.title}
                </p>
                <p className="text-xs text-gray-400 mt-0.5 leading-snug">{s.desc}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function formatBytes(n: number | null): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(d: Date): string {
  const diff = Date.now() - new Date(d).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  return `${Math.floor(m / 60)} 小时前`;
}

function CompanyBriefPreview({ brief }: { brief: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = brief.slice(0, 120).replace(/#+\s*/g, '').replace(/\n/g, ' ');
  return (
    <div className="mt-2 rounded-xl bg-blue-50/60 border border-blue-100 px-3 py-2.5 text-xs">
      <button
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className={`flex items-center gap-1 text-blue-600 font-medium w-full text-left rounded ${FOCUS_RING_LIGHT}`}
      >
        {/* 📋 改 ClipboardText, inline-flex 与文字对齐 */}
        <span className="inline-flex items-center gap-1.5"><ClipboardText size={14} weight="regular" />公司 brief 已生成</span>
        {/* 统一用 ▼ 字符, 靠 transition-transform 旋转表达展开/收起, 不引动画依赖 */}
        <span className={`ml-auto inline-block transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}>▼</span>
      </button>
      {expanded ? (
        <div className="mt-2 text-gray-700 whitespace-pre-wrap leading-relaxed">{brief}</div>
      ) : (
        <p className="mt-1 text-gray-500 line-clamp-2">{preview}…</p>
      )}
    </div>
  );
}

interface Props {
  projectId: string;
  onExtractStart: () => void;
  onExtract: (cards: import('../../env.js').Card[]) => void;
  onExtractError: (msg: string) => void;
}

type InputMode = 'none' | 'url' | 'text' | 'company';

export default function MaterialsTab({ projectId, onExtractStart, onExtract, onExtractError }: Props) {
  // 统一用共享 toast/confirm 反馈, 替代静默操作与裸 window.confirm
  const { toast } = useToast();
  const confirm = useConfirm();
  const offlineDaysLeft = useOfflineDaysLeft();
  const isOfflineReadonly = offlineDaysLeft === 0;
  const [list, setList] = useState<Material[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [briefLoading, setBriefLoading] = useState(false);
  const [progressMsg, setProgressMsg] = useState('');
  const [error, setError] = useState('');
  const [mode, setMode] = useState<InputMode>('none');
  const [urlInput, setUrlInput] = useState('');
  const [companyInput, setCompanyInput] = useState('');
  const [textInput, setTextInput] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [llmConfig, setLlmConfig] = useState<LlmConfigPublic | null>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    Promise.all([
      window.api.materials.list(projectId),
      window.api.projects.get(projectId),
      window.api.settings.getLlmConfig(),
    ]).then(([mats, proj, cfg]) => {
      setList(mats);
      setProject(proj);
      setLlmConfig(cfg);
      setLoading(false);
    });
    window.api.materials.onProgress((msg) => setProgressMsg(msg));
    window.api.projects.onCompanyBriefUpdated(({ companyName, brief }) => {
      setProject((prev) => prev ? { ...prev, companyName, companyBrief: brief, companyBriefGeneratedAt: new Date() } : prev);
    });
    return () => {
      window.api.materials.offProgress();
      window.api.projects.offCompanyBriefUpdated();
    };
  }, [projectId]);

  // successMsg: 添加成功后的 toast 文案; 失败统一 toast(error) 并保留红条
  async function wrap(fn: () => Promise<Material | Material[]>, successMsg?: string) {
    setBusy(true); setError(''); setProgressMsg('');
    try {
      const result = await fn();
      const added = Array.isArray(result) ? result : [result];
      setList((prev) => [...added, ...prev]);
      if (successMsg) toast(successMsg, { variant: 'success' });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '操作失败';
      if (msg !== '已取消') { setError(msg); toast(msg, { variant: 'error' }); }
    } finally {
      setBusy(false); setProgressMsg('');
    }
  }

  async function handleCancel() {
    await window.api.materials.cancel();
  }

  async function handleCompanySubmit() {
    const url = companyInput.trim();
    if (!url) return;
    await wrap(() => window.api.materials.addCompanyUrl(projectId, url), '已添加会议方背景');
    setCompanyInput(''); setMode('none');
  }

  async function handleUrlSubmit() {
    if (!urlInput.trim()) return;
    const url = urlInput.trim();
    const isGithub = url.includes('github.com');
    await wrap(() => isGithub
      ? window.api.materials.addGithubUrl(projectId, url)
      : window.api.materials.addUrl(projectId, url), '已添加素材');
    setUrlInput(''); setMode('none');
  }

  async function handleTextSubmit() {
    if (textInput.trim().length < 10) { setError('请输入至少 10 个字符'); return; }
    await wrap(() => window.api.materials.addText(projectId, textInput), '已添加素材');
    setTextInput(''); setMode('none');
  }

  async function handlePickFiles() {
    await wrap(() => window.api.materials.pickFiles(projectId), '已添加素材');
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault(); setDragOver(false);
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => (f as { path?: string }).path)
      .filter((p): p is string => Boolean(p));
    if (paths.length === 0) return;
    await wrap(() => window.api.materials.addDroppedFiles(projectId, paths), '已添加素材');
  }

  async function handleDelete(id: string) {
    // 删除不可撤销, 先二次确认再调 IPC, 成功后 toast 反馈
    if (!(await confirm({ title: '删除这条素材?', body: '此操作不可撤销', danger: true }))) return;
    try {
      await window.api.materials.delete(id);
      setList((prev) => prev.filter((m) => m.id !== id));
      toast('已删除素材', { variant: 'success' });
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : '删除失败', { variant: 'error' });
    }
  }

  async function handleRegenerateBrief() {
    setBriefLoading(true); setError('');
    try {
      const { companyName, brief } = await window.api.projects.regenerateCompanyBrief(projectId);
      setProject((prev) => prev ? { ...prev, companyName, companyBrief: brief, companyBriefGeneratedAt: new Date() } : prev);
      toast('公司 brief 已重新生成', { variant: 'success' });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '生成失败';
      setError(msg); toast(msg, { variant: 'error' });
    } finally {
      setBriefLoading(false);
    }
  }

  async function handleExtract() {
    if (!llmConfig?.hasKey) { setShowSetup(true); return; }
    setError(''); setSubmitting(true);
    onExtractStart();
    try {
      const cards = await window.api.cards.extract(projectId);
      onExtract(cards);
    } catch (e: unknown) {
      onExtractError(e instanceof Error ? e.message : '提取失败');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSetupSave(provider: string, apiKey: string, model?: string) {
    await window.api.settings.setLlmConfig(provider, apiKey, model);
    const cfg = await window.api.settings.getLlmConfig();
    setLlmConfig(cfg);
    setShowSetup(false);
    await handleExtract();
  }

  const projectMats = list.filter((m) => m.category === 'project');
  const companyMats = list.filter((m) => m.category === 'company');
  // Personal corpus (资料库) vs a job application — drives which upload affordances show.
  const isProfile = !!project?.isProfile;

  return (
    <div className="flex flex-col gap-6">
      {showSetup && (
        <LlmSetupModal
          current={llmConfig}
          onSave={handleSetupSave}
          onClose={() => setShowSetup(false)}
        />
      )}
      {/* Drop zone */}
      <div
        ref={dropRef}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`border-2 border-dashed rounded-2xl p-8 text-center transition-colors ${dragOver ? 'border-gray-400 bg-gray-50' : 'border-gray-200'}`}
      >
        <p className="text-gray-400 text-sm mb-4">
          {isProfile ? '拖入个人资料 / 项目代码 / 文档，或选择上传方式' : '拖入会议方资料（议程 / 介绍 / 新闻），或选择上传方式'}
        </p>
        <div className="flex flex-wrap gap-2 justify-center">
          {/* Personal corpus: code/files/repo. Application: company intel only. */}
          {isProfile && (
            <button onClick={handlePickFiles} disabled={busy}
              className={`px-4 py-2 bg-gray-900 text-white text-sm rounded-lg hover:bg-gray-700 transition-colors ${DISABLED} ${FOCUS_RING}`}>
              选择文件 / ZIP
            </button>
          )}
          {!isProfile && (
            <button onClick={() => setMode(mode === 'company' ? 'none' : 'company')} disabled={busy}
              className={`inline-flex items-center justify-center gap-2 px-4 py-2 bg-gray-900 text-white text-sm rounded-lg hover:bg-gray-700 transition-colors ${DISABLED} ${FOCUS_RING}`}>
              {/* 🏢 改 Buildings */}
              <Buildings size={16} weight="regular" />会议方背景
            </button>
          )}
          {isProfile && (
            <button onClick={() => setMode(mode === 'url' ? 'none' : 'url')} disabled={busy}
              className={`px-4 py-2 border border-gray-300 text-gray-700 text-sm rounded-lg hover:bg-gray-50 transition-colors ${DISABLED} ${FOCUS_RING}`}>
              粘贴 URL / GitHub
            </button>
          )}
          <button onClick={() => setMode(mode === 'text' ? 'none' : 'text')} disabled={busy}
            className={`px-4 py-2 border border-gray-300 text-gray-700 text-sm rounded-lg hover:bg-gray-50 transition-colors ${DISABLED} ${FOCUS_RING}`}>
            粘贴文本
          </button>
        </div>
      </div>

      {/* Company URL input */}
      {mode === 'company' && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-gray-500 px-1">贴公司主页、文化页、新闻、产品介绍 URL，可多次添加。AI 提取卡片时同步生成公司 brief。</p>
          <div className="flex gap-2">
            <input
              autoFocus
              type="text"
              value={companyInput}
              onChange={(e) => setCompanyInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCompanySubmit()}
              placeholder="https://www.anthropic.com"
              className={`flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 ${FOCUS_RING}`}
            />
            <button onClick={handleCompanySubmit} disabled={busy || !companyInput.trim()}
              className={`px-4 py-2 bg-gray-900 text-white text-sm rounded-lg ${DISABLED} ${FOCUS_RING}`}>
              {busy ? '检测中…' : '添加'}
            </button>
            <button onClick={() => { setMode('none'); setCompanyInput(''); }} className={`px-3 py-2 text-gray-400 text-sm hover:text-gray-700 rounded-lg ${FOCUS_RING}`}>取消</button>
          </div>
        </div>
      )}

      {/* URL input */}
      {mode === 'url' && (
        <div className="flex gap-2">
          <input
            autoFocus
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleUrlSubmit()}
            placeholder="https://github.com/owner/repo 或任意网页 URL"
            className={`flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 ${FOCUS_RING}`}
          />
          <button onClick={handleUrlSubmit} disabled={busy || !urlInput.trim()}
            className={`px-4 py-2 bg-gray-900 text-white text-sm rounded-lg ${DISABLED} ${FOCUS_RING}`}>
            {busy ? '…' : '添加'}
          </button>
          <button onClick={() => { setMode('none'); setUrlInput(''); }} className={`px-3 py-2 text-gray-400 text-sm hover:text-gray-700 rounded-lg ${FOCUS_RING}`}>取消</button>
        </div>
      )}

      {/* Text paste input */}
      {mode === 'text' && (() => {
        // 实时字数, 不足 10 字禁用提交并提示, 让最小长度要求所见即所得
        const trimmedLen = textInput.trim().length;
        const tooShort = trimmedLen < 10;
        return (
        <div className="flex flex-col gap-2">
          <textarea
            autoFocus
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            rows={6}
            placeholder={isProfile ? '粘贴你的项目描述、ChatGPT 对话、README 或任意文本内容…' : '粘贴议程、对方介绍、新闻要点等会议相关文本…'}
            className={`w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 resize-none ${FOCUS_RING}`}
          />
          <div className="flex items-center gap-2 justify-end">
            <span className={`mr-auto text-xs ${tooShort ? 'text-gray-400' : 'text-green-600'}`}>
              {tooShort ? `${trimmedLen}/10 字，至少 10 个字符` : `${trimmedLen} 字`}
            </span>
            <button onClick={() => { setMode('none'); setTextInput(''); }} className={`px-3 py-2 text-gray-400 text-sm hover:text-gray-700 rounded-lg ${FOCUS_RING}`}>取消</button>
            <button onClick={handleTextSubmit} disabled={busy || tooShort}
              className={`px-4 py-2 bg-gray-900 text-white text-sm rounded-lg ${DISABLED} ${FOCUS_RING}`}>
              {busy ? '添加中…' : '添加'}
            </button>
          </div>
        </div>
        );
      })()}

      {/* Upload progress bar */}
      {busy && progressMsg && (
        <div className="flex items-center gap-3 bg-gray-50 border border-gray-200 rounded-xl px-4 py-3">
          <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin shrink-0" />
          <p className="text-sm text-gray-600 flex-1 truncate">{progressMsg}</p>
          <button
            onClick={handleCancel}
            className={`text-xs text-gray-400 hover:text-red-600 shrink-0 transition-colors rounded ${FOCUS_RING}`}
          >
            取消
          </button>
        </div>
      )}

      {/* 错误提示用 role=alert aria-live 让屏幕阅读器即时播报 */}
      {error && <p role="alert" aria-live="polite" className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>}

      {/* Upload guidance checklist */}
      {!loading && (
        <UploadChecklist
          uploadedTypes={new Set(list.map((m) => m.type))}
          uploadedCategories={new Set(list.map((m) => m.category))}
          isEmpty={list.length === 0}
          isProfile={isProfile}
        />
      )}

      {/* Material list — grouped */}
      {!loading && list.length > 0 && (
        <div className="flex flex-col gap-4">
          {/* Project materials */}
          {projectMats.length > 0 && (
            <div>
              {/* 📁 改 FolderSimple, inline-flex 与文字对齐 */}
              <p className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-700 mb-3"><FolderSimple size={14} weight="regular" />项目素材 ({projectMats.length})</p>
              <div className="space-y-2">
                {projectMats.map((m) => {
                  // TYPE_ICON 现在存的是 Phosphor 组件, 取出后渲染
                  const TypeIcon = TYPE_ICON[m.type];
                  return (
                  <div key={m.id} className="flex items-center justify-between bg-white border border-gray-100 rounded-xl px-4 py-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <TypeIcon size={20} weight="regular" className="text-gray-500 shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm text-gray-900 truncate">{m.sourceRef ?? m.type}</p>
                        <p className="text-xs text-gray-400">{formatTime(m.uploadedAt)}{m.fileSize ? `  ·  ${formatBytes(m.fileSize)}` : ''}</p>
                      </div>
                    </div>
                    <button onClick={() => handleDelete(m.id)} className={`text-xs text-gray-300 hover:text-red-500 ml-4 shrink-0 transition-colors rounded ${FOCUS_RING}`}>删除</button>
                  </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Company materials */}
          {companyMats.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-3">
                {/* 🏢 改 Buildings, inline-flex 与文字对齐 */}
                <p className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-700">
                  <Buildings size={14} weight="regular" />会议方背景 ({companyMats.length}){project?.companyName ? ` · ${project.companyName}` : ''}
                </p>
                <button
                  onClick={handleRegenerateBrief}
                  disabled={briefLoading || busy}
                  className={`inline-flex items-center justify-center gap-1.5 text-xs text-blue-500 hover:text-blue-700 transition-colors rounded ${DISABLED} ${FOCUS_RING}`}
                >
                  {/* 🔄 改 ArrowsClockwise, 生成中旋转 */}
                  {briefLoading ? '生成中…' : <><ArrowsClockwise size={14} weight="regular" />重新生成 brief</>}
                </button>
              </div>
              <div className="space-y-2">
                {companyMats.map((m) => {
                  const parenIdx = m.sourceRef?.lastIndexOf(' (') ?? -1;
                  const companyName = parenIdx > 0 ? m.sourceRef!.slice(0, parenIdx) : m.sourceRef ?? '';
                  const domain = parenIdx > 0 ? m.sourceRef!.slice(parenIdx + 2, -1) : '';
                  // TYPE_ICON 现在存的是 Phosphor 组件, 取出后渲染
                  const TypeIcon = TYPE_ICON[m.type];
                  return (
                    <div key={m.id} className="flex items-center justify-between bg-white border border-gray-100 rounded-xl px-4 py-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <TypeIcon size={20} weight="regular" className="text-gray-500 shrink-0" />
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-gray-900 truncate">{companyName || m.sourceRef}</p>
                          {domain && <p className="text-xs text-gray-400 truncate">{domain}</p>}
                          <p className="text-xs text-gray-400">{formatTime(m.uploadedAt)}</p>
                        </div>
                      </div>
                      <button onClick={() => handleDelete(m.id)} className={`text-xs text-gray-300 hover:text-red-500 ml-4 shrink-0 transition-colors rounded ${FOCUS_RING}`}>删除</button>
                    </div>
                  );
                })}
              </div>
              {project?.companyBrief && <CompanyBriefPreview brief={project.companyBrief} />}
            </div>
          )}
        </div>
      )}

      {/* CTA */}
      {list.length > 0 && (
        <div className="pt-2 flex flex-col gap-2">
          <button onClick={handleExtract} disabled={submitting || isOfflineReadonly}
            title={isOfflineReadonly ? '离线验证已超期，请联网后重启应用' : undefined}
            className={`inline-flex items-center justify-center gap-2 w-full py-3 bg-gray-900 text-white rounded-xl font-medium hover:bg-gray-700 transition-colors ${DISABLED} ${FOCUS_RING}`}>
            {/* 🪄 改 Sparkle */}
            <Sparkle size={16} weight="regular" />提取卡片
          </button>
          {llmConfig?.hasKey && (
            <button onClick={() => setShowSetup(true)} className={`text-xs text-gray-400 hover:text-gray-600 text-center rounded ${FOCUS_RING}`}>
              当前：{llmConfig.provider} · 更换 API Key
            </button>
          )}
        </div>
      )}
    </div>
  );
}
