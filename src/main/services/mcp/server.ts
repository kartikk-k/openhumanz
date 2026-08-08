/**
 * The MCP server.
 *
 * This is the security seam of the product. A tool call physically terminates
 * inside this process, so the approval gate is unbypassable — the agent cannot
 * route around a check that lives on the other side of the protocol.
 *
 * Shape:
 *
 * ```
 *  claude CLI ──spawns──▶ shim (stdio) ──unix socket──▶ this server
 *                                                        │
 *                                                        ├─ token check
 *                                                        ├─ step scope
 *                                                        ├─ approval gate
 *                                                        └─ registry.invokeTool
 * ```
 *
 * Decisions worth knowing about:
 *
 * - **Unix domain socket, 0600, in `runtime/`. Never a TCP port.** A loopback
 *   port is reachable by every process on the machine and by browser tabs via
 *   DNS rebinding, and this server exposes mail and filesystem operations.
 * - **One MCP `Server` instance per connection.** Each shim connection is a
 *   session with its own scoped tool list; sharing one instance would mean the
 *   tool list depends on who asked last.
 * - **Low-level `Server`, not `McpServer`.** `McpServer.registerTool` builds
 *   the JSON Schema itself and we cannot make it use
 *   `z.toJSONSchema(schema, { io: 'input' })`; with `io: 'output'` every
 *   defaulted field is reported as required. Raw handlers also make the
 *   per-connection tool scoping a filter rather than a registration dance.
 * - **Errors are in-band** (`isError: true`), never thrown: an out-of-scope
 *   tool call is a result the model can read and correct, not a crash.
 */
import net from 'node:net';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { randomId, randomToken, timingSafeCompare } from '../../infra/crypto';
import { writeFileAtomic } from '../../infra/files';
import { getLogger } from '../../infra/logger';
import type { Logger } from '../../infra/logger';
import {
  ensureDir,
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
} from '../../infra/paths';
import type { WorkspacePaths } from '../../infra/paths';
import type { AnyToolDefinition, ToolCallContext } from '../../modules/types';
import { parseToolInput } from '../../modules/types';
import {
  allowAllApprovalGate,
  isDeniedResult,
  isPendingResult,
} from './approvals';
import type { ApprovalGate, ApprovalGateContext } from './approvals';
import {
  DEFAULT_MCP_SERVER_NAME,
  writeMcpConfigFile,
  normalizeServerName,
} from './config';
import type { McpConfigHandle } from './config';
import {
  HANDSHAKE_MAX_BYTES,
  HANDSHAKE_TIMEOUT_MS,
  HANDSHAKE_VERSION,
  MAX_SOCKET_PATH_LENGTH,
  parseHandshakeFrame,
  serializeAck,
  SHIM_ENV,
  SOCKET_FILENAME,
  TOKEN_FILENAME,
} from './protocol';
import { createStepScopeRegistry } from './steps';
import type { RegisteredStep, StepRegistrationInput, StepScope } from './steps';
import { UnixSocketTransport } from './transport';
import {
  assertNoForbiddenTools,
  compactToolResult,
  describeInputError,
  describeTool,
  errorResult,
  pendingApprovalResult,
  textResult,
} from './tools';
import type { ToolCallResult } from './tools';

/**
 * What the server needs from the module registry. Narrow on purpose:
 * `ModuleRegistry` satisfies it structurally, and a test can pass three
 * functions.
 */
export interface McpToolSource {
  tools(): AnyToolDefinition[];
  tool(name: string): AnyToolDefinition | undefined;
  invokeTool(
    name: string,
    input: unknown,
    ctx?: Partial<ToolCallContext>,
  ): Promise<unknown>;
}

export interface McpSocketServerOptions {
  paths: WorkspacePaths;
  tools: McpToolSource;
  logger?: Logger;
  /**
   * Injected by the approvals module. Defaults to allow-all, which is correct
   * for tests and wrong in production — start() warns when it is holding the
   * default and any registered tool is side-effecting.
   */
  approvals?: ApprovalGate;
  /** Name the CLI knows us by. Default `assistant`. */
  serverName?: string;
  serverVersion?: string;
  /** Override the socket path. Default `<workspace>/runtime/mcp.sock`. */
  socketPath?: string;
  /** Compaction caps for tool results. */
  maxResultItems?: number;
  maxResultChars?: number;
  /**
   * Ask the gate about read-only tools too. Default false: ARCHITECTURE routes
   * `sideEffecting` calls through the gate, and gating reads is how you get a
   * user who quits at the fortieth approval.
   */
  consultGateForReadOnlyTools?: boolean;
}

