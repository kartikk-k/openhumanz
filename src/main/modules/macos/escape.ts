/**
 * The one place a value is allowed to become AppleScript source.
 *
 * Treat this file as security-critical code. The agent that constructs the
 * arguments to a mail tool may have just read an email written by someone who
 * wants it to do something else; if any of that text can close a string literal
 * and open a statement, an attacker has arbitrary Apple Events under our signed
 * app's automation grants. That is the highest-severity failure available in
 * this product.
 *
 * The defence is layered, in order of preference:
 *
 *  1. **Do not interpolate at all.** Values travel to a script through
 *     `osascript`'s argv, which the kernel hands to the process as a vector of
 *     byte strings. There is no parser between the value and `on run argv`, so
 *     there is nothing to escape and nothing to get wrong. Every piece of
 *     agent-supplied data in this module goes this way. See `osascript.ts`.
 *  2. **Allowlist, where a literal is structurally required.**
 *     `tell application "Mail"` cannot take a runtime expression and keep its
 *     permission attribution, so the app name is interpolated — but only after
 *     an identity check against the fixed table in `apps.ts`. Nothing is escaped
 *     because nothing arbitrary is accepted. See {@link appleScriptAppLiteral}.
 *  3. **Escape, for anything else.** {@link appleScriptStringExpr} is the only
 *     function permitted to turn a free string into source, and
 *     {@link renderScript} is the only caller. It is exercised by an adversarial
 *     corpus in the tests because the day someone adds a data placeholder it has
 *     to already be right.
 *
 * ### Why the escaper emits an expression rather than a literal
 *
 * AppleScript string literals cannot contain a raw newline (that is an
 * unterminated-string compile error) and their behaviour with non-ASCII source
 * bytes depends on how `osascript` decided to decode the file, which varies by
 * locale and by macOS release. So the output of {@link appleScriptStringExpr} is
 * **pure ASCII**: printable ASCII goes in a quoted literal with `\\` and `\"`
 * escaped, and everything else — controls, newlines, accents, emoji, the
 * continuation character `¬` — is emitted as `(string id {…})`, AppleScript's
 * build-a-string-from-code-points constructor. The result is always parenthesised
 * so it is safe in any expression position, and it round-trips exactly.
 */
/* eslint-disable max-classes-per-file -- two small, closely-coupled error types. */
import { ALLOWED_APPLESCRIPT_NAMES } from './apps';

/**
 * Longest string this will turn into source. Well under any AppleScript limit;
 * the point is that a megabyte of quoted email body has no business being
 * compiled, and truncating silently would be worse than refusing.
 */
export const MAX_INTERPOLATED_LENGTH = 8192;

/** Raised instead of emitting something that might not mean what it says. */
export class AppleScriptEscapeError extends Error {
  readonly reason: 'too-long' | 'not-a-string' | 'app-not-allowed';

  constructor(reason: AppleScriptEscapeError['reason'], message: string) {
    super(message);
    this.name = 'AppleScriptEscapeError';
    this.reason = reason;
  }
}

/**
 * Codepoints that may appear unescaped inside a double-quoted AppleScript
 * literal: printable ASCII, minus `"` (ends the literal), `\` (starts an
 * escape) and `{`. Space is included; tab and newline are not.
 *
 * `{` is not dangerous inside a literal — it is excluded so the *output* can
 * never contain a `{{NAME}}` token. Without that, a value of `"{{APP_NAME}}"`
 * would be emitted verbatim inside a quoted literal, and a second pass of
 * {@link renderScript} over already-rendered source would substitute into it.
 * Nothing does that today; the point is that it cannot become a vulnerability
 * later, and the cost is a handful of extra characters on the rare string that
 * contains a brace.
 */
function isLiteralSafe(codePoint: number): boolean {
  if (codePoint === 0x22 || codePoint === 0x5c || codePoint === 0x7b) {
    return false;
  }
  return codePoint >= 0x20 && codePoint <= 0x7e;
}

