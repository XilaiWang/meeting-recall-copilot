import { useState } from 'react';
// 去 emoji 化: 文本符号图标改用 Phosphor glyph
import { Check, X } from '@phosphor-icons/react';
import type { LlmConfigPublic } from '../env.js';
// Why: 复用共享原语保证 loading/a11y 表现与全应用一致, 不自造。
import Spinner from './ui/spinner.js';
import { FOCUS_RING, DISABLED } from '../lib/ui.js';

interface Props {
  current: LlmConfigPublic | null;
  onSave: (provider: string, apiKey: string, model?: string) => Promise<void>;
  onClose: () => void;
}

// Why: minLen 与 label 集中到一处, 既驱动校验也驱动精确错误文案, 避免两处魔法数走偏。
const PROVIDERS = [
  { value: 'anthropic', label: 'Anthropic (Claude)', placeholder: 'sk-ant-api03-...', prefix: 'sk-ant-', minLen: 80 },
  { value: 'openai',    label: 'OpenAI (GPT)',        placeholder: 'sk-proj-...',      prefix: 'sk-',     minLen: 40 },
  { value: 'deepseek',  label: 'DeepSeek',            placeholder: 'sk-...',           prefix: 'sk-',     minLen: 20 },
  { value: 'qwen',      label: '通义千问 (Qwen)',      placeholder: 'sk-...',           prefix: '',        minLen: 20 },
] as const;

// Why: these thresholds come from observed key lengths. We stay conservative
// (below the true minimum) to avoid blocking valid future key formats.
function validateKeyFormat(provider: string, key: string): string | null {
  const k = key.trim();
  if (!k) return null; // empty handled separately
  const p = PROVIDERS.find((x) => x.value === provider);
  if (!p) return null;
  if (p.prefix && !k.startsWith(p.prefix)) return `${p.label} 的 Key 应以 ${p.prefix} 开头`;
  // Why: 文案带上要求长度与实际长度, 用户一眼能判断是否漏复制。
  if (k.length < p.minLen) return `${p.label} 的 Key 应至少 ${p.minLen} 字符（你填了 ${k.length}）`;
  return null;
}