export interface McpSocketServerStatus {
  running: boolean;
  socketPath: string;
  connections: number;
  registeredSteps: number;
  toolCount: number;
}

export interface McpSocketServer {
  readonly socketPath: string;
  readonly tokenFile: string;
  readonly serverName: string;
  /** True between a resolved `start()` and `stop()`. */
  readonly running: boolean;

  start(): Promise<void>;
  stop(): Promise<void>;

  /** Register a step's tool scope before spawning the CLI. */
  registerStep(input: StepRegistrationInput): RegisteredStep;
  /** Revoke it after. Returns false when it was already gone. */
  revokeStep(stepId: string): boolean;
  step(stepId: string): StepScope | undefined;

  /** Environment for the shim of an already-registered step. */
  stepEnv(stepId: string): Record<string, string>;
  /**
   * Write the per-invocation MCP config for a registered step. Caller must
   * `cleanup()` it when the run ends.
   */
  writeConfigForStep(
    stepId: string,
    options?: { serverName?: string; shim?: string; execPath?: string },
  ): Promise<McpConfigHandle>;

  /** Swap the approval gate in after construction, for late wiring in main.ts. */
  setApprovalGate(gate: ApprovalGate): void;

  status(): McpSocketServerStatus;
}

interface Session {
  readonly id: string;
  readonly stepId: string;
  readonly socket: net.Socket;
  readonly server: Server;
}

/**
 * How often to send a keep-alive progress notification while an interactive
 * approval is pending. Comfortably under the MCP client's default request
 * timeout (~60s), which resets on each progress notification.
 */
const APPROVAL_HEARTBEAT_MS = 20_000;

