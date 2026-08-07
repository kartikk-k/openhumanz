/**
 * The module registry.
 *
 * Takes a list of modules and does the four things that would otherwise be
 * copy-pasted into every module: run migrations in order, collect tools,
 * register IPC handlers, start and stop.
 *
 * It is the only place that knows every module exists. Modules do not know
 * about it, and it hands each one nothing but a {@link ModuleContext}.
 *
 * Electron is reached through {@link IpcBinder} rather than imported, so the
 * registry is testable under plain `bun` and so a headless mode (helper
 * process, tests) can bind the same handlers somewhere else.
 */
import type { Db } from '../infra/db';
import type { EventBus } from '../infra/events';
import type { Logger } from '../infra/logger';
import type { WorkspacePaths } from '../infra/paths';
import { IPC_CHANNELS, isIpcChannel } from '../../shared/ipc';
import type { IpcChannel } from '../../shared/ipc';
import {
  AnyToolDefinition,
  AppModule,
  IpcInvocation,
  ModuleContext,
  ToolCallContext,
  parseToolInput,
} from '../modules/types';

/** Whatever actually attaches a channel to a transport. */
export interface IpcBinder {
  handle(
    channel: string,
    handler: (payload: unknown, senderId?: number) => Promise<unknown>,
  ): void;
  removeHandler(channel: string): void;
}

export interface RegistryOptions {
  modules: AppModule[];
  db: Db;
  paths: WorkspacePaths;
  events: EventBus;
  logger: Logger;
  /** Omit to register no IPC at all (tests, helper processes). */
  ipc?: IpcBinder;
}

export interface ModuleRegistry {
  readonly modules: readonly AppModule[];

  /** Run every module's migrations, in module-list order. Idempotent. */
  migrate(): Promise<void>;
  /** Migrate (if not already) then `start()` each module in order. */
  start(): Promise<void>;
  /** `stop()` each module in reverse order, then unbind IPC. Never throws. */
  stop(): Promise<void>;

  /** Every registered tool, in module order. */
  tools(): AnyToolDefinition[];
  tool(name: string): AnyToolDefinition | undefined;
  /** Validate arguments against the tool's schema and run it. */
  invokeTool(
    name: string,
    input: unknown,
    ctx?: Partial<ToolCallContext>,
  ): Promise<unknown>;

  /** Channels that have a handler. */
  channels(): IpcChannel[];
  /** Call a channel's handler directly, bypassing the transport. */
  invoke(
    channel: IpcChannel,
    payload: unknown,
    senderId?: number,
  ): Promise<unknown>;

  /** The context handed to a module, for tests and diagnostics. */
  contextFor(moduleId: string): ModuleContext | undefined;
}

/**
 * `ipcMain.handle`, loaded lazily so importing the registry does not require
 * electron. Returns null outside a real electron main process.
 */
export function createElectronIpcBinder(): IpcBinder | null {
  let ipcMain: {
    handle(
      channel: string,
      listener: (
        event: { sender?: { id?: number } },
        ...args: unknown[]
      ) => unknown,
    ): void;
    removeHandler(channel: string): void;
  };
  try {
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    const electron = require('electron') as { ipcMain?: typeof ipcMain };
    if (!electron || typeof electron !== 'object' || !electron.ipcMain) {
      return null;
    }
    ipcMain = electron.ipcMain;
  } catch {
    return null;
  }

  return {
    handle(channel, handler) {
      ipcMain.handle(channel, (event, payload) =>
        handler(payload, event?.sender?.id),
      );
    },
    removeHandler(channel) {
      ipcMain.removeHandler(channel);
    },
  };
}

