/**
 * Settings controls that refuse bad input instead of persisting it.
 *
 * Every editable control here holds a local draft, validates it against the
 * leaf schema from `shared/settings.ts` on commit, and only calls back when the
 * schema accepts. An invalid draft stays on screen with a readable message
 * under it — it is never sent, and it never silently reverts either, because
 * losing what someone typed is its own small betrayal.
 *
 * Commit points are blur and Enter. Escape restores the persisted value. Text
 * inputs deliberately do not commit per keystroke: a path is invalid for most
 * of the time it takes to type one.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { Input, Select, Switch, type SelectOption } from '../../components/ui';
import { textMuted, textSubtle } from '../../components/ui/styles';
import { firstIssueMessage, type SchemaError } from './writer';

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

export interface SettingsSectionProps {
  id: string;
  title: string;
  description?: ReactNode;
  /** Rendered at the top right of the section header. */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function SettingsSection({
  id,
  title,
  description,
  actions,
  children,
  className,
}: SettingsSectionProps) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={cn(
        'scroll-mt-6 rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900',
        className,
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="min-w-0">
          <h2
            id={`${id}-title`}
            className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-100"
          >
            {title}
          </h2>
          {description ? (
            <p
              className={cn(
                'mt-0.5 max-w-2xl text-[12.5px] leading-relaxed',
                textSubtle,
              )}
            >
              {description}
            </p>
          ) : null}
        </div>
        {actions}
      </header>
      <div className="space-y-4 px-4 py-4">{children}</div>
    </section>
  );
}

/** Two-column on wide windows, one on narrow. */
export function FieldGrid({
  children,
  columns = 2,
}: {
  children: ReactNode;
  columns?: 1 | 2;
}) {
  return (
    <div
      className={cn(
        'grid gap-x-5 gap-y-4',
        columns === 2 ? 'sm:grid-cols-2' : 'grid-cols-1',
      )}
    >
      {children}
    </div>
  );
}

