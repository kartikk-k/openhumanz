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
import type { ChatTurn } from '../../../../shared/claudeTranscript.fold';
import type { LiveTurn } from '../../chat/liveTurn';
import { blocksToText } from './settledText';

export type Role = 'user' | 'assistant';

export interface Turn {
  id: string;
  role: Role;
  text: string;
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
    const text = blocksToText(t.message.blocks);
    if (!text) return; // skip tool-only / empty turns for this text-only view
    turns.push({
      id: t.id,
      role: t.message.role,
      text,
      animate: false,
      done: true,
    });
  });

  if (pendingUserMessage) {
    turns.push({
      id: 'pending-user',
      role: 'user',
      text: pendingUserMessage,
      animate: false,
      done: true,
    });
  }

  if (liveTurn) {
    const text = blocksToText(liveTurn.blocks);
    if (text) {
      turns.push({
        id: 'live-assistant',
        role: 'assistant',
        text,
        animate: true,
        done: !liveTurn.running,
      });
    }
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
