/**
 * The timeline model: `RunDetail` + a stream of `RunEvent`s, folded into an
 * ordered list of steps, each holding an ordered list of entries.
 *
 * This is deliberately a pure function of (detail, events). The timeline is the
 * highest-value surface in the product and it renders data written by an agent
 * mid-run, so the shape it draws has to be reconstructable, testable and
 * tolerant of a stream that is incomplete, out of order or replayed.
 *
 * Two things it refuses to do:
 *  - invent ordering. Everything is placed by `seq`, which is monotonic per
 *    run, and holes in `seq` are reported rather than closed over.
 *  - flatten tool calls into prose. A tool call keeps its arguments and its
 *    result as data so the UI can show a summary and expand to raw JSON.
 */
import type {
  Approval,
  ApprovalDecision,
  ApprovalScope,
} from '../../../shared/approvals';
import type { LogLevel, Usage } from '../../../shared/common';
import type {
  Run,
  RunDetail,
  RunEvent,
  RunStatus,
  RunStep,
  RunStepStatus,
  ToolCall,
} from '../../../shared/runs';
import { readFailureKind, type FailureKind } from './failures';

/** Key of the bucket that holds events the engine never attributed to a step. */
export const RUN_LEVEL_KEY = '__run__';

export type TimelineEntry =
  | {
      kind: 'message';
      id: string;
      seq: number;
      at: string;
      role: 'assistant' | 'user' | 'system';
      text: string;
    }
  | { kind: 'tool'; id: string; seq: number; at: string; call: ToolCall }
  | {
      kind: 'approval';
      id: string;
      seq: number;
      at: string;
      approval: Approval;
      decision?: ApprovalDecision;
      scope?: ApprovalScope;
    }
  | {
      kind: 'log';
      id: string;
      seq: number;
      at: string;
      level: LogLevel;
      message: string;
    };

export type TimelineEntryKind = TimelineEntry['kind'];

export interface TimelineStep {
  /** `stepId`, or {@link RUN_LEVEL_KEY} for the un-attributed bucket. */
  key: string;
  stepId?: string;
  /** Sort position. The run-level bucket is -1 so it sorts first. */
  index: number;
  name: string;
  status: RunStepStatus;
  prompt: string;
  allowedTools: string[];
  cwd?: string;
  sessionId?: string;
  maxTurns?: number;
  maxCostUsd?: number;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  usage?: Usage;
  summary?: string;
  error?: string;
  failureKind?: FailureKind;
  entries: TimelineEntry[];
  toolCount: number;
  /** Failed tool calls plus `error`-level logs. Drives the header chip. */
  errorCount: number;
}

export interface TimelineModel {
  steps: TimelineStep[];
  /** `seq` values the local buffer never saw. Non-empty means backfill. */
  gaps: number[];
  /** Entries across every step. What the virtualizer is sized against. */
  entryCount: number;
  /** Run-level usage: the authoritative one if present, else the sum of steps. */
  usage: Usage | undefined;
  /** True when the run usage had to be summed from steps. */
  usageIsDerived: boolean;
  /** Latest status seen on the stream, if it moved past the stored run. */
  streamStatus?: RunStatus;
  /** Error text from `run.finished`, if the stream carried one. */
  streamError?: string;
  lastSeq: number;
}

interface MutableStep extends Omit<TimelineStep, 'entries'> {
  entries: Map<string, TimelineEntry>;
  /** Ordering position of a tool call is fixed by its first appearance. */
  firstSeq: number;
}

function emptyStep(key: string, index: number, name: string): MutableStep {
  return {
    key,
    stepId: key === RUN_LEVEL_KEY ? undefined : key,
    index,
    name,
    status: 'pending',
    prompt: '',
    allowedTools: [],
    entries: new Map(),
    toolCount: 0,
    errorCount: 0,
    firstSeq: Number.MAX_SAFE_INTEGER,
  };
}

