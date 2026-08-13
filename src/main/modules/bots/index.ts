/**
 * The `bots` module.
 *
 * Owns the `bots` and `bot_messages` tables, the `bots:*` IPC surface, and the
 * MCP tools in `./tools`. A bot is a named agent with its own persistent thread;
 * the "Main" bot is the home chat promoted to first class and is seeded
 * (non-deletable) on first migration.
 *
 * Execution is injected, exactly like the runs and chat modules: a module may
 * not import a service, so the orchestrator arrives through {@link configure} as
 * a {@link BotRunLauncher}. Until it is wired, `bots:send` fails loudly rather
 * than silently doing nothing.
 *
 * The thread runner is the core bridge: it spawns a detached run per bot turn,
 * prepends the bot's system prompt, scopes tools/cwd to the bot, and folds the
 * run's transcript into `ChatBlock[]` as it streams — emitting `bots:thread` on
 * the bus, which `bootstrap.ts` bridges to `push:bot-thread`.
 *
 * Store and runner are created in `start()` (they need the db / event bus). The
 * registry collects `tools` and `ipc` at construction, so both close over
 * getters that throw until then.
 */
import { defineModule, type AppModule, type ModuleContext } from '../types';
import type { EventBus } from '../../infra/events';
import { migrations, createBotStore, type BotStore } from './store';
import { createIpcHandlers } from './ipc';
import {
  createThreadRunner,
  type BotRunLauncher,
  type ThreadRunner,
} from './thread-runner';
import { createBotsTools, type BotsToolDeps } from './tools';

export const BOTS_MODULE_ID = 'bots';

export { migrations, createBotStore } from './store';
export type {
  BotStore,
  BotPatch,
  AppendMessageInput,
  ListMessagesOptions,
} from './store';
export {
  createThreadRunner,
  type ThreadRunner,
  type BotRunLauncher,
  type SendToBotResult,
} from './thread-runner';

/** Injected from `bootstrap.ts` once the orchestrator exists. */
export interface BotsWiring {
  launcher?: BotRunLauncher;
  /** All registered tool names, so an unconfigured bot gets the full toolset. */
  allToolNames?: () => string[];
}

export interface BotsModule extends AppModule {
  readonly store: BotStore;
  readonly runner: ThreadRunner;
  configure(wiring: BotsWiring): void;
}

/** Forward a bus that is only assigned in `start()`. */
function liveEvents(get: () => EventBus): EventBus {
  return {
    emit: (name, payload) => get().emit(name, payload),
    on: (name, listener) => get().on(name, listener),
    once: (name, listener) => get().once(name, listener),
    off: (name, listener) => get().off(name, listener),
    onAny: (listener) => get().onAny(listener),
    waitFor: (name, options) => get().waitFor(name, options),
    removeAllListeners: (name) => get().removeAllListeners(name),
    listenerCount: (name) => get().listenerCount(name),
  };
}

/**
 * A stand-in that can be destructured at factory time. Method calls resolve
 * against the live object — `createBotsTools` closes over `store`/`runner`
 * before `start()` has a database.
 */
function liveRef<T extends object>(get: () => T): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      const live = get();
      const value = Reflect.get(live, prop, live);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(live)
        : value;
    },
  });
}

export function createBotsModule(): BotsModule {
  let store: BotStore | null = null;
  let runner: ThreadRunner | null = null;
  let events: EventBus | null = null;
  let pendingLauncher: BotRunLauncher | undefined;
  let pendingAllToolNames: (() => string[]) | undefined;

  const notStarted = (): never => {
    throw new Error('The bots module has not started yet.');
  };

  const requireStore = (): BotStore => store ?? notStarted();
  const requireRunner = (): ThreadRunner => runner ?? notStarted();
  const requireEvents = (): EventBus => events ?? notStarted();

  const toolDeps: BotsToolDeps = {
    store: liveRef(requireStore),
    runner: liveRef(requireRunner),
  };

  const module = defineModule({
    id: BOTS_MODULE_ID,
    migrations,
    tools: createBotsTools(toolDeps),
    ipc: createIpcHandlers(
      requireStore,
      requireRunner,
      liveEvents(requireEvents),
    ),

    async start(ctx: ModuleContext) {
      events = ctx.events;
      store = createBotStore(ctx.db);
      runner = createThreadRunner({
        store,
        events: ctx.events,
        paths: ctx.paths,
        logger: ctx.logger,
        launcher: pendingLauncher,
        allToolNames: pendingAllToolNames,
      });
      await runner.recoverOpenRuns();
    },

    async stop() {
      runner?.dispose();
      runner = null;
      store = null;
      events = null;
    },
  });

  return {
    ...module,
    get store() {
      return requireStore();
    },
    get runner() {
      return requireRunner();
    },
    configure(wiring) {
      if (wiring.launcher !== undefined) {
        pendingLauncher = wiring.launcher;
        runner?.configure({ launcher: wiring.launcher });
      }
      if (wiring.allToolNames !== undefined) {
        pendingAllToolNames = wiring.allToolNames;
        runner?.configure({ allToolNames: wiring.allToolNames });
      }
    },
  };
}

/** The instance the registry uses. */
const botsModule = createBotsModule();

export default botsModule;
