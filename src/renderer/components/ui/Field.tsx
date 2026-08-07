import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

/**
 * The `aria-describedby` a control should carry, given whether it has an error
 * and/or a hint. Error wins — only one of the two is ever rendered.
 */
export function describedBy(
  id: string,
  hasError: boolean,
  hasHint: boolean,
): string | undefined {
  if (hasError) return `${id}-error`;
  if (hasHint) return `${id}-hint`;
  return undefined;
}

export interface FieldProps {
  /** Rendered as a real `<label for>` when `htmlFor` is supplied. */
  label?: ReactNode;
  htmlFor?: string;
  /** Helper text under the control. Hidden while an error is showing. */
  hint?: ReactNode;
  /** Error text. Also flips the control's border via `aria-invalid`. */
  error?: ReactNode;
  required?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * Label + control + hint/error. Used by Input, Textarea, Select and Switch so
 * form rows line up and describe themselves the same way.
 *
 * The ids it needs (`<id>-hint`, `<id>-error`) are what the controls point at
 * with `aria-describedby`.
 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  required = false,
  className,
  children,
}: FieldProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label ? (
        <label
          htmlFor={htmlFor}
          className="text-xs font-medium text-zinc-700 dark:text-zinc-300"
        >
          {label}
          {required ? (
            <span
              className="ml-0.5 text-rose-600 dark:text-rose-400"
              aria-hidden="true"
            >
              *
            </span>
          ) : null}
        </label>
      ) : null}
      {children}
      {error ? (
        <p
          id={htmlFor ? `${htmlFor}-error` : undefined}
          className="text-xs text-rose-600 dark:text-rose-400"
        >
          {error}
        </p>
      ) : (
        hint && (
          <p
            id={htmlFor ? `${htmlFor}-hint` : undefined}
            className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400"
          >
            {hint}
          </p>
        )
      )}
    </div>
  );
}

export default Field;