/**
 * A string as an AppleScript *expression*, always parenthesised, always ASCII.
 *
 * ```
 * ''                    -> ("")
 * 'hi'                  -> ("hi")
 * 'a"b'                 -> ("a\"b")
 * 'a\nb'                -> ("a" & (string id {10}) & "b")
 * 'café'                -> ("caf" & (string id {233}))
 * ```
 *
 * The `string id {…}` form takes Unicode code points and is available in every
 * AppleScript 2.0 runtime (Mac OS X 10.5 onwards), so there is no version floor
 * to worry about. Astral characters are passed as their real code point rather
 * than a surrogate pair, which is what that constructor expects.
 */
export function appleScriptStringExpr(value: string): string {
  if (typeof value !== 'string') {
    throw new AppleScriptEscapeError(
      'not-a-string',
      `Refusing to interpolate a ${typeof value} into AppleScript source.`,
    );
  }
  if (value.length > MAX_INTERPOLATED_LENGTH) {
    throw new AppleScriptEscapeError(
      'too-long',
      `Refusing to interpolate ${value.length} characters into AppleScript source ` +
        `(limit ${MAX_INTERPOLATED_LENGTH}). Pass long values through osascript argv instead.`,
    );
  }
  if (value === '') return '("")';

  const parts: string[] = [];
  let literal = '';
  let codes: number[] = [];

  const flushLiteral = (): void => {
    if (literal !== '') {
      parts.push(`"${literal}"`);
      literal = '';
    }
  };
  const flushCodes = (): void => {
    if (codes.length > 0) {
      parts.push(`(string id {${codes.join(', ')}})`);
      codes = [];
    }
  };

  // Iterating the string yields whole code points, so a surrogate pair is one
  // step and lands in `codes` as a single value above 0xFFFF.
  for (const char of value) {
    const codePoint = char.codePointAt(0) as number;
    if (isLiteralSafe(codePoint)) {
      flushCodes();
      // Only `"` and `\` need escaping, and neither reaches here.
      literal += char;
    } else {
      flushLiteral();
      codes.push(codePoint);
    }
  }
  flushLiteral();
  flushCodes();

  return `(${parts.join(' & ')})`;
}

/**
 * An application name as a bare quoted literal, for `tell application "…"`.
 *
 * Not an escaper: the argument must already be one of the names in `apps.ts`.
 * Anything else throws, because an application name that came from outside that
 * table is by definition not a target we hold a permission grant for and not a
 * target we have reviewed.
 */
export function appleScriptAppLiteral(appleScriptName: string): string {
  if (!ALLOWED_APPLESCRIPT_NAMES.includes(appleScriptName)) {
    throw new AppleScriptEscapeError(
      'app-not-allowed',
      `"${appleScriptName}" is not one of the applications this module may target ` +
        `(${ALLOWED_APPLESCRIPT_NAMES.join(', ')}).`,
    );
  }
  // Every allowed name is plain ASCII letters and spaces; asserted by test.
  return `"${appleScriptName}"`;
}

/* ------------------------------------------------------------------ */
/* Templating                                                          */
/* ------------------------------------------------------------------ */

/** How a placeholder's value is turned into source. */
export type PlaceholderKind = 'app-name' | 'string';

export type PlaceholderKinds = Record<string, PlaceholderKind>;

const PLACEHOLDER_PATTERN = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

/** Every `{{NAME}}` token in a script body, in first-seen order. */
export function findPlaceholders(source: string): string[] {
  const seen = new Set<string>();
  for (const match of source.matchAll(PLACEHOLDER_PATTERN)) {
    seen.add(match[1]);
  }
  return [...seen];
}

/**
 * Substitute `{{NAME}}` tokens in a script body.
 *
 * Fails closed in both directions: a token in the source with no declared kind
 * throws, and a supplied value with no matching token throws. Silent
 * substitution failures in a code generator are how a `{{QUERY}}` ends up
 * shipped verbatim to a compiler, and the resulting error message never points
 * anywhere near the mistake.
 */
