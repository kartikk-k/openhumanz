/**
 * Normalize the engine's event stream into the compact {@link ChatStreamEvent}
 * the renderer needs for live rendering.
 *
 * The engine emits rich, low-level events (`message` with `partial` deltas,
 * `thinking`, `tool.call`, `tool.result`, `result`, `error`, plus bookkeeping
 * we don't surface). The UI only needs: text deltas, thinking deltas, tool
 * calls/results, subagent boundaries, and the terminal done/error. This keeps
 * that mapping in one pure place so the module stays a thin wire.
 *
 * Subagent attribution: engine events from a subagent's inner loop carry a flag
 * (a `subagent`/`sidechain` marker or a distinct sessionId); we pass a label
 * through so the UI can nest live subagent steps under the Task call and drop
 * them when the turn ends — subagents are ephemeral by design.
 */
import type { ChatStreamEvent } from '../../../shared/ipc';

/** The subset of engine-event fields we read. Kept loose to survive changes. */
interface RawEngineEvent {
  type: string;
  text?: string;
  partial?: boolean;
  toolCallId?: string;
  name?: string;
  input?: unknown;
  /** Claude Code calls tool arguments `arguments` in engine events. */
  arguments?: unknown;
  ok?: boolean;
  error?: string;
  result?: string;
  content?: unknown;
  /** Set by the adapter when the event came from a subagent's inner loop. */
  subagent?: string;
  isSidechain?: boolean;
  agentName?: string;
}

/** A short label for a subagent event, or undefined for the main loop. */
function subagentLabel(e: RawEngineEvent): string | undefined {
  if (typeof e.subagent === 'string' && e.subagent) return e.subagent;
  if (e.isSidechain && typeof e.agentName === 'string') return e.agentName;
  if (e.isSidechain) return 'subagent';
  return undefined;
}

/**
 * Map one engine event to zero or one {@link ChatStreamEvent}. Returns null for
 * events the UI does not render (usage, logs, raw, engine.started/finished).
 */
export function normalizeStreamEvent(raw: unknown): ChatStreamEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as RawEngineEvent;
  const subagent = subagentLabel(e);

  switch (e.type) {
    case 'message':
      if (typeof e.text !== 'string' || e.text.length === 0) return null;
      return {
        kind: 'text',
        text: e.text,
        partial: e.partial === true,
        subagent,
      };

    case 'thinking':
      if (typeof e.text !== 'string' || e.text.length === 0) return null;
      return {
        kind: 'thinking',
        text: e.text,
        partial: e.partial === true,
        subagent,
      };

    case 'tool.call':
      return {
        kind: 'tool-call',
        id: e.toolCallId ?? '',
        name: e.name ?? 'tool',
        // Engine events use `arguments`; keep accepting `input` for adapters
        // that already use the renderer-facing name. The activity chip needs
        // these values to describe generic router tools (e.g. Slack reads).
        input: e.input ?? e.arguments,
        subagent,
      };

    case 'tool.result':
      return {
        kind: 'tool-result',
        id: e.toolCallId ?? '',
        ok: e.ok !== false,
        text:
          typeof e.result === 'string' ? e.result : flattenContent(e.content),
        subagent,
      };

    case 'result':
      return { kind: 'done', ok: e.ok !== false, error: e.error };

    case 'error':
      return { kind: 'done', ok: false, error: e.error ?? 'The turn failed.' };

    default:
      return null;
  }
}

/** Flatten a tool result's content array/string to plain text. */
function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object') {
      const b = block as { type?: unknown; text?: unknown };
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    } else if (typeof block === 'string') {
      parts.push(block);
    }
  }
  return parts.join('\n');
}
