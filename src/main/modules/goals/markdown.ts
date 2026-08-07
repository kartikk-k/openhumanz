/**
 * `GOALS.md` — parse and render.
 *
 * The file is the source of truth, not a cache of the database, which means a
 * human with a text editor is a first-class writer and every parse has to assume
 * the file has been mangled since we last saw it. Two properties carry that:
 *
 *  1. **Nothing throws.** Every malformed construct degrades to text we keep.
 *     A file we cannot understand still round-trips; the worst case is a goal
 *     whose fields we did not recognise, not a lost goal.
 *  2. **Untouched goals are re-emitted byte-for-byte.** {@link renderGoalsFile}
 *     writes back the *original source block* of every goal the caller did not
 *     edit, so hand-formatting, ordering and stray whitespace survive a write.
 *     Only the edited goal is re-rendered from its fields.
 *
 * Ids live in the heading as `## [g2] Title`. They are stable: reordering the
 * file reorders the goals, it does not renumber them. A goal whose id a human
 * deleted gets a fresh one on the next write, which is the only lossy case and
 * the only one where there is nothing to recover.
 */
import type { JsonObject } from '../../../shared/common';
import { nowIso } from '../../../shared/common';
import {
  GOAL_HORIZONS,
  GOAL_STATUSES,
  Goal,
  GoalHorizon,
  GoalStatus,
} from '../../../shared/tasks';
import { GOAL_ID_PATTERN } from './schema';

/* ------------------------------------------------------------------ */
/* Shapes                                                              */
/* ------------------------------------------------------------------ */

export interface ParsedGoal {
  goal: Goal;
  /** The exact source block, heading included, as it appeared in the file. */
  raw: string;
  /** The heading line as it appeared, for id injection. */
  headingLine: string;
  /** False when the heading carried no id and one was assigned. */
  hadId: boolean;
}

export interface ParsedGoalsFile {
  /** Everything before the first goal heading, kept verbatim. */
  preamble: string;
  goals: ParsedGoal[];
  /** Ids we invented because the file did not have them. */
  assignedIds: string[];
  /** Lines we could not classify, for diagnostics. Never dropped from `raw`. */
  warnings: string[];
  /**
   * High-water mark from the `<!-- next-id: gN -->` marker.
   *
   * Without it, deleting `g2` and adding a goal would hand the new goal the id
   * `g2`, and every earlier transcript that mentions `g2` would quietly start
   * referring to something else. Ids are cheap; recycling them is not.
   */
  nextIdHint: number;
}

/* ------------------------------------------------------------------ */
/* Patterns                                                            */
/* ------------------------------------------------------------------ */

const HEADING = /^(#{1,6})[ \t]+(.*)$/;
const FENCE = /^[ \t]{0,3}(```|~~~)/;
/** `[g2] Title`, `g2. Title`, `g2) Title`, `g2: Title`. */
const HEADING_ID =
  /^[ \t]*(?:\[[ \t]*(g\d+)[ \t]*\]|(g\d+)[ \t]*[.):])[ \t]*(.*)$/i;
/** An optional bullet, a key, a colon, a value. */
const FIELD =
  /^[ \t]*([-*+][ \t]+)?([A-Za-z][A-Za-z0-9 _-]*?)[ \t]*:[ \t]*(.*)$/;

const KNOWN_FIELDS: Record<
  string,
  'horizon' | 'status' | 'metric' | 'targetDate' | 'createdAt' | 'updatedAt'
> = {
  horizon: 'horizon',
  timeframe: 'horizon',
  status: 'status',
  state: 'status',
  metric: 'metric',
  measure: 'metric',
  success: 'metric',
  target: 'targetDate',
  targetdate: 'targetDate',
  deadline: 'targetDate',
  created: 'createdAt',
  createdat: 'createdAt',
  updated: 'updatedAt',
  updatedat: 'updatedAt',
};

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]+/g, '');
}

/* ------------------------------------------------------------------ */
/* Parse                                                               */
/* ------------------------------------------------------------------ */

interface Block {
  headingLine: string;
  level: number;
  headingText: string;
  bodyLines: string[];
}

/**
 * Split the file into a preamble and one block per goal heading.
 *
 * A heading starts a goal when it carries an id, or when it is level 2 or
 * deeper. A bare `# Goals` at the top is therefore a document title and stays in
 * the preamble; a later level-1 heading with no id is treated as body text of
 * the goal above it, which keeps it in the file rather than inventing a goal
 * from a section divider.
 */
function splitBlocks(source: string): { preamble: string[]; blocks: Block[] } {
  const preamble: string[] = [];
  const blocks: Block[] = [];
  let current: Block | null = null;
  let inFence = false;

  for (const line of source.split('\n')) {
    if (FENCE.test(line)) inFence = !inFence;

    const heading = inFence ? null : HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();
      const isGoal = level >= 2 || HEADING_ID.test(text);
      if (isGoal) {
        current = {
          headingLine: line,
          level,
          headingText: text,
          bodyLines: [],
        };
        blocks.push(current);
        continue;
      }
    }

    if (current) current.bodyLines.push(line);
    else preamble.push(line);
  }

  return { preamble, blocks };
}

