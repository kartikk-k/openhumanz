import { useCallback, useId, useRef, useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';
import { focusRing } from './styles';

export interface TabItem<T extends string = string> {
  value: T;
  label: ReactNode;
  icon?: LucideIcon;
  /** Right-aligned count, e.g. pending approvals on a tab. */
  count?: number;
  disabled?: boolean;
}

export interface TabsProps<T extends string = string> {
  items: readonly TabItem<T>[];
  /** Controlled value. Omit to let Tabs own the state. */
  value?: T;
  defaultValue?: T;
  onValueChange?: (value: T) => void;
  /** `underline` for page-level sections, `pill` for in-panel switches. */
  variant?: 'underline' | 'pill';
  /** Accessible name for the tab list. */
  label?: string;
  className?: string;
  /** Content keyed by tab value. Only the active panel is mounted. */
  children?: (value: T) => ReactNode;
}

/**
 * Tabs with real `tablist` semantics and roving focus: Left/Right move between
 * tabs, Home/End jump to the ends, and activation follows focus (the pattern
 * users expect when panels are cheap to render).
 */
export function Tabs<T extends string = string>({
  items,
  value,
  defaultValue,
  onValueChange,
  variant = 'underline',
  label = 'Sections',
  className,
  children,
}: TabsProps<T>) {
  const baseId = useId();
  const [internal, setInternal] = useState<T>(
    defaultValue ?? (items[0]?.value as T),
  );
  const active = value ?? internal;
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const select = useCallback(
    (next: T) => {
      if (value === undefined) setInternal(next);
      onValueChange?.(next);
    },
    [value, onValueChange],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const enabled = items.filter((item) => !item.disabled);
    const index = enabled.findIndex((item) => item.value === active);
    if (index < 0) return;

    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % enabled.length;
    if (event.key === 'ArrowLeft') {
      nextIndex = (index - 1 + enabled.length) % enabled.length;
    }
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = enabled.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    const next = enabled[nextIndex].value;
    select(next);
    refs.current[next]?.focus();
  };

  return (
    <div className={className}>
      <div
        role="tablist"
        aria-label={label}
        className={cn(
          'flex items-center',
          variant === 'underline'
            ? 'gap-4 border-b border-zinc-200 dark:border-zinc-800'
            : 'gap-1 rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800/70',
        )}
      >
        {items.map((item) => {
          const selected = item.value === active;
          const Icon = item.icon;
          return (
            <button
              key={item.value}
              ref={(node) => {
                refs.current[item.value] = node;
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${item.value}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${item.value}`}
              tabIndex={selected ? 0 : -1}
              disabled={item.disabled}
              onClick={() => select(item.value)}
              onKeyDown={onKeyDown}
              className={cn(
                'inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] font-medium transition-colors disabled:opacity-40',
                focusRing,
                variant === 'underline'
                  ? '-mb-px border-b-2 px-0.5 pb-2 pt-1.5'
                  : 'rounded-[6px] px-2.5 py-1',
                variant === 'underline' && selected
                  ? 'border-indigo-500 text-zinc-900 dark:text-zinc-100'
                  : '',
                variant === 'underline' && !selected
                  ? 'border-transparent text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'
                  : '',
                variant === 'pill' && selected
                  ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-zinc-100'
                  : '',
                variant === 'pill' && !selected
                  ? 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'
                  : '',
              )}
            >
              {Icon ? <Icon size={14} aria-hidden="true" /> : null}
              {item.label}
              {typeof item.count === 'number' && item.count > 0 ? (
                <span className="ml-0.5 rounded bg-zinc-200 px-1 text-[10px] font-semibold tabular-nums text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300">
                  {item.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {children ? (
        <div
          role="tabpanel"
          id={`${baseId}-panel-${active}`}
          aria-labelledby={`${baseId}-tab-${active}`}
          tabIndex={0}
          className="outline-none"
        >
          {children(active)}
        </div>
      ) : null}
    </div>
  );
}

export default Tabs;
