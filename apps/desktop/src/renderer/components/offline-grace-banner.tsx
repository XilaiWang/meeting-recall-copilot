import { Lock, Warning } from '@phosphor-icons/react';
import { useOfflineDaysLeft } from '../store/auth-store.js';

// Why: banner is self-contained — it reads from auth-store directly so callers
// just drop <OfflineGraceBanner /> in any layout without prop drilling.
export default function OfflineGraceBanner() {
  const daysLeft = useOfflineDaysLeft();
  if (daysLeft === null) return null;

  const isExpired = daysLeft === 0;
  return (
    // Why: 超期是阻断态(功能已停用)，用 solid red-600 重背景+白字与 amber 离线警告分级，
    // 让用户一眼区分"还能用但要联网" vs "已停用必须联网"；role/aria-live 让屏幕阅读器主动播报。
    <div
      role="alert"
      aria-live="polite"
      className={`px-4 py-2 text-sm flex items-center gap-2 ${
        isExpired
          ? 'bg-red-600 text-white font-semibold border-b border-red-700'
          : 'bg-amber-50 text-amber-700 border-b border-amber-100'
      }`}
    >
      {/* 去 emoji：🔒->Lock、⚠️->Warning；aria-hidden 让图标对屏幕阅读器隐藏，文案承担信息 */}
      <span aria-hidden="true" className="inline-flex items-center justify-center">
        {isExpired ? <Lock size={16} weight="fill" /> : <Warning size={16} weight="fill" />}
      </span>
      {isExpired
        ? '请立即联网并重启应用以验证许可证：当前已超期，提取卡片和导出 PDF 已停用。'
        : `请在 ${daysLeft} 天内联网验证许可证，否则将停用提取卡片和导出 PDF。`}
    </div>
  );
}
