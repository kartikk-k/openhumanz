/**
 * Child processes.
 *
 * Rules from ARCHITECTURE.md that this file implements rather than documents:
 *
 *  - **stdout is the event stream; stderr is a log, never control flow.**
 *    `onStdoutLine` is the only line callback wired to logic. stderr is
 *    appended to a file and kept as a short tail for error messages.
 *  - **Track spawned pids; kill the tree on cancel and on quit.** Children are
 *    spawned detached so they get their own process group and the whole group
 *    can be signalled. {@link killAllTracked} is what `before-quit` calls.
 *  - **End users have no `node`.** {@link spawnNodeHelper} runs a bundled
 *    script through `process.execPath` with `ELECTRON_RUN_AS_NODE=1`.
 */
import { spawn as childSpawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomId } from './crypto';

export interface SpawnOptions {
  cwd?: string;
  /**
   * Extra environment. Merged over `process.env`; a key set to `undefined`
   * removes it, which is how a stray `ANTHROPIC_API_KEY` gets stripped.
   */
  env?: Record<string, string | undefined>;
  /** Kill the tree after this long. Reported as `timedOut`. */
  timeoutMs?: number;
  /** Appended to, created on demand. Normally `runs/<runId>/stderr.log`. */
  stderrLogPath?: string;
  /** Called once per complete stdout line, without the newline. */
  onStdoutLine?(line: string): void;
  /** Diagnostics only. Do not branch on this. */
  onStderrLine?(line: string): void;
  /** Written to stdin, which is then closed. */
  stdin?: string;
  /** Keep stdout in memory as well as streaming it. Default true. */
  collectStdout?: boolean;
  /** Cap on retained stdout, to bound memory on a runaway child. Default 8 MiB. */
  maxStdoutBytes?: number;
  /** Retained stderr tail, for error messages. Default 8 KiB. */
  maxStderrTailBytes?: number;
  /** Signal used by `kill()` and by the timeout. Default `SIGTERM`. */
  killSignal?: NodeJS.Signals;
  /** Escalate to SIGKILL this long after the first signal. Default 5000 ms. */
  killGraceMs?: number;
  /** Shown in logs and errors. Defaults to the command. */
  label?: string;
}

export interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Empty when `collectStdout` is false. */
  stdout: string;
  /** Last `maxStderrTailBytes` of stderr. Diagnostics only. */
  stderrTail: string;
  stderrLogPath?: string;
  timedOut: boolean;
  /** True when we signalled it, whether by `kill()` or by the timeout. */
  killed: boolean;
  durationMs: number;
  pid?: number;
  command: string;
  args: string[];
}

export interface SpawnHandle {
  /** Our id, stable even before the OS assigns a pid. */
  readonly id: string;
  readonly command: string;
  readonly args: string[];
  readonly pid: number | undefined;
  /** Resolves when the child exits. Never rejects on a non-zero exit. */
  readonly result: Promise<SpawnResult>;
  /** Signal the whole process group. Resolves once the child is gone. */
  kill(signal?: NodeJS.Signals): Promise<SpawnResult>;
  /** Write to stdin. No-op after the child exits. */
  write(data: string): void;
  /** Close stdin. */
  closeStdin(): void;
}

/* ------------------------------------------------------------------ */
/* Tracking                                                            */
/* ------------------------------------------------------------------ */

interface Tracked {
  id: string;
  pid: number;
  label: string;
  child: ChildProcess;
  startedAt: number;
}

const tracked = new Map<string, Tracked>();

/** Pids of every child we started that has not exited. */
export function trackedPids(): number[] {
  return [...tracked.values()].map((entry) => entry.pid);
}

export function trackedProcesses(): {
  id: string;
  pid: number;
  label: string;
  startedAt: number;
}[] {
  return [...tracked.values()].map(({ id, pid, label, startedAt }) => ({
    id,
    pid,
    label,
    startedAt,
  }));
}

/**
 * Kill every tracked child's process group. Called from `before-quit`; an
 * orphaned agent CLI keeps burning quota long after the app window is gone.
 */
