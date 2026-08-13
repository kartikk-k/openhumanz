/**
 * Bots — named agents, each with its own persistent chat thread.
 *
 * A bot is an identity (name, colour, system prompt) plus a scope (allowed
 * tools, a workspace directory) and a thread of messages. The "Main" bot is the
 * home chat promoted to a first-class bot; it is seeded on first run and cannot
 * be deleted.
 *
 * A bot turn runs as a background orchestrator run — it survives switching or
 * closing the thread — and its transcript is folded into {@link ChatBlock}s for
 * rendering. The blocks are reused wholesale from the chat transcript fold so a
 * bot message renders with exactly the same components as a chat turn.
 */
import { z } from 'zod';
import {
  IdSchema,
  IsoDateTimeSchema,
  JsonObjectSchema,
  patchSchema,
} from './common';
import type { ChatBlock } from './claudeTranscript.fold';

/**
 * The render blocks stored on a {@link BotMessage}.
 *
 * These are the exact `ChatBlock[]` produced by {@link foldTranscript} — text,
 * thinking, and tool calls with results. Re-exported here so a caller can lean
 * on the bots surface without also importing the transcript parser, and so this
 * file names the reused shape explicitly rather than re-declaring it.
 */
export type { ChatBlock } from './claudeTranscript.fold';

/** The fixed id of the seeded, non-deletable "Main" bot. */
export const MAIN_BOT_ID = 'bot_main';
export const MAIN_BOT_NAME = 'Main';

/* ------------------------------------------------------------------ */
/* Bot                                                                 */
/* ------------------------------------------------------------------ */

export const BotSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  /** A CSS colour (hex or token) for the bot's avatar. */
  avatarColor: z.string().default('#6366f1'),
  /**
   * The bot's identity prompt. Prepended to the run prompt on every turn so the
   * agent speaks as this bot. Empty for a plain bot with no special persona.
   */
  systemPrompt: z.string().default(''),
  /**
   * Tools this bot's turns may reach. Empty means "the default set" — the
   * thread runner leaves the run's allowlist unset so the orchestrator's
   * defaults apply, rather than scoping it to nothing.
   */
  allowedTools: z.array(z.string()).default([]),
  /** The cwd a bot's runs execute in. Defaults to the bot's own subdirectory. */
  workspaceDir: z.string().default(''),
  /** Archived bots are hidden from the roster but keep their thread. */
  archived: z.boolean().default(false),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  metadata: JsonObjectSchema.default({}),
});
export type Bot = z.infer<typeof BotSchema>;

export const BotCreateSchema = BotSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).partial({
  avatarColor: true,
  systemPrompt: true,
  allowedTools: true,
  workspaceDir: true,
  archived: true,
  metadata: true,
});
export type BotCreate = z.infer<typeof BotCreateSchema>;
export type BotCreateInput = z.input<typeof BotCreateSchema>;

/**
 * A patch. {@link patchSchema}, not `.partial()` — the same hazard as the
 * scheduled-job patch: `.partial()` would have `parse({ id })` come back with
 * `archived: false`, `allowedTools: []`, etc., so renaming a bot would silently
 * un-archive it and wipe its tool scope.
 */
export const BotUpdateSchema = patchSchema(
  BotSchema.omit({ createdAt: true, updatedAt: true }),
).extend({ id: IdSchema });
export type BotUpdate = z.infer<typeof BotUpdateSchema>;
export type BotUpdateInput = z.input<typeof BotUpdateSchema>;

/* ------------------------------------------------------------------ */
/* Bot message                                                         */
/* ------------------------------------------------------------------ */

export const BOT_MESSAGE_ROLES = ['user', 'bot', 'system'] as const;
export const BotMessageRoleSchema = z.enum(BOT_MESSAGE_ROLES);
export type BotMessageRole = z.infer<typeof BotMessageRoleSchema>;

