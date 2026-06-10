import { useState } from 'react';
import { SealCheck } from '@phosphor-icons/react';
import { useToast } from './ui/toast.js';
import { FOCUS_RING, DISABLED } from '../lib/ui.js';

interface Props {
  projectId: string;
  onClose: () => void;
}

const OUTCOME_OPTIONS = [
  { value: 'went_well',         label: '会议进展顺利' },
  { value: 'needs_followup',    label: '需要跟进' },
  { value: 'no_progress',       label: '暂无进展' },
  { value: 'prefer_not_to_say', label: '不便透露' },
] as const;

const HELPFUL_OPTIONS = [
  { value: 'used_helpful',     label: '用了，有帮助' },
  { value: 'used_not_helpful', label: '用了，没啥用' },
  { value: 'not_used',         label: '没用上' },
] as const;

const WILL_USE_OPTIONS = [
  { value: 'definitely', label: '一定用' },
  { value: 'maybe',      label: '可能用' },
  { value: 'depends',    label: '看情况' },
  { value: 'no',         label: '不会用' },
] as const;

// Why: freeText 上限抽常量,字数计数与 textarea maxLength 共用单一来源避免漂移。
const FREE_TEXT_MAX = 500;

type Outcome     = typeof OUTCOME_OPTIONS[number]['value'];
type CardHelpful = typeof HELPFUL_OPTIONS[number]['value'];
type WillUse     = typeof WILL_USE_OPTIONS[number]['value'];

export default function SurveyModal({ projectId, onClose }: Props) {
  const [outcome,     setOutcome]     = useState<Outcome | ''>('');
  const [cardHelpful, setCardHelpful] = useState<CardHelpful | ''>('');
  const [willUse,     setWillUse]     = useState<WillUse | ''>('');
  const [company,     setCompany]     = useState('');
  const [freeText,    setFreeText]    = useState('');
  const [submitting,  setSubmitting]  = useState(false);
  const [submitted,   setSubmitted]   = useState(false);
  const { toast } = useToast();

  const canSubmit = outcome !== '' && cardHelpful !== '' && willUse !== '';

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    const today = new Date().toISOString().slice(0, 10);
    try {
      await window.api.survey.submit({
        projectId,
        meetingDate: today,
        outcome: outcome as Outcome,
        cardHelpful: cardHelpful as CardHelpful,
        willUseNext: willUse as WillUse,
        companyName: company.trim() || undefined,
        freeText: freeText.trim() || undefined,
      });
      // Why: 复用共享 toast 给出即时成功反馈,提交后随即切到致谢页。
      toast('反馈已提交', { variant: 'success' });
      setSubmitted(true);
    } catch {
      // Non-critical — close on error so survey failure never blocks the user.
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-8 flex flex-col items-center gap-4">
          {/* 去 emoji: 致谢页大图标改 Phosphor SealCheck,绿色对勾印章传达"已收到/完成" */}
          <SealCheck size={48} className="text-green-600" weight="regular" />
          <h2 className="text-lg font-semibold text-gray-900">感谢反馈！</h2>
          <p className="text-sm text-gray-500 text-center">你的回答帮助我们持续改进产品。</p>
          <button
            onClick={onClose}
            className={`mt-2 px-6 py-2 bg-gray-900 text-white text-sm rounded-lg hover:bg-gray-700 transition-colors ${FOCUS_RING}`}
          >
            关闭
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6 flex flex-col gap-5 max-h-[90vh] overflow-y-auto">
        <div>
          {/* 去 emoji 化规范: 用户可见的 em-dash 改逗号 */}
          <h2 className="text-lg font-semibold text-gray-900">会议结束，快速复盘</h2>
          <p className="text-sm text-gray-500 mt-1">只需 30 秒，帮助我们改进产品</p>
        </div>

        {/* 会议进展 */}
        <Field label="这次会议进展如何？" required>
          <div className="grid grid-cols-2 gap-2">
            {OUTCOME_OPTIONS.map((o) => (
              <ToggleBtn
                key={o.value}
                active={outcome === o.value}
                onClick={() => setOutcome(o.value)}
              >
                {o.label}
              </ToggleBtn>
            ))}
          </div>
        </Field>

        {/* 卡片帮助情况 */}
        <Field label="记忆卡片有没有帮上忙？" required>
          <div className="flex flex-col gap-2">
            {HELPFUL_OPTIONS.map((o) => (
              <ToggleBtn
                key={o.value}
                active={cardHelpful === o.value}
                onClick={() => setCardHelpful(o.value)}
              >
                {o.label}
              </ToggleBtn>
            ))}
          </div>
        </Field>

        {/* 下次是否继续用 */}
        <Field label="下次开会还会用吗？" required>
          <div className="grid grid-cols-2 gap-2">
            {WILL_USE_OPTIONS.map((o) => (
              <ToggleBtn
                key={o.value}
                active={willUse === o.value}
                onClick={() => setWillUse(o.value)}
              >
                {o.label}
              </ToggleBtn>
            ))}
          </div>
        </Field>

        {/* 公司（可选） */}
        <Field label="会议涉及的公司（可选）" hint="仅保存哈希值，不存明文">
          <input
            type="text"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            placeholder="如：Google、字节跳动…"
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gray-300"
          />
        </Field>

        {/* 感想（可选） */}
        <Field label="有什么想说的？（可选）">
          <textarea
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            placeholder="任何反馈都欢迎…"
            rows={2}
            maxLength={FREE_TEXT_MAX}
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:ring-gray-300"
          />
          {/* Why: 实时字数反馈,接近上限(≥90%)转 amber 提醒用户即将触顶。 */}
          <span
            className={`self-end text-xs tabular-nums ${
              freeText.length >= FREE_TEXT_MAX * 0.9 ? 'text-amber-500' : 'text-gray-400'
            }`}
            aria-live="polite"
          >
            {freeText.length}/{FREE_TEXT_MAX}
          </span>
        </Field>

        <div className="flex gap-2 justify-end pt-1">
          {/* Why: "跳过" 易误触致数据丢失,改文案为"取消"并降权,与主 CTA 明确区分。 */}
          <button
            onClick={onClose}
            className={`px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors ${FOCUS_RING} rounded-lg`}
          >
            取消
          </button>
          <button
            onClick={() => { void handleSubmit(); }}
            disabled={!canSubmit || submitting}
            // Why: 必填项未填完时禁用并给 title 提示,DISABLED 替代 opacity-40 以达 WCAG AA 对比。
            title={!canSubmit ? '请填完所有必填项' : undefined}
            className={`px-5 py-2 bg-gray-900 text-white text-sm rounded-lg hover:bg-gray-700 transition-colors ${DISABLED} ${FOCUS_RING}`}
          >
            {submitting ? '提交中…' : '提交反馈'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, required, children }: { label: string; hint?: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-medium text-gray-700">
          {label}
          {/* Why: 必填字段 label 后加红色星号,提交前让用户一眼识别哪些必答。 */}
          {required && <span className="text-red-500 ml-0.5" aria-label="必填">*</span>}
        </span>
        {hint && <span className="text-xs text-gray-400">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function ToggleBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      // Why: 选项按钮追加 FOCUS_RING,键盘可见焦点,满足 a11y 通则。
      className={`px-3 py-2 rounded-lg text-sm border transition-colors text-left ${FOCUS_RING} ${
        active
          ? 'bg-gray-900 text-white border-gray-900'
          : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
      }`}
    >
      {children}
    </button>
  );
}
