import {
  forwardRef,
  useId,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '../../lib/utils';
import { Field, describedBy } from './Field';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Monospace — for prompts, cron strings, raw payloads. */
  mono?: boolean;
  textareaClassName?: string;
  containerClassName?: string;
}

/**
 * Multi-line text. Vertical resize only, because horizontal resize inside a
 * fixed desktop layout just breaks the grid.
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  (
    {
      label,
      hint,
      error,
      mono = false,
      className,
      textareaClassName,
      containerClassName,
      id,
      required,
      rows = 4,
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
        <textarea
          ref={ref}
          id={fieldId}
          rows={rows}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(fieldId, Boolean(error), Boolean(hint))}
          className={cn(
            'w-full resize-y rounded-md border bg-white px-2.5 py-2 text-[13px] leading-relaxed text-zinc-900 transition-colors',
            'placeholder:text-zinc-400 dark:placeholder:text-zinc-600',
            'dark:bg-zinc-950 dark:text-zinc-100',
            'focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/60',
            'disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-500 dark:disabled:bg-zinc-900',
            mono && 'font-mono text-xs',
            error
              ? 'border-rose-400 dark:border-rose-500/70'
              : 'border-zinc-300 dark:border-zinc-700',
            textareaClassName,
          )}
          {...rest}
        />
      </Field>
    );
  },
);

Textarea.displayName = 'Textarea';

export default Textarea;