function mergeStep(target: MutableStep, step: RunStep): void {
  target.stepId = step.id;
  target.index = step.index;
  target.name = step.name || target.name;
  target.status = step.status;
  target.prompt = step.prompt ?? target.prompt;
  target.allowedTools = step.allowedTools ?? target.allowedTools;
  target.cwd = step.cwd ?? target.cwd;
  target.sessionId = step.sessionId ?? target.sessionId;
  target.maxTurns = step.maxTurns ?? target.maxTurns;
  target.maxCostUsd = step.maxCostUsd ?? target.maxCostUsd;
  target.startedAt = step.startedAt ?? target.startedAt;
  target.finishedAt = step.finishedAt ?? target.finishedAt;
  target.durationMs = step.durationMs ?? target.durationMs;
  target.usage = step.usage ?? target.usage;
  target.summary = step.summary ?? target.summary;
  target.error = step.error ?? target.error;
  target.failureKind = readFailureKind(step) ?? target.failureKind;
}

/** Sum the numeric fields of several usages. Absent everywhere stays absent. */
export function sumUsage(parts: (Usage | undefined)[]): Usage | undefined {
  const present = parts.filter((part): part is Usage => Boolean(part));
  if (present.length === 0) return undefined;

  const total: Usage = {};
  const add = (
    key:
      | 'inputTokens'
      | 'outputTokens'
      | 'cacheReadTokens'
      | 'cacheCreationTokens'
      | 'totalCostUsd'
      | 'durationMs'
      | 'turns',
  ) => {
    const values = present
      .map((part) => part[key])
      .filter((value): value is number => typeof value === 'number');
    if (values.length > 0) {
      total[key] = values.reduce((sum, value) => sum + value, 0);
    }
  };
  add('inputTokens');
  add('outputTokens');
  add('cacheReadTokens');
  add('cacheCreationTokens');
  add('totalCostUsd');
  add('durationMs');
  add('turns');
  total.model = present.find((part) => part.model)?.model;
  return total;
}

/**
 * Fold a run's detail and event buffer into the ordered model the timeline
 * renders. Safe to call on every render — it is O(events) with no allocation
 * per row.
 */
