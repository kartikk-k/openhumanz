/**
 * The Claude Code adapter.
 *
 * Flag surface is the one verified against **2.1.224** on this machine and
 * written down in `docs/API-NOTES.md` §8. Two things from that note are load
 * bearing here:
 *
 *  - `--max-turns` is real but **absent from `--help`**, so it is probed by
 *    argument arity at detection time and, if a build ever rejects it, the run
 *    retries once without it rather than dying. Fail soft, never fail silent.
 *  - `--verbose` alongside `--output-format stream-json` is the historically
 *    required pairing. 2.1.224's help does not state the requirement; it is
 *    passed anyway because it is harmless and the alternative is a stream that
 *    silently emits nothing.
 *
 * Invariants this file keeps:
 *
 *  - **stdout is the event stream, stderr is a log.** Nothing branches on
 *    stderr except the one fail-soft retry, which reads it only to recognise
 *    the CLI's own `unknown option` message.
 *  - **cwd is always explicit**, and a fresh `--session-id` is minted for every
 *    non-resume run, so the CLI is never in a position to offer an interactive
 *    "resume the session in this directory?" prompt to a spawn with no terminal.
 *  - **Turn and budget ceilings go on every invocation.**
 *  - **No `--bare`, no `--dangerously-skip-permissions`**, and API-key
 *    environment variables are stripped unless the caller opts in.
 */
/* Two classes on purpose: the adapter is a factory for the run, and splitting
   a live process's state away from the code that spawns it buys nothing. */
/* eslint-disable max-classes-per-file */
import fs from 'node:fs';
import path from 'node:path';
import { uuid } from '../../infra/crypto';
import { getLogger } from '../../infra/logger';
import type { Logger } from '../../infra/logger';
import { runProcess, spawnProcess, whichSync } from '../../infra/spawn';
import type { SpawnHandle, SpawnResult } from '../../infra/spawn';
import { nowIso } from '../../../shared/common';
import type { Usage } from '../../../shared/common';
import {
  buildAuthStatus,
  engineEnvOverrides,
  findApiKeyEnv,
} from './environment';
import type { RawAuthStatus } from './environment';
import {
  classifyErrorText,
  createParserState,
  parseStreamJsonLine,
} from './stream-json';
import type { StreamParserState } from './stream-json';
import {
  AsyncEventQueue,
  batchEvents,
  isDroppableEvent,
  resolveBatchOptions,
} from './stream';
import type {
  BatchOptions,
  DetectOptions,
  EngineAdapter,
  EngineCapabilities,
  EngineDetection,
  EngineErrorKind,
  EngineEvent,
  EngineRun,
  EngineRunOptions,
  EngineRunStatus,
  EngineRunSummary,
  ModelUsage,
} from './types';

export const CLAUDE_CODE_ENGINE_ID = 'claude-code';
export const CLAUDE_CODE_BINARY = 'claude';

/** How long a detection probe may take before it is treated as a failure. */
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/** Grace given to a killed tree before the stream is closed regardless. */
const CANCEL_CLOSE_TIMEOUT_MS = 8_000;

/* ------------------------------------------------------------------ */
/* Argument construction                                               */
/* ------------------------------------------------------------------ */

export interface ArgBuildContext {
  mode: 'run' | 'resume';
  /** Pinned session id (run) or the session to continue (resume). */
  sessionId?: string;
  /** Flags a previous attempt proved this build rejects. */
  unsupported?: ReadonlySet<string>;
  /** Prompt goes on argv unless this says otherwise. */
  promptVia: 'argv' | 'stdin';
}

/**
 * Build the argv for one invocation.
 *
 * Exported because it is the part most worth testing without a process: the
 * flags are a contract with a CLI that drifts, and a unit assertion on the
 * array is cheaper than noticing a bad run in production.
 */
