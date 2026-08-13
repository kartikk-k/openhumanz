/**
 * The thread runner — the bridge between a bot's thread and a background run.
 *
 * Sending to a bot spawns a detached orchestrator run (`startIfCondition` with
 * `condition: () => true`, so it is visible in review that nothing is being
 * gated). The bot's identity is applied by *prepending* its system prompt to
 * the run prompt — `EngineInvocation` has no systemPrompt field, and
 * re-architecting the engine to add one is out of scope. The run's tool scope
 * is the bot's `allowedTools` and its cwd is the bot's `workspaceDir`.
 *
 * The run writes app-owned `runs/<id>/transcript.jsonl` ({@link RunEvent}
 * JSONL, not the Claude Code session file) and emits `run:event` / `run:status`
 * on the bus. This runner folds that file with `foldRunEvents` into
 * `ChatBlock[]`, then patches the placeholder bot message. It re-folds on each
 * `run:event` (best-effort live streaming) and once more on `run:status`
 * finish (the authoritative final state).
 *
 * Nothing here ties streaming to a "current" bot: the run is detached, the
 * subscription is keyed on the run id, and the message row is the durable
 * anchor. Closing or switching the thread does not stop or lose the run.
 */
import fsp from 'node:fs/promises';
import type { EventBus, Unsubscribe } from '../../infra/events';
import type { Logger } from '../../infra/logger';
import type { WorkspacePaths } from '../../infra/paths';
import type { ChatBlock } from '../../../shared/claudeTranscript.fold';
import {
  foldRunEvents,
  parseRunTranscript,
} from '../../../shared/runEvents.fold';
import type { BotMessageSource, Bot } from '../../../shared/bots';
import type { BotStore } from './store';

/**
 * Tools every bot run gets no matter how the bot is configured. A bot must
 * ALWAYS be able to see the roster and message another bot — that is the whole
 * point of bots — so these are force-included in the run's allow-list even when
 * the bot has a narrow `allowedTools`. Without this, a bot whose allow-list
 * omits them (or the empty→defaults case, where the orchestrator's default
 * exposed set may not include them) simply cannot find `message_bot`.
 */
export const ALWAYS_ALLOWED_BOT_TOOLS = ['list_bots', 'message_bot'];

/**
 * The orchestrator, as this runner needs to see it — one method. Declared here
 * (not imported from the services layer) so the module stays free of a service
 * import; `bootstrap.ts` injects the real orchestrator. The shape matches
 * `Orchestrator.startIfCondition` from the services layer.
 */
export interface BotRunLauncher {
  startIfCondition(options: {
    request: {
      title?: string;
      prompt: string;
      trigger: string;
      cwd?: string;
      resumeSessionId?: string;
      allowedTools?: string[];
      metadata?: Record<string, unknown>;
    };
    condition: () => boolean | Promise<boolean>;
    reason?: string;
  }): Promise<{ started: boolean; run?: { id: string }; skipped?: string }>;
}

export interface ThreadRunnerDeps {
  store: BotStore;
  events: EventBus;
  paths: WorkspacePaths;
  logger: Logger;
  /** Injected after the orchestrator exists; until then, sends fail loudly. */
  launcher?: BotRunLauncher;
  /**
   * Every tool name registered in the app. Used to give a bot with no explicit
   * `allowedTools` the FULL toolset (an empty allow-list otherwise strips every
   * tool — the orchestrator treats [] as "expose nothing", not "expose all").
   * Injected from bootstrap's `registry.tools()`.
   */
  allToolNames?: () => string[];
  /**
   * Which bot's thread the UI currently has open. Used to decide whether a
   * finished run should bump unread. Returns null when no thread is focused.
   */
  focusedBotId?: () => string | null;
}

export interface SendToBotResult {
  botId: string;
  /** The run backing the bot's placeholder message, or null if none started. */
  runId: string | null;
  /** The placeholder bot message id, so the caller can reference it. */
  messageId: string | null;
  accepted: boolean;
  skipped?: string;
}

export interface SendToBotInput {
  botId: string;
  prompt: string;
  source?: BotMessageSource;
  author?: string;
  /** Append the user's prompt as a message. Off for bot-to-bot triggers that
   *  already recorded the incoming turn elsewhere. Defaults to true. */
  recordUserMessage?: boolean;
  /** Depth of this turn in a bot-to-bot chain. 0 for a user/schedule trigger. */
  hopDepth?: number;
  /** Display name of the calling bot, when source is `bot-to-bot`. */
  fromBotName?: string;
}

