import { useId, type ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { focusRing } from './styles';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Visible label. Omit only when an adjacent element labels the switch. */
  label?: ReactNode;
  description?: ReactNode;
  /** Required when `label` is omitted. */
  'aria-label'?: string;
  size?: 'sm' | 'md';
  /** Puts the label first and the control hard right — the settings-row look. */
  layout?: 'inline' | 'row';
  className?: string;
  id?: string;
}

/**
 * A binary toggle. `role="switch"` on a real button, so Space/Enter work and
 * assistive tech announces on/off rather than "checkbox".
 */
export function Switch({
  checked,
  onChange,
  disabled = false,
  label,
  description,
  size = 'md',
  layout = 'inline',
  className,
  id,
  'aria-label': ariaLabel,
}: SwitchProps) {
  const generatedId = useId();
  const switchId = id ?? generatedId;
  const labelId = label ? `${switchId}-label` : undefined;
  const descriptionId = description ? `${switchId}-description` : undefined;

  const track = size === 'sm' ? 'h-4 w-7' : 'h-5 w-9';
  const knob = size === 'sm' ? 'h-3 w-3' : 'h-4 w-4';
  const travel = size === 'sm' ? 'translate-x-3' : 'translate-x-4';

  const control = (
    <button
      type="button"
      role="switch"
      id={switchId}
      aria-checked={checked}
      aria-label={label ? undefined : ariaLabel}
      aria-labelledby={labelId}
      aria-describedby={descriptionId}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex shrink-0 items-center rounded-full transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        focusRing,
        track,
        checked
          ? 'bg-indigo-600 dark:bg-indigo-500'
          : 'bg-zinc-300 dark:bg-zinc-700',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'inline-block transform rounded-full bg-white shadow-sm transition-transform',
          knob,
          checked ? travel : 'translate-x-0.5',
        )}
      />
    </button>
  );

  if (!label && !description) {
    return <span className={className}>{control}</span>;
  }

  return (
    <div
      className={cn(
        'flex gap-3',
        layout === 'row' ? 'items-center justify-between' : 'items-start',
        className,
      )}
    >
      {layout === 'row' ? null : control}
      <div className="min-w-0">
        {label ? (
          <label
            id={labelId}
            htmlFor={switchId}
            className={cn(
              'block text-[13px] font-medium text-zinc-800 dark:text-zinc-200',
              !disabled && 'cursor-pointer',
            )}
          >
            {label}
          </label>
        ) : null}
        {description ? (
          <p
            id={descriptionId}
            className="mt-0.5 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400"
          >
            {description}
          </p>
        ) : null}
      </div>
      {layout === 'row' ? control : null}
    </div>
  );
}

export default Switch;