/** How a message came to be, for filtering and display. */
export const BOT_MESSAGE_SOURCES = ['chat', 'schedule', 'bot-to-bot'] as const;
export const BotMessageSourceSchema = z.enum(BOT_MESSAGE_SOURCES);
export type BotMessageSource = z.infer<typeof BotMessageSourceSchema>;

/**
 * One message in a bot's thread.
 *
 * `blocks` is the folded render model — the same `ChatBlock[]` the chat UI
 * draws. A `bot` message backed by a live run starts with an empty (or
 * placeholder) block list and is patched as the run's transcript grows.
 */
export const BotMessageSchema = z.object({
  id: IdSchema,
  botId: IdSchema,
  role: BotMessageRoleSchema,
  /** Display name of the author (the user, the bot, or the sending bot). */
  author: z.string().default(''),
  /**
   * The render blocks. Typed as unknown-passthrough here so this shared schema
   * does not pull the transcript parser's zod in; callers treat it as
   * {@link ChatBlock}[]. The store round-trips it as JSON.
   */
  blocks: z.array(z.unknown()).default([]),
  /** The background run backing a `bot` message, while it streams and after. */
  runId: IdSchema.optional(),
  source: BotMessageSourceSchema.default('chat'),
  createdAt: IsoDateTimeSchema,
});
export type BotMessageRow = z.infer<typeof BotMessageSchema>;

/**
 * A {@link BotMessageRow} with its blocks typed as the real render model. The
 * store validates the row shape with {@link BotMessageSchema} and then casts
 * the blocks to this; the UI consumes this type.
 */
export interface BotMessage extends Omit<BotMessageRow, 'blocks'> {
  blocks: ChatBlock[];
}

/** Input for appending a message. Id and timestamp are minted by the store. */
export const BotMessageCreateSchema = BotMessageSchema.omit({
  id: true,
  createdAt: true,
}).partial({
  author: true,
  blocks: true,
  source: true,
});
export type BotMessageCreate = z.infer<typeof BotMessageCreateSchema>;
export type BotMessageCreateInput = z.input<typeof BotMessageCreateSchema>;

/* ------------------------------------------------------------------ */
/* Queries and requests                                               */
/* ------------------------------------------------------------------ */

/** Options for listing a thread. */
export const BotMessagesQuerySchema = z.object({
  botId: IdSchema,
  limit: z.number().int().positive().max(500).default(200),
  offset: z.number().int().nonnegative().default(0),
});
export type BotMessagesQuery = z.infer<typeof BotMessagesQuerySchema>;
export type BotMessagesQueryInput = z.input<typeof BotMessagesQuerySchema>;

/** The renderer sending a message to a bot. */
export const BotSendRequestSchema = z.object({
  botId: IdSchema,
  prompt: z.string().min(1),
  /** Where the message originated. Defaults to the chat surface. */
  source: BotMessageSourceSchema.default('chat'),
  /** Author label for the user's message. */
  author: z.string().default(''),
});
export type BotSendRequest = z.infer<typeof BotSendRequestSchema>;
export type BotSendRequestInput = z.input<typeof BotSendRequestSchema>;

/** Ack for a send: the user message plus the placeholder bot message. */
export interface BotSendResult {
  botId: string;
  /** The bot's placeholder message that will stream in, if a run was started. */
  runId: string | null;
  accepted: boolean;
}

/** A bot with its unread count, for the roster. */
export interface BotWithUnread extends Bot {
  unread: number;
  lastReadAt: string | null;
  /** First text block of the latest message, trimmed to ~80 chars. */
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
}

/** Mark a thread read up to an instant. */
export const BotMarkReadRequestSchema = z.object({
  botId: IdSchema,
  /** ISO instant to mark read up to. Defaults to now on the main side. */
  atIso: IsoDateTimeSchema.optional(),
});
export type BotMarkReadRequest = z.infer<typeof BotMarkReadRequestSchema>;
export type BotMarkReadRequestInput = z.input<typeof BotMarkReadRequestSchema>;
