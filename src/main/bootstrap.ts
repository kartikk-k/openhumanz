/**
 * Wires the application together.
 *
 * This is the one place that knows about every layer at once, which is exactly
 * why it is the only place allowed to. Modules receive their dependencies; they
 * never reach for them. The two adapters at the bottom exist because the
 * orchestrator declares narrow interfaces for the engine and MCP services
 * rather than importing them — that is what let all three be built and tested
 * independently.
 *
 * Order is load-bearing and is called out where it matters.
 */
import type { WorkspacePaths } from './infra/paths';
import {
  createWorkspacePaths,
  ensureWorkspace,
  setWorkspacePaths,
} from './infra/paths';
import type { Logger } from './infra/logger';
import { initLoggerForWorkspace } from './infra/logger';
import type { Db } from './infra/db';
import { openDatabase, closeAllDatabases } from './infra/db';
import { appEvents } from './infra/events';
import { killAllTracked, shimPath } from './infra/spawn';

import type { ModuleRegistry } from './services/registry';
import { createRegistry, createElectronIpcBinder } from './services/registry';
import type { McpSocketServer } from './services/mcp';
import {
  createMcpSocketServer,
  mcpToolNames,
  DEFAULT_MCP_SERVER_NAME,
} from './services/mcp';
import type { EngineRegistry } from './services/engines';
import { createEngineRegistry } from './services/engines';
import { createEngineProvider } from './services/engine-bridge';
import type {
  McpScopeRegistrar,
  McpStepScope,
  McpStepScopeRequest,
  Orchestrator,
} from './services/orchestrator';
import { createOrchestrator } from './services/orchestrator';

import approvalsModule, { getApprovalGate } from './modules/approvals';
import runsAppModule, { configureRuns, getRunStore } from './modules/runs';
import tasksModule from './modules/tasks';
import goalsModule from './modules/goals';
import memoryModule from './modules/memory';
import { createScheduleModule } from './modules/schedule';
import settingsAppModule, {
  configureSettings,
  getSettingsStore,
} from './modules/settings';
import macosAppModule from './modules/macos';
import { createDialogModule } from './modules/dialog';
import { createComposioModule } from './modules/composio';
import { createChatModule } from './modules/chat';
import { createChatSessionRunner } from './services/chat-session-runner';
import { CLAUDE_CODE_ENGINE_ID } from './services/engines/claude-code';
import { createNotificationService } from './services/notifications';

import type { IpcPushChannel, IpcPushPayload } from '../shared/ipc';
import { IPC_PUSH } from '../shared/ipc';

export interface AppServices {
  paths: WorkspacePaths;
  logger: Logger;
  db: Db;
  registry: ModuleRegistry;
  mcp: McpSocketServer;
  engines: EngineRegistry;
  orchestrator: Orchestrator;
  shutdown(): Promise<void>;
}

/**
 * Broadcast to every open window.
 *
 * Electron is required lazily, exactly as `createElectronIpcBinder()` does it,
 * so the whole backend can be booted headlessly under a plain node/bun runtime
 * for testing. Outside Electron this degrades to a no-op rather than throwing.
 */
function send<C extends IpcPushChannel>(
  channel: C,
  payload: IpcPushPayload<C>,
  senderIds?: readonly number[],
): void {
  let windows: Array<{
    isDestroyed(): boolean;
    webContents: { id: number; send(channel: string, payload: unknown): void };
  }>;
  try {
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    windows = require('electron').BrowserWindow.getAllWindows();
  } catch {
    return;
  }
  for (const win of windows) {
    if (win.isDestroyed()) continue;
    if (senderIds && !senderIds.includes(win.webContents.id)) continue;
    win.webContents.send(channel, payload);
  }
}

/**
 * Bridges the MCP server's step registry to the orchestrator's scope interface.
 *
 * The shim is spawned through Electron in Node mode because end users have no
 * `node` on PATH — that is the whole reason `ELECTRON_RUN_AS_NODE` is here and
 * not a bare `node` in the server entry.
 */
