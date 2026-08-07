import { useId, useState, type ReactNode } from 'react';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';
import { focusRingInset } from './styles';

export interface CollapsibleSectionProps {
  title: ReactNode;
  /** Secondary text on the header line — duration, cost, tool name. */
  subtitle?: ReactNode;
  /** Leading icon, usually a status icon. */
  icon?: LucideIcon;
  /** Right-hand metadata: badges, timings. Not click targets. */
  meta?: ReactNode;
  /** Uncontrolled initial state. */
  defaultOpen?: boolean;
  /** Controlled state. Pass with `onOpenChange`. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Removes the border/background — for nesting inside another panel. */
  bare?: boolean;
  /** Tighter header, for deep timelines. */
  density?: 'comfortable' | 'compact';
  className?: string;
  contentClassName?: string;
  children: ReactNode;
}

/**
 * Disclosure row.
 *
 * The run timeline is built out of these — collapsible steps with tool name,
 * arguments, output, duration and cost — so it keeps the header cheap and the
 * body unmounted while closed.
 */
export function CollapsibleSection({
  title,
  subtitle,
  icon: Icon,
  meta,
  defaultOpen = false,
  open,
  onOpenChange,
  bare = false,
  density = 'comfortable',
  className,
  contentClassName,
  children,
}: CollapsibleSectionProps) {
  const [internal, setInternal] = useState(defaultOpen);
  const isOpen = open ?? internal;
  const id = useId();

  const toggle = () => {
    const next = !isOpen;
    if (open === undefined) setInternal(next);
    onOpenChange?.(next);
  };

  return (
    <div
      className={cn(
        'overflow-hidden',
        !bare &&
          'rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900',
        className,
      )}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={isOpen}
        aria-controls={`${id}-content`}
        className={cn(
          'flex w-full items-center gap-2 text-left transition-colors',
          'hover:bg-zinc-50 dark:hover:bg-zinc-800/50',
          focusRingInset,
          density === 'compact' ? 'px-2.5 py-1.5' : 'px-3 py-2',
        )}
      >
        <ChevronRight
          size={14}
          aria-hidden="true"
          className={cn(
            'shrink-0 text-zinc-400 transition-transform duration-150 dark:text-zinc-500',
            isOpen && 'rotate-90',
          )}
        />
        {Icon ? (
          <Icon
            size={14}
            aria-hidden="true"
            className="shrink-0 text-zinc-500 dark:text-zinc-400"
          />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-zinc-800 dark:text-zinc-200">
          {title}
          {subtitle ? (
            <span className="ml-2 font-normal text-zinc-500 dark:text-zinc-400">
              {subtitle}
            </span>
          ) : null}
        </span>
        {meta ? (
          <span className="flex shrink-0 items-center gap-2 text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
            {meta}
          </span>
        ) : null}
      </button>

      {isOpen ? (
        <div
          id={`${id}-content`}
          className={cn(
            'border-t border-zinc-100 dark:border-zinc-800',
            density === 'compact' ? 'px-2.5 py-2' : 'px-3 py-2.5',
            contentClassName,
          )}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

export default CollapsibleSection;
