import {
  forwardRef,
  useId,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Field, describedBy } from './Field';

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'size' | 'children'
> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Options, or pass `children` for `<optgroup>` layouts. */
  options?: readonly SelectOption[];
  /** Shown as a disabled first entry when the value is empty. */
  placeholder?: string;
  size?: 'sm' | 'md';
  children?: ReactNode;
  selectClassName?: string;
  containerClassName?: string;
}

/**
 * A styled native `<select>`.
 *
 * Deliberately native: the OS popup is keyboard-operable, screen-reader
 * correct and type-ahead capable for free, and a hand-rolled listbox is a
 * hundred lines of ARIA we would have to keep right. When a screen genuinely
 * needs rich rows (icons, two-line options) it should use a Dialog, not a
 * bespoke dropdown.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  (
    {
      label,
      hint,
      error,
      options,
      placeholder,
      size = 'md',
      className,
      selectClassName,
      containerClassName,
      children,
      id,
      required,
      ...rest
    },
    ref,
  ) => {
    const generatedId = useId();
    const fieldId = id ?? generatedId;

    return (
      <Field
        label={label}
        htmlFor={fieldId}
        hint={hint}
        error={error}
        required={required}
        className={cn(containerClassName, className)}
      >
        <div className="relative flex items-center">
          <select
            ref={ref}
            id={fieldId}
            required={required}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy(
              fieldId,
              Boolean(error),
              Boolean(hint),
            )}
            className={cn(
              'w-full appearance-none rounded-md border bg-white pl-2.5 pr-7 text-zinc-900 transition-colors',
              'dark:bg-zinc-950 dark:text-zinc-100',
              'focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/60',
              'disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-500 dark:disabled:bg-zinc-900',
              size === 'sm' ? 'h-7 text-xs' : 'h-8 text-[13px]',
              error
                ? 'border-rose-400 dark:border-rose-500/70'
                : 'border-zinc-300 dark:border-zinc-700',
              selectClassName,
            )}
            {...rest}
          >
            {placeholder ? (
              <option value="" disabled>
                {placeholder}
              </option>
            ) : null}
            {options?.map((option) => (
              <option
                key={option.value}
                value={option.value}
                disabled={option.disabled}
              >
                {option.label}
              </option>
            ))}
            {children}
          </select>
          <ChevronDown
            size={14}
            aria-hidden="true"
            className="pointer-events-none absolute right-2 text-zinc-400 dark:text-zinc-500"
          />
        </div>
      </Field>
    );
  },
);

Select.displayName = 'Select';

export default Select;
