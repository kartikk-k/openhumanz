/**
 * Run persistence.
 *
 * Two stores in one, deliberately split by what the data is for:
 *
 *  - **SQLite** holds the structured skeleton — runs, steps, tool calls,
 *    statuses, timings, per-model cost, turn counts, session ids. Everything
 *    the runs list and the timeline header need, queryable.
 *  - **`runs/<runId>/transcript.jsonl`** holds the event stream, appended one
 *    JSON object per line, and `runs/<runId>/engine.jsonl` holds the raw engine
 *    payloads behind them. Legible storage is the trust story; it is also what
 *    makes a run survive a crash without a resumable-graph fiction.
 *
 * Durability is at the **step boundary**. A CLI subprocess is not a resumable
 * graph and nothing here pretends otherwise: a step either completed and has a
 * persisted result, or it did not and is marked failed on the next start.
 *
 * `seq` is a strict per-run counter starting at 1, and event N is line N of the
 * transcript. That invariant is what lets `readEvents({ sinceSeq })` skip
 * instead of scan, so it is enforced in exactly one place: {@link append}.
 */
import path from 'node:path';
import type { Db, Row, SqlParam } from '../../infra/db';
import type { EventBus } from '../../infra/events';
import type { Logger } from '../../infra/logger';
import type { WorkspacePaths } from '../../infra/paths';
import { appendJsonLine, readJsonLines } from '../../infra/files';
import { randomId } from '../../infra/crypto';
import type { JsonObject, Page, Usage } from '../../../shared/common';
import { nowIso } from '../../../shared/common';
import type { Approval } from '../../../shared/approvals';
import { ApprovalSchema } from '../../../shared/approvals';
import type {
  Run,
  RunDetail,
  RunEvent,
  RunEventsQuery,
  RunListQuery,
  RunStatus,
  RunStep,
  RunStepStatus,
  ToolCall,
  ToolCallStatus,
} from '../../../shared/runs';
import { TERMINAL_RUN_STATUSES } from '../../../shared/runs';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/**
 * A run event as produced by a caller: everything except the three fields the
 * store owns. `runId`, `seq` and `at` are assigned in {@link RunStore.append}
 * so the monotonic-seq invariant cannot be broken from outside.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

export type RunEventDraft = DistributiveOmit<RunEvent, 'runId' | 'seq' | 'at'>;

/**
 * Why a run or step ended badly.
 *
 * `quota` and `rate_limit` are separated from everything else on purpose: they
 * are the most likely real-world failure and the only ones where the right UI
 * copy is "your plan is out", not "something went wrong".
 */
