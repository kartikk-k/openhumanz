/**
 * The engine ↔ orchestrator bridge.
 *
 * `services/engines` and `services/orchestrator` were built without importing
 * each other, and both got the shape right for their own side of the wire. They
 * are not the same shape. This file is the only place that knows both, and it
 * translates rather than casts: an `as` here would compile and then lose the
 * session id, mis-report quota exhaustion as a budget overrun, and leak CLI
 * processes on cancel.
 *
 * Three hazards from `docs/INTEGRATION.md` are encoded here rather than left to
 * discipline, because each is silent when you get it wrong:
 *
 *  1. **`run.batches()` is never called.** The engine's queue is
 *     single-consumer: iterating both the run and its batches throws. The run
 *     is iterated directly and the orchestrator batches at the IPC boundary,
 *     which is the boundary that actually costs anything.
 *  2. **`errorKind: 'budget'` never becomes `budget_exceeded`.** The engine
 *     collapses quota and credit exhaustion into `'budget'`; in orchestrator
 *     vocabulary `budget_exceeded` means "hit the ceiling *we* set". Passing it
 *     through would tell a user who is out of plan capacity that their cost
 *     limit was too low. The error *text* goes to {@link classifyFailure}
 *     instead — which is also the only place a 429 or a weekly-limit message is
 *     recognised at all, since nothing in `services/engines` matches either.
 *  3. **`engines/run-events.ts` is not used.** `toRunEvents()` advances its own
 *     `ctx.seq`, which would be a second sequence allocator racing the run
 *     store's and would silently break `runs:events` paging. We map onto the
 *     orchestrator's `EngineEvent`; the store stamps `seq`.
 *
 * Fields that exist on one side and not the other are listed at
 * {@link translate} and {@link toRunOptions}, each with the reason it is
 * dropped. Nothing is dropped by accident.
 */
import type { EngineAuthStatus, EngineInfo } from '../../shared/engines';
import type { Usage } from '../../shared/common';
import { DEFAULT_ENGINE_ID } from './engines';
import type {
  EngineAdapter as ServiceAdapter,
  EngineErrorKind,
  EngineEvent as ServiceEvent,
  EngineRegistry,
  EngineRun,
  EngineRunOptions,
} from './engines';
import { classifyFailure } from './orchestrator';
import type {
  EngineAdapter as OrchestratorAdapter,
  EngineEvent as OrchestratorEvent,
  EngineFailureKind,
  EngineInvocation,
  EngineProvider,
} from './orchestrator';

/**
 * Prompts longer than this go down stdin instead of argv. The adapter already
 * routes a prompt starting with `-` to stdin; this covers the other way an
 * argv prompt fails, which is E2BIG on a long generated plan.
 */
const MAX_ARGV_PROMPT_CHARS = 100_000;

/* ------------------------------------------------------------------ */
/* Failure classification                                              */
/* ------------------------------------------------------------------ */

/**
 * `EngineErrorKind` → `EngineFailureKind`, with hazard 2 baked in.
 *
 * `undefined` is a deliberate answer, not a failure to answer: the orchestrator
 * falls back to `classifyFailure()` over the same text, and an honest "we don't
 * know" is better than a confident wrong label. See the table:
 *
 * | engine `errorKind` | orchestrator `failureKind`                          |
 * | ------------------ | --------------------------------------------------- |
 * | `not-installed`    | `spawn_failed`                                      |
 * | `spawn-failed`     | `spawn_failed`                                      |
 * | `auth`             | `auth`                                              |
 * | `max-turns`        | `max_turns`                                         |
 * | `timeout`          | `timeout`                                           |
 * | `cancelled`        | `cancelled`                                         |
 * | `protocol`         | `engine_error`                                      |
 * | `engine`           | `engine_error`                                      |
 * | `budget`           | **sniffed from text** — never `budget_exceeded`     |
 * | `unknown`          | sniffed from text, else `undefined`                 |
 */