function coerceEnum<T extends string>(
  value: string,
  allowed: readonly T[],
): T | null {
  const needle = value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  const hit = allowed.find((option) => option === needle);
  return hit ?? null;
}

interface FieldBag {
  horizon?: GoalHorizon;
  status?: GoalStatus;
  metric?: string;
  targetDate?: string;
  createdAt?: string;
  updatedAt?: string;
  metadata: JsonObject;
  descriptionLines: string[];
  warnings: string[];
}

/** Read a goal body: field lines into fields, everything else into prose. */
function parseBody(bodyLines: string[], id: string): FieldBag {
  const bag: FieldBag = {
    metadata: {},
    descriptionLines: [],
    warnings: [],
  };
  const extras: { key: string; value: string }[] = [];
  let inFence = false;

  for (const line of bodyLines) {
    if (FENCE.test(line)) inFence = !inFence;

    const match = inFence ? null : FIELD.exec(line);
    if (!match) {
      bag.descriptionLines.push(line);
      continue;
    }

    const bulleted = Boolean(match[1]);
    const rawKey = match[2];
    const value = match[3].trim();
    const known = KNOWN_FIELDS[normalizeKey(rawKey)];

    // A bare `Note: remember to call Ana` is prose, not a field. Only bulleted
    // lines may introduce an unknown key.
    if (!known && !bulleted) {
      bag.descriptionLines.push(line);
      continue;
    }

    if (!known) {
      extras.push({ key: rawKey.trim(), value });
      continue;
    }

    if (known === 'horizon') {
      const parsed = coerceEnum(value, GOAL_HORIZONS);
      if (parsed) bag.horizon = parsed;
      else if (value) {
        // Keep what the human wrote so a rewrite does not silently correct it.
        bag.metadata.horizonAsWritten = value;
        bag.warnings.push(`${id}: unrecognised horizon "${value}"`);
      }
    } else if (known === 'status') {
      const parsed = coerceEnum(value, GOAL_STATUSES);
      if (parsed) bag.status = parsed;
      else if (value) {
        bag.metadata.statusAsWritten = value;
        bag.warnings.push(`${id}: unrecognised status "${value}"`);
      }
    } else if (value) {
      bag[known] = value;
    }
  }

  if (extras.length > 0) bag.metadata.extraFields = extras;
  return bag;
}

/** Strip leading and trailing blank lines without touching the inside. */
function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start += 1;
  while (end > start && lines[end - 1].trim() === '') end -= 1;
  return lines.slice(start, end);
}

/** `<!-- next-id: g7 -->`. Written into the preamble, stripped on parse. */
const NEXT_ID_MARKER =
  /^[ \t]*<!--[ \t]*next-id:[ \t]*g(\d+)[ \t]*-->[ \t]*$/im;

