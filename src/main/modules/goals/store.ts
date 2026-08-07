/**
 * Goal storage: a markdown file, and nothing else.
 *
 * There is no goals table. Eight items do not need an index, and putting them in
 * SQLite would mean the thing a user most wants to read and edit by hand lives
 * in an opaque store — exactly what the storage rule in ARCHITECTURE.md exists
 * to prevent. Every read stats the file and re-parses it when it has moved, so a
 * hand edit is picked up with no watcher and no cache invalidation protocol.
 *
 * Every write is read-modify-write against the file as it is on disk *right
 * now*, then an atomic replace. A user editing in one window and the agent
 * writing from another cannot interleave into a corrupt file; the worst case is
 * a lost edit, and the atomic rename means never a truncated one.
 */
import path from 'node:path';
import { readTextFile, statOrNull, writeTextFileAtomic } from '../../infra/files';
import { nowIso } from '../../../shared/common';
import type { Goal, GoalQuery, GoalWrite } from '../../../shared/tasks';
import {
  GOALS_FILENAME,
  GoalBudgetError,
  MAX_GOALS,
  MAX_GOAL_TOKENS,
  estimateTokens,
} from './schema';
import {
  DEFAULT_PREAMBLE,
  ParsedGoal,
  ParsedGoalsFile,
  nextGoalId,
  parseGoalsFile,
  renderGoalsCompact,
  renderGoalsFile,
} from './markdown';

export interface GoalBudget {
  count: number;
  maxCount: number;
  /** Estimated tokens of the compact rendering — what gets injected per turn. */
  tokens: number;
  maxTokens: number;
  /** True when the file is already over one of the limits. */
  overBudget: boolean;
}

export interface GoalStore {
  readonly filePath: string;
  /** The whole file, parsed. Cheap: cached on mtime. */
  read(): Promise<ParsedGoalsFile>;
  list(query?: GoalQuery): Promise<Goal[]>;
  get(id: string): Promise<Goal | null>;
  /** Create or update. Returns the stored goal, ids and all. */
  write(input: GoalWrite): Promise<Goal>;
  remove(id: string): Promise<boolean>;
  budget(): Promise<GoalBudget>;
  /** The per-turn rendering, already capped. */
  compact(limit?: number): Promise<{
    markdown: string;
    count: number;
    truncated: number;
    budget: GoalBudget;
  }>;
  /**
   * Persist ids the parser had to invent, so they stop moving. No-op when the
   * file already names every goal.
   */
  normalizeIds(): Promise<string[]>;
}

/** Item and token cost of a goal list, measured on what actually gets injected. */
export function measure(goals: Goal[]): GoalBudget {
  const tokens = estimateTokens(renderGoalsCompact(goals));
  return {
    count: goals.length,
    maxCount: MAX_GOALS,
    tokens,
    maxTokens: MAX_GOAL_TOKENS,
    overBudget: goals.length > MAX_GOALS || tokens > MAX_GOAL_TOKENS,
  };
}

/**
 * Enforce the caps.
 *
 * Forgiving in one direction on purpose: a file a human filled with twelve goals
 * still opens, still lists, and can still be *edited down*. What is refused is a
 * write that makes an over-budget list worse — which is the only moment where
 * refusing costs the user nothing and saves them a per-turn tax forever.
 */
function assertWithinBudget(
  before: GoalBudget,
  after: GoalBudget,
  goals: Goal[],
): void {
  if (after.count > MAX_GOALS && after.count > before.count) {
    const existing = goals
      .slice(0, MAX_GOALS)
      .map((goal) => `${goal.id} (${goal.title})`)
      .join(', ');
    throw new GoalBudgetError(
      `Long-term goals are capped at ${MAX_GOALS}; there are already ${before.count}. ` +
        `Drop or finish one first — currently: ${existing}.`,
    );
  }
  if (after.tokens > MAX_GOAL_TOKENS && after.tokens > before.tokens) {
    throw new GoalBudgetError(
      `The goal list is injected into every turn and is capped at ~${MAX_GOAL_TOKENS} tokens; ` +
        `this write would take it to ~${after.tokens}. Shorten a title or a metric.`,
    );
  }
}

export interface GoalStoreOptions {
  /** Workspace root. The file is `<root>/GOALS.md`. */
  root: string;
}

