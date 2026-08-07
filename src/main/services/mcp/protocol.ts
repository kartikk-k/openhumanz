/**
 * The wire contract between the app and the MCP shim.
 *
 * Two frames, both newline-delimited JSON, both sent before any MCP traffic:
 *
 * ```
 * shim  -> app   {"v":1,"stepId":"step_…","token":"…"}
 * app   -> shim  {"v":1,"ok":true,"server":"assistant","tools":7}
 * ```
 *
 * After the ack the socket carries nothing but MCP JSON-RPC, framed exactly the
 * way the SDK's `shared/stdio.js` frames it (NDJSON, no Content-Length), so the
 * shim can relay bytes without understanding them.
 *
 * A rejected handshake gets **no reply at all** — the socket is destroyed. An
 * error body would tell an unauthorised caller whether it got the token wrong,
 * the step id wrong, or found a server at all.
 *
 * ## Why these constants are duplicated in `src/shim/index.ts`
 *
 * The shim is spawned as its own process and bundled separately; `.eslintrc.js`
 * forbids it from importing anything under `src/main/`. `src/shared/` would be
 * the natural home, but the shim bundle is deliberately dependency-light and
 * these are four strings. Both copies are the contract; change them together.
 */

/** Handshake version. Bump when the frame shape changes incompatibly. */
export const HANDSHAKE_VERSION = 1;

/** Socket file inside `<workspace>/runtime/`. Never a TCP port. */
export const SOCKET_FILENAME = 'mcp.sock';

/** Token file inside `<workspace>/runtime/`, written 0600. */
export const TOKEN_FILENAME = 'mcp-token';

/**
 * Environment the app puts in the generated MCP config so the CLI passes it to
 * the shim it spawns. Mirrored by `SHIM_ENV` in `src/shim/index.ts`.
 */
export const SHIM_ENV = {
  /** Absolute path to the unix domain socket. */
  socketPath: 'ASSISTANT_MCP_SOCKET',
  /** Per-launch token, compared with `timingSafeEqual` and never logged. */
  token: 'ASSISTANT_MCP_TOKEN',
  /** Which step this connection belongs to; scopes the tool list. */
  stepId: 'ASSISTANT_MCP_STEP_ID',
} as const;

/**
 * A handshake line longer than this is not a handshake. Bounded so a client
 * that connects and streams garbage cannot grow our buffer.
 */
export const HANDSHAKE_MAX_BYTES = 4096;

/** How long a connection may take to produce its handshake line. */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Longest socket path we will try to bind. `sockaddr_un.sun_path` is 104 bytes
 * on macOS and 108 on Linux; over that, `listen()` fails with EINVAL/ENAMETOOLONG
 * and the server falls back to a short private directory.
 */
export const MAX_SOCKET_PATH_LENGTH = 96;

export interface HandshakeFrame {
  v: number;
  stepId: string;
  token: string;
}

export interface HandshakeAck {
  v: number;
  ok: true;
  /** Server name, for the shim's error messages. Not secret. */
  server: string;
  /** How many tools this connection is scoped to. Diagnostics only. */
  tools: number;
}

/** Serialise the handshake frame the shim sends first. */
export function serializeHandshake(frame: HandshakeFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/**
 * Parse and structurally validate a handshake line. Returns null for anything
 * that is not a well-formed frame — the caller destroys the socket either way,
 * so there is nothing to distinguish.
 */
export function parseHandshakeFrame(line: string): HandshakeFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  if (frame.v !== HANDSHAKE_VERSION) return null;
  if (typeof frame.stepId !== 'string' || frame.stepId.length === 0) {
    return null;
  }
  if (typeof frame.token !== 'string' || frame.token.length === 0) return null;
  return { v: frame.v, stepId: frame.stepId, token: frame.token };
}

export function serializeAck(ack: HandshakeAck): string {
  return `${JSON.stringify(ack)}\n`;
}

/** Parse the ack. Returns null unless it is a well-formed `ok: true` frame. */
export function parseAck(line: string): HandshakeAck | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const ack = value as Record<string, unknown>;
  if (ack.ok !== true || typeof ack.v !== 'number') return null;
  return {
    v: ack.v,
    ok: true,
    server: typeof ack.server === 'string' ? ack.server : 'assistant',
    tools: typeof ack.tools === 'number' ? ack.tools : 0,
  };
}
