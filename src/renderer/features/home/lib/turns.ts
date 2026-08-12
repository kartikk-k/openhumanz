/**
 * Turn model + derivation for the home chat experience.
 *
 * The UI renders a flat list of turns built from the real chat store:
 *   - past turns from the durable transcript (settled, not re-streamed),
 *   - the just-asked question from `pendingUserMessage` (optimistic),
 *   - the streaming answer from `liveTurn` (the only turn that animates).
 * The store clears pending/live once the durable transcript carries them, so
 * there's no double-render at the handoff.
 */
import type {
  ChatBlock,
  ChatTurn,
} from '../../../../shared/claudeTranscript.fold';
import type { LiveTurn } from '../../chat/liveTurn';
import { blocksToText } from './settledText';
import { parseTags } from './tags';

export type Role = 'user' | 'assistant';

export interface Turn {
  id: string;
  role: Role;
  /** flattened plain text — used for the user question's shrink-to-fit hero. */
  text: string;
  /** full blocks (markdown text, thinking, tool calls, sub-agents) — used to
   *  render an assistant answer with proper formatting. */
  blocks: ChatBlock[];
  /** stream the text in (true) or show it settled instantly (past turns). */
  animate: boolean;
  done: boolean;
  /** optional shape preset for assistant turns (question/approval/etc.) */
  shape?: string;
}

/** orb rests centered when ambient, drops toward the BOTTOM once in a chat.
 * uCenter.y is in WebGL UV space: 1 = top of screen, 0 = bottom. So a SMALLER
 * y sits lower. Ambient ~middle, chat ~lower third. */
export const CENTER_AMBIENT: [number, number] = [0.5, 0.55];
export const CENTER_CHAT: [number, number] = [0.5, 0.18];

/** Build the flat Turn[] the UI renders from the real chat store state. */
export function buildTurns(
  transcriptTurns: ChatTurn[],
  pendingUserMessage: string | null,
  liveTurn: LiveTurn | null,
): Turn[] {
  const turns: Turn[] = [];

  transcriptTurns.forEach((t) => {
    const isUser = t.message.role === 'user';
    const text = blocksToText(t.message.blocks);
    // Assistant turns can be tool-only (no text) but still worth showing; user
    // turns with no text are skipped (nothing to display).
    if (isUser && !text) return;
    if (!isUser && t.message.blocks.length === 0) return;
    turns.push({
      id: t.id,
      role: t.message.role,
      text,
      blocks: t.message.blocks,
      animate: false,
      done: true,
    });
  });

  if (pendingUserMessage) {
    turns.push({
      id: 'pending-user',
      role: 'user',
      text: pendingUserMessage,
      blocks: [{ kind: 'text', text: pendingUserMessage }],
      animate: false,
      done: true,
    });
  }

  if (liveTurn && liveTurn.blocks.length > 0) {
    turns.push({
      id: 'live-assistant',
      role: 'assistant',
      text: blocksToText(liveTurn.blocks),
      blocks: liveTurn.blocks,
      animate: true,
      done: !liveTurn.running,
    });
  }

  return turns;
}

/**
 * Group a flat turn list into exchanges. Each user turn opens a new exchange;
 * assistant turns attach to the current one. This lets each Q+A pair own a full
 * viewport height so scrolling steps cleanly between conversations.
 */
export function groupExchanges(turns: Turn[]): Turn[][] {
  const groups: Turn[][] = [];
  turns.forEach((turn) => {
    if (turn.role === 'user' || groups.length === 0) {
      groups.push([turn]);
    } else {
      groups[groups.length - 1].push(turn);
    }
  });
  return groups;
}

/**
 * True when `turn` is an ASSISTANT turn whose tagged output ends by awaiting the
 * user — i.e. its parsed tags include an `[openhumanz-ask]…[/openhumanz-ask]`
 * (a direct question) or an `[openhumanz-card/confirm …/]` (a draft awaiting
 * confirmation). These are the shapes that hand control back to the user, so a
 * following user turn is a reply within the same thread rather than a new one.
 */
export function awaitsUserInput(turn: Turn): boolean {
  if (turn.role !== 'assistant') return false;
  return parseTags(turn.text).some(
    (node) =>
      node.kind === 'ask' ||
      (node.kind === 'card' && node.cardType === 'confirm'),
  );
}

/**
 * Group a flat turn list into intent-threads.
 *
 * Unlike {@link groupExchanges} (which opens a new group on every user turn), a
 * thread models a single conversational INTENT, so a follow-up stays on the same
 * screen instead of jumping to a fresh one.
 *
 * Rule:
 *   - A user turn normally opens a NEW thread.
 *   - EXCEPT when the immediately-preceding turn is an assistant turn that ends
 *     by awaiting the user (see {@link awaitsUserInput}: an ask tag or a confirm
 *     card). Then this user turn is the user RESPONDING to that ask/draft, so it
 *     CONTINUES the current thread instead of opening a new one.
 *   - Assistant turns always attach to the current thread.
 *   - The first turn always opens a thread.
 */
export function groupThreads(turns: Turn[]): Turn[][] {
  const groups: Turn[][] = [];
  turns.forEach((turn, i) => {
    const prev = i > 0 ? turns[i - 1] : null;
    const continuesThread =
      turn.role === 'user' && prev !== null && awaitsUserInput(prev);
    if (groups.length === 0 || (turn.role === 'user' && !continuesThread)) {
      groups.push([turn]);
    } else {
      groups[groups.length - 1].push(turn);
    }
  });
  return groups;
}
