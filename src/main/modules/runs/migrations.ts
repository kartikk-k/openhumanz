/**
 * The `runs` module's tables.
 *
 * Structured state only. The event stream itself is **not** here: it lives as
 * append-only JSONL under `runs/<runId>/transcript.jsonl`, because a transcript
 * a human can `cat` is the trust story and a BLOB in SQLite is not.
 *
 * What SQLite owns is everything you need to render the runs list and the
 * timeline skeleton without opening a single file: status, timings, cost,
 * turns, session ids, tool calls.
 */
import type { Migration } from '../types';

export const migrations: Migration[] = [
  {
    id: '001_init',
    description: 'runs, steps, tool calls',
    up: [
      `CREATE TABLE IF NOT EXISTS runs_run (
         id                 TEXT PRIMARY KEY,
         title              TEXT NOT NULL,
         status             TEXT NOT NULL,
         trigger            TEXT NOT NULL,
         engine             TEXT NOT NULL,
         prompt             TEXT NOT NULL DEFAULT '',
         cwd                TEXT,
         session_id         TEXT,
         goal_id            TEXT,
         task_id            TEXT,
         scheduled_job_id   TEXT,
         created_at         TEXT NOT NULL,
         started_at         TEXT,
         finished_at        TEXT,
         duration_ms        INTEGER,
         usage_json         TEXT,
         error              TEXT,
         /* Quota exhaustion is the failure users hit first and the one the UI
            has to name specifically, so it gets its own column rather than
            being buried in a message string. */
         failure_kind       TEXT,
         metadata_json      TEXT NOT NULL DEFAULT '{}',
         /* Monotonic per-run event counter. Line N of transcript.jsonl is
            seq N, which is what makes sinceSeq a cheap skip. */
         last_seq           INTEGER NOT NULL DEFAULT 0
       );`,
      'CREATE INDEX IF NOT EXISTS runs_run_created_idx ON runs_run (created_at DESC);',
      'CREATE INDEX IF NOT EXISTS runs_run_status_idx ON runs_run (status);',
      'CREATE INDEX IF NOT EXISTS runs_run_goal_idx ON runs_run (goal_id);',
      'CREATE INDEX IF NOT EXISTS runs_run_task_idx ON runs_run (task_id);',
      'CREATE INDEX IF NOT EXISTS runs_run_job_idx ON runs_run (scheduled_job_id);',

      `CREATE TABLE IF NOT EXISTS runs_step (
         id                 TEXT PRIMARY KEY,
         run_id             TEXT NOT NULL REFERENCES runs_run (id) ON DELETE CASCADE,
         step_index         INTEGER NOT NULL,
         name               TEXT NOT NULL,
         status             TEXT NOT NULL,
         prompt             TEXT NOT NULL DEFAULT '',
         allowed_tools_json TEXT NOT NULL DEFAULT '[]',
         cwd                TEXT,
         session_id         TEXT,
         max_turns          INTEGER,
         max_cost_usd       REAL,
         started_at         TEXT,
         finished_at        TEXT,
         duration_ms        INTEGER,
         usage_json         TEXT,
         summary            TEXT,
         error              TEXT,
         failure_kind       TEXT,
         UNIQUE (run_id, step_index)
       );`,
      'CREATE INDEX IF NOT EXISTS runs_step_run_idx ON runs_step (run_id, step_index);',

      `CREATE TABLE IF NOT EXISTS runs_tool_call (
         id              TEXT PRIMARY KEY,
         run_id          TEXT NOT NULL REFERENCES runs_run (id) ON DELETE CASCADE,
         step_id         TEXT,
         name            TEXT NOT NULL,
         arguments_json  TEXT NOT NULL DEFAULT '{}',
         side_effecting  INTEGER NOT NULL DEFAULT 0,
         status          TEXT NOT NULL,
         approval_id     TEXT,
         started_at      TEXT NOT NULL,
         finished_at     TEXT,
         duration_ms     INTEGER,
         result_summary  TEXT,
         error           TEXT,
         /* The engine's own id for the call (Claude Code's tool_use id), so a
            tool_result can find its tool_use without guessing. */
         external_id     TEXT
       );`,
      'CREATE INDEX IF NOT EXISTS runs_tool_call_run_idx ON runs_tool_call (run_id, started_at);',
      'CREATE INDEX IF NOT EXISTS runs_tool_call_step_idx ON runs_tool_call (step_id);',

      /* A read-model projection of the approvals a run is waiting on.
         The runs module must not import the approvals module, so it keeps its
         own copy fed from the event bus. Authority stays with approvals. */
      `CREATE TABLE IF NOT EXISTS runs_approval_cache (
         approval_id    TEXT PRIMARY KEY,
         run_id         TEXT NOT NULL,
         requested_at   TEXT NOT NULL,
         resolved       INTEGER NOT NULL DEFAULT 0,
         approval_json  TEXT NOT NULL
       );`,
      'CREATE INDEX IF NOT EXISTS runs_approval_cache_run_idx ON runs_approval_cache (run_id, resolved);',
    ],
  },
];

export default migrations;
