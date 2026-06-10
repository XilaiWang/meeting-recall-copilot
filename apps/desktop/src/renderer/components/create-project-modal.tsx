import { useState, useEffect, useRef } from 'react';
import { X } from '@phosphor-icons/react';
import Spinner from './ui/spinner.js';
import { FOCUS_RING, DISABLED } from '../lib/ui.js';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreate: (project: { name: string; targetRole: string; jdText?: string }) => Promise<void>;
}

export default function CreateProjectModal({ open, onClose, onCreate }: Props) {
  const [name, setName] = useState('');
  const [targetRole, setTargetRole] = useState('');
  const [jdText, setJdText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  // Why: 记录字段是否被用户编辑过，只有「碰过且不合法」才提示，避免一打开就报红。
  const [touched, setTouched] = useState({ name: false, targetRole: false });
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName(''); setTargetRole(''); setJdText(''); setError('');
      setTouched({ name: false, targetRole: false });
      setTimeout(() => nameRef.current?.focus(), 50);
    }
  }, [open]);

  // Why: Esc 关闭是 Modal 的标准交互预期；提交中不允许误关丢失输入。
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !submitting) onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, submitting, onClose]);

  const nameValid = name.trim().length >= 1 && name.trim().length <= 50;
  const roleValid = targetRole.trim().length >= 2 && targetRole.trim().length <= 80;
  const valid = nameValid && roleValid;
  // Why: 仅在用户编辑过该字段后才展示校验提示，输入合法则不显示。
  const nameError = touched.name && !nameValid ? '项目名称需 1-50 字' : '';
  const roleError = touched.targetRole && !roleValid ? '会议主题至少 2 字' : '';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true); setError('');
    try {
      await onCreate({ name: name.trim(), targetRole: targetRole.trim(), jdText: jdText.trim() || undefined });
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '创建失败，请重试');
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => { if (!submitting) onClose(); }}>
      {/* Why: 复用全局 fadeSlideIn keyframe 做入场动画，与 confirm-dialog 视觉一致。 */}
      <div
        className="relative bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 p-6"
        style={{ animation: 'fadeSlideIn 0.18s ease-out' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold mb-5">创建新项目</h2>
        {/* Why: 右上角显式关闭入口，纯图标按钮需 aria-label。 */}
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          aria-label="关闭"
          className={`absolute top-4 right-4 p-1.5 text-gray-400 rounded-lg hover:bg-gray-100 hover:text-gray-600 transition-colors ${FOCUS_RING} ${DISABLED}`}
        >
          {/* 关闭图标：手绘 SVG 换成 Phosphor X glyph */}
          <X size={16} />
        </button>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              项目名称 <span className="text-red-500">*</span>
            </label>
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, name: true }))}
              maxLength={50}
              placeholder="产品技术评审会（按会议主题命名）"
              className={`w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 ${FOCUS_RING} ${nameError ? 'border-red-400' : 'border-gray-300'}`}
            />
            {nameError
              ? <p className="text-xs text-red-600 mt-1" role="alert" aria-live="polite">{nameError}</p>
              : <p className="text-xs text-gray-400 mt-1 text-right">{name.length}/50</p>}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              会议主题名称 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={targetRole}
              onChange={(e) => setTargetRole(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, targetRole: true }))}
              maxLength={80}
              placeholder="技术方案评审 · 客户沟通"
              className={`w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 ${FOCUS_RING} ${roleError ? 'border-red-400' : 'border-gray-300'}`}
            />
            {roleError
              ? <p className="text-xs text-red-600 mt-1" role="alert" aria-live="polite">{roleError}</p>
              : <p className="text-xs text-gray-400 mt-1">会议主题 / 场景，简短填写</p>}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              背景资料 <span className="text-gray-400 font-normal">（可选）</span>
            </label>
            {/* Why: 让用户明白背景资料的用途——填了 AI 提取时会匹配会议背景，卡片更精准。 */}
            <p className="text-xs text-gray-400 mb-1.5">可选：粘贴会议议程或背景，AI 提取时会匹配会议背景，卡片更精准</p>
            <textarea
              value={jdText}
              onChange={(e) => setJdText(e.target.value)}
              rows={4}
              placeholder="粘贴会议议程或背景资料，AI 提取卡片时会优先匹配会议关注的内容…"
              className={`w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 ${FOCUS_RING} resize-none`}
            />
          </div>

          {error && (
            <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg" role="alert" aria-live="polite">{error}</p>
          )}

          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose} disabled={submitting}
              className={`flex-1 py-2.5 border border-gray-200 text-gray-600 rounded-lg text-sm hover:bg-gray-50 transition-colors ${FOCUS_RING} ${DISABLED}`}>
              取消
            </button>
            {/* Why: 提交中显示 Spinner 并禁用，防重复提交；DISABLED 取代低对比的 opacity-40。 */}
            <button type="submit" disabled={!valid || submitting}
              className={`flex-1 py-2.5 bg-gray-900 text-white rounded-lg text-sm font-medium hover:bg-gray-700 transition-colors inline-flex items-center justify-center gap-2 ${FOCUS_RING} ${DISABLED}`}>
              {submitting && <Spinner className="w-4 h-4" />}
              {submitting ? '创建中…' : '创建项目'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
