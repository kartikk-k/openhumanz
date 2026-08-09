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
  disallowedTools?: string[];
  appendSystemPrompt?: string;
  model?: string;
  maxTurns?: number;
  maxCostUsd?: number;
  /** Stream token-level deltas so the UI can render as text arrives. */
  includePartialMessages?: boolean;
  signal?: AbortSignal;
  env?: Record<string, string>;
  logger?: Logger;
}

/**
 * The Claude Code CLI ships its own in-memory `CronCreate`/`CronList`/
 * `CronDelete` tools. They only live for the current CLI process, so a reminder
 * scheduled through them silently dies when the chat turn ends and never shows
 * in the Schedule screen. We disallow them so the assistant uses the app's own
 * persistent `schedule_create` MCP tool instead.
 */
const DISALLOWED_CLI_TOOLS = ['CronCreate', 'CronList', 'CronDelete'];

/**
 * How long the CLI should keep a chat tool call alive with no response.
 *
 * A side-effecting chat tool call blocks on the MCP side until the user answers
 * its inline approval, which can take minutes. Claude Code aborts a stdio MCP
 * tool call that is idle (no response, no progress) past this window — 30 min by
 * default, which we raise to be safe. The MCP server also heartbeats progress
 * every ~20s while waiting, which resets this timer when the CLI honours it;
 * this generous ceiling is the belt to that suspenders. 2 hours in ms.
 */
const CHAT_MCP_IDLE_TIMEOUT_MS = '7200000';

/**
 * Steer scheduling toward the app's persistent scheduler.
 *
 * The app's tools reach the model as MCP tools named `mcp__assistant__<tool>`,
 * and with a large tool surface the CLI defers them behind ToolSearch — so the
 * model, searching for "schedule_create", finds the unrelated built-in
 * `TaskCreate` instead and concludes no scheduler exists. This prompt gives the
 * exact tool names and tells the model to load and call them directly, so a
 * reminder request never dead-ends.
 */
const CHAT_SYSTEM_PROMPT =
  'You are running inside a desktop assistant app that has its own persistent ' +
  'scheduler, exposed as MCP tools. To schedule anything — reminders, ' +
  'recurring checks, one-off future tasks — you MUST use these exact tools:\n' +
  '  • mcp__assistant__schedule_create — create a scheduled job (cron + prompt)\n' +
  '  • mcp__assistant__schedule_list — list scheduled jobs\n' +
  '  • mcp__assistant__schedule_update — change a job\n' +
  '  • mcp__assistant__schedule_delete — remove a job\n' +
  'If these tools are not already loaded, load them first with ToolSearch ' +
  '(query "select:mcp__assistant__schedule_create,mcp__assistant__schedule_list,' +
  'mcp__assistant__schedule_update,mcp__assistant__schedule_delete"), then call ' +
  'them. They persist to the app database, appear on the Schedule screen, fire ' +
  'even after this conversation ends, and notify the user. Do NOT use the ' +
  'built-in CronCreate/CronList/CronDelete tools (session-only, will not fire ' +
  'once the turn ends) and do NOT use TaskCreate/TaskUpdate for reminders ' +
  '(those only track work within this session). If a schedule tool call is ' +
  'ever blocked or missing, say so plainly rather than substituting a ' +
  'session-only alternative.\n\n' +
  // Memory: proactive capture + recall. The user wants the assistant to build a
  // memory of them over time without being asked — preferences, facts, and
  // decisions — and to use it. The engine extracts and de-duplicates the atomic
  // facts itself, so the model hands over plain statements and decides only
  // *when* something is worth remembering.
  'You have a long-term memory of the user, exposed as MCP tools:\n' +
  '  • mcp__assistant__memory_store — remember a durable fact about the user\n' +
  '  • mcp__assistant__memory_search — recall what you already know\n' +
  '  • mcp__assistant__memory_list — list everything remembered\n' +
  '  • mcp__assistant__memory_forget — delete a memory by id\n' +
  '  • mcp__assistant__memory_update — replace a memory by id\n' +
  'PROACTIVELY call memory_store, without being asked, whenever the user ' +
  'reveals something worth remembering across conversations: preferences and ' +
  'likes/dislikes ("prefers burgers over pizza"), personal facts (name, ' +
  'location, job, relationships), decisions and goals, and important ongoing ' +
  'projects. State the fact plainly; the engine extracts and organises the ' +
  'atomic memories and supersedes anything it contradicts, so you rarely need ' +
  'to forget or update by hand. Use memory_forget / memory_update only when the ' +
  'user explicitly asks to remove or correct something (get the id from ' +
  'memory_list or memory_search first). Do NOT store transient chatter or ' +
  'one-off task details. Before answering anything that depends on who the ' +
  'user is or what they like, call memory_search first. If these tools are not ' +
  'loaded, load them with ToolSearch (query ' +
  '"select:mcp__assistant__memory_store,mcp__assistant__memory_search,' +
  'mcp__assistant__memory_list,mcp__assistant__memory_forget,' +
  'mcp__assistant__memory_update") and use them.';

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
      // The session id is stable across a session's turns; the step id is unique
      // per turn. Keying the run on the session (not a per-turn value, nor the
      // constant 'chat') is what makes a "For this chat" grant reach later turns
      // of the same conversation while never leaking into a different chat.
      const chatSessionId =
        request.freshSessionId ?? request.resumeSessionId ?? 'chat';
      const chatRunId = `chat:${chatSessionId}`;
      const stepId = `chat-${chatSessionId}-${jitter()}`;
      const allowed = deps.allowedTools();

      // Give this turn the app's tools + approval gate, exactly like a run step —
      // but marked interactive, so a pending approval holds the tool call open
      // and the turn continues in place once the user decides in the chat.
      mcp.registerStep({
        stepId,
        runId: chatRunId,
        allowedTools: allowed,
        interactive: true,
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
        // Block the CLI's ephemeral cron tools so scheduling goes through the
        // app's persistent scheduler, and tell the model why.
        disallowedTools: DISALLOWED_CLI_TOOLS,
        appendSystemPrompt: CHAT_SYSTEM_PROMPT,
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
        env: {
          ...mcp.stepEnv(stepId),
          // Let a chat tool call wait for the user's inline approval without the
          // CLI aborting it as idle. See CHAT_MCP_IDLE_TIMEOUT_MS.
          CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: CHAT_MCP_IDLE_TIMEOUT_MS,
        },
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
