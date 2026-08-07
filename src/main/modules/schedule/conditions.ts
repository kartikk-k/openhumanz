/**
 * The gate in front of every spawn.
 *
 * ARCHITECTURE.md, "Background work": *never put a CLI invocation on an
 * unconditional timer*. An unconditional five-minute heartbeat exhausts a
 * weekly subscription quota by Tuesday. So a condition is not an option on a
 * job, it is part of what a job *is* — `ScheduledJobSchema.condition` is
 * required and defaults to the one explicit escape hatch, `always`.
 *
 * Three properties every check here holds to:
 *
 *  1. **Cheap and deterministic.** A `stat`, an integer comparison, a clock
 *     read. No network, no engine, no subprocess. The check must cost orders of
 *     magnitude less than the thing it is gating.
 *  2. **Fails closed.** A missing file, an unreadable counter, a broken
 *     timezone — all of them *skip*. The expensive failure is spawning when we
 *     should not have; not spawning is always recoverable.
 *  3. **Explains itself.** Every outcome carries a sentence the jobs table can
 *     show verbatim ("no new mail (7 unread)"), because "skipped" with no
 *     reason is indistinguishable from "broken".
 *
 * Baselines (`lastSeenMtimeMs`, `lastSeenValue`) live inside the condition
 * object and are written back only when the condition passes, so a job cannot
 * re-fire on the same change.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ScheduleCondition } from '../../../shared/schedule';
import type { WorkspacePaths } from '../../infra/paths';
import type { CounterReader } from './types';

/** What an evaluation decided, and why. */
export interface ConditionOutcome {
  passed: boolean;
  /** Plain language, shown in the jobs table and stored in run history. */
  reason: string;
  /** Condition with its baseline advanced, when the check moved one. */
  next?: ScheduleCondition;
}

export interface ConditionContext {
  paths: WorkspacePaths;
  /** Epoch ms; comes from the injected clock so tests need not wait. */
  nowMs: number;
  /** Timezone for `time-window`. The job's zone, or the app default. */
  timezone: string;
  readCounter?: CounterReader;
}

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

/**
 * Absolute paths are taken as given (a user may watch `~/Downloads`); a
 * relative path resolves inside the workspace, where `paths.resolve` rejects
 * traversal back out.
 */
export function resolveWatchedPath(
  paths: WorkspacePaths,
  target: string,
): string {
  return path.isAbsolute(target) ? target : paths.resolve(target);
}

/**
 * Modification time in whole milliseconds.
 *
 * `stats.mtimeMs` is a **float** on every platform, and
 * `ScheduleConditionSchema.lastSeenMtimeMs` is `z.number().int()`. Storing the
 * raw value makes the condition fail to re-parse on the way back out of the
 * database, and a condition that will not parse is a gate that is not there.
 */
async function mtimeMs(file: string): Promise<number | null> {
  try {
    const stats = await fsp.stat(file);
    return Math.floor(stats.mtimeMs);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Time-window                                                         */
/* ------------------------------------------------------------------ */

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Local hour and weekday in an IANA zone.
 *
 * `Intl` rather than a date library — it is the platform capability the
 * dependency rules point at, and it is the only correct way to get a wall-clock
 * hour in another zone across a DST boundary.
 */
export function zonedHourAndWeekday(
  nowMs: number,
  timezone: string,
): { hour: number; minute: number; weekday: number } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    }).formatToParts(new Date(nowMs));

    let hour = -1;
    let minute = -1;
    let weekday = -1;
    for (const part of parts) {
      if (part.type === 'hour') hour = Number(part.value);
      else if (part.type === 'minute') minute = Number(part.value);
      else if (part.type === 'weekday') weekday = WEEKDAY_INDEX[part.value] ?? -1;
    }
    if (hour < 0 || minute < 0 || weekday < 0) return null;
    return { hour, minute, weekday };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Evaluation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Decide whether the job may spawn.
 *
 * Never throws: an exception here would either crash the scheduler loop or, if
 * caught carelessly upstream, be read as "proceed".
 */
