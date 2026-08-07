import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';
import { focusRing } from './styles';
import { Spinner } from './Spinner';

export type ButtonVariant =
  'primary' | 'secondary' | 'ghost' | 'outline' | 'destructive' | 'link';

export type ButtonSize = 'xs' | 'sm' | 'md' | 'icon' | 'icon-sm';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Swaps the leading icon for a spinner and disables the button. */
  loading?: boolean;
  /** Leading icon. Rendered at 14/16px depending on size. */
  icon?: LucideIcon;
  /** Trailing icon — chevrons, external-link marks. */
  iconRight?: LucideIcon;
  fullWidth?: boolean;
  children?: ReactNode;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-indigo-600 text-white hover:bg-indigo-500 active:bg-indigo-700 shadow-sm dark:bg-indigo-500 dark:hover:bg-indigo-400',
  secondary:
    'bg-zinc-100 text-zinc-900 hover:bg-zinc-200 active:bg-zinc-300 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700',
  ghost:
    'text-zinc-700 hover:bg-zinc-100 active:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-zinc-800',
  outline:
    'border border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-50 active:bg-zinc-100 dark:border-zinc-700 dark:bg-transparent dark:text-zinc-200 dark:hover:bg-zinc-800',
  destructive:
    'bg-rose-600 text-white hover:bg-rose-500 active:bg-rose-700 shadow-sm dark:bg-rose-600 dark:hover:bg-rose-500',
  link: 'text-indigo-600 underline-offset-4 hover:underline dark:text-indigo-400 px-0',
};

const SIZES: Record<ButtonSize, string> = {
  xs: 'h-6 gap-1 rounded px-2 text-[11px]',
  sm: 'h-7 gap-1.5 rounded-md px-2.5 text-xs',
  md: 'h-8 gap-2 rounded-md px-3 text-[13px]',
  icon: 'h-8 w-8 rounded-md',
  'icon-sm': 'h-7 w-7 rounded-md',
};

const ICON_SIZE: Record<ButtonSize, number> = {
  xs: 12,
  sm: 14,
  md: 14,
  icon: 16,
  'icon-sm': 14,
};

/**
 * The one button. Everything clickable that is not a link uses it.
 *
 * `destructive` is a real variant rather than a red override so that "this
 * deletes something" is a decision made once, in the component API.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'secondary',
      size = 'md',
      loading = false,
      icon: Icon,
      iconRight: IconRight,
      fullWidth = false,
      className,
      children,
      disabled,
      type = 'button',
      ...rest
    },
    ref,
  ) => {
    const iconPx = ICON_SIZE[size];
    const isIconOnly = size === 'icon' || size === 'icon-sm';

    return (
      <button
        ref={ref}
        // eslint-disable-next-line react/button-has-type
        type={type}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        className={cn(
          'inline-flex select-none items-center justify-center whitespace-nowrap font-medium transition-colors',
          'disabled:pointer-events-none disabled:opacity-50',
          focusRing,
          VARIANTS[variant],
          SIZES[size],
          fullWidth && 'w-full',
          className,
        )}
        {...rest}
      >
        {loading ? (
          <Spinner size="xs" label={null} />
        ) : (
          Icon && <Icon size={iconPx} strokeWidth={2} aria-hidden="true" />
        )}
        {!isIconOnly && children}
        {!isIconOnly && IconRight && (
          <IconRight size={iconPx} strokeWidth={2} aria-hidden="true" />
        )}
      </button>
    );
  },
);

Button.displayName = 'Button';

export default Button;
