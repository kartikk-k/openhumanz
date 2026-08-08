/**
 * Drives one Claude Code chat turn.
 *
 * This is the small slice of what the orchestrator does per step, kept separate
 * because Chat is deliberately *not* the run abstraction: it is one long-lived
 * CLI session that every message resumes, exactly like typing into `claude` in
 * a terminal. The CLI writes its own JSONL transcript under
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, and that file — not any
 * store of ours — is the source of truth the UI renders.
 *
 * What we still must do, and do here, is give that CLI the app's tool surface
 * and approval gate: register an MCP scope, write the per-turn `--mcp-config`,
 * inject the scope env, then stream the engine events (we only need `session`
 * to learn the session id and `result` to know the turn ended — the transcript
 * carries the rich detail).
 */
import type { Logger } from '../infra/logger';
import type { EngineAdapter, EngineEvent } from './engines/types';
import type { McpSocketServer } from './mcp/server';

/**
 * Circuit breakers for a chat turn. The adapter requires both, and rejects an
 * omitted or non-positive value at preflight — so these are real defaults, not
 * decoration. Generous because chat is interactive: a single answer may fan out
 * into many tool calls and subagents.
 */
const DEFAULT_CHAT_MAX_TURNS = 100;
const DEFAULT_CHAT_MAX_COST_USD = 5;

export interface ChatTurnRequest {
  /** The user's message. */
  prompt: string;
  /** cwd for the session — the `claude-chats` folder. */
  cwd: string;
  /** Resume this session, or start fresh when undefined. */
  resumeSessionId?: string;
  /** Pin this id when starting a fresh session (so we know it up front). */
  freshSessionId?: string;
  model?: string;
  maxTurns?: number;
  maxCostUsd?: number;
  signal?: AbortSignal;
}

export interface ChatTurnResult {
  /** The session id the turn ran under (learned from the engine). */
  sessionId: string | undefined;
  ok: boolean;
  error?: string;
}

export interface ChatSessionRunnerDeps {
  adapter: EngineAdapter;
  mcp: McpSocketServer;
  logger: Logger;
  /** Every tool the assistant may use in chat. */
  allowedTools: () => string[];
}

/**
 * A tiny concrete adapter surface. The orchestrator bridges the two `run`
 * shapes; here we only need the streamed events, so we accept either the
 * invocation form or the (prompt, options) form via a thin wrapper below.
 */
interface RunnableAdapter {
  run(prompt: string, options: RunOptions): AsyncIterable<EngineEvent>;
  resume(
    sessionId: string,
    prompt: string,
    options: RunOptions,
  ): AsyncIterable<EngineEvent>;
}

interface RunOptions {
  cwd: string;
  sessionId?: string;
  mcpConfigPath?: string;
  allowedTools?: string[];
  model?: string;
  maxTurns?: number;
  maxCostUsd?: number;
  /** Stream token-level deltas so the UI can render as text arrives. */
  includePartialMessages?: boolean;
  signal?: AbortSignal;
  env?: Record<string, string>;
  logger?: Logger;
}

export interface ChatSessionRunner {
  /** Run one turn, streaming engine events to `onEvent`. Resolves at the end. */
  runTurn(
    request: ChatTurnRequest,
    onEvent?: (event: EngineEvent) => void,
  ): Promise<ChatTurnResult>;
}

export function createChatSessionRunner(
  deps: ChatSessionRunnerDeps,
): ChatSessionRunner {
  const { mcp, logger } = deps;
  const adapter = deps.adapter as unknown as RunnableAdapter;

  return {
    async runTurn(request, onEvent) {
      const stepId = `chat-${request.freshSessionId ?? request.resumeSessionId ?? 'turn'}-${jitter()}`;
      const allowed = deps.allowedTools();

      // Give this turn the app's tools + approval gate, exactly like a run step.
      // The scope is keyed by stepId; we address it by id below, so the return
      // value is not needed.
      mcp.registerStep({
        stepId,
        runId: 'chat',
        allowedTools: allowed,
      });
      let mcpConfigPath: string | undefined;
      let cleanupConfig: (() => Promise<void>) | undefined;
      // The CLI's `--allowed-tools` wants the namespaced `mcp__server__tool`
      // ids, which the written config knows how to produce.
      let engineAllowedTools = allowed;
      try {
        const written = await mcp.writeConfigForStep(stepId);
        mcpConfigPath = written.path;
        cleanupConfig = () => written.cleanup();
        engineAllowedTools = written.toolIds(allowed);
      } catch (cause) {
        logger.warn('chat: failed to write mcp config; running without tools', {
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }

      const options: RunOptions = {
        cwd: request.cwd,
        mcpConfigPath,
        allowedTools: engineAllowedTools,
        model: request.model,
        // Token-level streaming: the UI renders deltas as they arrive instead
        // of waiting for the whole message (or the transcript file flush).
        includePartialMessages: true,
        // The adapter requires positive, finite circuit breakers — an omitted
        // value fails preflight and the turn yields nothing. Chat is
        // interactive, so the caps are generous but present.
        maxTurns: request.maxTurns ?? DEFAULT_CHAT_MAX_TURNS,
        maxCostUsd: request.maxCostUsd ?? DEFAULT_CHAT_MAX_COST_USD,
        signal: request.signal,
        env: mcp.stepEnv(stepId),
        logger,
      };

      let sessionId = request.resumeSessionId;
      let ok = false;
      let error: string | undefined;

      try {
        const stream = request.resumeSessionId
          ? adapter.resume(request.resumeSessionId, request.prompt, options)
          : adapter.run(request.prompt, {
              ...options,
              sessionId: request.freshSessionId,
            });

        let sawResult = false;
        for await (const event of stream) {
          if (event.type === 'session') sessionId = event.sessionId;
          if (event.type === 'result') {
            sawResult = true;
            ok = event.ok !== false;
          }
          if (event.type === 'error') {
            ok = false;
            error = event.message;
            // Surface the adapter's own failures (bad options, spawn failure,
            // CLI error) — otherwise a turn that yields only an error event
            // looks like silent success and nothing appears in the UI.
            logger.error('chat engine error', { message: event.message });
          }
          onEvent?.(event);
        }
        // A stream that ended without any result AND without an error means the
        // CLI produced nothing — treat that as a failure so it is visible.
        if (!sawResult && !error) {
          error = 'The engine produced no output.';
          ok = false;
          logger.error('chat turn produced no output', { sessionId });
        } else if (!error) {
          ok = true;
        }
      } catch (cause) {
        ok = false;
        error = cause instanceof Error ? cause.message : String(cause);
        logger.error('chat turn failed', { error, sessionId });
      } finally {
        mcp.revokeStep(stepId);
        if (cleanupConfig) await cleanupConfig().catch(() => {});
      }

      return { sessionId, ok, error };
    },
  };
}

/** Small non-crypto suffix so concurrent turns don't collide on a step id. */
let counter = 0;
function jitter(): string {
  counter = (counter + 1) % 1_000_000;
  return counter.toString(36);
}
