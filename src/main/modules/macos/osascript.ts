/**
 * The `osascript` execution path. Everything that reaches macOS goes through
 * here, and nothing else in this module spawns a process.
 *
 * Four properties this file is responsible for.
 *
 * **Arguments never become source.** A script is a file path and a list of argv
 * strings. `spawnProcess` runs the binary directly with no shell, so the values
 * arrive at `on run argv` as opaque byte strings. There is no interpolation on
 * this path at all — see `escape.ts` for why that is the whole security story.
 *
 * **A hard deadline, always.** Mail hangs. Not occasionally: a mailbox that is
 * re-indexing, a server that is not answering, a `whose` clause over forty
 * thousand messages, and the Apple Event never comes back. Every call carries a
 * timeout, the child is spawned into its own process group and the group is
 * killed, so a wedged `osascript` cannot outlive the call that started it.
 *
 * **One call at a time per target app.** These apps handle simultaneous Apple
 * Events badly — Mail in particular serialises them internally and then starts
 * timing them out, so firing five at once is slower than firing them in
 * sequence and occasionally wedges the app. A per-app semaphore makes the
 * queueing explicit and measurable (`queueWaitMs` in diagnostics) instead of
 * leaving it to chance inside another process.
 *
 * **Output is JSON and is validated.** Script stdout is parsed and run through a
 * zod schema before anything sees it. The model never receives raw script
 * output: it is untrusted (the strings inside it came from an email) and it is
 * unstable (Apple changes what a property returns between releases). A shape
 * that does not match is a `bad-output` error naming the field, which is a bug
 * report; passing it through would be a silent wrong answer.
 */
import { z } from 'zod';
import type { Logger } from '../../infra/logger';
import { spawnProcess, type SpawnResult } from '../../infra/spawn';
import { randomId } from '../../infra/crypto';
import type { AppleAppId } from './apps';
import { MacosError, mapAppleScriptError, type MacosErrorKind } from './errors';
import { Diagnostics, startRecord } from './diagnostics';
import { ScriptStore } from './scripts';
import { Semaphore } from './semaphore';

/**
 * Absolute path, never resolved from `PATH`.
 *
 * A `PATH` lookup would let anything that can prepend a directory to the
 * environment we spawn with substitute its own binary and inherit our automation
 * grants. `/usr/bin/osascript` is on the signed system volume.
 */
export const OSASCRIPT_PATH = '/usr/bin/osascript';

/** Default deadline. Deliberately short: a slow answer is a failed answer. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Per-app deadlines. Mail gets longer because its dictionary genuinely is slow
 * on a large mailbox; nothing gets longer than 45 seconds, because past that a
 * user has given up and an agent step has burned its budget waiting.
 */
export const APP_TIMEOUTS_MS: Partial<Record<AppleAppId, number>> = {
  mail: 30_000,
  notes: 20_000,
  contacts: 20_000,
  calendar: 20_000,
  reminders: 15_000,
  finder: 8_000,
  systemevents: 8_000,
};

/** Concurrent invocations allowed against one app. One, on purpose. */
export const DEFAULT_APP_CONCURRENCY = 1;

/** Ceiling across all apps, so a burst cannot spawn twenty processes. */
export const DEFAULT_GLOBAL_CONCURRENCY = 4;

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

/** Injection seam so the concurrency and timeout behaviour is testable. */
export type ProcessRunner = (
  command: string,
  args: string[],
  options: {
    timeoutMs?: number;
    env?: Record<string, string | undefined>;
    /** Kill the child when this fires. */
    signal?: AbortSignal;
  },
) => Promise<SpawnResult>;

/**
 * The real runner: spawn, and kill the process group if the run is cancelled.
 *
 * `runProcess` alone would not do — it returns only a promise, so a cancelled
 * run would leave a wedged `osascript` alive until its own timeout, holding the
 * per-app semaphore slot and blocking every queued call behind it. Cancellation
 * has to reach the child, not just the caller.
 */
