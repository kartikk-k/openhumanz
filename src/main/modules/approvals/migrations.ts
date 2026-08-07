/**
 * Tables owned by the approvals module. Namespaced `approvals_*`.
 *
 * Three tables, three jobs:
 *  - `approvals_requests` — the request for a decision. Survives restart, which
 *    is the point: a pending approval is the only record that a tool call is
 *    parked, and losing it on quit strands the run.
 *  - `approvals_grants` — standing `run` / `always` grants.
 *  - `approvals_audit` — every decision with the full arguments it was made
 *    about. Append-only; nothing in this module ever updates or deletes a row
 *    here.
 */
import type { Migration } from '../../infra/db';

export const migrations: Migration[] = [
  {
    id: '001_init',
    description: 'approval requests, standing grants, decision audit log',
    up: [
      `CREATE TABLE IF NOT EXISTS approvals_requests (
        id             TEXT PRIMARY KEY,
        run_id         TEXT NOT NULL,
        step_id        TEXT,
        tool_call_id   TEXT,
        tool_name      TEXT NOT NULL,
        -- Classifier-derived action for generic dispatchers; '' for a tool
        -- whose name already is the action.
        action         TEXT NOT NULL DEFAULT '',
        -- Full arguments, verbatim JSON. The audit value and the debugging
        -- value; never truncated here.
        tool_arguments TEXT NOT NULL DEFAULT '{}',
        -- Capability fingerprint: hash of (tool name, action, discriminator).
        -- Grants match on this and only on this.
        fingerprint    TEXT NOT NULL,
        -- Hash of the complete argument set. Identifies one exact call, so a
        -- re-dispatch can be told from a new call that merely looks alike.
        args_hash      TEXT NOT NULL,
        title          TEXT NOT NULL DEFAULT '',
        summary        TEXT NOT NULL DEFAULT '',
        raw_detail     TEXT,
        status         TEXT NOT NULL DEFAULT 'pending',
        decision       TEXT,
        granted_scope  TEXT,
        decided_by     TEXT,
        reason         TEXT,
        requested_at   TEXT NOT NULL,
        resolved_at    TEXT,
        expires_at     TEXT,
        -- Set when a 'once' approval has been spent. A once-approval that is
        -- consumed can never allow a second call.
        consumed_at    TEXT
      );`,
      `CREATE INDEX IF NOT EXISTS approvals_requests_status_idx
         ON approvals_requests (status, requested_at);`,
      `CREATE INDEX IF NOT EXISTS approvals_requests_run_idx
         ON approvals_requests (run_id, status);`,
      `CREATE INDEX IF NOT EXISTS approvals_requests_call_idx
         ON approvals_requests (tool_call_id);`,
      `CREATE INDEX IF NOT EXISTS approvals_requests_match_idx
         ON approvals_requests (run_id, fingerprint, args_hash, status);`,

      `CREATE TABLE IF NOT EXISTS approvals_grants (
        id            TEXT PRIMARY KEY,
        scope         TEXT NOT NULL,
        tool_name     TEXT NOT NULL,
        action        TEXT NOT NULL DEFAULT '',
        run_id        TEXT,
        -- NULL means "every call to this tool", which the gate never creates
        -- from a button press. See the note in gate.ts.
        fingerprint   TEXT,
        label         TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL,
        expires_at    TEXT,
        revoked_at    TEXT,
        source_approval_id TEXT
      );`,
      `CREATE INDEX IF NOT EXISTS approvals_grants_match_idx
         ON approvals_grants (tool_name, fingerprint, revoked_at);`,
      `CREATE INDEX IF NOT EXISTS approvals_grants_run_idx
         ON approvals_grants (run_id, scope);`,

      `CREATE TABLE IF NOT EXISTS approvals_audit (
        id             TEXT PRIMARY KEY,
        approval_id    TEXT NOT NULL,
        run_id         TEXT NOT NULL,
        tool_name      TEXT NOT NULL,
        action         TEXT NOT NULL DEFAULT '',
        tool_arguments TEXT NOT NULL DEFAULT '{}',
        decision       TEXT NOT NULL,
        scope          TEXT NOT NULL,
        decided_by     TEXT NOT NULL DEFAULT 'user',
        at             TEXT NOT NULL
      );`,
      `CREATE INDEX IF NOT EXISTS approvals_audit_at_idx
         ON approvals_audit (at);`,
      `CREATE INDEX IF NOT EXISTS approvals_audit_approval_idx
         ON approvals_audit (approval_id);`,
      `CREATE INDEX IF NOT EXISTS approvals_audit_run_idx
         ON approvals_audit (run_id, at);`,
      `CREATE INDEX IF NOT EXISTS approvals_audit_tool_idx
         ON approvals_audit (tool_name, at);`,
    ],
  },
];

export default migrations;
