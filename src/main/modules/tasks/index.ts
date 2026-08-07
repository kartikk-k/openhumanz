/**
 * The tasks module.
 *
 * A task board with two shapes: one **personal** board that outlives every
 * conversation, and a **per-conversation** board for the work an agent is doing
 * right now. Same card schema, same storage, different scope — so promoting
 * something an agent did into the user's standing list is a board move, not a
 * migration.
 *
 * Owns `tasks_card`. Talks to nobody: state changes go out on `tasks:changed`
 * over the event bus, which is how the renderer and any other module hear about
 * them.
 */
import type { Deleted } from '../../../shared/ipc';
import type { Page } from '../../../shared/common';
import type { Task } from '../../../shared/tasks';
import { defineModule } from '../types';
import type { IpcHandlerMap, ModuleContext } from '../types';
import { migrations } from './migrations';
import { renderBoard, renderCard } from './markdown';
import {
  TaskCard,
  TaskCardCreateSchema,
  TaskCardQuerySchema,
  TaskCardUpdateSchema,
  TaskCardView,
  resolveBoard,
} from './schema';
import { createTaskStore } from './store';
import type { TaskStore } from './store';
import { createTaskTools } from './tools';

export * from './schema';
export { createTaskStore } from './store';
export type { TaskStore } from './store';
export { renderBoard, renderCard, renderBoardLine } from './markdown';

/**
 * A page of cards plus the board rendered once. The markdown is part of the
 * response rather than something the UI reassembles, so the board reads
 * identically in the app and in an agent transcript.
 */
export interface TaskBoardPage extends Page<Task> {
  items: TaskCard[];
  markdown: string;
}

let context: ModuleContext | null = null;
let store: TaskStore | null = null;

/** The store, created on first use. Throws before the module has started. */
function requireStore(): TaskStore {
  if (!store) {
    throw new Error('tasks module used before start()');
  }
  return store;
}

function emitChanged(ids: string[]): void {
  if (ids.length === 0) return;
  context?.events.emit('tasks:changed', { ids });
}

/**
 * IPC. The request types come from `shared/ipc.ts` and are the shared,
 * board-unaware shapes; every payload is re-parsed here with the module's own
 * superset schema, so a board-aware caller can pass `board` / `conversationId`
 * and a shared-typed caller keeps working untouched.
 */
const ipc: IpcHandlerMap = {
  'tasks:list': (request): TaskBoardPage => {
    const query = TaskCardQuerySchema.parse(request ?? {});
    const board = resolveBoard(query);
    const page = requireStore().list(query);
    return {
      ...page,
      markdown: renderBoard(page.items, {
        board: query.board ?? board.board,
        conversationId: query.conversationId,
        total: page.total,
      }),
    };
  },

  'tasks:get': (request): TaskCardView | null => {
    const card = requireStore().get(request.id);
    if (!card) return null;
    return { ...card, markdown: renderCard(card) };
  },

  'tasks:create': (request): TaskCard => {
    const card = requireStore().create(TaskCardCreateSchema.parse(request));
    emitChanged([card.id]);
    return card;
  },

  'tasks:update': (request): TaskCard => {
    const card = requireStore().update(TaskCardUpdateSchema.parse(request));
    emitChanged([card.id]);
    return card;
  },

  'tasks:delete': (request): Deleted => {
    const deleted = requireStore().remove(request.id);
    if (deleted) emitChanged([request.id]);
    return { id: request.id, deleted };
  },
};

export default defineModule({
  id: 'tasks',
  migrations,
  ipc,
  tools: createTaskTools({
    store: {
      // Bound lazily: the registry collects tools before it has a database.
      list: (query) => requireStore().list(query),
      get: (id) => requireStore().get(id),
      create: (input) => requireStore().create(input),
      update: (input) => requireStore().update(input),
      remove: (id) => requireStore().remove(id),
      boardCards: (board, includeCompleted) =>
        requireStore().boardCards(board, includeCompleted),
      countOnBoard: (board) => requireStore().countOnBoard(board),
      clearBoard: (board, options) => requireStore().clearBoard(board, options),
      removeMany: (ids, options) => requireStore().removeMany(ids, options),
      replaceBoard: (board, cards, options) =>
        requireStore().replaceBoard(board, cards, options),
    },
    onChanged: emitChanged,
  }),

  start(ctx) {
    context = ctx;
    store = createTaskStore(ctx.db);
    ctx.logger.debug('tasks module started');
  },

  stop() {
    store = null;
    context = null;
  },
});
