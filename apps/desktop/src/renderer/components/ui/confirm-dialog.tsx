import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

// Imperative confirmation dialog. Wrap the app in <ConfirmProvider> once, then:
//   const confirm = useConfirm();
//   if (await confirm({ title: '确认删除？', body: '此操作不可撤销', danger: true })) { ... }
// Resolves true on confirm, false on cancel / Esc / backdrop click.

interface ConfirmOptions {
  title: string;
  body?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within <ConfirmProvider>');
  return ctx;
}

interface DialogState extends ConfirmOptions {
  open: boolean;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<DialogState>({ open: false, title: '' });
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((opts) => {
    setState({ ...opts, open: true });
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const close = useCallback((result: boolean) => {
    setState((s) => ({ ...s, open: false }));
    resolver.current?.(result);
    resolver.current = null;
  }, []);

  useEffect(() => {
    if (!state.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.open, close]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {state.open && (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label={state.title}
        >
          <div className="absolute inset-0 bg-black/30" onClick={() => close(false)} />
          <div
            className="relative bg-white rounded-2xl shadow-xl max-w-sm w-full p-6"
            style={{ animation: 'fadeSlideIn 0.18s ease-out' }}
          >
            <h2 className="font-semibold text-gray-900 mb-1.5">{state.title}</h2>
            {state.body && <p className="text-sm text-gray-500">{state.body}</p>}
            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={() => close(false)}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900 rounded-lg transition-colors"
              >
                {state.cancelText ?? '取消'}
              </button>
              <button
                autoFocus
                onClick={() => close(true)}
                className={`px-4 py-2 text-sm text-white rounded-lg transition-colors ${
                  state.danger ? 'bg-red-600 hover:bg-red-700' : 'bg-gray-900 hover:bg-gray-700'
                }`}
              >
                {state.confirmText ?? '确定'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
