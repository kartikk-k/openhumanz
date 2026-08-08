/**
 * The live turn model.
 *
 * While a chat turn is running, the assistant's output arrives as a stream of
 * {@link ChatStreamEvent}s (text deltas, thinking, tool calls/results, subagent
 * boundaries). We fold those into the same block shape the transcript parser
 * produces ({@link ChatBlock}), so the UI renders a streaming turn with exactly
 * the same components it uses for saved history — no divergent rendering paths.
 *
 * When the turn ends the durable transcript file is re-read and this live turn
 * is discarded, so subagents shown live are ephemeral by design: they appear as
 * the Task runs and fold back into the call once it is on disk.
 */
import type { ChatStreamEvent } from '../../../shared/ipc';
import type {
  ChatBlock,
  ChatToolCall,
} from '../../../shared/claudeTranscript.fold';

export interface LiveTurn {
  /** Main-conversation blocks, in arrival order. */
  blocks: ChatBlock[];
  /** True until a `done` event arrives. */
  running: boolean;
  error: string | undefined;
}

export function emptyLiveTurn(): LiveTurn {
  return { blocks: [], running: true, error: undefined };
}

/** Find or create the tool call with `id` (searching subagents too). */
function findCall(turn: LiveTurn, id: string): ChatToolCall | undefined {
  for (const block of turn.blocks) {
    if (block.kind === 'tool') {
      if (block.call.id === id) return block.call;
      const nested = block.call.subagent?.blocks.find(
        (b) => b.kind === 'tool' && b.call.id === id,
      );
      if (nested && nested.kind === 'tool') return nested.call;
    }
  }
  return undefined;
}

/** The Task call hosting `subagentLabel`, so its steps nest under it. */
function subagentHostBlocks(
  turn: LiveTurn,
  label: string,
): ChatBlock[] | undefined {
  // Attach to the most recent Task tool call whose subagent label matches, or
  // the most recent Task call if none is labelled yet.
  let host: ChatToolCall | undefined;
  for (const block of turn.blocks) {
    if (block.kind === 'tool' && /task/i.test(block.call.name)) {
      host = block.call;
      if (block.call.subagent?.name === label) break;
    }
  }
  if (!host) return undefined;
  if (!host.subagent) host.subagent = { name: label, blocks: [] };
  return host.subagent.blocks;
}

/** Append accumulated text/thinking to the right block list, merging deltas. */
function appendProse(
  target: ChatBlock[],
  kind: 'text' | 'thinking',
  text: string,
  partial: boolean,
): void {
  const last = target[target.length - 1];
  if (last && last.kind === kind && partial) {
    // A delta continues the open streaming block.
    last.text += text;
    return;
  }
  if (last && last.kind === kind && !partial) {
    // A final replaces the deltas it summarises (the CLI repeats the whole
    // block as a non-partial after the deltas).
    last.text = text;
    return;
  }
  target.push({ kind, text });
}

/**
 * Fold one stream event into the live turn, mutating and returning a new turn
 * object (so React sees a change). The mutation is on a shallow clone — good
 * enough for a single in-flight turn.
 */
export function reduceLiveTurn(
  prev: LiveTurn,
  event: ChatStreamEvent,
): LiveTurn {
  const turn: LiveTurn = {
    blocks: prev.blocks.map((b) =>
      b.kind === 'tool' ? { ...b, call: cloneCall(b.call) } : { ...b },
    ),
    running: prev.running,
    error: prev.error,
  };

  const target =
    'subagent' in event && event.subagent
      ? (subagentHostBlocks(turn, event.subagent) ?? turn.blocks)
      : turn.blocks;

  switch (event.kind) {
    case 'text':
      appendProse(target, 'text', event.text, event.partial);
      break;
    case 'thinking':
      appendProse(target, 'thinking', event.text, event.partial);
      break;
    case 'tool-call':
      target.push({
        kind: 'tool',
        call: {
          id: event.id,
          name: event.name,
          input: event.input,
          result: null,
        },
      });
      break;
    case 'tool-result': {
      const call = findCall(turn, event.id);
      if (call) call.result = { ok: event.ok, text: event.text };
      break;
    }
    case 'subagent-start': {
      const call = findCall(turn, event.id);
      if (call && !call.subagent)
        call.subagent = { name: event.name, blocks: [] };
      break;
    }
    case 'subagent-end':
      // Nothing to do live: the steps stay until the file reload replaces them.
      break;
    case 'done':
      turn.running = false;
      turn.error = event.ok ? undefined : event.error;
      break;
    default:
      break;
  }
  return turn;
}

function cloneCall(call: ChatToolCall): ChatToolCall {
  return {
    ...call,
    subagent: call.subagent
      ? { name: call.subagent.name, blocks: [...call.subagent.blocks] }
      : undefined,
  };
}

/** True when the live turn has anything worth showing. */
export function liveTurnHasContent(turn: LiveTurn | null): boolean {
  return turn != null && (turn.blocks.length > 0 || turn.running);
}