export function buildTimeline(
  detail: RunDetail | null | undefined,
  events: RunEvent[],
): TimelineModel {
  const steps = new Map<string, MutableStep>();

  const stepFor = (key: string): MutableStep => {
    const existing = steps.get(key);
    if (existing) return existing;
    const created =
      key === RUN_LEVEL_KEY
        ? emptyStep(key, -1, 'Run')
        : emptyStep(key, steps.size, 'Step');
    steps.set(key, created);
    return created;
  };

  // 1. Seed from the stored detail, so a finished run renders fully even with
  //    an empty event buffer.
  detail?.steps?.forEach((step) => {
    mergeStep(stepFor(step.id), step);
  });

  const toolSeq = new Map<string, number>();
  const place = (key: string, entry: TimelineEntry) => {
    const step = stepFor(key);
    step.entries.set(entry.id, entry);
    if (entry.seq < step.firstSeq) step.firstSeq = entry.seq;
  };

  detail?.toolCalls?.forEach((call, position) => {
    // Stored calls have no seq; keep their array order ahead of live events by
    // giving them a negative synthetic position.
    const seq = -1_000_000 + position;
    toolSeq.set(call.id, seq);
    place(call.stepId ?? RUN_LEVEL_KEY, {
      kind: 'tool',
      id: `tool:${call.id}`,
      seq,
      at: call.startedAt,
      call,
    });
  });

  detail?.pendingApprovals?.forEach((approval, position) => {
    place(approval.stepId ?? RUN_LEVEL_KEY, {
      kind: 'approval',
      id: `approval:${approval.id}`,
      seq: -500_000 + position,
      at: approval.requestedAt,
      approval,
    });
  });

  // 2. Fold the stream on top.
  let currentKey = RUN_LEVEL_KEY;
  let streamStatus: RunStatus | undefined;
  let streamError: string | undefined;
  let runUsage: Usage | undefined = detail?.run.usage;
  let lastSeq = 0;

  const approvalIndex = new Map<string, { key: string; id: string }>();

  events.forEach((event) => {
    lastSeq = Math.max(lastSeq, event.seq);
    switch (event.type) {
      case 'run.started':
        runUsage = event.run.usage ?? runUsage;
        break;

      case 'run.status':
        streamStatus = event.status;
        break;

      case 'run.finished':
        streamStatus = event.status;
        streamError = event.error ?? streamError;
        runUsage = event.usage ?? runUsage;
        break;

      case 'step.started': {
        const step = stepFor(event.step.id);
        mergeStep(step, event.step);
        if (step.firstSeq === Number.MAX_SAFE_INTEGER)
          step.firstSeq = event.seq;
        currentKey = event.step.id;
        break;
      }

      case 'step.finished': {
        const step = stepFor(event.step.id);
        mergeStep(step, event.step);
        if (currentKey === event.step.id) currentKey = RUN_LEVEL_KEY;
        break;
      }

      case 'message':
        place(event.stepId ?? currentKey, {
          kind: 'message',
          id: `msg:${event.seq}`,
          seq: event.seq,
          at: event.at,
          role: event.role,
          text: event.text,
        });
        break;

      case 'tool.call':
      case 'tool.result': {
        const seq = toolSeq.get(event.call.id) ?? event.seq;
        toolSeq.set(event.call.id, seq);
        place(event.call.stepId ?? currentKey, {
          kind: 'tool',
          id: `tool:${event.call.id}`,
          seq,
          at: event.call.startedAt || event.at,
          call: event.call,
        });
        break;
      }

      case 'approval.requested': {
        const key = event.approval.stepId ?? currentKey;
        const id = `approval:${event.approval.id}`;
        approvalIndex.set(event.approval.id, { key, id });
        place(key, {
          kind: 'approval',
          id,
          seq: event.seq,
          at: event.at,
          approval: event.approval,
        });
        break;
      }

      case 'approval.resolved': {
        const found = approvalIndex.get(event.approvalId);
        if (!found) break;
        const step = steps.get(found.key);
        const entry = step?.entries.get(found.id);
        if (entry && entry.kind === 'approval') {
          step?.entries.set(found.id, {
            ...entry,
            decision: event.decision,
            scope: event.scope,
          });
        }
        break;
      }

      case 'usage': {
        if (event.stepId) {
          const step = stepFor(event.stepId);
          step.usage = event.usage;
        } else {
          runUsage = event.usage;
        }
        break;
      }

      case 'log':
        place(currentKey, {
          kind: 'log',
          id: `log:${event.seq}`,
          seq: event.seq,
          at: event.at,
          level: event.level,
          message: event.message,
        });
        break;

      default:
        break;
    }
  });

  // 3. Freeze into the render model.
  const ordered: TimelineStep[] = Array.from(steps.values())
    .filter((step) => step.key !== RUN_LEVEL_KEY || step.entries.size > 0)
    .map((step) => {
      const entries = Array.from(step.entries.values()).sort(
        (a, b) => a.seq - b.seq,
      );
      const toolCount = entries.filter((entry) => entry.kind === 'tool').length;
      const errorCount = entries.filter(
        (entry) =>
          (entry.kind === 'tool' &&
            (entry.call.status === 'failed' ||
              entry.call.status === 'denied')) ||
          (entry.kind === 'log' && entry.level === 'error'),
      ).length;
      return {
        key: step.key,
        stepId: step.stepId,
        index: step.index,
        name: step.name,
        status: step.status,
        prompt: step.prompt,
        allowedTools: step.allowedTools,
        cwd: step.cwd,
        sessionId: step.sessionId,
        maxTurns: step.maxTurns,
        maxCostUsd: step.maxCostUsd,
        startedAt: step.startedAt,
        finishedAt: step.finishedAt,
        durationMs: step.durationMs,
        usage: step.usage,
        summary: step.summary,
        error: step.error,
        failureKind: step.failureKind,
        entries,
        toolCount,
        errorCount,
      } satisfies TimelineStep;
    })
    .sort((a, b) => a.index - b.index);

  const derived = sumUsage(ordered.map((step) => step.usage));
  const hasRunUsage =
    Boolean(runUsage) && Object.keys(runUsage ?? {}).length > 0;

  return {
    steps: ordered,
    gaps: [],
    entryCount: ordered.reduce((total, step) => total + step.entries.length, 0),
    usage: hasRunUsage ? runUsage : derived,
    usageIsDerived: !hasRunUsage && Boolean(derived),
    streamStatus,
    streamError,
    lastSeq,
  };
}

/* ------------------------------------------------------------------ */
/* Flat rows — what the virtualizer walks                              */
/* ------------------------------------------------------------------ */