export async function killAllTracked(
  signal: NodeJS.Signals = 'SIGTERM',
): Promise<void> {
  await Promise.all(
    [...tracked.values()].map((entry) => killTree(entry.pid, signal)),
  );
}

/**
 * Signal a process group, falling back to the bare pid.
 *
 * Children are spawned `detached`, so their pid is also their process group id
 * and `kill(-pid)` reaches grandchildren — which matters because an agent CLI
 * spawns its own tools. On Windows there are no process groups, so `taskkill`
 * does the walking.
 */
export async function killTree(
  pid: number,
  signal: NodeJS.Signals = 'SIGTERM',
): Promise<void> {
  if (!pid || pid <= 0) return;

  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = childSpawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
      });
      killer.on('error', () => resolve());
      killer.on('close', () => resolve());
    });
    return;
  }

  try {
    process.kill(-pid, signal);
    return;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return;
    // No process group (spawn failed to detach) — fall through to the pid.
  }
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

/* ------------------------------------------------------------------ */
/* Line splitting                                                      */
/* ------------------------------------------------------------------ */

/**
 * Split a byte stream into complete lines. Returned function is fed chunks;
 * call the returned `flush` to emit a trailing partial line at EOF.
 */
export function createLineSplitter(onLine: (line: string) => void): {
  push(chunk: Buffer | string): void;
  flush(): void;
} {
  let buffer = '';
  return {
    push(chunk) {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        onLine(line);
        index = buffer.indexOf('\n');
      }
    },
    flush() {
      if (buffer.length > 0) {
        const line = buffer.replace(/\r$/, '');
        buffer = '';
        onLine(line);
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Environment                                                         */
/* ------------------------------------------------------------------ */

/** `process.env` with the overrides applied; `undefined` values are removed. */
export function mergeEnv(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/**
 * Environment for running a bundled script through Electron's own Node.
 * `ELECTRON_RUN_AS_NODE=1` turns `process.execPath` into a plain node binary,
 * which is the only node an end user is guaranteed to have.
 */
export function electronNodeEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    ...overrides,
    ELECTRON_RUN_AS_NODE: '1',
    // Never inherit the app's own devtools/inspector flags into a helper.
    ELECTRON_NO_ATTACH_CONSOLE: '1',
  };
}

/* ------------------------------------------------------------------ */
/* Spawn                                                               */
/* ------------------------------------------------------------------ */

/**
 * Start a child process. Resolution of `handle.result` means the child exited;
 * a non-zero exit is a value, not a rejection, because "the CLI said no" is an
 * expected outcome rather than a bug.
 */
export function spawnProcess(
  command: string,
  args: string[] = [],
  options: SpawnOptions = {},
): SpawnHandle {
  const {
    cwd,
    env,
    timeoutMs,
    stderrLogPath,
    onStdoutLine,
    onStderrLine,
    stdin,
    collectStdout = true,
    maxStdoutBytes = 8 * 1024 * 1024,
    maxStderrTailBytes = 8 * 1024,
    killSignal = 'SIGTERM',
    killGraceMs = 5000,
    label = command,
  } = options;

  const id = randomId('proc');
  const startedAt = Date.now();

  if (stderrLogPath) {
    fs.mkdirSync(path.dirname(stderrLogPath), { recursive: true });
  }
  const stderrStream = stderrLogPath
    ? fs.createWriteStream(stderrLogPath, { flags: 'a' })
    : null;

  const child = childSpawn(command, args, {
    cwd,
    env: mergeEnv(env),
    stdio: ['pipe', 'pipe', 'pipe'],
    // Own process group, so killTree can reach grandchildren.
    detached: process.platform !== 'win32',
    windowsHide: true,
  });

  if (child.pid) {
    tracked.set(id, { id, pid: child.pid, label, child, startedAt });
  }

  let stdout = '';
  let stdoutBytes = 0;
  let stderrTail = '';
  let timedOut = false;
  let killed = false;
  let settled = false;
  let graceTimer: NodeJS.Timeout | null = null;

  const stdoutSplitter = createLineSplitter((line) => {
    onStdoutLine?.(line);
  });
  const stderrSplitter = createLineSplitter((line) => {
    onStderrLine?.(line);
  });

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    if (collectStdout && stdoutBytes < maxStdoutBytes) {
      stdout += chunk;
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes >= maxStdoutBytes) {
        stdout += '\n[stdout truncated]';
      }
    }
    stdoutSplitter.push(chunk);
  });

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrStream?.write(chunk);
    stderrTail = (stderrTail + chunk).slice(-maxStderrTailBytes);
    stderrSplitter.push(chunk);
  });

  if (stdin !== undefined) {
    child.stdin?.write(stdin);
    child.stdin?.end();
  }

  let timeoutTimer: NodeJS.Timeout | null = null;

  const escalate = (): void => {
    if (!child.pid) return;
    graceTimer = setTimeout(() => {
      void killTree(child.pid as number, 'SIGKILL');
    }, killGraceMs);
    graceTimer.unref?.();
  };

  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    killed = true;
    if (child.pid) await killTree(child.pid, signal);
    escalate();
  };

  const result = new Promise<SpawnResult>((resolve) => {
    const finish = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      tracked.delete(id);
      stdoutSplitter.flush();
      stderrSplitter.flush();
      stderrStream?.end();
      resolve({
        code,
        signal,
        stdout,
        stderrTail,
        stderrLogPath,
        timedOut,
        killed,
        durationMs: Date.now() - startedAt,
        pid: child.pid,
        command,
        args,
      });
    };

    child.on('error', (error) => {
      stderrTail = `${stderrTail}${error.message}\n`.slice(-maxStderrTailBytes);
      stderrStream?.write(`${error.stack ?? error.message}\n`);
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });

  if (timeoutMs !== undefined && timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      void stop(killSignal);
    }, timeoutMs);
    timeoutTimer.unref?.();
  }

  return {
    id,
    command,
    args,
    get pid() {
      return child.pid;
    },
    result,
    async kill(signal = killSignal) {
      await stop(signal);
      return result;
    },
    write(data) {
      if (!settled) child.stdin?.write(data);
    },
    closeStdin() {
      child.stdin?.end();
    },
  };
}

