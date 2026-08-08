/**
 * The panel used whenever the app has to tell the user something about the
 * machine rather than about their data.
 *
 * Same visual register as the run-failure notice: a tone rail, an eyebrow, a
 * headline in plain language and the raw detail demoted to a code block. Shared
 * by settings and onboarding so a warning looks identical wherever it appears.
 */
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { TONE_TEXT, type Tone } from '../../lib/tone';
import { CodeBlock } from '../../components/ui';

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
    'border-rose-300 bg-rose-50 dark:border-rose-500/40 dark:bg-rose-500/10',
};

const RAIL: Record<Tone, string> = {
  neutral: 'bg-zinc-300 dark:bg-zinc-700',
  accent: 'bg-indigo-500',
  info: 'bg-sky-500',
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-rose-500',
};

export interface NoticeProps {
  tone?: Tone;
  icon?: LucideIcon;
  /** Small-caps label above the title. */
  eyebrow?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  /** Monospace detail, demoted below the prose. Never the headline. */
  detail?: string;
  detailLabel?: string;
  actions?: ReactNode;
  size?: 'compact' | 'full';
  className?: string;
}

export function Notice({
  tone = 'neutral',
  icon: Icon,
  eyebrow,
  title,
  children,
  detail,
  detailLabel = 'detail',
  actions,
  size = 'full',
  className,
}: NoticeProps) {
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
        {Icon ? (
          <Icon
            size={size === 'full' ? 17 : 15}
            aria-hidden="true"
            className={cn('mt-0.5 shrink-0', TONE_TEXT[tone])}
          />
        ) : null}
        <div className="min-w-0 flex-1">
          {eyebrow ? (
            <p
              className={cn(
                'text-[10px] font-semibold uppercase tracking-wider',
                TONE_TEXT[tone],
              )}
            >
              {eyebrow}
            </p>
          ) : null}
          <p
            className={cn(
              'font-semibold text-zinc-900 dark:text-zinc-100',
              eyebrow ? 'mt-0.5' : '',
              size === 'full' ? 'text-[14px]' : 'text-[13px]',
            )}
          >
            {title}
          </p>
          {children ? (
            <div className="mt-1 space-y-1.5 text-[12.5px] leading-relaxed text-zinc-700 dark:text-zinc-300">
              {children}
            </div>
          ) : null}

          {detail ? (
            <CodeBlock
              code={detail.trim()}
              language={detailLabel}
              wrap
              maxHeight="9rem"
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

/**
 * Render a string that contains `backticked` fragments, turning them into real
 * inline code. Engine and auth messages are written by the main process with
 * backticks in them (`claude auth login`), and showing the tick characters
 * verbatim looks like a bug.
 */
export function Ticks({ text }: { text: string }) {
  const parts = text.split('`');
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          // eslint-disable-next-line react/no-array-index-key
          <code
            key={`${index}-${part}`}
            className="rounded bg-zinc-900/[0.06] px-1 py-px font-mono text-[11.5px] text-zinc-800 dark:bg-white/10 dark:text-zinc-200"
          >
            {part}
          </code>
        ) : (
          // eslint-disable-next-line react/no-array-index-key
          <span key={`${index}-plain`}>{part}</span>
        ),
      )}
    </>
  );
}

export default Notice;
