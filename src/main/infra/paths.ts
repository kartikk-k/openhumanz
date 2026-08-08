/**
 * Workspace layout.
 *
 * ```
 * ~/.assistant/
 *   assistant.db          sql.js database, persisted on a debounce
 *   settings.json         user settings
 *   memory/               *.md — the memory vault, human-editable
 *   runs/<runId>/         transcript.jsonl, stderr.log
 *   logs/
 *   runtime/              socket + token, 0700, cleared on launch
 *   tmp/                  per-invocation MCP configs, deleted after use
 * ```
 *
 * Nothing here imports electron: paths must resolve identically in the main
 * process, in a helper spawned through `ELECTRON_RUN_AS_NODE`, and in a test
 * script run with bun.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Environment override for the workspace root. Wins over the settings value. */
export const WORKSPACE_ENV_VAR = 'ASSISTANT_HOME';

/** Directory name under the user's home when nothing overrides it. */
export const DEFAULT_WORKSPACE_DIRNAME = '.assistant';

export const DB_FILENAME = 'assistant.db';
export const SETTINGS_FILENAME = 'settings.json';
export const ONBOARDING_FILENAME = 'onboarding.json';
export const MEMORY_DIRNAME = 'memory';
export const RUNS_DIRNAME = 'runs';
/**
 * Where the Chat feature runs its Claude Code sessions (as their cwd). Kept
 * separate from real project folders so the chat history is self-contained and
 * never mixed with the user's other `claude` sessions.
 */
export const CLAUDE_CHATS_DIRNAME = 'claude-chats';
export const LOGS_DIRNAME = 'logs';
export const RUNTIME_DIRNAME = 'runtime';
export const TMP_DIRNAME = 'tmp';

/** Mode for directories that hold secrets (`runtime/`). */
export const PRIVATE_DIR_MODE = 0o700;
/** Mode for files that hold secrets (socket, token). */
export const PRIVATE_FILE_MODE = 0o600;

/**
 * Absolute paths for one workspace. Immutable; build a new one if the root
 * changes (it only changes via settings, which requires a restart).
 */
