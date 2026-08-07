/**
 * Leveled logging to console and to a file in `<workspace>/logs/`.
 *
 * Wraps the already-installed `electron-log`. The `electron-log/node` entry is
 * used rather than `electron-log/main` so this module also works in a helper
 * spawned through `ELECTRON_RUN_AS_NODE` and in a plain bun script; if the
 * package cannot be loaded at all we degrade to console instead of throwing,
 * because failing to log is never a reason to fail to start.
 *
 * The log path is ours, not electron-log's default under `userData` — logs
 * belong in the workspace next to everything else the user might want to read.
 */
import path from 'node:path';
import type { LogLevel } from '../../shared/common';
import { ensureDirSync, LOGS_DIRNAME } from './paths';

/** Structured context attached to a line. Kept flat and small. */
export type LogMeta = Record<string, unknown>;

export interface Logger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta | unknown): void;
  /** A logger that prefixes every line with `scope`. Cheap; make them freely. */
  child(scope: string): Logger;
  readonly scope: string;
}

export interface LoggerOptions {
  /** Directory for the log file. Normally `paths.logsDir`. */
  logsDir: string;
  /** Minimum level written. Default `info` (`debug` when NODE_ENV=development). */
  level?: LogLevel;
  /** Default `main.log`. */
  fileName?: string;
  /** Rotate once the file exceeds this. Default 5 MiB. */
  maxFileBytes?: number;
  /** How many rotated files to keep. Default 5. */
  maxFiles?: number;
  /** Write to stdout as well as the file. Default true. */
  console?: boolean;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

interface Sink {
  write(level: LogLevel, line: string): void;
  setLevel(level: LogLevel): void;
  filePath(): string | null;
}

/* ------------------------------------------------------------------ */
/* electron-log binding                                                */
/* ------------------------------------------------------------------ */

interface ElectronLogLike {
  transports: {
    console: { level: unknown; format?: unknown };
    file: {
      level: unknown;
      maxSize: number;
      resolvePathFn: (...args: unknown[]) => string;
      archiveLogFn?: (file: { path: string }) => void;
      getFile?: () => { path: string };
      format?: unknown;
    };
  };
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  create(options: { logId: string }): ElectronLogLike;
}

function loadElectronLog(): ElectronLogLike | null {
  try {
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    const mod = require('electron-log/node') as
      ElectronLogLike | { default: ElectronLogLike };
    const resolved = 'transports' in mod ? mod : mod.default;
    return resolved && resolved.transports ? resolved : null;
  } catch {
    return null;
  }
}

function createElectronLogSink(options: LoggerOptions): Sink | null {
  const backend = loadElectronLog();
  if (!backend) return null;

  const {
    logsDir,
    level = defaultLevel(),
    fileName = 'main.log',
    maxFileBytes = 5 * 1024 * 1024,
    maxFiles = 5,
    console: toConsole = true,
  } = options;

  ensureDirSync(logsDir);
  const file = path.join(logsDir, fileName);

  const instance = backend.create({ logId: 'assistant' });
  instance.transports.file.resolvePathFn = () => file;
  instance.transports.file.maxSize = maxFileBytes;
  instance.transports.file.level = level;
  instance.transports.console.level = toConsole ? level : false;
  instance.transports.file.archiveLogFn = (old: { path: string }) => {
    rotate(old.path, maxFiles);
  };

  return {
    write(lineLevel, line) {
      instance[lineLevel](line);
    },
    setLevel(next) {
      instance.transports.file.level = next;
      instance.transports.console.level = toConsole ? next : false;
    },
    filePath: () => file,
  };
}

/** Keep `main.log.1 … main.log.N`, dropping the oldest. */
function rotate(oldPath: string, maxFiles: number): void {
  // Required lazily so this module still loads where fs is unavailable.
  // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs');
  try {
    for (let index = maxFiles - 1; index >= 1; index -= 1) {
      const from = `${oldPath}.${index}`;
      const to = `${oldPath}.${index + 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    fs.renameSync(oldPath, `${oldPath}.1`);
    const dropped = `${oldPath}.${maxFiles + 1}`;
    if (fs.existsSync(dropped)) fs.rmSync(dropped, { force: true });
  } catch {
    /* rotation is best effort */
  }
}

/** Last-resort sink: console only, no file. */
function createConsoleSink(level: LogLevel): Sink {
  let current = level;
  return {
    write(lineLevel, line) {
      if (LEVEL_ORDER[lineLevel] < LEVEL_ORDER[current]) return;
      /* eslint-disable no-console */
      if (lineLevel === 'error') console.error(line);
      else if (lineLevel === 'warn') console.warn(line);
      else console.log(line);
      /* eslint-enable no-console */
    },
    setLevel(next) {
      current = next;
    },
    filePath: () => null,
  };
}

function defaultLevel(): LogLevel {
  return process.env.NODE_ENV === 'development' ? 'debug' : 'info';
}

/* ------------------------------------------------------------------ */
/* Public surface                                                      */
/* ------------------------------------------------------------------ */

let sink: Sink = createConsoleSink(defaultLevel());
let activeLevel: LogLevel = defaultLevel();
let initialized = false;

function formatMeta(meta: LogMeta | unknown): string {
  if (meta === undefined || meta === null) return '';
  if (meta instanceof Error) {
    return ` ${meta.stack ?? `${meta.name}: ${meta.message}`}`;
  }
  try {
    const text = JSON.stringify(meta);
    return text && text !== '{}' ? ` ${text}` : '';
  } catch {
    return ` ${String(meta)}`;
  }
}

function makeLogger(scope: string): Logger {
  const emit = (level: LogLevel, message: string, meta?: unknown): void => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[activeLevel]) return;
    const prefix = scope ? `[${scope}] ` : '';
    sink.write(level, `${prefix}${message}${formatMeta(meta)}`);
  };

  return {
    scope,
    debug: (message, meta) => emit('debug', message, meta),
    info: (message, meta) => emit('info', message, meta),
    warn: (message, meta) => emit('warn', message, meta),
    error: (message, meta) => emit('error', message, meta),
    child: (childScope) =>
      makeLogger(scope ? `${scope}:${childScope}` : childScope),
  };
}

/**
 * Configure the process-wide logger. Call once, early in `main.ts`, before
 * anything else logs. Safe to call again when settings change.
 */
export function initLogger(options: LoggerOptions): Logger {
  activeLevel = options.level ?? defaultLevel();
  sink = createElectronLogSink(options) ?? createConsoleSink(activeLevel);
  sink.setLevel(activeLevel);
  initialized = true;
  return makeLogger('');
}

/**
 * A logger for a subsystem. Works before {@link initLogger} (console only), so
 * import order never matters.
 */
export function getLogger(scope = ''): Logger {
  return makeLogger(scope);
}

export function setLogLevel(level: LogLevel): void {
  activeLevel = level;
  sink.setLevel(level);
}

export function getLogLevel(): LogLevel {
  return activeLevel;
}

/** Absolute path of the current log file, or null when console-only. */
export function logFilePath(): string | null {
  return sink.filePath();
}

/** True once {@link initLogger} has run. */
export function isLoggerInitialized(): boolean {
  return initialized;
}

/** Convenience for callers that only have a workspace root. */
export function initLoggerForWorkspace(
  workspaceRoot: string,
  options: Omit<LoggerOptions, 'logsDir'> = {},
): Logger {
  return initLogger({
    ...options,
    logsDir: path.join(workspaceRoot, LOGS_DIRNAME),
  });
}
