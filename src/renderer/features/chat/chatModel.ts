/**
 * Folds a run's raw event stream into the handful of things a chat bubble
 * needs: the assistant's prose, which tools it reached for, whether it is
 * waiting on an approval, and how the turn ended.
 *
 * A "turn" here is one run: the user typed something, the app started a run
 * (continuing the previous session so context carries), and the assistant's
 * `message` events are its reply. Everything else — tool calls, approvals,
 * completion — is surfaced as quiet status under the reply, because a chat that
 * hides its tool use is a chat you cannot trust.
 */
import type { RunEvent, RunStatus } from '../../../shared/runs';

export interface ChatToolActivity {
  id: string;
  name: string;
  /** 'running' until a matching tool.result arrives. */
  state: 'running' | 'done' | 'error';
}

export interface AssistantTurn {
  /** Concatenated assistant prose, in order. */
  text: string;
  tools: ChatToolActivity[];
  /** An approval is blocking the turn — the user must act in Approvals. */
  awaitingApproval: boolean;
  status: RunStatus | 'running';
  /** Verbatim error if the run failed. */
  error: string | undefined;
}

const TERMINAL: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled'];

/** Fold one run's events into a render model for its assistant turn. */
export function foldTurn(events: RunEvent[]): AssistantTurn {
  let text = '';
  const tools = new Map<string, ChatToolActivity>();
  let awaitingApproval = false;
  let status: AssistantTurn['status'] = 'running';
  let error: string | undefined;

  for (const event of events) {
    switch (event.type) {
      case 'message':
        // Only the assistant's own words go in the bubble. The user's message
        // is rendered from what they typed, not echoed back from the stream.
        if (event.role === 'assistant' && event.text) {
          text += (text ? '\n' : '') + event.text;
        }
        break;
      case 'tool.call':
        tools.set(event.call.id, {
          id: event.call.id,
          name: event.call.name,
          state: 'running',
        });
        break;
      case 'tool.result': {
        const failed =
          event.call.status === 'failed' || event.call.status === 'denied';
        tools.set(event.call.id, {
          id: event.call.id,
          name: event.call.name,
          state: failed ? 'error' : 'done',
        });
        break;
      }
      case 'approval.requested':
        awaitingApproval = true;
        break;
      case 'approval.resolved':
        awaitingApproval = false;
        break;
      case 'run.finished':
        status = event.status;
        error = event.error;
        break;
      default:
        break;
    }
  }

  if (status === 'running' && awaitingApproval) {
    // Still running, but blocked on the human.
  }

  return {
    text,
    tools: Array.from(tools.values()),
    awaitingApproval,
    status,
    error,
  };
}

/** Has this run reached a terminal state? */
export function isTurnDone(status: AssistantTurn['status']): boolean {
  return status !== 'running' && TERMINAL.includes(status as RunStatus);
}
