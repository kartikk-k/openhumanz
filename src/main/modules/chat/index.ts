/**
 * The `chat` module.
 *
 * A direct, continuous line to the assistant — one long-lived Claude Code
 * session that every message resumes, exactly like typing into `claude` in a
 * terminal. Sessions run with their cwd set to `<workspace>/claude-chats`, so
 * the CLI writes its transcripts into one dedicated `~/.claude/projects/...`
 * folder that holds the chat history and nothing else.
 *
 * The CLI's own JSONL transcript is the source of truth: this module reads and
 * folds it (via the shared parser) for the UI, and watches it so streamed
 * output appears live. We keep almost no state of our own — only which session
 * is "current" and whether a turn is in flight.
 *
 * Execution is injected. Like the runs module, a module may not import a
 * service, so the engine adapter and MCP server arrive through
 * {@link configureChat}. Until then, `chat:send` fails loudly.
 */
import fs from 'node:fs';
import type { AppModule, IpcHandlerMap, ModuleContext } from '../types';
import type { Logger } from '../../infra/logger';
import type { WorkspacePaths } from '../../infra/paths';
import type {
  ChatSessionList,
  ChatSessionSummary,
  ChatTranscript,
} from '../../../shared/ipc';
import {
  foldTranscript,
  foldTranscriptWithSubagents,
  latestSessionTitle,
  parseTranscript,
} from '../../../shared/claudeTranscript.fold';
import {
  latestSession,
  listSessions,
  readSessionText,
  readSubagents,
  sessionTranscriptFile,
} from './claudeHome';
import { normalizeStreamEvent } from './streamNormalize';

/**
 * The chat runner, as this module needs to see it — one method. Declared here
 * (not imported from the services layer) so the module stays free of any
 * service import; `main.ts` injects a concrete runner through {@link configureChat}.
 */
export interface ChatSessionRunner {
  runTurn(
    request: {
      prompt: string;
      cwd: string;
      resumeSessionId?: string;
      freshSessionId?: string;
      model?: string;
      maxTurns?: number;
      maxCostUsd?: number;
      signal?: AbortSignal;
      surface?: 'home' | 'chat';
    },
    onEvent?: (event: unknown) => void,
  ): Promise<{ sessionId: string | undefined; ok: boolean; error?: string }>;
}

