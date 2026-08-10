import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Field, describedBy } from './Field';

export interface InputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'size'
> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Leading icon inside the field — search, filter, path. */
  icon?: LucideIcon;
  /** Trailing adornment: a unit, a clear button, a shortcut hint. */
  trailing?: ReactNode;
  size?: 'sm' | 'md';
  /** Constrain the field itself rather than the wrapper. */
  inputClassName?: string;
  containerClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      label,
      hint,
      error,
      icon: Icon,
      trailing,
      size = 'md',
      className,
      inputClassName,
      containerClassName,
      id,
      required,
      disabled,
      ...rest
    },
    ref,
  ) => {
    const generatedId = useId();
    const inputId = id ?? generatedId;
    const describedById = describedBy(inputId, Boolean(error), Boolean(hint));

    return (
      <Field
        label={label}
        htmlFor={inputId}
        hint={hint}
        error={error}
        required={required}
        className={cn(containerClassName, className)}
      >
        <div className="relative flex items-center">
          {Icon ? (
            <Icon
              size={14}
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 text-zinc-400 dark:text-zinc-500"
            />
          ) : null}
          <input
            ref={ref}
            id={inputId}
            required={required}
            disabled={disabled}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedById}
            className={cn(
              'w-full rounded-md border bg-white text-zinc-900 transition-colors',
              'placeholder:text-zinc-400 dark:placeholder:text-zinc-600',
              'dark:bg-zinc-950 dark:text-zinc-100',
              'focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/60',
              'disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-500 dark:disabled:bg-zinc-900',
              size === 'sm' ? 'h-7 text-xs' : 'h-8 text-[13px]',
              Icon ? 'pl-8' : 'pl-2.5',
              trailing ? 'pr-9' : 'pr-2.5',
              error
                ? 'border-rose-400 dark:border-rose-500/70'
                : 'border-zinc-300 dark:border-zinc-700',
              inputClassName,
            )}
            {...rest}
          />
          {trailing ? (
            <div className="absolute right-2 flex items-center text-zinc-400 dark:text-zinc-500">
              {trailing}
            </div>
          ) : null}
        </div>
      </Field>
    );
  },
);

Input.displayName = 'Input';

export default Input;
