/**
 * Internal types for the schedule module.
 *
 * Nothing here crosses a process boundary as a *contract* — the wire types live
 * in `shared/schedule.ts`. These are the seams that make the scheduler testable
 * without waiting for wall-clock time and without spawning an engine: an
 * injectable clock and an injectable dispatcher.
 */
import type { ScheduledJob, ScheduleTrigger } from '../../../shared/schedule';

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

/** Why a job is firing right now. Defined in shared/, re-exported here. */
export type { ScheduleTrigger };

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
) =>
  Promise<{ runId?: string | null } | void> | { runId?: string | null } | void;

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
/* Missed runs and run history                                         */
/* ------------------------------------------------------------------ */

/**
 * These all live in `shared/schedule.ts` now — the jobs screen renders run
 * history over IPC, so the shapes are wire contract, not module internals.
 * Re-exported here so the module's own files keep importing from one place.
 */
export {
  MISSED_RUN_POLICIES,
  DEFAULT_MISSED_RUN_POLICY,
  isMissedRunPolicy,
  SCHEDULE_RUN_STATUSES,
  SCHEDULE_TRIGGERS,
} from '../../../shared/schedule';
export type {
  MissedRunPolicy,
  ScheduleRunStatus,
  ScheduleRunRecord,
} from '../../../shared/schedule';

/**
 * All-optional history query. `ScheduleHistoryQuery` in shared/ carries
 * defaults for `limit`/`offset` (it is parsed at the IPC edge); internally the
 * store wants them genuinely optional, which is the schema's *input* type.
 */
export type { ScheduleHistoryQueryInput as ScheduleHistoryQuery } from '../../../shared/schedule';