function spawnOsascript(
  command: string,
  args: string[],
  options: {
    timeoutMs?: number;
    env?: Record<string, string | undefined>;
    signal?: AbortSignal;
  },
): Promise<SpawnResult> {
  const handle = spawnProcess(command, args, {
    timeoutMs: options.timeoutMs,
    env: options.env,
    label: 'osascript',
    collectStdout: true,
    // Far more than any bounded script here can produce; the cap exists so a
    // pathological result cannot exhaust memory.
    maxStdoutBytes: 4 * 1024 * 1024,
  });

  const { signal } = options;
  if (!signal) return handle.result;
  if (signal.aborted) {
    void handle.kill();
    return handle.result;
  }
  const onAbort = (): void => {
    void handle.kill();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  return handle.result.finally(() =>
    signal.removeEventListener('abort', onAbort),
  );
}

export interface OsascriptRunnerOptions {
  scripts: ScriptStore;
  diagnostics: Diagnostics;
  logger: Logger;
  /** Overridden in tests to point at a fake. */
  binaryPath?: string;
  appConcurrency?: number;
  globalConcurrency?: number;
  defaultTimeoutMs?: number;
  /** Overridden in tests. Defaults to `infra/spawn.runProcess`. */
  run?: ProcessRunner;
  /** Overridden in tests. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

export interface RunScriptOptions<TOutput> {
  script: string;
  /** Target application, for the per-app semaphore, timeout and error copy. */
  appId?: AppleAppId;
  args?: readonly string[];
  /** Validated before the value is returned. Required — there is no raw path. */
  schema: z.ZodType<TOutput>;
  timeoutMs?: number;
  /** Cancelled when the run is cancelled. */
  signal?: AbortSignal;
}

export class OsascriptRunner {
  private readonly scripts: ScriptStore;

  private readonly diagnostics: Diagnostics;

  private readonly logger: Logger;

  private readonly binaryPath: string;

  private readonly appConcurrency: number;

  private readonly defaultTimeoutMs: number;

  private readonly global: Semaphore;

  private readonly perApp = new Map<string, Semaphore>();

  private readonly run: ProcessRunner;

  private readonly platform: NodeJS.Platform;

  constructor(options: OsascriptRunnerOptions) {
    this.scripts = options.scripts;
    this.diagnostics = options.diagnostics;
    this.logger = options.logger;
    this.binaryPath = options.binaryPath ?? OSASCRIPT_PATH;
    this.appConcurrency = options.appConcurrency ?? DEFAULT_APP_CONCURRENCY;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.global = new Semaphore(
      options.globalConcurrency ?? DEFAULT_GLOBAL_CONCURRENCY,
    );
    this.run = options.run ?? spawnOsascript;
    this.platform = options.platform ?? process.platform;
  }

  get isSupportedPlatform(): boolean {
    return this.platform === 'darwin';
  }

  private semaphoreFor(appId: AppleAppId | undefined): Semaphore {
    const key = appId ?? '_none';
    let semaphore = this.perApp.get(key);
    if (!semaphore) {
      semaphore = new Semaphore(this.appConcurrency);
      this.perApp.set(key, semaphore);
    }
    return semaphore;
  }

  /** Live queue depth per app. Surfaced on the diagnostics screen. */
  queueDepths(): { key: string; inUse: number; queued: number }[] {
    return [...this.perApp.entries()].map(([key, semaphore]) => ({
      key,
      inUse: semaphore.inUse,
      queued: semaphore.queued,
    }));
  }

  /**
   * Run a script and return its validated output.
   *
   * Throws {@link MacosError} and nothing else. Callers turn that into a tool
   * result; they never see a spawn error or a zod error.
   */
  async runScript<TOutput>(
    options: RunScriptOptions<TOutput>,
  ): Promise<TOutput> {
    const { script, appId, schema } = options;
    const args = [...(options.args ?? [])];

    if (!this.isSupportedPlatform) {
      throw new MacosError({
        kind: 'unavailable',
        message: `AppleScript is only available on macOS; this is ${this.platform}.`,
        script,
        appId,
      });
    }

    if (options.signal?.aborted) {
      throw new MacosError({
        kind: 'user-cancelled',
        message: 'The run was cancelled before the script started.',
        script,
        appId,
      });
    }

    let scriptPath: string;
    try {
      scriptPath = this.scripts.pathFor(script, appId);
    } catch (cause) {
      throw new MacosError({
        kind: 'unavailable',
        message: cause instanceof Error ? cause.message : String(cause),
        script,
        appId,
        cause,
      });
    }

    const timeoutMs =
      options.timeoutMs ??
      (appId ? APP_TIMEOUTS_MS[appId] : undefined) ??
      this.defaultTimeoutMs;

    const record = startRecord(randomId('osa'), script, appId, args);
    const queuedAt = Date.now();

    // Global slot first, then the per-app slot. Always this order: taking the
    // narrow lock first and then blocking on the wide one is how a deadlock is
    // built, and with two levels it is worth being explicit about.
    const releaseGlobal = await this.global.acquire();
    let releaseApp: (() => void) | null = null;
    try {
      releaseApp = await this.semaphoreFor(appId).acquire();
      record.queueWaitMs = Date.now() - queuedAt;

      if (options.signal?.aborted) {
        throw new MacosError({
          kind: 'user-cancelled',
          message: 'The run was cancelled while the script was queued.',
          script,
          appId,
        });
      }

      const result = await this.spawn(
        scriptPath,
        args,
        timeoutMs,
        options.signal,
      );

      record.durationMs = result.durationMs;
      record.exitCode = result.code;
      record.signal = result.signal;
      record.timedOut = result.timedOut;
      record.stderr = result.stderrTail;
      record.stdoutBytes = Buffer.byteLength(result.stdout, 'utf8');

      if (result.timedOut || result.code !== 0) {
        const error = mapAppleScriptError({
          stderr: result.stderrTail,
          exitCode: result.code,
          timedOut: result.timedOut,
          appId,
          script,
          durationMs: result.durationMs,
        });
        record.errorKind = error.kind;
        record.errorNumber = error.number;
        throw error;
      }

      const parsed = parseScriptOutput(result.stdout, schema, script, appId);
      record.ok = true;
      return parsed;
    } catch (cause) {
      if (!record.errorKind) {
        record.errorKind =
          cause instanceof MacosError
            ? cause.kind
            : ('unknown' satisfies MacosErrorKind);
        if (cause instanceof MacosError) record.errorNumber = cause.number;
      }
      throw cause instanceof MacosError
        ? cause
        : new MacosError({
            kind: 'unknown',
            message: cause instanceof Error ? cause.message : String(cause),
            script,
            appId,
            cause,
          });
    } finally {
      if (releaseApp) releaseApp();
      releaseGlobal();
      this.diagnostics.record(record);
      if (!record.ok) {
        this.logger.warn('osascript failed', {
          script,
          appId,
          exitCode: record.exitCode,
          timedOut: record.timedOut,
          durationMs: record.durationMs,
          errorKind: record.errorKind,
          errorNumber: record.errorNumber,
        });
      } else {
        this.logger.debug('osascript ok', {
          script,
          appId,
          durationMs: record.durationMs,
          queueWaitMs: record.queueWaitMs,
        });
      }
    }
  }

  private async spawn(
    scriptPath: string,
    args: string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<SpawnResult> {
    return this.run(this.binaryPath, [scriptPath, ...args], {
      timeoutMs,
      signal,
      env: {
        // A helper spawned from Electron inherits ELECTRON_RUN_AS_NODE and the
        // inspector flags. osascript is not node and neither belongs here.
        ELECTRON_RUN_AS_NODE: undefined,
        ELECTRON_NO_ATTACH_CONSOLE: undefined,
        NODE_OPTIONS: undefined,
      },
    });
  }
}

/**
 * Parse and validate script stdout.
 *
 * A module-level function rather than a method because it touches no runner
 * state: given the same bytes it gives the same answer, which is what makes the
 * malformed-output cases testable without constructing a runner at all.
 */
function parseScriptOutput<TOutput>(
  stdout: string,
  schema: z.ZodType<TOutput>,
  script: string,
  appId?: AppleAppId,
): TOutput {
  const text = stdout.trim();
  if (text === '') {
    throw new MacosError({
      kind: 'bad-output',
      message: `The ${script} script produced no output.`,
      script,
      appId,
    });
  }

  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new MacosError({
      kind: 'bad-output',
      message: `The ${script} script did not return JSON.`,
      script,
      appId,
      // The first line only: a mangled 4 MiB body in a log helps nobody, and
      // the whole point of keeping stderr is that this is where to look.
      stderr: text.slice(0, 500),
      cause,
    });
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join('.') || '(root)';
    throw new MacosError({
      kind: 'bad-output',
      message:
        `The ${script} script returned an unexpected shape at "${where}": ` +
        `${first?.message ?? 'validation failed'}. This usually means the ` +
        "application's scripting support changed in this macOS version.",
      script,
      appId,
      stderr: text.slice(0, 500),
    });
  }
  return parsed.data;
}
