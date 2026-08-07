/**
 * Internal types for the schedule module.
 *
 * Nothing here crosses a process boundary as a *contract* — the wire types live
 * in `shared/schedule.ts`. These are the seams that make the scheduler testable
 * without waiting for wall-clock time and without spawning an engine: an
 * injectable clock and an injectable dispatcher.
 */
import type { ScheduledJob } from '../../../shared/schedule';

/* ------------------------------------------------------------------ */
/* Clock                                                               */
/* ------------------------------------------------------------------ */

/** Opaque timer handle. `setTimeout` returns a `Timeout`; a fake returns a number. */
export type TimerHandle = unknown;

/**
 * Everything the scheduler knows about time.
 *
 * The scheduler never measures elapsed time by counting how long a timer slept;
 * it always re-reads `now()` and compares against a stored absolute instant.
 * That is what makes a suspend/resume, a DST shift or an NTP correction a
 * non-event: the timer is only ever a hint that it may be worth looking again.
 */
export interface ScheduleClock {
  /** Epoch milliseconds. */
  now(): number;
  setTimer(fn: () => void, ms: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
}

/** The real clock. `unref` so a pending timer never holds the process open. */
export const systemClock: ScheduleClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimer: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */

/** Why a job is firing right now. */
export type ScheduleTrigger = 'cron' | 'catch-up' | 'manual';

/** What the dispatcher is told when a job's condition has passed. */
export interface ScheduleDispatch {
  job: ScheduledJob;
  trigger: ScheduleTrigger;
  /** The occurrence this dispatch is for, ISO-8601. */
  scheduledFor: string;
  /**
   * Occurrences that elapsed between `scheduledFor` and now and are being
   * collapsed into this one dispatch. Non-zero only for `catch-up`.
   */
  missedCount: number;
}

/**
 * How a due job reaches the rest of the app.
 *
 * The default emits `schedule:due` on the event bus and returns nothing — the
 * orchestrator subscribes and owns run creation. This module must never import
 * the runs module or the orchestrator, so the run id (if any) comes back
 * through this return value rather than through a call into a sibling.
 */
export type ScheduleDispatcher = (
  dispatch: ScheduleDispatch,
) => Promise<{ runId?: string | null } | void> | { runId?: string | null } | void;

/* ------------------------------------------------------------------ */
/* Conditions                                                          */
/* ------------------------------------------------------------------ */

/**
 * Reads the current value of a named counter source (`mail:unread`).
 *
 * Returns `undefined` when the source has no reading — which makes the
 * condition fail *closed*. Never spawning is always the safe error.
 */
export type CounterReader = (
  source: string,
) => number | undefined | Promise<number | undefined>;

/* ------------------------------------------------------------------ */
/* Missed runs                                                         */
/* ------------------------------------------------------------------ */

export const MISSED_RUN_POLICIES = ['skip', 'catch-up'] as const;
/**
 * What to do with an occurrence that came due while the app was closed (or
 * while the machine was asleep).
 *
 * - `skip`     — record the miss and move on to the next occurrence.
 * - `catch-up` — evaluate the condition now and dispatch once, collapsing every
 *                missed occurrence into a single run. Never a burst.
 */
export type MissedRunPolicy = (typeof MISSED_RUN_POLICIES)[number];

export const DEFAULT_MISSED_RUN_POLICY: MissedRunPolicy = 'skip';

export function isMissedRunPolicy(value: unknown): value is MissedRunPolicy {
  return (
    typeof value === 'string' &&
    (MISSED_RUN_POLICIES as readonly string[]).includes(value)
  );
}

/* ------------------------------------------------------------------ */
/* Run history                                                         */
/* ------------------------------------------------------------------ */

export const SCHEDULE_RUN_STATUSES = ['dispatched', 'skipped', 'error'] as const;
export type ScheduleRunStatus = (typeof SCHEDULE_RUN_STATUSES)[number];

/**
 * One evaluation of a job.
 *
 * Every wake-up writes one of these, including the ones that decided *not* to
 * spawn. The skip history is the evidence that the condition gate works; a
 * table full of `skipped / condition did not pass` rows is the design
 * succeeding, not failing.
 */
export interface ScheduleRunRecord {
  id: string;
  jobId: string;
  trigger: ScheduleTrigger;
  /** The cron occurrence being served, ISO-8601. Null for a manual run. */
  scheduledFor: string | null;
  startedAt: string;
  finishedAt: string;
  /** Wall time spent evaluating the condition and handing off the dispatch. */
  durationMs: number;
  status: ScheduleRunStatus;
  conditionKind: string;
  conditionPassed: boolean;
  /** Plain-language outcome, e.g. "unread count unchanged (7)". */
  conditionReason: string;
  missedCount: number;
  /** Set when the dispatcher came back with one. */
  runId: string | null;
  error: string | null;
}

/** Query for {@link ScheduleRunRecord} history. */
export interface ScheduleHistoryQuery {
  jobId?: string;
  status?: ScheduleRunStatus;
  limit?: number;
  offset?: number;
}
