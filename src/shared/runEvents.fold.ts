/**
 * Fold an orchestrator run transcript into the chat render model.
 *
 * `runs/<id>/transcript.jsonl` is app-owned {@link RunEvent} JSONL (line N is
 * seq N). It is not the Claude Code session file — `foldTranscript` would drop
 * every line. This reducer is the RunEvent → ChatBlock[] path the bot thread
 * (and anything else that wants to draw a run as a chat turn) uses.
 */
import { RunEventSchema, type RunEvent, type ToolCall } from './runs';
import type { ChatBlock, ChatToolCall } from './claudeTranscript.fold';

export type { ChatBlock } from './claudeTranscript.fold';

/** Parse a run transcript file. Malformed or unknown lines are skipped. */
export function parseRunTranscript(text: string): RunEvent[] {
  const events: RunEvent[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const parsed = RunEventSchema.safeParse(json);
    if (parsed.success) events.push(parsed.data);
  }
  return events;
}

function toolResultOf(call: ToolCall): ChatToolCall['result'] {
  if (
    call.status === 'pending' ||
    call.status === 'running' ||
    call.status === 'awaiting_approval'
  ) {
    return null;
  }
  const text = (call.resultSummary ?? call.error ?? '').trim();
  return {
    ok: call.status === 'succeeded',
    text,
  };
}

function toChatTool(call: ToolCall): ChatToolCall {
  return {
    id: call.id,
    name: call.name,
    input: call.arguments,
    result: toolResultOf(call),
  };
}

/**
 * Reduce a run's events into the blocks of one bot/assistant turn.
 *
 * User messages are omitted — the bot thread already recorded the prompt as
 * its own row. Consecutive assistant texts are merged so a streamed reply
 * does not become a stack of one-line bubbles.
 */
export function foldRunEvents(events: readonly RunEvent[]): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  const toolAt = new Map<string, number>();
  let fallback = '';

  const pushText = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const last = blocks[blocks.length - 1];
    if (last?.kind === 'text') {
      last.text = `${last.text}\n\n${trimmed}`;
      return;
    }
    blocks.push({ kind: 'text', text: trimmed });
  };

  for (const event of events) {
    if (event.type === 'message') {
      if (event.role === 'user') continue;
      pushText(event.text);
      continue;
    }

    if (event.type === 'tool.call' || event.type === 'tool.result') {
      const existing = toolAt.get(event.call.id);
      if (existing !== undefined) {
        const block = blocks[existing];
        if (block?.kind === 'tool') block.call = toChatTool(event.call);
        continue;
      }
      blocks.push({ kind: 'tool', call: toChatTool(event.call) });
      toolAt.set(event.call.id, blocks.length - 1);
      continue;
    }

    if (event.type === 'step.finished') {
      const summary = event.step.summary?.trim();
      if (summary) fallback = summary;
      const error = event.step.error?.trim();
      if (error && event.step.status === 'failed') fallback = error;
    }

    if (event.type === 'run.finished' && event.error) {
      fallback = event.error;
    }
  }

  if (blocks.length === 0 && fallback) {
    blocks.push({ kind: 'text', text: fallback });
  }

  return blocks;
}
