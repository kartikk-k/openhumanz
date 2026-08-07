/**
 * The normalized engine contract.
 *
 * One interface, several CLIs behind it. Everything in here is engine-agnostic:
 * nothing mentions a Claude Code flag, and a second adapter is a drop-in as long
 * as it can produce these events.
 *
 * Two rules from ARCHITECTURE.md are encoded in the *types* rather than left to
 * discipline:
 *
 *  - **Turn and budget limits are set on every run.** `maxTurns` and
 *    `maxCostUsd` are required fields of {@link EngineRunOptions}. They are the
 *    circuit breakers, and they are cheaper than building loop detection.
 *  - **The working directory is explicit.** `cwd` is required too. Inheriting
 *    `process.cwd()` can land the CLI on top of a prior session and trigger an
 *    interactive resume prompt that hangs an unattended spawn forever.
 *
 * The event stream is normalized from the CLI's stdout. stderr never appears
 * here as control flow — it is archived to a file and, on failure only, quoted
 * into an error message.
 */
import type {
  IsoDateTime,
  JsonObject,
  LogLevel,
  Usage,
} from '../../../shared/common';
import type { EngineInfo } from '../../../shared/engines';
import type { Logger } from '../../infra/logger';

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

/**
 * Why a run failed, in terms an orchestrator can branch on. Deliberately small:
 * anything not on this list is `unknown` plus a human-readable message, because
 * a wrong-but-specific classification is worse than an honest `unknown`.
 */
export type EngineErrorKind =
  | 'not-installed'
  | 'spawn-failed'
  | 'auth'
  | 'max-turns'
  | 'budget'
  | 'timeout'
  | 'cancelled'
  | 'protocol'
  | 'engine'
  | 'unknown';

export type EngineRunStatus = 'succeeded' | 'failed' | 'cancelled';

/** Per-model cost, as the CLI reports it in the final result. */
export interface ModelUsage {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  webSearchRequests?: number;
  costUsd?: number;
  contextWindow?: number;
}

interface EventBase {
  at: IsoDateTime;
}

/**
 * The normalized stream. Every variant carries `at`; ordering is the order the
 * CLI emitted the corresponding line.
 */
export type EngineEvent =
  /** The process started. First event of every run, always. */
  | (EventBase & {
      type: 'engine.started';
      engineId: string;
      command: string;
      /** Prompt text is NOT included; it can be large and is already persisted. */
      args: string[];
      cwd: string;
      pid?: number;
      attempt: number;
    })
  /** The CLI announced its session. Carries the id needed by `resume()`. */
  | (EventBase & {
      type: 'session';
      sessionId: string;
      model?: string;
      cwd?: string;
      tools?: string[];
      mcpServers?: { name: string; status?: string }[];
      permissionMode?: string;
      /**
       * Where the CLI says its credentials came from. Anything other than
       * `none` in a subscription setup means a key is in play.
       */
      apiKeySource?: string;
    })
  | (EventBase & {
      type: 'message';
      role: 'assistant' | 'user' | 'system';
      text: string;
      model?: string;
      sessionId?: string;
      /** Set when the message came from a subagent's inner loop. */
      parentToolUseId?: string;
      /**
       * A streaming delta, not a complete message. Only produced when
       * `includePartialMessages` is on, and the complete message follows, so a
       * consumer must either render deltas or render finals — never both.
       */
      partial?: boolean;
    })
  /** Extended thinking. Separate from `message` so the UI can collapse it. */
  | (EventBase & {
      type: 'thinking';
      text: string;
      sessionId?: string;
      partial?: boolean;
    })
  | (EventBase & {
      type: 'tool.call';
      toolCallId: string;
      name: string;
      arguments: JsonObject;
      sessionId?: string;
      parentToolUseId?: string;
    })
  | (EventBase & {
      type: 'tool.result';
      toolCallId: string;
      /** Resolved from the matching `tool.call` when the CLI omits it. */
      name?: string;
      isError: boolean;
      /** Flattened to text, truncated. Full payload is in the transcript. */
      content: string;
      sessionId?: string;
      parentToolUseId?: string;
    })
  /** Incremental token usage, when the CLI reports it mid-run. */
  | (EventBase & { type: 'usage'; usage: Usage })
  /** The final result line. The cost meter, for free. */
  | (EventBase & {
      type: 'result';
      ok: boolean;
      /** Raw CLI subtype, e.g. `success`, `error_max_turns`. */
      subtype?: string;
      sessionId?: string;
      turns?: number;
      durationMs?: number;
      apiDurationMs?: number;
      usage: Usage;
      byModel: ModelUsage[];
      /** The final assistant text, when the CLI repeats it in the result. */
      text?: string;
      permissionDenials?: JsonObject[];
    })
  | (EventBase & {
      type: 'error';
      kind: EngineErrorKind;
      message: string;
      detail?: string;
    })
  /** Diagnostics. Never control flow; safe to drop. */
  | (EventBase & { type: 'log'; level: LogLevel; message: string })
  /**
   * A stdout line we recognized as JSON but not as anything we model. Kept so
   * the transcript stays lossless and a CLI upgrade degrades instead of
   * breaking.
   */
  | (EventBase & { type: 'raw'; payload: unknown })
  /** The process exited. Last event of every run, always. */
  | (EventBase & {
      type: 'engine.finished';
      status: EngineRunStatus;
      exitCode: number | null;
      signal: string | null;
      durationMs: number;
      usage?: Usage;
      sessionId?: string;
      error?: string;
      errorKind?: EngineErrorKind;
    });

