/**
 * MCP shim.
 *
 * The agent CLI spawns this as an MCP stdio server. It does not implement MCP:
 * it opens the app's unix domain socket, proves who it is with a one-line
 * handshake, and then relays bytes in both directions until either side hangs
 * up. The app's MCP server is the thing on the other end.
 *
 * Why a shim exists at all: the CLI only speaks stdio to a child process, and
 * we will not expose a TCP port — a loopback port is reachable by every process
 * on the machine and by browser tabs via DNS rebinding, and this server exposes
 * mail and filesystem operations. So the socket stays a unix socket and this
 * 150-line process bridges the gap.
 *
 * It is spawned through Electron in Node mode (`process.execPath` with
 * `ELECTRON_RUN_AS_NODE=1`) because end users have no `node` on PATH. That is
 * why it builds as its own CommonJS bundle rather than being part of the main
 * bundle: it has to be a file that can be handed to a node binary.
 *
 * Rules it lives by:
 *  - **Nothing but JSON-RPC on stdout.** Every diagnostic goes to stderr.
 *  - **Dependency-light.** `node:net` and the process streams, nothing else.
 *  - **Loud and non-zero on any failure.** A shim that exits 0 after failing to
 *    connect looks to the CLI like a server with no tools, and the run silently
 *    does the wrong thing.
 *
 * The handshake constants are mirrored in
 * `src/main/services/mcp/protocol.ts`. `.eslintrc.js` forbids this file from
 * importing anything under `src/main/`, deliberately: the shim is standalone.
 * Change the two copies together.
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

/** Handshake version. Must match `HANDSHAKE_VERSION` on the server. */
export const HANDSHAKE_VERSION = 1;

/** Give up if the app has not acknowledged the handshake in this long. */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

/** An ack line longer than this is not an ack. */
export const HANDSHAKE_MAX_BYTES = 4096;

/**
 * Exit codes. Distinct on purpose: the orchestrator reads them out of the run's
 * stderr log when a step comes back with no tools.
 */
export const EXIT = {
  ok: 0,
  /** Something threw that we did not classify. */
  failed: 1,
  /** Environment missing or incomplete. */
  misconfigured: 2,
  /** Could not reach the socket. */
  unreachable: 3,
  /** The app never answered the handshake. */
  timeout: 4,
  /** The app refused this connection. */
  refused: 5,
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
    v: HANDSHAKE_VERSION,
    stepId: config.stepId,
    token: config.token,
  })}\n`;
}

/* ------------------------------------------------------------------ */
/* Relay                                                               */
/* ------------------------------------------------------------------ */

export interface ShimStreams {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

function defaultStreams(): ShimStreams {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

/**
 * Connect, handshake, relay. Resolves with the process exit code; never
 * rejects, because a rejected promise at the top level of a helper turns into
 * an unhandled rejection warning on stdout in some Node builds and stdout is
 * the protocol.
 */
export function runShim(
  config: ShimConfig,
  streams: ShimStreams = defaultStreams(),
): Promise<number> {
  return new Promise<number>((resolve) => {
    const { stdin, stdout, stderr } = streams;
    let settled = false;
    let relaying = false;
    let pending: Buffer = Buffer.alloc(0);

    const socket = net.createConnection({ path: config.socketPath });
    socket.setNoDelay(true);

    const timer = setTimeout(() => {
      finish(EXIT.timeout, 'timed out waiting for the assistant to answer');
    }, HANDSHAKE_TIMEOUT_MS);
    timer.unref?.();

    function finish(code: number, message?: string): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (message) stderr.write(`assistant-shim: ${message}\n`);
      try {
        stdin.unpipe(socket);
        stdin.pause();
      } catch {
        /* the process is going away anyway */
      }
      socket.destroy();
      resolve(code);
    }

    const onData = (chunk: Buffer): void => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      const newline = pending.indexOf(0x0a);
      if (newline === -1) {
        if (pending.length > HANDSHAKE_MAX_BYTES) {
          finish(EXIT.refused, 'the assistant sent a malformed greeting');
        }
        return;
      }

      const line = pending.subarray(0, newline).toString('utf8');
      const rest = pending.subarray(newline + 1);
      pending = Buffer.alloc(0);

      let ack: unknown;
      try {
        ack = JSON.parse(line);
      } catch {
        finish(EXIT.refused, 'the assistant sent a malformed greeting');
        return;
      }
      if (
        !ack ||
        typeof ack !== 'object' ||
        (ack as { ok?: unknown }).ok !== true
      ) {
        finish(EXIT.refused, 'the assistant refused this connection');
        return;
      }

      clearTimeout(timer);
      relaying = true;

      // Pause before swapping listeners so nothing arrives in the gap between
      // removing ours and pipe() installing its own.
      socket.pause();
      socket.off('data', onData);
      if (rest.length > 0) stdout.write(rest);

      // `end: false` — the CLI's stdout is not ours to close; the process
      // exiting flushes it.
      socket.pipe(stdout, { end: false });
      stdin.pipe(socket);
      socket.resume();
    };

    socket.on('data', onData);

    socket.on('error', (error: NodeJS.ErrnoException) => {
      const detail =
        error.code === 'ENOENT'
          ? `no assistant listening at ${config.socketPath}`
          : `socket error: ${error.message}`;
      finish(relaying ? EXIT.failed : EXIT.unreachable, detail);
    });

    socket.on('connect', () => {
      socket.write(handshakeFrame(config));
    });

    socket.on('close', () => {
      if (relaying) finish(EXIT.ok);
      else finish(EXIT.refused, 'the assistant closed the connection');
    });

    stdin.on('end', () => {
      // The CLI is done with us. Half-close so the server sees EOF and can
      // finish anything in flight before the socket goes away.
      socket.end();
    });
    stdin.on('error', () => {
      finish(EXIT.failed, 'stdin closed unexpectedly');
    });
  });
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export async function main(): Promise<number> {
  const config = readShimConfig();
  if (!config) {
    process.stderr.write(
      'assistant-shim: missing configuration; expected ' +
        `${SHIM_ENV.socketPath}, ${SHIM_ENV.token} and ${SHIM_ENV.stepId} in the environment.\n`,
    );
    return EXIT.misconfigured;
  }
  return runShim(config);
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
      process.exitCode = EXIT.failed;
    });
}
