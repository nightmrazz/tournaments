import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';
import { Button } from './primitives';

/* ---------------------------------------------------------------- Dialog */

/** Accessible modal built on the native <dialog> element (focus trap, Esc to close). */
export function Dialog({ open, onClose, title, description, children, footer, size = 'md' }: {
  open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg';
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      className={cn(
        'm-auto w-[calc(100%-2rem)] rounded-[var(--radius-card)] border border-line-strong bg-surface p-0 text-fg shadow-2xl shadow-black/60',
        { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl' }[size],
      )}
    >
      {open && (
        <div className="animate-fade-in">
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div>
              <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
              {description && <p className="mt-1 text-sm text-muted">{description}</p>}
            </div>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label={t('Close dialog')} className="-mr-2 -mt-1 h-9 w-9"><X className="h-4 w-4" /></Button>
          </div>
          {children && <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>}
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

/* --------------------------------------------------------------- Confirm */

interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
}

const ConfirmContext = createContext<(o: ConfirmOptions) => Promise<boolean>>(async () => false);

/** `const confirm = useConfirm(); if (await confirm({...})) ...` — used for every destructive action. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => setState({ ...o, resolve })), []);
  const close = (v: boolean) => { state?.resolve(v); setState(null); };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        open={!!state}
        onClose={() => close(false)}
        title={<span className="flex items-center gap-2">{state?.destructive && <AlertTriangle className="h-5 w-5 text-danger" aria-hidden />}{state?.title}</span>}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => close(false)}>{t('Cancel')}</Button>
            <Button variant={state?.destructive ? 'danger' : 'primary'} onClick={() => close(true)} autoFocus>{state?.confirmLabel ?? t('Confirm')}</Button>
          </>
        }
      >
        <div className="text-sm text-muted">{state?.body}</div>
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export const useConfirm = () => useContext(ConfirmContext);

/* ----------------------------------------------------------------- Toast */

type ToastTone = 'success' | 'error' | 'info' | 'warning';
interface ToastItem { id: number; tone: ToastTone; message: string }
const ToastContext = createContext<(tone: ToastTone, message: string) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((tone: ToastTone, message: string) => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs.slice(-3), { id, tone, message }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 4000);
  }, []);
  const icon = { success: CheckCircle2, error: XCircle, info: Info, warning: AlertTriangle };
  const color = { success: 'text-success', error: 'text-danger', info: 'text-info', warning: 'text-warning' };
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end">
        {items.map((item) => {
          const Icon = icon[item.tone];
          return (
            <div key={item.id} role={item.tone === 'error' ? 'alert' : 'status'} className="pointer-events-auto flex w-full max-w-sm animate-fade-in items-start gap-3 rounded-[var(--radius-control)] border border-line-strong bg-surface-2 px-4 py-3 text-sm shadow-xl shadow-black/40">
              <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', color[item.tone])} aria-hidden />
              <p className="flex-1">{item.message}</p>
              <button className="text-subtle hover:text-fg" onClick={() => setItems((xs) => xs.filter((x) => x.id !== item.id))} aria-label={t('Dismiss notification')}><X className="h-4 w-4" /></button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/* ------------------------------------------------------------------ Tabs */

export interface TabDef { id: string; label: string; count?: number }

/** WAI-ARIA tabs with arrow-key navigation. Panels are rendered by the caller. */
export function Tabs({ tabs, value, onChange, label }: { tabs: TabDef[]; value: string; onChange: (id: string) => void; label: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = tabs.length - 1;
    if (next >= 0) { e.preventDefault(); onChange(tabs[next].id); refs.current[next]?.focus(); }
  };
  return (
    <div role="tablist" aria-label={label} className="relative -mx-4 flex gap-1 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0 [scrollbar-width:none]">
      {tabs.map((tab, i) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(el) => { refs.current[i] = el; }}
            role="tab"
            id={`tab-${tab.id}`}
            aria-selected={active}
            aria-controls={`panel-${tab.id}`}
            tabIndex={active ? 0 : -1}
            onKeyDown={(e) => onKey(e, i)}
            onClick={() => onChange(tab.id)}
            className={cn(
              'relative flex h-11 shrink-0 items-center gap-2 px-3 text-sm font-medium transition-colors',
              active ? 'text-fg' : 'text-muted hover:text-fg',
            )}
          >
            {tab.label}
            {tab.count !== undefined && <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[11px] tabular text-muted">{tab.count}</span>}
            {active && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full neon-gradient glow-sm" aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ id, children }: { id: string; children: ReactNode }) {
  return <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} tabIndex={0} className="animate-fade-in focus-visible:outline-none">{children}</div>;
}