/** A short id + prompt used to spawn a fresh session before its id is known. */
function draftSessionId(): string {
  // A v4-shaped id the CLI will accept via --session-id. Time-free so it never
  // trips the "no Date.now in workflow" rule anywhere; this is main-process
  // code so Date is fine, but keep it simple and unique enough.
  const hex = (n: number) =>
    Array.from({ length: n }, () =>
      Math.floor(Math.random() * 16).toString(16),
    ).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${((8 + Math.floor(Math.random() * 4)) % 16).toString(16)}${hex(3)}-${hex(12)}`;
}

export interface ChatWiring {
  runner?: ChatSessionRunner;
}

export interface ChatModule extends AppModule {
  configure(wiring: ChatWiring): void;
}

export function createChatModule(): ChatModule {
  let runner: ChatSessionRunner | undefined;
  let paths: WorkspacePaths | null = null;
  let logger: Logger | null = null;
  let events: ModuleContext['events'] | null = null;

  /** The session the UI is looking at. Resolved lazily to the latest on disk. */
  let currentSessionId: string | null = null;
  /**
   * Set by "New chat": the next send must start a *fresh* session rather than
   * resolving `currentSessionId` back to the newest transcript on disk. Without
   * this, clearing `currentSessionId` and then resolving it would just re-open
   * the last session — silently undoing "New chat".
   */
  let startFreshNext = false;
  /** True while a turn streams, so the UI can show a spinner and disable send. */
  let busy = false;
  /** Watchers for the current session file, so streamed output pushes live. */
  let watcher: fs.FSWatcher | null = null;

  const cwd = (): string => {
    if (!paths) throw new Error('The chat module has not started yet.');
    return paths.claudeChatsDir;
  };

  const emitUpdated = (sessionsChanged = false): void => {
    events?.emit('chat:updated', {
      sessionId: currentSessionId,
      busy,
      sessionsChanged,
    });
  };

  const stopWatching = (): void => {
    if (watcher) {
      watcher.close();
      watcher = null;
    }
  };

  const watchSession = (sessionId: string): void => {
    stopWatching();
    const file = sessionTranscriptFile(cwd(), sessionId);
    try {
      // Watch the directory is more reliable than the file (atomic rewrites),
      // but the CLI appends, so watching the file is enough and cheaper.
      watcher = fs.watch(file, { persistent: false }, () => {
        emitUpdated(false);
      });
    } catch {
      // File may not exist yet (fresh session). We'll rewatch after the first
      // turn creates it.
      watcher = null;
    }
  };

  /** Resolve the current session, defaulting to the latest one on disk. */
  const resolveCurrent = async (): Promise<string | null> => {
    if (currentSessionId) return currentSessionId;
    // A pending "New chat" must not resolve back to the last session on disk.
    if (startFreshNext) return null;
    const latest = await latestSession(cwd());
    currentSessionId = latest?.sessionId ?? null;
    if (currentSessionId) watchSession(currentSessionId);
    return currentSessionId;
  };

  const readTranscript = async (
    sessionId: string | null,
  ): Promise<ChatTranscript> => {
    if (!sessionId) {
      return { sessionId: null, title: null, turns: [], busy };
    }
    const file = sessionTranscriptFile(cwd(), sessionId);
    const text = await readSessionText(file);
    const records = parseTranscript(text);
    // Subagents (Task tool) live in a sibling directory; fold them in so the UI
    // can nest each subagent's steps under the call that spawned it.
    const subagents = await readSubagents(cwd(), sessionId);
    return {
      sessionId,
      title: latestSessionTitle(records) ?? null,
      turns: foldTranscriptWithSubagents(records, subagents),
      busy,
    };
  };

  const buildSessionList = async (): Promise<ChatSessionList> => {
    const files = await listSessions(cwd());
    const current = await resolveCurrent();
    const sessions: ChatSessionSummary[] = await Promise.all(
      files.map(async (info): Promise<ChatSessionSummary> => {
        const text = await readSessionText(info.file);
        const records = parseTranscript(text);
        const turns = foldTranscript(records);
        return {
          sessionId: info.sessionId,
          title: latestSessionTitle(records) ?? null,
          updatedMs: info.modifiedMs,
          messageCount: turns.length,
        };
      }),
    );
    return { sessions, currentSessionId: current };
  };

  const ipc: IpcHandlerMap = {
    'chat:sessions': async () => buildSessionList(),

    'chat:transcript': async (request) => {
      // A pending "New chat" shows an empty conversation until the first send
      // creates the session — never resolve back to the last one on disk.
      if (startFreshNext && !request.sessionId) {
        return { sessionId: null, title: null, turns: [], busy };
      }
      const sessionId = request.sessionId ?? (await resolveCurrent());
      return readTranscript(sessionId);
    },

    'chat:new': async () => {
      stopWatching();
      // A fresh session is created on the next send; clearing the current id
      // makes the UI show an empty conversation immediately, and the flag makes
      // the next send start fresh instead of resolving back to the last session.
      currentSessionId = null;
      startFreshNext = true;
      emitUpdated(true);
      return { currentSessionId: null };
    },

    'chat:select': async (request) => {
      currentSessionId = request.sessionId;
      startFreshNext = false;
      watchSession(request.sessionId);
      emitUpdated(true);
      return { currentSessionId };
    },

    'chat:send': async (request) => {
      if (!runner) {
        throw new Error(
          'No engine is wired up, so chat cannot run. ' +
            'Call configureChat({ runner }) from main.ts.',
        );
      }
      // "New chat" forces a fresh session; otherwise continue the requested or
      // current session (falling back to the newest on disk).
      const resumeId = startFreshNext
        ? undefined
        : (request.sessionId ?? (await resolveCurrent()));
      const freshId = resumeId ? undefined : draftSessionId();
      startFreshNext = false;

      busy = true;
      // If we're starting fresh, adopt the drafted id immediately so the UI and
      // the watcher have something to bind to.
      if (freshId) {
        currentSessionId = freshId;
      }
      emitUpdated(Boolean(freshId));

      // Fire the turn in the background; the transcript watcher streams output.
      void (async () => {
        try {
          const result = await runner!.runTurn(
            {
              prompt: request.prompt,
              cwd: cwd(),
              resumeSessionId: resumeId ?? undefined,
              freshSessionId: freshId,
              surface: request.surface ?? 'chat',
            },
            (engineEvent) => {
              // Stream every event straight to the UI so the response renders
              // token-by-token, with tool calls and subagent steps appearing as
              // they happen — not when the transcript file is flushed.
              const streamEvent = normalizeStreamEvent(engineEvent);
              if (streamEvent) {
                events?.emit('chat:stream', {
                  sessionId: currentSessionId,
                  event: streamEvent,
                });
              }
            },
          );
          if (result.sessionId && result.sessionId !== currentSessionId) {
            currentSessionId = result.sessionId;
            watchSession(result.sessionId);
          } else if (currentSessionId) {
            watchSession(currentSessionId);
          }
        } catch (error) {
          logger?.error('chat send failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          busy = false;
          emitUpdated(true);
        }
      })();

      return { sessionId: currentSessionId, accepted: true };
    },

    'chat:cancel': async () => {
      // Cancellation is best-effort: the runner owns the abort signal. For now
      // we just clear busy; a follow-up can thread an AbortController through.
      return { ok: true as const };
    },

    'chat:subscribe': async () => {
      // Push is broadcast (chat is single-window in practice); nothing to scope.
      return { ok: true as const };
    },

    'chat:unsubscribe': async () => ({ ok: true as const }),
  };

  return {
    id: 'chat',
    migrations: [],
    ipc,

    configure(wiring) {
      if (wiring.runner !== undefined) runner = wiring.runner;
    },

    async start(ctx: ModuleContext) {
      paths = ctx.paths;
      logger = ctx.logger;
      events = ctx.events;
      await resolveCurrent();
    },

    async stop() {
      stopWatching();
    },
  };
}

export default createChatModule;