/** {@link spawnProcess}, awaited. */
export function runProcess(
  command: string,
  args: string[] = [],
  options: SpawnOptions = {},
): Promise<SpawnResult> {
  return spawnProcess(command, args, options).result;
}

/**
 * Run a bundled helper script (the MCP shim, for one) through Electron in Node
 * mode. Never spawn a bare `node`: end users do not have one, and the one on a
 * developer's PATH is not the version the app was built against.
 */
export function spawnNodeHelper(
  scriptPath: string,
  args: string[] = [],
  options: SpawnOptions = {},
): SpawnHandle {
  return spawnProcess(process.execPath, [scriptPath, ...args], {
    ...options,
    label: options.label ?? path.basename(scriptPath),
    env: electronNodeEnv(options.env),
  });
}

/** Basename of the MCP shim bundle, emitted next to the main bundle. */
export const SHIM_FILENAME = 'shim.js';

/**
 * Absolute path of a file webpack emitted next to the main bundle
 * (`.erb/dll/` in dev, `dist/main/` when packaged).
 */
export function bundledHelperPath(fileName: string): string {
  const here = typeof __dirname === 'string' ? __dirname : process.cwd();
  return path.join(here, fileName);
}

/** Where {@link spawnNodeHelper} should be pointed to start the MCP shim. */
export function shimPath(): string {
  return bundledHelperPath(SHIM_FILENAME);
}

/** Awaited {@link spawnNodeHelper}. */
export function runNodeHelper(
  scriptPath: string,
  args: string[] = [],
  options: SpawnOptions = {},
): Promise<SpawnResult> {
  return spawnNodeHelper(scriptPath, args, options).result;
}

/**
 * Resolve an executable on PATH without a shell. Returns null when not found;
 * detection reports unavailable, it does not throw.
 */
export function whichSync(command: string): string | null {
  const isWindows = process.platform === 'win32';
  const exts = isWindows
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : [''];
  const dirs = (process.env.PATH ?? '').split(isWindows ? ';' : ':');
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}
