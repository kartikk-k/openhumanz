/**
 * Small pieces shared by the three panels of this screen.
 *
 * Kept local to the feature rather than pushed into `components/ui`: none of
 * them is general enough to earn a place in the design system, and the approval
 * screen is the only surface that needs "how long has this been waiting".
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { PlugZap, TriangleAlert, type LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';
import { TONE_TEXT, type Tone } from '../../lib/tone';
import { formatDuration, formatJson } from '../../lib/format';
import { Button, eyebrow, mono, textMuted } from '../../components/ui';

/* ------------------------------------------------------------------ */
/* Clock                                                               */
/* ------------------------------------------------------------------ */

/**
 * A slowly ticking `Date.now()`.
 *
 * "Waiting 4m" is a lie thirty seconds after it renders, and a queue is exactly
 * the place a stale number matters. The interval is deliberately coarse — this
 * re-renders every card, and nobody needs a second hand on a page whose job is
 * to be read carefully.
 *
 * The timer is created in an effect, so a server render gets one fixed instant
 * and no interval is ever left behind.
 */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return now;
}

/** `4m 12s` since `iso`. Empty string when the stamp is unusable. */
export function waitedFor(iso: string | undefined, now: number): string {
  if (!iso) return '';
  const started = new Date(iso).getTime();
  if (Number.isNaN(started)) return '';
  return formatDuration(Math.max(0, now - started));
}

/* ------------------------------------------------------------------ */
/* Metadata                                                            */
/* ------------------------------------------------------------------ */

export interface MetaItemProps {
  label: string;
  children: ReactNode;
  /** Render the value in the monospace stack — ids, tool names, paths. */
  code?: boolean;
  className?: string;
}

/** One `label value` pair on a card's metadata line. */
export function MetaItem({ label, children, code, className }: MetaItemProps) {
  return (
    <span className={cn('inline-flex items-baseline gap-1.5', className)}>
      <span className={cn(eyebrow, 'tracking-wide')}>{label}</span>
      <span
        className={cn(
          'truncate text-[11.5px] text-zinc-600 dark:text-zinc-400',
          code && mono,
        )}
      >
        {children}
      </span>
    </span>
  );
}

/** Thin vertical rule between metadata items. */
export function MetaDivider() {
  return (
    <span aria-hidden="true" className="text-zinc-300 dark:text-zinc-700">
      ·
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Channel failures                                                    */
/* ------------------------------------------------------------------ */

const PANEL: Record<Tone, string> = {
  neutral: 'border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/60',
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

export interface NoticePanelProps {
  tone?: Tone;
  icon?: LucideIcon;
  eyebrow?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  /** Verbatim machine text. Demoted below the prose, never the headline. */
  detail?: string;
  actions?: ReactNode;
  className?: string;
}

/** Tone rail, eyebrow, plain-language headline, raw detail last. */
export function NoticePanel({
  tone = 'neutral',
  icon: Icon,
  eyebrow: eyebrowText,
  title,
  children,
  detail,
  actions,
  className,
}: NoticePanelProps) {
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
      <div className="flex gap-3 px-4 py-3.5 pl-5">
        {Icon ? (
          <Icon
            size={16}
            aria-hidden="true"
            className={cn('mt-0.5 shrink-0', TONE_TEXT[tone])}
          />
        ) : null}
        <div className="min-w-0 flex-1">
          {eyebrowText ? (
            <p className={cn(eyebrow, 'mb-0.5')}>{eyebrowText}</p>
          ) : null}
          <p className="text-[13px] font-medium text-zinc-900 dark:text-zinc-100">
            {title}
          </p>
          {children ? (
            <div
              className={cn(
                'mt-1 text-xs leading-relaxed',
                'text-zinc-600 dark:text-zinc-400',
              )}
            >
              {children}
            </div>
          ) : null}
          {detail ? (
            <p className={cn('mt-2 truncate', mono, textMuted)}>{detail}</p>
          ) : null}
          {actions ? (
            <div className="mt-2.5 flex items-center gap-2">{actions}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export interface ChannelNoticeProps {
  /** The message the store recorded for the failed load. */
  message: string;
  /** True when the failure is "not wired up yet" rather than "went wrong". */
  unavailable: boolean;
  /** What could not be loaded, lower case: `the approval queue`. */
  what: string;
  onRetry?: () => void;
  className?: string;
}

/**
 * How a dead channel looks on this screen.
 *
 * The backend is not connected to the UI yet, so today this renders on every
 * load. It has to read as a state of the system — and, on this screen
 * specifically, it has to be unmistakable that an empty queue behind a dead
 * bridge is *unknown*, not *clear*. Saying "nothing is waiting on you" when we
 * cannot see the queue would be the single most damaging sentence in the
 * product.
 */
export function ChannelNotice({
  message,
  unavailable,
  what,
  onRetry,
  className,
}: ChannelNoticeProps) {
  const body = unavailable
    ? `This window has no connection to the approval gate, so ${what} cannot be read. Treat it as unknown rather than empty: anything the assistant is waiting on is still waiting, and none of it is shown here.`
    : `${what} could not be read. The approval gate keeps every pending request until it is answered, so nothing has been lost or auto-approved.`;

  return (
    <NoticePanel
      tone={unavailable ? 'warning' : 'danger'}
      icon={unavailable ? PlugZap : TriangleAlert}
      eyebrow={unavailable ? 'Not connected' : 'Read failed'}
      title={
        unavailable
          ? `Not connected to the app, so ${what} cannot load`
          : `Could not load ${what}`
      }
      detail={message}
      actions={
        onRetry ? (
          <Button size="xs" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        ) : null
      }
      className={className}
    >
      {body}
    </NoticePanel>
  );
}

/* ------------------------------------------------------------------ */
/* Argument rendering                                                  */
/* ------------------------------------------------------------------ */

/** `3 arguments` / `no arguments` — the label on the disclosure row. */
export function argumentCount(value: object | undefined): string {
  const keys = value ? Object.keys(value) : [];
  if (keys.length === 0) return 'no arguments';
  return keys.length === 1 ? '1 argument' : `${keys.length} arguments`;
}

/** Memoised pretty JSON, so a card re-render does not re-stringify arguments. */
export function usePrettyJson(value: unknown): string {
  return useMemo(() => formatJson(value), [value]);
}