/** A read-only fact: label above, value below. Used for paths we cannot edit. */
export function ReadOnlyFact({
  label,
  value,
  hint,
  monospace = true,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  monospace?: boolean;
}) {
  return (
    <div>
      <p className="text-[12px] font-medium text-zinc-700 dark:text-zinc-300">
        {label}
      </p>
      <p
        className={cn(
          'mt-1 break-all text-[12.5px] text-zinc-900 dark:text-zinc-100',
          monospace && 'font-mono text-[12px]',
        )}
      >
        {value}
      </p>
      {hint ? (
        <p className={cn('mt-1 text-[12px] leading-relaxed', textMuted)}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Draft plumbing                                                      */
/* ------------------------------------------------------------------ */

interface DraftState {
  draft: string;
  error: string | null;
}

function useDraft(persisted: string) {
  const [state, setState] = useState<DraftState>({
    draft: persisted,
    error: null,
  });
  const persistedRef = useRef(persisted);

  // Adopt a value that changed underneath us (a push, or another window)
  // only when the user is not mid-edit with an error on screen.
  useEffect(() => {
    if (persistedRef.current === persisted) return;
    persistedRef.current = persisted;
    setState({ draft: persisted, error: null });
  }, [persisted]);

  return [state, setState] as const;
}

/**
 * Just enough of a zod schema to validate one leaf.
 *
 * Structural rather than `z.ZodType<T>` on purpose: the leaves in
 * `shared/settings.ts` are wrapped in `.default()`, whose *input* type is
 * `T | undefined`, and `ZodType`'s input parameter is invariant enough that
 * `ZodDefault<ZodString>` will not assign to `ZodType<string>`. Every zod
 * schema satisfies this interface, including refined and defaulted ones.
 */
export interface LeafSchema<T> {
  safeParse: (
    value: unknown,
  ) => { success: true; data: T } | { success: false; error: SchemaError };
}

export interface ValidatedFieldProps<T> {
  id: string;
  label: string;
  hint?: ReactNode;
  /** The persisted value. */
  value: T;
  /** The leaf schema from `shared/settings.ts` this field must satisfy. */
  schema: LeafSchema<T>;
  /**
   * Shown instead of zod's own wording when validation fails. Zod says
   * "Too small: expected number to be >0"; a person needs "At least 1 turn."
   */
  invalidMessage?: string;
  onCommit: (value: T) => void;
  disabled?: boolean;
}

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

export function TextSetting({
  id,
  label,
  hint,
  value,
  schema,
  invalidMessage,
  onCommit,
  disabled,
  placeholder,
  monospace = false,
}: ValidatedFieldProps<string> & {
  monospace?: boolean;
  placeholder?: string;
}) {
  const [state, setState] = useDraft(value);

  const commit = () => {
    if (state.draft === value) {
      setState({ draft: state.draft, error: null });
      return;
    }
    const parsed = schema.safeParse(state.draft);
    if (!parsed.success) {
      setState({
        draft: state.draft,
        error: invalidMessage ?? firstIssueMessage(parsed.error),
      });
      return;
    }
    setState({ draft: state.draft, error: null });
    onCommit(parsed.data);
  };

  return (
    <Input
      id={id}
      label={label}
      hint={hint}
      error={state.error}
      value={state.draft}
      disabled={disabled}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      inputClassName={monospace ? 'font-mono text-[12px]' : undefined}
      onChange={(event) => setState({ draft: event.target.value, error: null })}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        }
        if (event.key === 'Escape') {
          setState({ draft: value, error: null });
        }
      }}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Number                                                              */
/* ------------------------------------------------------------------ */

export interface NumberUnit {
  /** Suffix shown after the input, e.g. "minutes". */
  label: string;
  /** Stored value = entered value × factor. */
  factor: number;
}

function toDisplay(value: number, factor: number): string {
  const scaled = value / factor;
  return String(Number(scaled.toFixed(4)));
}

export function NumberSetting({
  id,
  label,
  hint,
  value,
  schema,
  invalidMessage,
  onCommit,
  disabled,
  unit,
  step,
  min,
}: ValidatedFieldProps<number> & {
  unit?: NumberUnit;
  step?: number;
  min?: number;
}) {
  const factor = unit?.factor ?? 1;
  const persisted = toDisplay(value, factor);
  const [state, setState] = useDraft(persisted);

  const commit = () => {
    if (state.draft === persisted) {
      setState({ draft: state.draft, error: null });
      return;
    }
    const trimmed = state.draft.trim();
    if (trimmed === '') {
      setState({ draft: state.draft, error: 'Enter a number.' });
      return;
    }
    const entered = Number(trimmed);
    if (!Number.isFinite(entered)) {
      setState({
        draft: state.draft,
        error: `“${trimmed}” is not a number.`,
      });
      return;
    }
    const scaled = Math.round(entered * factor);
    const parsed = schema.safeParse(scaled);
    if (!parsed.success) {
      setState({
        draft: state.draft,
        error: invalidMessage ?? firstIssueMessage(parsed.error),
      });
      return;
    }
    setState({ draft: state.draft, error: null });
    onCommit(parsed.data);
  };

  return (
    <Input
      id={id}
      label={label}
      hint={hint}
      error={state.error}
      value={state.draft}
      disabled={disabled}
      inputMode="decimal"
      step={step}
      min={min}
      spellCheck={false}
      autoComplete="off"
      trailing={
        unit ? (
          <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
            {unit.label}
          </span>
        ) : undefined
      }
      inputClassName="tabular-nums"
      onChange={(event) => setState({ draft: event.target.value, error: null })}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        }
        if (event.key === 'Escape') {
          setState({ draft: persisted, error: null });
        }
      }}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Select                                                              */
/* ------------------------------------------------------------------ */

export function SelectSetting<T extends string>({
  id,
  label,
  hint,
  value,
  schema,
  invalidMessage,
  onCommit,
  disabled,
  options,
}: ValidatedFieldProps<T> & { options: readonly SelectOption<T>[] }) {
  const [error, setError] = useState<string | null>(null);

  return (
    <Select
      id={id}
      label={label}
      hint={hint}
      error={error}
      value={value}
      disabled={disabled}
      options={options}
      onChange={(event) => {
        const parsed = schema.safeParse(event.target.value);
        if (!parsed.success) {
          setError(invalidMessage ?? firstIssueMessage(parsed.error));
          return;
        }
        setError(null);
        onCommit(parsed.data);
      }}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Switch                                                              */
/* ------------------------------------------------------------------ */

export function SwitchSetting({
  id,
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Switch
      id={id}
      layout="row"
      checked={checked}
      onChange={onChange}
      disabled={disabled}
      label={label}
      description={description}
    />
  );
}