interface VerifyResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export default function LlmSetupModal({ current, onSave, onClose }: Props) {
  const [provider, setProvider] = useState<string>(current?.provider ?? 'anthropic');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false); // Why: 长 Key 易输错, 允许临时明文核对。
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);

  const ph = PROVIDERS.find((p) => p.value === provider)?.placeholder ?? 'sk-...';
  const formatError = validateKeyFormat(provider, apiKey);
  const hasKey = apiKey.trim().length > 0;
  const canSave = hasKey && !formatError;
  const canVerify = canSave && !verifying;

  function handleProviderChange(v: string) {
    setProvider(v);
    setVerifyResult(null);
  }

  function handleKeyChange(v: string) {
    setApiKey(v);
    setVerifyResult(null);
  }

  async function handleVerify() {
    if (!canVerify) return;
    setVerifying(true);
    setVerifyResult(null);
    try {
      const res = await window.api.settings.verifyApiKey(provider, apiKey.trim());
      setVerifyResult(res);
    } catch {
      setVerifyResult({ ok: false, error: '请求失败，请重试' });
    } finally {
      setVerifying(false);
    }
  }

  async function handleSave() {
    if (!canSave) return;
    setSaving(true); setSaveError('');
    try {
      await onSave(provider, apiKey.trim());
      onClose();
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6 flex flex-col gap-5">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">配置 LLM API Key</h2>
          <p className="text-sm text-gray-500 mt-1">
            AI 提取卡片需要你的 API Key（BYOK）。Key 仅存储在本地。
          </p>
        </div>

        <div className="flex flex-col gap-3">
          {/* Provider selector */}
          <div>
            <label className="text-sm font-medium text-gray-700 mb-1 block">服务商</label>
            <select
              value={provider}
              onChange={(e) => handleProviderChange(e.target.value)}
              className={`w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white ${FOCUS_RING}`}
            >
              {PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>

          {/* API Key input */}
          <div>
            <label className="text-sm font-medium text-gray-700 mb-1 block">API Key</label>
            {/* Why: 相对定位容器, 把显示/隐藏按钮叠在输入框右侧。 */}
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => handleKeyChange(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && canSave && handleSave()}
                placeholder={ph}
                autoFocus
                className={`w-full pl-3 pr-10 py-2 border rounded-lg text-sm font-mono transition-colors ${FOCUS_RING} ${
                  hasKey && formatError ? 'border-red-400' : 'border-gray-300'
                }`}
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                aria-label={showKey ? '隐藏 Key' : '显示 Key'}
                aria-pressed={showKey}
                className={`absolute inset-y-0 right-0 px-3 flex items-center text-xs text-gray-500 hover:text-gray-700 rounded-r-lg ${FOCUS_RING}`}
              >
                {showKey ? '隐藏' : '显示'}
              </button>
            </div>
            {/* Format error */}
            {hasKey && formatError && (
              <p className="text-xs text-red-600 mt-1 flex items-center gap-1" role="alert" aria-live="polite">
                {/* 去 emoji 化: ✕ -> X glyph */}
                <X size={14} />{formatError}
              </p>
            )}
            {/* Legacy key hint: Why: 升级为信息条, 比灰字更易被注意到。 */}
            {current?.hasKey && !hasKey && (
              <p className="text-xs text-blue-700 bg-blue-50 px-2.5 py-1.5 rounded-lg mt-1.5">
                已有配置的 Key，输入新 Key 可覆盖
              </p>
            )}
          </div>

          {/* Connection verify */}
          {canSave && (
            <div className="flex items-center gap-2">
              <button
                onClick={handleVerify}
                disabled={!canVerify}
                className={`text-xs px-3 py-1.5 border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50 transition-colors inline-flex items-center gap-1.5 ${DISABLED} ${FOCUS_RING}`}
              >
                {verifying && <Spinner className="w-3.5 h-3.5" />}
                {verifying ? '验证中…' : '验证连接'}
              </button>
              {/* Why: 预留固定高度, 结果出现/消失时不挤压上下布局造成抖动。 */}
              <div className="h-5 flex items-center" role="status" aria-live="polite">
                {verifyResult && (
                  // 去 emoji 化: ✓/✕ 不能放进模板字符串, 改用 JSX 渲染 Phosphor glyph
                  <span className={`text-xs font-medium inline-flex items-center gap-1 ${verifyResult.ok ? 'text-green-600' : 'text-red-600'}`}>
                    {verifyResult.ok ? (
                      <>
                        <Check size={14} className="text-green-600" />
                        {`连接成功${verifyResult.latencyMs != null ? `（${verifyResult.latencyMs}ms）` : ''}`}
                      </>
                    ) : (
                      <>
                        <X size={14} className="text-red-600" />
                        {verifyResult.error ?? '验证失败'}
                      </>
                    )}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        {saveError && (
          <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg" role="alert" aria-live="polite">{saveError}</p>
        )}

        <div className="flex gap-2 justify-end pt-1">
          <button onClick={onClose} className={`px-4 py-2 text-sm text-gray-500 hover:text-gray-700 rounded-lg ${FOCUS_RING}`}>取消</button>
          <button
            onClick={handleSave}
            disabled={saving || !canSave}
            className={`px-5 py-2 bg-gray-900 text-white text-sm rounded-lg hover:bg-gray-700 transition-colors inline-flex items-center gap-2 ${DISABLED} ${FOCUS_RING}`}
          >
            {saving && <Spinner className="w-4 h-4" />}
            {saving ? '保存中…' : '保存并开始提取'}
          </button>
        </div>
      </div>
    </div>
  );
}
