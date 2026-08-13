/**
 * The bots slice of the MCP surface.
 *
 * Two tools. `list_bots` is the roster the agent reads before it talks to
 * anyone; `message_bot` is a thin ack over the existing background-run
 * primitive — it does not wait for the target to finish. Failures come back
 * as values so a missing name or a hop-cap hit is something the caller can
 * react to, not an exception.
 */
import { z } from 'zod';
import { defineTool } from '../types';
import type { AnyToolDefinition, ToolCallContext } from '../types';
import type { Bot } from '../../../shared/bots';
import type { BotStore } from './store';
import { botDescriptionLine, type ThreadRunner } from './thread-runner';

/** A bot-to-bot chain may hop this many times; the next call is rejected. */
export const BOT_HOP_LIMIT = 3;

const ListInputSchema = z.object({});
type ListInput = z.infer<typeof ListInputSchema>;

const MessageInputSchema = z.object({
  botId: z
    .string()
    .min(1)
    .describe(
      'The unique id of the bot to message (the `id` field from list_bots). ' +
        'Address bots by id, never by name.',
    ),
  prompt: z.string().min(1).describe('What the other bot should do.'),
});
type MessageInput = z.infer<typeof MessageInputSchema>;

export interface BotsToolDeps {
  store: BotStore;
  runner: ThreadRunner;
}

function compactBot(bot: Bot): {
  id: string;
  name: string;
  description: string;
} {
  return {
    id: bot.id,
    name: bot.name,
    description: botDescriptionLine(bot.systemPrompt),
  };
}

/**
 * Bot with this exact id, INCLUDING archived ones. Archived is fine: the
 * thread-runner auto-activates a dormant target before delivery, so a bot can
 * message a bot that is currently archived.
 */
function findBotById(store: BotStore, botId: string): Bot | undefined {
  const needle = botId.trim();
  if (!needle) return undefined;
  return store.getBot(needle);
}

/**
 * The bot that owns this tool call, if the call came from a bot-owned run.
 * Hop depth is the value sendToBot recorded on that run (0 when unknown).
 */
function resolveCaller(
  store: BotStore,
  runner: ThreadRunner,
  ctx: ToolCallContext,
): { bot: Bot; hopDepth: number } | undefined {
  if (!ctx.runId) return undefined;
  const message = store.findMessageByRunId(ctx.runId);
  if (!message) return undefined;
  const bot = store.getBot(message.botId);
  if (!bot) return undefined;
  return { bot, hopDepth: runner.hopDepthFor(ctx.runId) };
}

export function createBotsTools(deps: BotsToolDeps): AnyToolDefinition[] {
  const { store, runner } = deps;

  const list = defineTool<ListInput>({
    name: 'list_bots',
    description: 'The roster of named bots the agent can message.',
    inputSchema: ListInputSchema,
    sideEffecting: false,
    annotations: { title: 'List bots', readOnlyHint: true },
    handler() {
      return { bots: store.listBots(false).map(compactBot) };
    },
  });

  const message = defineTool<MessageInput>({
    name: 'message_bot',
    description:
      'Send a prompt to another bot by its id (from list_bots). It runs in ' +
      "the background and the result lands in THAT bot's thread. This is the " +
      'ONLY way to talk to another bot — do NOT use SendMessage (that reaches ' +
      'CLI teammate agents, not bots). Always call list_bots first to get ids.',
    inputSchema: MessageInputSchema,
    sideEffecting: true,
    summarize: (input) => `Message bot ${input.botId}.`,
    annotations: { title: 'Message a bot' },
    async handler(input, ctx) {
      const target = findBotById(store, input.botId);
      if (!target) {
        const roster = store
          .listBots(false)
          .map((b) => `${b.id} (${b.name})`)
          .join(', ');
        return {
          ok: false,
          error: `No bot with id "${input.botId}". Available: ${roster || 'none'}. Call list_bots for ids.`,
        };
      }

      const caller = resolveCaller(store, runner, ctx);
      if (caller && caller.bot.id === target.id) {
        return { ok: false, error: 'A bot cannot message itself.' };
      }

      const callerDepth = caller?.hopDepth ?? 0;
      if (callerDepth >= BOT_HOP_LIMIT) {
        return { ok: false, error: 'Bot-to-bot hop limit reached.' };
      }

      const result = await runner.sendToBot({
        botId: target.id,
        prompt: input.prompt,
        source: 'bot-to-bot',
        author: caller?.bot.name ?? 'bot',
        recordUserMessage: true,
        hopDepth: callerDepth + 1,
        fromBotName: caller?.bot.name,
      });

      return {
        ok: true,
        botId: result.botId,
        botName: target.name,
        runId: result.runId,
        accepted: result.accepted,
      };
    },
  });

  return [list, message];
}
