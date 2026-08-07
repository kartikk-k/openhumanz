/**
 * Persistence for the approvals module.
 *
 * Every statement is a prepared statement with bound parameters. Where a query
 * has optional filters the *clause fragments* are string literals from this
 * file and the values are always bound — no value ever reaches the SQL text.
 */
import type { Db, Row, SqlParam } from '../../infra/db';
import type { JsonObject } from '../../../shared/common';
import {
  ApprovalAuditEntrySchema,
  ApprovalGrantSchema,
  ApprovalSchema,
} from '../../../shared/approvals';
import type {
  Approval,
  ApprovalAuditEntry,
  ApprovalDecision,
  ApprovalGrant,
  ApprovalScope,
  ApprovalStatus,
} from '../../../shared/approvals';
import type { AuditFilter, GrantFilter, PendingFilter } from './types';

/* ------------------------------------------------------------------ */
/* Row coercion                                                        */
/* ------------------------------------------------------------------ */

/** One cell as sql.js hands it back. `Row` is infra's alias for the whole map. */
type SqlValue = Row[string];

function text(value: SqlValue): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function optionalText(value: SqlValue): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  return text(value);
}

/** Arguments are stored verbatim; a corrupt blob must not break the log. */
export function parseArguments(value: SqlValue): JsonObject {
  const raw = optionalText(value);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as JsonObject;
    }
    return { value: parsed as unknown };
  } catch {
    return { unparseable: raw };
  }
}

export interface ApprovalRow {
  id: string;
  runId: string;
  stepId?: string;
  toolCallId?: string;
  toolName: string;
  action: string;
  toolArguments: JsonObject;
  fingerprint: string;
  argsHash: string;
  status: ApprovalStatus;
  decision?: ApprovalDecision;
  grantedScope?: ApprovalScope;
  decidedBy?: string;
  requestedAt: string;
  resolvedAt?: string;
  expiresAt?: string;
  consumedAt?: string;
  reason?: string;
  title: string;
  summary: string;
  rawDetail?: string;
}

function toApprovalRow(row: Row): ApprovalRow {
  return {
    id: text(row.id),
    runId: text(row.run_id),
    stepId: optionalText(row.step_id),
    toolCallId: optionalText(row.tool_call_id),
    toolName: text(row.tool_name),
    action: text(row.action ?? ''),
    toolArguments: parseArguments(row.tool_arguments),
    fingerprint: text(row.fingerprint),
    argsHash: text(row.args_hash),
    status: text(row.status) as ApprovalStatus,
    decision: optionalText(row.decision) as ApprovalDecision | undefined,
    grantedScope: optionalText(row.granted_scope) as ApprovalScope | undefined,
    decidedBy: optionalText(row.decided_by),
    requestedAt: text(row.requested_at),
    resolvedAt: optionalText(row.resolved_at),
    expiresAt: optionalText(row.expires_at),
    consumedAt: optionalText(row.consumed_at),
    reason: optionalText(row.reason),
    title: text(row.title ?? ''),
    summary: text(row.summary ?? ''),
    rawDetail: optionalText(row.raw_detail),
  };
}

/** The shared-contract view of a row. Drops the gate's internal columns. */
export function toApproval(row: ApprovalRow): Approval {
  return ApprovalSchema.parse({
    id: row.id,
    runId: row.runId,
    stepId: row.stepId,
    toolCallId: row.toolCallId,
    toolName: row.toolName,
    toolArguments: row.toolArguments,
    fingerprint: row.fingerprint,
    title: row.title || row.toolName,
    summary: row.summary,
    rawDetail: row.rawDetail,
    status: row.status,
    decision: row.decision,
    grantedScope: row.grantedScope,
    requestedAt: row.requestedAt,
    resolvedAt: row.resolvedAt,
    expiresAt: row.expiresAt,
    reason: row.reason,
  });
}

function toGrant(row: Row): ApprovalGrant {
  return ApprovalGrantSchema.parse({
    id: text(row.id),
    scope: text(row.scope) as 'run' | 'always',
    toolName: text(row.tool_name),
    runId: optionalText(row.run_id),
    fingerprint: optionalText(row.fingerprint),
    createdAt: text(row.created_at),
    expiresAt: optionalText(row.expires_at),
    label: text(row.label ?? ''),
  });
}

function toAuditEntry(row: Row): ApprovalAuditEntry {
  return ApprovalAuditEntrySchema.parse({
    id: text(row.id),
    approvalId: text(row.approval_id),
    runId: text(row.run_id),
    toolName: text(row.tool_name),
    toolArguments: parseArguments(row.tool_arguments),
    decision: text(row.decision) as ApprovalDecision,
    scope: text(row.scope) as ApprovalScope,
    decidedBy: text(row.decided_by ?? 'user'),
    at: text(row.at),
  });
}

