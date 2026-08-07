/**
 * Bridge from the engine's stream to `shared/runs.ts`'s `RunEvent`.
 *
 * `RunEvent` carries `runId` and a monotonic `seq`, and neither is knowable to
 * an adapter driving a CLI — the run identity and the sequence numbering belong
 * to the orchestrator, which is also the thing that has to keep `seq` gapless
 * across steps and across a reconnect. So the adapter emits `EngineEvent` and
 * the orchestrator stamps it here.
 *
 * Not every engine event has a `RunEvent` counterpart. `raw` and `thinking`
 * have none by design: they belong in the transcript, not on the timeline.
 * {@link toRunEvents} drops them rather than inventing a variant, and
 * `unmapped` counts them so a caller can tell "nothing to show" from "we lost
 * something".
 */
import { nowIso } from '../../../shared/common';
import type { Usage } from '../../../shared/common';
import type { RunEvent, ToolCall } from '../../../shared/runs';
import type { EngineEvent } from './types';

export interface RunEventContext {
  runId: string;
  /** Attached to messages, tool calls and usage so the timeline can nest them. */
  stepId?: string;
  /**
   * Next sequence number to use. The mapper advances it, so the same context
   * object can be passed across batches and the numbering stays monotonic.
   */
  seq: number;
  /**
   * Emit partial (streaming delta) messages too. Off by default: a timeline
   * that stores every delta stores the same text twice.
   */
  includePartial?: boolean;
  /**
   * Marks a tool call as side-effecting on the persisted row. The approval gate
   * reads the MCP server's own flag, not this one; this is for display.
   */
  isSideEffecting?(toolName: string): boolean;
}

/** Started tool calls, so a result can be turned into a complete `ToolCall`. */
export type ToolCallIndex = Map<string, ToolCall>;

export interface MappedRunEvents {
  events: RunEvent[];
  /** Engine events with no timeline counterpart. Kept in the transcript only. */
  unmapped: number;
}

/**
 * Map a batch of engine events onto run events, stamping `runId` and `seq`.
 *
 * `index` must be the same map across a whole run: `tool.result` looks up the
 * call it completes so the emitted `ToolCall` has its name, arguments and
 * duration filled in rather than being a bare id.
 */
export function toRunEvents(
  engineEvents: Iterable<EngineEvent>,
  context: RunEventContext,
  index: ToolCallIndex = new Map(),
): MappedRunEvents {
  const events: RunEvent[] = [];
  let unmapped = 0;

  const next = (): number => {
    const value = context.seq;
    context.seq += 1;
    return value;
  };

  for (const event of engineEvents) {
    switch (event.type) {
      case 'message': {
        if (event.partial && !context.includePartial) {
          unmapped += 1;
          break;
        }
        events.push({
          type: 'message',
          runId: context.runId,
          seq: next(),
          at: event.at,
          stepId: context.stepId,
          role: event.role,
          text: event.text,
        });
        break;
      }

      case 'tool.call': {
        const call: ToolCall = {
          id: event.toolCallId,
          runId: context.runId,
          stepId: context.stepId,
          name: event.name,
          arguments: event.arguments,
          sideEffecting: context.isSideEffecting?.(event.name) ?? false,
          status: 'running',
          startedAt: event.at,
        };
        index.set(event.toolCallId, call);
        events.push({
          type: 'tool.call',
          runId: context.runId,
          seq: next(),
          at: event.at,
          call,
        });
        break;
      }

      case 'tool.result': {
        const started = index.get(event.toolCallId);
        const startedAt = started?.startedAt ?? event.at;
        const call: ToolCall = {
          id: event.toolCallId,
          runId: context.runId,
          stepId: started?.stepId ?? context.stepId,
          name: started?.name ?? event.name ?? 'unknown',
          arguments: started?.arguments ?? {},
          sideEffecting: started?.sideEffecting ?? false,
          status: event.isError ? 'failed' : 'succeeded',
          startedAt,
          finishedAt: event.at,
          durationMs: Math.max(
            0,
            Date.parse(event.at) - Date.parse(startedAt) || 0,
          ),
          resultSummary: event.isError ? undefined : event.content,
          error: event.isError ? event.content : undefined,
        };
        index.set(event.toolCallId, call);
        events.push({
          type: 'tool.result',
          runId: context.runId,
          seq: next(),
          at: event.at,
          call,
        });
        break;
      }

      case 'usage': {
        events.push({
          type: 'usage',
          runId: context.runId,
          seq: next(),
          at: event.at,
          stepId: context.stepId,
          usage: event.usage,
        });
        break;
      }

      case 'result': {
        events.push({
          type: 'usage',
          runId: context.runId,
          seq: next(),
          at: event.at,
          stepId: context.stepId,
          usage: event.usage,
        });
        if (event.text) {
          events.push({
            type: 'message',
            runId: context.runId,
            seq: next(),
            at: event.at,
            stepId: context.stepId,
            role: 'assistant',
            text: event.text,
          });
        }
        break;
      }

      case 'error': {
        events.push({
          type: 'log',
          runId: context.runId,
          seq: next(),
          at: event.at,
          level: 'error',
          message: `[${event.kind}] ${event.message}`,
        });
        break;
      }

      case 'log': {
        events.push({
          type: 'log',
          runId: context.runId,
          seq: next(),
          at: event.at,
          level: event.level,
          message: event.message,
        });
        break;
      }

      case 'session': {
        events.push({
          type: 'log',
          runId: context.runId,
          seq: next(),
          at: event.at,
          level: 'debug',
          message: `engine session ${event.sessionId}${
            event.model ? ` on ${event.model}` : ''
          }`,
        });
        break;
      }

      // engine.started / engine.finished map onto step lifecycle rows, which
      // only the orchestrator can build (it owns the RunStep). raw and thinking
      // are transcript-only.
      default:
        unmapped += 1;
        break;
    }
  }

  return { events, unmapped };
}

/**
 * The `run.finished` event, for the orchestrator to emit once the engine stream
 * ends and the run row has been updated.
 */
export function runFinishedEvent(
  context: RunEventContext,
  status: 'succeeded' | 'failed' | 'cancelled',
  usage?: Usage,
  error?: string,
): RunEvent {
  const seq = context.seq;
  context.seq += 1;
  return {
    type: 'run.finished',
    runId: context.runId,
    seq,
    at: nowIso(),
    status,
    usage,
    error,
  };
}
