import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: ReactNode;
  /** One or two sentences. Say what to do next, not just what is missing. */
  description?: ReactNode;
  /** Primary action, usually a Button. */
  action?: ReactNode;
  /** Secondary line under the action — a hint, a keyboard shortcut. */
  footer?: ReactNode;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * The empty/first-run state. This app ships with no data and no backend on day
 * one, so this component is load-bearing, not decoration: every list, table and
 * panel renders it rather than nothing.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  footer,
  size = 'md',
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        size === 'sm' ? 'gap-2 px-4 py-8' : 'gap-3 px-6 py-14',
        className,
      )}
    >
      {Icon ? (
        <div
          className={cn(
            'flex items-center justify-center rounded-full bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500',
            size === 'sm' ? 'h-8 w-8' : 'h-11 w-11',
          )}
        >
          <Icon size={size === 'sm' ? 15 : 19} aria-hidden="true" />
        </div>
      ) : null}
      <div className="max-w-sm">
        <p
          className={cn(
            'font-medium text-zinc-800 dark:text-zinc-200',
            size === 'sm' ? 'text-[13px]' : 'text-sm',
          )}
        >
          {title}
        </p>
        {description ? (
          <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
            {description}
          </p>
        ) : null}
      </div>
      {action ? (
        <div className="mt-1 flex items-center gap-2">{action}</div>
      ) : null}
      {footer ? (
        <div className="mt-1 text-[11px] text-zinc-400 dark:text-zinc-500">
          {footer}
        </div>
      ) : null}
    </div>
  );
}

export default EmptyState;
