/**
 * The two seams the orchestrator is built against.
 *
 * The engine adapter and the MCP server are separate concerns owned by separate
 * code, so neither is imported here — both arrive as constructor arguments
 * satisfying the interfaces in this file. That is not ceremony: it is what lets
 * the whole orchestrator be tested under plain `bun` with a stub engine that
 * emits synthetic events and never spawns anything.
 *
 * Read this file first if you are writing either adapter. It is the contract.
 */
import type { JsonObject, LogLevel, Usage } from '../../../shared/common';
import type { EngineInfo } from '../../../shared/engines';

/* ------------------------------------------------------------------ */
/* Failure classification                                              */
/* ------------------------------------------------------------------ */

/**
 * Why an invocation ended badly.
 *
 * `quota` and `rate_limit` are first-class rather than lumped into
 * `engine_error` because they are the failure a real user hits first, and the
 * only ones where the honest UI copy is "your plan is out of capacity" instead
 * of "something went wrong". Adapters should set them when they can; the
 * orchestrator also sniffs error text as a backstop.
 */
export type EngineFailureKind =
  | 'quota'
  | 'rate_limit'
  | 'auth'
  | 'timeout'
  | 'budget_exceeded'
  | 'max_turns'
  | 'engine_error'
  | 'spawn_failed'
  | 'cancelled';

/* ------------------------------------------------------------------ */
/* Engine adapter                                                      */
/* ------------------------------------------------------------------ */

/**
 * One engine invocation == one step. Everything the CLI needs is here; the
 * orchestrator never lets an adapter reach for global state.
 */
export interface EngineInvocation {
  runId: string;
  stepId: string;
  prompt: string;
  /**
   * Always set by the orchestrator. Control the working directory or a prior
   * session in the cwd can trigger an interactive resume prompt that hangs an
   * unattended spawn forever.
   */
  cwd: string;
  /** Resume this session instead of starting a new one. */
  sessionId?: string;
  /**
   * Hard turn ceiling for this step. Always set. Cheaper than loop detection.
   * `--max-turns` is undocumented in some CLI builds: fail soft on it, do not
   * let a rejected flag kill the run.
   */
  maxTurns: number;
  /** Hard cost ceiling in USD for this step. Always set. */
  maxCostUsd: number;
  /**
   * The complete tool allowlist for this invocation — native CLI tools plus the
   * namespaced names of our own MCP tools. The MCP server enforces its half
   * independently; this is the second of two gates that fail separately.
   */
  allowedTools: string[];
  /** Absolute path to the per-invocation MCP config. Deleted after the step. */
  mcpConfigPath?: string;
  model?: string;
  /** `runs/<runId>/stderr.log`. stderr is a log, never control flow. */
  stderrLogPath?: string;
  /**
   * Aborted on cancel and on budget exhaustion. The adapter must kill the
   * process **tree** — an agent CLI spawns its own tools.
   */
  signal?: AbortSignal;
  /** Extra environment. A key set to `undefined` is removed from the child. */
  env?: Record<string, string | undefined>;
}

/** What the adapter yields. One normalised shape, whatever the CLI emits. */
export type EngineEvent =
  /** Session established or resumed. Persisted so a step can be re-run. */
  | { type: 'session'; sessionId: string; model?: string; raw?: unknown }
  | {
      type: 'message';
      role: 'assistant' | 'user' | 'system';
      text: string;
      raw?: unknown;
    }
  /** The agent called a tool. `id` is the CLI's own id, used to match results. */
  | {
      type: 'tool_use';
      id?: string;
      name: string;
      input?: JsonObject;
      raw?: unknown;
    }
  | {
      type: 'tool_result';
      id?: string;
      name?: string;
      ok: boolean;
      summary?: string;
      error?: string;
      raw?: unknown;
    }
  /** Incremental cost/token accounting. Emit as often as the CLI reports it. */
  | { type: 'usage'; usage: Usage; raw?: unknown }
  | { type: 'log'; level: LogLevel; message: string }
  /** A non-final error. Set `kind` when the CLI is explicit about the cause. */
  | {
      type: 'error';
      kind?: EngineFailureKind;
      message: string;
      retryAfterMs?: number;
      raw?: unknown;
    }
  /**
   * The final result. The CLI's result line carries session id, turns, duration
   * and per-model cost — pass all of it through, it is the cost meter for free.
   * Exactly one of these should be emitted per invocation.
   */
  | {
      type: 'result';
      ok: boolean;
      sessionId?: string;
      turns?: number;
      durationMs?: number;
      usage?: Usage;
      summary?: string;
      error?: string;
      failureKind?: EngineFailureKind;
      raw?: unknown;
    };

