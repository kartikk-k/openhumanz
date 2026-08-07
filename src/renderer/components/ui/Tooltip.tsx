import {
  cloneElement,
  isValidElement,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { cn } from '../../lib/utils';

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipProps {
  /** The tooltip text. When empty the trigger renders untouched. */
  content: ReactNode;
  side?: TooltipSide;
  /** Hover delay in ms. Focus always shows it immediately. */
  delayMs?: number;
  className?: string;
  /** A single focusable element. */
  children: ReactNode;
}

const SIDES: Record<TooltipSide, string> = {
  top: 'bottom-full left-1/2 -translate-x-1/2 mb-1.5',
  bottom: 'top-full left-1/2 -translate-x-1/2 mt-1.5',
  left: 'right-full top-1/2 -translate-y-1/2 mr-1.5',
  right: 'left-full top-1/2 -translate-y-1/2 ml-1.5',
};

/**
 * Text tooltip on hover and on keyboard focus.
 *
 * Positioned with plain CSS relative to a wrapper, not a portal — the app's
 * layout has no clipping ancestors around interactive controls, and a portal
 * would cost a positioning engine we do not need. Never put anything
 * interactive inside: the content is wired up with `aria-describedby`, so it is
 * announced as a description, not visited as content.
 */
export function Tooltip({
  content,
  side = 'top',
  delayMs = 250,
  className,
  children,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();

  if (!content) {
    return (
      <span className={cn('relative inline-flex', className)}>{children}</span>
    );
  }

  const show = (immediate = false) => {
    if (timer.current) clearTimeout(timer.current);
    if (immediate || delayMs === 0) {
      setOpen(true);
      return;
    }
    timer.current = setTimeout(() => setOpen(true), delayMs);
  };

  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
  };

  const trigger = isValidElement(children)
    ? cloneElement(children as ReactElement<{ 'aria-describedby'?: string }>, {
        'aria-describedby': open ? id : undefined,
      })
    : children;

  return (
    <span
      className={cn('relative inline-flex', className)}
      onMouseEnter={() => show()}
      onMouseLeave={hide}
      onFocus={() => show(true)}
      onBlur={hide}
    >
      {trigger}
      {open ? (
        <span
          role="tooltip"
          id={id}
          className={cn(
            'pointer-events-none absolute z-50 max-w-xs whitespace-normal rounded-md px-2 py-1 text-[11px] font-medium leading-snug shadow-lg',
            'bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900',
            SIDES[side],
          )}
        >
          {content}
        </span>
      ) : null}
    </span>
  );
}

export default Tooltip;
