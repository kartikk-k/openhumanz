/**
 * The orchestrator.
 *
 * The app owns orchestration; the agent CLI executes. That sentence is the
 * whole design, and this file is where it becomes code: a request is decomposed
 * into steps, each step is exactly one CLI invocation with its own tool scope
 * and its own budget, and the step boundary is the only place durability is
 * claimed. A CLI subprocess is not a resumable graph and nothing here pretends
 * it is — we do not checkpoint inside a turn. We make sure that when a turn
 * dies, everything before it is on disk and coherent.
 *
 * Per step, in order, with teardown in a `finally` so a thrown step still
 * narrows the blast radius back down:
 *
 *   1. register the step's allowed tools with the MCP server (gate one),
 *   2. write the per-invocation MCP config into a fresh 0700 temp dir,
 *   3. invoke the engine with an explicit turn and cost ceiling (gate two),
 *   4. stream events, persisting each to the transcript as it arrives,
 *   5. revoke the registration and delete the config.
 *
 * Neither the engine adapter nor the MCP server is imported. Both arrive as
 * interfaces from `./types`, which is what lets the whole thing be tested under
 * `bun` with a stub engine that spawns nothing.
 */
import type { EventBus } from '../../infra/events';
import type { Logger } from '../../infra/logger';
import type { WorkspacePaths } from '../../infra/paths';
import type { JsonObject, Usage } from '../../../shared/common';
import { nowIso } from '../../../shared/common';
import type {
  Run,
  RunStartRequest,
  RunStartRequestInput,
  RunStatus,
  RunStep,
  ToolCall,
} from '../../../shared/runs';
import {
  RunStartRequestSchema,
  TERMINAL_RUN_STATUSES,
} from '../../../shared/runs';
import type { FailureKind, RunStore } from '../../modules/runs/store';
import { classifyFailure, describeFailure, isQuotaKind } from './failures';
import { writeMcpConfig } from './mcp-config';
import type { WrittenMcpConfig } from './mcp-config';
import {
  DEFAULT_MAX_COST_USD,
  DEFAULT_MAX_TURNS,
  createDefaultPlanner,
  titleFromPrompt,
} from './planner';
import type {
  EngineEvent,
  EngineFailureKind,
  EngineInvocation,
  EngineProvider,
  McpScopeRegistrar,
  McpStepScope,
  PlannedStep,
  Planner,
} from './types';

export * from './types';
export { classifyFailure, describeFailure, isQuotaKind } from './failures';
export {
  DEFAULT_MAX_COST_USD,
  DEFAULT_MAX_TURNS,
  PlanInputSchema,
  createDefaultPlanner,
  normalizeStep,
  titleFromPrompt,
} from './planner';
export { buildMcpConfig, writeMcpConfig } from './mcp-config';
export type { McpConfigFile, WrittenMcpConfig } from './mcp-config';

/* ------------------------------------------------------------------ */
/* Options and surface                                                 */
/* ------------------------------------------------------------------ */

export interface OrchestratorOptions {
  store: RunStore;
  engines: EngineProvider;
  mcp: McpScopeRegistrar;
  paths: WorkspacePaths;
  events: EventBus;
  logger: Logger;
  planner?: Planner;
  defaults?: {
    engine?: string;
    cwd?: string;
    maxTurns?: number;
    maxCostUsd?: number;
    allowedTools?: string[];
    model?: string;
  };
  /**
   * How long to wait for an adapter to shut its stream down after a cancel
   * before giving up on it and marking the run cancelled anyway. Default 10 s.
   */
  cancelGraceMs?: number;
}

/**
 * Starting a run on an external event.
 *
 * `condition` is **required**, and not by accident. An unconditional timer
 * around a CLI invocation exhausts a weekly quota by Tuesday; if the check is
 * optional then somebody eventually omits it at 2am. When there is genuinely
 * nothing to check, pass `() => true` — and then it is visible in review that
 * nothing is being checked.
 */
export interface ConditionalStartOptions {
  request: RunStartRequestInput;
  /** File mtime moved, unread count changed, time window open. No model here. */
  condition: () => boolean | Promise<boolean>;
  /** Recorded when the condition says no. */
  reason?: string;
}