/**
 * An agent CLI, normalised.
 *
 * `run` returns an async iterable rather than taking a callback so the
 * orchestrator controls backpressure and so `break` is a cancel: **breaking the
 * loop calls `return()` on the iterator, and `return()` must kill the process
 * tree and only resolve once the child is gone.**
 */
export interface EngineAdapter {
  /** Stable id, e.g. `claude-code`. Matches `Run.engine`. */
  readonly id: string;
  readonly name?: string;
  /** Never throws. An absent binary is `available: false` with a reason. */
  detect(options?: { force?: boolean }): Promise<EngineInfo>;
  run(invocation: EngineInvocation): AsyncIterable<EngineEvent>;
  /** Optional: `run` with a `sessionId` is the required path. */
  resume?(
    sessionId: string,
    invocation: EngineInvocation,
  ): AsyncIterable<EngineEvent>;
}

/** How the orchestrator finds an adapter. Implemented by `services/engines`. */
export interface EngineProvider {
  /** The adapter for `engineId`, or the default when omitted. */
  get(engineId?: string): EngineAdapter | undefined;
  readonly defaultEngineId: string;
}

/* ------------------------------------------------------------------ */
/* MCP scope registration                                              */
/* ------------------------------------------------------------------ */

/**
 * What the orchestrator tells the MCP server before a step runs.
 *
 * The point of this call is the second gate: the shim handshakes with `stepId`
 * and the server scopes that connection's tool list to exactly these tools,
 * independently of whatever allowlist the CLI was handed.
 */
export interface McpStepScopeRequest {
  runId: string;
  stepId: string;
  /**
   * Everything the step may use. The server registers the names it owns and
   * ignores the rest (native CLI tools like `Read` are not its business).
   */
  allowedTools: string[];
  cwd: string;
  /** Aborted on cancel; long-running tools should honour it. */
  signal?: AbortSignal;
  /**
   * Called when a tool call terminates inside our process. This is how the
   * timeline learns about MCP tool calls — there is no bus event for them, and
   * inventing one would put tool traffic through a cross-module channel.
   */
  onToolCall?(call: McpToolCallStart): void;
  onToolResult?(result: McpToolCallEnd): void;
}

export interface McpToolCallStart {
  /** The server's id for the call. Stable across start and end. */
  callId: string;
  name: string;
  arguments?: JsonObject;
  sideEffecting: boolean;
  /** Set when the call is parked at the approval gate. */
  approvalId?: string;
}

export interface McpToolCallEnd {
  callId: string;
  name?: string;
  ok: boolean;
  /** Compact rendering. The full payload belongs in the transcript. */
  summary?: string;
  error?: string;
  /** True when the gate returned a pending handle rather than a result. */
  awaitingApproval?: boolean;
  approvalId?: string;
}

/**
 * A live registration. The orchestrator revokes it in a `finally`, so a step
 * that throws still narrows the blast radius back down.
 */
export interface McpStepScope {
  /** Key under `mcpServers` in the generated config, e.g. `assistant`. */
  serverName: string;
  /**
   * The stdio server entry: the shim, plus whatever it needs to reach the
   * socket. The token belongs in `env` and is never logged.
   */
  server: {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
  /**
   * The tool names as the CLI will see them, e.g.
   * `mcp__assistant__memory_search`. Merged into the engine allowlist.
   */
  exposedToolNames: string[];
  /** Idempotent. Called even when the step failed. */
  revoke(): Promise<void>;
}

export interface McpScopeRegistrar {
  register(request: McpStepScopeRequest): Promise<McpStepScope>;
}

/* ------------------------------------------------------------------ */
/* Planning                                                            */
/* ------------------------------------------------------------------ */

/**
 * One unit of work == one CLI invocation.
 *
 * Every step carries its own tool scope and its own budget. Keep them small
 * enough that the blast radius is comprehensible at a glance — that is the
 * whole reason the app owns the step boundary.
 */
export interface PlannedStep {
  name: string;
  prompt: string;
  /** Tools this step, and only this step, may use. */
  allowedTools: string[];
  maxTurns?: number;
  maxCostUsd?: number;
  cwd?: string;
  /** Continue the previous step's session instead of starting fresh. */
  continueSession?: boolean;
  model?: string;
}

export interface RunPlan {
  title?: string;
  steps: PlannedStep[];
}

export interface PlanContext {
  runId: string;
  engineId: string;
  cwd: string;
  defaults: { maxTurns: number; maxCostUsd: number; allowedTools: string[] };
}

/** Swappable so an LLM planner can replace the default without a rewrite. */
export interface Planner {
  plan(
    request: {
      prompt: string;
      title?: string;
      allowedTools?: string[];
      maxTurns?: number;
      maxCostUsd?: number;
      metadata?: JsonObject;
    },
    ctx: PlanContext,
  ): Promise<RunPlan> | RunPlan;
}