export type TimelineRow =
  | { type: 'step'; key: string; step: TimelineStep; open: boolean }
  | {
      type: 'entry';
      key: string;
      step: TimelineStep;
      entry: TimelineEntry;
      last: boolean;
    }
  | { type: 'quiet'; key: string; step: TimelineStep; hidden: number }
  | { type: 'empty'; key: string; step: TimelineStep };

export interface FlattenOptions {
  /** Step keys that are expanded. Everything else contributes one header row. */
  open: ReadonlySet<string>;
  /** Hide `debug`/`info` logs. On by default — they are noise in a timeline. */
  hideChatter: boolean;
}

/**
 * Flatten the model into one row per rendered element.
 *
 * This is what makes virtualization and collapsible steps coexist: a closed
 * step is exactly one row, an open step is one header row plus one row per
 * entry, and the virtualizer never has to measure a nested variable-height
 * container.
 */
export function flattenTimeline(
  model: TimelineModel,
  options: FlattenOptions,
): TimelineRow[] {
  const rows: TimelineRow[] = [];

  model.steps.forEach((step) => {
    const open = options.open.has(step.key);
    rows.push({ type: 'step', key: `step:${step.key}`, step, open });
    if (!open) return;

    const visible = options.hideChatter
      ? step.entries.filter(
          (entry) =>
            entry.kind !== 'log' ||
            entry.level === 'warn' ||
            entry.level === 'error',
        )
      : step.entries;

    if (visible.length === 0) {
      const hidden = step.entries.length;
      rows.push(
        hidden > 0
          ? { type: 'quiet', key: `quiet:${step.key}`, step, hidden }
          : { type: 'empty', key: `empty:${step.key}`, step },
      );
      return;
    }

    visible.forEach((entry, position) => {
      rows.push({
        type: 'entry',
        key: `${step.key}:${entry.id}`,
        step,
        entry,
        last: position === visible.length - 1,
      });
    });

    const hidden = step.entries.length - visible.length;
    if (hidden > 0) {
      rows.push({ type: 'quiet', key: `quiet:${step.key}`, step, hidden });
    }
  });

  return rows;
}

/* ------------------------------------------------------------------ */
/* Small readers used by the row renderers                             */
/* ------------------------------------------------------------------ */

/** `path="/a/b" · limit=20` — a one-line précis of tool arguments. */
export function summariseArguments(
  args: Record<string, unknown> | undefined,
  max = 96,
): string {
  if (!args) return '';
  const keys = Object.keys(args);
  if (keys.length === 0) return 'no arguments';
  const parts = keys.slice(0, 4).map((key) => {
    const value = args[key];
    if (typeof value === 'string') {
      const clipped = value.length > 32 ? `${value.slice(0, 31)}…` : value;
      return `${key}="${clipped}"`;
    }
    if (value === null) return `${key}=null`;
    if (Array.isArray(value)) return `${key}[${value.length}]`;
    if (typeof value === 'object') return `${key}{…}`;
    return `${key}=${String(value)}`;
  });
  if (keys.length > 4) parts.push(`+${keys.length - 4} more`);
  const line = parts.join('  ');
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Elapsed milliseconds for something that may still be running. */
export function elapsedMs(
  startedAt: string | undefined,
  finishedAt: string | undefined,
  now: number,
): number | undefined {
  if (!startedAt) return undefined;
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return undefined;
  const end = finishedAt ? new Date(finishedAt).getTime() : now;
  if (Number.isNaN(end)) return undefined;
  return Math.max(0, end - start);
}

/** Step keys worth having open on first paint: running, failing, or the last. */
export function defaultOpenKeys(model: TimelineModel): Set<string> {
  const open = new Set<string>();
  model.steps.forEach((step) => {
    if (
      step.status === 'running' ||
      step.status === 'awaiting_approval' ||
      step.status === 'failed' ||
      step.errorCount > 0
    ) {
      open.add(step.key);
    }
  });
  if (open.size === 0 && model.steps.length > 0) {
    open.add(model.steps[model.steps.length - 1].key);
  }
  return open;
}

/** The run object the header should trust: stored row, patched by the stream. */
export function effectiveRun(
  run: Run | undefined,
  model: TimelineModel,
): Run | undefined {
  if (!run) return undefined;
  if (!model.streamStatus && !model.streamError) return run;
  return {
    ...run,
    status: model.streamStatus ?? run.status,
    error: model.streamError ?? run.error,
  };
}
