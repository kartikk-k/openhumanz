/**
 * The goals module.
 *
 * Long-term intent, capped at eight items and ~500 tokens so it can be injected
 * into every turn without anyone having to think about whether it is worth it.
 *
 * Stored as `GOALS.md` in the workspace root — a plain markdown file with stable
 * short ids in the headings — because this is the one piece of state a user is
 * most likely to want to edit in their own editor at midnight. There is no goals
 * table: the file is the source of truth, eight rows do not need an index, and
 * an index that can disagree with the file is worse than no index.
 *
 * Owns no tables. Emits `goals:changed` on the event bus.
 */
import type { Deleted } from '../../../shared/ipc';
import type { Goal } from '../../../shared/tasks';
import { GoalQuerySchema, GoalWriteSchema } from '../../../shared/tasks';
import { defineModule } from '../types';
import type { IpcHandlerMap, ModuleContext } from '../types';
import { createGoalStore } from './store';
import type { GoalStore } from './store';
import { createGoalTools } from './tools';

export * from './schema';
export {
  DEFAULT_PREAMBLE,
  nextGoalId,
  parseGoalsFile,
  renderGoal,
  renderGoalsCompact,
  renderGoalsFile,
} from './markdown';
export type { ParsedGoal, ParsedGoalsFile } from './markdown';
export { createGoalStore, measure } from './store';
export type { GoalBudget, GoalStore } from './store';

let context: ModuleContext | null = null;
let store: GoalStore | null = null;

function requireStore(): GoalStore {
  if (!store) throw new Error('goals module used before start()');
  return store;
}

function emitChanged(ids: string[]): void {
  if (ids.length === 0) return;
  context?.events.emit('goals:changed', { ids });
}

const ipc: IpcHandlerMap = {
  'goals:list': async (request): Promise<Goal[]> =>
    requireStore().list(GoalQuerySchema.parse(request ?? {})),

  'goals:get': async (request): Promise<Goal | null> =>
    requireStore().get(request.id),

  'goals:write': async (request): Promise<Goal> => {
    const goal = await requireStore().write(GoalWriteSchema.parse(request));
    emitChanged([goal.id]);
    return goal;
  },

  'goals:delete': async (request): Promise<Deleted> => {
    const deleted = await requireStore().remove(request.id);
    if (deleted) emitChanged([request.id]);
    return { id: request.id, deleted };
  },
};

export default defineModule({
  id: 'goals',
  // No tables. The file is the store.
  migrations: [],
  ipc,
  tools: createGoalTools({
    // Bound lazily: the registry collects tools before `start` has run.
    store: {
      get filePath() {
        return requireStore().filePath;
      },
      read: () => requireStore().read(),
      list: (query) => requireStore().list(query),
      get: (id) => requireStore().get(id),
      write: (input) => requireStore().write(input),
      remove: (id) => requireStore().remove(id),
      budget: () => requireStore().budget(),
      compact: (limit) => requireStore().compact(limit),
      normalizeIds: () => requireStore().normalizeIds(),
    },
    onChanged: emitChanged,
  }),

  async start(ctx) {
    context = ctx;
    store = createGoalStore({ root: ctx.paths.root });

    // If a human added a goal without an id, pin one now rather than letting it
    // drift between reads.
    try {
      const assigned = await store.normalizeIds();
      if (assigned.length > 0) {
        ctx.logger.info('assigned ids to hand-written goals', { assigned });
      }
    } catch (cause) {
      ctx.logger.warn('could not normalise GOALS.md ids', {
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  },

  stop() {
    store = null;
    context = null;
  },
});
