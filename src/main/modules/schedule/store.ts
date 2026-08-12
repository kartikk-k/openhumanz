/**
 * Persistence for scheduled jobs and their run history.
 *
 * Two things this file is deliberate about:
 *
 *  - **`next_run_at` is stored, not recomputed from scratch.** Recomputing on
 *    every launch is how a scheduler silently drops an occurrence (recompute
 *    from `now` and the missed one vanishes) or double-fires one (recompute
 *    from `created_at` and it comes back). The stored instant is the record of
 *    what we promised; the missed-run policy decides what to do about it.
 *  - **No string-concatenated SQL.** Column names come from a fixed literal
 *    map; every value is a bound parameter.
 */
import { z } from 'zod';
import type { Db, Migration, SqlParam } from '../../infra/db';
import {
  ScheduleConditionSchema,
  ScheduledJobSchema,
  DEFAULT_SCHEDULED_JOB_KIND,
  type ScheduleCondition,
  type ScheduledJob,
} from '../../../shared/schedule';
import {
  DEFAULT_MISSED_RUN_POLICY,
  isMissedRunPolicy,
  type MissedRunPolicy,
  type ScheduleHistoryQuery,
  type ScheduleRunRecord,
  type ScheduleRunStatus,
  type ScheduleTrigger,
} from './types';

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

