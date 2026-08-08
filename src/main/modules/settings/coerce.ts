/**
 * Per-field degradation for hand-editable JSON state files.
 *
 * `settings.json` is a file a human is invited to open. Humans typo. The rule
 * this module exists to enforce is that **one bad value must not cost the user
 * the rest of their configuration**: a `"theme": "drak"` resets `ui.theme` and
 * nothing else, and the rejection is reported so it can be logged rather than
 * swallowed.
 *
 * A whole-object `safeParse` is tried first, so the happy path costs one parse.
 * Only when that fails do we walk the schema field by field, keeping every
 * value that parses and substituting the field's own default for every value
 * that does not.
 */
import { z } from 'zod';

/** One value the file offered and we refused, with enough context to fix it. */
export interface RejectedField {
  /** Dotted path, e.g. `ui.theme`. Empty string means the document itself. */
  path: string;
  /** Why it was refused, in zod's words. */
  reason: string;
  /** What was there, truncated. Never a secret — settings hold no secrets. */
  received: string;
}

export interface CoercionResult<T> {
  value: T;
  rejected: RejectedField[];
}

/** How much of a rejected value we quote back in the log line. */
const MAX_RECEIVED_CHARS = 120;

type UnknownRecord = Record<string, unknown>;
type AnyObjectSchema = z.ZodObject<z.ZodRawShape>;

function isPlainObject(value: unknown): value is UnknownRecord {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value)
  );
}

/** zod v4 keeps the kind on `_zod.def.type`; `instanceof` breaks across dupes. */
function schemaKind(schema: z.ZodType): string | undefined {
  return (schema as unknown as { _zod?: { def?: { type?: string } } })._zod?.def
    ?.type;
}

/**
 * Peel `.default()` / `.prefault()` / `.optional()` wrappers so we can see
 * whether the field underneath is an object worth recursing into.
 */
function unwrap(schema: z.ZodType): z.ZodType {
  let current = schema;
  for (;;) {
    const kind = schemaKind(current);
    if (kind !== 'default' && kind !== 'prefault' && kind !== 'optional') {
      return current;
    }
    const inner = (current as unknown as { unwrap?: () => z.ZodType }).unwrap;
    if (typeof inner !== 'function') return current;
    current = inner.call(current);
  }
}

function asObjectSchema(schema: z.ZodType): AnyObjectSchema | null {
  const inner = unwrap(schema);
  return schemaKind(inner) === 'object' ? (inner as AnyObjectSchema) : null;
}

function describe(value: unknown): string {
  if (value === undefined) return 'undefined';
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > MAX_RECEIVED_CHARS
    ? `${text.slice(0, MAX_RECEIVED_CHARS)}…`
    : text;
}

function firstIssue(error: z.ZodError, at: string): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid value';
  const where = issue.path.length > 0 ? issue.path.join('.') : at;
  return where && where !== at ? `${where}: ${issue.message}` : issue.message;
}

function join(prefix: string, key: string): string {
  return prefix ? `${prefix}.${key}` : key;
}

/**
 * The value a field falls back to.
 *
 * Parsing `undefined` is the honest way to ask a schema for its own default:
 * it yields the default for a `.default()`/`.prefault()` field and `undefined`
 * for a genuinely optional one, with no second source of truth to drift.
 */
function fallbackFor(schema: z.ZodType): unknown {
  const parsed = schema.safeParse(undefined);
  return parsed.success ? parsed.data : undefined;
}

function coerceField(
  schema: z.ZodType,
  value: unknown,
  path: string,
  rejected: RejectedField[],
): unknown {
  const direct = schema.safeParse(value);
  if (direct.success) return direct.data;

  const object = asObjectSchema(schema);
  if (object) {
    // A section: keep the leaves that parse rather than dropping the section.
    let source: UnknownRecord = {};
    if (isPlainObject(value)) {
      source = value;
    } else {
      rejected.push({
        path,
        reason: 'expected an object',
        received: describe(value),
      });
    }
    const out: UnknownRecord = {};
    for (const [key, field] of Object.entries(
      object.shape as Record<string, z.ZodType>,
    )) {
      out[key] = coerceField(field, source[key], join(path, key), rejected);
    }
    const reparsed = object.safeParse(out);
    // Cross-field refinements could still fail; the whole section then resets.
    if (reparsed.success) return reparsed.data;
    rejected.push({
      path,
      reason: firstIssue(reparsed.error, path),
      received: describe(value),
    });
    return fallbackFor(schema);
  }

  rejected.push({
    path,
    reason: firstIssue(direct.error, path),
    received: describe(value),
  });
  return fallbackFor(schema);
}

/** Keys in the file that the schema does not know about, one level deep. */
function collectUnknownKeys(
  schema: AnyObjectSchema,
  raw: unknown,
  path: string,
  rejected: RejectedField[],
): void {
  if (!isPlainObject(raw)) return;
  const shape = schema.shape as Record<string, z.ZodType>;
  for (const key of Object.keys(raw)) {
    const field = shape[key];
    if (!field) {
      rejected.push({
        path: join(path, key),
        reason: 'unknown key, ignored',
        received: describe(raw[key]),
      });
      continue;
    }
    const nested = asObjectSchema(field);
    if (nested) collectUnknownKeys(nested, raw[key], join(path, key), rejected);
  }
}

/**
 * Parse `raw` against `schema`, degrading field by field instead of failing.
 *
 * The returned value always parses clean; `rejected` lists everything that was
 * replaced by a default, including keys the schema does not recognise.
 */
export function coerceWithDefaults<S extends AnyObjectSchema>(
  schema: S,
  raw: unknown,
): CoercionResult<z.infer<S>> {
  const rejected: RejectedField[] = [];
  collectUnknownKeys(schema, raw, '', rejected);

  const direct = schema.safeParse(raw ?? {});
  if (direct.success) {
    return { value: direct.data as z.infer<S>, rejected };
  }

  let source: UnknownRecord = {};
  if (isPlainObject(raw)) {
    source = raw;
  } else if (raw !== undefined && raw !== null) {
    rejected.push({
      path: '',
      reason: 'expected a JSON object at the top level',
      received: describe(raw),
    });
  }

  const out: UnknownRecord = {};
  for (const [key, field] of Object.entries(
    schema.shape as Record<string, z.ZodType>,
  )) {
    out[key] = coerceField(field, source[key], key, rejected);
  }

  const repaired = schema.safeParse(out);
  if (repaired.success) {
    return { value: repaired.data as z.infer<S>, rejected };
  }

  // Nothing salvageable: fall all the way back to a factory-fresh object.
  rejected.push({
    path: '',
    reason: firstIssue(repaired.error, ''),
    received: describe(raw),
  });
  return { value: schema.parse({}) as z.infer<S>, rejected };
}

/** One-line rendering of a rejection list, for a log line. */
export function summarizeRejections(rejected: RejectedField[]): string {
  return rejected
    .map((item) => `${item.path || '<document>'} (${item.reason})`)
    .join(', ');
}
