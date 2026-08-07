/**
 * MCP shim — PLACEHOLDER.
 *
 * The agent CLI spawns this as an MCP server over stdio; it relays stdio to the
 * app's unix domain socket in `<workspace>/runtime/`, handshaking with a step
 * id so the server can scope that connection's tool list independently of
 * whatever allowlist the CLI was given.
 *
 * It is spawned through Electron in Node mode (`process.execPath` with
 * `ELECTRON_RUN_AS_NODE=1`), because end users have no `node` on PATH. That is
 * why this builds as its own CommonJS bundle rather than being part of the main
 * bundle: it has to be a file that can be handed to a node binary.
 *
 * Another agent implements the relay. This file exists so the build, the spawn
 * path and the environment contract are real and testable now. Everything below
 * the contract block is a stub.
 */
import net from 'node:net';

/** Environment the app sets when it spawns the shim. */
export const SHIM_ENV = {
  /** Absolute path to the unix domain socket. Never a TCP port. */
  socketPath: 'ASSISTANT_MCP_SOCKET',
  /** Per-launch token, compared with `timingSafeEqual` and never logged. */
  token: 'ASSISTANT_MCP_TOKEN',
  /** Which step this connection belongs to; scopes the tool list. */
  stepId: 'ASSISTANT_MCP_STEP_ID',
} as const;

export interface ShimConfig {
  socketPath: string;
  token: string;
  stepId: string;
}

/** Read the shim's configuration from the environment. */
export function readShimConfig(
  env: NodeJS.ProcessEnv = process.env,
): ShimConfig | null {
  const socketPath = env[SHIM_ENV.socketPath];
  const token = env[SHIM_ENV.token];
  const stepId = env[SHIM_ENV.stepId];
  if (!socketPath || !token || !stepId) return null;
  return { socketPath, token, stepId };
}

/**
 * The handshake frame sent as the first line on the socket. Newline-delimited
 * JSON, so the server can read it before switching to MCP framing.
 */
export function handshakeFrame(config: ShimConfig): string {
  return `${JSON.stringify({
    v: 1,
    stepId: config.stepId,
    token: config.token,
  })}\n`;
}

/* ------------------------------------------------------------------ */
/* Stub entry point                                                    */
/* ------------------------------------------------------------------ */

async function main(): Promise<number> {
  const config = readShimConfig();
  if (!config) {
    process.stderr.write(
      'assistant-shim: missing configuration; expected ' +
        `${SHIM_ENV.socketPath}, ${SHIM_ENV.token} and ${SHIM_ENV.stepId} in the environment.\n`,
    );
    return 2;
  }

  // Relay implementation lands here. Proving the socket type is wired is
  // enough for now; `net` stays imported so the bundle target is exercised.
  void net;
  process.stderr.write('assistant-shim: relay not implemented yet.\n');
  return 0;
}

// `require.main === module` is false when this file is imported by a test.
if (typeof require !== 'undefined' && require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
      return code;
    })
    .catch((cause: unknown) => {
      process.stderr.write(
        `assistant-shim: ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
      process.exitCode = 1;
    });
}