export interface ConditionalStartResult {
  started: boolean;
  run?: Run;
  /** Why nothing was started. */
  skipped?: string;
}

export interface Orchestrator {
  /** Persist the run, return immediately, execute in the background. */
  start(request: RunStartRequestInput): Promise<Run>;
  /** Start only if a deterministic condition holds. See the type docs. */
  startIfCondition(
    options: ConditionalStartOptions,
  ): Promise<ConditionalStartResult>;
  /** Kill the process tree and leave the run coherently persisted. */
  cancel(runId: string): Promise<{ id: string; status: RunStatus }>;
  /** Re-run a finished run's original request. History is re-runnable. */
  rerun(runId: string): Promise<Run>;
  /** Resolves when a run reaches a terminal status. */
  waitFor(runId: string): Promise<Run>;
  activeRunIds(): string[];
  /** Cancel everything. For `before-quit`. */
  shutdown(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

interface ActiveRun {
  runId: string;
  controller: AbortController;
  done: Promise<void>;
}

interface StepOutcome {
  status: 'succeeded' | 'failed' | 'cancelled';
  usage: Usage;
  sessionId?: string;
  summary?: string;
  error?: string;
  failureKind?: EngineFailureKind;
}

/** Add `b` into `a`. Costs and tokens sum; the model is whatever spoke last. */
function mergeUsage(a: Usage, b: Usage | undefined): Usage {
  if (!b) return a;
  const add = (
    left: number | undefined,
    right: number | undefined,
  ): number | undefined => {
    if (left === undefined && right === undefined) return undefined;
    return (left ?? 0) + (right ?? 0);
  };
  return {
    model: b.model ?? a.model,
    inputTokens: add(a.inputTokens, b.inputTokens),
    outputTokens: add(a.outputTokens, b.outputTokens),
    cacheReadTokens: add(a.cacheReadTokens, b.cacheReadTokens),
    cacheCreationTokens: add(a.cacheCreationTokens, b.cacheCreationTokens),
    totalCostUsd: add(a.totalCostUsd, b.totalCostUsd),
    durationMs: add(a.durationMs, b.durationMs),
    turns: add(a.turns, b.turns),
  };
}

/**
 * Within a single step, engines report usage cumulatively (a running total for
 * the invocation). Replacing rather than summing is what keeps the cost meter
 * honest; summing a running total triple-counts by the third message.
 */
function applyUsage(current: Usage, incoming: Usage): Usage {
  return { ...current, ...incoming };
}

const MAX_SUMMARY_LENGTH = 400;

function compact(
  value: string | undefined,
  max = MAX_SUMMARY_LENGTH,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Resolves to `sentinel` when the signal aborts. Never rejects. */
function onAbort<T>(signal: AbortSignal, sentinel: T): Promise<T> {
  if (signal.aborted) return Promise.resolve(sentinel);
  return new Promise<T>((resolve) => {
    signal.addEventListener('abort', () => resolve(sentinel), { once: true });
  });
}

/* ------------------------------------------------------------------ */
/* The orchestrator                                                    */
/* ------------------------------------------------------------------ */

export function createOrchestrator(options: OrchestratorOptions): Orchestrator {
  const { store, engines, mcp, paths, events, logger } = options;
  const planner = options.planner ?? createDefaultPlanner();
  const cancelGraceMs = options.cancelGraceMs ?? 10_000;
  const defaults = {
    engine: options.defaults?.engine ?? engines.defaultEngineId,
    cwd: options.defaults?.cwd ?? paths.root,
    maxTurns: options.defaults?.maxTurns ?? DEFAULT_MAX_TURNS,
    maxCostUsd: options.defaults?.maxCostUsd ?? DEFAULT_MAX_COST_USD,
    allowedTools: options.defaults?.allowedTools ?? [],
    model: options.defaults?.model,
  };

  const active = new Map<string, ActiveRun>();
  const waiters = new Map<string, ((run: Run) => void)[]>();

  const settle = (runId: string): void => {
    const run = store.getRun(runId);
    const list = waiters.get(runId);
    waiters.delete(runId);
    if (run) for (const resolve of list ?? []) resolve(run);
  };

  /* ---------------- one step == one CLI invocation ---------------- */

  const runStep = async (
    run: Run,
    step: RunStep,
    plannedStep: PlannedStep,
    controller: AbortController,
    inheritedSessionId: string | undefined,
  ): Promise<StepOutcome> => {
    const stepLogger = logger.child(`step${step.index}`);
    const startedAt = nowIso();
    const startedMs = Date.now();
    const maxTurns = plannedStep.maxTurns ?? defaults.maxTurns;
    const maxCostUsd = plannedStep.maxCostUsd ?? defaults.maxCostUsd;
    const cwd = plannedStep.cwd ?? run.cwd ?? defaults.cwd;

    let usage: Usage = {};
    let sessionId = plannedStep.continueSession
      ? inheritedSessionId
      : undefined;
    let summary: string | undefined;
    let failure: { kind: EngineFailureKind; message: string } | undefined;
    let sawResult = false;
    let resultOk = false;

    const running = store.updateStep(step.id, {
      status: 'running',
      startedAt,
      sessionId: sessionId ?? null,
    });
    await store.append(run.id, { type: 'step.started', step: running });

    let scope: McpStepScope | undefined;
    let config: WrittenMcpConfig | undefined;
    /** MCP call id -> our tool call row id. */
    const mcpCalls = new Map<string, string>();
    /** Rows already claimed by an MCP call, so two calls cannot adopt one row. */
    const adoptedRows = new Set<string>();

    /**
     * The open row the engine opened for this MCP tool, if any. The engine
     * reports the namespaced name (`mcp__assistant__memory_search`); our server
     * reports the bare one.
     */
    const adoptEngineToolCall = (
      stepId: string,
      mcpToolName: string,
    ): ToolCall | undefined => {
      const candidate = store
        .listToolCalls(run.id)
        .find(
          (call) =>
            call.stepId === stepId &&
            !call.finishedAt &&
            !adoptedRows.has(call.id) &&
            (call.name === mcpToolName ||
              call.name.endsWith(`__${mcpToolName}`)),
        );
      if (candidate) adoptedRows.add(candidate.id);
      return candidate;
    };

    /** Fold one engine event into step state. Returns true to stop the stream. */
    const handle = async (event: EngineEvent): Promise<boolean> => {
      switch (event.type) {
        case 'session': {
          sessionId = event.sessionId;
          store.updateStep(step.id, { sessionId: event.sessionId });
          if (!store.getRun(run.id)?.sessionId) {
            store.updateRun(run.id, { sessionId: event.sessionId });
          }
          return false;
        }

        case 'message': {
          await store.append(run.id, {
            type: 'message',
            stepId: step.id,
            role: event.role,
            text: event.text,
          });
          return false;
        }

        case 'tool_use': {
          const row = store.createToolCall({
            runId: run.id,
            stepId: step.id,
            name: event.name,
            arguments: event.input,
            // The engine's own view of the call. Whether it is side-effecting
            // is our server's call to make, and a native CLI tool never
            // reaches the gate at all.
            sideEffecting: false,
            status: 'running',
            externalId: event.id,
          });
          await store.append(run.id, { type: 'tool.call', call: row });
          return false;
        }

        case 'tool_result': {
          const existing = store.findOpenToolCall(step.id, {
            externalId: event.id,
            name: event.name,
          });
          if (!existing) return false;
          const finishedAt = nowIso();
          const row = store.updateToolCall(existing.id, {
            status: event.ok ? 'succeeded' : 'failed',
            finishedAt,
            durationMs: Math.max(
              0,
              Date.parse(finishedAt) - Date.parse(existing.startedAt),
            ),
            resultSummary: compact(event.summary) ?? null,
            error: event.error ?? null,
          });
          await store.append(run.id, { type: 'tool.result', call: row });
          return false;
        }

        case 'usage': {
          usage = applyUsage(usage, event.usage);
          await store.append(run.id, {
            type: 'usage',
            stepId: step.id,
            usage,
          });

          // The ceiling is not decoration. The CLI is told about it too, but a
          // flag a build silently ignores is not a limit.
          if ((usage.totalCostUsd ?? 0) > maxCostUsd) {
            failure = {
              kind: 'budget_exceeded',
              message: `Step cost ${(usage.totalCostUsd ?? 0).toFixed(4)} USD passed its ${maxCostUsd} USD ceiling.`,
            };
            controller.abort();
            return true;
          }
          if ((usage.turns ?? 0) > maxTurns) {
            failure = {
              kind: 'max_turns',
              message: `Step used ${usage.turns} turns, past its ${maxTurns}-turn ceiling.`,
            };
            controller.abort();
            return true;
          }
          return false;
        }

        case 'log': {
          await store.append(run.id, {
            type: 'log',
            level: event.level,
            message: event.message,
          });
          return false;
        }

        case 'error': {
          const kind = event.kind ?? classifyFailure(event.message);
          failure = { kind, message: event.message };
          await store.append(run.id, {
            type: 'log',
            level: isQuotaKind(kind) ? 'warn' : 'error',
            message: describeFailure(kind, event.message),
          });
          // Retrying into an exhausted quota or a rejected login only burns
          // wall clock, so those end the step immediately.
          return isQuotaKind(kind) || kind === 'auth';
        }

        case 'result': {
          sawResult = true;
          resultOk = event.ok;
          if (event.usage) usage = applyUsage(usage, event.usage);
          usage = {
            ...usage,
            turns: event.turns ?? usage.turns,
            durationMs: event.durationMs ?? usage.durationMs,
          };
          if (event.sessionId) {
            sessionId = event.sessionId;
            store.updateStep(step.id, { sessionId: event.sessionId });
          }
          summary = compact(event.summary) ?? summary;
          if (event.ok) {
            // A recoverable error earlier does not make a successful run fail.
            failure = undefined;
          } else {
            const kind =
              event.failureKind ??
              failure?.kind ??
              classifyFailure(event.error, event.summary);
            failure = {
              kind,
              message: event.error ?? 'The engine reported a failure.',
            };
          }
          return true;
        }

        default:
          return false;
      }
    };

    try {
      /* 1. gate one — what this step may reach through our own server */
      scope = await mcp.register({
        runId: run.id,
        stepId: step.id,
        allowedTools: plannedStep.allowedTools,
        cwd,
        signal: controller.signal,
        onToolCall: (call) => {
          // The same physical call reaches us twice: the CLI announces
          // `mcp__assistant__memory_search` on stdout, and our own server sees
          // `memory_search` arrive over the socket. The two ids are minted
          // independently and cannot be correlated, so the engine's row is
          // adopted by name rather than duplicated — one call, one timeline row.
          const adopted = adoptEngineToolCall(step.id, call.name);
          const row = adopted
            ? store.updateToolCall(adopted.id, {
                sideEffecting: call.sideEffecting,
                approvalId: call.approvalId ?? null,
                status: call.approvalId ? 'awaiting_approval' : adopted.status,
              })
            : store.createToolCall({
                runId: run.id,
                stepId: step.id,
                name: call.name,
                arguments: call.arguments,
                sideEffecting: call.sideEffecting,
                status: call.approvalId ? 'awaiting_approval' : 'running',
                approvalId: call.approvalId,
                externalId: call.callId,
              });
          mcpCalls.set(call.callId, row.id);
          void store
            .append(run.id, { type: 'tool.call', call: row })
            .catch(() => undefined);
        },
        onToolResult: (result) => {
          const rowId = mcpCalls.get(result.callId);
          if (!rowId) return;
          const existing = store.getToolCall(rowId);
          const finishedAt = nowIso();
          let status: 'awaiting_approval' | 'succeeded' | 'failed';
          if (result.awaitingApproval) status = 'awaiting_approval';
          else if (result.ok) status = 'succeeded';
          else status = 'failed';
          const row = store.updateToolCall(rowId, {
            status,
            approvalId: result.approvalId ?? existing?.approvalId ?? null,
            // A call parked at the gate has not finished; leaving finishedAt
            // null is what keeps it visibly pending in the timeline.
            finishedAt: result.awaitingApproval ? null : finishedAt,
            durationMs:
              result.awaitingApproval || !existing
                ? null
                : Math.max(
                    0,
                    Date.parse(finishedAt) - Date.parse(existing.startedAt),
                  ),
            resultSummary: compact(result.summary) ?? null,
            error: result.error ?? null,
          });
          void store
            .append(run.id, { type: 'tool.result', call: row })
            .catch(() => undefined);
        },
      });

      /* 2. per-invocation config — never the user's global or project one */
      config = await writeMcpConfig(paths, scope);

      const adapter = engines.get(run.engine);
      if (!adapter) {
        throw new Error(
          `No engine adapter for "${run.engine}". Is the CLI installed?`,
        );
      }

      /* 3. gate two — the allowlist the CLI itself is handed */
      const invocation: EngineInvocation = {
        runId: run.id,
        stepId: step.id,
        prompt: plannedStep.prompt,
        cwd,
        sessionId,
        maxTurns,
        maxCostUsd,
        allowedTools: [
          ...new Set([...plannedStep.allowedTools, ...scope.exposedToolNames]),
        ],
        mcpConfigPath: config.path,
        model: plannedStep.model ?? defaults.model,
        stderrLogPath: paths.runStderrFile(run.id),
        signal: controller.signal,
      };

      stepLogger.debug('invoking engine', {
        stepId: step.id,
        engine: adapter.id,
        maxTurns,
        maxCostUsd,
        tools: invocation.allowedTools.length,
      });

      /* 4. stream and persist */
      const iterator = adapter
        .run(invocation)
        [Symbol.asyncIterator]() as AsyncIterator<EngineEvent>;

      const ABORTED = Symbol('aborted');
      const abortPromise = onAbort(controller.signal, ABORTED);

      let streaming = true;
      while (streaming) {
        const pending = iterator.next();
        // Racing rather than plain `for await`: a well-behaved adapter ends its
        // own stream on abort, but cancel must not depend on the adapter being
        // well-behaved. If abort wins, `return()` kills the tree.
        // eslint-disable-next-line no-await-in-loop
        const next = await Promise.race([pending, abortPromise]);
        if (next === ABORTED) {
          pending.catch(() => undefined);
          streaming = false;
          break;
        }
        const settled = next as IteratorResult<EngineEvent>;
        if (settled.done) break;

        const engineEvent = settled.value;
        // Raw payloads go to engine.jsonl. The transcript stays the timeline.
        void store
          .appendRaw(run.id, {
            at: nowIso(),
            stepId: step.id,
            raw: (engineEvent as { raw?: unknown }).raw ?? engineEvent,
          })
          .catch(() => undefined);

        // eslint-disable-next-line no-await-in-loop
        if (await handle(engineEvent)) break;
      }

      // Whether we broke out or ran dry, the adapter is told to shut down. Its
      // `return()` is what kills the process tree; it is given a grace window
      // so a hung child cannot wedge a cancel.
      if (iterator.return) {
        // Deliberately *not* unref'd: this timeout is actively awaited, and it
        // is the only thing standing between a wedged child and a cancel that
        // never returns. It is always cleared, so a healthy step pays nothing.
        let timeoutHandle: NodeJS.Timeout | undefined;
        const timedOut = new Promise<'timeout'>((resolve) => {
          timeoutHandle = setTimeout(() => resolve('timeout'), cancelGraceMs);
        });
        const closed = await Promise.race([
          iterator.return().then(
            () => 'closed' as const,
            () => 'closed' as const,
          ),
          timedOut,
        ]);
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (closed === 'timeout') {
          stepLogger.warn('engine did not shut its stream down in time', {
            stepId: step.id,
            cancelGraceMs,
          });
        }
      }
    } catch (cause) {
      const message = errorMessage(cause);
      failure = failure ?? { kind: classifyFailure(message), message };
      stepLogger.error('step threw', { stepId: step.id, error: message });
    } finally {
      /* 5. narrow the blast radius back down, whatever happened */
      if (scope) {
        await scope.revoke().catch((cause: unknown) => {
          stepLogger.warn('failed to revoke mcp step scope', {
            stepId: step.id,
            error: errorMessage(cause),
          });
        });
      }
      await config?.cleanup().catch(() => undefined);
    }

    /* ---- settle the step ---- */

    const cancelled = controller.signal.aborted && !failure;
    const finishedAt = nowIso();
    const durationMs = Date.now() - startedMs;

    let status: StepOutcome['status'];
    if (cancelled) {
      status = 'cancelled';
    } else if (failure) {
      status = 'failed';
    } else if (sawResult && resultOk) {
      status = 'succeeded';
    } else {
      // A stream that ended without a result line is a dead process, not a
      // quiet success.
      failure = failure ?? {
        kind: 'engine_error',
        message: 'The engine stream ended without a final result.',
      };
      status = 'failed';
    }

    const finalUsage: Usage = {
      ...usage,
      durationMs: usage.durationMs ?? durationMs,
    };
    const failureKind: FailureKind | undefined = cancelled
      ? 'cancelled'
      : (failure?.kind as FailureKind | undefined);

    let stepError: string | null = null;
    if (failure) stepError = describeFailure(failure.kind, failure.message);
    else if (cancelled) stepError = 'Cancelled.';

    const finished = store.updateStep(step.id, {
      status,
      finishedAt,
      durationMs,
      usage: finalUsage,
      sessionId: sessionId ?? null,
      summary: summary ?? null,
      error: stepError,
      failureKind: failureKind ?? null,
    });
    await store.append(run.id, { type: 'step.finished', step: finished });

    return {
      status,
      usage: finalUsage,
      sessionId,
      summary,
      error: finished.error,
      failureKind: failureKind as EngineFailureKind | undefined,
    };
  };

  /* ---------------- one run ---------------- */

  const execute = async (
    created: Run,
    request: RunStartRequest,
    controller: AbortController,
  ): Promise<void> => {
    const runLogger = logger.child(created.id);
    const startedAt = nowIso();
    const startedMs = Date.now();

    let status: RunStatus = 'running';
    let failureKind: FailureKind | undefined;
    let error: string | undefined;
    let usage: Usage = {};
    let sessionId: string | undefined;

    const started = store.updateRun(created.id, {
      status: 'running',
      startedAt,
    });
    await store.append(created.id, { type: 'run.started', run: started });
    await store.append(created.id, { type: 'run.status', status: 'running' });

    try {
      const plan = await planner.plan(
        {
          prompt: request.prompt,
          title: request.title,
          allowedTools: request.allowedTools,
          maxTurns: request.maxTurns,
          maxCostUsd: request.maxCostUsd,
          metadata: request.metadata,
        },
        {
          runId: created.id,
          engineId: created.engine,
          cwd: created.cwd ?? defaults.cwd,
          defaults: {
            maxTurns: request.maxTurns ?? defaults.maxTurns,
            maxCostUsd: request.maxCostUsd ?? defaults.maxCostUsd,
            allowedTools: request.allowedTools ?? defaults.allowedTools,
          },
        },
      );

      if (plan.steps.length === 0) {
        throw new Error('The planner produced no steps.');
      }

      // The whole plan is persisted up front, so the timeline shows what is
      // coming and not only what already happened.
      const rows = plan.steps.map((planned, index) =>
        store.createStep({
          runId: created.id,
          index,
          name: planned.name,
          prompt: planned.prompt,
          allowedTools: planned.allowedTools,
          cwd: planned.cwd,
          maxTurns: planned.maxTurns,
          maxCostUsd: planned.maxCostUsd,
        }),
      );
      if (plan.title && plan.title !== created.title) {
        store.updateRun(created.id, { title: plan.title });
      }
      await store.append(created.id, {
        type: 'log',
        level: 'info',
        message: `Planned ${rows.length} step${rows.length === 1 ? '' : 's'}: ${rows
          .map((step) => step.name)
          .join(' → ')}`,
      });

      for (let index = 0; index < rows.length; index += 1) {
        if (controller.signal.aborted) break;

        // Sequential by definition: one step is one CLI invocation, and the
        // next may resume the session this one establishes.
        // eslint-disable-next-line no-await-in-loop
        const outcome = await runStep(
          store.getRun(created.id) ?? created,
          rows[index],
          plan.steps[index],
          controller,
          sessionId,
        );

        usage = mergeUsage(usage, outcome.usage);
        if (outcome.sessionId) sessionId = outcome.sessionId;

        if (outcome.status !== 'succeeded') {
          status = outcome.status === 'cancelled' ? 'cancelled' : 'failed';
          failureKind =
            outcome.status === 'cancelled'
              ? 'cancelled'
              : ((outcome.failureKind ?? 'engine_error') as FailureKind);
          error = outcome.error;
          // Everything downstream depended on this step, so it is marked
          // rather than attempted with a missing precondition.
          for (const remaining of rows.slice(index + 1)) {
            store.updateStep(remaining.id, {
              status: status === 'cancelled' ? 'cancelled' : 'skipped',
              error:
                status === 'cancelled'
                  ? 'Cancelled before this step ran.'
                  : 'Skipped: an earlier step failed.',
            });
          }
          break;
        }

        if (index === rows.length - 1) status = 'succeeded';
      }

      if (controller.signal.aborted && status !== 'failed') {
        status = 'cancelled';
        failureKind = 'cancelled';
        error = error ?? 'Cancelled.';
        for (const row of store.listSteps(created.id)) {
          if (row.status === 'pending' || row.status === 'running') {
            store.updateStep(row.id, {
              status: 'cancelled',
              error: 'Cancelled before this step ran.',
            });
          }
        }
      }
    } catch (cause) {
      const message = errorMessage(cause);
      status = controller.signal.aborted ? 'cancelled' : 'failed';
      failureKind =
        status === 'cancelled'
          ? 'cancelled'
          : (classifyFailure(message) as FailureKind);
      error = message;
      runLogger.error('run failed', { error: message });
    }

    const durationMs = Date.now() - startedMs;
    const finalUsage: Usage = { ...usage, durationMs };
    store.updateRun(created.id, {
      status,
      finishedAt: nowIso(),
      durationMs,
      usage: finalUsage,
      sessionId: sessionId ?? null,
      error: error ?? null,
      failureKind: failureKind ?? null,
    });

    await store.append(created.id, { type: 'run.status', status });
    await store.append(created.id, {
      type: 'run.finished',
      status,
      usage: finalUsage,
      error: error ?? undefined,
      // `Run.failureKind` is a real field now; the event carries it too so a
      // live timeline can say "out of quota" without re-fetching the run.
      failureKind,
    });
    await store.flush(created.id);

    active.delete(created.id);
    runLogger.info('run finished', {
      status,
      failureKind,
      costUsd: finalUsage.totalCostUsd,
      turns: finalUsage.turns,
    });
    settle(created.id);
  };

  /* ---------------- public surface ---------------- */

  const startRun = async (input: RunStartRequestInput): Promise<Run> => {
    const request = RunStartRequestSchema.parse(input);
    const run = store.createRun({
      title: request.title ?? titleFromPrompt(request.prompt),
      prompt: request.prompt,
      engine: request.engine ?? defaults.engine,
      trigger: request.trigger,
      cwd: request.cwd ?? defaults.cwd,
      goalId: request.goalId,
      taskId: request.taskId,
      scheduledJobId: request.scheduledJobId,
      metadata: request.metadata ?? {},
      status: 'queued',
    });

    const controller = new AbortController();
    const entry: ActiveRun = {
      runId: run.id,
      controller,
      done: Promise.resolve(),
    };
    // Deliberately not awaited: `runs:start` hands a Run back to the renderer
    // immediately and the timeline fills in over IPC.
    entry.done = execute(run, request, controller).catch((cause: unknown) => {
      logger.error('run executor crashed', {
        runId: run.id,
        error: errorMessage(cause),
      });
      active.delete(run.id);
      settle(run.id);
    });
    active.set(run.id, entry);
    return run;
  };

  const orchestrator: Orchestrator = {
    start: startRun,

    async startIfCondition({ request, condition, reason }) {
      if (typeof condition !== 'function') {
        throw new Error(
          'startIfCondition requires a deterministic condition. An unconditional ' +
            'timer around a CLI invocation exhausts a weekly quota by Tuesday.',
        );
      }
      let passed = false;
      try {
        passed = await condition();
      } catch (cause) {
        const message = errorMessage(cause);
        logger.warn('start condition threw; not starting', { error: message });
        return { started: false, skipped: `condition failed: ${message}` };
      }
      if (!passed) {
        logger.debug('start condition not met', { reason });
        return { started: false, skipped: reason ?? 'condition not met' };
      }
      return { started: true, run: await startRun(request) };
    },

    async cancel(runId) {
      const current = store.getRun(runId);
      if (!current) throw new Error(`Unknown run: ${runId}`);
      if (TERMINAL_RUN_STATUSES.includes(current.status)) {
        return { id: runId, status: current.status };
      }

      const entry = active.get(runId);
      if (!entry) {
        // Not executing here — a restart, or another window. Still leave the
        // row terminal rather than stuck at "running" forever.
        const finishedAt = nowIso();
        const updated = store.updateRun(runId, {
          status: 'cancelled',
          finishedAt,
          failureKind: 'cancelled',
          error: 'Cancelled.',
          durationMs: current.startedAt
            ? Math.max(
                0,
                Date.parse(finishedAt) - Date.parse(current.startedAt),
              )
            : 0,
        });
        for (const row of store.listSteps(runId)) {
          if (!['succeeded', 'failed', 'cancelled'].includes(row.status)) {
            store.updateStep(row.id, {
              status: 'cancelled',
              error: 'Cancelled.',
            });
          }
        }
        await store.append(runId, { type: 'run.status', status: 'cancelled' });
        await store.append(runId, {
          type: 'run.finished',
          status: 'cancelled',
          error: 'Cancelled.',
        });
        return { id: runId, status: updated.status };
      }

      // Abort reaches the adapter; ending the stream is what makes it kill the
      // process tree. Both happen, and we wait for the run to settle so the
      // caller is told the truth about what is on disk.
      entry.controller.abort();
      await entry.done;
      return { id: runId, status: store.getRun(runId)?.status ?? 'cancelled' };
    },

    async rerun(runId) {
      const previous = store.getRun(runId);
      if (!previous) throw new Error(`Unknown run: ${runId}`);
      const metadata: JsonObject = { ...previous.metadata, rerunOf: runId };
      // Legacy rows still carry the old mirrors; a rerun must not inherit the
      // previous attempt's failure. Nothing writes these any more.
      delete metadata.failureKind;
      delete metadata.quotaFailure;
      return startRun({
        title: previous.title,
        prompt: previous.prompt,
        engine: previous.engine,
        trigger: previous.trigger,
        cwd: previous.cwd,
        goalId: previous.goalId,
        taskId: previous.taskId,
        scheduledJobId: previous.scheduledJobId,
        metadata,
      });
    },

    waitFor(runId) {
      const current = store.getRun(runId);
      if (!current) return Promise.reject(new Error(`Unknown run: ${runId}`));
      if (
        TERMINAL_RUN_STATUSES.includes(current.status) &&
        !active.has(runId)
      ) {
        return Promise.resolve(current);
      }
      return new Promise<Run>((resolve) => {
        const list = waiters.get(runId) ?? [];
        list.push(resolve);
        waiters.set(runId, list);
      });
    },

    activeRunIds() {
      return [...active.keys()];
    },

    async shutdown() {
      const ids = [...active.keys()];
      await Promise.all(
        ids.map((runId) => orchestrator.cancel(runId).catch(() => undefined)),
      );
      events.emit('app:quitting', {});
    },
  };

  return orchestrator;
}
