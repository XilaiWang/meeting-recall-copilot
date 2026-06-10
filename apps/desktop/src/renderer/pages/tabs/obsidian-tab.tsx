import { useEffect, useState } from 'react';
// 复用共享 toast 反馈 + a11y 类常量, 与素材页保持一致
import { useToast } from '../../components/ui/toast.js';
import { FOCUS_RING, DISABLED } from '../../lib/ui.js';
import { FolderOpen, Notebook, Warning } from '@phosphor-icons/react';
import type { ObsidianScanResult, ObsidianNoteStatus } from '../../env.js';

interface Props {
  projectId: string;
  onImported: () => void;
}

// Why: above this many notes a full extract burns a lot of LLM tokens; warn first.
const MANY_NOTES = 200;

const STATUS_BADGE: Record<ObsidianNoteStatus, { label: string; cls: string }> = {
  new: { label: '新增', cls: 'text-green-700 bg-green-50 border-green-200' },
  changed: { label: '已修改', cls: 'text-amber-700 bg-amber-50 border-amber-200' },
  unchanged: { label: '未变更', cls: 'text-gray-400 bg-gray-50 border-gray-200' },
};

const ROOT_FOLDER_LABEL = '根目录';

export default function ObsidianTab({ projectId, onImported }: Props) {
  const { toast } = useToast();
  const [vaultPath, setVaultPath] = useState('');
  const [scan, setScan] = useState<ObsidianScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progressMsg, setProgressMsg] = useState('');
  const [error, setError] = useState('');

  // Filters. selectedFolders defaults to ALL folders (membership required);
  // selectedTags defaults to empty (= no tag filter). onlyChanged hides notes
  // already imported and unchanged since.
  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(new Set());
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [onlyChanged, setOnlyChanged] = useState(true);

  // Why: initialize filters from a fresh scan — select every folder, clear tag
  // filter, so the default selection imports the whole (new/changed) vault.
  function applyScan(result: ObsidianScanResult) {
    setScan(result);
    setSelectedFolders(new Set(result.folders.map((f) => f.name)));
    setSelectedTags(new Set());
    setOnlyChanged(result.unchangedCount > 0 ? true : false);
  }

  // Why: reuse the main process material:progress stream (shared with uploads);
  // also pre-fill the last-used vault and try to rescan it on mount.
  useEffect(() => {
    window.api.materials.onProgress((msg) => setProgressMsg(msg));
    void window.api.settings.getObsidianConfig().then(async (cfg) => {
      if (!cfg?.lastVaultPath) return;
      setVaultPath(cfg.lastVaultPath);
      setScanning(true);
      try {
        applyScan(await window.api.materials.scanObsidianVault(cfg.lastVaultPath, projectId));
      } catch {
        /* 上次的 vault 路径可能已失效, 静默忽略 */
      } finally {
        setScanning(false);
      }
    });
    return () => { window.api.materials.offProgress(); };
  }, [projectId]);

  async function runScan(path: string) {
    setScanning(true); setError(''); setScan(null);
    try {
      const result = await window.api.materials.scanObsidianVault(path, projectId);
      applyScan(result);
      if (result.count === 0) setError('这个文件夹里没有找到 .md 笔记，确认它是 Obsidian vault 根目录？');
    } catch (e) {
      setError(e instanceof Error ? e.message : '扫描失败');
    } finally {
      setScanning(false);
    }
  }

  async function handlePick() {
    const path = await window.api.materials.pickObsidianVault();
    if (!path) return;
    setVaultPath(path);
    await runScan(path);
  }

  function toggle(set: Set<string>, key: string): Set<string> {
    const next = new Set(set);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  }

  // Filtered subset honoring folder/tag selection + the "only new/changed" toggle.
  const filtered = (scan?.notes ?? []).filter((n) =>
    selectedFolders.has(n.folder) &&
    (selectedTags.size === 0 || n.tags.some((t) => selectedTags.has(t))) &&
    (!onlyChanged || n.status !== 'unchanged'),
  );

  async function handleImport() {
    if (!vaultPath || filtered.length === 0) return;
    setBusy(true); setError(''); setProgressMsg('');
    try {
      const added = await window.api.materials.addObsidian(projectId, vaultPath, filtered.map((n) => n.relPath));
      await window.api.settings.setObsidianConfig({ lastVaultPath: vaultPath });
      toast(`已导入 ${added.length} 篇 Obsidian 笔记`, { variant: 'success' });
      onImported();
    } catch (e) {
      const msg = e instanceof Error ? e.message : '导入失败';
      if (msg !== '已取消') { setError(msg); toast(msg, { variant: 'error' }); }
    } finally {
      setBusy(false); setProgressMsg('');
    }
  }

  function handleCancel() { void window.api.materials.cancel(); }

  const folderLabel = (name: string) => (name === '' ? ROOT_FOLDER_LABEL : name);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="inline-flex items-center gap-2 text-lg font-semibold text-gray-900">
          <Notebook size={20} weight="regular" />从 Obsidian 导入笔记
        </h2>
        <p className="text-sm text-gray-400 mt-1">
          选择一个 Obsidian vault 文件夹，自动读取 .md 笔记、清洗掉双链 / 嵌入 / 注释后导入为素材，再到「卡片库」提取卡片。重复导入会跳过未变更的笔记。
        </p>
      </div>

      <div className="flex gap-2 items-center">
        <button onClick={handlePick} disabled={busy || scanning}
          className={`inline-flex items-center gap-2 px-4 py-2 bg-gray-900 text-white text-sm rounded-lg hover:bg-gray-700 transition-colors ${DISABLED} ${FOCUS_RING}`}>
          <FolderOpen size={16} weight="regular" />选择 Vault 文件夹
        </button>
        {vaultPath && <span className="text-xs text-gray-500 truncate flex-1" title={vaultPath}>{vaultPath}</span>}
      </div>

      {scanning && <p className="text-sm text-gray-500">正在扫描笔记…</p>}

      {scan && scan.count > 0 && !busy && (
        <div className="rounded-xl border border-gray-200 p-4 flex flex-col gap-3">
          {/* 概览 + 增量分解 */}
          <p className="text-sm text-gray-700">
            扫描到 <span className="font-semibold">{scan.count}</span> 篇笔记
            <span className="text-gray-400">（已排除 .obsidian / 附件 / 隐藏文件）</span>
          </p>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="px-2 py-0.5 rounded-full border text-green-700 bg-green-50 border-green-200">新增 {scan.newCount}</span>
            <span className="px-2 py-0.5 rounded-full border text-amber-700 bg-amber-50 border-amber-200">已修改 {scan.changedCount}</span>
            <span className="px-2 py-0.5 rounded-full border text-gray-400 bg-gray-50 border-gray-200">已导入未变更 {scan.unchangedCount}</span>
          </div>

          {scan.count > MANY_NOTES && (
            <p className="inline-flex items-start gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <Warning size={14} weight="fill" className="mt-0.5 shrink-0" />
              笔记较多，全量提取卡片会消耗较多 token / 费用，确认无误再导入。
            </p>
          )}

          {/* 仅新增/修改 开关 */}
          {scan.unchangedCount > 0 && (
            <label className="inline-flex items-center gap-2 text-xs text-gray-600 cursor-pointer select-none">
              <input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)}
                className="rounded border-gray-300" />
              仅导入新增 / 修改的笔记（跳过 {scan.unchangedCount} 篇未变更）
            </label>
          )}

          {/* 文件夹过滤（多于一个顶层文件夹时显示） */}
          {scan.folders.length > 1 && (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs text-gray-500 font-medium">按文件夹</p>
              <div className="flex flex-wrap gap-1.5">
                {scan.folders.map((f) => {
                  const on = selectedFolders.has(f.name);
                  return (
                    <button key={f.name || '__root__'} onClick={() => setSelectedFolders((s) => toggle(s, f.name))}
                      className={`px-2 py-0.5 rounded-full border text-xs transition-colors ${FOCUS_RING} ${on ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-200 text-gray-500 hover:border-gray-400'}`}>
                      {folderLabel(f.name)} <span className={on ? 'text-gray-300' : 'text-gray-400'}>{f.count}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* 标签过滤（有 frontmatter 标签时显示；不选 = 不限） */}
          {scan.tags.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs text-gray-500 font-medium">按标签 <span className="text-gray-300">（不选 = 全部）</span></p>
              <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
                {scan.tags.map((t) => {
                  const on = selectedTags.has(t.name);
                  return (
                    <button key={t.name} onClick={() => setSelectedTags((s) => toggle(s, t.name))}
                      className={`px-2 py-0.5 rounded-full border text-xs transition-colors ${FOCUS_RING} ${on ? 'border-indigo-500 bg-indigo-500 text-white' : 'border-gray-200 text-gray-500 hover:border-gray-400'}`}>
                      #{t.name} <span className={on ? 'text-indigo-200' : 'text-gray-400'}>{t.count}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* 过滤后的笔记列表 */}
          <ul className="max-h-48 overflow-y-auto text-xs text-gray-500 flex flex-col gap-1 border-t border-gray-100 pt-2">
            {filtered.slice(0, 100).map((n) => (
              <li key={n.relPath} className="flex items-center justify-between gap-3">
                <span className="truncate flex-1">{n.relPath}</span>
                <span className={`shrink-0 px-1.5 py-px rounded border text-[10px] ${STATUS_BADGE[n.status].cls}`}>{STATUS_BADGE[n.status].label}</span>
                <span className="shrink-0 text-gray-300 w-12 text-right">{n.sizeKB} KB</span>
              </li>
            ))}
            {filtered.length > 100 && <li className="text-gray-300">…以及另外 {filtered.length - 100} 篇</li>}
            {filtered.length === 0 && <li className="text-gray-400">当前筛选没有匹配的笔记</li>}
          </ul>

          <button onClick={handleImport} disabled={busy || filtered.length === 0}
            className={`self-start px-4 py-2 bg-gray-900 text-white text-sm rounded-lg ${DISABLED} ${FOCUS_RING}`}>
            导入 {filtered.length} 篇
          </button>
        </div>
      )}

      {busy && (
        <div className="flex items-center gap-3 bg-gray-50 border border-gray-200 rounded-xl px-4 py-3">
          <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin shrink-0" />
          <p className="text-sm text-gray-600 flex-1 truncate">{progressMsg || '正在导入…'}</p>
          <button onClick={handleCancel} className={`text-xs text-gray-400 hover:text-red-600 shrink-0 transition-colors rounded ${FOCUS_RING}`}>取消</button>
        </div>
      )}

      {error && <p role="alert" aria-live="polite" className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
    </div>
  );
}
