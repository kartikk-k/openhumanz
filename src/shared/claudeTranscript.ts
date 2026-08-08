/**
 * Zod schema for Claude Code session transcript JSONL.
 *
 * These are the `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` files the
 * CLI writes — one JSON object per line. We read them to render the chat UI, so
 * the schema's job is to be *lenient and forward-compatible*: the CLI's format
 * drifts between versions, new record and content types appear, and a single
 * unrecognised line must never nuke a whole transcript.
 *
 * Every object schema is `.passthrough()` so unknown fields survive, and there
 * is an explicit unknown-record fallback so a new top-level `type` parses as
 * "something we don't render yet" rather than throwing.
 *
 * The shapes here were derived from a real 4359-line transcript covering text,
 * thinking, tool calls, tool results, images, subagents (sidechains) and
 * attachments — see `.chat-jsonl-types.txt` at the repo root.
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Content items (message.content[])                                   */
/* ------------------------------------------------------------------ */

export const TextContentSchema = z
  .object({ type: z.literal('text'), text: z.string() })
  .passthrough();

export const ThinkingContentSchema = z
  .object({
    type: z.literal('thinking'),
    thinking: z.string(),
    signature: z.string().optional(),
  })
  .passthrough();

export const ToolUseContentSchema = z
  .object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.unknown().optional(),
    caller: z.unknown().optional(),
  })
  .passthrough();

export const ToolResultContentSchema = z
  .object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    // Content may be a plain string or an array of content blocks.
    content: z.union([z.string(), z.array(z.unknown())]).optional(),
    is_error: z.boolean().optional(),
  })
  .passthrough();

export const ImageContentSchema = z
  .object({ type: z.literal('image'), source: z.unknown() })
  .passthrough();

/** Anything with a `type` we don't model yet — kept, not dropped. */
export const UnknownContentSchema = z
  .object({ type: z.string() })
  .passthrough();

export const ContentItemSchema = z.union([
  TextContentSchema,
  ThinkingContentSchema,
  ToolUseContentSchema,
  ToolResultContentSchema,
  ImageContentSchema,
  UnknownContentSchema,
]);
export type ContentItem = z.infer<typeof ContentItemSchema>;
export type TextContent = z.infer<typeof TextContentSchema>;
export type ThinkingContent = z.infer<typeof ThinkingContentSchema>;
export type ToolUseContent = z.infer<typeof ToolUseContentSchema>;
export type ToolResultContent = z.infer<typeof ToolResultContentSchema>;
export type ImageContent = z.infer<typeof ImageContentSchema>;

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

/** user `.content` can be a bare string OR an array of content items. */
export const MessageContentSchema = z.union([
  z.string(),
  z.array(ContentItemSchema),
]);

export const InnerMessageSchema = z
  .object({
    role: z.enum(['assistant', 'user', 'system']).optional(),
    content: MessageContentSchema.optional(),
    model: z.string().optional(),
    id: z.string().optional(),
    stop_reason: z.string().nullable().optional(),
    usage: z.unknown().optional(),
  })
  .passthrough();
export type InnerMessage = z.infer<typeof InnerMessageSchema>;

/* ------------------------------------------------------------------ */
/* Top-level records                                                   */
/* ------------------------------------------------------------------ */

/** Fields common to the timeline records (assistant / user / attachment / …). */
const timelineBase = {
  uuid: z.string().optional(),
  parentUuid: z.string().nullable().optional(),
  sessionId: z.string().optional(),
  timestamp: z.string().optional(),
  isSidechain: z.boolean().optional(),
  cwd: z.string().optional(),
  gitBranch: z.string().optional(),
  userType: z.string().optional(),
  version: z.string().optional(),
  slug: z.string().optional(),
};

export const AssistantRecordSchema = z
  .object({
    type: z.literal('assistant'),
    message: InnerMessageSchema,
    requestId: z.string().optional(),
    attributionMcpServer: z.string().optional(),
    attributionMcpTool: z.string().optional(),
    attributionSkill: z.string().optional(),
    ...timelineBase,
  })
  .passthrough();
export type AssistantRecord = z.infer<typeof AssistantRecordSchema>;

export const UserRecordSchema = z
  .object({
    type: z.literal('user'),
    message: InnerMessageSchema,
    promptId: z.string().optional(),
    promptSource: z.string().optional(),
    isMeta: z.boolean().optional(),
    isCompactSummary: z.boolean().optional(),
    toolUseResult: z.unknown().optional(),
    sourceToolUseID: z.string().optional(),
    sourceToolAssistantUUID: z.string().optional(),
    ...timelineBase,
  })
  .passthrough();
export type UserRecord = z.infer<typeof UserRecordSchema>;

export const AgentNameRecordSchema = z
  .object({
    type: z.literal('agent-name'),
    agentName: z.string(),
    sessionId: z.string().optional(),
  })
  .passthrough();
export type AgentNameRecord = z.infer<typeof AgentNameRecordSchema>;

export const AiTitleRecordSchema = z
  .object({
    type: z.literal('ai-title'),
    aiTitle: z.string(),
    sessionId: z.string().optional(),
  })
  .passthrough();

export const AttachmentRecordSchema = z
  .object({
    type: z.literal('attachment'),
    attachment: z.unknown(),
    ...timelineBase,
  })
  .passthrough();

export const SystemRecordSchema = z
  .object({
    type: z.literal('system'),
    subtype: z.string().optional(),
    content: z.string().optional(),
    level: z.string().optional(),
    ...timelineBase,
  })
  .passthrough();

export const SummaryRecordSchema = z
  .object({
    type: z.literal('summary'),
    summary: z.string().optional(),
    leafUuid: z.string().optional(),
  })
  .passthrough();

/** A record whose `type` we don't model — preserved so nothing is lost. */
export const UnknownRecordSchema = z.object({ type: z.string() }).passthrough();
export type UnknownRecord = z.infer<typeof UnknownRecordSchema>;

/**
 * One transcript line. The known records are tried first; anything else falls
 * through to {@link UnknownRecordSchema}. Because every branch requires a
 * string `type`, a line with no `type` fails to parse and is dropped by the
 * caller — which is the correct treatment for a corrupt line.
 */
export const TranscriptRecordSchema = z.union([
  AssistantRecordSchema,
  UserRecordSchema,
  AgentNameRecordSchema,
  AiTitleRecordSchema,
  AttachmentRecordSchema,
  SystemRecordSchema,
  SummaryRecordSchema,
  UnknownRecordSchema,
]);
export type TranscriptRecord = z.infer<typeof TranscriptRecordSchema>;