function mcpScopeRegistrar(
  mcp: McpSocketServer,
  registryRef: ModuleRegistry,
): McpScopeRegistrar {
  return {
    async register(request: McpStepScopeRequest): Promise<McpStepScope> {
      const step = mcp.registerStep({
        stepId: request.stepId,
        runId: request.runId,
        allowedTools: request.allowedTools,
      });

      // Only the names this server actually owns become `mcp__…` ids; native
      // CLI tools in the allowlist are not its business.
      const owned = request.allowedTools.filter(
        (name) => registryRef.tool(name) !== undefined,
      );

      return {
        serverName: DEFAULT_MCP_SERVER_NAME,
        server: {
          command: process.execPath,
          args: [shimPath()],
          env: { ELECTRON_RUN_AS_NODE: '1', ...step.env() },
        },
        exposedToolNames: mcpToolNames(DEFAULT_MCP_SERVER_NAME, owned),
        revoke: async () => {
          step.revoke();
        },
      };
    },
  };
}

/** Forwards bus events the renderer needs. Modules emit; this delivers. */
function bridgeEventsToRenderer(): void {
  appEvents.on('approval:requested', ({ approval }) =>
    send(IPC_PUSH.approvalRequested, { approval }),
  );
  appEvents.on('approval:resolved', (payload) =>
    send(IPC_PUSH.approvalResolved, payload),
  );
  appEvents.on('tasks:changed', (payload) =>
    send(IPC_PUSH.tasksChanged, payload),
  );
  appEvents.on('goals:changed', (payload) =>
    send(IPC_PUSH.goalsChanged, payload),
  );
  appEvents.on('schedule:changed', (payload) =>
    send(IPC_PUSH.scheduleChanged, payload),
  );
  appEvents.on('memory:indexed', ({ status }) =>
    send(IPC_PUSH.memoryIndexed, { status }),
  );
  appEvents.on('memory:doc-changed', (payload) =>
    send(IPC_PUSH.memoryDocChanged, payload),
  );
  appEvents.on('settings:changed', ({ settings }) =>
    send(IPC_PUSH.settingsChanged, { settings }),
  );
  appEvents.on('environment:changed', ({ status }) =>
    send(IPC_PUSH.environmentChanged, { status }),
  );
  appEvents.on('chat:updated', (payload) =>
    send(IPC_PUSH.chatUpdated, payload),
  );
  appEvents.on('chat:stream', (payload) => send(IPC_PUSH.chatStream, payload));
}

