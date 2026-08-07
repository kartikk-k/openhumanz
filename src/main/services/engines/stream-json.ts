/**
 * Claude Code's `--output-format stream-json` parser.
 *
 * One newline-delimited JSON object per stdout line. Everything in here is
 * written to survive a CLI upgrade: unknown top-level types become `raw`
 * events, unknown fields are ignored, malformed lines become a `log` event and
 * the stream continues. A parse error must never end a run — the alternative is
 * an app that breaks the week the CLI ships a new message type.
 *
 * Field names are read in both snake_case and camelCase because the CLI has
 * used both across versions (`total_cost_usd` alongside `modelUsage`).
 */
import { nowIso } from '../../../shared/common';
import type { JsonObject, Usage } from '../../../shared/common';
import type { EngineErrorKind, EngineEvent, ModelUsage } from './types';

/** Tool result payloads can be enormous; the transcript keeps the full text. */
export const TOOL_RESULT_PREVIEW_CHARS = 4000;

/* ------------------------------------------------------------------ */
/* Small readers                                                       */
/* ------------------------------------------------------------------ */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** First key present, tried in order. Tolerates snake_case/camelCase drift. */
function pick(source: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}

function readString(
  source: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  const value = pick(source, ...keys);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(
  source: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  const value = pick(source, ...keys);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function readInt(
  source: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  const value = readNumber(source, ...keys);
  return value === undefined ? undefined : Math.trunc(value);
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… [${text.length - limit} more characters]`;
}

/** Flatten anything the CLI might use for message content into plain text. */
export function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (!isObject(block)) return '';
        if (typeof block.text === 'string') return block.text;
        if (typeof block.thinking === 'string') return block.thinking;
        if (typeof block.content !== 'undefined') {
          return flattenContent(block.content);
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (isObject(content)) return flattenContent(content.content ?? '');
  return '';
}

/* ------------------------------------------------------------------ */
/* Usage                                                               */
/* ------------------------------------------------------------------ */

/** Anthropic-style usage block → our {@link Usage}. */
export function parseUsage(raw: unknown, model?: string): Usage {
  if (!isObject(raw)) return model ? { model } : {};
  const usage: Usage = {};
  if (model) usage.model = model;
  const input = readInt(raw, 'input_tokens', 'inputTokens');
  const output = readInt(raw, 'output_tokens', 'outputTokens');
  const cacheRead = readInt(
    raw,
    'cache_read_input_tokens',
    'cacheReadInputTokens',
    'cache_read_tokens',
  );
  const cacheCreate = readInt(
    raw,
    'cache_creation_input_tokens',
    'cacheCreationInputTokens',
    'cache_creation_tokens',
  );
  if (input !== undefined) usage.inputTokens = Math.max(0, input);
  if (output !== undefined) usage.outputTokens = Math.max(0, output);
  if (cacheRead !== undefined) usage.cacheReadTokens = Math.max(0, cacheRead);
  if (cacheCreate !== undefined) {
    usage.cacheCreationTokens = Math.max(0, cacheCreate);
  }
  return usage;
}

/**
 * `modelUsage` in the result line: a map of model name → per-model counters and
 * cost. This is the per-model cost the architecture asks to persist.
 */
export function parseModelUsage(raw: unknown): ModelUsage[] {
  if (!isObject(raw)) return [];
  const out: ModelUsage[] = [];
  for (const [model, value] of Object.entries(raw)) {
    if (!isObject(value)) continue;
    const entry: ModelUsage = { model };
    const input = readInt(value, 'inputTokens', 'input_tokens');
    const output = readInt(value, 'outputTokens', 'output_tokens');
    const cacheRead = readInt(
      value,
      'cacheReadInputTokens',
      'cache_read_input_tokens',
    );
    const cacheCreate = readInt(
      value,
      'cacheCreationInputTokens',
      'cache_creation_input_tokens',
    );
    const cost = readNumber(value, 'costUSD', 'costUsd', 'cost_usd');
    const web = readInt(value, 'webSearchRequests', 'web_search_requests');
    const context = readInt(value, 'contextWindow', 'context_window');
    if (input !== undefined) entry.inputTokens = input;
    if (output !== undefined) entry.outputTokens = output;
    if (cacheRead !== undefined) entry.cacheReadTokens = cacheRead;
    if (cacheCreate !== undefined) entry.cacheCreationTokens = cacheCreate;
    if (cost !== undefined) entry.costUsd = cost;
    if (web !== undefined) entry.webSearchRequests = web;
    if (context !== undefined) entry.contextWindow = context;
    out.push(entry);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Result classification                                               */
/* ------------------------------------------------------------------ */

/**
 * Map a result `subtype` onto an {@link EngineErrorKind}. Anything unrecognized
 * is `engine` rather than a guess, so a new subtype degrades to "the CLI failed
 * and here is what it said".
 */
export function classifyResultSubtype(
  subtype: string | undefined,
  isError: boolean,
): EngineErrorKind | undefined {
  if (!isError) return undefined;
  const value = (subtype ?? '').toLowerCase();
  if (value.includes('max_turns') || value.includes('maxturns')) {
    return 'max-turns';
  }
  if (value.includes('budget') || value.includes('cost')) return 'budget';
  if (value.includes('timeout')) return 'timeout';
  if (value.includes('auth') || value.includes('credential')) return 'auth';
  if (value.includes('cancel') || value.includes('abort')) return 'cancelled';
  return 'engine';
}

/** Best-effort classification of a free-text CLI failure. */
export function classifyErrorText(text: string): EngineErrorKind {
  const value = text.toLowerCase();
  if (
    value.includes('unauthorized') ||
    value.includes('authentication') ||
    value.includes('invalid api key') ||
    value.includes('please run /login') ||
    value.includes('not logged in')
  ) {
    return 'auth';
  }
  if (value.includes('credit balance') || value.includes('quota')) {
    return 'budget';
  }
  if (value.includes('unknown option') || value.includes('unknown command')) {
    return 'protocol';
  }
  if (value.includes('enoent') || value.includes('command not found')) {
    return 'not-installed';
  }
  return 'unknown';
}

/* ------------------------------------------------------------------ */
/* The parser                                                          */
/* ------------------------------------------------------------------ */

/**
 * Per-run state the parser needs across lines: the id→name map that lets a
 * `tool_result` report which tool it belongs to, since the CLI only sends the
 * id back.
 */
export interface StreamParserState {
  toolNames: Map<string, string>;
  sessionId?: string;
  model?: string;
}

export function createParserState(sessionId?: string): StreamParserState {
  return { toolNames: new Map(), sessionId };
}

/**
 * Parse one stdout line into zero or more normalized events.
 *
 * Never throws. A line that is not JSON, or is JSON we cannot make sense of,
 * comes back as a `log` or `raw` event so the run continues.
 */
export function parseStreamJsonLine(
  line: string,
  state: StreamParserState,
): EngineEvent[] {
  const trimmed = line.trim();
  if (trimmed === '') return [];

  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    // Not JSON. Some builds print a banner or a warning on stdout before the
    // stream starts; that is a log line, not a protocol failure.
    return [
      {
        at: nowIso(),
        type: 'log',
        level: 'debug',
        message: `non-JSON stdout: ${truncate(trimmed, 400)}`,
      },
    ];
  }

  if (!isObject(payload)) {
    return [{ at: nowIso(), type: 'raw', payload }];
  }

  const at = nowIso();
  const sessionId =
    readString(payload, 'session_id', 'sessionId') ?? state.sessionId;
  if (sessionId) state.sessionId = sessionId;

  switch (payload.type) {
    case 'system':
      return parseSystem(payload, state, at);
    case 'assistant':
      return parseAssistant(payload, state, at);
    case 'user':
      return parseUser(payload, state, at);
    case 'result':
      return parseResult(payload, state, at);
    case 'stream_event':
      return parseStreamEvent(payload, state, at);
    case 'error':
      return [
        {
          at,
          type: 'error',
          kind: classifyErrorText(
            readString(payload, 'message', 'error') ?? 'unknown error',
          ),
          message: readString(payload, 'message', 'error') ?? 'unknown error',
          detail: truncate(JSON.stringify(payload), 2000),
        },
      ];
    default:
      return [{ at, type: 'raw', payload }];
  }
}

function parseSystem(
  payload: Record<string, unknown>,
  state: StreamParserState,
  at: string,
): EngineEvent[] {
  if (payload.subtype !== 'init') {
    return [{ at, type: 'raw', payload }];
  }
  const sessionId = state.sessionId;
  if (!sessionId) return [{ at, type: 'raw', payload }];

  const model = readString(payload, 'model');
  if (model) state.model = model;

  const tools = Array.isArray(payload.tools)
    ? payload.tools.filter((t): t is string => typeof t === 'string')
    : undefined;

  const rawServers = pick(payload, 'mcp_servers', 'mcpServers');
  const mcpServers = Array.isArray(rawServers)
    ? rawServers.flatMap((entry) => {
        if (!isObject(entry)) return [];
        const name = readString(entry, 'name');
        if (!name) return [];
        return [{ name, status: readString(entry, 'status') }];
      })
    : undefined;

  return [
    {
      at,
      type: 'session',
      sessionId,
      model,
      cwd: readString(payload, 'cwd'),
      tools,
      mcpServers,
      permissionMode: readString(payload, 'permissionMode', 'permission_mode'),
      apiKeySource: readString(payload, 'apiKeySource', 'api_key_source'),
    },
  ];
}

function parseAssistant(
  payload: Record<string, unknown>,
  state: StreamParserState,
  at: string,
): EngineEvent[] {
  const message = isObject(payload.message) ? payload.message : undefined;
  if (!message) return [{ at, type: 'raw', payload }];

  const model = readString(message, 'model') ?? state.model;
  if (model) state.model = model;
  const parentToolUseId = readString(
    payload,
    'parent_tool_use_id',
    'parentToolUseId',
  );
  const events: EngineEvent[] = [];
  const content = Array.isArray(message.content)
    ? message.content
    : [message.content];

  for (const block of content) {
    if (typeof block === 'string') {
      if (block) {
        events.push({
          at,
          type: 'message',
          role: 'assistant',
          text: block,
          model,
          sessionId: state.sessionId,
          parentToolUseId,
        });
      }
      continue;
    }
    if (!isObject(block)) continue;

    if (block.type === 'text' && typeof block.text === 'string') {
      if (block.text.length > 0) {
        events.push({
          at,
          type: 'message',
          role: 'assistant',
          text: block.text,
          model,
          sessionId: state.sessionId,
          parentToolUseId,
        });
      }
    } else if (
      block.type === 'thinking' ||
      block.type === 'redacted_thinking'
    ) {
      const text =
        typeof block.thinking === 'string'
          ? block.thinking
          : '[redacted thinking]';
      events.push({
        at,
        type: 'thinking',
        text,
        sessionId: state.sessionId,
      });
    } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
      const toolCallId =
        readString(block, 'id') ?? `tool_${state.toolNames.size}`;
      const name = readString(block, 'name') ?? 'unknown';
      state.toolNames.set(toolCallId, name);
      events.push({
        at,
        type: 'tool.call',
        toolCallId,
        name,
        arguments: isObject(block.input) ? (block.input as JsonObject) : {},
        sessionId: state.sessionId,
        parentToolUseId,
      });
    }
  }

  const usage = parseUsage(message.usage, model);
  if (Object.keys(usage).length > (model ? 1 : 0)) {
    events.push({ at, type: 'usage', usage });
  }

  return events.length > 0 ? events : [{ at, type: 'raw', payload }];
}

function parseUser(
  payload: Record<string, unknown>,
  state: StreamParserState,
  at: string,
): EngineEvent[] {
  const message = isObject(payload.message) ? payload.message : undefined;
  if (!message) return [{ at, type: 'raw', payload }];

  const parentToolUseId = readString(
    payload,
    'parent_tool_use_id',
    'parentToolUseId',
  );
  const content = Array.isArray(message.content)
    ? message.content
    : [message.content];
  const events: EngineEvent[] = [];

  for (const block of content) {
    if (isObject(block) && block.type === 'tool_result') {
      const toolCallId =
        readString(block, 'tool_use_id', 'toolUseId') ?? 'unknown';
      events.push({
        at,
        type: 'tool.result',
        toolCallId,
        name: state.toolNames.get(toolCallId),
        isError: block.is_error === true || block.isError === true,
        content: truncate(
          flattenContent(block.content),
          TOOL_RESULT_PREVIEW_CHARS,
        ),
        sessionId: state.sessionId,
        parentToolUseId,
      });
    } else {
      const text =
        typeof block === 'string' ? block : flattenContent(block ?? '');
      if (text) {
        events.push({
          at,
          type: 'message',
          role: 'user',
          text,
          sessionId: state.sessionId,
          parentToolUseId,
        });
      }
    }
  }

  return events.length > 0 ? events : [{ at, type: 'raw', payload }];
}

function parseResult(
  payload: Record<string, unknown>,
  state: StreamParserState,
  at: string,
): EngineEvent[] {
  const subtype = readString(payload, 'subtype');
  const isError =
    payload.is_error === true ||
    payload.isError === true ||
    (subtype !== undefined && subtype !== 'success');

  const byModel = parseModelUsage(pick(payload, 'modelUsage', 'model_usage'));
  const turns = readInt(payload, 'num_turns', 'numTurns');
  const durationMs = readInt(payload, 'duration_ms', 'durationMs');
  const apiDurationMs = readInt(payload, 'duration_api_ms', 'durationApiMs');
  const totalCost = readNumber(
    payload,
    'total_cost_usd',
    'totalCostUsd',
    'cost_usd',
  );

  const usage: Usage = parseUsage(pick(payload, 'usage'), state.model);
  // Fall back to summing the per-model figures when the flat total is absent.
  const summedCost = byModel.reduce(
    (total, entry) => total + (entry.costUsd ?? 0),
    0,
  );
  const cost = totalCost ?? (byModel.length > 0 ? summedCost : undefined);
  if (cost !== undefined) usage.totalCostUsd = Math.max(0, cost);
  if (turns !== undefined) usage.turns = Math.max(0, turns);
  if (durationMs !== undefined) usage.durationMs = Math.max(0, durationMs);

  const text = readString(payload, 'result');
  const denials = pick(payload, 'permission_denials', 'permissionDenials');

  const events: EngineEvent[] = [
    {
      at,
      type: 'result',
      ok: !isError,
      subtype,
      sessionId: state.sessionId,
      turns,
      durationMs,
      apiDurationMs,
      usage,
      byModel,
      text,
      permissionDenials: Array.isArray(denials)
        ? denials.filter(isObject).map((entry) => entry as JsonObject)
        : undefined,
    },
  ];

  if (isError) {
    const kind = classifyResultSubtype(subtype, true) ?? 'engine';
    events.push({
      at,
      type: 'error',
      kind,
      message: text ?? `engine reported ${subtype ?? 'an error'}`,
      detail: subtype,
    });
  }

  return events;
}

/**
 * `--include-partial-messages` wraps raw SSE deltas. Text deltas become partial
 * `message` events so a UI can stream; everything else stays `raw` rather than
 * being invented into a shape we would then have to keep true.
 */
function parseStreamEvent(
  payload: Record<string, unknown>,
  state: StreamParserState,
  at: string,
): EngineEvent[] {
  const event = isObject(payload.event) ? payload.event : undefined;
  if (!event) return [{ at, type: 'raw', payload }];
  const delta = isObject(event.delta) ? event.delta : undefined;

  if (event.type === 'content_block_delta' && delta) {
    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      return [
        {
          at,
          type: 'message',
          role: 'assistant',
          text: delta.text,
          model: state.model,
          sessionId: state.sessionId,
          partial: true,
        },
      ];
    }
    if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      return [
        {
          at,
          type: 'thinking',
          text: delta.thinking,
          sessionId: state.sessionId,
          partial: true,
        },
      ];
    }
  }
  return [{ at, type: 'raw', payload }];
}
