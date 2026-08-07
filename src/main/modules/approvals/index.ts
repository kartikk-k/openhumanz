/**
 * The approvals module.
 *
 * Owns `approvals_requests`, `approvals_grants` and `approvals_audit`; serves
 * the four `approvals:*` IPC channels; and exports the {@link ApprovalGate} the
 * MCP server injects into its tool-dispatch path.
 *
 * Wiring, once:
 *   1. add this module to the registry list in `main.ts`
 *   2. after `registry.start()`, hand the gate to the MCP server and give it the
 *      tool surface:
 *
 *      ```ts
 *      const gate = getApprovalGate();
 *      gate.registerTools(registry.tools());
 *      createMcpServer({ approvalGate: gate, ... });
 *      ```
 *
 *   3. forward `approval:requested` / `approval:resolved` from the bus to the
 *      renderer over `IPC_PUSH.approvalRequested` / `.approvalResolved`.
 *
 * Step 2 is not optional: without it every tool is treated as side-effecting,
 * because the gate fails closed on tools it has not been told about.
 */
import { defineModule } from '../types';
import type { AppModule, ModuleContext } from '../types';
import type { Deleted } from '../../../shared/ipc';
import type { Approval, ApprovalGrant } from '../../../shared/approvals';
import type { Unsubscribe } from '../../infra/events';
import { migrations } from './migrations';
import { createApprovalService } from './gate';
import type { ApprovalServiceInternals } from './gate';
import { approvalSettingsFrom, readApprovalSettings } from './settings';
import type { ApprovalService } from './types';

export const APPROVALS_MODULE_ID = 'approvals';

/* ------------------------------------------------------------------ */
/* The live instance                                                   */
/* ------------------------------------------------------------------ */

let active: ApprovalServiceInternals | null = null;
let waiters: Array<(service: ApprovalService) => void> = [];

/**
 * The gate, for injection into the MCP server.
 *
 * Throws before the registry has started the module, which is deliberate: a
 * service that silently got `null` here would dispatch tool calls with no gate
 * at all, and that failure has to be loud.
 */
export function getApprovalGate(): ApprovalService {
  if (!active) {
    throw new Error(
      'The approvals module has not started yet. Call this after ' +
        'registry.start(), or await whenApprovalGateReady().',
    );
  }
  return active;
}

/** Null before start. Prefer {@link getApprovalGate}. */
export function tryGetApprovalGate(): ApprovalService | null {
  return active;
}

/** Resolves as soon as the module has started. */
export function whenApprovalGateReady(): Promise<ApprovalService> {
  if (active) return Promise.resolve(active);
  return new Promise((resolve) => {
    waiters.push(resolve);
  });
}

/* ------------------------------------------------------------------ */
/* Module                                                              */
/* ------------------------------------------------------------------ */

/** Never sweep more often than this, whatever the TTL is. */
const MIN_SWEEP_MS = 15_000;
const MAX_SWEEP_MS = 5 * 60_000;

let subscriptions: Unsubscribe[] = [];
let sweepTimer: NodeJS.Timeout | null = null;

const approvalsModule: AppModule = defineModule({
  id: APPROVALS_MODULE_ID,
  migrations,

  ipc: {
    'approvals:list-pending': (request): Approval[] =>
      getApprovalGate().listPending({ runId: request?.runId }),

    'approvals:resolve': (request): Approval =>
      getApprovalGate().resolve(request),

    'approvals:list-grants': (request): ApprovalGrant[] =>
      getApprovalGate().listGrants({
        scope: request?.scope,
        runId: request?.runId,
      }),

    'approvals:revoke-grant': (request): Deleted => ({
      id: request.id,
      deleted: getApprovalGate().revokeGrant(request.id),
    }),
  },

  async start(ctx: ModuleContext) {
    const service = createApprovalService({
      db: ctx.db,
      logger: ctx.logger,
      events: ctx.events,
      settings: readApprovalSettings(ctx.paths.settingsFile),
    });
    active = service;

    // Modules do not import each other, so settings arrive over the bus.
    subscriptions.push(
      ctx.events.on('settings:changed', ({ settings }) => {
        service.applySettings(approvalSettingsFrom(settings));
      }),
    );

    // `run` grants expire with their run, and a pending approval nobody will
    // ever re-dispatch is noise on the approvals screen.
    subscriptions.push(
      ctx.events.on('run:finished', ({ runId }) => {
        service.endRun(runId);
      }),
    );

    /*
     * Pending approvals survive a restart — they live in SQLite, not in memory.
     * Re-emitting them here is what repopulates the UI after a crash or a quit,
     * so a run parked on an approval is resumable rather than stranded.
     */
    service.reloadPending();

    const ttl = service.settings().pendingTtlMs;
    if (ttl > 0) {
      const interval = Math.min(
        MAX_SWEEP_MS,
        Math.max(MIN_SWEEP_MS, Math.floor(ttl / 4)),
      );
      sweepTimer = setInterval(() => {
        try {
          service.sweepExpired();
        } catch (cause) {
          ctx.logger.error('approval sweep failed', cause);
        }
      }, interval);
      sweepTimer.unref?.();
    }

    const pendingWaiters = waiters;
    waiters = [];
    for (const resolve of pendingWaiters) resolve(service);
  },

  async stop() {
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
    for (const off of subscriptions) off();
    subscriptions = [];
    active = null;
  },
});

export default approvalsModule;

/* ------------------------------------------------------------------ */
/* Public surface                                                      */
/* ------------------------------------------------------------------ */

export {
  createApprovalService,
  capabilityFingerprint,
  argumentsHash,
} from './gate';
export type { ApprovalServiceDeps, ApprovalServiceInternals } from './gate';
export { createClassifierRegistry, dispatcherClassifier } from './classify';
export type {
  ApprovalClassification,
  ApprovalClassifier,
  ClassifierRegistry,
  DispatcherClassifierOptions,
} from './classify';
export { UNATTRIBUTED_RUN_ID } from './types';
export type {
  ApprovalCheckContext,
  ApprovalCheckResult,
  ApprovalDeniedResult,
  ApprovalGate,
  ApprovalPendingResult,
  ApprovalService,
  AuditFilter,
  GrantFilter,
  PendingFilter,
  ToolPolicy,
} from './types';
export { migrations } from './migrations';
