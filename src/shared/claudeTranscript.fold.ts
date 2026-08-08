/**
 * Parse and fold a Claude Code transcript into a render model for the chat UI.
 *
 * Pure — no node/electron imports — so it runs in tests and could run in the
 * renderer. The main process reads the file and hands the text in.
 *
 * The fold turns a flat, interleaved event log into an ordered list of
 * conversational blocks:
 *
 *   - user text (with a note when images/attachments were part of the turn)
 *   - assistant text
 *   - assistant thinking (kept as its own block so the UI can collapse it)
 *   - tool calls, each with its result matched back by id, and — for the Task
 *     tool — the subagent's own steps grouped underneath (from the sidechain
 *     records the CLI writes with `isSidechain: true`).
 *
 * Matching is by id, not by position: `tool_result.tool_use_id` points at the
 * `tool_use.id` that produced it, and those can be far apart in the stream.
 */
import {
  ContentItemSchema,
  TranscriptRecordSchema,
  type ContentItem,
  type TextContent,
  type ThinkingContent,
  type ToolResultContent,
  type ToolUseContent,
  type TranscriptRecord,
} from './claudeTranscript';

/* ------------------------------------------------------------------ */
/* Render model                                                        */
/* ------------------------------------------------------------------ */

export interface ChatToolResult {
  ok: boolean;
  /** Flattened text of the result, ready to show (may be long). */
  text: string;
}

export interface ChatToolCall {
  id: string;
  name: string;
  input: unknown;
  result: ChatToolResult | null;
  /** For the Task tool: the subagent's own folded steps. */
  subagent?: {
    name: string | undefined;
    blocks: ChatBlock[];
  };
}

export type ChatBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; call: ChatToolCall };

export interface ChatMessage {
  role: 'user' | 'assistant';
  /** ISO timestamp of the record, if present. */
  at: string | undefined;
  blocks: ChatBlock[];
  /** True when the user's turn carried images/attachments. */
  hasAttachments: boolean;
}