export function createMcpSocketServer(
  options: McpSocketServerOptions,
): McpSocketServer {
  const {
    paths,
    tools: source,
    serverVersion = '0.1.0',
    maxResultItems,
    maxResultChars,
    consultGateForReadOnlyTools = false,
  } = options;

  const logger = options.logger ?? getLogger('mcp');
  const serverName = normalizeServerName(
    options.serverName ?? DEFAULT_MCP_SERVER_NAME,
  );
  const steps = createStepScopeRegistry();
  const sessions = new Set<Session>();

  let approvals: ApprovalGate = options.approvals ?? allowAllApprovalGate;
  let usingDefaultGate = options.approvals === undefined;

  let socketPath =
    options.socketPath ?? path.join(paths.runtimeDir, SOCKET_FILENAME);
  let tokenFile = path.join(paths.runtimeDir, TOKEN_FILENAME);
  let token = '';
  let listener: net.Server | null = null;
  let running = false;
  /** Set when we had to bind outside the workspace because the path was long. */
  let fallbackDir: string | null = null;

  /* ---------------------------------------------------------------- */
  /* Tool calls                                                        */
  /* ---------------------------------------------------------------- */

  async function runToolCall(
    scope: StepScope,
    name: string,
    rawArgs: unknown,
    signal: AbortSignal | undefined,
    sessionLogger: Logger,
    /**
     * Sends a keep-alive to the CLI while an interactive approval is pending.
     * The MCP client resets its request timeout on progress, so heartbeating it
     * every ~20s lets a human take minutes to decide without the call reading as
     * a timeout (which is indistinguishable from a denial). Absent for runs.
     */
    heartbeat?: () => Promise<void>,
  ): Promise<ToolCallResult> {
    // Gate one: this step's scope, applied independently of whatever
    // --allowedTools the CLI was given.
    if (!scope.allowedTools.has(name)) {
      sessionLogger.warn('tool call outside step scope', {
        tool: name,
        stepId: scope.stepId,
      });
      return errorResult(
        `Tool "${name}" is not available in this step. Available: ${
          [...scope.allowedTools].sort().join(', ') || '(none)'
        }`,
      );
    }

    const tool = source.tool(name);
    if (!tool) {
      // Scope named a tool no module provides — a planning bug, not an attack.
      return errorResult(`Tool "${name}" is not registered.`);
    }

    let args: unknown;
    try {
      args = parseToolInput(tool, rawArgs ?? {});
    } catch (cause) {
      return errorResult(
        `Invalid arguments for "${name}": ${describeInputError(cause)}`,
      );
    }

    const toolCallId = randomId('call');

    // Gate two: approvals. Only side-effecting calls by default.
    if (tool.sideEffecting || consultGateForReadOnlyTools) {
      let summary: string | undefined;
      try {
        summary = tool.summarize?.(args);
      } catch {
        summary = undefined;
      }
      const gateCtx: ApprovalGateContext = {
        runId: scope.runId,
        stepId: scope.stepId,
        toolCallId,
        sideEffecting: tool.sideEffecting,
        summary,
        description: tool.description,
        signal,
      };

      let decision;
      try {
        decision = await approvals.check(name, args, gateCtx);
      } catch (cause) {
        // A broken gate must fail closed. Running the tool because the policy
        // engine threw is the one outcome we can never accept.
        sessionLogger.error('approval gate threw; refusing the call', {
          tool: name,
          error: cause instanceof Error ? cause.message : String(cause),
        });
        return errorResult(
          `Could not obtain approval for "${name}"; the call was not made.`,
        );
      }

      if (isPendingResult(decision)) {
        const canWait =
          scope.interactive && typeof approvals.waitForDecision === 'function';
        sessionLogger.info('tool call awaiting approval', {
          tool: name,
          stepId: scope.stepId,
          approvalId: decision.pending,
          waiting: canWait,
        });

        // Interactive (chat): hold the call open and continue in place once the
        // user decides. A heartbeat keeps the CLI's request from timing out
        // while a human takes their time.
        if (canWait) {
          let stopHeartbeat: (() => void) | undefined;
          if (heartbeat) {
            const timer = setInterval(() => {
              void heartbeat().catch(() => {
                /* client gone; the await below will settle via signal */
              });
            }, APPROVAL_HEARTBEAT_MS);
            timer.unref?.();
            stopHeartbeat = () => clearInterval(timer);
          }
          try {
            const outcome = await approvals.waitForDecision!(
              decision.pending,
              signal,
            );
            if (!outcome.approved) {
              sessionLogger.info('tool call denied (interactive)', {
                tool: name,
                stepId: scope.stepId,
              });
              return errorResult(
                `The user denied "${name}": ${
                  outcome.reason ?? 'declined'
                }. Do not retry it.`,
              );
            }
            // Approved — fall through to invoke the tool below.
          } catch (cause) {
            const message =
              cause instanceof Error ? cause.message : String(cause);
            sessionLogger.info('interactive approval wait ended', {
              tool: name,
              stepId: scope.stepId,
              reason: message,
            });
            return errorResult(
              `Approval for "${name}" did not complete (${message}); the call was not made.`,
            );
          } finally {
            stopHeartbeat?.();
          }
        } else {
          // Non-interactive (runs): return the handle immediately and let the
          // orchestrator re-dispatch once resolved.
          return pendingApprovalResult({
            approvalId: decision.pending,
            pollAfterMs: decision.pollAfterMs,
            message: decision.message,
          });
        }
      }
      if (isDeniedResult(decision)) {
        sessionLogger.info('tool call denied', {
          tool: name,
          stepId: scope.stepId,
        });
        return errorResult(
          `The user denied "${name}": ${decision.denied}. Do not retry it.`,
        );
      }
    }

    const startedAt = Date.now();
    try {
      const value = await source.invokeTool(name, args, {
        runId: scope.runId,
        stepId: scope.stepId,
        toolCallId,
        signal,
        logger: sessionLogger,
      });
      sessionLogger.debug('tool call ok', {
        tool: name,
        durationMs: Date.now() - startedAt,
      });
      return textResult(
        compactToolResult(value, {
          maxItems: maxResultItems,
          maxChars: maxResultChars,
        }),
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      sessionLogger.warn('tool call failed', { tool: name, error: message });
      return errorResult(`"${name}" failed: ${message}`);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Sessions                                                          */
  /* ---------------------------------------------------------------- */

  function createSessionServer(
    scope: StepScope,
    sessionLogger: Logger,
  ): Server {
    const mcp = new Server(
      { name: serverName, version: serverVersion },
      { capabilities: { tools: {} } },
    );

    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: source
        .tools()
        .filter((tool) => scope.allowedTools.has(tool.name))
        .map(describeTool),
    }));

    mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      // A progress token lets us heartbeat the client while an interactive
      // approval is pending. The SDK only routes progress when the client asked
      // for it (a token on the request); when absent, we simply don't heartbeat
      // and rely on the client's own timeout being generous.
      const progressToken = request.params._meta?.progressToken;
      const heartbeat =
        scope.interactive &&
        progressToken !== undefined &&
        extra?.sendNotification
          ? async () => {
              await extra.sendNotification({
                method: 'notifications/progress',
                params: {
                  progressToken,
                  progress: 0,
                  message: 'Waiting for your approval…',
                },
              });
            }
          : undefined;
      return runToolCall(
        scope,
        request.params.name,
        request.params.arguments,
        extra?.signal,
        sessionLogger,
        heartbeat,
      );
    });

    return mcp;
  }

  /**
   * Read the handshake line, then hand the socket to an MCP session.
   *
   * Every failure path is the same: destroy the socket with no reply. Telling a
   * caller *why* it was refused tells it whether it guessed the token, the step
   * id, or neither.
   */
  function handleConnection(socket: net.Socket): void {
    socket.setNoDelay(true);

    let buffer: Buffer = Buffer.alloc(0);
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
      }
    }, HANDSHAKE_TIMEOUT_MS);
    timer.unref?.();

    const refuse = (reason: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Category only. Never the token, never the caller's step id.
      logger.warn('mcp handshake refused', { reason });
      socket.destroy();
    };

    const onData = (chunk: Buffer): void => {
      if (settled) return;
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) {
        if (buffer.length > HANDSHAKE_MAX_BYTES) refuse('oversized handshake');
        return;
      }
      if (newline > HANDSHAKE_MAX_BYTES) {
        refuse('oversized handshake');
        return;
      }

      const line = buffer.subarray(0, newline).toString('utf8');
      const rest = buffer.subarray(newline + 1);
      buffer = Buffer.alloc(0);

      const frame = parseHandshakeFrame(line);
      if (!frame) {
        refuse('malformed handshake');
        return;
      }
      // Constant time, and before the step lookup, so neither the comparison
      // nor the lookup order leaks which half was wrong.
      const tokenOk = timingSafeCompare(frame.token, token);
      const scope = steps.get(frame.stepId);
      if (!tokenOk) {
        refuse('bad token');
        return;
      }
      if (!scope) {
        refuse('unknown step');
        return;
      }

      settled = true;
      clearTimeout(timer);
      socket.pause();
      socket.off('data', onData);

      void acceptSession(socket, scope, rest).catch((cause) => {
        logger.error('mcp session failed to start', {
          error: cause instanceof Error ? cause.message : String(cause),
        });
        socket.destroy();
      });
    };

    socket.on('data', onData);
    socket.on('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
      }
      socket.destroy();
    });
    socket.on('close', () => clearTimeout(timer));
  }

  async function acceptSession(
    socket: net.Socket,
    scope: StepScope,
    pending: Buffer,
  ): Promise<void> {
    const id = randomId('mcp');
    const sessionLogger = logger.child(scope.stepId);
    const allowed = source
      .tools()
      .filter((tool) => scope.allowedTools.has(tool.name));

    socket.write(
      serializeAck({
        v: HANDSHAKE_VERSION,
        ok: true,
        server: serverName,
        tools: allowed.length,
      }),
    );

    const mcp = createSessionServer(scope, sessionLogger);
    const transport = new UnixSocketTransport(socket, {
      initialData: pending.length > 0 ? pending : undefined,
    });

    const session: Session = { id, stepId: scope.stepId, socket, server: mcp };
    sessions.add(session);

    const drop = (): void => {
      if (sessions.delete(session)) {
        sessionLogger.debug('mcp session closed', { session: id });
      }
    };
    transport.onclose = drop;
    socket.once('close', drop);

    await mcp.connect(transport);
    socket.resume();

    sessionLogger.info('mcp session open', {
      session: id,
      runId: scope.runId,
      tools: allowed.length,
    });
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * `sockaddr_un.sun_path` is 104 bytes on macOS. A deep workspace root (or a
   * long username) overflows it, and the failure mode is an opaque EINVAL at
   * bind time. Fall back to a short private directory rather than not starting.
   */
  async function resolveSocketPath(preferred: string): Promise<string> {
    if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH_LENGTH) {
      return preferred;
    }
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asst-'));
    await fsp.chmod(dir, PRIVATE_DIR_MODE).catch(() => undefined);
    fallbackDir = dir;
    logger.warn('workspace socket path too long; using a private temp socket', {
      length: Buffer.byteLength(preferred),
    });
    return path.join(dir, SOCKET_FILENAME);
  }

  async function start(): Promise<void> {
    if (running) return;

    // Refuse to come up at all if a module registered arbitrary execution.
    assertNoForbiddenTools(source.tools(), logger);

    await ensureDir(paths.runtimeDir, PRIVATE_DIR_MODE);
    socketPath = await resolveSocketPath(socketPath);
    tokenFile = fallbackDir
      ? path.join(fallbackDir, TOKEN_FILENAME)
      : path.join(paths.runtimeDir, TOKEN_FILENAME);

    // A stale socket file from a crash blocks the bind.
    await fsp.rm(socketPath, { force: true }).catch(() => undefined);

    token = randomToken();
    await writeFileAtomic(tokenFile, token, { mode: PRIVATE_FILE_MODE });

    const server = net.createServer(handleConnection);
    server.on('error', (error) => {
      logger.error('mcp socket error', { error: error.message });
    });

    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      function onError(error: Error): void {
        server.off('listening', onListening);
        reject(error);
      }
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(socketPath);
    });

    // mkdir/bind modes are masked by the umask; chmod is not. Do this before
    // announcing the path anywhere.
    await fsp.chmod(socketPath, PRIVATE_FILE_MODE).catch(() => undefined);

    listener = server;
    running = true;

    const sideEffecting = source.tools().filter((tool) => tool.sideEffecting);
    if (usingDefaultGate && sideEffecting.length > 0) {
      logger.warn(
        'no approval gate injected: every side-effecting tool will run unchecked',
        { sideEffectingTools: sideEffecting.length },
      );
    }

    logger.info('mcp server listening', {
      socket: socketPath,
      tools: source.tools().length,
    });
  }

  async function stop(): Promise<void> {
    running = false;

    const open = [...sessions];
    sessions.clear();
    await Promise.all(
      open.map(async (session) => {
        try {
          await session.server.close();
        } catch {
          /* closing a dead session is not an error */
        }
        session.socket.destroy();
      }),
    );

    if (listener) {
      const server = listener;
      listener = null;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }

    steps.clear();
    token = '';

    await fsp.rm(socketPath, { force: true }).catch(() => undefined);
    await fsp.rm(tokenFile, { force: true }).catch(() => undefined);
    if (fallbackDir) {
      await fsp
        .rm(fallbackDir, { recursive: true, force: true })
        .catch(() => undefined);
      fallbackDir = null;
    }

    logger.info('mcp server stopped');
  }

  /* ---------------------------------------------------------------- */
  /* Public surface                                                    */
  /* ---------------------------------------------------------------- */

  function stepEnv(stepId: string): Record<string, string> {
    const scope = steps.get(stepId);
    if (!scope) throw new Error(`Step "${stepId}" is not registered`);
    if (!running) throw new Error('MCP server is not running');
    return {
      [SHIM_ENV.socketPath]: socketPath,
      [SHIM_ENV.token]: token,
      [SHIM_ENV.stepId]: scope.stepId,
    };
  }

  const api: McpSocketServer = {
    get socketPath() {
      return socketPath;
    },
    get tokenFile() {
      return tokenFile;
    },
    get serverName() {
      return serverName;
    },
    get running() {
      return running;
    },

    start,
    stop,

    registerStep(input) {
      const scope = steps.register(input);
      logger.debug('step registered', {
        stepId: scope.stepId,
        runId: scope.runId,
        tools: scope.allowedTools.size,
      });
      return {
        ...scope,
        env: () => stepEnv(scope.stepId),
        revoke: () => {
          api.revokeStep(scope.stepId);
        },
      };
    },

    revokeStep(stepId) {
      const removed = steps.revoke(stepId);
      // Any live connection for that step loses its scope the moment it is
      // revoked; drop the socket rather than serving a stale one.
      for (const session of [...sessions]) {
        if (session.stepId === stepId) {
          sessions.delete(session);
          void session.server.close().catch(() => undefined);
          session.socket.destroy();
        }
      }
      if (removed) logger.debug('step revoked', { stepId });
      return removed;
    },

    step(stepId) {
      return steps.get(stepId);
    },

    stepEnv,

    async writeConfigForStep(stepId, configOptions = {}) {
      const scope = steps.get(stepId);
      if (!scope) throw new Error(`Step "${stepId}" is not registered`);
      if (!running) throw new Error('MCP server is not running');
      return writeMcpConfigFile({
        paths,
        socketPath,
        token,
        stepId: scope.stepId,
        serverName: configOptions.serverName ?? serverName,
        shim: configOptions.shim,
        execPath: configOptions.execPath,
      });
    },

    setApprovalGate(gate) {
      approvals = gate;
      usingDefaultGate = false;
      logger.info('approval gate installed');
    },

    status() {
      return {
        running,
        socketPath,
        connections: sessions.size,
        registeredSteps: steps.size,
        toolCount: source.tools().length,
      };
    },
  };

  return api;
}
