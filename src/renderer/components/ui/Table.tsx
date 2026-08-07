import type {
  HTMLAttributes,
  ReactNode,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from 'react';
import { cn } from '../../lib/utils';

export interface TableProps extends HTMLAttributes<HTMLTableElement> {
  /** Adds a scroll container with a sticky header. */
  stickyHeader?: boolean;
  /** Tighter rows for long lists. */
  density?: 'comfortable' | 'compact';
  containerClassName?: string;
}

/**
 * A dense data table. Semantic `<table>` throughout — screen readers get row
 * and column relationships for free, which a div grid would have to re-declare.
 */
export function Table({
  stickyHeader = false,
  density = 'comfortable',
  className,
  containerClassName,
  children,
  ...rest
}: TableProps) {
  return (
    <div
      className={cn(
        'w-full overflow-x-auto',
        stickyHeader && 'max-h-full overflow-y-auto',
        containerClassName,
      )}
      data-density={density}
    >
      <table
        className={cn(
          'w-full border-collapse text-left text-[13px]',
          className,
        )}
        {...rest}
      >
        {children}
      </table>
    </div>
  );
}

export interface TableHeadProps
  extends HTMLAttributes<HTMLTableSectionElement> {
  sticky?: boolean;
}

export function TableHead({
  sticky = false,
  className,
  children,
  ...rest
}: TableHeadProps) {
  return (
    <thead
      className={cn(
        'border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/70',
        sticky && 'sticky top-0 z-10',
        className,
      )}
      {...rest}
    >
      {children}
    </thead>
  );
}

export function TableBody({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tbody
      className={cn(
        'divide-y divide-zinc-100 dark:divide-zinc-800/80',
        className,
      )}
      {...rest}
    >
      {children}
    </tbody>
  );
}

export interface TableRowProps extends HTMLAttributes<HTMLTableRowElement> {
  selected?: boolean;
  /** Hover highlight. Set it when the row navigates somewhere. */
  interactive?: boolean;
}

export function TableRow({
  selected = false,
  interactive = false,
  className,
  children,
  ...rest
}: TableRowProps) {
  return (
    <tr
      aria-selected={selected || undefined}
      className={cn(
        'transition-colors',
        interactive &&
          'cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/50',
        selected && 'bg-indigo-50/70 dark:bg-indigo-500/10',
        className,
      )}
      {...rest}
    >
      {children}
    </tr>
  );
}

export interface TableHeaderCellProps
  extends ThHTMLAttributes<HTMLTableCellElement> {
  align?: 'left' | 'right' | 'center';
  /** Fixed column width, e.g. `'8rem'`. */
  width?: string | number;
}

export function TableHeaderCell({
  align = 'left',
  width,
  className,
  style,
  children,
  ...rest
}: TableHeaderCellProps) {
  return (
    <th
      scope="col"
      style={{ width, ...style }}
      className={cn(
        'whitespace-nowrap px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        className,
      )}
      {...rest}
    >
      {children}
    </th>
  );
}

export interface TableCellProps
  extends TdHTMLAttributes<HTMLTableCellElement> {
  align?: 'left' | 'right' | 'center';
  /** Numeric columns: tabular figures so digits line up. */
  numeric?: boolean;
  /** Prevent wrapping — ids, timestamps, statuses. */
  nowrap?: boolean;
}

export function TableCell({
  align = 'left',
  numeric = false,
  nowrap = false,
  className,
  children,
  ...rest
}: TableCellProps) {
  return (
    <td
      className={cn(
        'px-3 py-2 align-middle text-zinc-700 dark:text-zinc-300',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        numeric && 'tabular-nums',
        nowrap && 'whitespace-nowrap',
        className,
      )}
      {...rest}
    >
      {children}
    </td>
  );
}

export interface TableEmptyRowProps {
  colSpan: number;
  children: ReactNode;
}

/** A single full-width row for the "no rows" case. */
export function TableEmptyRow({ colSpan, children }: TableEmptyRowProps) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-10 text-center">
        {children}
      </td>
    </tr>
  );
}

export default Table;
