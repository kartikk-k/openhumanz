/**
 * Per-invocation MCP config generation.
 *
 * The CLI is pointed at a config file we write into a private temp directory
 * and delete when the run ends. We **never** touch the user's global
 * (`~/.claude.json`) or project (`.mcp.json`) MCP registry: this app is a
 * guest on the user's machine, and a crash must not leave a socket path
 * pointing at a dead server in a file they did not ask us to edit.
 *
 * Pair it with `--strict-mcp-config` so the step also cannot pick up whatever
 * else the user has configured.
 *
 * ### The server-entry schema is verified, not assumed
 *
 * `docs/API-NOTES.md` §8 flagged it UNVERIFIED. Confirmed against
 * `claude mcp add-json <name> <json> -s project` (2.1.224), which wrote:
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "assistant": {
 *       "type": "stdio",
 *       "command": "/path/to/electron",
 *       "args": ["/path/to/shim.js"],
 *       "env": { "ASSISTANT_MCP_SOCKET": "…" }
 *     }
 *   }
 * }
 * ```
 *
 * `type` is optional (an entry without it was accepted and stored verbatim as a
 * stdio server); we emit it anyway because explicit beats inferred.
 */
import path from 'node:path';
import fsp from 'node:fs/promises';
import { writeFileAtomic } from '../../infra/files';
import { createTempDir, PRIVATE_FILE_MODE } from '../../infra/paths';
import type { WorkspacePaths } from '../../infra/paths';
import { electronNodeEnv, shimPath } from '../../infra/spawn';

/** The name the CLI knows our server by. Appears in every tool id. */
export const DEFAULT_MCP_SERVER_NAME = 'assistant';

export interface McpServerEntry {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface McpConfigDocument {
  mcpServers: Record<string, McpServerEntry>;
}

export interface McpConfigInput {
  /** Absolute path to the unix socket. */
  socketPath: string;
  /** Per-launch token. Ends up in a 0600 file; never log it. */
  token: string;
  /** Which step this invocation is. Scopes the tool list server-side. */
  stepId: string;
  /** Default `assistant`. */
  serverName?: string;
  /** Default `shimPath()` — `shim.js` next to the main bundle. */
  shim?: string;
  /**
   * Default `process.execPath`. End users have no `node`; the shim runs through
   * Electron with `ELECTRON_RUN_AS_NODE=1`, which is what {@link electronNodeEnv}
   * puts in the entry's `env`.
   */
  execPath?: string;
  /** Extra environment for the shim process. Merged under ours. */
  extraEnv?: Record<string, string>;
}

/**
 * Sanitise a server name into what the CLI will accept in a tool id.
 * `mcp__<server>__<tool>` has to survive being pasted into an allowlist.
 */
export function normalizeServerName(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-');
  return cleaned.replace(/^-+|-+$/g, '') || DEFAULT_MCP_SERVER_NAME;
}

/**
 * The tool id the CLI exposes for one of our tools.
 *
 * Convention, not read out of the CLI binary: Claude Code namespaces MCP tools
 * as `mcp__<server>__<tool>`. Used for `--allowedTools`, which is the *other*
 * gate — the server enforces the same list independently, so a naming drift
 * here loosens the CLI-side allowlist but cannot widen what a step can reach.
 */
export function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${normalizeServerName(serverName)}__${toolName}`;
}

export function mcpToolNames(
  serverName: string,
  toolNames: readonly string[],
): string[] {
  return toolNames.map((name) => mcpToolName(serverName, name));
}

/** `mcp__<server>` — every tool on the server, for the CLI allowlist. */
export function mcpServerWildcard(serverName: string): string {
  return `mcp__${normalizeServerName(serverName)}`;
}

/** Build the document without touching disk. Exported for tests. */
export function buildMcpConfigDocument(
  input: McpConfigInput,
): McpConfigDocument {
  const serverName = normalizeServerName(
    input.serverName ?? DEFAULT_MCP_SERVER_NAME,
  );
  const command = input.execPath ?? process.execPath;
  const shim = input.shim ?? shimPath();

  // `electronNodeEnv` supplies ELECTRON_RUN_AS_NODE=1 — without it, handing a
  // script to the Electron binary opens a window instead of running node.
  const env: Record<string, string> = {};
  const merged = electronNodeEnv({
    ...input.extraEnv,
    ASSISTANT_MCP_SOCKET: input.socketPath,
    ASSISTANT_MCP_TOKEN: input.token,
    ASSISTANT_MCP_STEP_ID: input.stepId,
  });
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined) env[key] = value;
  }

  return {
    mcpServers: {
      [serverName]: { type: 'stdio', command, args: [shim], env },
    },
  };
}

export interface McpConfigHandle {
  /** Pass to `claude --mcp-config <file> --strict-mcp-config`. */
  readonly path: string;
  /** The temp directory holding it. Removed by {@link McpConfigHandle.cleanup}. */
  readonly dir: string;
  readonly serverName: string;
  /** `mcp__<server>__<tool>` ids, for `--allowedTools`. */
  toolIds(toolNames: readonly string[]): string[];
  /** Remove the directory. Idempotent, never throws. */
  cleanup(): Promise<void>;
}

export interface WriteMcpConfigOptions extends McpConfigInput {
  /** Where the temp dir is created. Normally the workspace `tmp/`. */
  paths: WorkspacePaths;
  /** Use this directory instead of creating one. Then cleanup only unlinks the file. */
  dir?: string;
  /** Default `mcp.json`. */
  fileName?: string;
}

/**
 * Write the config into a fresh private directory and hand back a handle that
 * knows how to delete it. It holds the token, so it is 0600 inside a 0700
 * directory — the same treatment the token file itself gets.
 */
export async function writeMcpConfigFile(
  options: WriteMcpConfigOptions,
): Promise<McpConfigHandle> {
  const { paths, fileName = 'mcp.json' } = options;
  const ownsDir = options.dir === undefined;
  const dir = options.dir ?? (await createTempDir(paths, 'mcp-'));
  const file = path.join(dir, fileName);
  const serverName = normalizeServerName(
    options.serverName ?? DEFAULT_MCP_SERVER_NAME,
  );

  const document = buildMcpConfigDocument({ ...options, serverName });
  await writeFileAtomic(file, `${JSON.stringify(document, null, 2)}\n`, {
    mode: PRIVATE_FILE_MODE,
  });

  let cleaned = false;
  return {
    path: file,
    dir,
    serverName,
    toolIds: (toolNames) => mcpToolNames(serverName, toolNames),
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      try {
        if (ownsDir) await fsp.rm(dir, { recursive: true, force: true });
        else await fsp.rm(file, { force: true });
      } catch {
        /* the config is disposable; a failed unlink must not fail a run */
      }
    },
  };
}

/**
 * Run `fn` with a config file, deleting it afterwards whatever happens. This is
 * the shape the orchestrator should use — a `finally` that gets skipped leaves
 * a token on disk.
 */
export async function withMcpConfigFile<T>(
  options: WriteMcpConfigOptions,
  fn: (config: McpConfigHandle) => Promise<T>,
): Promise<T> {
  const handle = await writeMcpConfigFile(options);
  try {
    return await fn(handle);
  } finally {
    await handle.cleanup();
  }
}
