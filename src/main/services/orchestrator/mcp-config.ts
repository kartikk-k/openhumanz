/**
 * The per-invocation MCP config.
 *
 * Written into a fresh 0700 temp directory, handed to the CLI with
 * `--mcp-config <file> --strict-mcp-config`, and deleted when the step ends.
 *
 * **Never write to the user's global or project CLI config.** Mutating
 * `~/.claude.json` or a project `.mcp.json` would leave our server registered
 * for every unrelated thing the user does with the CLI afterwards, pointed at a
 * socket and a token that die with this launch.
 *
 * The file is 0600 because the server entry carries the per-launch token in its
 * environment, and `tmp/` is inside the workspace where other things look.
 */
import nodePath from 'node:path';
import { createTempDir, PRIVATE_FILE_MODE } from '../../infra/paths';
import type { WorkspacePaths } from '../../infra/paths';
import { removeDir, writeJsonFileAtomic } from '../../infra/files';
import type { McpStepScope } from './types';

/** `.mcp.json`'s shape: one entry per server under `mcpServers`. */
export interface McpConfigFile {
  mcpServers: Record<
    string,
    { command: string; args: string[]; env?: Record<string, string> }
  >;
}

export interface WrittenMcpConfig {
  /** Pass to `--mcp-config`. */
  path: string;
  dir: string;
  /** Idempotent; safe in a `finally`. */
  cleanup(): Promise<void>;
}

export function buildMcpConfig(scope: McpStepScope): McpConfigFile {
  return {
    mcpServers: {
      [scope.serverName]: {
        command: scope.server.command,
        args: [...scope.server.args],
        ...(scope.server.env ? { env: { ...scope.server.env } } : {}),
      },
    },
  };
}

export async function writeMcpConfig(
  paths: WorkspacePaths,
  scope: McpStepScope,
): Promise<WrittenMcpConfig> {
  const dir = await createTempDir(paths, 'mcp-');
  const path = nodePath.join(dir, 'mcp.json');
  await writeJsonFileAtomic(path, buildMcpConfig(scope), {
    mode: PRIVATE_FILE_MODE,
  });

  let removed = false;
  return {
    path,
    dir,
    async cleanup() {
      if (removed) return;
      removed = true;
      await removeDir(dir);
    },
  };
}