/* ------------------------------------------------------------------ */
/* Statements                                                          */
/* ------------------------------------------------------------------ */

const APPROVAL_COLUMNS = `id, run_id, step_id, tool_call_id, tool_name, action,
  tool_arguments, fingerprint, args_hash, title, summary, raw_detail, status,
  decision, granted_scope, decided_by, reason, requested_at, resolved_at,
  expires_at, consumed_at`;

const INSERT_APPROVAL = `INSERT INTO approvals_requests (${APPROVAL_COLUMNS})
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const SELECT_APPROVAL_BY_ID = `SELECT ${APPROVAL_COLUMNS}
  FROM approvals_requests WHERE id = ?`;

/**
 * An already-decided or already-parked approval for *this exact call*.
 *
 * Matched on `tool_call_id` when the caller supplied one: that is the only
 * value that distinguishes "the agent is re-dispatching the call a human just
 * approved" from "the agent is making a second, identical call". Without it the
 * gate falls back to (run, capability, arguments) — see `findPriorForCall`.
 */
const SELECT_BY_TOOL_CALL = `SELECT ${APPROVAL_COLUMNS}
  FROM approvals_requests
  WHERE tool_call_id = ? AND tool_name = ? AND args_hash = ?
  ORDER BY requested_at DESC, rowid DESC LIMIT 1`;

const SELECT_BY_CALL_SHAPE = `SELECT ${APPROVAL_COLUMNS}
  FROM approvals_requests
  WHERE run_id = ? AND fingerprint = ? AND args_hash = ?
    AND tool_call_id IS NULL
    AND (status = 'pending' OR status = 'denied'
         OR (status = 'approved' AND consumed_at IS NULL))
  ORDER BY requested_at DESC, rowid DESC LIMIT 1`;

const SELECT_PENDING = `SELECT ${APPROVAL_COLUMNS}
  FROM approvals_requests WHERE status = 'pending' ORDER BY requested_at ASC`;

const SELECT_PENDING_FOR_RUN = `SELECT ${APPROVAL_COLUMNS}
  FROM approvals_requests WHERE status = 'pending' AND run_id = ?
  ORDER BY requested_at ASC`;

const RESOLVE_APPROVAL = `UPDATE approvals_requests
  SET status = ?, decision = ?, granted_scope = ?, decided_by = ?, reason = ?,
      resolved_at = ?, consumed_at = ?
  WHERE id = ?`;

const CONSUME_APPROVAL = `UPDATE approvals_requests SET consumed_at = ?
  WHERE id = ? AND consumed_at IS NULL`;

const EXPIRE_PENDING = `UPDATE approvals_requests
  SET status = 'expired', decision = 'deny', granted_scope = 'once',
      decided_by = 'system:ttl', resolved_at = ?, consumed_at = ?
  WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`;

const SELECT_EXPIRABLE = `SELECT ${APPROVAL_COLUMNS}
  FROM approvals_requests
  WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`;

const SELECT_PENDING_FOR_RUN_ALL = `SELECT ${APPROVAL_COLUMNS}
  FROM approvals_requests WHERE status = 'pending' AND run_id = ?`;

const CANCEL_PENDING_FOR_RUN = `UPDATE approvals_requests
  SET status = 'cancelled', decision = 'deny', granted_scope = 'once',
      decided_by = 'system:run-ended', resolved_at = ?, consumed_at = ?
  WHERE status = 'pending' AND run_id = ?`;

const GRANT_COLUMNS = `id, scope, tool_name, action, run_id, fingerprint, label,
  created_at, expires_at, revoked_at, source_approval_id`;

const INSERT_GRANT = `INSERT INTO approvals_grants (${GRANT_COLUMNS})
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * Grant lookup. Note what is *not* here: there is no `tool_name`-only branch
 * that ignores the fingerprint. A grant either carries a capability
 * fingerprint, or is explicitly tool-wide (`fingerprint IS NULL`), and the gate
 * never creates the latter from a user press.
 */
const SELECT_MATCHING_GRANT = `SELECT ${GRANT_COLUMNS}
  FROM approvals_grants
  WHERE revoked_at IS NULL
    AND tool_name = ?
    AND (fingerprint IS NULL OR fingerprint = ?)
    AND (scope = 'always' OR (scope = 'run' AND run_id IS NOT NULL AND run_id = ?))
    AND (expires_at IS NULL OR expires_at > ?)
  ORDER BY CASE scope WHEN 'run' THEN 0 ELSE 1 END, created_at DESC
  LIMIT 1`;

const REVOKE_GRANT = `UPDATE approvals_grants SET revoked_at = ?
  WHERE id = ? AND revoked_at IS NULL`;

