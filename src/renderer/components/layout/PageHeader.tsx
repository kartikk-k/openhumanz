import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export interface PageHeaderProps {
  title: ReactNode;
  /** One line under the title. Keep it to a sentence. */
  description?: ReactNode;
  /** Right-aligned controls: primary action, filters, search. */
  actions?: ReactNode;
  /** A Tabs row or a filter bar, rendered flush against the bottom border. */
  toolbar?: ReactNode;
  /** Stick to the top of the scroll container. On by default. */
  sticky?: boolean;
  className?: string;
}

/**
 * The top of every feature screen. Same height, same alignment, same place for
 * the primary action — so moving between screens does not move the furniture.
 */
export function PageHeader({
  title,
  description,
  actions,
  toolbar,
  sticky = true,
  className,
}: PageHeaderProps) {
  return (
    <header
      className={cn(
        'border-b border-zinc-200 bg-white/95 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95',
        sticky && 'sticky top-0 z-20',
        className,
      )}
    >
      <div className="flex items-center gap-4 px-5 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[15px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            {title}
          </h1>
          {description ? (
            <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        ) : null}
      </div>
      {toolbar ? <div className="px-5 pb-2">{toolbar}</div> : null}
    </header>
  );
}

export default PageHeader;