export const migrations: Migration[] = [
  {
    id: '001_init',
    description: 'scheduled jobs, run history, counter readings',
    up: [
      `CREATE TABLE IF NOT EXISTS schedule_jobs (
         id                TEXT PRIMARY KEY,
         name              TEXT NOT NULL,
         description       TEXT NOT NULL DEFAULT '',
         cron              TEXT NOT NULL,
         timezone          TEXT NOT NULL DEFAULT 'UTC',
         human_readable    TEXT NOT NULL DEFAULT '',
         enabled           INTEGER NOT NULL DEFAULT 1,
         condition_json    TEXT NOT NULL DEFAULT '{"kind":"always"}',
         missed_run_policy TEXT NOT NULL DEFAULT 'skip',
         prompt            TEXT NOT NULL,
         engine            TEXT,
         allowed_tools_json TEXT NOT NULL DEFAULT '[]',
         max_turns         INTEGER,
         max_cost_usd      REAL,
         next_run_at       TEXT,
         last_run_at       TEXT,
         last_run_id       TEXT,
         last_status       TEXT,
         last_skip_reason  TEXT,
         created_at        TEXT NOT NULL,
         updated_at        TEXT NOT NULL,
         metadata_json     TEXT NOT NULL DEFAULT '{}'
       );`,
      `CREATE INDEX IF NOT EXISTS schedule_jobs_due
         ON schedule_jobs (enabled, next_run_at);`,
      `CREATE TABLE IF NOT EXISTS schedule_runs (
         id               TEXT PRIMARY KEY,
         job_id           TEXT NOT NULL REFERENCES schedule_jobs(id) ON DELETE CASCADE,
         trigger          TEXT NOT NULL,
         scheduled_for    TEXT,
         started_at       TEXT NOT NULL,
         finished_at      TEXT NOT NULL,
         duration_ms      INTEGER NOT NULL DEFAULT 0,
         status           TEXT NOT NULL,
         condition_kind   TEXT NOT NULL,
         condition_passed INTEGER NOT NULL DEFAULT 0,
         condition_reason TEXT NOT NULL DEFAULT '',
         missed_count     INTEGER NOT NULL DEFAULT 0,
         run_id           TEXT,
         error            TEXT
       );`,
      `CREATE INDEX IF NOT EXISTS schedule_runs_job
         ON schedule_runs (job_id, started_at);`,
      // Latest reading per counter source, so a `counter-changed` condition
      // still works across a restart. Written by whoever owns the source.
      `CREATE TABLE IF NOT EXISTS schedule_counters (
         source     TEXT PRIMARY KEY,
         value      INTEGER NOT NULL,
         updated_at TEXT NOT NULL
       );`,
    ],
  },
  {
    id: '002_recurring',
    description:
      'one-shot jobs: a `recurring` flag; false disables after firing',
    up: [
      // Existing jobs were all cron-recurring, so default 1 preserves them.
      `ALTER TABLE schedule_jobs
         ADD COLUMN recurring INTEGER NOT NULL DEFAULT 1;`,
    ],
  },
  {
    id: '003_kind',
    description:
      'job kind: `reminder` (notify only, no engine) vs `agent` (spawns engine)',
    up: [
      // Every job that existed before this migration had a required prompt and
      // spawned the engine, i.e. it was an agent job — so default 'agent'
      // preserves their behaviour exactly. New jobs default to 'reminder' at
      // the schema layer; only the historical rows are pinned here.
      `ALTER TABLE schedule_jobs
         ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent';`,
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Row <-> domain                                                      */
/* ------------------------------------------------------------------ */

interface JobRow {
  id: string;
  name: string;
  description: string;
  cron: string;
  timezone: string;
  human_readable: string;
  enabled: number;
  recurring: number;
  condition_json: string;
  missed_run_policy: string;
  kind: string;
  prompt: string;
  engine: string | null;
  allowed_tools_json: string;
  max_turns: number | null;
  max_cost_usd: number | null;
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_id: string | null;
  last_status: string | null;
  last_skip_reason: string | null;
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * Legacy location for the policy.
 *
 * `ScheduledJob.missedRunPolicy` is a real field now, so nothing writes this
 * key any more. Rows created before the promotion still carry it in
 * `metadata_json`, and dev workspaces have real data, so reads fall back to it.
 */
export const MISSED_POLICY_METADATA_KEY = 'missedRunPolicy';

/**
 * A stored row as a {@link ScheduledJob}.
 *
 * Re-parsed through the shared schema on the way out, so a row written by an
 * older build (or hand-edited) cannot leak a shape the rest of the app does not
 * expect.
 */
export function rowToJob(row: JobRow): ScheduledJob {
  const condition = ScheduleConditionSchema.safeParse(
    parseJson<unknown>(row.condition_json, { kind: 'always' }),
  );
  const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {});
  // The column is authoritative. A row written before the field was promoted
  // may only have it on metadata, so that is the fallback, not the default.
  const policy: MissedRunPolicy = isMissedRunPolicy(row.missed_run_policy)
    ? row.missed_run_policy
    : policyFromMetadata(metadata);

  return ScheduledJobSchema.parse({
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    cron: row.cron,
    timezone: row.timezone || 'UTC',
    humanReadable: row.human_readable ?? '',
    // A stored condition that will not parse is a gate that is not there.
    // Falling back to `always` would silently turn a gated job into an
    // unconditional five-minute heartbeat — the exact failure ARCHITECTURE.md
    // names. So the job reads as *off* until a human fixes it.
    enabled: row.enabled !== 0 && condition.success,
    // Older rows (pre-002 migration) have no column; treat absent as recurring.
    recurring: row.recurring === undefined ? true : row.recurring !== 0,
    condition: condition.success ? condition.data : { kind: 'always' },
    // Absent (pre-003 rows read through an older path) → 'agent', matching the
    // migration default: everything before the split was an agent job.
    kind: row.kind ?? 'agent',
    prompt: row.prompt,
    engine: row.engine ?? undefined,
    allowedTools: parseJson<string[]>(row.allowed_tools_json, []),
    maxTurns: row.max_turns ?? undefined,
    maxCostUsd: row.max_cost_usd ?? undefined,
    nextRunAt: row.next_run_at ?? undefined,
    lastRunAt: row.last_run_at ?? undefined,
    lastRunId: row.last_run_id ?? undefined,
    lastStatus: row.last_status ?? undefined,
    lastSkipReason: condition.success
      ? (row.last_skip_reason ?? undefined)
      : 'disabled: the stored condition could not be read',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    missedRunPolicy: policy,
    // The policy lives on its own field now; strip the legacy alias so a job
    // never reports it in two places that could disagree.
    metadata: metadataWithoutPolicy(metadata),
  });
}

/** Drop the legacy metadata alias so the policy lives in exactly one place. */
export function metadataWithoutPolicy(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  if (!(MISSED_POLICY_METADATA_KEY in metadata)) return metadata;
  const copy = { ...metadata };
  delete copy[MISSED_POLICY_METADATA_KEY];
  return copy;
}

/** The persisted policy for a job. */
export function missedRunPolicyOf(job: ScheduledJob): MissedRunPolicy {
  return isMissedRunPolicy(job.missedRunPolicy)
    ? job.missedRunPolicy
    : DEFAULT_MISSED_RUN_POLICY;
}

/** Pull a policy out of a caller-supplied metadata blob. */
export function policyFromMetadata(
  metadata: Record<string, unknown> | undefined,
  fallback: MissedRunPolicy = DEFAULT_MISSED_RUN_POLICY,
): MissedRunPolicy {
  const value = metadata?.[MISSED_POLICY_METADATA_KEY];
  return isMissedRunPolicy(value) ? value : fallback;
}

/* ------------------------------------------------------------------ */
/* Writable columns                                                    */
/* ------------------------------------------------------------------ */

/**
 * Every column a caller may set, and how to encode it.
 *
 * The keys of this object are the *only* strings that ever reach a SQL
 * fragment; values are always bound.
 */
const COLUMNS = {
  name: (v: unknown) => String(v),
  description: (v: unknown) => String(v ?? ''),
  cron: (v: unknown) => String(v),
  timezone: (v: unknown) => String(v ?? 'UTC'),
  human_readable: (v: unknown) => String(v ?? ''),
  enabled: (v: unknown) => (v ? 1 : 0),
  recurring: (v: unknown) => (v === undefined || v ? 1 : 0),
  condition_json: (v: unknown) => JSON.stringify(v ?? { kind: 'always' }),
  missed_run_policy: (v: unknown) => String(v ?? DEFAULT_MISSED_RUN_POLICY),
  kind: (v: unknown) => String(v ?? DEFAULT_SCHEDULED_JOB_KIND),
  prompt: (v: unknown) => String(v ?? ''),
  engine: (v: unknown) => (v === undefined || v === null ? null : String(v)),
  allowed_tools_json: (v: unknown) => JSON.stringify(v ?? []),
  max_turns: (v: unknown) => (v === undefined || v === null ? null : Number(v)),
  max_cost_usd: (v: unknown) =>
    v === undefined || v === null ? null : Number(v),
  next_run_at: (v: unknown) =>
    v === undefined || v === null ? null : String(v),
  last_run_at: (v: unknown) =>
    v === undefined || v === null ? null : String(v),
  last_run_id: (v: unknown) =>
    v === undefined || v === null ? null : String(v),
  last_status: (v: unknown) =>
    v === undefined || v === null ? null : String(v),
  last_skip_reason: (v: unknown) =>
    v === undefined || v === null ? null : String(v),
  created_at: (v: unknown) => String(v),
  updated_at: (v: unknown) => String(v),
  metadata_json: (v: unknown) => JSON.stringify(v ?? {}),
} as const;

type Column = keyof typeof COLUMNS;

export type JobPatch = Partial<Record<Column, unknown>>;

const SELECT_JOB = `SELECT id, name, description, cron, timezone, human_readable,
    enabled, recurring, condition_json, missed_run_policy, kind, prompt, engine,
    allowed_tools_json, max_turns, max_cost_usd, next_run_at, last_run_at,
    last_run_id, last_status, last_skip_reason, created_at, updated_at,
    metadata_json
  FROM schedule_jobs`;

/* ------------------------------------------------------------------ */
/* Run-history queries                                                 */
/* ------------------------------------------------------------------ */

const RUN_ORDER = 'ORDER BY started_at DESC, rowid DESC LIMIT ? OFFSET ?';

/**
 * The four filter combinations, each a complete statement.
 *
 * Written out rather than assembled so that no caller-supplied value can ever
 * reach a SQL string — the filters pick a constant, the values are bound.
 */
const RUN_QUERIES = {
  all: {
    select: `SELECT * FROM schedule_runs ${RUN_ORDER}`,
    count: 'SELECT COUNT(*) FROM schedule_runs',
  },
  job: {
    select: `SELECT * FROM schedule_runs WHERE job_id = ? ${RUN_ORDER}`,
    count: 'SELECT COUNT(*) FROM schedule_runs WHERE job_id = ?',
  },
  status: {
    select: `SELECT * FROM schedule_runs WHERE status = ? ${RUN_ORDER}`,
    count: 'SELECT COUNT(*) FROM schedule_runs WHERE status = ?',
  },
  both: {
    select: `SELECT * FROM schedule_runs WHERE job_id = ? AND status = ? ${RUN_ORDER}`,
    count: 'SELECT COUNT(*) FROM schedule_runs WHERE job_id = ? AND status = ?',
  },
} as const;

function filterKey(jobId?: string, status?: string): keyof typeof RUN_QUERIES {
  if (jobId && status) return 'both';
  if (jobId) return 'job';
  if (status) return 'status';
  return 'all';
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

export interface ScheduleStore {
  listJobs(): ScheduledJob[];
  getJob(id: string): ScheduledJob | undefined;
  insertJob(patch: JobPatch & { id: string }): ScheduledJob;
  updateJob(id: string, patch: JobPatch): ScheduledJob | undefined;
  deleteJob(id: string): boolean;
  /** Persist a moved condition baseline without touching `updated_at`. */
  saveCondition(id: string, condition: ScheduleCondition): void;
  /** The job that owns an engine run, for closing the loop on `run:finished`. */
  findJobIdByRunId(runId: string): string | undefined;

  insertRun(record: ScheduleRunRecord): void;
  listRuns(query?: ScheduleHistoryQuery): ScheduleRunRecord[];
  countRuns(query?: Pick<ScheduleHistoryQuery, 'jobId' | 'status'>): number;

  readCounter(source: string): number | undefined;
  writeCounter(source: string, value: number, atIso: string): void;
}

export function createStore(db: Db): ScheduleStore {
  const selectAll = `${SELECT_JOB} ORDER BY created_at, id`;
  const selectOne = `${SELECT_JOB} WHERE id = ?`;

  const encode = (
    patch: JobPatch,
  ): { columns: Column[]; values: SqlParam[] } => {
    const columns: Column[] = [];
    const values: SqlParam[] = [];
    for (const key of Object.keys(patch) as Column[]) {
      const encoder = COLUMNS[key];
      if (!encoder) continue; // never trust a key we did not define
      columns.push(key);
      values.push(encoder(patch[key]) as SqlParam);
    }
    return { columns, values };
  };

  const store: ScheduleStore = {
    listJobs() {
      return db.all<JobRow & Record<string, never>>(selectAll).map(rowToJob);
    },

    getJob(id) {
      const row = db.get<JobRow & Record<string, never>>(selectOne, [id]);
      return row ? rowToJob(row) : undefined;
    },

    insertJob(patch) {
      const { id, ...rest } = patch;
      const { columns, values } = encode(rest);
      const allColumns = ['id', ...columns];
      const sql = `INSERT INTO schedule_jobs (${allColumns.join(', ')}) VALUES (${allColumns
        .map(() => '?')
        .join(', ')})`;
      db.run(sql, [id, ...values]);
      const created = store.getJob(id);
      if (!created) throw new Error(`Failed to insert scheduled job "${id}"`);
      return created;
    },

    updateJob(id, patch) {
      const { columns, values } = encode(patch);
      if (columns.length > 0) {
        const sql = `UPDATE schedule_jobs SET ${columns
          .map((column) => `${column} = ?`)
          .join(', ')} WHERE id = ?`;
        db.run(sql, [...values, id]);
      }
      return store.getJob(id);
    },

    deleteJob(id) {
      const { changes } = db.run('DELETE FROM schedule_jobs WHERE id = ?', [
        id,
      ]);
      return changes > 0;
    },

    saveCondition(id, condition) {
      db.run('UPDATE schedule_jobs SET condition_json = ? WHERE id = ?', [
        JSON.stringify(condition),
        id,
      ]);
    },

    findJobIdByRunId(runId) {
      const value = db.pluck<string>(
        'SELECT id FROM schedule_jobs WHERE last_run_id = ? LIMIT 1',
        [runId],
      );
      return value === undefined || value === null ? undefined : String(value);
    },

    insertRun(record) {
      db.run(
        `INSERT INTO schedule_runs (
           id, job_id, trigger, scheduled_for, started_at, finished_at,
           duration_ms, status, condition_kind, condition_passed,
           condition_reason, missed_count, run_id, error
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          record.jobId,
          record.trigger,
          record.scheduledFor,
          record.startedAt,
          record.finishedAt,
          record.durationMs,
          record.status,
          record.conditionKind,
          record.conditionPassed ? 1 : 0,
          record.conditionReason,
          record.missedCount,
          record.runId,
          record.error,
        ],
      );
    },

    listRuns(query = {}) {
      const { jobId, status, limit = 50, offset = 0 } = query;
      // One fixed statement per filter combination. The filters choose which
      // constant to run; they never build one.
      const rows = db.all(RUN_QUERIES[filterKey(jobId, status)].select, [
        ...(jobId ? [jobId] : []),
        ...(status ? [status] : []),
        limit,
        offset,
      ]);

      return rows.map((row) => ({
        id: String(row.id),
        jobId: String(row.job_id),
        trigger: String(row.trigger) as ScheduleTrigger,
        scheduledFor:
          row.scheduled_for === null ? null : String(row.scheduled_for),
        startedAt: String(row.started_at),
        finishedAt: String(row.finished_at),
        durationMs: Number(row.duration_ms ?? 0),
        status: String(row.status) as ScheduleRunStatus,
        conditionKind: String(row.condition_kind),
        conditionPassed: Number(row.condition_passed) !== 0,
        conditionReason: String(row.condition_reason ?? ''),
        missedCount: Number(row.missed_count ?? 0),
        runId: row.run_id === null ? null : String(row.run_id),
        error: row.error === null ? null : String(row.error),
      }));
    },

    countRuns(query = {}) {
      const { jobId, status } = query;
      const value = db.pluck<number>(
        RUN_QUERIES[filterKey(jobId, status)].count,
        [...(jobId ? [jobId] : []), ...(status ? [status] : [])],
      );
      return Number(value ?? 0);
    },

    readCounter(source) {
      const value = db.pluck<number>(
        'SELECT value FROM schedule_counters WHERE source = ?',
        [source],
      );
      return value === undefined || value === null ? undefined : Number(value);
    },

    writeCounter(source, value, atIso) {
      db.run(
        `INSERT INTO schedule_counters (source, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(source) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [source, Math.trunc(value), atIso],
      );
    },
  };

  return store;
}

/**
 * Record a counter reading (`mail:unread` = 7) for `counter-changed` conditions.
 *
 * Exported for a **service** to call — modules must not import each other, so
 * whoever owns the underlying source (mail, notifications) reports through a
 * service, which calls this. The scheduler only ever reads.
 */
export function recordCounterReading(
  db: Db,
  source: string,
  value: number,
  atIso: string = new Date().toISOString(),
): void {
  createStore(db).writeCounter(source, value, atIso);
}

/** Schema for the metadata blob, kept permissive on purpose. */
export const MetadataSchema = z.record(z.string(), z.unknown());