export type EngineEventType = EngineEvent['type'];
export type EngineEventOf<T extends EngineEventType> = Extract<
  EngineEvent,
  { type: T }
>;

/* ------------------------------------------------------------------ */
/* Batching                                                            */
/* ------------------------------------------------------------------ */

/**
 * How events are grouped before they cross IPC. Per-event IPC traffic pins a
 * core on a chatty run, so the orchestrator picks a flush interval rather than
 * the adapter deciding for it.
 */
export interface BatchOptions {
  /** Emit a batch once this many events are pending. Default 64. */
  maxEvents?: number;
  /** Emit a partial batch after this long. `0` disables batching. Default 50. */
  flushIntervalMs?: number;
  /**
   * Event types that flush immediately regardless of the interval — the ones a
   * user is watching for. Default: `result`, `error`, `engine.finished`.
   */
  flushOn?: EngineEventType[];
}

export const DEFAULT_BATCH: Required<BatchOptions> = {
  maxEvents: 64,
  flushIntervalMs: 50,
  flushOn: ['result', 'error', 'engine.finished'],
};

/* ------------------------------------------------------------------ */
/* Run options                                                         */
/* ------------------------------------------------------------------ */

export type EnginePermissionMode =
  'acceptEdits' | 'auto' | 'bypassPermissions' | 'manual' | 'dontAsk' | 'plan';

export interface EngineRunOptions {
  /* -- required circuit breakers -------------------------------------- */

  /**
   * Hard cap on agent turns. Required, not optional: an unbounded run is the
   * failure mode that empties a weekly quota.
   */
  maxTurns: number;
  /** Hard cap on spend for this single invocation, in USD. Required. */
  maxCostUsd: number;
  /**
   * Working directory. Required. Never defaulted to `process.cwd()` — see the
   * file header.
   */
  cwd: string;

  /* -- injection ------------------------------------------------------- */

  /**
   * Absolute path to the CLI. Injectable so tests can point the adapter at a
   * fake CLI and prove the parser without spending money. Defaults to the
   * detected binary.
   */
  binaryPath?: string;

  /* -- model ----------------------------------------------------------- */

  model?: string;
  fallbackModel?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';

  /* -- session --------------------------------------------------------- */