export interface WorkspacePaths {
  /** Workspace root, e.g. `/Users/x/.assistant`. */
  readonly root: string;
  readonly dbFile: string;
  readonly settingsFile: string;
  readonly onboardingFile: string;
  readonly memoryDir: string;
  readonly runsDir: string;
  /** `claude-chats/` — cwd for the Chat feature's Claude Code sessions. */
  readonly claudeChatsDir: string;
  readonly logsDir: string;
  readonly runtimeDir: string;
  readonly tmpDir: string;
  /** `runs/<runId>/`. */
  runDir(runId: string): string;
  /** `runs/<runId>/transcript.jsonl`. */
  runTranscriptFile(runId: string): string;
  /** `runs/<runId>/stderr.log`. stderr is a log, never control flow. */
  runStderrFile(runId: string): string;
  /** Any path under the workspace root. Rejects traversal outside it. */
  resolve(...segments: string[]): string;
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith(`~${path.sep}`) || input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

/** True when `child` is `parent` or lives underneath it. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** `~/.assistant`, with no overrides considered. */
export function defaultWorkspaceRoot(): string {
  return path.join(os.homedir(), DEFAULT_WORKSPACE_DIRNAME);
}

/**
 * Resolve the workspace root.
 *
 * Precedence: `ASSISTANT_HOME` env var, then the caller's override (normally
 * `settings.workspaceRoot`), then `~/.assistant`. Empty strings are ignored so
 * a settings file with `workspaceRoot: ''` means "use the default".
 */
export function resolveWorkspaceRoot(override?: string | null): string {
  const fromEnv = process.env[WORKSPACE_ENV_VAR];
  const candidate =
    (fromEnv && fromEnv.trim()) || (override && override.trim()) || '';
  if (!candidate) return defaultWorkspaceRoot();
  return path.resolve(expandHome(candidate));
}

/** Build the path table for a workspace root. Touches no disk. */
export function createWorkspacePaths(override?: string | null): WorkspacePaths {
  const root = resolveWorkspaceRoot(override);
  const runsDir = path.join(root, RUNS_DIRNAME);

  const resolveWithin = (...segments: string[]): string => {
    const target = path.resolve(root, ...segments);
    if (!isInside(root, target)) {
      throw new Error(
        `Refusing to resolve a path outside the workspace: ${target}`,
      );
    }
    return target;
  };

  return {
    root,
    dbFile: path.join(root, DB_FILENAME),
    settingsFile: path.join(root, SETTINGS_FILENAME),
    onboardingFile: path.join(root, ONBOARDING_FILENAME),
    memoryDir: path.join(root, MEMORY_DIRNAME),
    runsDir,
    claudeChatsDir: path.join(root, CLAUDE_CHATS_DIRNAME),
    logsDir: path.join(root, LOGS_DIRNAME),
    runtimeDir: path.join(root, RUNTIME_DIRNAME),
    tmpDir: path.join(root, TMP_DIRNAME),
    runDir: (runId: string) => path.join(runsDir, safeSegment(runId)),
    runTranscriptFile: (runId: string) =>
      path.join(runsDir, safeSegment(runId), 'transcript.jsonl'),
    runStderrFile: (runId: string) =>
      path.join(runsDir, safeSegment(runId), 'stderr.log'),
    resolve: resolveWithin,
  };
}

/**
 * Reject anything that could escape the runs directory. Run ids come from our
 * own id generator, but they also arrive over IPC and MCP.
 */
function safeSegment(segment: string): string {
  if (!segment || segment === '.' || segment === '..') {
    throw new Error(`Invalid path segment: ${JSON.stringify(segment)}`);
  }
  if (
    segment.includes('/') ||
    segment.includes('\\') ||
    segment.includes('\0')
  ) {
    throw new Error(`Invalid path segment: ${JSON.stringify(segment)}`);
  }
  return segment;
}

/** `mkdir -p`, returning the directory. Safe to call repeatedly. */
export async function ensureDir(dir: string, mode?: number): Promise<string> {
  await fsp.mkdir(dir, { recursive: true, mode });
  if (mode !== undefined) {
    // mkdir's mode is masked by the process umask; chmod is not.
    await fsp.chmod(dir, mode).catch(() => undefined);
  }
  return dir;
}

/** Synchronous {@link ensureDir}, for constructor-time use. */
export function ensureDirSync(dir: string, mode?: number): string {
  fs.mkdirSync(dir, { recursive: true, mode });
  if (mode !== undefined) {
    try {
      fs.chmodSync(dir, mode);
    } catch {
      /* best effort */
    }
  }
  return dir;
}

/**
 * Create every workspace directory. `runtime/` is created 0700 and emptied,
 * because it holds the per-launch MCP socket and token and a stale socket file
 * blocks the next bind.
 */
export async function ensureWorkspace(paths: WorkspacePaths): Promise<void> {
  await ensureDir(paths.root);
  await Promise.all([
    ensureDir(paths.memoryDir),
    ensureDir(paths.runsDir),
    ensureDir(paths.claudeChatsDir),
    ensureDir(paths.logsDir),
    ensureDir(paths.tmpDir),
  ]);
  await ensureDir(paths.runtimeDir, PRIVATE_DIR_MODE);
  await clearDirectory(paths.runtimeDir);
}

/** Remove every entry inside `dir` without removing `dir` itself. */
export async function clearDirectory(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    entries.map((entry) =>
      fsp.rm(path.join(dir, entry), { recursive: true, force: true }),
    ),
  );
}

/** `runs/<runId>/`, created on demand. */
export async function ensureRunDir(
  paths: WorkspacePaths,
  runId: string,
): Promise<string> {
  return ensureDir(paths.runDir(runId));
}

/**
 * A fresh, private temp directory under `tmp/`, for the per-invocation MCP
 * config. Callers are expected to remove it when the invocation ends.
 */
export async function createTempDir(
  paths: WorkspacePaths,
  prefix = 'mcp-',
): Promise<string> {
  await ensureDir(paths.tmpDir, PRIVATE_DIR_MODE);
  const dir = await fsp.mkdtemp(path.join(paths.tmpDir, prefix));
  await fsp.chmod(dir, PRIVATE_DIR_MODE).catch(() => undefined);
  return dir;
}

/**
 * Process-wide workspace paths. Set once at startup with
 * {@link setWorkspacePaths}; modules receive their copy through `ctx.paths` and
 * should prefer that over reaching for this.
 */
let current: WorkspacePaths | null = null;

export function setWorkspacePaths(paths: WorkspacePaths): WorkspacePaths {
  current = paths;
  return paths;
}

/** The workspace set at startup, or one built from env/defaults on first use. */
export function getWorkspacePaths(): WorkspacePaths {
  if (!current) current = createWorkspacePaths();
  return current;
}
