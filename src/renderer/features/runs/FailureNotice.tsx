/**
 * The panel a failed run shows instead of a red word.
 *
 * Quota and rate-limit failures are rendered in a visually distinct register —
 * warning tone, a capacity eyebrow, a "capacity" icon and no "raw error"
 * framing — because they are not breakage, and the user who hits one needs
 * "your plan is out, come back later", not a stack trace.
 */
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { TONE_TEXT, type Tone } from '../../lib/tone';
import { CodeBlock } from '../../components/ui';
import { explainFailure, isQuotaFailure, type FailureKind } from './failures';

const PANEL: Record<Tone, string> = {
  neutral:
    'border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/60',
  accent:
    'border-indigo-200 bg-indigo-50/70 dark:border-indigo-500/30 dark:bg-indigo-500/10',
  info: 'border-sky-200 bg-sky-50/70 dark:border-sky-500/30 dark:bg-sky-500/10',
  success:
    'border-emerald-200 bg-emerald-50/70 dark:border-emerald-500/30 dark:bg-emerald-500/10',
  warning:
    'border-amber-300 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-500/10',
  danger:
    'border-rose-200 bg-rose-50/70 dark:border-rose-500/30 dark:bg-rose-500/10',
};

const RAIL: Record<Tone, string> = {
  neutral: 'bg-zinc-300 dark:bg-zinc-700',
  accent: 'bg-indigo-500',
  info: 'bg-sky-500',
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-rose-500',
};

export interface FailureNoticeProps {
  kind: FailureKind | undefined;
  /** Verbatim engine/app error. Shown as raw text, never as the headline. */
  detail?: string;
  /** Buttons — re-run, open settings. */
  actions?: ReactNode;
  /** `compact` is the in-step version; `full` is the run header version. */
  size?: 'compact' | 'full';
  className?: string;
}

export function FailureNotice({
  kind,
  detail,
  actions,
  size = 'full',
  className,
}: FailureNoticeProps) {
  const explanation = explainFailure(kind);
  const { icon: Icon, tone } = explanation;
  const capacity = isQuotaFailure(kind);

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-lg border',
        PANEL[tone],
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn('absolute inset-y-0 left-0 w-[3px]', RAIL[tone])}
      />
      <div
        className={cn(
          'flex gap-3',
          size === 'full' ? 'px-4 py-3.5 pl-5' : 'px-3 py-2.5 pl-4',
        )}
      >
        <Icon
          size={size === 'full' ? 17 : 15}
          aria-hidden="true"
          className={cn('mt-0.5 shrink-0', TONE_TEXT[tone])}
        />
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              'text-[10px] font-semibold uppercase tracking-wider',
              TONE_TEXT[tone],
            )}
          >
            {explanation.eyebrow}
          </p>
          <p
            className={cn(
              'mt-0.5 font-semibold text-zinc-900 dark:text-zinc-100',
              size === 'full' ? 'text-[14px]' : 'text-[13px]',
            )}
          >
            {explanation.title}
          </p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-zinc-700 dark:text-zinc-300">
            {explanation.body}
          </p>
          {explanation.advice ? (
            <p
              className={cn(
                'mt-1.5 text-[12.5px] font-medium leading-relaxed',
                capacity
                  ? 'text-amber-800 dark:text-amber-300'
                  : 'text-zinc-600 dark:text-zinc-400',
              )}
            >
              {explanation.advice}
            </p>
          ) : null}

          {detail ? (
            <CodeBlock
              code={detail.trim()}
              language={capacity ? 'engine said' : 'error'}
              wrap
              maxHeight="10rem"
              className="mt-2.5 bg-white/70 dark:bg-zinc-950/60"
            />
          ) : null}

          {actions ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {actions}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default FailureNotice;