export interface ThreadRunner {
  configure(wiring: {
    launcher?: BotRunLauncher;
    allToolNames?: () => string[];
  }): void;
  /**
   * User (or another bot, or a schedule) sends a prompt to a bot. Appends the
   * user message, then spawns the background run and a streaming placeholder
   * bot message. Returns immediately; the run streams into the message.
   */
  sendToBot(input: SendToBotInput): Promise<SendToBotResult>;
  /** Hop depth recorded for a bot-owned run; 0 when the run is unknown. */
  hopDepthFor(runId: string): number;
  /**
   * Re-fold every message that already has a run id. Heals threads that were
   * left as empty "Working…" bubbles because an earlier fold produced nothing.
   */
  recoverOpenRuns(): Promise<void>;
  /** Release the bus subscriptions this runner holds. Safe to call twice. */
  dispose(): void;
}

/**
 * First sentence of a system prompt, or the first 120 characters. Empty when
 * the bot has no persona — the injected roster stays a name list in that case.
 */
export function botDescriptionLine(systemPrompt: string): string {
  const flat = systemPrompt.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const sentence = flat.match(/^(.+?[.!?])(?:\s|$)/);
  const line = sentence?.[1] ?? flat;
  return line.length <= 120 ? line : line.slice(0, 120);
}

/** One compact line per reachable bot, excluding the speaker. */
function formatRoster(roster: readonly Bot[], currentId: string): string {
  const others = roster.filter((peer) => peer.id !== currentId);
  if (others.length === 0) {
    return 'There are no other bots to message.';
  }
  const lines = others.map((peer) => {
    const blurb = botDescriptionLine(peer.systemPrompt);
    const head = `- id: ${peer.id} — ${peer.name}`;
    return blurb ? `${head} — ${blurb}` : head;
  });
  return [
    'Other bots you can reach. To message one, call the `message_bot` tool with ' +
      'its `botId` (the id shown below) and a `prompt`. Address bots by id, ' +
      'NEVER by name. Do NOT use the SendMessage tool for bots — SendMessage ' +
      'reaches CLI teammate agents, not bots, and will fail. Do not message yourself.',
    ...lines,
  ].join('\n');
}

/** Compose the run prompt: identity, persona, roster, then the user's ask. */
function composePrompt(
  bot: Bot,
  prompt: string,
  roster: readonly Bot[],
): string {
  const parts: string[] = [`You are the bot named "${bot.name}".`];
  const persona = bot.systemPrompt.trim();
  if (persona) parts.push(persona);
  parts.push(formatRoster(roster, bot.id));
  parts.push(`---\n\n${prompt}`);
  return parts.join('\n\n');
}