export async function evaluateCondition(
  condition: ScheduleCondition,
  ctx: ConditionContext,
): Promise<ConditionOutcome> {
  try {
    switch (condition.kind) {
      case 'always':
        return { passed: true, reason: 'no condition (always)' };

      case 'file-changed': {
        const file = resolveWatchedPath(ctx.paths, condition.path);
        const current = await mtimeMs(file);
        if (current === null) {
          return { passed: false, reason: `file not found: ${condition.path}` };
        }
        const seen = condition.lastSeenMtimeMs;
        if (seen === undefined) {
          // First look. Record the baseline and skip — a job created today
          // should not fire on a file that was last touched last year.
          return {
            passed: false,
            reason: `first check, recorded baseline for ${condition.path}`,
            next: { ...condition, lastSeenMtimeMs: current },
          };
        }
        if (current <= seen) {
          return {
            passed: false,
            reason: `${condition.path} unchanged since last run`,
          };
        }
        return {
          passed: true,
          reason: `${condition.path} changed`,
          next: { ...condition, lastSeenMtimeMs: current },
        };
      }

      case 'counter-changed': {
        if (!ctx.readCounter) {
          return {
            passed: false,
            reason: `no reader for counter "${condition.source}"`,
          };
        }
        const current = await ctx.readCounter(condition.source);
        if (current === undefined || !Number.isFinite(current)) {
          return {
            passed: false,
            reason: `no reading for counter "${condition.source}"`,
          };
        }
        const seen = condition.lastSeenValue;
        if (seen === undefined) {
          return {
            passed: false,
            reason: `first check, recorded ${condition.source} = ${current}`,
            next: { ...condition, lastSeenValue: current },
          };
        }
        if (current === seen) {
          return {
            passed: false,
            reason: `${condition.source} unchanged (${current})`,
          };
        }
        return {
          passed: true,
          reason: `${condition.source} moved ${seen} -> ${current}`,
          next: { ...condition, lastSeenValue: current },
        };
      }

      case 'time-window': {
        const local = zonedHourAndWeekday(ctx.nowMs, ctx.timezone);
        if (!local) {
          return {
            passed: false,
            reason: `unusable timezone "${ctx.timezone}"`,
          };
        }
        const { startHour, endHour, weekdays } = condition;
        const inDay = weekdays.length === 0 || weekdays.includes(local.weekday);
        // Start inclusive, end exclusive. A window that wraps midnight
        // (start > end) is read as two pieces of the same day.
        const inHours =
          startHour <= endHour
            ? local.hour >= startHour && local.hour < endHour
            : local.hour >= startHour || local.hour < endHour;
        const window = `${String(startHour).padStart(2, '0')}:00-${String(endHour).padStart(2, '0')}:00`;
        if (!inDay) {
          return { passed: false, reason: `outside allowed days (${window})` };
        }
        if (!inHours) {
          return {
            passed: false,
            reason: `outside ${window} (local time ${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')})`,
          };
        }
        return { passed: true, reason: `inside ${window}` };
      }

      default: {
        // A condition kind we do not implement must not fall through to
        // "spawn anyway".
        const unknown = condition as { kind?: string };
        return {
          passed: false,
          reason: `unsupported condition kind "${String(unknown.kind)}"`,
        };
      }
    }
  } catch (cause) {
    return {
      passed: false,
      reason: `condition check failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}

/**
 * Baseline a condition at write time.
 *
 * Called when a job is created or its condition is edited, so the *first* cron
 * tick compares against reality rather than against `undefined`. Without this a
 * new `file-changed` job burns a run on its first firing every time.
 */
export async function seedCondition(
  condition: ScheduleCondition,
  ctx: Pick<ConditionContext, 'paths' | 'readCounter'>,
): Promise<ScheduleCondition> {
  try {
    if (condition.kind === 'file-changed') {
      const current = await mtimeMs(resolveWatchedPath(ctx.paths, condition.path));
      return current === null
        ? condition
        : { ...condition, lastSeenMtimeMs: current };
    }
    if (condition.kind === 'counter-changed' && ctx.readCounter) {
      const current = await ctx.readCounter(condition.source);
      return current === undefined || !Number.isFinite(current)
        ? condition
        : { ...condition, lastSeenValue: current };
    }
  } catch {
    /* seeding is best effort; an unseeded condition skips its first tick */
  }
  return condition;
}

/** One-line summary of a condition, for tool output and the jobs table. */
export function describeCondition(condition: ScheduleCondition): string {
  switch (condition.kind) {
    case 'always':
      return 'always (no precondition)';
    case 'file-changed':
      return `when ${condition.path} changes`;
    case 'counter-changed':
      return `when ${condition.source} changes`;
    case 'time-window': {
      const days =
        condition.weekdays.length === 0
          ? 'any day'
          : condition.weekdays
              .map(
                (d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d],
              )
              .join(', ');
      return `between ${String(condition.startHour).padStart(2, '0')}:00 and ${String(condition.endHour).padStart(2, '0')}:00 on ${days}`;
    }
    default:
      return 'unknown condition';
  }
}
