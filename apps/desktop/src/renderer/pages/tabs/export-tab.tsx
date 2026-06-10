import { useEffect, useState } from 'react';
// 去 emoji 化: 用 Phosphor 图标替换文本 emoji
import { FileText, Star, DownloadSimple, Check, Notebook } from '@phosphor-icons/react';
import { useOfflineDaysLeft } from '../../store/auth-store.js';
import { useToast } from '../../components/ui/toast.js';
import { FOCUS_RING, DISABLED } from '../../lib/ui.js';
import CountUp from '../../components/ui/reactbits/count-up.js';

// Why: 离线超期文案集中一处, 让禁用 title 与按钮下方红字说明保持一致, 避免分叉。
const OFFLINE_READONLY_MSG = '离线验证已超期，请联网后重启应用';

interface Props {
  projectId: string;
}

type Range = 'auto' | 'all' | 'important';

const RANGE_LABELS: Record<Range, string> = {
  auto: '自动（推荐）',
  all: '全部',
  important: '仅重要',
};

export default function ExportTab({ projectId }: Props) {
  const offlineDaysLeft = useOfflineDaysLeft();
  const isOfflineReadonly = offlineDaysLeft === 0;
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [counts, setCounts] = useState<{ auto: number; all: number; important: number } | null>(null);
  const [range, setRange] = useState<Range>('auto');

  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedPath, setSavedPath] = useState('');

  const [generatingPdf, setGeneratingPdf] = useState(false);
  const [pdfSavedPath, setPdfSavedPath] = useState('');
  const [pdfError, setPdfError] = useState('');

  const [exportingObsidian, setExportingObsidian] = useState(false);
  const [obsidianFolder, setObsidianFolder] = useState('');
  const [obsidianError, setObsidianError] = useState('');

  useEffect(() => {
    setLoading(true);
    window.api.export.cardCounts(projectId)
      .then((c) => setCounts(c))
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    setSavedPath('');
    setCopied(false);
    setPdfSavedPath('');
    setPdfError('');
    setObsidianFolder('');
    setObsidianError('');
  }, [range]);

  async function handleCopy() {
    await window.api.export.copyClipboard(projectId, range);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleSave() {
    setSaving(true);
    setSavedPath('');
    try {
      const path = await window.api.export.saveFile(projectId, range);
      // Why: 保存成功改用自动消失的 toast 反馈, inline 路径提示仅作短暂确认(下方定时清除)。
      if (path) {
        setSavedPath(path);
        toast('Markdown 已保存', { variant: 'success' });
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleGeneratePdf() {
    setGeneratingPdf(true);
    setPdfSavedPath('');
    setPdfError('');
    try {
      const path = await window.api.export.generatePdf(projectId, 'modern', range);
      // Why: PDF 保存成功同样用 toast 反馈, 取代常驻 inline 成功提示。
      if (path) {
        setPdfSavedPath(path);
        toast('PDF 已保存', { variant: 'success' });
      }
    } catch (e: unknown) {
      setPdfError(e instanceof Error ? e.message : 'PDF 生成失败');
    } finally {
      setGeneratingPdf(false);
    }
  }

  async function handleExportObsidian() {
    setExportingObsidian(true);
    setObsidianFolder('');
    setObsidianError('');
    try {
      const res = await window.api.export.exportObsidian(projectId, range);
      if (res) {
        setObsidianFolder(res.folder);
        toast(`已导出 ${res.count} 张卡片到 Obsidian`, { variant: 'success' });
      }
    } catch (e: unknown) {
      setObsidianError(e instanceof Error ? e.message : 'Obsidian 导出失败');
    } finally {
      setExportingObsidian(false);
    }
  }

  // Why: 成功路径提示不应常驻; 5 秒后自动清除, 与 toast 协同作短暂确认。
  useEffect(() => {
    if (!savedPath) return;
    const t = setTimeout(() => setSavedPath(''), 5000);
    return () => clearTimeout(t);
  }, [savedPath]);

  useEffect(() => {
    if (!obsidianFolder) return;
    const t = setTimeout(() => setObsidianFolder(''), 8000);
    return () => clearTimeout(t);
  }, [obsidianFolder]);

  useEffect(() => {
    if (!pdfSavedPath) return;
    const t = setTimeout(() => setPdfSavedPath(''), 5000);
    return () => clearTimeout(t);
  }, [pdfSavedPath]);

  if (loading) {
    return <div className="flex items-center justify-center py-16 text-gray-400 text-sm">加载中…</div>;
  }

  if (!counts || counts.all === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
        {/* 去 emoji 化: 📄 -> FileText 空态大图 */}
        <FileText size={40} className="text-gray-300" />
        <p className="text-gray-500 text-sm">没有卡片可导出</p>
        <p className="text-gray-400 text-xs">请先在「素材」tab 提取卡片，再来导出</p>
      </div>
    );
  }

  const selectedCount = counts[range];

  return (
    <div className="flex flex-col gap-5">

      {/* Range selector — shared by both export types */}
      <div>
        <p className="text-xs text-gray-500 mb-2 font-medium">卡片范围</p>
        <div className="flex gap-2 flex-wrap">
          {(['auto', 'all', 'important'] as Range[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-3 py-1.5 rounded-lg border text-sm transition-all ${FOCUS_RING} ${
                range === r
                  ? 'border-gray-900 bg-gray-900 text-white'
                  : 'border-gray-200 text-gray-600 hover:border-gray-400'
              }`}
            >
              {RANGE_LABELS[r]}
              <span className={`ml-1 text-xs ${range === r ? 'text-gray-300' : 'text-gray-400'}`}>(<CountUp to={counts[r]} duration={0.5} />)</span>
            </button>
          ))}
        </div>
        {/* 去 emoji 化: ★ -> Star(fill, 行内) 保留 amber 色 */}
        {range === 'important' && counts.important === 0 && (
          <p className="text-xs text-amber-600 mt-1.5 inline-flex items-center gap-1.5">
            还没有标记重要的卡片，请先在卡片库里标记
            <Star size={14} weight="fill" className="text-amber-500 inline" />
          </p>
        )}
      </div>

      {/* ── PDF 导出 ── */}
      <div className="border border-gray-100 rounded-2xl overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2.5 bg-gray-50 border-b border-gray-100">
          {/* 去 emoji 化: 📥 -> DownloadSimple, 容器 inline-flex 对齐 */}
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-600"><DownloadSimple size={14} />导出为 PDF</span>
        </div>
        <div className="p-5 flex flex-col gap-3">
          <button
            onClick={() => { void handleGeneratePdf(); }}
            disabled={generatingPdf || selectedCount === 0 || isOfflineReadonly}
            title={isOfflineReadonly ? OFFLINE_READONLY_MSG : undefined}
            className={`w-full py-2.5 bg-gray-900 text-white text-sm font-medium rounded-xl hover:bg-gray-700 transition-colors ${DISABLED} ${FOCUS_RING}`}
          >
            {generatingPdf ? '生成中…' : `下载 PDF（${selectedCount} 张卡片）`}
          </button>
          {/* Why: 离线超期时按钮被禁用, 显式渲染红字说明原因, 不依赖 hover title。 */}
          {isOfflineReadonly && (
            <p className="text-xs text-red-600" role="alert" aria-live="polite">{OFFLINE_READONLY_MSG}</p>
          )}
          {pdfSavedPath && (
            /* 去 emoji 化: ✓ -> Check(绿色), 容器 inline-flex 对齐 */
            <p className="inline-flex items-center gap-1.5 text-xs text-green-600 bg-green-50 px-3 py-2 rounded-lg truncate"><Check size={14} className="text-green-600 shrink-0" /><span className="truncate">已保存到 {pdfSavedPath}</span></p>
          )}
          {pdfError && (
            /* Why: 失败提示加 role=alert 让读屏播报, 并提供重试按钮重新触发同一操作。 */
            <div className="flex items-center justify-between gap-2 text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg" role="alert" aria-live="polite">
              <span className="flex-1">{pdfError}</span>
              <button
                onClick={() => { void handleGeneratePdf(); }}
                disabled={generatingPdf || selectedCount === 0 || isOfflineReadonly}
                className={`shrink-0 px-2 py-0.5 rounded-md border border-red-300 text-red-700 hover:bg-red-100 transition-colors ${DISABLED} ${FOCUS_RING}`}
              >
                重试
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Markdown 备忘录 ── */}
      <div className="border border-gray-100 rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50 border-b border-gray-100">
          <span className="text-xs font-medium text-gray-600">Markdown 备忘录</span>
          <div className="flex gap-2">
            <button
              onClick={() => { void handleCopy(); }}
              disabled={selectedCount === 0}
              className={`inline-flex items-center justify-center gap-1.5 px-3 py-1 text-xs rounded-lg border transition-all ${DISABLED} ${FOCUS_RING} ${
                copied ? 'border-green-400 text-green-600 bg-green-50' : 'border-gray-300 text-gray-600 hover:bg-white'
              }`}
            >
              {/* 去 emoji 化: ✓ -> Check(绿色), 复制成功态显示图标 */}
              {copied ? (<><Check size={14} className="text-green-600" />已复制</>) : '复制'}
            </button>
            <button
              onClick={() => { void handleSave(); }}
              disabled={saving || selectedCount === 0}
              className={`px-3 py-1 text-xs rounded-lg border border-gray-300 text-gray-600 hover:bg-white transition-colors ${DISABLED} ${FOCUS_RING}`}
            >
              {saving ? '保存中…' : '保存文件'}
            </button>
          </div>
        </div>
        <div className="px-5 py-4">
          <p className="text-sm text-gray-500">
            将导出 <span className="font-semibold text-gray-800"><CountUp to={selectedCount} duration={0.5} /></span> 张卡片的 Markdown 备忘录
          </p>
        </div>
        {savedPath && (
          /* 去 emoji 化: ✓ -> Check(绿色), 容器 inline-flex 对齐 */
          <p className="flex items-center gap-1.5 text-xs text-green-600 bg-green-50 px-4 py-2 border-t border-gray-100 truncate"><Check size={14} className="text-green-600 shrink-0" /><span className="truncate">已保存到 {savedPath}</span></p>
        )}
      </div>

      {/* ── 导出到 Obsidian ── */}
      <div className="border border-gray-100 rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50 border-b border-gray-100">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-600"><Notebook size={14} />导出到 Obsidian</span>
          <button
            onClick={() => { void handleExportObsidian(); }}
            disabled={exportingObsidian || selectedCount === 0}
            className={`px-3 py-1 text-xs rounded-lg border border-gray-300 text-gray-600 hover:bg-white transition-colors ${DISABLED} ${FOCUS_RING}`}
          >
            {exportingObsidian ? '导出中…' : '选择 Vault 并导出'}
          </button>
        </div>
        <div className="px-5 py-4">
          <p className="text-sm text-gray-500">
            把 <span className="font-semibold text-gray-800"><CountUp to={selectedCount} duration={0.5} /></span> 张卡片写入所选 vault 的
            <span className="font-mono text-xs text-gray-600 mx-1">QA Matching/{'{'}项目名{'}'}/</span>
            子文件夹（每张一篇 .md + 索引，含类型 / 重要 / 标签 frontmatter）。仅新增不删除你的其他笔记。
          </p>
        </div>
        {obsidianFolder && (
          <p className="flex items-center gap-1.5 text-xs text-green-600 bg-green-50 px-4 py-2 border-t border-gray-100 truncate"><Check size={14} className="text-green-600 shrink-0" /><span className="truncate">已导出到 {obsidianFolder}</span></p>
        )}
        {obsidianError && (
          <div className="flex items-center justify-between gap-2 text-xs text-red-600 bg-red-50 px-4 py-2 border-t border-gray-100" role="alert" aria-live="polite">
            <span className="flex-1">{obsidianError}</span>
            <button
              onClick={() => { void handleExportObsidian(); }}
              disabled={exportingObsidian || selectedCount === 0}
              className={`shrink-0 px-2 py-0.5 rounded-md border border-red-300 text-red-700 hover:bg-red-100 transition-colors ${DISABLED} ${FOCUS_RING}`}
            >
              重试
            </button>
          </div>
        )}
      </div>

    </div>
  );
}
