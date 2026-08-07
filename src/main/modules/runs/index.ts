/**
 * The `runs` module.
 *
 * Owns the run tables, the transcript files, and the `runs:*` slice of the IPC
 * surface. It is the data behind the run timeline — the highest-value screen in
 * the product — so its job is to be complete and boring: every step, every
 * timing, every dollar, reloadable from disk after a crash.
 *
 * What it deliberately does **not** own is execution. Starting and cancelling a
 * run is the orchestrator's business, and the orchestrator is a service; a
 * module may not import one. So a {@link RunLauncher} is injected by `main.ts`
 * through {@link configureRuns}, and until it is, `runs:start` fails loudly
 * rather than silently doing nothing.
 *
 * Likewise the approvals module is never imported. Pending approvals reach the
 * timeline as a projection fed from the event bus.
 */
import type { AppModule, IpcHandlerMap } from '../types';
import { migrations } from './migrations';
import { createRunStore } from './store';
import type { RunStore } from './store';
import { createRunFanout } from './fanout';
import type { RunFanout, RunPushSink } from './fanout';
import { nowIso } from '../../../shared/common';
import type { Run, RunStatus } from '../../../shared/runs';
import {
  RunEventsQuerySchema,
  RunListQuerySchema,
  RunStartRequestSchema,
  TERMINAL_RUN_STATUSES,
} from '../../../shared/runs';

export { createRunStore, isQuotaFailure, FAILURE_KINDS } from './store';
export type {
  CreateRunInput,
  CreateStepInput,
  CreateToolCallInput,
  FailureKind,
  RawEngineEntry,
  RunEventDraft,
  RunPatch,
  RunStore,
  StepPatch,
  ToolCallPatch,
} from './store';
export { createRunFanout } from './fanout';
export type { RunFanout, RunPushSink } from './fanout';

/**
 * The orchestrator, as this module needs to see it. Two methods, so the module
 * stays testable with a fake and so nothing here can reach into execution.
 */
export interface RunLauncher {
  start(request: unknown): Promise<Run>;
  cancel(runId: string): Promise<{ id: string; status: RunStatus }>;
}

export interface RunsWiring {
  /** The orchestrator. Without it `runs:start` throws. */
  launcher?: RunLauncher;
  /** Delivers `push:run-events` / `push:run-status`. Normally electron. */
  sink?: RunPushSink;
}

export interface RunsModule extends AppModule {
  /** The live store. Throws before `start()`. */
  store(): RunStore;
  fanout(): RunFanout;
  configure(wiring: RunsWiring): void;
}

export function createRunsModule(): RunsModule {
  let store: RunStore | null = null;
  let fanout: RunFanout | null = null;
  let launcher: RunLauncher | undefined;
  let pendingSink: RunPushSink | undefined;
  const cleanup: (() => void)[] = [];

  const requireStore = (): RunStore => {
    if (!store) {
      throw new Error('The runs module has not started yet.');
    }
    return store;
  };

  const requireFanout = (): RunFanout => {
    if (!fanout) throw new Error('The runs module has not started yet.');
    return fanout;
  };

  const ipc: IpcHandlerMap = {
    'runs:list': async (request) =>
      requireStore().listRuns(RunListQuerySchema.parse(request ?? {})),

    'runs:get': async (request) => requireStore().getRunDetail(request.id),

    'runs:start': async (request) => {
      const parsed = RunStartRequestSchema.parse(request);
      if (!launcher) {
        throw new Error(
          'No orchestrator is wired up, so runs cannot be started. ' +
            'Call configureRuns({ launcher }) from main.ts.',
        );
      }
      return launcher.start(parsed);
    },

    'runs:cancel': async (request) => {
      if (launcher) return launcher.cancel(request.id);

      // No orchestrator (headless, or it crashed): still leave the row in a
      // coherent terminal state rather than reporting a lie.
      const current = requireStore().getRun(request.id);
      if (!current) throw new Error(`Unknown run: ${request.id}`);
      if (TERMINAL_RUN_STATUSES.includes(current.status)) {
        return { id: current.id, status: current.status };
      }
      const finishedAt = nowIso();
      const updated = requireStore().updateRun(request.id, {
        status: 'cancelled',
        finishedAt,
        failureKind: 'cancelled',
        durationMs: current.startedAt
          ? Math.max(0, Date.parse(finishedAt) - Date.parse(current.startedAt))
          : 0,
      });
      return { id: updated.id, status: updated.status };
    },

    'runs:events': async (request) =>
      requireStore().readEvents(RunEventsQuerySchema.parse(request)),

    'runs:subscribe': async (request, ctx) => {
      requireFanout().subscribe(request.id, ctx.senderId);
      return { ok: true as const };
    },

    'runs:unsubscribe': async (request, ctx) => {
      requireFanout().unsubscribe(request.id, ctx.senderId);
      return { ok: true as const };
    },
  };

  return {
    id: 'runs',
    migrations,
    ipc,

    store: requireStore,
    fanout: requireFanout,

    configure(wiring) {
      if (wiring.launcher !== undefined) launcher = wiring.launcher;
      if (wiring.sink !== undefined) {
        pendingSink = wiring.sink;
        fanout?.setSink(wiring.sink);
      }
    },

    async start(ctx) {
      store = createRunStore({
        db: ctx.db,
        paths: ctx.paths,
        events: ctx.events,
        logger: ctx.logger,
      });

      // A CLI subprocess is not a resumable graph. Anything the last process
      // left mid-flight is dead, and saying so is more useful than a row that
      // claims to be running forever.
      const recovered = store.recoverInterruptedRuns();
      if (recovered.length > 0) {
        ctx.logger.warn('runs left running by a previous process', {
          count: recovered.length,
        });
      }

      fanout = createRunFanout({
        events: ctx.events,
        logger: ctx.logger.child('fanout'),
        sink: pendingSink,
      });
      fanout.start();

      // Approvals live in another module, so they arrive over the bus. Recorded
      // into the timeline here so the transcript is the whole story.
      cleanup.push(
        ctx.events.on('approval:requested', ({ approval }) => {
          const active = store;
          if (!active || !approval?.runId) return;
          active.recordApproval(approval);
          void active
            .append(approval.runId, { type: 'approval.requested', approval })
            .catch((cause: unknown) => {
              ctx.logger.error('failed to record approval', cause);
            });
        }),
      );
      cleanup.push(
        ctx.events.on(
          'approval:resolved',
          ({ approvalId, runId, decision, scope }) => {
            const active = store;
            if (!active || !runId) return;
            active.resolveApproval(approvalId);
            void active
              .append(runId, {
                type: 'approval.resolved',
                approvalId,
                decision,
                scope,
              })
              .catch((cause: unknown) => {
                ctx.logger.error('failed to record approval decision', cause);
              });
          },
        ),
      );
    },

    async stop() {
      while (cleanup.length > 0) cleanup.pop()?.();
      await fanout?.stop();
      await store?.flush();
      fanout = null;
      store = null;
    },
  };
}

/**
 * The instance the registry uses. A module is a singleton in a running app; the
 * factory exists so tests can have their own.
 */
export const runsModule: RunsModule = createRunsModule();

/** Wire the orchestrator and the IPC sink in from `main.ts`. */
export function configureRuns(wiring: RunsWiring): void {
  runsModule.configure(wiring);
}

/** The live store, for services that coordinate across modules. */
export function getRunStore(): RunStore {
  return runsModule.store();
}

export default runsModule;
