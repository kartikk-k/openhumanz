/**
 * The tone→panel mapping, and the inline panel built from it.
 *
 * `lib/tone.ts` covers chips, dots and foreground text but stops short of
 * *surfaces*, so every screen that needs a tinted box tends to hand-roll an
 * amber one. This file is that missing rung for the runs screen: one place
 * where a `Tone` becomes a panel, used by the gap warning, the composer
 * warnings, the approval banner and {@link FailureNotice} alike, so all four
 * are the same shade of the same idea.
 *
 * If a second feature needs these, they should move into the design system.
 */
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';
import { TONE_TEXT, type Tone } from '../../lib/tone';

/** Tinted surface: border + background. */
export const PANEL_TONE: Record<Tone, string> = {
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

/** The 3px edge that marks a panel as more than decoration. */
export const RAIL_TONE: Record<Tone, string> = {
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
  title: ReactNode;
  /** One or two sentences. What happened and what it means. */
  children?: ReactNode;
  /** Buttons, right of the text on one line. */
  actions?: ReactNode;
  /** `flush` drops the rounding — for a bar spanning a pane. */
  shape?: 'card' | 'flush';
  className?: string;
}

/**
 * An inline explanation with a tone. Title on one line, body under it,
 * actions to the right — the shape used for every "you should know this"
 * message on this screen.
 */
export function Notice({
  tone = 'warning',
  icon: Icon,
  title,
  children,
  actions,
  shape = 'card',
  className,
}: NoticeProps) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 border px-3 py-2',
        shape === 'card' ? 'rounded-lg' : 'border-x-0 border-t-0',
        PANEL_TONE[tone],
        className,
      )}
    >
      {Icon ? (
        <Icon
          size={14}
          aria-hidden="true"
          className={cn('mt-[3px] shrink-0', TONE_TEXT[tone])}
        />
      ) : null}
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-medium text-zinc-900 dark:text-zinc-100">
          {title}
        </p>
        {children ? (
          <div className="mt-0.5 text-[12px] leading-relaxed text-zinc-700 dark:text-zinc-300">
            {children}
          </div>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

export default Notice;