export async function bootstrap(): Promise<AppServices> {
  const paths = setWorkspacePaths(createWorkspacePaths());
  await ensureWorkspace(paths);

  const logger = initLoggerForWorkspace(paths.root).child('app');
  logger.info('starting', { workspace: paths.root });

  const db = await openDatabase({ filePath: paths.dbFile, logger });
  const engines = createEngineRegistry({ logger: logger.child('engines') });

  // The settings module owns the `engines:*` channels but may not import a
  // service, so the registry is injected rather than reached for.
  configureSettings({ environment: engines });

  // Schedule dispatches through the bus by default; the orchestrator is not
  // available yet, so the real dispatcher is injected below.
  const scheduleModule = createScheduleModule({});

  // Chat runs its own resumable Claude Code session; its runner is injected
  // below once the MCP server exists (it needs the tool surface + approvals).
  const chatModule = createChatModule();

  // Composio: third-party connectors. The API key comes from settings; the
  // browser open uses electron's shell.
  const composioModule = createComposioModule();

  const registry = createRegistry({
    modules: [
      approvalsModule,
      runsAppModule,
      tasksModule,
      goalsModule,
      memoryModule,
      scheduleModule,
      settingsAppModule,
      macosAppModule,
      createDialogModule(),
      composioModule,
      chatModule,
    ],
    db,
    paths,
    events: appEvents,
    logger,
    ipc: createElectronIpcBinder() ?? undefined,
  });

  // Migrations run here, and the runs module builds its store. Everything
  // below depends on that having happened.
  await registry.start();

  const mcp = createMcpSocketServer({
    paths,
    tools: registry,
    logger: logger.child('mcp'),
  });
  await mcp.start();

  // The gate must learn the tool surface, or every tool reads as side-effecting.
  const gate = getApprovalGate();
  gate.registerTools(registry.tools());
  mcp.setApprovalGate(gate);

  // Wire Chat to the same Claude Code adapter + MCP surface the runs use, so a
  // chat message has the full tool set and hits the same approval gate.
  const chatAdapter = engines.get(CLAUDE_CODE_ENGINE_ID);
  if (chatAdapter) {
    chatModule.configure({
      runner: createChatSessionRunner({
        adapter: chatAdapter,
        mcp,
        logger: logger.child('chat'),
        allowedTools: () => registry.tools().map((tool) => tool.name),
      }),
    });
  } else {
    logger.warn('chat disabled: no claude-code adapter available');
  }

  const orchestrator = createOrchestrator({
    store: getRunStore(),
    engines: createEngineProvider(engines),
    mcp: mcpScopeRegistrar(mcp, registry),
    paths,
    events: appEvents,
    logger: logger.child('orchestrator'),
  });

  configureRuns({ launcher: orchestrator, sink: { send } });

  // The scheduler already evaluated its own deterministic condition before
  // emitting. Passing an explicit `() => true` keeps that visible in review
  // rather than implicit — nothing starts a CLI invocation uncondionally.
  //
  // Load the job so the run carries its real prompt and settings. Without this
  // the run spawned with an empty prompt and no job linkage, so a fired
  // reminder did nothing.
  appEvents.on('schedule:due', ({ jobId }) => {
    const job = scheduleModule.scheduler.get(jobId);
    if (!job) {
      logger.warn('scheduled job fired but was not found', { jobId });
      return;
    }
    void orchestrator
      .startIfCondition({
        request: {
          title: job.name,
          prompt: job.prompt,
          engine: job.engine,
          allowedTools: job.allowedTools,
          maxTurns: job.maxTurns,
          maxCostUsd: job.maxCostUsd,
          scheduledJobId: job.id,
          trigger: 'schedule',
        },
        condition: () => true,
        reason: `scheduled job ${job.name} (${jobId})`,
      })
      .catch((error) => logger.error('scheduled dispatch failed', error));
  });

  bridgeEventsToRenderer();

  // OS notifications: tell the user when a scheduled reminder has run, a run
  // finishes (if they opted in), or an approval is waiting. Reads the live
  // settings on each event, so toggling notifications takes effect at once.
  createNotificationService({
    events: appEvents,
    settings: getSettingsStore(),
    runs: getRunStore(),
    logger: logger.child('notifications'),
  }).start();

  // Composio: open consent URLs in the system browser, seed the key from
  // settings, and persist it back when the user changes it in the UI.
  composioModule.configure({
    openExternal: async (url: string) => {
      try {
        // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
        await require('electron').shell.openExternal(url);
      } catch {
        /* headless / no shell */
      }
    },
  });
  getSettingsStore()
    .get()
    .then((settings) => {
      composioModule.setApiKey(settings.composio?.apiKey ?? '');
      return undefined;
    })
    .catch(() => {});
  appEvents.on('composio:save-key', ({ apiKey }) => {
    composioModule.setApiKey(apiKey);
    void getSettingsStore()
      .set({ composio: { apiKey } })
      .catch((error) => logger.error('failed to save composio key', error));
  });

  logger.info('ready', { tools: registry.tools().length });

  return {
    paths,
    logger,
    db,
    registry,
    mcp,
    engines,
    orchestrator,
    async shutdown() {
      logger.info('shutting down');
      appEvents.emit('app:quitting', {});
      await orchestrator.shutdown().catch(() => {});
      await mcp.stop().catch(() => {});
      await registry.stop().catch(() => {});
      await killAllTracked().catch(() => {});
      await closeAllDatabases().catch(() => {});
    },
  };
}