/** Highest id number in use, or 0. */
function highestId(taken: Iterable<string>): number {
  let max = 0;
  for (const id of taken) {
    const match = /^g(\d+)$/.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

/**
 * The next free id: one past the highest number ever used, not one past the
 * highest currently present. `hint` carries the high-water mark across deletes.
 */
export function nextGoalId(taken: Iterable<string>, hint = 0): string {
  return `g${Math.max(highestId(taken) + 1, hint)}`;
}

export interface ParseOptions {
  /** Fallback for `createdAt` / `updatedAt` when the file records neither. */
  defaultTimestamp?: string;
}

/**
 * Parse `GOALS.md`. Never throws.
 *
 * Duplicate ids in the file (a human copy-pasting a goal) are resolved by
 * keeping the first and assigning the later one a fresh id, because two goals
 * answering to `g2` is the one state that would make every later edit ambiguous.
 */
export function parseGoalsFile(
  source: string,
  options: ParseOptions = {},
): ParsedGoalsFile {
  const timestamp = options.defaultTimestamp ?? nowIso();
  const normalized = source.replace(/\r\n?/g, '\n');
  const { preamble, blocks } = splitBlocks(normalized);

  const markerLine = preamble.findIndex((line) => NEXT_ID_MARKER.test(line));
  const marker =
    markerLine === -1 ? null : NEXT_ID_MARKER.exec(preamble[markerLine]);
  const nextIdHint = marker ? Number(marker[1]) : 0;
  // Stripped here and re-emitted by the renderer, so it cannot accumulate.
  const preambleLines =
    markerLine === -1
      ? preamble
      : [...preamble.slice(0, markerLine), ...preamble.slice(markerLine + 1)];

  const taken = new Set<string>();
  const assignedIds: string[] = [];
  const warnings: string[] = [];

  // First pass: claim the explicit ids, so assignment never collides with one.
  const headings = blocks.map((block) => {
    const match = HEADING_ID.exec(block.headingText);
    const id = (match?.[1] ?? match?.[2])?.toLowerCase();
    const title = (match ? match[3] : block.headingText).trim();
    return { id, title };
  });
  for (const heading of headings) {
    if (
      heading.id &&
      GOAL_ID_PATTERN.test(heading.id) &&
      !taken.has(heading.id)
    ) {
      taken.add(heading.id);
    }
  }

  const goals: ParsedGoal[] = [];

  blocks.forEach((block, index) => {
    const heading = headings[index];
    let { id } = heading;
    let hadId = Boolean(id);

    if (id && goals.some((existing) => existing.goal.id === id)) {
      warnings.push(`duplicate id "${id}" — the second one was renumbered`);
      id = undefined;
      hadId = false;
    }
    if (!id) {
      id = nextGoalId(taken, nextIdHint);
      taken.add(id);
      assignedIds.push(id);
    }

    const bag = parseBody(block.bodyLines, id);
    warnings.push(...bag.warnings);

    const title = heading.title || '(untitled goal)';
    if (!heading.title) {
      warnings.push(`${id}: heading had no title text`);
    }

    goals.push({
      goal: {
        id,
        title,
        description: trimBlankEdges(bag.descriptionLines).join('\n'),
        horizon: bag.horizon ?? 'quarter',
        status: bag.status ?? 'active',
        metric: bag.metric ?? '',
        targetDate: bag.targetDate,
        order: index,
        createdAt: bag.createdAt ?? timestamp,
        updatedAt: bag.updatedAt ?? bag.createdAt ?? timestamp,
        metadata: bag.metadata,
      },
      raw: [block.headingLine, ...trimBlankEdges(block.bodyLines)].join('\n'),
      headingLine: block.headingLine,
      hadId,
    });
  });

  return {
    preamble: trimBlankEdges(preambleLines).join('\n'),
    goals,
    assignedIds,
    warnings,
    nextIdHint,
  };
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

export const DEFAULT_PREAMBLE = [
  '# Goals',
  '',
  'Long-term goals, in priority order. This file is the source of truth — edit it',
  'by hand whenever you like. Keep the `[g1]` ids: they are how the assistant',
  'refers to a goal, and deleting one makes it a new goal.',
].join('\n');

function fieldLine(key: string, value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? `- ${key}: ${trimmed}` : null;
}

function extraFieldsOf(goal: Goal): { key: string; value: string }[] {
  const extras = goal.metadata.extraFields;
  if (!Array.isArray(extras)) return [];
  return extras.filter(
    (entry): entry is { key: string; value: string } =>
      Boolean(entry) &&
      typeof entry === 'object' &&
      typeof (entry as { key?: unknown }).key === 'string' &&
      typeof (entry as { value?: unknown }).value === 'string',
  );
}

function asWritten(
  goal: Goal,
  field: 'horizon' | 'status',
): string | undefined {
  const value = goal.metadata[`${field}AsWritten`];
  return typeof value === 'string' ? value : undefined;
}

/** One goal as a markdown block. Used for new and edited goals. */
export function renderGoal(goal: Goal, level = 2): string {
  const lines: string[] = [`${'#'.repeat(level)} [${goal.id}] ${goal.title}`];

  const fields = [
    fieldLine('horizon', asWritten(goal, 'horizon') ?? goal.horizon),
    fieldLine('status', asWritten(goal, 'status') ?? goal.status),
    fieldLine('metric', goal.metric),
    fieldLine('target', goal.targetDate),
    ...extraFieldsOf(goal).map((entry) => fieldLine(entry.key, entry.value)),
    // Written because "how long have I been carrying this goal?" is one of the
    // few things about a goal worth knowing that cannot be re-derived. `updated`
    // is deliberately *not* written: the file's mtime already answers it, and a
    // timestamp that changes on every write makes the file noisy in git.
    fieldLine('created', goal.createdAt),
  ].filter((line): line is string => line !== null);

  if (fields.length > 0) lines.push('', ...fields);
  if (goal.description.trim()) lines.push('', goal.description.trim());

  return lines.join('\n');
}

/** Put an id into a heading that lacks one, leaving the rest of it alone. */
export function injectId(headingLine: string, id: string): string {
  const heading = HEADING.exec(headingLine);
  if (!heading) return `## [${id}] ${headingLine.trim()}`;
  return `${heading[1]} [${id}] ${heading[2].trim()}`;
}

export interface RenderOptions {
  /** Ids whose block must be re-rendered from fields rather than reused. */
  changed?: Iterable<string>;
  preamble?: string;
}

/**
 * Write the file back.
 *
 * Goals not named in `changed` are emitted from their captured source, so a
 * write triggered by editing one goal cannot reformat the other seven.
 */
export function renderGoalsFile(
  parsed: ParsedGoalsFile,
  options: RenderOptions = {},
): string {
  const changed = new Set(options.changed ?? []);
  const preamble = (options.preamble ?? parsed.preamble ?? '').trim();

  const blocks = parsed.goals.map((entry) => {
    if (changed.has(entry.goal.id) || !entry.raw.trim()) {
      return renderGoal(entry.goal);
    }
    if (entry.hadId) return entry.raw.trim();
    // Untouched, but the file never named it. Add the id, keep everything else.
    const [, ...rest] = entry.raw.split('\n');
    return [injectId(entry.headingLine, entry.goal.id), ...rest]
      .join('\n')
      .trim();
  });

  const next = Math.max(
    highestId(parsed.goals.map((entry) => entry.goal.id)) + 1,
    parsed.nextIdHint ?? 0,
  );
  const head = `${preamble || DEFAULT_PREAMBLE}\n\n<!-- next-id: g${next} -->`;

  const body = blocks.join('\n\n');
  return body ? `${head}\n\n${body}\n` : `${head}\n`;
}

/* ------------------------------------------------------------------ */
/* Compact rendering, for the agent                                    */
/* ------------------------------------------------------------------ */

/**
 * The smallest useful rendering: one line per goal.
 *
 * This is what goes into a prompt, so it is measured in tokens rather than
 * fields. Description is dropped entirely — a goal that needs a paragraph to be
 * understood mid-conversation is not doing its job as a goal.
 */
export function renderGoalsCompact(goals: Goal[]): string {
  if (goals.length === 0) return 'No goals set.';
  return goals
    .map((goal) => {
      const bits: string[] = [goal.horizon];
      if (goal.status !== 'active') bits.push(goal.status);
      if (goal.targetDate) bits.push(`by ${goal.targetDate.slice(0, 10)}`);
      if (goal.metric) bits.push(goal.metric);
      return `- [${goal.id}] ${goal.title} (${bits.join(', ')})`;
    })
    .join('\n');
}