export function buildClaudeArgs(
  prompt: string,
  options: EngineRunOptions,
  context: ArgBuildContext,
): string[] {
  const unsupported = context.unsupported ?? new Set<string>();
  const args: string[] = ['--print'];

  if (context.promptVia === 'argv') args.push(prompt);

  args.push('--output-format', 'stream-json');
  // Required by the historical stream-json contract; harmless where it is not.
  args.push('--verbose');
  args.push('--input-format', 'text');

  if (options.includePartialMessages) args.push('--include-partial-messages');

  if (options.model) args.push('--model', options.model);
  if (options.fallbackModel)
    args.push('--fallback-model', options.fallbackModel);
  if (options.effort) args.push('--effort', options.effort);

  if (context.mode === 'resume') {
    if (!context.sessionId) {
      throw new Error('resume() requires a session id');
    }
    args.push('--resume', context.sessionId);
    if (options.forkSession) args.push('--fork-session');
  } else if (context.sessionId) {
    // Pinning a fresh id keeps the CLI from proposing a prior session in cwd.
    args.push('--session-id', context.sessionId);
  }

  // The circuit breakers. Both are required options, so both are always here.
  if (!unsupported.has('--max-turns')) {
    args.push('--max-turns', String(Math.max(1, Math.trunc(options.maxTurns))));
  }
  if (!unsupported.has('--max-budget-usd')) {
    args.push('--max-budget-usd', String(options.maxCostUsd));
  }

  args.push('--permission-mode', options.permissionMode ?? 'acceptEdits');

  if (options.systemPrompt) args.push('--system-prompt', options.systemPrompt);
  if (options.appendSystemPrompt) {
    args.push('--append-system-prompt', options.appendSystemPrompt);
  }

  if (options.mcpConfigPath) {
    args.push('--mcp-config', options.mcpConfigPath);
    // Default on: the app must never inherit, or mutate, the user's own MCP
    // registry. Explicit false is the only way to turn it off.
    if (options.strictMcpConfig !== false) args.push('--strict-mcp-config');
  }

  if (options.builtinTools === 'none') {
    args.push('--tools', '');
  } else if (options.builtinTools === 'default') {
    args.push('--tools', 'default');
  } else if (
    Array.isArray(options.builtinTools) &&
    options.builtinTools.length
  ) {
    args.push('--tools', options.builtinTools.join(','));
  }

  if (options.allowedTools?.length) {
    args.push('--allowed-tools', ...options.allowedTools);
  }
  if (options.disallowedTools?.length) {
    args.push('--disallowed-tools', ...options.disallowedTools);
  }
  if (options.addDirs?.length) {
    args.push('--add-dir', ...options.addDirs);
  }

  return args;
}

