/**
 * The cron-parser seam.
 *
 * Every parse in this module goes through here, for three reasons: cron-parser
 * v5 throws a *plain* `Error` with no `code` (so the message is the only thing
 * to surface), its timezone option is `tz` and not `timezone`, and it returns a
 * `CronDate` rather than a `Date`. Getting any of those wrong is silent.
 */
import { CronExpressionParser } from 'cron-parser';
import type { CronValidation } from '../../../shared/schedule';
import { describeCron } from './describe';

/** How many future occurrences {@link validateCron} previews. */
const PREVIEW_RUNS = 3;

/**
 * Ceiling on how many missed occurrences we will count when catching up.
 *
 * A job that was due every minute and the app was closed for a week has 10,080
 * occurrences behind it; counting them exactly is pointless work, and the only
 * consumer is a "you missed N runs" number.
 */
const MAX_MISSED_COUNT = 500;

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronError';
  }
}

/**
 * Next occurrence strictly after `fromMs`, in epoch milliseconds.
 *
 * @throws {CronError} when the expression or the timezone is not usable. Both
 * failure modes surface as a thrown plain `Error` from cron-parser — an invalid
 * `tz` fails late, inside `CronDate`, with "unhandled timestamp".
 */
export function nextRunAfter(
  cron: string,
  timezone: string,
  fromMs: number,
): number {
  try {
    const interval = CronExpressionParser.parse(cron, {
      tz: timezone || 'UTC',
      currentDate: new Date(fromMs),
    });
    return interval.next().toDate().getTime();
  } catch (cause) {
    throw new CronError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
}

/** {@link nextRunAfter} as an ISO string. */
export function nextRunIsoAfter(
  cron: string,
  timezone: string,
  fromMs: number,
): string {
  return new Date(nextRunAfter(cron, timezone, fromMs)).toISOString();
}

/** The next `count` occurrences after `fromMs`, as ISO strings. */
export function nextRuns(
  cron: string,
  timezone: string,
  fromMs: number,
  count: number,
): string[] {
  try {
    const interval = CronExpressionParser.parse(cron, {
      tz: timezone || 'UTC',
      currentDate: new Date(fromMs),
    });
    const out: string[] = [];
    for (let i = 0; i < count; i += 1) {
      out.push(interval.next().toDate().toISOString());
    }
    return out;
  } catch (cause) {
    throw new CronError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
}

/**
 * Occurrences strictly between `afterMs` and `untilMs`.
 *
 * Used to report how many firings a catch-up is collapsing, and how many a
 * `skip` policy dropped. Capped at {@link MAX_MISSED_COUNT}.
 */
export function countOccurrencesBetween(
  cron: string,
  timezone: string,
  afterMs: number,
  untilMs: number,
): number {
  if (untilMs <= afterMs) return 0;
  try {
    const interval = CronExpressionParser.parse(cron, {
      tz: timezone || 'UTC',
      currentDate: new Date(afterMs),
    });
    let count = 0;
    while (count < MAX_MISSED_COUNT) {
      const next = interval.next().toDate().getTime();
      if (next > untilMs) break;
      count += 1;
    }
    return count;
  } catch {
    // A job whose expression stopped parsing has no meaningful miss count.
    return 0;
  }
}

/**
 * Validate an expression and echo it back in English.
 *
 * This is the whole "plain-English schedule composer": the agent emits cron, we
 * confirm the shape and hand back a description a human can approve. There is
 * deliberately no natural-language *input* path.
 */
export function validateCron(
  cron: string,
  timezone = 'UTC',
  fromMs: number = Date.now(),
): CronValidation {
  const expression = (cron ?? '').trim();
  if (!expression) {
    return {
      valid: false,
      humanReadable: '',
      nextRuns: [],
      error: 'Cron expression is empty.',
    };
  }

  try {
    const runs = nextRuns(expression, timezone, fromMs, PREVIEW_RUNS);
    return {
      valid: true,
      humanReadable: describeCron(expression, timezone),
      nextRuns: runs,
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      valid: false,
      humanReadable: '',
      nextRuns: [],
      // cron-parser messages are terse ("Constraint error, got value 99
      // expected range 0-59") and do not name the expression.
      error: `Invalid cron expression "${expression}": ${message}`,
    };
  }
}

/** Throwing form, for the write paths. */
export function assertValidCron(cron: string, timezone: string): void {
  const result = validateCron(cron, timezone);
  if (!result.valid) throw new CronError(result.error ?? 'Invalid cron expression');
}