  /**
   * Pin the session id instead of letting the CLI mint one. Must be a UUID.
   * Left unset, the adapter generates a fresh one, which is what keeps an
   * unattended spawn from being offered a prior session in `cwd`.
   */
  sessionId?: string;
  /** Resume mode only: start a new session id from the resumed history. */
  forkSession?: boolean;

  /* -- tools and MCP --------------------------------------------------- */

  /**
   * Allowlist handed to the CLI, e.g. `['Read', 'Bash(git *)']`. This is the
   * outer of two independent gates; the MCP server scopes the connection too.
   */
  allowedTools?: string[];
  disallowedTools?: string[];
  /**
   * Restrict the CLI's built-in tool set. `'none'` disables them entirely,
   * `'default'` keeps all, an array names them.
   */
  builtinTools?: string[] | 'none' | 'default';
  /** Path to a generated MCP config file. Written and owned by the caller. */
  mcpConfigPath?: string;
  /** Ignore the user's global/project MCP config. Default true when a path is given. */
  strictMcpConfig?: boolean;
  /** Default `acceptEdits`. Never defaulted to a bypass mode. */
  permissionMode?: EnginePermissionMode;
  /** Extra directories the CLI may read outside `cwd`. */
  addDirs?: string[];

  /* -- prompt shaping -------------------------------------------------- */

  systemPrompt?: string;
  appendSystemPrompt?: string;
  /**
   * `argv` puts the prompt in the command line (verified shape). `stdin` pipes
   * it, for prompts large enough to risk E2BIG.
   */
  promptVia?: 'argv' | 'stdin';

  /* -- process --------------------------------------------------------- */

  /** Extra env. A key set to `undefined` is removed from the child's env. */
  env?: Record<string, string | undefined>;
  /**
   * Keep `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` in the child's
   * environment. Default false: a key takes precedence over subscription login,
   * so leaving one in place silently bills the user for a plan they already pay
   * for. Opt in explicitly or not at all.
   */
  allowApiKeyEnv?: boolean;
  /** Wall-clock ceiling. The tree is killed and the run reported `timeout`. */
  timeoutMs?: number;
  /** stderr is appended here. Normally `runs/<runId>/stderr.log`. */
  stderrLogPath?: string;
  /** Every raw stdout line is appended here verbatim. Normally `transcript.jsonl`. */
  transcriptPath?: string;
  /** Cancels the run. Equivalent to calling `cancel()`. */
  signal?: AbortSignal;
  logger?: Logger;

  /* -- stream shaping -------------------------------------------------- */

  /** Ask for partial message deltas. Much chattier; batching matters more. */
  includePartialMessages?: boolean;
  batch?: BatchOptions;
  /**
   * Cap on events buffered while a slow consumer catches up. Beyond it, `raw`
   * and `thinking` events are dropped and the drop is reported once.
   * Default 50000.
   */
  maxQueuedEvents?: number;
}

/* ------------------------------------------------------------------ */
/* Run handle                                                          */
/* ------------------------------------------------------------------ */

/**
 * A live run.
 *
 * Iterating it directly yields single events — the contract ARCHITECTURE.md
 * states. {@link EngineRun.batches} yields the same events grouped for IPC and
 * is what the orchestrator should consume. Pick one: they drain the same queue,
 * and asking for the second throws.
 *
 * Breaking out of either loop cancels the run and kills the process tree, so a
 * `return` inside `for await` cannot leak a CLI process.
 */
export interface EngineRun extends AsyncIterable<EngineEvent> {
  readonly engineId: string;
  /** Resolved once the CLI announces it, or once it is pinned up front. */
  readonly sessionId: string | undefined;
  readonly pid: number | undefined;
  /** Events grouped per {@link BatchOptions}. Overrides merge over the run's. */
  batches(overrides?: BatchOptions): AsyncIterable<EngineEvent[]>;
  /**
   * Kill the process tree and end the stream cleanly. Idempotent, and safe to
   * call after the run already finished.
   */
  cancel(reason?: string): Promise<void>;
  /** Resolves after the stream ends. Never rejects; failure is a value. */
  readonly done: Promise<EngineRunSummary>;
}

