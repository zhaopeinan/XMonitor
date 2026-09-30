import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作：确认按钮用红色 */
  danger?: boolean;
}

type ConfirmFn = (options: ConfirmOptions | string) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<ConfirmOptions>({ message: '' });
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const close = useCallback((value: boolean) => {
    setOpen(false);
    resolver.current?.(value);
    resolver.current = null;
  }, []);

  const confirm = useCallback<ConfirmFn>((input) => {
    const next: ConfirmOptions = typeof input === 'string' ? { message: input } : input;
    setOpts(next);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const value = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {open && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/30 px-4"
          onClick={() => close(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="xm-confirm-title"
            aria-describedby="xm-confirm-desc"
          >
            <h3 id="xm-confirm-title" className="text-sm font-semibold text-slate-900">
              {opts.title ?? '请确认'}
            </h3>
            <p id="xm-confirm-desc" className="mt-2 whitespace-pre-line text-sm leading-relaxed text-slate-600">
              {opts.message}
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => close(false)}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-600 transition-colors hover:bg-slate-50"
              >
                {opts.cancelText ?? '取消'}
              </button>
              <button
                type="button"
                onClick={() => close(true)}
                autoFocus
                className={`rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors ${
                  opts.danger
                    ? 'bg-rose-600 hover:bg-rose-500'
                    : 'bg-slate-900 hover:bg-slate-700'
                }`}
              >
                {opts.confirmText ?? '确定'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmContext);
  if (!fn) {
    throw new Error('useConfirm 必须在 ConfirmProvider 内使用');
  }
  return fn;
}
