import { createContext, useCallback, useContext, useRef, useState } from 'react';
// 去 emoji 化: 用 Phosphor 图标替换原文本符号 ✓/!/ℹ 和关闭按钮 ✕
import { CheckCircle, WarningCircle, Info, X, type Icon } from '@phosphor-icons/react';

// Lightweight transient-feedback layer. Wrap the app in <ToastProvider> once, then
// call `const { toast } = useToast()` anywhere to show a self-dismissing message.

type ToastVariant = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  title: string;
  variant: ToastVariant;
}

interface ToastOptions {
  variant?: ToastVariant;
  /** ms before auto-dismiss; 0 keeps it until the user closes it. Default 3000. */
  duration?: number;
}

interface ToastApi {
  toast: (title: string, opts?: ToastOptions) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>');
  return ctx;
}

const VARIANT_STYLE: Record<ToastVariant, string> = {
  success: 'bg-green-600 text-white',
  error: 'bg-red-600 text-white',
  info: 'bg-gray-900 text-white',
};

// 去 emoji 化: 改存 Phosphor 组件而非文本符号, 渲染处用局部变量取组件
const VARIANT_ICON: Record<ToastVariant, Icon> = {
  success: CheckCircle,
  error: WarningCircle,
  info: Info,
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const remove = useCallback((id: number) => {
    setItems((list) => list.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback<ToastApi['toast']>(
    (title, opts) => {
      const id = (idRef.current += 1);
      const variant = opts?.variant ?? 'info';
      setItems((list) => [...list, { id, title, variant }]);
      const duration = opts?.duration ?? 3000;
      if (duration > 0) setTimeout(() => remove(id), duration);
    },
    [remove],
  );

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div
        className="fixed top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none"
        role="status"
        aria-live="polite"
      >
        {items.map((t) => {
          // 去 emoji 化: 用局部变量取出对应的 Phosphor 组件再渲染
          const VariantIcon = VARIANT_ICON[t.variant];
          return (
            <div
              key={t.id}
              className={`pointer-events-auto flex items-center gap-2 min-w-[200px] max-w-sm px-4 py-2.5 rounded-xl shadow-lg text-sm ${VARIANT_STYLE[t.variant]}`}
              style={{ animation: 'toastIn 0.2s ease-out' }}
            >
              <span className="shrink-0">
                <VariantIcon size={16} weight="fill" />
              </span>
              <span className="flex-1">{t.title}</span>
              <button
                onClick={() => remove(t.id)}
                aria-label="关闭"
                className="shrink-0 opacity-70 hover:opacity-100 transition-opacity"
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
