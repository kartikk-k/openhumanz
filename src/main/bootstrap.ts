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
import { createScheduleModule } from './modules/schedule';
import settingsAppModule, {
  configureSettings,
  getSettingsStore,
} from './modules/settings';
import macosAppModule, { MACOS_TOOL_NAMES } from './modules/macos';
import { createDialogModule } from './modules/dialog';
import { createSystemModule } from './modules/system';
import { createVoiceModule } from './modules/voice';
import { createComposioModule } from './modules/composio';
import { createSupermemoryModule } from './modules/supermemory';
import { createChatModule } from './modules/chat';
import { createBotsModule } from './modules/bots';
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
      // The inter-bot tools are exposed to EVERY run, regardless of the run's
      // own allow-list. This is what lets a scheduled job (or any run) reach a
      // bot via message_bot — otherwise a job whose prompt says "message the
      // Hacker News bot" fails with "no message_bot tool available". They are
      // internal, non-consequential (hand a prompt to a local bot), and are
      // force-allowed by the approval gate too, so always exposing them is safe.
      const BOT_TOOLS = ['list_bots', 'message_bot'];
      const allowedTools = [
        ...new Set([...request.allowedTools, ...BOT_TOOLS]),
      ];

      const step = mcp.registerStep({
        stepId: request.stepId,
        runId: request.runId,
        allowedTools,
        interactive: request.interactive,
      });

      // Only the names this server actually owns become `mcp__…` ids; native
      // CLI tools in the allowlist are not its business.
      const owned = allowedTools.filter(
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
  appEvents.on('bots:thread', (payload) => send(IPC_PUSH.botThread, payload));
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

  // Bots: named agents with persistent threads. The orchestrator is injected
  // below once it exists, the same way chat and runs receive their launchers.
  const botsModule = createBotsModule();

  // Composio: third-party connectors. The API key comes from settings; the
  // browser open uses electron's shell.
  const composioModule = createComposioModule();

  // Voice: speech-to-text for hold-to-talk. Reads the OpenAI key live from
  // settings (configured below) and transcribes recorded audio.
  const voiceModule = createVoiceModule();

  // Supermemory: the memory engine. Runs a local server (on-device vector store
  // + embeddings) whose fact extraction is routed to the user's own Claude via a
  // local shim — no external key. Owns the agent's memory_store / memory_search.
  const supermemoryModule = createSupermemoryModule();

  const registry = createRegistry({
    modules: [
      approvalsModule,
      runsAppModule,
      tasksModule,
      goalsModule,
      scheduleModule,
      settingsAppModule,
      macosAppModule,
      createDialogModule(),
      createSystemModule(),
      composioModule,
      voiceModule,
      supermemoryModule,
      chatModule,
      botsModule,
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

  // `composio_app_execute` is a generic dispatcher: one tool that runs any
  // connected-app tool. The gate must classify on what is actually being run,
  // not on the router name — otherwise an "always allow" on a read would
  // authorise every write, and reads would prompt. Key the capability on the
  // `tool` argument and take read/write from the module's live cache.
  gate.registerClassifier('composio_app_execute', ({ args }) => {
    const tool = typeof args.tool === 'string' ? args.tool : '';
    const app = typeof args.app === 'string' ? args.app : '';
    if (!tool || !composioModule.isKnownTool(tool)) {
      // Unknown tool: fail closed (side-effecting) and let the handler explain.
      return { action: tool || 'unknown', sideEffecting: true };
    }
    const readOnly = composioModule.isReadOnlyTool(tool);
    return {
      // The real tool slug is the action, so grants never cross tools.
      action: tool,
      sideEffecting: !readOnly,
      title: `${app || 'App'} · ${tool}`,
    };
  });

  // Product decision: all macOS AppleScript actions are always allowed and are
  // never routed through the approval gate. A classifier that returns
  // `sideEffecting: false` short-circuits `check()` to 'allow' (see gate.ts:
  // the classifier verdict is the highest-precedence input). This deliberately
  // overrides each tool's own `sideEffecting: true` for the local-macOS surface
  // — these operate only on the user's own machine via their own signed-in apps.
  for (const toolName of MACOS_TOOL_NAMES) {
    gate.registerClassifier(toolName, () => ({ sideEffecting: false }));
  }

  // The bots tools are always allowed too. `message_bot` just hands a prompt to
  // another local bot (which runs in the background and posts into its own
  // thread) — there is no external, consequential side effect to gate, and a
  // bot run is non-interactive, so a pending approval there can never be
  // answered and would hang the call forever. list_bots is a pure read.
  for (const toolName of ['list_bots', 'message_bot']) {
    gate.registerClassifier(toolName, () => ({ sideEffecting: false }));
  }

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
  // The runner types `trigger` as string; the orchestrator wants the enum.
  botsModule.configure({
    // An unconfigured bot (empty allowedTools) gets the full registered
    // toolset — otherwise the orchestrator scopes it to nothing and even
    // message_bot disappears.
    allToolNames: () => registry.tools().map((tool) => tool.name),
    launcher: {
      startIfCondition: ({ request, condition, reason }) => {
        const trigger =
          request.trigger === 'schedule' ||
          request.trigger === 'watcher' ||
          request.trigger === 'system'
            ? request.trigger
            : 'manual';
        return orchestrator.startIfCondition({
          request: { ...request, trigger },
          condition,
          reason,
        });
      },
    },
  });

  // OS notifications: tell the user when a scheduled reminder has run, a run
  // finishes (if they opted in), or an approval is waiting. Reads the live
  // settings on each event, so toggling notifications takes effect at once.
  // Created BEFORE the schedule:due handler because that handler now calls
  // `notify()` directly for reminder jobs.
  const notificationService = createNotificationService({
    events: appEvents,
    settings: getSettingsStore(),
    runs: getRunStore(),
    logger: logger.child('notifications'),
  });
  notificationService.start();

  // A scheduled job came due. Three kinds, three paths:
  //
  //  - `reminder` → post the notification directly and STOP. No engine spawns,
  //    so a recurring "drink water" reminder costs zero tokens. The title is
  //    the job name and the body is its (optional) pre-filled prompt.
  //  - agent with `botId` → post into that bot's thread (and notify
  //    "New from <bot>"). The run is the bot's, not a standalone one.
  //  - `agent`    → spawn the engine with the job's prompt, exactly as before,
  //    for work that must be *done* at run time (summaries, triage, workflows).
  //
  // The scheduler already evaluated its deterministic condition before emitting;
  // the explicit `() => true` keeps that visible rather than implicit.
  appEvents.on('schedule:due', ({ jobId }) => {
    const job = scheduleModule.scheduler.get(jobId);
    if (!job) {
      logger.warn('scheduled job fired but was not found', { jobId });
      return;
    }

    if (job.kind === 'reminder') {
      // Body is the pre-filled prompt if present, else a minimal fallback so
      // the banner is never empty. No engine, no run, no tokens.
      const body = job.prompt.trim() || job.description.trim() || job.name;
      notificationService.notify(job.name, body);
      logger.info('reminder fired (no engine)', { jobId, name: job.name });
      return;
    }

    const botId = job.botId;
    if (typeof botId === 'string' && botId.length > 0) {
      const bot = botsModule.store.getBot(botId);
      void botsModule.runner
        .sendToBot({
          botId,
          prompt: job.prompt,
          source: 'schedule',
          author: job.name,
        })
        .catch((error) => logger.error('scheduled bot dispatch failed', error));
      const label = bot?.name ?? job.name;
      notificationService.notify(`New from ${label}`, job.name);
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

  // Voice: read the OpenAI key/model live from settings on every transcription,
  // so updating the key in Settings takes effect without a restart.
  voiceModule.configure({
    getConfig: () => {
      const settings = getSettingsStore().current();
      return {
        apiKey: settings.voice?.openaiApiKey ?? '',
        model: settings.voice?.transcribeModel || 'gpt-4o-transcribe',
        language: settings.voice?.language ?? '',
        prompt: settings.voice?.prompt ?? '',
      };
    },
  });
  appEvents.on('composio:save-key', ({ apiKey }) => {
    composioModule.setApiKey(apiKey);
    void getSettingsStore()
      .set({ composio: { apiKey } })
      .catch((error) => logger.error('failed to save composio key', error));
  });
  // Expose the connected apps' tools to the agent through the registry's
  // dynamic-tool provider. Consulted live, so a newly-connected app's tools
  // reach chat and Claude Code with no restart.
  registry.registerDynamicToolProvider(() => composioModule.dynamicTools());
  appEvents.on('composio:connections-changed', () => {
    void composioModule.refreshTools();
  });

  // Supermemory: honour the user's settings. The module already started with
  // safe defaults (enabled, default port) so the common case is live; here we
  // shut it down if the user has turned the memory engine off.
  getSettingsStore()
    .get()
    .then(async (settings) => {
      const sm = settings.supermemory;
      supermemoryModule.configure({ enabled: sm?.enabled, port: sm?.port });
      if (sm?.enabled === false) await supermemoryModule.stop?.();
      return undefined;
    })
    .catch(() => {});

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