export interface ChatTurn {
  /** Stable-ish key for React lists. */
  id: string;
  message: ChatMessage;
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

/** Parse one JSONL line. Returns null for blank or invalid lines. */
export function parseTranscriptLine(line: string): TranscriptRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const parsed = TranscriptRecordSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** Parse a whole transcript file's text into records, dropping bad lines. */
export function parseTranscript(text: string): TranscriptRecord[] {
  const out: TranscriptRecord[] = [];
  for (const line of text.split('\n')) {
    const record = parseTranscriptLine(line);
    if (record) out.push(record);
  }
  return out;
}

/** The latest `ai-title` in the transcript, if any. */
export function latestSessionTitle(
  records: TranscriptRecord[],
): string | undefined {
  let title: string | undefined;
  for (const record of records) {
    if (record.type === 'ai-title' && typeof record.aiTitle === 'string') {
      title = record.aiTitle;
    }
  }
  return title;
}

/* ------------------------------------------------------------------ */
/* Folding                                                             */
/* ------------------------------------------------------------------ */

/** Read `.message.content` off any record without fighting the union type. */
function messageContent(record: TranscriptRecord): unknown {
  const message = (record as { message?: { content?: unknown } }).message;
  return message?.content;
}

function recordString(
  record: TranscriptRecord,
  key: string,
): string | undefined {
  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function contentItems(content: unknown): ContentItem[] {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const items: ContentItem[] = [];
  for (const raw of content) {
    const parsed = ContentItemSchema.safeParse(raw);
    if (parsed.success) items.push(parsed.data);
  }
  return items;
}

/** Flatten a tool_result's content into displayable text. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object') {
      const b = block as { type?: unknown; text?: unknown };
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      else parts.push(JSON.stringify(block));
    } else if (typeof block === 'string') {
      parts.push(block);
    }
  }
  return parts.join('\n');
}

/** True for records that belong to the main conversation (not a subagent). */
function isMain(record: TranscriptRecord): boolean {
  return !('isSidechain' in record) || record.isSidechain !== true;
}

/**
 * Fold records into the ordered chat turns.
 *
 * Two passes conceptually, one loop:
 *   1. index every tool_result by its `tool_use_id`, and collect sidechain
 *      records so subagent steps can be attached to their spawning Task call.
 *   2. walk the main-conversation messages in order, building blocks and
 *      wiring each tool_use to its result (and, for Task calls, its subagent).
 */
export function foldTranscript(records: TranscriptRecord[]): ChatTurn[] {
  // tool_use_id -> result
  const resultsById = new Map<string, ChatToolResult>();

  for (const record of records) {
    if (record.type === 'user' || record.type === 'assistant') {
      const items = contentItems(messageContent(record));
      for (const item of items) {
        if (item.type === 'tool_result') {
          const tr = item as ToolResultContent;
          resultsById.set(tr.tool_use_id, {
            ok: tr.is_error !== true,
            text: resultText(tr.content),
          });
        }
      }
    }
  }

  const turns: ChatTurn[] = [];
  let index = 0;
  for (const record of records) {
    if (record.type !== 'user' && record.type !== 'assistant') continue;
    // Sidechain records (subagent steps) are never inline in current Claude
    // versions — they live in separate files — but guard anyway.
    if (!isMain(record)) continue;

    const role = record.type === 'user' ? 'user' : 'assistant';
    const items = contentItems(messageContent(record));
    // A user "message" that is only a tool_result is the CLI echoing a result
    // back to the model — not something the human typed. Skip those.
    if (role === 'user' && items.every((i) => i.type === 'tool_result')) {
      continue;
    }

    const blocks: ChatBlock[] = [];
    pushBlocks(blocks, items, resultsById);
    if (blocks.length === 0) continue;

    const hasAttachments = items.some((i) => i.type === 'image');
    index += 1;
    turns.push({
      id: recordString(record, 'uuid') ?? `turn-${index}`,
      message: {
        role,
        at: recordString(record, 'timestamp'),
        blocks,
        hasAttachments,
      },
    });
  }

  return turns;
}

/**
 * One subagent's transcript, as read from
 * `<projectDir>/<sessionId>/subagents/agent-*.jsonl` plus its `.meta.json`.
 */
export interface SubagentTranscript {
  /** The parent `tool_use.id` this subagent was spawned from (meta.toolUseId). */
  toolUseId?: string;
  /** Display label — the agent type and/or its task description. */
  name?: string;
  records: TranscriptRecord[];
}

/**
 * Fold the main transcript, then attach each subagent's folded blocks to the
 * Task `tool_use` that spawned it.
 *
 * Linkage is by id: the subagent's `meta.toolUseId` equals the main
 * conversation's `tool_use.id`. When a subagent has no usable id (older
 * transcripts), it falls back to the Nth un-attached Task call in order.
 */
export function foldTranscriptWithSubagents(
  main: TranscriptRecord[],
  subagents: SubagentTranscript[],
): ChatTurn[] {
  const turns = foldTranscript(main);

  // Index every tool call in the folded output by its id, and keep an ordered
  // list of Task calls for the fallback path.
  const callById = new Map<string, ChatToolCall>();
  const taskCalls: ChatToolCall[] = [];
  for (const turn of turns) {
    for (const block of turn.message.blocks) {
      if (block.kind === 'tool') {
        callById.set(block.call.id, block.call);
        if (/task/i.test(block.call.name)) taskCalls.push(block.call);
      }
    }
  }

  let fallbackIndex = 0;
  for (const sub of subagents) {
    const blocks = foldTranscriptToBlocks(sub.records);
    const byId = sub.toolUseId ? callById.get(sub.toolUseId) : undefined;
    const target = byId ?? taskCalls[fallbackIndex];
    if (!byId) fallbackIndex += 1;
    if (target) {
      target.subagent = { name: sub.name, blocks };
    }
  }

  return turns;
}

/** Fold a (subagent) transcript into a flat block list, ignoring turn grouping. */
function foldTranscriptToBlocks(records: TranscriptRecord[]): ChatBlock[] {
  const resultsById = new Map<string, ChatToolResult>();
  for (const record of records) {
    if (record.type === 'user' || record.type === 'assistant') {
      for (const item of contentItems(messageContent(record))) {
        if (item.type === 'tool_result') {
          const tr = item as ToolResultContent;
          resultsById.set(tr.tool_use_id, {
            ok: tr.is_error !== true,
            text: resultText(tr.content),
          });
        }
      }
    }
  }
  const blocks: ChatBlock[] = [];
  for (const record of records) {
    if (record.type !== 'user' && record.type !== 'assistant') continue;
    const items = contentItems(messageContent(record));
    if (
      record.type === 'user' &&
      items.every((i) => i.type === 'tool_result')
    ) {
      continue;
    }
    pushBlocks(blocks, items, resultsById);
  }
  return blocks;
}

/** Turn content items into render blocks, wiring tool results by id. */
function pushBlocks(
  out: ChatBlock[],
  items: ContentItem[],
  resultsById: Map<string, ChatToolResult>,
): void {
  for (const item of items) {
    if (item.type === 'text') {
      const text = (item as TextContent).text;
      if (text.trim()) out.push({ kind: 'text', text });
    } else if (item.type === 'thinking') {
      const text = (item as ThinkingContent).thinking;
      if (text.trim()) out.push({ kind: 'thinking', text });
    } else if (item.type === 'tool_use') {
      const call = item as ToolUseContent;
      out.push({
        kind: 'tool',
        call: {
          id: call.id,
          name: call.name,
          input: call.input,
          result: resultsById.get(call.id) ?? null,
        },
      });
    }
  }
}