/** What the orchestrator persists once a run ends. */
export interface EngineRunSummary {
  engineId: string;
  status: EngineRunStatus;
  sessionId?: string;
  usage: Usage;
  byModel: ModelUsage[];
  turns: number;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  error?: string;
  errorKind?: EngineErrorKind;
  /** Last few KiB of stderr. Diagnostics only, and only worth showing on failure. */
  stderrTail?: string;
  stderrLogPath?: string;
  transcriptPath?: string;
  /** How many spawns it took, counting a fail-soft retry. */
  attempts: number;
}

/* ------------------------------------------------------------------ */
/* Detection                                                           */
/* ------------------------------------------------------------------ */

/**
 * Auth as a first-class, renderable status rather than a line in a log.
 *
 * `apiKeyEnv` is the one that matters: `ANTHROPIC_API_KEY` takes precedence
 * over a subscription login, so a user with a stray key in their shell profile
 * burns pay-as-you-go credit while believing they are on their plan. It is
 * surfaced as its own severity, not folded into a warning list.
 */
export type EngineAuthState =
  'subscription' | 'api-key' | 'logged-out' | 'unknown';

export interface EngineAuthStatus {
  state: EngineAuthState;
  /** `ok` renders green, `warning` amber, `error` red and blocking. */
  severity: 'ok' | 'warning' | 'error';
  /** One sentence, addressed to a human, saying what to do about it. */
  message: string;
  /** True when a key is present in the environment we would spawn with. */
  apiKeyEnvDetected: boolean;
  /** Which variables, by name. Values are never read, stored, or logged. */
  apiKeyEnvVars: string[];
  /** True when the adapter will strip those variables before spawning. */
  apiKeyEnvStripped: boolean;
  /** As reported by the CLI, when it can say. */
  method?: string;
  email?: string;
  organization?: string;
  subscription?: string;
  /** Set when the auth probe itself failed. */
  probeError?: string;
}

/** Optional flags a build may or may not accept. Probed, never assumed. */
export interface EngineCapabilities {
  streamingJson: boolean;
  resume: boolean;
  /** `--max-turns` is real but hidden from `--help`; this is probed by arity. */
  maxTurns: boolean;
  maxBudgetUsd: boolean;
  mcpConfig: boolean;
  strictMcpConfig: boolean;
  partialMessages: boolean;
}

export interface EngineDetection {
  /** The shared-contract shape, ready to hand to the UI. */
  info: EngineInfo;
  auth: EngineAuthStatus;
  capabilities: EngineCapabilities;
  /** Raw `--version` stdout, for the about screen and for bug reports. */
  rawVersion?: string;
}

export interface DetectOptions {
  /** Skip the PATH lookup and probe this binary. Injectable for tests. */
  binaryPath?: string;
  /** Ignore the cached result. */
  force?: boolean;
  /** Per-probe timeout. Default 10000 ms. */
  timeoutMs?: number;
  logger?: Logger;
}

/* ------------------------------------------------------------------ */
/* The adapter                                                         */
/* ------------------------------------------------------------------ */

/**
 * What every engine implements. Keep it this small — anything CLI-specific
 * belongs behind {@link EngineRunOptions}, not in a new method, or the second
 * adapter stops being a drop-in.
 */
export interface EngineAdapter {
  readonly id: string;
  readonly name: string;
  detect(options?: DetectOptions): Promise<EngineDetection>;
  run(prompt: string, options: EngineRunOptions): EngineRun;
  /** Continue an existing session. Same options surface as {@link run}. */
  resume(
    sessionId: string,
    prompt: string,
    options: EngineRunOptions,
  ): EngineRun;
}