/** Which flag, if any, this build just told us it does not know. */
export function unsupportedFlagFromOutput(text: string): string | null {
  const match = /unknown option ['`"]?(--[a-z0-9-]+)/i.exec(text);
  return match ? match[1] : null;
}

/* ------------------------------------------------------------------ */
/* Detection                                                           */
/* ------------------------------------------------------------------ */

/** `2.1.224 (Claude Code)` → `2.1.224`. Anything unparseable is kept verbatim. */
export function parseVersion(stdout: string): string | undefined {
  const line = stdout.split('\n').find((entry) => entry.trim() !== '');
  if (!line) return undefined;
  const match = /(\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?)/.exec(line);
  return match ? match[1] : line.trim();
}

/**
 * Does this build accept `flag`?
 *
 * Probed by arity: invoking a flag with no value makes commander print
 * `argument missing` when it knows the flag and `unknown option` when it does
 * not. This is the only way to see `--max-turns`, which is real but hidden
 * from `--help`.
 */
async function probeFlagArity(
  binaryPath: string,
  flag: string,
  timeoutMs: number,
  cwd: string,
): Promise<boolean> {
  const result = await runProcess(binaryPath, [flag], {
    timeoutMs,
    cwd,
    collectStdout: true,
    label: `claude ${flag} (probe)`,
    env: engineEnvOverrides({ allowApiKeyEnv: false }),
  });
  const text = `${result.stdout}\n${result.stderrTail}`;
  if (/argument missing/i.test(text)) return true;
  if (/unknown option/i.test(text)) return false;
  // Ambiguous — assume supported and let the run's fail-soft retry decide.
  return true;
}

function parseAuthJson(stdout: string): RawAuthStatus | undefined {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(stdout.slice(start, end + 1)) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    return parsed as RawAuthStatus;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

interface RunConfig {
  prompt: string;
  options: EngineRunOptions;
  mode: 'run' | 'resume';
  sessionId?: string;
  binaryPath: string | null;
  binaryError?: string;
  capabilities?: EngineCapabilities;
  logger: Logger;
}

class ClaudeCodeRun implements EngineRun {
  readonly engineId = CLAUDE_CODE_ENGINE_ID;

  private readonly queue: AsyncEventQueue<EngineEvent>;

  private readonly batchDefaults: Required<BatchOptions>;

  private parser: StreamParserState;

  private spawnHandle: SpawnHandle | null = null;

  private cancelled = false;

  private cancelReason: string | undefined;

  /** The id handed to `--session-id` / `--resume` for the current attempt. */
  private pinnedSessionId: string | undefined;

  private startedAt = Date.now();

  private attempts = 0;

  private lastUsage: Usage = {};

  private byModel: ModelUsage[] = [];

  private turns = 0;

  private sawResult = false;

  private resultOk = false;

  private firstError: { kind: EngineErrorKind; message: string } | undefined;

  private transcript: fs.WriteStream | null = null;

  private resolveDone!: (summary: EngineRunSummary) => void;

  readonly done: Promise<EngineRunSummary>;

  constructor(private readonly config: RunConfig) {
    const { options } = config;
    this.batchDefaults = resolveBatchOptions(options.batch);
    this.queue = new AsyncEventQueue<EngineEvent>({
      capacity: options.maxQueuedEvents ?? 50_000,
      droppable: isDroppableEvent,
      onOverflow: ({ dropped }) => {
        config.logger.warn('engine event queue overflowed', { dropped });
      },
    });
    this.parser = createParserState(
      config.mode === 'resume' ? config.sessionId : undefined,
    );
    this.done = new Promise<EngineRunSummary>((resolve) => {
      this.resolveDone = resolve;
    });

    if (options.signal) {
      if (options.signal.aborted) this.cancelled = true;
      else {
        options.signal.addEventListener(
          'abort',
          () => {
            void this.cancel('aborted by signal');
          },
          { once: true },
        );
      }
    }

    void this.execute();
  }

  get sessionId(): string | undefined {
    return (
      this.parser.sessionId ?? this.pinnedSessionId ?? this.config.sessionId
    );
  }

  get pid(): number | undefined {
    return this.spawnHandle?.pid;
  }

  [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
    const inner = this.queue[Symbol.asyncIterator]();
    return {
      next: () => inner.next(),
      // A `break` out of the caller's loop must not leak a CLI process.
      return: async () => {
        await this.cancel('consumer stopped iterating');
        await inner.return?.(undefined as never);
        return { value: undefined as unknown as EngineEvent, done: true };
      },
    };
  }

  batches(overrides?: BatchOptions): AsyncIterable<EngineEvent[]> {
    const resolved = resolveBatchOptions(this.batchDefaults, overrides);
    return batchEvents(this, resolved);
  }

  async cancel(reason = 'cancelled'): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true;
    this.cancelReason = reason;
    const handle = this.spawnHandle;
    if (!handle) return;
    // killTree signals the whole process group: the CLI spawns its own tools,
    // and killing only the parent leaves them running.
    await Promise.race([
      handle.kill(),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CANCEL_CLOSE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  }

  /* ---------------------------------------------------------------- */

  private emit(event: EngineEvent): void {
    this.queue.push(event);
  }

  private emitError(
    kind: EngineErrorKind,
    message: string,
    detail?: string,
  ): void {
    if (!this.firstError) this.firstError = { kind, message };
    this.emit({ at: nowIso(), type: 'error', kind, message, detail });
  }

  private openTranscript(): void {
    const { transcriptPath } = this.config.options;
    if (!transcriptPath || this.transcript) return;
    try {
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      this.transcript = fs.createWriteStream(transcriptPath, { flags: 'a' });
      this.transcript.on('error', (error) => {
        this.config.logger.warn('transcript write failed', {
          error: error.message,
        });
        this.transcript = null;
      });
    } catch (error) {
      this.config.logger.warn('could not open transcript', {
        error: (error as Error).message,
      });
    }
  }

  private handleStdoutLine(line: string): void {
    this.transcript?.write(`${line}\n`);
    let events: EngineEvent[];
    try {
      events = parseStreamJsonLine(line, this.parser);
    } catch (error) {
      // A parser bug must not take the run down with it.
      events = [
        {
          at: nowIso(),
          type: 'log',
          level: 'warn',
          message: `failed to normalize a stream line: ${(error as Error).message}`,
        },
      ];
    }
    for (const event of events) {
      if (event.type === 'result') {
        this.sawResult = true;
        this.resultOk = event.ok;
        this.lastUsage = event.usage;
        this.byModel = event.byModel;
        this.turns = event.turns ?? event.usage.turns ?? this.turns;
      } else if (event.type === 'error' && !this.firstError) {
        this.firstError = { kind: event.kind, message: event.message };
      }
      this.emit(event);
    }
  }

  private preflight(): string | null {
    const { options } = this.config;
    if (!this.config.binaryPath) {
      return (
        this.config.binaryError ?? 'Claude Code CLI was not found on PATH.'
      );
    }
    if (!Number.isFinite(options.maxTurns) || options.maxTurns <= 0) {
      return `maxTurns must be a positive number, got ${options.maxTurns}.`;
    }
    if (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0) {
      return `maxCostUsd must be a positive number, got ${options.maxCostUsd}.`;
    }
    if (!options.cwd) return 'cwd is required; it is never inherited.';
    try {
      if (!fs.statSync(options.cwd).isDirectory()) {
        return `cwd is not a directory: ${options.cwd}`;
      }
    } catch {
      return `cwd does not exist: ${options.cwd}`;
    }
    return null;
  }

  private async execute(): Promise<void> {
    const { options, logger } = this.config;

    const failure = this.preflight();
    if (failure) {
      this.emitError(
        this.config.binaryPath ? 'spawn-failed' : 'not-installed',
        failure,
      );
      this.finish('failed', null, null);
      return;
    }
    if (this.cancelled) {
      this.emitError(
        'cancelled',
        this.cancelReason ?? 'cancelled before start',
      );
      this.finish('cancelled', null, null);
      return;
    }

    this.openTranscript();

    const binaryPath = this.config.binaryPath as string;
    const unsupported = new Set<string>();
    if (this.config.capabilities) {
      if (!this.config.capabilities.maxTurns) unsupported.add('--max-turns');
      if (!this.config.capabilities.maxBudgetUsd) {
        unsupported.add('--max-budget-usd');
      }
    }

    // A prompt that starts with `-` would be read as an option, so it goes down
    // stdin instead. Callers can force stdin for large prompts too.
    const promptVia: 'argv' | 'stdin' =
      options.promptVia ??
      (this.config.prompt.startsWith('-') ? 'stdin' : 'argv');

    let result: SpawnResult | null = null;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      this.attempts = attempt;
      // A retry is a fresh CLI process: the pinned id from the rejected attempt
      // was never used, but minting a new one keeps the two attempts from ever
      // colliding on an id the CLI has already recorded.
      const pinned =
        this.config.mode === 'resume'
          ? this.config.sessionId
          : (this.config.sessionId ?? uuid());
      this.pinnedSessionId = pinned;
      this.parser = createParserState(pinned);

      let args: string[];
      try {
        args = buildClaudeArgs(this.config.prompt, options, {
          mode: this.config.mode,
          sessionId: pinned,
          unsupported,
          promptVia,
        });
      } catch (error) {
        this.emitError('spawn-failed', (error as Error).message);
        this.finish('failed', null, null);
        return;
      }

      this.emit({
        at: nowIso(),
        type: 'engine.started',
        engineId: CLAUDE_CODE_ENGINE_ID,
        command: binaryPath,
        args:
          promptVia === 'argv' ? redactPrompt(args, this.config.prompt) : args,
        cwd: options.cwd,
        attempt,
      });

      this.startedAt = Date.now();
      this.spawnHandle = spawnProcess(binaryPath, args, {
        cwd: options.cwd,
        env: engineEnvOverrides({
          allowApiKeyEnv: options.allowApiKeyEnv,
          extra: options.env,
        }),
        timeoutMs: options.timeoutMs,
        stderrLogPath: options.stderrLogPath,
        label: `${CLAUDE_CODE_ENGINE_ID} run`,
        collectStdout: false,
        onStdoutLine: (line) => this.handleStdoutLine(line),
        // stderr is a log. It is written to the file by spawnProcess and only
        // ever quoted back on failure; nothing here branches on it.
        stdin: promptVia === 'stdin' ? this.config.prompt : '',
      });

      if (this.cancelled) {
        // cancel() arrived between the check above and the spawn returning.
        // eslint-disable-next-line no-await-in-loop
        await this.spawnHandle.kill();
      }

      // eslint-disable-next-line no-await-in-loop
      result = await this.spawnHandle.result;

      const combined = result.stderrTail ?? '';
      const rejected = unsupportedFlagFromOutput(combined);
      const canRetry =
        attempt === 1 &&
        !this.cancelled &&
        !this.sawResult &&
        rejected !== null &&
        (rejected === '--max-turns' || rejected === '--max-budget-usd');

      if (!canRetry) break;

      unsupported.add(rejected as string);
      logger.warn('claude rejected a flag; retrying without it', {
        flag: rejected,
      });
      this.emit({
        at: nowIso(),
        type: 'log',
        level: 'warn',
        message: `This Claude Code build rejected ${rejected}; retrying once without it. The ceiling is no longer enforced by the CLI for this run.`,
      });
    }

    this.finishFromResult(result as SpawnResult);
  }

  private finishFromResult(result: SpawnResult): void {
    if (this.cancelled) {
      this.emitError('cancelled', this.cancelReason ?? 'cancelled');
      this.finish('cancelled', result.code, result.signal, result);
      return;
    }
    if (result.timedOut) {
      this.emitError(
        'timeout',
        `The engine exceeded its ${this.config.options.timeoutMs} ms time limit and was stopped.`,
      );
      this.finish('failed', result.code, result.signal, result);
      return;
    }
    if (this.sawResult && this.resultOk) {
      this.finish('succeeded', result.code, result.signal, result);
      return;
    }
    if (this.sawResult) {
      // The CLI reported the failure itself; parseResult already emitted it.
      this.finish('failed', result.code, result.signal, result);
      return;
    }

    // No result line at all. This is the case where stderr finally earns a
    // read: as text for a human, never as a branch.
    const tail = (result.stderrTail ?? '').trim();
    const message =
      tail.length > 0
        ? `The engine exited with code ${result.code} and produced no result. Last output: ${tail.slice(-1500)}`
        : `The engine exited with code ${result.code} and produced no result.`;
    this.emitError(
      result.code === 0 ? 'protocol' : classifyErrorText(tail),
      message,
    );
    this.finish('failed', result.code, result.signal, result);
  }

  private finish(
    status: EngineRunStatus,
    exitCode: number | null,
    signal: NodeJS.Signals | string | null,
    result?: SpawnResult,
  ): void {
    const durationMs = result?.durationMs ?? Date.now() - this.startedAt;
    const usage: Usage = { ...this.lastUsage };
    if (usage.turns === undefined && this.turns) usage.turns = this.turns;

    this.emit({
      at: nowIso(),
      type: 'engine.finished',
      status,
      exitCode,
      signal: signal === null ? null : String(signal),
      durationMs,
      usage,
      sessionId: this.sessionId,
      error: this.firstError?.message,
      errorKind: this.firstError?.kind,
    });

    this.queue.close();

    const summary: EngineRunSummary = {
      engineId: CLAUDE_CODE_ENGINE_ID,
      status,
      sessionId: this.sessionId,
      usage,
      byModel: this.byModel,
      turns: this.turns,
      durationMs,
      exitCode,
      signal: signal === null ? null : String(signal),
      error: this.firstError?.message,
      errorKind: this.firstError?.kind,
      stderrTail: result?.stderrTail,
      stderrLogPath: this.config.options.stderrLogPath,
      transcriptPath: this.config.options.transcriptPath,
      attempts: this.attempts,
    };

    // `done` must not resolve until the transcript is on disk: the summary
    // points a caller at that file, and resolving first makes a read-after-run
    // an intermittent short read.
    const transcript = this.transcript;
    this.transcript = null;
    if (!transcript) {
      this.resolveDone(summary);
      return;
    }
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      this.resolveDone(summary);
    };
    const timer = setTimeout(settle, 2000);
    timer.unref?.();
    transcript.end(() => {
      clearTimeout(timer);
      settle();
    });
  }
}

/**
 * Replace the prompt in a logged argv with a placeholder. The prompt can be
 * large and is already persisted on the run row; repeating it in every
 * `engine.started` event bloats the transcript for nothing.
 */
function redactPrompt(args: string[], prompt: string): string[] {
  return args.map((arg) =>
    arg === prompt ? `<prompt:${prompt.length} chars>` : arg,
  );
}

/* ------------------------------------------------------------------ */
/* The adapter                                                         */
/* ------------------------------------------------------------------ */

export interface ClaudeCodeAdapterOptions {
  /** Skip the PATH lookup. Injectable so tests can drive a fake CLI. */
  binaryPath?: string;
  logger?: Logger;
}

export class ClaudeCodeAdapter implements EngineAdapter {
  readonly id = CLAUDE_CODE_ENGINE_ID;

  readonly name = 'Claude Code';

  private readonly logger: Logger;

  private cached: EngineDetection | null = null;

  constructor(private readonly options: ClaudeCodeAdapterOptions = {}) {
    this.logger = options.logger ?? getLogger('engines:claude-code');
  }

  /** Last detection result, if any. Never triggers a probe. */
  get lastDetection(): EngineDetection | null {
    return this.cached;
  }

  async detect(options: DetectOptions = {}): Promise<EngineDetection> {
    if (this.cached && !options.force) return this.cached;

    const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    const binaryPath =
      options.binaryPath ??
      this.options.binaryPath ??
      whichSync(CLAUDE_CODE_BINARY);
    const apiKeyEnv = findApiKeyEnv();
    const detectedAt = nowIso();

    if (!binaryPath) {
      const detection: EngineDetection = {
        info: {
          id: this.id,
          name: this.name,
          available: false,
          reason:
            'The Claude Code CLI was not found on PATH. Install it, then reopen this screen. If it is installed, make sure its directory is on the PATH the app inherits.',
          supportsResume: false,
          supportsStreamingJson: false,
          detectedAt,
        },
        auth: buildAuthStatus({
          apiKeyEnv,
          stripping: true,
          probeError: 'CLI not installed',
        }),
        capabilities: {
          streamingJson: false,
          resume: false,
          maxTurns: false,
          maxBudgetUsd: false,
          mcpConfig: false,
          strictMcpConfig: false,
          partialMessages: false,
        },
      };
      this.cached = detection;
      return detection;
    }

    // Probes run where the app runs, not in a user project: `--version` and
    // `--help` do not care, and this keeps detection away from any directory
    // that might hold a resumable session.
    const probeCwd = process.cwd();
    const env = engineEnvOverrides({ allowApiKeyEnv: false });

    const [version, help, auth, maxTurns, maxBudget] = await Promise.all([
      runProcess(binaryPath, ['--version'], {
        timeoutMs,
        cwd: probeCwd,
        env,
        label: 'claude --version',
      }),
      runProcess(binaryPath, ['--help'], {
        timeoutMs,
        cwd: probeCwd,
        env,
        label: 'claude --help',
      }),
      runProcess(binaryPath, ['auth', 'status', '--json'], {
        timeoutMs,
        cwd: probeCwd,
        env,
        label: 'claude auth status',
      }),
      probeFlagArity(binaryPath, '--max-turns', timeoutMs, probeCwd),
      probeFlagArity(binaryPath, '--max-budget-usd', timeoutMs, probeCwd),
    ]);

    const versionText = version.stdout.trim();
    const parsedVersion = parseVersion(versionText);
    const helpText = `${help.stdout}\n${help.stderrTail}`;

    const capabilities: EngineCapabilities = {
      streamingJson: helpText.includes('stream-json'),
      resume: /--resume/.test(helpText),
      maxTurns,
      maxBudgetUsd: maxBudget,
      mcpConfig: /--mcp-config/.test(helpText),
      strictMcpConfig: /--strict-mcp-config/.test(helpText),
      partialMessages: /--include-partial-messages/.test(helpText),
    };

    // `--version` failing is the one hard stop: if the binary will not identify
    // itself, nothing downstream is trustworthy.
    const versionOk = version.code === 0 && parsedVersion !== undefined;
    const reason = versionOk
      ? undefined
      : `\`${binaryPath} --version\` failed (exit ${version.code}). ${
          version.stderrTail.trim().slice(-500) || 'No output.'
        }`;

    // Missing stream-json in --help is suspicious but not disqualifying: help
    // text is prose and has been reworded before. Warn, do not block.
    if (versionOk && !capabilities.streamingJson) {
      this.logger.warn(
        'claude --help does not mention stream-json; assuming it is still supported',
        { version: parsedVersion },
      );
      capabilities.streamingJson = true;
    }

    const rawAuth = auth.code === 0 ? parseAuthJson(auth.stdout) : undefined;
    let authProbeError: string | undefined;
    if (auth.code !== 0) {
      authProbeError = `\`claude auth status\` exited ${auth.code}`;
    } else if (!rawAuth) {
      authProbeError = 'unrecognised output from `claude auth status --json`';
    }

    const detection: EngineDetection = {
      info: {
        id: this.id,
        name: this.name,
        available: versionOk,
        binaryPath,
        version: parsedVersion,
        reason,
        supportsResume: capabilities.resume,
        supportsStreamingJson: capabilities.streamingJson,
        detectedAt,
      },
      auth: buildAuthStatus({
        raw: rawAuth,
        probeError: authProbeError,
        apiKeyEnv,
        stripping: true,
      }),
      capabilities,
      rawVersion: versionText || undefined,
    };

    this.logger.info('detected claude code', {
      binaryPath,
      version: parsedVersion,
      available: versionOk,
      auth: detection.auth.state,
      apiKeyEnvDetected: apiKeyEnv.detected,
      capabilities,
    });

    this.cached = detection;
    return detection;
  }

  run(prompt: string, options: EngineRunOptions): EngineRun {
    return this.start(prompt, options, 'run', options.sessionId);
  }

  resume(
    sessionId: string,
    prompt: string,
    options: EngineRunOptions,
  ): EngineRun {
    return this.start(prompt, options, 'resume', sessionId);
  }

  private start(
    prompt: string,
    options: EngineRunOptions,
    mode: 'run' | 'resume',
    sessionId?: string,
  ): EngineRun {
    const binaryPath =
      options.binaryPath ??
      this.options.binaryPath ??
      this.cached?.info.binaryPath ??
      whichSync(CLAUDE_CODE_BINARY);

    return new ClaudeCodeRun({
      prompt,
      options,
      mode,
      sessionId,
      binaryPath: binaryPath ?? null,
      binaryError: binaryPath
        ? undefined
        : 'The Claude Code CLI was not found on PATH.',
      // Only trust cached capabilities for the binary they were measured on.
      capabilities:
        this.cached && this.cached.info.binaryPath === binaryPath
          ? this.cached.capabilities
          : undefined,
      logger: options.logger ?? this.logger,
    });
  }
}

/** Convenience for the common case. */
export function createClaudeCodeAdapter(
  options?: ClaudeCodeAdapterOptions,
): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter(options);
}
