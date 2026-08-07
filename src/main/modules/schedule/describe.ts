/**
 * cron -> English.
 *
 * ARCHITECTURE.md forbids a natural-language date parser: the agent emits a
 * cron expression and we echo it back in English so a human can confirm it
 * before it becomes a recurring spend. That makes this file part of the
 * approval surface, which sets the rule it lives by:
 *
 *   **When a shape is not recognised, say the raw expression.**
 *
 * A wrong description is worse than no description — it gets confirmed. Every
 * branch below either matches exactly or gives up and returns the expression
 * unchanged.
 *
 * Descriptions are built from cron-parser's *expanded field values*, not from
 * the text, so `@daily`, `MON-FRI`, `1-5`, `*\/15` and `0,15,30,45` all describe
 * correctly without a second parser to keep in sync. Anything non-numeric in a
 * field (`L`, `W`, `#`) is a shape we do not claim to understand.
 */
import { CronExpressionParser } from 'cron-parser';

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** Result of a describe attempt, so callers can tell a description from a punt. */
export interface CronDescription {
  /** English, or the raw expression when `recognized` is false. */
  text: string;
  /** False means "this is the expression, not a description of it". */
  recognized: boolean;
}

/* ------------------------------------------------------------------ */
/* Small formatters                                                    */
/* ------------------------------------------------------------------ */

/**
 * 12-hour clock, written by hand rather than via `Intl`.
 *
 * `Intl` with `hour12` emits a narrow no-break space (U+202F) before AM/PM in
 * current ICU, which looks like a plain space, breaks string comparison, and
 * would silently churn every stored `humanReadable` on an ICU upgrade.
 */
export function formatTime(hour: number, minute: number): string {
  const suffix = hour < 12 ? 'AM' : 'PM';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

/** 1 -> "1st", 22 -> "22nd". */
export function ordinal(value: number): string {
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}

/** ["a"] -> "a"; ["a","b"] -> "a and b"; ["a","b","c"] -> "a, b and c". */
export function joinList(parts: string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Pluralise a count of units: (1,'minute') -> "minute", (5,'minute') -> "5 minutes". */
function every(count: number, unit: string): string {
  return count === 1 ? unit : `${count} ${unit}s`;
}

/* ------------------------------------------------------------------ */
/* Field analysis                                                      */
/* ------------------------------------------------------------------ */

/** Ascending, de-duplicated numbers, or null when the field is not all numbers. */
function numeric(values: readonly unknown[]): number[] | null {
  const out: number[] = [];
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isInteger(value)) return null;
    if (!out.includes(value)) out.push(value);
  }
  return out.sort((a, b) => a - b);
}

/** True when the field covers its whole domain — i.e. it is effectively `*`. */
function covers(values: number[], min: number, max: number): boolean {
  for (let i = min; i <= max; i += 1) if (!values.includes(i)) return false;
  return true;
}

/**
 * The step of an evenly spaced field that starts at its minimum and runs to the
 * end of its domain, or null. `*\/15` on minutes -> 15. `15,45` -> null (evenly
 * spaced but does not start at 0, so "every 30 minutes" would be a lie).
 */
function uniformStep(
  values: number[],
  min: number,
  max: number,
): number | null {
  if (values.length < 2 || values[0] !== min) return null;
  const step = values[1] - values[0];
  if (step <= 0) return null;
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] - values[i - 1] !== step) return null;
  }
  // Must run out the domain, otherwise it is a window, not a cadence.
  if (values[values.length - 1] + step <= max) return null;
  return step;
}

/** True when the values are consecutive: [9,10,11] -> true. */
function contiguous(values: number[]): boolean {
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] - values[i - 1] !== 1) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Clauses                                                             */
/* ------------------------------------------------------------------ */

/** "every Monday" / "every weekday" / "on Monday, Wednesday and Friday". */
function describeWeekdays(dow: number[]): string | null {
  // cron-parser normalises 7 to 0, so a restricted field is always 0-6.
  if (dow.some((d) => d < 0 || d > 6)) return null;
  const set = [...dow].sort((a, b) => a - b);
  if (set.length === 5 && set.join() === '1,2,3,4,5') return 'every weekday';
  if (set.length === 2 && set.join() === '0,6') return 'every weekend day';
  if (set.length === 1) return `every ${DAY_NAMES[set[0]]}`;
  return `on ${joinList(set.map((d) => DAY_NAMES[d]))}`;
}

/** "of every month" / "in January" / "in January and July". */
function describeMonths(months: number[], monthsAll: boolean): string {
  if (monthsAll) return 'every month';
  return joinList(months.map((m) => MONTH_NAMES[m - 1]));
}

/* ------------------------------------------------------------------ */
/* The describer                                                       */
/* ------------------------------------------------------------------ */

/**
 * Describe a cron expression in English.
 *
 * `timezone` is appended verbatim when given and not UTC — a schedule the user
 * is about to approve should not hide which clock it runs on.
 */