export function renderScript(
  source: string,
  kinds: PlaceholderKinds,
  values: Record<string, string>,
): string {
  const present = findPlaceholders(source);

  for (const name of present) {
    if (!(name in kinds)) {
      throw new AppleScriptEscapeError(
        'not-a-string',
        `Script uses {{${name}}} but no placeholder kind is declared for it.`,
      );
    }
    if (!(name in values)) {
      throw new AppleScriptEscapeError(
        'not-a-string',
        `Script uses {{${name}}} but no value was supplied.`,
      );
    }
  }
  for (const name of Object.keys(values)) {
    if (!present.includes(name)) {
      throw new AppleScriptEscapeError(
        'not-a-string',
        `Value supplied for {{${name}}}, which this script does not use.`,
      );
    }
  }

  return source.replace(PLACEHOLDER_PATTERN, (_match, name: string) => {
    const value = values[name];
    return kinds[name] === 'app-name'
      ? appleScriptAppLiteral(value)
      : appleScriptStringExpr(value);
  });
}

/* ------------------------------------------------------------------ */
/* argv                                                                */
/* ------------------------------------------------------------------ */

/**
 * Normalise a value for `osascript` argv.
 *
 * No escaping happens or is needed — `spawn` without a shell passes these
 * straight into `execve`. The only real constraint is that argv strings cannot
 * contain a NUL, so one is rejected rather than truncated: `execve` would cut
 * the string at the NUL and hand the script a silently shortened value, which
 * is precisely the "looks fine, means something else" class of bug this module
 * is trying to eliminate.
 */
export function toArg(
  value: string | number | boolean | Date | null | undefined,
): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : String(value.getTime());
  }
  return value;
}

/** Thrown when an argument cannot be represented in argv. */
export class ArgvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgvError';
  }
}

/** Longest single argv entry. `ARG_MAX` is ~1 MiB; this leaves plenty of room. */
export const MAX_ARG_LENGTH = 128 * 1024;

/** Validate and normalise a whole argv list. */
export function buildArgv(
  values: readonly (string | number | boolean | Date | null | undefined)[],
): string[] {
  return values.map((value, index) => {
    const arg = toArg(value);
    if (arg.includes('\0')) {
      throw new ArgvError(
        `Argument ${index + 1} contains a NUL byte, which cannot survive argv.`,
      );
    }
    if (arg.length > MAX_ARG_LENGTH) {
      throw new ArgvError(
        `Argument ${index + 1} is ${arg.length} characters, over the ${MAX_ARG_LENGTH} limit.`,
      );
    }
    return arg;
  });
}

/**
 * A Date as the six consecutive argv slots `dateFromParts` in the prelude
 * expects. Components rather than a formatted string, because AppleScript's
 * `date "…"` coercion parses in the user's locale and there is no locale-neutral
 * spelling of a date that it accepts.
 *
 * A null date becomes six zeroes, which the prelude reads as "not supplied".
 */
export function dateArgs(value: Date | null | undefined): string[] {
  if (!value || Number.isNaN(value.getTime())) {
    return ['0', '0', '0', '0', '0', '0'];
  }
  return [
    String(value.getFullYear()),
    String(value.getMonth() + 1),
    String(value.getDate()),
    String(value.getHours()),
    String(value.getMinutes()),
    String(value.getSeconds()),
  ];
}

/**
 * Newline-joined list for a script that reads a multi-value argument.
 *
 * Newline is a safe separator here because every list this is used for holds
 * email addresses, and an address containing a newline is rejected rather than
 * joined — a smuggled newline would turn one recipient into two.
 */
export function joinArgList(values: readonly string[]): string {
  for (const value of values) {
    if (/[\r\n]/.test(value)) {
      throw new ArgvError(
        'A list entry contains a line break, which would split it into two entries.',
      );
    }
  }
  return values.join('\n');
}