const EXPIRE_RUN_GRANTS = `UPDATE approvals_grants SET revoked_at = ?
  WHERE scope = 'run' AND run_id = ? AND revoked_at IS NULL`;

const INSERT_AUDIT = `INSERT INTO approvals_audit
  (id, approval_id, run_id, tool_name, action, tool_arguments, decision, scope,
   decided_by, at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

export interface InsertApprovalInput {
  id: string;
  runId: string;
  stepId?: string;
  toolCallId?: string;
  toolName: string;
  action: string;
  toolArguments: JsonObject;
  fingerprint: string;
  argsHash: string;
  title: string;
  summary: string;
  rawDetail?: string;
  status: ApprovalStatus;
  decision?: ApprovalDecision;
  grantedScope?: ApprovalScope;
  decidedBy?: string;
  requestedAt: string;
  resolvedAt?: string;
  expiresAt?: string;
  consumedAt?: string;
}

export interface InsertGrantInput {
  id: string;
  scope: 'run' | 'always';
  toolName: string;
  action: string;
  runId?: string;
  fingerprint: string | null;
  label: string;
  createdAt: string;
  expiresAt?: string;
  sourceApprovalId?: string;
}

export interface InsertAuditInput {
  id: string;
  approvalId: string;
  runId: string;
  toolName: string;
  action: string;
  toolArguments: JsonObject;
  decision: ApprovalDecision;
  scope: ApprovalScope;
  decidedBy: string;
  at: string;
}

export interface ApprovalStore {
  insertApproval(input: InsertApprovalInput): ApprovalRow;
  getRow(id: string): ApprovalRow | null;
  findPriorForCall(params: {
    runId: string;
    toolCallId?: string;
    toolName: string;
    fingerprint: string;
    argsHash: string;
  }): ApprovalRow | null;
  listPendingRows(filter?: PendingFilter): ApprovalRow[];
  markResolved(params: {
    id: string;
    status: ApprovalStatus;
    decision: ApprovalDecision;
    scope: ApprovalScope;
    decidedBy: string;
    reason?: string;
    at: string;
    /** `once` approvals are spent by the call that triggered them. */
    consumedAt?: string;
  }): ApprovalRow | null;
  consume(id: string, at: string): boolean;
  expirePending(nowIso: string): ApprovalRow[];
  cancelPendingForRun(runId: string, at: string): ApprovalRow[];

  insertGrant(input: InsertGrantInput): ApprovalGrant;
  findMatchingGrant(params: {
    toolName: string;
    fingerprint: string;
    runId?: string;
    nowIso: string;
  }): (ApprovalGrant & { action: string }) | null;
  listGrants(filter?: GrantFilter): ApprovalGrant[];
  revokeGrant(id: string, at: string): boolean;
  expireRunGrants(runId: string, at: string): number;

  insertAudit(input: InsertAuditInput): void;
  queryAudit(filter?: AuditFilter): ApprovalAuditEntry[];
}

export function createStore(db: Db): ApprovalStore {
  const rows = (sql: string, params: SqlParam[]): ApprovalRow[] =>
    db.all(sql, params).map(toApprovalRow);

  const one = (sql: string, params: SqlParam[]): ApprovalRow | null => {
    const row = db.get(sql, params);
    return row ? toApprovalRow(row) : null;
  };

  return {
    insertApproval(input) {
      db.run(INSERT_APPROVAL, [
        input.id,
        input.runId,
        input.stepId ?? null,
        input.toolCallId ?? null,
        input.toolName,
        input.action,
        JSON.stringify(input.toolArguments ?? {}),
        input.fingerprint,
        input.argsHash,
        input.title,
        input.summary,
        input.rawDetail ?? null,
        input.status,
        input.decision ?? null,
        input.grantedScope ?? null,
        input.decidedBy ?? null,
        null,
        input.requestedAt,
        input.resolvedAt ?? null,
        input.expiresAt ?? null,
        input.consumedAt ?? null,
      ]);
      const created = one(SELECT_APPROVAL_BY_ID, [input.id]);
      if (!created) throw new Error(`Failed to persist approval ${input.id}`);
      return created;
    },

    getRow(id) {
      return one(SELECT_APPROVAL_BY_ID, [id]);
    },

    findPriorForCall({ runId, toolCallId, toolName, fingerprint, argsHash }) {
      if (toolCallId) {
        return one(SELECT_BY_TOOL_CALL, [toolCallId, toolName, argsHash]);
      }
      return one(SELECT_BY_CALL_SHAPE, [runId, fingerprint, argsHash]);
    },

    listPendingRows(filter = {}) {
      const found = filter.runId
        ? rows(SELECT_PENDING_FOR_RUN, [filter.runId])
        : rows(SELECT_PENDING, []);
      return filter.limit ? found.slice(0, filter.limit) : found;
    },

    markResolved({
      id,
      status,
      decision,
      scope,
      decidedBy,
      reason,
      at,
      consumedAt,
    }) {
      db.run(RESOLVE_APPROVAL, [
        status,
        decision,
        scope,
        decidedBy,
        reason ?? null,
        at,
        consumedAt ?? null,
        id,
      ]);
      return one(SELECT_APPROVAL_BY_ID, [id]);
    },

    consume(id, at) {
      return db.run(CONSUME_APPROVAL, [at, id]).changes > 0;
    },

    expirePending(nowIso) {
      // Read first: the update loses the row identities we need for the audit.
      const doomed = rows(SELECT_EXPIRABLE, [nowIso]);
      if (doomed.length === 0) return [];
      db.run(EXPIRE_PENDING, [nowIso, nowIso, nowIso]);
      return doomed;
    },

    cancelPendingForRun(runId, at) {
      const affected = rows(SELECT_PENDING_FOR_RUN_ALL, [runId]);
      if (affected.length === 0) return [];
      db.run(CANCEL_PENDING_FOR_RUN, [at, at, runId]);
      return affected;
    },

    insertGrant(input) {
      db.run(INSERT_GRANT, [
        input.id,
        input.scope,
        input.toolName,
        input.action,
        input.runId ?? null,
        input.fingerprint,
        input.label,
        input.createdAt,
        input.expiresAt ?? null,
        null,
        input.sourceApprovalId ?? null,
      ]);
      return ApprovalGrantSchema.parse({
        id: input.id,
        scope: input.scope,
        toolName: input.toolName,
        runId: input.runId,
        fingerprint: input.fingerprint ?? undefined,
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
        label: input.label,
      });
    },

    findMatchingGrant({ toolName, fingerprint, runId, nowIso }) {
      const row = db.get(SELECT_MATCHING_GRANT, [
        toolName,
        fingerprint,
        runId ?? null,
        nowIso,
      ]);
      if (!row) return null;
      return { ...toGrant(row), action: text(row.action ?? '') };
    },

    listGrants(filter = {}) {
      const clauses: string[] = [];
      const params: SqlParam[] = [];
      if (!filter.includeInactive) clauses.push('revoked_at IS NULL');
      if (filter.scope) {
        // `once` is never a standing grant, so it can never match one.
        clauses.push('scope = ?');
        params.push(filter.scope);
      }
      if (filter.runId) {
        clauses.push('run_id = ?');
        params.push(filter.runId);
      }
      if (filter.toolName) {
        clauses.push('tool_name = ?');
        params.push(filter.toolName);
      }
      const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
      const sql = `SELECT ${GRANT_COLUMNS} FROM approvals_grants${where} ORDER BY created_at DESC`;
      return db.all(sql, params).map(toGrant);
    },

    revokeGrant(id, at) {
      return db.run(REVOKE_GRANT, [at, id]).changes > 0;
    },

    expireRunGrants(runId, at) {
      return db.run(EXPIRE_RUN_GRANTS, [at, runId]).changes;
    },

    insertAudit(input) {
      db.run(INSERT_AUDIT, [
        input.id,
        input.approvalId,
        input.runId,
        input.toolName,
        input.action,
        JSON.stringify(input.toolArguments ?? {}),
        input.decision,
        input.scope,
        input.decidedBy,
        input.at,
      ]);
    },

    queryAudit(filter = {}) {
      const clauses: string[] = [];
      const params: SqlParam[] = [];
      if (filter.approvalId) {
        clauses.push('approval_id = ?');
        params.push(filter.approvalId);
      }
      if (filter.runId) {
        clauses.push('run_id = ?');
        params.push(filter.runId);
      }
      if (filter.toolName) {
        clauses.push('tool_name = ?');
        params.push(filter.toolName);
      }
      if (filter.decision) {
        clauses.push('decision = ?');
        params.push(filter.decision);
      }
      if (filter.since) {
        clauses.push('at >= ?');
        params.push(filter.since);
      }
      if (filter.until) {
        clauses.push('at <= ?');
        params.push(filter.until);
      }
      const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
      const sql =
        `SELECT id, approval_id, run_id, tool_name, action, tool_arguments,` +
        ` decision, scope, decided_by, at FROM approvals_audit${where}` +
        ` ORDER BY at DESC, rowid DESC LIMIT ? OFFSET ?`;
      params.push(Math.min(Math.max(filter.limit ?? 200, 1), 2000));
      params.push(Math.max(filter.offset ?? 0, 0));
      return db.all(sql, params).map(toAuditEntry);
    },
  };
}