export function createThreadRunner(deps: ThreadRunnerDeps): ThreadRunner {
  const { store, events, paths, logger } = deps;
  let launcher = deps.launcher;
  let allToolNames = deps.allToolNames;

  /**
   * The tool allow-list for a bot's run. A bot with an explicit `allowedTools`
   * gets exactly that; a bot with none gets the FULL registered toolset (empty
   * would otherwise expose nothing). Either way the bot-to-bot tools are always
   * force-included so a bot can always reach the roster.
   */
  const effectiveAllowedTools = (bot: Bot): string[] => {
    const base =
      bot.allowedTools.length > 0 ? bot.allowedTools : (allToolNames?.() ?? []);
    return [...new Set([...base, ...ALWAYS_ALLOWED_BOT_TOOLS])];
  };

  /** run id -> the message id whose blocks that run streams into. */
  const runToMessage = new Map<string, string>();
  /** run id -> the bot that owns the run, for unread bookkeeping. */
  const runToBot = new Map<string, string>();
  /** run id -> bot-to-bot hop depth recorded when the run was spawned. */
  const runToHop = new Map<string, number>();

  /**
   * Bind a run to its placeholder. Events can land before `sendToBot` records
   * the id (startIfCondition emits `run.started` before it returns), so
   * handlers also recover via the message row that already has this runId.
   */
  const bindRun = (
    runId: string,
    messageId: string,
    botId: string,
    hopDepth = 0,
  ): void => {
    runToMessage.set(runId, messageId);
    runToBot.set(runId, botId);
    if (!runToHop.has(runId)) runToHop.set(runId, hopDepth);
  };

  const ensureBound = (runId: string): boolean => {
    if (runToMessage.has(runId)) return true;
    const message = store.findMessageByRunId(runId);
    if (!message) return false;
    bindRun(runId, message.id, message.botId);
    return true;
  };

  /**
   * Read the run's event transcript and fold it into blocks. Missing file
   * (the run has not written anything yet) folds to an empty list.
   */
  const foldRunBlocks = async (runId: string): Promise<ChatBlock[]> => {
    const file = paths.runTranscriptFile(runId);
    let text: string;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch {
      return [];
    }
    return foldRunEvents(parseRunTranscript(text));
  };

  /**
   * The engine session id the run established, read from its transcript. Bots
   * persist this so the NEXT turn resumes the same conversation — without it a
   * bot has no memory of what was just said ("try now" means nothing).
   */
  const runSessionId = async (runId: string): Promise<string | undefined> => {
    const file = paths.runTranscriptFile(runId);
    let text: string;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch {
      return undefined;
    }
    let latest: string | undefined;
    for (const event of parseRunTranscript(text)) {
      const sid = (event as { sessionId?: string }).sessionId;
      if (sid) latest = sid;
    }
    return latest;
  };

  /** Re-fold and patch the message backing a run; emit a thread update. */
  const refresh = async (
    runId: string,
    rosterChanged = false,
  ): Promise<void> => {
    if (!ensureBound(runId)) return;
    const messageId = runToMessage.get(runId);
    if (!messageId) return;
    const blocks = await foldRunBlocks(runId);
    store.updateMessageBlocks(messageId, blocks, runId);
    const botId = runToBot.get(runId);
    if (botId) events.emit('bots:thread', { botId, rosterChanged });
  };

  const onEvent = (payload: { runId: string; event: unknown }): void => {
    if (!ensureBound(payload.runId)) return;
    void refresh(payload.runId).catch((cause: unknown) => {
      logger.warn('failed to fold bot run transcript', {
        runId: payload.runId,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    });
  };

  const onStatus = (payload: { runId: string; status: string }): void => {
    if (!ensureBound(payload.runId)) return;
    const terminal =
      payload.status === 'succeeded' ||
      payload.status === 'failed' ||
      payload.status === 'cancelled';
    void (async () => {
      // Final authoritative fold.
      await refresh(payload.runId, true).catch(() => undefined);
      if (!terminal) return;
      // A finished run that wrote nothing would otherwise sit as an empty
      // "Working…" bubble. Give the thread a line so the UI can settle.
      const messageId = runToMessage.get(payload.runId);
      if (messageId) {
        const existing = store.getMessage(messageId);
        if (existing && existing.blocks.length === 0) {
          let text = 'The run ended without output.';
          if (payload.status === 'cancelled') text = 'The run was cancelled.';
          else if (payload.status === 'failed') {
            text = 'The run failed before producing output.';
          }
          store.updateMessageBlocks(messageId, [{ kind: 'text', text }]);
        }
      }
      const botId = runToBot.get(payload.runId);
      // Persist the engine session so the bot's NEXT turn resumes it — this is
      // what gives the thread memory across turns.
      if (botId) {
        const sid = await runSessionId(payload.runId).catch(() => undefined);
        if (sid) store.setSessionId(botId, sid);
      }
      // If the thread is not focused, the freshly-finished bot message is
      // unread; the roster's unread count is derived from the read cursor, so
      // there is nothing to increment — emitting the roster change is enough for
      // the UI to recompute. (When focused, the IPC layer marks it read.)
      if (botId) events.emit('bots:thread', { botId, rosterChanged: true });
      runToMessage.delete(payload.runId);
      runToBot.delete(payload.runId);
      runToHop.delete(payload.runId);
    })().catch(() => undefined);
  };

  const offEvent = events.on('run:event', onEvent);
  const offStatus = events.on('run:status', onStatus);
  const offFinished: Unsubscribe = events.on(
    'run:finished',
    ({ runId, status }) => onStatus({ runId, status }),
  );

  const runner: ThreadRunner = {
    configure(wiring) {
      if (wiring.launcher !== undefined) launcher = wiring.launcher;
      if (wiring.allToolNames !== undefined) allToolNames = wiring.allToolNames;
    },

    async sendToBot(input) {
      let bot = store.getBot(input.botId);
      if (!bot) throw new Error(`Unknown bot: ${input.botId}`);
      // Auto-activate: a dormant (archived) bot is woken before we deliver, so
      // a message never silently no-ops because the target was inactive. This
      // is a built-in guarantee of the pipeline — callers (including another
      // bot's message_bot) never have to activate a bot first.
      if (bot.archived) {
        const revived = store.updateBot(bot.id, { archived: false });
        if (revived) bot = revived;
        logger.info('bot auto-activated before delivery', {
          botId: bot.id,
          name: bot.name,
        });
        events.emit('bots:thread', { botId: bot.id, rosterChanged: true });
      }
      const source: BotMessageSource = input.source ?? 'chat';
      const hopDepth = input.hopDepth ?? 0;
      const author =
        source === 'bot-to-bot'
          ? (input.fromBotName ?? input.author ?? 'bot')
          : (input.author ?? '');

      if (input.recordUserMessage !== false) {
        store.appendMessage({
          botId: bot.id,
          role: 'user',
          author,
          blocks: [{ kind: 'text', text: input.prompt }],
          source,
        });
        events.emit('bots:thread', { botId: bot.id, rosterChanged: true });
      }

      if (!launcher) {
        throw new Error(
          'No orchestrator is wired up, so bots cannot run. ' +
            'Inject a launcher via the bots module configure() from bootstrap.ts.',
        );
      }

      // Resolve the bot's cwd. An empty workspaceDir means "the bot's own
      // subdirectory under the workspace"; create it so the run has a home.
      const cwd = bot.workspaceDir.trim() || defaultBotCwd(paths, bot.id);
      try {
        await fsp.mkdir(cwd, { recursive: true });
      } catch {
        /* best-effort; the orchestrator falls back to the workspace root */
      }

      // Placeholder bot message the run streams into. Created before the run so
      // the UI has an anchor immediately; the run id is patched in once known.
      const placeholder = store.appendMessage({
        botId: bot.id,
        role: 'bot',
        author: bot.name,
        blocks: [],
        source,
      });

      // Resume the bot's prior engine session so this turn remembers the last —
      // this is what makes "try now" / "approve" continue the conversation
      // instead of starting cold.
      const resumeSessionId = store.getSessionId(bot.id);

      const result = await launcher.startIfCondition({
        request: {
          title: `${bot.name}: ${input.prompt.slice(0, 60)}`,
          prompt: composePrompt(bot, input.prompt, store.listBots(false)),
          trigger: source === 'schedule' ? 'schedule' : 'manual',
          cwd,
          resumeSessionId,
          // Always an explicit list: full toolset for an unconfigured bot, the
          // bot's own set otherwise, plus the always-on bot-to-bot tools. An
          // empty list would strip every tool (the orchestrator treats [] as
          // "expose nothing"), which is exactly why message_bot went missing.
          allowedTools: effectiveAllowedTools(bot),
          metadata: {
            botId: bot.id,
            botMessageId: placeholder.id,
            source,
            botHopDepth: hopDepth,
          },
        },
        condition: () => true,
        reason: `bot ${bot.name} (${bot.id})`,
      });

      if (!result.started || !result.run) {
        const reason = result.skipped?.trim() || 'The run did not start.';
        store.updateMessageBlocks(placeholder.id, [
          { kind: 'text', text: reason },
        ]);
        events.emit('bots:thread', { botId: bot.id, rosterChanged: true });
        return {
          botId: bot.id,
          runId: null,
          messageId: placeholder.id,
          accepted: false,
          skipped: result.skipped,
        };
      }

      const runId = result.run.id;
      bindRun(runId, placeholder.id, bot.id, hopDepth);
      // Stamp the run id first so a mid-start event that missed the map can
      // recover via findMessageByRunId, then fold whatever is already on disk.
      store.updateMessageBlocks(placeholder.id, [], runId);
      void refresh(runId).catch(() => undefined);

      return {
        botId: bot.id,
        runId,
        messageId: placeholder.id,
        accepted: true,
      };
    },

    hopDepthFor(runId) {
      return runToHop.get(runId) ?? 0;
    },

    async recoverOpenRuns() {
      const pending = store.listMessagesWithRuns();
      await Promise.all(
        pending.map(async (message) => {
          const runId = message.runId;
          if (!runId) return;
          bindRun(runId, message.id, message.botId);
          await refresh(runId, true).catch(() => undefined);
          const existing = store.getMessage(message.id);
          if (existing && existing.blocks.length === 0) {
            store.updateMessageBlocks(message.id, [
              { kind: 'text', text: 'The run ended without output.' },
            ]);
            events.emit('bots:thread', {
              botId: message.botId,
              rosterChanged: true,
            });
          }
        }),
      );
    },

    dispose() {
      offEvent();
      offStatus();
      offFinished();
      runToMessage.clear();
      runToBot.clear();
      runToHop.clear();
    },
  };

  return runner;
}

/** `runs/../bots/<botId>` — a bot's default cwd, self-contained per bot. */
function defaultBotCwd(paths: WorkspacePaths, botId: string): string {
  // Kept beside the workspace root so a bot's files never mix with runs/ or the
  // chat sessions. `resolve` rejects traversal outside the workspace.
  return paths.resolve('bots', sanitizeSegment(botId));
}

/** Strip anything that could escape the bots directory. */
function sanitizeSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9_-]/g, '_') || 'bot';
}