export function createRegistry(options: RegistryOptions): ModuleRegistry {
  const { modules, db, paths, events, logger, ipc } = options;

  /* -------- validate the list up front -------- */

  const seenIds = new Set<string>();
  for (const module of modules) {
    if (!module.id) throw new Error('A module has no id');
    if (seenIds.has(module.id)) {
      throw new Error(`Duplicate module id: "${module.id}"`);
    }
    seenIds.add(module.id);
  }

  const contexts = new Map<string, ModuleContext>();
  for (const module of modules) {
    contexts.set(module.id, {
      moduleId: module.id,
      db,
      logger: logger.child(module.id),
      events,
      paths,
    });
  }

  const toolsByName = new Map<string, AnyToolDefinition>();
  const toolOwner = new Map<string, string>();
  for (const module of modules) {
    for (const tool of module.tools ?? []) {
      if (toolsByName.has(tool.name)) {
        throw new Error(
          `Duplicate tool "${tool.name}": "${toolOwner.get(tool.name)}" and "${module.id}"`,
        );
      }
      toolsByName.set(tool.name, tool);
      toolOwner.set(tool.name, module.id);
    }
  }

  type BoundHandler = (
    request: unknown,
    ctx: IpcInvocation,
  ) => Promise<unknown> | unknown;
  const handlers = new Map<IpcChannel, BoundHandler>();
  const channelOwner = new Map<IpcChannel, string>();
  for (const module of modules) {
    for (const [channel, handler] of Object.entries(module.ipc ?? {})) {
      if (!isIpcChannel(channel)) {
        throw new Error(
          `Module "${module.id}" registered unknown IPC channel "${channel}". ` +
            'Add it to shared/ipc.ts first.',
        );
      }
      if (handlers.has(channel)) {
        throw new Error(
          `Duplicate IPC channel "${channel}": "${channelOwner.get(channel)}" and "${module.id}"`,
        );
      }
      handlers.set(channel, handler as BoundHandler);
      channelOwner.set(channel, module.id);
    }
  }

  let migrated = false;
  let started = false;
  const boundChannels: IpcChannel[] = [];

  const registry: ModuleRegistry = {
    modules,

    async migrate() {
      if (migrated) return;
      for (const module of modules) {
        if (!module.migrations || module.migrations.length === 0) continue;
        // Sequential on purpose: migrations share one database and one
        // transaction depth counter.
        // eslint-disable-next-line no-await-in-loop
        const applied = await db.migrate(module.id, module.migrations);
        if (applied.length > 0) {
          logger.info('migrations applied', {
            module: module.id,
            count: applied.length,
          });
        }
      }
      await db.persist();
      migrated = true;
    },

    async start() {
      if (started) return;
      await registry.migrate();

      if (ipc) {
        for (const [channel, handler] of handlers) {
          const scoped = logger.child(channelOwner.get(channel) ?? 'ipc');
          ipc.handle(channel, async (payload, senderId) =>
            handler(payload, { senderId, logger: scoped }),
          );
          boundChannels.push(channel);
        }
        logger.info('ipc handlers registered', {
          bound: boundChannels.length,
          total: IPC_CHANNELS.length,
        });
      }

      for (const module of modules) {
        const ctx = contexts.get(module.id) as ModuleContext;
        if (!module.start) continue;
        // Sequential: a later module may rely on an earlier one's tables
        // having been populated at start.
        // eslint-disable-next-line no-await-in-loop
        await module.start(ctx);
        events.emit('module:started', { id: module.id });
        logger.debug('module started', { module: module.id });
      }

      started = true;
    },

    async stop() {
      for (const module of [...modules].reverse()) {
        if (!module.stop) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          await module.stop();
          events.emit('module:stopped', { id: module.id });
        } catch (cause) {
          logger.error('module stop failed', {
            module: module.id,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
      if (ipc) {
        for (const channel of boundChannels) {
          try {
            ipc.removeHandler(channel);
          } catch {
            /* nothing bound */
          }
        }
        boundChannels.length = 0;
      }
      started = false;
    },

    tools() {
      return [...toolsByName.values()];
    },

    tool(name) {
      return toolsByName.get(name);
    },

    async invokeTool(name, input, ctx = {}) {
      const tool = toolsByName.get(name);
      if (!tool) throw new Error(`Unknown tool: "${name}"`);
      const parsed = parseToolInput(tool, input);
      const owner = toolOwner.get(name) ?? 'tools';
      return tool.handler(parsed, {
        ...ctx,
        logger: ctx.logger ?? logger.child(owner),
      });
    },

    channels() {
      return [...handlers.keys()];
    },

    async invoke(channel, payload, senderId) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No handler for channel "${channel}"`);
      const owner = channelOwner.get(channel) ?? 'ipc';
      return handler(payload, { senderId, logger: logger.child(owner) });
    },

    contextFor(moduleId) {
      return contexts.get(moduleId);
    },
  };

  return registry;
}
