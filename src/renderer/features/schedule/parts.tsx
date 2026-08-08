/**
 * Pieces the schedule screen uses in more than one place.
 *
 * The vocabulary lives here rather than in `lib/status.ts` because it is
 * schedule-specific: a *schedule run record* is not a run. It is one wake-up of
 * the scheduler, and three quarters of them are expected to end in `skipped`.
 *
 *  - {@link conditionMeta}    the deterministic gate, as a chip
 *  - {@link describeCondition} the gate, in a sentence
 *  - {@link scheduleRunMeta}  dispatched / skipped / error
 *  - {@link OutcomeLine}      "condition held — unread count unchanged (7)"
 *  - {@link BridgeNotice}     what a dead IPC channel looks like
 */
import type { ReactNode } from 'react';
import {
  CalendarClock,
  CircleSlash,
  FileClock,
  Gauge,
  Infinity as InfinityIcon,
  MinusCircle,
  PlayCircle,
  PlugZap,
  ShieldCheck,
  TriangleAlert,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type {
  MissedRunPolicy,
  ScheduleCondition,
  ScheduleConditionKind,
  ScheduleRunRecord,
  ScheduleRunStatus,
  ScheduleTrigger,
} from '../../../shared/schedule';
import { cn } from '../../lib/utils';
import { TONE_TEXT, type Tone } from '../../lib/tone';
import type { IpcError } from '../../lib/ipc';
import { Badge, CodeBlock } from '../../components/ui';
import { textMuted } from '../../components/ui/styles';

/* ------------------------------------------------------------------ */
/* Conditions                                                          */
/* ------------------------------------------------------------------ */

export interface ConditionMeta {
  label: string;
  icon: LucideIcon;
  tone: Tone;
  /** One line explaining what the gate buys, for a tooltip. */
  rationale: string;
}

/**
 * `always` is the only amber one on purpose.
 *
 * ARCHITECTURE.md: never put a CLI invocation on an unconditional timer — an
 * unconditional five-minute heartbeat exhausts a weekly quota by Tuesday. A
 * gated job is the normal, calm case and is coloured like one; the unguarded
 * job is the one worth noticing across a table of twenty.
 */
const CONDITION_META: Record<ScheduleConditionKind, ConditionMeta> = {
  always: {
    label: 'Always',
    icon: InfinityIcon,
    tone: 'warning',
    rationale:
      'Unconditional — the engine is spawned on every occurrence, whether or not anything changed.',
  },
  'file-changed': {
    label: 'File changed',
    icon: FileClock,
    tone: 'neutral',
    rationale:
      'Only spawns when the file’s mtime has moved since the last run.',
  },
  'counter-changed': {
    label: 'Counter changed',
    icon: Gauge,
    tone: 'neutral',
    rationale: 'Only spawns when the counter differs from the last value seen.',
  },
  'time-window': {
    label: 'Time window',
    icon: CalendarClock,
    tone: 'neutral',
    rationale: 'Only spawns inside the hours and weekdays named below.',
  },
};

export function conditionMeta(kind: ScheduleConditionKind): ConditionMeta {
  return CONDITION_META[kind] ?? CONDITION_META.always;
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function hour(value: number): string {
  return `${String(Math.max(0, Math.min(24, value))).padStart(2, '0')}:00`;
}

function weekdayList(days: readonly number[]): string {
  if (days.length === 0) return 'every day';
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const contiguous =
    sorted.length > 2 &&
    sorted[sorted.length - 1] - sorted[0] === sorted.length - 1;
  if (contiguous) {
    return `${WEEKDAY_NAMES[sorted[0]]}–${WEEKDAY_NAMES[sorted[sorted.length - 1]]}`;
  }
  return sorted.map((day) => WEEKDAY_NAMES[day] ?? String(day)).join(', ');
}

/** The gate as a sentence, e.g. `only if ~/mail.json has changed`. */
export function describeCondition(condition: ScheduleCondition): string {
  switch (condition.kind) {
    case 'file-changed':
      return `only if ${condition.path} changed`;
    case 'counter-changed':
      return `only if ${condition.source} moved`;
    case 'time-window':
      return `only ${hour(condition.startHour)}–${hour(condition.endHour)}, ${weekdayList(condition.weekdays)}`;
    case 'always':
    default:
      return 'no gate — runs every time';
  }
}

/** The gate's parameter on its own, for a second line in a dense cell. */
export function conditionDetail(condition: ScheduleCondition): string {
  switch (condition.kind) {
    case 'file-changed':
      return condition.path;
    case 'counter-changed':
      return condition.source;
    case 'time-window':
      return `${hour(condition.startHour)}–${hour(condition.endHour)} · ${weekdayList(condition.weekdays)}`;
    case 'always':
    default:
      return 'every occurrence';
  }
}

export const MISSED_RUN_POLICY_LABEL: Record<MissedRunPolicy, string> = {
  skip: 'Skip missed',
  'catch-up': 'Catch up',
};

export const MISSED_RUN_POLICY_HINT: Record<MissedRunPolicy, string> = {
  skip: 'Occurrences that came due while the app was closed are recorded and dropped.',
  'catch-up':
    'One run collapses every occurrence missed while the app was closed. Never a burst.',
};

/* ------------------------------------------------------------------ */
/* Run records                                                         */
/* ------------------------------------------------------------------ */

export interface ScheduleRunMeta {
  label: string;
  tone: Tone;
  icon: LucideIcon;
}

/**
 * `skipped` is neutral, not amber.
 *
 * A table full of `skipped / condition did not pass` rows is the design
 * succeeding. Colouring it as a warning would teach the user to read the
 * mechanism that protects their quota as a fault. Same call `stepStatusMeta`
 * already makes for skipped steps.
 */
const SCHEDULE_RUN_META: Record<ScheduleRunStatus, ScheduleRunMeta> = {
  dispatched: { label: 'Dispatched', tone: 'info', icon: PlayCircle },
  skipped: { label: 'Skipped', tone: 'neutral', icon: MinusCircle },
  error: { label: 'Error', tone: 'danger', icon: XCircle },
};

export function scheduleRunMeta(status: ScheduleRunStatus): ScheduleRunMeta {
  return SCHEDULE_RUN_META[status] ?? SCHEDULE_RUN_META.skipped;
}

export const TRIGGER_LABEL: Record<ScheduleTrigger, string> = {
  cron: 'On schedule',
  'catch-up': 'Catch-up',
  manual: 'Run now',
};

/**
 * The one-line outcome of an evaluation: did the gate pass, and what did it
 * say. This is the sentence that proves the gate works, so it is rendered as
 * prose rather than a chip.
 */
export function OutcomeLine({
  record,
  className,
}: {
  record: ScheduleRunRecord;
  className?: string;
}) {
  const outcome = (() => {
    if (record.error) {
      return { Icon: TriangleAlert, tone: 'danger' as Tone, lead: 'failed' };
    }
    if (record.conditionPassed) {
      return {
        Icon: ShieldCheck,
        tone: 'success' as Tone,
        lead: 'condition passed',
      };
    }
    return {
      Icon: CircleSlash,
      tone: 'neutral' as Tone,
      lead: 'condition held',
    };
  })();
  const { Icon, tone, lead } = outcome;

  return (
    <span className={cn('flex min-w-0 items-start gap-1.5', className)}>
      <Icon
        size={12}
        aria-hidden="true"
        className={cn('mt-[3px] shrink-0', TONE_TEXT[tone])}
      />
      <span className="min-w-0 text-[12px] leading-snug text-zinc-600 dark:text-zinc-400">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">
          {lead}
        </span>
        {record.error || record.conditionReason ? (
          <> — {record.error || record.conditionReason}</>
        ) : null}
      </span>
    </span>
  );
}

/**
 * The last thing a job produced, condensed to one line for the table.
 *
 * There is no stored "output" on a `ScheduledJob` — the useful preview is the
 * evaluation's own verdict, which is exactly what the user needs to see: the
 * error, or the reason the gate held, or the fact that a run was handed off.
 */
export function lastOutputPreview(
  record: ScheduleRunRecord | undefined,
): string {
  if (!record) return '';
  if (record.error) return record.error;
  if (record.conditionReason) return record.conditionReason;
  return record.conditionPassed
    ? 'Dispatched a run.'
    : 'Condition did not pass.';
}

/* ------------------------------------------------------------------ */
/* Channel failures                                                    */
/* ------------------------------------------------------------------ */

export interface BridgeNoticeProps {
  error: IpcError;
  /** What the user was trying to see, e.g. `the scheduled jobs`. */
  subject: string;
  actions?: ReactNode;
  className?: string;
}

/**
 * A dead channel, rendered honestly.
 *
 * Until the backend is wired to the UI every channel answers
 * `bridge_unavailable`, so this is not an edge case — it is the current
 * first-run experience, and it says which channel and why rather than showing
 * a spinner that never resolves.
 */
export function BridgeNotice({
  error,
  subject,
  actions,
  className,
}: BridgeNoticeProps) {
  const unavailable = error.isUnavailable;
  const tone: Tone = unavailable ? 'warning' : 'danger';

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-lg border',
        unavailable
          ? 'border-amber-300 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-500/10'
          : 'border-rose-300 bg-rose-50 dark:border-rose-500/40 dark:bg-rose-500/10',
        className,
      )}
    >
      <div className="flex gap-3 px-4 py-3.5">
        {unavailable ? (
          <PlugZap
            size={17}
            aria-hidden="true"
            className={cn('mt-0.5 shrink-0', TONE_TEXT[tone])}
          />
        ) : (
          <TriangleAlert
            size={17}
            aria-hidden="true"
            className={cn('mt-0.5 shrink-0', TONE_TEXT[tone])}
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-semibold text-zinc-900 dark:text-zinc-100">
            {unavailable
              ? `The scheduler is not answering yet, so ${subject} cannot be loaded.`
              : `Could not load ${subject}.`}
          </p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-zinc-700 dark:text-zinc-300">
            {unavailable
              ? 'The main process has not registered this channel. Nothing is lost — the screen fills in the moment it does.'
              : error.message}
          </p>
          <CodeBlock
            code={`${error.channel}\n${error.code}: ${error.message}`}
            language="ipc"
            wrap
            className="mt-2.5 bg-white/70 dark:bg-zinc-950/60"
          />
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

/* ------------------------------------------------------------------ */
/* Small shared bits                                                   */
/* ------------------------------------------------------------------ */

/** A label/value pair for the detail rail. */
export function DetailRow({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex gap-3 py-1', className)}>
      <span className={cn('w-24 shrink-0 text-[11px] leading-5', textMuted)}>
        {label}
      </span>
      <span className="min-w-0 flex-1 text-[12.5px] leading-5 text-zinc-700 dark:text-zinc-300">
        {children}
      </span>
    </div>
  );
}

/** The condition as a chip plus its parameter. Used in the table and the rail. */
export function ConditionChip({
  condition,
  showDetail = true,
}: {
  condition: ScheduleCondition;
  showDetail?: boolean;
}) {
  const meta = conditionMeta(condition.kind);
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <Badge
        tone={meta.tone}
        variant={condition.kind === 'always' ? 'soft' : 'outline'}
        icon={meta.icon}
        title={meta.rationale}
      >
        {meta.label}
      </Badge>
      {showDetail && condition.kind !== 'always' ? (
        <span
          className={cn('truncate text-[11px] leading-4', textMuted)}
          title={conditionDetail(condition)}
        >
          {conditionDetail(condition)}
        </span>
      ) : null}
    </span>
  );
}
