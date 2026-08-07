import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { focusRing } from './styles';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface DialogProps {
  open: boolean;
  /** Called for Esc, overlay click and the close button. */
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  /** Footer content — usually buttons, right aligned. */
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Hide the corner close button (a confirm dialog with two buttons). */
  hideCloseButton?: boolean;
  /** Ignore clicks on the backdrop. Esc still closes. */
  disableOverlayClose?: boolean;
  /** Ignore Esc too. Use only for a dialog mid-destructive-operation. */
  disableEscapeClose?: boolean;
  className?: string;
  children?: ReactNode;
}

const SIZES: Record<NonNullable<DialogProps['size']>, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
};

/**
 * Modal dialog.
 *
 * Does the four things a modal has to do and usually does not:
 *  - traps Tab inside the panel while open,
 *  - moves focus in on open and back to the trigger on close,
 *  - closes on Esc,
 *  - marks the rest of the app inert to assistive tech via `aria-modal`.
 *
 * Rendered into `document.body` with a portal so it is never clipped by a
 * scroll container.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  footer,
  size = 'md',
  hideCloseButton = false,
  disableOverlayClose = false,
  disableEscapeClose = false,
  className,
  children,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const reactId = useId();
  const titleId = `${reactId}-title`;
  const descriptionId = `${reactId}-description`;

  // Remember what had focus, and give focus to the panel.
  useEffect(() => {
    if (!open) return undefined;
    previouslyFocused.current =
      (document.activeElement as HTMLElement | null) ?? null;

    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();

    return () => {
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  // Lock body scroll behind the modal.
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape' && !disableEscapeClose) {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((element) => element.offsetParent !== null);
      if (items.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose, disableEscapeClose],
  );

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    // The overlay is a click target, not a control; the dialog inside owns
    // keyboard interaction, which is why the handler lives on the panel wrapper.
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-6 pt-[10vh]"
      onKeyDown={onKeyDown}
      role="presentation"
    >
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={disableOverlayClose ? undefined : onClose}
        className="fixed inset-0 cursor-default bg-zinc-950/40 backdrop-blur-[1px] dark:bg-zinc-950/70"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cn(
          'relative w-full rounded-xl border border-zinc-200 bg-white shadow-2xl outline-none',
          'dark:border-zinc-800 dark:bg-zinc-900',
          SIZES[size],
          className,
        )}
      >
        {(title || !hideCloseButton) && (
          <div className="flex items-start justify-between gap-4 px-5 pb-3 pt-4">
            <div className="min-w-0">
              {title ? (
                <h2
                  id={titleId}
                  className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-100"
                >
                  {title}
                </h2>
              ) : null}
              {description ? (
                <p
                  id={descriptionId}
                  className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400"
                >
                  {description}
                </p>
              ) : null}
            </div>
            {hideCloseButton ? null : (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close dialog"
                className={cn(
                  '-mr-1 -mt-0.5 shrink-0 rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700',
                  'dark:hover:bg-zinc-800 dark:hover:text-zinc-200',
                  focusRing,
                )}
              >
                <X size={15} aria-hidden="true" />
              </button>
            )}
          </div>
        )}

        {children ? (
          <div className="px-5 pb-4 text-[13px] leading-relaxed text-zinc-700 dark:text-zinc-300">
            {children}
          </div>
        ) : null}

        {footer ? (
          <div className="flex items-center justify-end gap-2 rounded-b-xl border-t border-zinc-200 bg-zinc-50 px-5 py-3 dark:border-zinc-800 dark:bg-zinc-900/60">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

export default Dialog;