function mapFailureKind(
  kind: EngineErrorKind | undefined,
  ...text: (string | undefined)[]
): EngineFailureKind | undefined {
  switch (kind) {
    case 'not-installed':
    case 'spawn-failed':
      return 'spawn_failed';
    case 'auth':
      return 'auth';
    case 'max-turns':
      return 'max_turns';
    case 'timeout':
      return 'timeout';
    case 'cancelled':
      return 'cancelled';
    case 'protocol':
    case 'engine':
      return 'engine_error';

    // Hazard 2. `classifyErrorText()` in services/engines returns 'budget' for
    // "credit balance" and "quota" alike, and `classifyResultSubtype()` returns
    // it for any subtype containing "budget" or "cost" — so this one kind spans
    // "your plan is out" and "the ceiling we passed as --max-budget-usd was
    // hit". Only the text can tell them apart, and `classifyFailure` is the
    // thing that knows how (it checks quota patterns before budget ones, so
    // "usage limit" wins over a co-occurring "cost limit").
    case 'budget':
    case 'unknown':
    case undefined: {
      const sniffed = classifyFailure(...text);
      // `engine_error` is classifyFailure's "nothing matched" answer. Returning
      // it here would stop the orchestrator re-sniffing with the extra context
      // it has (a result's `summary` as well as its `error`), so leave it unset.
      return sniffed === 'engine_error' ? undefined : sniffed;
    }

    default:
      return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Invocation → run options                                            */
/* ------------------------------------------------------------------ */

/**
 * `EngineInvocation` → `EngineRunOptions`.
 *
 * | orchestrator            | engine                    | note                                        |
 * | ----------------------- | ------------------------- | ------------------------------------------- |
 * | `prompt`                | `run(prompt, …)` argument | over stdin when very large                  |
 * | `cwd`                   | `cwd`                     | required on both sides                      |
 * | `maxTurns`              | `maxTurns`                | required on both sides                      |
 * | `maxCostUsd`            | `maxCostUsd`              | required on both sides                      |
 * | `allowedTools`          | `allowedTools`            | gate two, verbatim                          |
 * | `mcpConfigPath`         | `mcpConfigPath`           | plus `strictMcpConfig`, see below           |
 * | `model`                 | `model`                   |                                             |
 * | `stderrLogPath`         | `stderrLogPath`           |                                             |
 * | `signal`                | `signal`                  | one of two cancel paths                     |
 * | `env`                   | `env`                     | `undefined` value removes the var           |
 * | `sessionId`             | `resume()`                | **not** `options.sessionId` — see `wrap()`  |
 * | `runId`, `stepId`       | —                         | persistence identity; the CLI has no use    |
 *
 * Left unset on purpose:
 *
 *  - **`transcriptPath`.** The orchestrator owns `runs/<runId>/transcript.jsonl`
 *    and its "line N == seq N" identity is what makes `sinceSeq` a cheap skip.
 *    Handing the adapter the same path would interleave raw CLI stdout into it
 *    and break that identity. Raw payloads reach `engine.jsonl` instead, via the
 *    `raw` field the orchestrator reads off every event.
 *  - **`allowApiKeyEnv`.** Default false strips `ANTHROPIC_API_KEY` from the
 *    child. An API key silently outranks a subscription login; opting in here
 *    would bill a user for a plan they already pay for.
 *  - **`permissionMode`.** The adapter defaults to `acceptEdits`. Nothing in the
 *    orchestrator asks for a bypass mode and this is not the place to invent one.
 *  - **`batch`.** Only affects `batches()`, which hazard 1 forbids.
 *  - **`timeoutMs`.** The orchestrator has no per-step wall clock; it cancels
 *    through `signal`, and a second, invisible deadline would be worse than none.
 *  - **`includePartialMessages`, `builtinTools`, `disallowedTools`, `addDirs`,
 *    `systemPrompt`, `appendSystemPrompt`, `effort`, `fallbackModel`,
 *    `forkSession`, `binaryPath`, `logger`, `maxQueuedEvents`.** No orchestrator
 *    field maps to any of them; the adapter's defaults are the right answer.
 */
function toRunOptions(invocation: EngineInvocation): EngineRunOptions {
  return {
    maxTurns: invocation.maxTurns,
    maxCostUsd: invocation.maxCostUsd,
    cwd: invocation.cwd,
    allowedTools: invocation.allowedTools,
    mcpConfigPath: invocation.mcpConfigPath,
    // Explicit rather than relying on the adapter's default: a per-invocation
    // config is only a gate if the user's global and project MCP registries are
    // excluded from it.
    strictMcpConfig: invocation.mcpConfigPath ? true : undefined,
    model: invocation.model,
    stderrLogPath: invocation.stderrLogPath,
    signal: invocation.signal,
    env: invocation.env,
    promptVia:
      invocation.prompt.length > MAX_ARGV_PROMPT_CHARS ? 'stdin' : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Event translation                                                   */
/* ------------------------------------------------------------------ */

/** Carried across events of one invocation. */
interface StreamState {
  /** The CLI's own result line, held until `engine.finished` completes it. */
  cliResult?: Extract<ServiceEvent, { type: 'result' }>;
}

function hasKeys(usage: Usage | undefined): usage is Usage {
  return usage !== undefined && Object.keys(usage).length > 0;
}

/**
 * One engine event → zero, one or two orchestrator events.
 *
 * | engine event      | orchestrator event(s)                                        |
 * | ----------------- | ------------------------------------------------------------ |
 * | `engine.started`  | `log` (debug) — the retry attempt is worth seeing             |
 * | `session`         | `session` (+ a `log` warn when the CLI reports an API key)    |
 * | `message`         | `message` — partial deltas dropped                            |
 * | `thinking`        | *dropped* — transcript-only, as in `run-events.ts`            |
 * | `tool.call`       | `tool_use`                                                    |
 * | `tool.result`     | `tool_result`                                                 |
 * | `usage`           | `usage`                                                       |
 * | `result`          | `usage` now; the rest held for `engine.finished`              |
 * | `error`           | `error`                                                       |
 * | `log`             | `log`                                                         |
 * | `raw`             | *dropped* — see the note below                                |
 * | `engine.finished` | `result` — exactly one per invocation                         |
 *
 * Every variant that can carry `raw` gets the *engine's* event verbatim, so the
 * fields the orchestrator's vocabulary has nowhere to put (`at`, `model`,
 * `parentToolUseId`, `byModel`, `apiDurationMs`, `subtype`, `exitCode`,
 * `signal`) still land in `runs/<runId>/engine.jsonl`. The orchestrator reads
 * `raw ?? event`, so this is strictly additive.
 *
 * `thinking` and `raw` are the two events with nowhere to go: the orchestrator
 * has no variant that carries a payload *without* also creating a timeline row,
 * and turning extended thinking or an unrecognised CLI line into a visible log
 * row is exactly the noise `engine.jsonl` exists to keep out of the timeline.
 * `engines/run-events.ts` drops both for the same reason. Closing the gap needs
 * a one-line addition to the orchestrator's own union — see the report.
 */
function translate(
  event: ServiceEvent,
  out: OrchestratorEvent[],
  state: StreamState,
): void {
  switch (event.type) {
    case 'engine.started': {
      out.push({
        type: 'log',
        level: 'debug',
        message: `${event.engineId} started in ${event.cwd} (attempt ${event.attempt})`,
      });
      return;
    }

    case 'session': {
      out.push({
        type: 'session',
        sessionId: event.sessionId,
        model: event.model,
        raw: event,
      });
      // The stray-key story at run time. Detection reports it as a status; here
      // it is the CLI itself saying which credentials it picked up, which is the
      // only evidence that survives a key arriving from somewhere we did not
      // strip. `EngineInfo` has nowhere to carry it, so it becomes a warning on
      // the run's own timeline.
      if (event.apiKeySource && event.apiKeySource !== 'none') {
        out.push({
          type: 'log',
          level: 'warn',
          message: `The CLI reports its credentials came from "${event.apiKeySource}". An API key overrides subscription login and bills pay-as-you-go.`,
        });
      }
      return;
    }

    case 'message': {
      // A delta is followed by the complete message; rendering both stores the
      // same text twice. The bridge never asks for partials, so this is belt
      // and braces.
      if (event.partial) return;
      out.push({
        type: 'message',
        role: event.role,
        text: event.text,
        raw: event,
      });
      return;
    }

    case 'tool.call': {
      out.push({
        type: 'tool_use',
        id: event.toolCallId,
        name: event.name,
        input: event.arguments,
        raw: event,
      });
      return;
    }

    case 'tool.result': {
      out.push({
        type: 'tool_result',
        id: event.toolCallId,
        name: event.name,
        ok: !event.isError,
        summary: event.isError ? undefined : event.content,
        error: event.isError ? event.content : undefined,
        raw: event,
      });
      return;
    }

    case 'usage': {
      out.push({ type: 'usage', usage: event.usage, raw: event });
      return;
    }

    case 'result': {
      state.cliResult = event;
      // Forwarded immediately, not held: this is the invocation's cost, and the
      // orchestrator's own ceiling check runs on `usage` events. Holding it
      // until `engine.finished` would let a step blow its budget unnoticed for
      // as long as the process took to exit.
      if (hasKeys(event.usage)) {
        out.push({ type: 'usage', usage: event.usage, raw: event });
      }
      // Denials are why a step can finish "successfully" having done nothing.
      // The list itself is `JsonObject[]` with no orchestrator counterpart; the
      // count is the part a human needs.
      if (event.permissionDenials?.length) {
        out.push({
          type: 'log',
          level: 'warn',
          message: `The CLI denied ${event.permissionDenials.length} tool call(s) during this step.`,
        });
      }
      return;
    }

    case 'error': {
      out.push({
        type: 'error',
        // `detail` sharpens the classification but stays out of `message`: the
        // message is rendered to a human through `describeFailure()`, and the
        // detail is usually a subtype or a JSON blob. It survives in `raw`.
        kind: mapFailureKind(event.kind, event.message, event.detail),
        message: event.message,
        raw: event,
      });
      return;
    }

    case 'log': {
      out.push({ type: 'log', level: event.level, message: event.message });
      return;
    }

    case 'engine.finished': {
      const cli = state.cliResult;
      const ok = event.status === 'succeeded';
      // Both usages describe the same invocation — `engine.finished` carries a
      // copy of the last result's — but the CLI's own line is the richer of the
      // two, so it wins on any key it has.
      const usage: Usage = { ...event.usage, ...cli?.usage };
      out.push({
        type: 'result',
        ok,
        // Every source of a session id, in order of authority. Losing this is
        // losing the ability to re-run or continue the step.
        sessionId: event.sessionId ?? cli?.sessionId,
        turns: cli?.turns ?? usage.turns,
        // The CLI's own duration when it reported one; the process wall clock
        // otherwise.
        durationMs: cli?.durationMs ?? event.durationMs,
        usage: hasKeys(usage) ? usage : undefined,
        // The CLI repeats its final answer on the result line. It becomes the
        // step summary rather than a second `message`, which would duplicate
        // text already on the timeline.
        summary: cli?.text,
        error: ok ? undefined : event.error,
        failureKind: ok
          ? undefined
          : mapFailureKind(event.errorKind, event.error),
        raw: event,
      });
      break;
    }

    // `thinking` and `raw`: see the doc comment.
    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* Stream adaptation                                                   */
/* ------------------------------------------------------------------ */

/**
 * Wrap an {@link EngineRun} as the orchestrator's event stream.
 *
 * Written as an explicit iterator rather than an `async function*` on purpose.
 * An async generator queues `return()` behind any `next()` already in flight, so
 * a cancel arriving while the CLI is wedged and producing nothing would not run
 * the generator's `finally` until the child spoke again — which is precisely
 * when it never will. This `return()` kills the tree immediately and resolves
 * only once the child is gone, which is the contract the orchestrator's
 * `cancelGraceMs` race is written against.
 *
 * `factory` is called here, not in `run()`, so an iterable that is created and
 * dropped never spawns a process.
 */
function toEventStream(
  factory: () => EngineRun,
): AsyncIterable<OrchestratorEvent> {
  let started = false;

  return {
    [Symbol.asyncIterator](): AsyncIterator<OrchestratorEvent> {
      if (started) {
        // The engine's queue is single-consumer and would throw on the second
        // iteration anyway; failing here says why.
        throw new Error(
          'This engine invocation is already being consumed. Iterate it once.',
        );
      }
      started = true;

      const run = factory();
      // Hazard 1: the run itself, never `run.batches()`. Asking for both throws.
      const inner = run[Symbol.asyncIterator]();
      const pending: OrchestratorEvent[] = [];
      const state: StreamState = {};
      let done = false;

      return {
        async next(): Promise<IteratorResult<OrchestratorEvent>> {
          for (;;) {
            const buffered = pending.shift();
            if (buffered) return { value: buffered, done: false };
            if (done) return { value: undefined, done: true };
            // eslint-disable-next-line no-await-in-loop
            const step = await inner.next();
            if (step.done) {
              done = true;
              return { value: undefined, done: true };
            }
            translate(step.value, pending, state);
          }
        },

        async return(): Promise<IteratorResult<OrchestratorEvent>> {
          done = true;
          pending.length = 0;
          // The whole point of the interface being an iterable: `break` is a
          // cancel. `cancel()` signals the process *group* — an agent CLI spawns
          // its own tools — and resolves once the tree is gone.
          await run.cancel('the orchestrator stopped iterating');
          await inner.return?.(undefined as never);
          return { value: undefined, done: true };
        },
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

/**
 * Fold the auth status into `EngineInfo`.
 *
 * `EngineDetection` splits `info` from `auth`; the orchestrator's seam returns
 * only an `EngineInfo`. `EngineInfoSchema` now carries an optional `auth` — the
 * deferred `shared/` gap that made `detectAll()` return a sidecar map has just
 * been closed — so the whole status travels rather than being flattened into a
 * sentence, and the stray-`ANTHROPIC_API_KEY` case keeps its variable names and
 * its `apiKeyEnvStripped` flag.
 *
 * `severity: 'error'` (signed out, or an API key we are not stripping) also
 * forces `available: false`. An unattended spawn cannot answer a login prompt,
 * and an "available" engine that fails on every invocation is not available.
 * A `warning` (the stray key we do strip) stays available: those runs work.
 */
function withAuth(info: EngineInfo, auth: EngineAuthStatus): EngineInfo {
  const merged: EngineInfo = { ...info, auth };
  if (auth.severity === 'error') {
    return { ...merged, available: false, reason: info.reason ?? auth.message };
  }
  return merged;
}

function wrap(adapter: ServiceAdapter): OrchestratorAdapter {
  return {
    id: adapter.id,
    name: adapter.name,

    async detect(options?: { force?: boolean }): Promise<EngineInfo> {
      try {
        const detection = await adapter.detect({ force: options?.force });
        return withAuth(detection.info, detection.auth);
      } catch (cause) {
        // "Never throws. An absent binary is `available: false` with a reason."
        // The registry's adapters already honour that; this covers a future one
        // that does not.
        const message = cause instanceof Error ? cause.message : String(cause);
        return {
          id: adapter.id,
          name: adapter.name,
          available: false,
          reason: `Detection failed: ${message}`,
          supportsResume: false,
          supportsStreamingJson: false,
          auth: {
            state: 'unknown',
            severity: 'warning',
            message: `Could not check ${adapter.name}: ${message}`,
            apiKeyEnvDetected: false,
            apiKeyEnvVars: [],
            apiKeyEnvStripped: false,
          },
          detectedAt: new Date().toISOString(),
        };
      }
    },

    run(invocation: EngineInvocation): AsyncIterable<OrchestratorEvent> {
      const options = toRunOptions(invocation);
      // The two `sessionId` fields mean opposite things. The orchestrator's is
      // "resume this session"; the engine's is "pin this id on a *new* session"
      // — and pinning an id the CLI has already recorded fails. So a resume
      // invocation goes to `resume()`, which is also what keeps `--resume` and
      // `--session-id` from ever appearing together.
      const { sessionId } = invocation;
      return toEventStream(() =>
        sessionId
          ? adapter.resume(sessionId, invocation.prompt, options)
          : adapter.run(invocation.prompt, options),
      );
    },

    resume(
      sessionId: string,
      invocation: EngineInvocation,
    ): AsyncIterable<OrchestratorEvent> {
      const options = toRunOptions(invocation);
      return toEventStream(() =>
        adapter.resume(sessionId, invocation.prompt, options),
      );
    },
  };
}

/* ------------------------------------------------------------------ */
/* Provider                                                            */
/* ------------------------------------------------------------------ */

/**
 * The orchestrator's view of `services/engines`.
 *
 * Wrappers are memoised per adapter so `get()` is stable: the orchestrator calls
 * it once per step, and an adapter identity that changes under it would be a
 * trap for anything that ever wants to compare or cache one.
 */
export function createEngineProvider(engines: EngineRegistry): EngineProvider {
  const wrapped = new Map<string, OrchestratorAdapter>();

  const defaultEngineId = engines.get(DEFAULT_ENGINE_ID)
    ? DEFAULT_ENGINE_ID
    : (engines.adapters[0]?.id ?? DEFAULT_ENGINE_ID);

  return {
    defaultEngineId,

    get(engineId?: string): OrchestratorAdapter | undefined {
      const id = engineId ?? defaultEngineId;
      const existing = wrapped.get(id);
      if (existing) return existing;
      // `get`, not `require`: the orchestrator's contract is `undefined` for an
      // unknown id, and it raises its own error with the run's context.
      const adapter = engines.get(id);
      if (!adapter) return undefined;
      const bridged = wrap(adapter);
      wrapped.set(id, bridged);
      return bridged;
    },
  };
}