export function describeCronDetailed(
  expression: string,
  timezone?: string,
): CronDescription {
  const raw = expression.trim();
  const punt: CronDescription = { text: raw, recognized: false };

  let fields;
  try {
    fields = CronExpressionParser.parse(raw).fields;
  } catch {
    return punt;
  }

  const second = numeric(fields.second.values);
  const minute = numeric(fields.minute.values);
  const hour = numeric(fields.hour.values);
  const dom = numeric(fields.dayOfMonth.values);
  const month = numeric(fields.month.values);
  const dow = numeric(fields.dayOfWeek.values);
  if (!second || !minute || !hour || !dom || !month || !dow) return punt;

  const secondsAll = covers(second, 0, 59);
  const minutesAll = covers(minute, 0, 59);
  const hoursAll = covers(hour, 0, 23);
  const domAll = covers(dom, 1, 31);
  const monthsAll = covers(month, 1, 12);
  // `*` expands to 0-7 (both spellings of Sunday); a restriction never does.
  const dowAll = covers(dow, 0, 6);

  /* -------- seconds -------- */

  // We describe second-level cadence only in its simplest form. Anything else
  // (a seconds list, seconds combined with a restricted minute) is a shape we
  // do not claim to read back accurately.
  let secondClause = '';
  if (second.length === 1 && second[0] === 0) {
    secondClause = '';
  } else if (secondsAll && minutesAll && hoursAll) {
    secondClause = 'every second';
  } else {
    const step = uniformStep(second, 0, 59);
    if (step === null || !minutesAll || !hoursAll) return punt;
    secondClause = `every ${every(step, 'second')}`;
  }

  /* -------- the date part -------- */

  let datePart: string;
  if (domAll && dowAll) {
    datePart = monthsAll
      ? 'every day'
      : `every day in ${describeMonths(month, false)}`;
  } else if (domAll && !dowAll) {
    const days = describeWeekdays(dow);
    if (!days) return punt;
    datePart = monthsAll ? days : `${days} in ${describeMonths(month, false)}`;
  } else if (!domAll && dowAll) {
    if (dom.length > 3) return punt;
    const dayList = joinList(dom.map(ordinal));
    datePart = monthsAll
      ? `on the ${dayList} of every month`
      : `on ${describeMonths(month, false)} ${joinList(dom.map(String))}`;
  } else {
    // Both day-of-month and day-of-week restricted. cron ORs the two fields,
    // which almost nobody expects — refuse to paraphrase it.
    return punt;
  }

  /* -------- second-level cadence short-circuits the time part -------- */

  if (secondClause) {
    return finish(
      datePart === 'every day' ? secondClause : `${secondClause}, ${datePart}`,
      timezone,
    );
  }

  /* -------- the time part -------- */

  // (a) Sub-hour cadence: "every 5 minutes", optionally inside an hour window.
  if (minutesAll || uniformStep(minute, 0, 59) !== null) {
    const step = minutesAll ? 1 : (uniformStep(minute, 0, 59) as number);
    const cadence = `every ${every(step, 'minute')}`;

    let hourClause = '';
    if (!hoursAll) {
      if (!contiguous(hour)) return punt;
      const from = formatTime(hour[0], 0);
      const to = formatTime(hour[hour.length - 1], 59);
      hourClause =
        hour.length === 1
          ? ` during the ${formatTime(hour[0], 0)} hour`
          : ` between ${from} and ${to}`;
    }

    const suffix = datePart === 'every day' ? '' : `, ${datePart}`;
    return finish(`${cadence}${hourClause}${suffix}`, timezone);
  }

  // (b) Fixed minutes past every hour: "every hour at :30".
  if (hoursAll) {
    if (minute.length > 3) return punt;
    const at = joinList(minute.map((m) => `:${String(m).padStart(2, '0')}`));
    const suffix = datePart === 'every day' ? '' : `, ${datePart}`;
    const head =
      minute.length === 1 && minute[0] === 0
        ? 'every hour, on the hour'
        : `every hour at ${at}`;
    return finish(`${head}${suffix}`, timezone);
  }

  // (c) Specific times. Enumerate only while the list stays readable.
  if (hour.length * minute.length > 4) return punt;
  const times: string[] = [];
  for (const h of hour) for (const m of minute) times.push(formatTime(h, m));
  times.sort((a, b) => hourMinuteKey(a) - hourMinuteKey(b));
  return finish(`${datePart} at ${joinList(times)}`, timezone);
}

/** Sort key for the already-formatted times, so 9:00 AM precedes 5:00 PM. */
function hourMinuteKey(formatted: string): number {
  const match = /^(\d+):(\d+) (AM|PM)$/.exec(formatted);
  if (!match) return 0;
  let hour = Number(match[1]) % 12;
  if (match[3] === 'PM') hour += 12;
  return hour * 60 + Number(match[2]);
}

function finish(text: string, timezone?: string): CronDescription {
  const zone = timezone && timezone !== 'UTC' ? ` (${timezone})` : '';
  return { text: `${text}${zone}`, recognized: true };
}

/**
 * English for a cron expression, or the expression itself when its shape is not
 * one we describe. Never returns an inaccurate description.
 */
export function describeCron(expression: string, timezone?: string): string {
  return describeCronDetailed(expression, timezone).text;
}
