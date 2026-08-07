import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { hairline } from './styles';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** `flat` drops the shadow — use inside an already-raised container. */
  variant?: 'raised' | 'flat' | 'ghost';
  /** Adds hover affordance. Pair with an onClick or a wrapping link. */
  interactive?: boolean;
  children?: ReactNode;
}

const VARIANTS: Record<NonNullable<CardProps['variant']>, string> = {
  raised: 'bg-white dark:bg-zinc-900 border shadow-sm',
  flat: 'bg-white dark:bg-zinc-900 border',
  ghost: 'bg-zinc-50/60 dark:bg-zinc-900/40 border border-dashed',
};

/** A bounded surface. The default container for everything. */
export function Card({
  variant = 'raised',
  interactive = false,
  className,
  children,
  ...rest
}: CardProps) {
  return (
    <div
      className={cn(
        'rounded-lg',
        hairline,
        VARIANTS[variant],
        interactive &&
          'cursor-pointer transition-colors hover:border-zinc-300 hover:bg-zinc-50 dark:hover:border-zinc-700 dark:hover:bg-zinc-800/50',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export interface CardHeaderProps extends HTMLAttributes<HTMLDivElement> {
  /** Right-aligned controls. Kept out of the title's click target. */
  actions?: ReactNode;
  children?: ReactNode;
}

export function CardHeader({
  actions,
  className,
  children,
  ...rest
}: CardHeaderProps) {
  return (
    <div
      className={cn(
        'flex items-start justify-between gap-3 px-4 py-3',
        className,
      )}
      {...rest}
    >
      <div className="min-w-0 flex-1">{children}</div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
      ) : null}
    </div>
  );
}

export function CardTitle({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn(
        'truncate text-[13px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100',
        className,
      )}
      {...rest}
    >
      {children}
    </h3>
  );
}

export function CardDescription({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn(
        'mt-0.5 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400',
        className,
      )}
      {...rest}
    >
      {children}
    </p>
  );
}

export interface CardContentProps extends HTMLAttributes<HTMLDivElement> {
  /** Removes padding — for tables and lists that own their own edges. */
  flush?: boolean;
}

export function CardContent({
  flush = false,
  className,
  children,
  ...rest
}: CardContentProps) {
  return (
    <div className={cn(!flush && 'px-4 pb-4', className)} {...rest}>
      {children}
    </div>
  );
}

export function CardFooter({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex items-center justify-end gap-2 border-t px-4 py-2.5',
        hairline,
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export default Card;
