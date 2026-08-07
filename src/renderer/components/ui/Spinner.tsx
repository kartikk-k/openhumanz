import { cn } from '../../lib/utils';

export interface SpinnerProps {
  /** 12 / 16 / 20 / 28px. Default `sm` (16). */
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
  /**
   * Screen-reader label. Pass `null` on purely decorative spinners that sit
   * next to their own text (e.g. inside a Button that already says "Saving").
   */
  label?: string | null;
}

const SIZES: Record<NonNullable<SpinnerProps['size']>, string> = {
  xs: 'h-3 w-3 border',
  sm: 'h-4 w-4 border-[1.5px]',
  md: 'h-5 w-5 border-2',
  lg: 'h-7 w-7 border-2',
};

/**
 * Indeterminate progress. A CSS ring rather than an icon so it inherits
 * `currentColor` and stays crisp at every size.
 */
export function Spinner({
  size = 'sm',
  className,
  label = 'Loading',
}: SpinnerProps) {
  return (
    <span
      className={cn(
        'inline-block shrink-0 animate-spin rounded-full border-current border-r-transparent align-[-0.125em]',
        SIZES[size],
        className,
      )}
      role={label ? 'status' : undefined}
      aria-hidden={label ? undefined : true}
    >
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}

export default Spinner;
