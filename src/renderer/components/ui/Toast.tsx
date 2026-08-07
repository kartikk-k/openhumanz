import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  X,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { TONE_TEXT, type Tone } from '../../lib/tone';
import { focusRing } from './styles';
import { useToastStore, type ToastItem } from '../../store/toastStore';

const ICONS: Record<Tone, LucideIcon> = {
  neutral: Info,
  accent: Info,
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
};

function ToastRow({
  item,
  onDismiss,
}: {
  item: ToastItem;
  onDismiss: (id: string) => void;
}) {
  const Icon = ICONS[item.tone];

  useEffect(() => {
    if (!item.durationMs) return undefined;
    const timer = setTimeout(() => onDismiss(item.id), item.durationMs);
    return () => clearTimeout(timer);
  }, [item.id, item.durationMs, onDismiss]);

  return (
    <div
      className={cn(
        'pointer-events-auto flex w-80 items-start gap-2.5 rounded-lg border px-3 py-2.5 shadow-lg',
        'border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-800',
      )}
    >
      <Icon
        size={15}
        aria-hidden="true"
        className={cn('mt-px shrink-0', TONE_TEXT[item.tone])}
      />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-zinc-900 dark:text-zinc-100">
          {item.title}
        </p>
        {item.description ? (
          <p className="mt-0.5 break-words text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
            {item.description}
          </p>
        ) : null}
        {item.action ? (
          <button
            type="button"
            onClick={() => {
              item.action?.onClick();
              onDismiss(item.id);
            }}
            className={cn(
              'mt-1.5 rounded text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400',
              focusRing,
            )}
          >
            {item.action.label}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(item.id)}
        aria-label="Dismiss notification"
        className={cn(
          'shrink-0 rounded p-0.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-200',
          focusRing,
        )}
      >
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * Renders the toast stack. Mount once, near the root.
 *
 * `aria-live="polite"` so a screen reader announces new toasts without
 * interrupting; the region exists even when empty, which is what makes live
 * announcements actually fire.
 */
export function Toaster() {
  const toasts = useToastStore((state) => state.toasts);
  const dismiss = useToastStore((state) => state.dismiss);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col items-end gap-2"
      role="region"
      aria-label="Notifications"
    >
      <div aria-live="polite" aria-atomic="false" className="flex flex-col gap-2">
        {toasts.map((item) => (
          <ToastRow key={item.id} item={item} onDismiss={dismiss} />
        ))}
      </div>
    </div>,
    document.body,
  );
}

export default Toaster;