export const FAILURE_KINDS = [
  'quota',
  'rate_limit',
  'auth',
  'timeout',
  'budget_exceeded',
  'max_turns',
  'engine_error',
  'spawn_failed',
  'cancelled',
  'interrupted',
  'internal',
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

/** True when a failure means "the account is out of capacity", not "a bug". */
export function isQuotaFailure(kind: string | undefined): boolean {
  return kind === 'quota' || kind === 'rate_limit';
}

export interface CreateRunInput {
  id?: string;
  title: string;
  prompt: string;
  engine: string;
  trigger?: Run['trigger'];
  status?: RunStatus;
  cwd?: string;
  goalId?: string;
  taskId?: string;
  scheduledJobId?: string;
  metadata?: JsonObject;
}

export interface RunPatch {
  title?: string;
  status?: RunStatus;
  prompt?: string;
  cwd?: string | null;
  sessionId?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  durationMs?: number | null;
  usage?: Usage | null;
  error?: string | null;
  failureKind?: FailureKind | null;
  /** Shallow-merged into the existing metadata. */
  metadata?: JsonObject;
}

export interface CreateStepInput {
  id?: string;
  runId: string;
  index: number;
  name: string;
  prompt?: string;
  allowedTools?: string[];
  cwd?: string;
  maxTurns?: number;
  maxCostUsd?: number;
  status?: RunStepStatus;
}

export interface StepPatch {
  status?: RunStepStatus;
  prompt?: string;
  allowedTools?: string[];
  sessionId?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  durationMs?: number | null;
  usage?: Usage | null;
  summary?: string | null;
  error?: string | null;
  failureKind?: FailureKind | null;
}

export interface CreateToolCallInput {
  id?: string;
  runId: string;
  stepId?: string;
  name: string;
  arguments?: JsonObject;
  sideEffecting?: boolean;
  status?: ToolCallStatus;
  approvalId?: string;
  /** The engine's own id for the call, used to match a later result. */
  externalId?: string;
}

export interface ToolCallPatch {
  status?: ToolCallStatus;
  approvalId?: string | null;
  sideEffecting?: boolean;
  finishedAt?: string | null;
  durationMs?: number | null;
  resultSummary?: string | null;
  error?: string | null;
}

/** One line of `engine.jsonl`: the raw payload behind a timeline event. */
export interface RawEngineEntry {
  at: string;
  stepId?: string;
  /** Whatever the adapter read off stdout, unmodified. */
  raw: unknown;
}

export interface RunStoreOptions {
  db: Db;
  paths: WorkspacePaths;
  events: EventBus;
  logger: Logger;
}

export interface RunStore {
  /* runs */
  createRun(input: CreateRunInput): Run;
  getRun(id: string): Run | undefined;
  updateRun(id: string, patch: RunPatch): Run;
  listRuns(query: RunListQuery): Page<Run>;
  /** Run + steps + tool calls + pending approvals, in one payload. */
  getRunDetail(id: string): RunDetail | null;
  /** `failure_kind` for a run, which {@link Run} has no field for yet. */
  runFailureKind(id: string): FailureKind | undefined;

  /* steps */
  createStep(input: CreateStepInput): RunStep;
  getStep(id: string): RunStep | undefined;
  updateStep(id: string, patch: StepPatch): RunStep;
  listSteps(runId: string): RunStep[];
  stepFailureKind(id: string): FailureKind | undefined;

  /* tool calls */
  createToolCall(input: CreateToolCallInput): ToolCall;
  getToolCall(id: string): ToolCall | undefined;
  updateToolCall(id: string, patch: ToolCallPatch): ToolCall;
  listToolCalls(runId: string): ToolCall[];
  /** Newest unfinished call in a step, optionally matched by name. */
  findOpenToolCall(
    stepId: string,
    options?: { name?: string; externalId?: string },
  ): ToolCall | undefined;

  /* events */
  /**
   * Assign `seq`/`at`, append to the transcript, emit on the bus. Appends are
   * serialised per run, so line order and seq order never diverge.
   */
  append(runId: string, draft: RunEventDraft): Promise<RunEvent>;
  /** Read back from the transcript on disk. Survives a restart, by design. */
  readEvents(query: RunEventsQuery): Promise<{
    runId: string;
    events: RunEvent[];
    lastSeq: number;
  }>;
  /** Append one raw engine payload to `engine.jsonl`. Never control flow. */
  appendRaw(runId: string, entry: RawEngineEntry): Promise<void>;
  readRaw(runId: string, limit?: number): Promise<RawEngineEntry[]>;
  /** Wait for every queued append to reach disk. */
  flush(runId?: string): Promise<void>;

  /* approvals projection (fed from the event bus, never imported) */
  recordApproval(approval: Approval): void;
  resolveApproval(approvalId: string): void;
  pendingApprovals(runId: string): Approval[];

  /**
   * Anything left non-terminal by a crash becomes a coherent failure. Returns
   * the run ids it repaired.
   */
  recoverInterruptedRuns(): string[];
}

/* ------------------------------------------------------------------ */
/* Row helpers                                                         */
/* ------------------------------------------------------------------ */

function text(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return String(value);
}

function requiredText(value: unknown, fallback = ''): string {
  return text(value) ?? fallback;
}

/** Numeric column, `undefined` for NULL. Reals and integers alike. */
function num(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const int = num;

function bool(value: unknown): boolean {
  return Number(value ?? 0) !== 0;
}

function parseJson<T>(value: unknown, fallback: T): T {
  const raw = text(value);
  if (raw === undefined || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseUsage(value: unknown): Usage | undefined {
  const parsed = parseJson<Usage | null>(value, null);
  return parsed ?? undefined;
}

/** Column names come from these code-defined maps; only values are ever bound. */
function buildAssignments(
  columns: Record<string, string>,
  values: Record<string, SqlParam | undefined>,
): { clause: string; params: SqlParam[] } {
  const sets: string[] = [];
  const params: SqlParam[] = [];
  for (const [key, column] of Object.entries(columns)) {
    if (!(key in values)) continue;
    sets.push(`${column} = ?`);
    params.push(values[key] ?? null);
  }
  return { clause: sets.join(', '), params };
}

const RUN_COLUMNS: Record<string, string> = {
  title: 'title',
  status: 'status',
  prompt: 'prompt',
  cwd: 'cwd',
  sessionId: 'session_id',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
  durationMs: 'duration_ms',
  usageJson: 'usage_json',
  error: 'error',
  failureKind: 'failure_kind',
  metadataJson: 'metadata_json',
};

const STEP_COLUMNS: Record<string, string> = {
  status: 'status',
  prompt: 'prompt',
  allowedToolsJson: 'allowed_tools_json',
  sessionId: 'session_id',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
  durationMs: 'duration_ms',
  usageJson: 'usage_json',
  summary: 'summary',
  error: 'error',
  failureKind: 'failure_kind',
};

const TOOL_CALL_COLUMNS: Record<string, string> = {
  status: 'status',
  approvalId: 'approval_id',
  sideEffecting: 'side_effecting',
  finishedAt: 'finished_at',
  durationMs: 'duration_ms',
  resultSummary: 'result_summary',
  error: 'error',
};

/* ------------------------------------------------------------------ */
/* Mapping                                                             */
/* ------------------------------------------------------------------ */

function toRun(row: Row): Run {
  return {
    id: requiredText(row.id),
    title: requiredText(row.title, 'Untitled run'),
    status: requiredText(row.status, 'queued') as RunStatus,
    trigger: requiredText(row.trigger, 'manual') as Run['trigger'],
    engine: requiredText(row.engine, 'unknown'),
    prompt: requiredText(row.prompt),
    cwd: text(row.cwd),
    sessionId: text(row.session_id),
    goalId: text(row.goal_id),
    taskId: text(row.task_id),
    scheduledJobId: text(row.scheduled_job_id),
    createdAt: requiredText(row.created_at, nowIso()),
    startedAt: text(row.started_at),
    finishedAt: text(row.finished_at),
    durationMs: int(row.duration_ms),
    usage: parseUsage(row.usage_json),
    error: text(row.error),
    metadata: parseJson<JsonObject>(row.metadata_json, {}),
  };
}

function toStep(row: Row): RunStep {
  return {
    id: requiredText(row.id),
    runId: requiredText(row.run_id),
    index: int(row.step_index) ?? 0,
    name: requiredText(row.name, 'step'),
    status: requiredText(row.status, 'pending') as RunStepStatus,
    prompt: requiredText(row.prompt),
    allowedTools: parseJson<string[]>(row.allowed_tools_json, []),
    cwd: text(row.cwd),
    sessionId: text(row.session_id),
    maxTurns: int(row.max_turns),
    maxCostUsd: num(row.max_cost_usd),
    startedAt: text(row.started_at),
    finishedAt: text(row.finished_at),
    durationMs: int(row.duration_ms),
    usage: parseUsage(row.usage_json),
    summary: text(row.summary),
    error: text(row.error),
  };
}

function toToolCall(row: Row): ToolCall {
  return {
    id: requiredText(row.id),
    runId: requiredText(row.run_id),
    stepId: text(row.step_id),
    name: requiredText(row.name, 'tool'),
    arguments: parseJson<JsonObject>(row.arguments_json, {}),
    sideEffecting: bool(row.side_effecting),
    status: requiredText(row.status, 'pending') as ToolCallStatus,
    approvalId: text(row.approval_id),
    startedAt: requiredText(row.started_at, nowIso()),
    finishedAt: text(row.finished_at),
    durationMs: int(row.duration_ms),
    resultSummary: text(row.result_summary),
    error: text(row.error),
  };
}

/* ------------------------------------------------------------------ */
/* The store                                                           */
/* ------------------------------------------------------------------ */

export function createRunStore(options: RunStoreOptions): RunStore {
  const { db, paths, events, logger } = options;

  /**
   * One append chain per run. `fs.appendFile` calls issued concurrently are not
   * ordered, and an out-of-order transcript would break the seq/line identity
   * that `readEvents` relies on.
   */
  const appendChains = new Map<string, Promise<void>>();

  const enqueue = <T>(runId: string, work: () => Promise<T>): Promise<T> => {
    const previous = appendChains.get(runId) ?? Promise.resolve();
    const next = previous.then(work, work);
    appendChains.set(
      runId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  };

  /**
   * The raw engine stream, beside the transcript. Kept separate so line N of
   * `transcript.jsonl` stays seq N — mixing the two would break the skip.
   */
  const engineFile = (runId: string): string =>
    path.join(paths.runDir(runId), 'engine.jsonl');

  const requireRunRow = (id: string): Row => {
    const row = db.get('SELECT * FROM runs_run WHERE id = ?', [id]);
    if (!row) throw new Error(`Unknown run: ${id}`);
    return row;
  };

  const store: RunStore = {
    /* ---------------- runs ---------------- */

    createRun(input) {
      const id = input.id ?? randomId('run');
      const createdAt = nowIso();
      db.run(
        `INSERT INTO runs_run (
           id, title, status, trigger, engine, prompt, cwd, goal_id, task_id,
           scheduled_job_id, created_at, metadata_json, last_seq
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [
          id,
          input.title,
          input.status ?? 'queued',
          input.trigger ?? 'manual',
          input.engine,
          input.prompt,
          input.cwd ?? null,
          input.goalId ?? null,
          input.taskId ?? null,
          input.scheduledJobId ?? null,
          createdAt,
          JSON.stringify(input.metadata ?? {}),
        ],
      );
      const run = toRun(requireRunRow(id));
      events.emit('run:created', { run });
      return run;
    },

    getRun(id) {
      const row = db.get('SELECT * FROM runs_run WHERE id = ?', [id]);
      return row ? toRun(row) : undefined;
    },

    updateRun(id, patch) {
      const current = requireRunRow(id);
      const values: Record<string, SqlParam | undefined> = {};
      if ('title' in patch) values.title = patch.title;
      if ('status' in patch) values.status = patch.status;
      if ('prompt' in patch) values.prompt = patch.prompt;
      if ('cwd' in patch) values.cwd = patch.cwd ?? null;
      if ('sessionId' in patch) values.sessionId = patch.sessionId ?? null;
      if ('startedAt' in patch) values.startedAt = patch.startedAt ?? null;
      if ('finishedAt' in patch) values.finishedAt = patch.finishedAt ?? null;
      if ('durationMs' in patch) values.durationMs = patch.durationMs ?? null;
      if ('error' in patch) values.error = patch.error ?? null;
      if ('failureKind' in patch) values.failureKind = patch.failureKind ?? null;
      if ('usage' in patch) {
        values.usageJson = patch.usage ? JSON.stringify(patch.usage) : null;
      }
      if (patch.metadata) {
        const merged = {
          ...parseJson<JsonObject>(current.metadata_json, {}),
          ...patch.metadata,
        };
        values.metadataJson = JSON.stringify(merged);
      }

      const { clause, params } = buildAssignments(RUN_COLUMNS, values);
      if (clause) {
        db.run(`UPDATE runs_run SET ${clause} WHERE id = ?`, [...params, id]);
      }

      const run = toRun(requireRunRow(id));
      if (patch.status && patch.status !== requiredText(current.status)) {
        events.emit('run:status', { runId: id, status: run.status });
        if (TERMINAL_RUN_STATUSES.includes(run.status)) {
          events.emit('run:finished', {
            runId: id,
            status: run.status,
            error: run.error,
          });
        }
      }
      return run;
    },

    listRuns(query) {
      const where: string[] = [];
      const params: SqlParam[] = [];

      if (query.status && query.status.length > 0) {
        // Placeholders, not values, are interpolated. Values stay bound.
        where.push(`status IN (${query.status.map(() => '?').join(', ')})`);
        params.push(...query.status);
      }
      if (query.goalId) {
        where.push('goal_id = ?');
        params.push(query.goalId);
      }
      if (query.taskId) {
        where.push('task_id = ?');
        params.push(query.taskId);
      }
      if (query.scheduledJobId) {
        where.push('scheduled_job_id = ?');
        params.push(query.scheduledJobId);
      }
      if (query.search && query.search.trim()) {
        where.push('(title LIKE ? OR prompt LIKE ?)');
        const needle = `%${query.search.trim()}%`;
        params.push(needle, needle);
      }

      const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      const total = Number(
        db.pluck(`SELECT COUNT(*) FROM runs_run ${clause}`, params) ?? 0,
      );
      const rows = db.all(
        `SELECT * FROM runs_run ${clause}
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`,
        [...params, query.limit, query.offset],
      );
      return {
        items: rows.map(toRun),
        total,
        limit: query.limit,
        offset: query.offset,
      };
    },

    getRunDetail(id) {
      const row = db.get('SELECT * FROM runs_run WHERE id = ?', [id]);
      if (!row) return null;
      return {
        run: toRun(row),
        steps: store.listSteps(id),
        toolCalls: store.listToolCalls(id),
        pendingApprovals: store.pendingApprovals(id),
      };
    },

    runFailureKind(id) {
      const row = db.get('SELECT failure_kind FROM runs_run WHERE id = ?', [id]);
      return text(row?.failure_kind) as FailureKind | undefined;
    },

    /* ---------------- steps ---------------- */

    createStep(input) {
      const id = input.id ?? randomId('step');
      db.run(
        `INSERT INTO runs_step (
           id, run_id, step_index, name, status, prompt, allowed_tools_json,
           cwd, max_turns, max_cost_usd
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.runId,
          input.index,
          input.name,
          input.status ?? 'pending',
          input.prompt ?? '',
          JSON.stringify(input.allowedTools ?? []),
          input.cwd ?? null,
          input.maxTurns ?? null,
          input.maxCostUsd ?? null,
        ],
      );
      const step = store.getStep(id);
      if (!step) throw new Error(`Failed to create step ${id}`);
      return step;
    },

    getStep(id) {
      const row = db.get('SELECT * FROM runs_step WHERE id = ?', [id]);
      return row ? toStep(row) : undefined;
    },

    updateStep(id, patch) {
      const values: Record<string, SqlParam | undefined> = {};
      if ('status' in patch) values.status = patch.status;
      if ('prompt' in patch) values.prompt = patch.prompt;
      if ('allowedTools' in patch) {
        values.allowedToolsJson = JSON.stringify(patch.allowedTools ?? []);
      }
      if ('sessionId' in patch) values.sessionId = patch.sessionId ?? null;
      if ('startedAt' in patch) values.startedAt = patch.startedAt ?? null;
      if ('finishedAt' in patch) values.finishedAt = patch.finishedAt ?? null;
      if ('durationMs' in patch) values.durationMs = patch.durationMs ?? null;
      if ('summary' in patch) values.summary = patch.summary ?? null;
      if ('error' in patch) values.error = patch.error ?? null;
      if ('failureKind' in patch) values.failureKind = patch.failureKind ?? null;
      if ('usage' in patch) {
        values.usageJson = patch.usage ? JSON.stringify(patch.usage) : null;
      }

      const { clause, params } = buildAssignments(STEP_COLUMNS, values);
      if (clause) {
        db.run(`UPDATE runs_step SET ${clause} WHERE id = ?`, [...params, id]);
      }
      const step = store.getStep(id);
      if (!step) throw new Error(`Unknown step: ${id}`);
      return step;
    },

    listSteps(runId) {
      return db
        .all('SELECT * FROM runs_step WHERE run_id = ? ORDER BY step_index', [
          runId,
        ])
        .map(toStep);
    },

    stepFailureKind(id) {
      const row = db.get('SELECT failure_kind FROM runs_step WHERE id = ?', [
        id,
      ]);
      return text(row?.failure_kind) as FailureKind | undefined;
    },

    /* ---------------- tool calls ---------------- */

    createToolCall(input) {
      const id = input.id ?? randomId('call');
      db.run(
        `INSERT INTO runs_tool_call (
           id, run_id, step_id, name, arguments_json, side_effecting, status,
           approval_id, started_at, external_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.runId,
          input.stepId ?? null,
          input.name,
          JSON.stringify(input.arguments ?? {}),
          input.sideEffecting ? 1 : 0,
          input.status ?? 'running',
          input.approvalId ?? null,
          nowIso(),
          input.externalId ?? null,
        ],
      );
      const row = db.get('SELECT * FROM runs_tool_call WHERE id = ?', [id]);
      if (!row) throw new Error(`Failed to create tool call ${id}`);
      return toToolCall(row);
    },

    getToolCall(id) {
      const row = db.get('SELECT * FROM runs_tool_call WHERE id = ?', [id]);
      return row ? toToolCall(row) : undefined;
    },

    updateToolCall(id, patch) {
      const values: Record<string, SqlParam | undefined> = {};
      if ('status' in patch) values.status = patch.status;
      if ('approvalId' in patch) values.approvalId = patch.approvalId ?? null;
      if ('sideEffecting' in patch) {
        values.sideEffecting = patch.sideEffecting ? 1 : 0;
      }
      if ('finishedAt' in patch) values.finishedAt = patch.finishedAt ?? null;
      if ('durationMs' in patch) values.durationMs = patch.durationMs ?? null;
      if ('resultSummary' in patch) {
        values.resultSummary = patch.resultSummary ?? null;
      }
      if ('error' in patch) values.error = patch.error ?? null;

      const { clause, params } = buildAssignments(TOOL_CALL_COLUMNS, values);
      if (clause) {
        db.run(`UPDATE runs_tool_call SET ${clause} WHERE id = ?`, [
          ...params,
          id,
        ]);
      }
      const row = db.get('SELECT * FROM runs_tool_call WHERE id = ?', [id]);
      if (!row) throw new Error(`Unknown tool call: ${id}`);
      return toToolCall(row);
    },

    listToolCalls(runId) {
      return db
        .all(
          'SELECT * FROM runs_tool_call WHERE run_id = ? ORDER BY started_at, rowid',
          [runId],
        )
        .map(toToolCall);
    },

    findOpenToolCall(stepId, matchOptions = {}) {
      if (matchOptions.externalId) {
        const row = db.get(
          'SELECT * FROM runs_tool_call WHERE step_id = ? AND external_id = ? ORDER BY rowid DESC LIMIT 1',
          [stepId, matchOptions.externalId],
        );
        if (row) return toToolCall(row);
      }
      if (matchOptions.name) {
        const row = db.get(
          `SELECT * FROM runs_tool_call
             WHERE step_id = ? AND name = ? AND finished_at IS NULL
             ORDER BY rowid DESC LIMIT 1`,
          [stepId, matchOptions.name],
        );
        return row ? toToolCall(row) : undefined;
      }
      const row = db.get(
        `SELECT * FROM runs_tool_call
           WHERE step_id = ? AND finished_at IS NULL
           ORDER BY rowid DESC LIMIT 1`,
        [stepId],
      );
      return row ? toToolCall(row) : undefined;
    },

    /* ---------------- events ---------------- */

    append(runId, draft) {
      return enqueue(runId, async () => {
        // seq is allocated inside the chain, so two concurrent callers cannot
        // both read the same last_seq.
        const previous = Number(
          db.pluck('SELECT last_seq FROM runs_run WHERE id = ?', [runId]) ?? 0,
        );
        const seq = previous + 1;
        const event = { ...draft, runId, seq, at: nowIso() } as RunEvent;

        await appendJsonLine(paths.runTranscriptFile(runId), event);
        db.run('UPDATE runs_run SET last_seq = ? WHERE id = ?', [seq, runId]);

        events.emit('run:event', { runId, event });
        return event;
      });
    },

    async readEvents(query) {
      const lastSeq = Number(
        db.pluck('SELECT last_seq FROM runs_run WHERE id = ?', [query.runId]) ??
          0,
      );
      // Line N is seq N, so sinceSeq is a skip count rather than a scan. The
      // seq filter below is belt-and-braces for a transcript truncated by a
      // crash mid-line.
      const lines = await readJsonLines<RunEvent>(
        paths.runTranscriptFile(query.runId),
        { skip: query.sinceSeq, limit: query.limit },
      );
      const filtered = lines.filter(
        (event) => typeof event?.seq === 'number' && event.seq > query.sinceSeq,
      );
      return { runId: query.runId, events: filtered, lastSeq };
    },

    appendRaw(runId, entry) {
      return enqueue(runId, () => appendJsonLine(engineFile(runId), entry));
    },

    readRaw(runId, limit) {
      return readJsonLines<RawEngineEntry>(engineFile(runId), { limit });
    },

    async flush(runId) {
      if (runId) {
        await (appendChains.get(runId) ?? Promise.resolve());
        return;
      }
      await Promise.all([...appendChains.values()]);
    },

    /* ---------------- approvals projection ---------------- */

    recordApproval(approval) {
      db.run(
        `INSERT INTO runs_approval_cache
           (approval_id, run_id, requested_at, resolved, approval_json)
         VALUES (?, ?, ?, 0, ?)
         ON CONFLICT (approval_id) DO UPDATE SET
           approval_json = excluded.approval_json,
           resolved = 0`,
        [
          approval.id,
          approval.runId,
          approval.requestedAt,
          JSON.stringify(approval),
        ],
      );
    },

    resolveApproval(approvalId) {
      db.run(
        'UPDATE runs_approval_cache SET resolved = 1 WHERE approval_id = ?',
        [approvalId],
      );
    },

    pendingApprovals(runId) {
      return db
        .all(
          `SELECT approval_json FROM runs_approval_cache
             WHERE run_id = ? AND resolved = 0
             ORDER BY requested_at`,
          [runId],
        )
        .map((row) => ApprovalSchema.safeParse(parseJson(row.approval_json, {})))
        .filter(
          (parsed): parsed is { success: true; data: Approval } =>
            parsed.success,
        )
        .map((parsed) => parsed.data);
    },

    /* ---------------- crash recovery ---------------- */

    recoverInterruptedRuns() {
      const stale = db.all(
        `SELECT id FROM runs_run
           WHERE status IN ('queued', 'running', 'awaiting_approval')`,
      );
      if (stale.length === 0) return [];

      const ids = stale.map((row) => requiredText(row.id));
      const finishedAt = nowIso();
      db.transaction(() => {
        for (const id of ids) {
          db.run(
            `UPDATE runs_step
               SET status = 'failed',
                   finished_at = COALESCE(finished_at, ?),
                   failure_kind = COALESCE(failure_kind, 'interrupted'),
                   error = COALESCE(error, 'Interrupted by an app restart')
             WHERE run_id = ?
               AND status IN ('pending', 'running', 'awaiting_approval')`,
            [finishedAt, id],
          );
          db.run(
            `UPDATE runs_run
               SET status = 'failed',
                   finished_at = COALESCE(finished_at, ?),
                   failure_kind = 'interrupted',
                   error = COALESCE(error, 'Interrupted by an app restart')
             WHERE id = ?`,
            [finishedAt, id],
          );
        }
      });

      logger.warn('recovered interrupted runs', { count: ids.length });
      for (const id of ids) {
        events.emit('run:status', { runId: id, status: 'failed' });
      }
      return ids;
    },
  };

  return store;
}