export function createGoalStore(options: GoalStoreOptions): GoalStore {
  const filePath = path.join(options.root, GOALS_FILENAME);

  let cache: { key: string; parsed: ParsedGoalsFile } | null = null;
  /** Serialises writes so two concurrent upserts cannot both win. */
  let queue: Promise<unknown> = Promise.resolve();

  const readParsed = async (): Promise<ParsedGoalsFile> => {
    const stats = await statOrNull(filePath);
    const key = stats ? `${stats.mtimeMs}:${stats.size}` : 'missing';
    if (cache && cache.key === key) return cache.parsed;

    const raw = (await readTextFile(filePath)) ?? '';
    const parsed = parseGoalsFile(raw, {
      defaultTimestamp: stats ? new Date(stats.mtimeMs).toISOString() : nowIso(),
    });
    cache = { key, parsed };
    return parsed;
  };

  const commit = async (
    parsed: ParsedGoalsFile,
    changed: string[],
  ): Promise<void> => {
    const text = renderGoalsFile(parsed, {
      changed,
      preamble: parsed.preamble || DEFAULT_PREAMBLE,
    });
    await writeTextFileAtomic(filePath, text);
    cache = null;
  };

  /** Run a read-modify-write turn with nothing else interleaved. */
  const mutate = async <T>(
    fn: (parsed: ParsedGoalsFile) => Promise<T> | T,
  ): Promise<T> => {
    const run = queue.then(async () => {
      cache = null; // always re-read: the file may have been hand-edited
      const parsed = await readParsed();
      return fn(parsed);
    });
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const store: GoalStore = {
    filePath,

    read: readParsed,

    async list(query) {
      const parsed = await readParsed();
      let goals = parsed.goals.map((entry) => entry.goal);
      if (query?.status?.length) {
        const wanted = new Set(query.status);
        goals = goals.filter((goal) => wanted.has(goal.status));
      }
      if (query?.horizon?.length) {
        const wanted = new Set(query.horizon);
        goals = goals.filter((goal) => wanted.has(goal.horizon));
      }
      return goals;
    },

    async get(id) {
      const parsed = await readParsed();
      return parsed.goals.find((entry) => entry.goal.id === id)?.goal ?? null;
    },

    async write(input) {
      return mutate(async (parsed) => {
        const at = nowIso();
        const before = measure(parsed.goals.map((entry) => entry.goal));
        const index = input.id
          ? parsed.goals.findIndex((entry) => entry.goal.id === input.id)
          : -1;

        if (input.id && index === -1) {
          // Writing to an id the file no longer has: the user deleted it by
          // hand. Honour the intent and create it, keeping the id they used.
          if (!/^g\d+$/.test(input.id)) {
            throw new Error(
              `Goal ids look like g1, g2, …; "${input.id}" is not one.`,
            );
          }
        }

        const existing = index === -1 ? null : parsed.goals[index].goal;
        const id =
          input.id ??
          existing?.id ??
          nextGoalId(parsed.goals.map((entry) => entry.goal.id));

        const metadata = { ...(existing?.metadata ?? {}), ...(input.metadata ?? {}) };
        // An explicit value replaces whatever the human wrote; keeping the old
        // spelling around would silently undo the edit on the next render.
        if (input.horizon !== undefined) delete metadata.horizonAsWritten;
        if (input.status !== undefined) delete metadata.statusAsWritten;

        const goal: Goal = {
          id,
          title: input.title,
          description: input.description ?? existing?.description ?? '',
          horizon: input.horizon ?? existing?.horizon ?? 'quarter',
          status: input.status ?? existing?.status ?? 'active',
          metric: input.metric ?? existing?.metric ?? '',
          targetDate: input.targetDate ?? existing?.targetDate,
          order: input.order ?? existing?.order ?? parsed.goals.length,
          createdAt: existing?.createdAt ?? at,
          updatedAt: at,
          metadata,
        };

        const entry: ParsedGoal = {
          goal,
          raw: '',
          headingLine: `## [${id}] ${goal.title}`,
          hadId: true,
        };

        const goals = [...parsed.goals];
        if (index === -1) goals.push(entry);
        else goals[index] = entry;

        // `order` is file position, so honouring it means moving the block.
        if (input.order !== undefined) {
          const from = goals.indexOf(entry);
          const to = Math.max(0, Math.min(goals.length - 1, input.order));
          if (from !== to) {
            goals.splice(from, 1);
            goals.splice(to, 0, entry);
          }
        }

        const after = measure(goals.map((item) => item.goal));
        assertWithinBudget(
          before,
          after,
          parsed.goals.map((item) => item.goal),
        );

        await commit({ ...parsed, goals }, [id]);
        return goal;
      });
    },

    async remove(id) {
      return mutate(async (parsed) => {
        const goals = parsed.goals.filter((entry) => entry.goal.id !== id);
        if (goals.length === parsed.goals.length) return false;
        await commit({ ...parsed, goals }, []);
        return true;
      });
    },

    async budget() {
      const parsed = await readParsed();
      return measure(parsed.goals.map((entry) => entry.goal));
    },

    async compact(limit = MAX_GOALS) {
      const parsed = await readParsed();
      const all = parsed.goals.map((entry) => entry.goal);
      const shown = all.slice(0, limit);
      return {
        markdown: renderGoalsCompact(shown),
        count: shown.length,
        truncated: all.length - shown.length,
        budget: measure(all),
      };
    },

    async normalizeIds() {
      return mutate(async (parsed) => {
        if (parsed.assignedIds.length === 0) return [];
        await commit(parsed, []);
        return parsed.assignedIds;
      });
    },
  };

  return store;
}
