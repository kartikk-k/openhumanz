/**
 * The approval gate.
 *
 * ARCHITECTURE.md calls this the most important mechanism in the product: it is
 * what makes prompt injection non-fatal. A poisoned calendar invite can make
 * the agent *want* to email its contents to an attacker; it cannot make a human
 * press Approve.
 *
 * The gate is a value-returning function, never a blocking one. `check` costs a
 * database round trip and returns `'allow'`, a handle to a persisted pending
 * approval, or an outright `{ denied }`. The agent polls, the orchestrator
 * re-dispatches once a human has decided. Holding an
 * MCP response open until a person reacts reliably hits client timeouts, and a
 * timed-out tool call is indistinguishable from a denied one — which is exactly
 * the ambiguity a security gate cannot afford.
 */
import {
  ApprovalPendingHandleSchema,
  ApprovalResolutionSchema,
} from '../../../shared/approvals';
import type {
  Approval,
  ApprovalAuditEntry,
  ApprovalGrant,
  ApprovalResolution,
  ApprovalScope,
} from '../../../shared/approvals';
import type { JsonObject } from '../../../shared/common';
import type { ApprovalSettings } from '../../../shared/settings';
import type { Db } from '../../infra/db';
import type { EventBus } from '../../infra/events';
import type { Logger } from '../../infra/logger';
import {
  fingerprint,
  randomId,
  shortHash,
  stableStringify,
} from '../../infra/crypto';
import { createClassifierRegistry } from './classify';
import type { ApprovalClassification, ApprovalClassifier } from './classify';
import { createStore, toApproval } from './store';
import type { ApprovalRow } from './store';
import { defaultApprovalSettings } from './settings';
import {
  UNATTRIBUTED_RUN_ID,
  type ApprovalCheckContext,
  type ApprovalDeniedResult,
  type ApprovalPendingResult,
  type ApprovalService,
  type AuditFilter,
  type GrantFilter,
  type PendingFilter,
  type ToolPolicy,
} from './types';

/* ------------------------------------------------------------------ */
/* Grant matching — read this before changing anything below           */
/* ------------------------------------------------------------------ */

/**
 * **What a grant covers, and why.**
 *
 * Two obvious designs, both wrong:
 *
 * 1. *Key the grant on the tool name alone.* Then `always` means "any call to
 *    this tool, with any arguments, forever". That is correct only while every
 *    tool is narrow — one tool, one action. The moment a generic dispatcher
 *    exists (`calendar({action})`, `mail({op})`, an MCP passthrough), an
 *    `always` taken on "read calendar" silently authorises "delete calendar
 *    event", because both are the tool `calendar`. The gate still *looks*
 *    present. It is no longer effective. ARCHITECTURE.md flags this case
 *    explicitly.
 *
 * 2. *Key the grant on the full argument hash* — `fingerprint(toolName, args)`
 *    over the complete argument object. Perfectly precise and completely
 *    useless for `always`: every calendar read carries a different date range,
 *    so no `always` ever matches twice and the user is back to approving the
 *    fortieth calendar read. That abandonment is the failure mode
 *    ARCHITECTURE.md says kills the product.
 *
 * So the grant is keyed on neither. It is keyed on a **capability**:
 *
 * ```
 * capability = fingerprint(toolName, { action, args: discriminator })
 * ```
 *
 * - `toolName` is inside the hash, so a grant can never reach another tool.
 *   `always` on `calendar_read_events` cannot match `calendar_delete_event`.
 * - `action` comes from the classifier and is empty for a narrow tool, where
 *   the name already *is* the action. For a dispatcher it is the action being
 *   requested — the gate classifies on what is being asked for, not on which
 *   function was called. Different action, different hash, fresh approval.
 * - `discriminator` is the (normally empty) subset of arguments a tool declares
 *   security-relevant. Empty means `always` is "always, for any arguments";
 *   `['recipient']` on a send-mail tool means `always` is "always, to this
 *   address". A tool widens its own grants by leaving it empty and narrows them
 *   by filling it in — the choice is local to the tool, which is where the
 *   knowledge is.
 *
 * This reading is exactly what `shared/approvals.ts` documents: the approval's
 * `fingerprint` is a "stable hash of (toolName, normalised arguments)", and the
 * normalisation is the classifier's projection. Nothing outside the projection
 * affects grant matching; everything is still recorded in full on the approval
 * and in the audit log.
 *
 * The complete argument set is hashed separately as `argsHash`. It never takes
 * part in grant matching — its only job is to identify *one exact call*, so a
 * re-dispatch of an approved call can be told apart from the next call that
 * merely looks the same. That distinction is the entire meaning of `once`.
 *
 * `ApprovalGrant.fingerprint` is nullable in the shared schema, and a null
 * there means "any call to this tool" — design (1) above. The gate matches such
 * grants if they exist but **never creates one from a button press**. If you
 * add a code path that does, you have re-introduced the leak this comment
 * exists to prevent.
 */
export function capabilityFingerprint(
  toolName: string,
  classification: ApprovalClassification,
): string {
  return fingerprint(toolName, {
    action: classification.action ?? null,
    args: classification.discriminator ?? {},
  });
}

/** Identity of one exact call. Not used for grant matching. See above. */
export function argumentsHash(args: JsonObject): string {
  return shortHash(stableStringify(args), 32);
}

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

export interface ApprovalServiceDeps {
  db: Db;
  logger: Logger;
  events: EventBus;
  settings?: ApprovalSettings;
  /** Injectable clock, for tests. */
  now?(): Date;
}

export interface ApprovalServiceInternals extends ApprovalService {
  /** Called by the module when `settings:changed` fires. */
  applySettings(settings: ApprovalSettings): void;
  settings(): ApprovalSettings;
}

const DEFAULT_POLL_AFTER_MS = 2000;

function toJsonObject(args: unknown): JsonObject {
  if (args === null || args === undefined) return {};
  if (typeof args !== 'object') return { value: args };
  if (Array.isArray(args)) return { value: args };
  return args as JsonObject;
}

function humanize(toolName: string, action: string): string {
  const base = toolName.replace(/[_.:]+/g, ' ').trim() || toolName;
  return action ? `${base} — ${action}` : base;
}

function compact(args: JsonObject, max = 160): string {
  const text = stableStringify(args);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function createApprovalService(
  deps: ApprovalServiceDeps,
): ApprovalServiceInternals {
  const { db, logger, events } = deps;
  const clock = deps.now ?? (() => new Date());
  const store = createStore(db);
  const classifiers = createClassifierRegistry();
  const policies = new Map<string, ToolPolicy>();
  let settings: ApprovalSettings = deps.settings ?? defaultApprovalSettings();

  const nowIso = (): string => clock().toISOString();

  /* -------- audit -------- */

  const audit = (input: {
    approvalId: string;
    runId: string;
    toolName: string;
    action: string;
    args: JsonObject;
    decision: 'approve' | 'deny';
    scope: ApprovalScope;
    decidedBy: string;
    at: string;
  }): void => {
    store.insertAudit({
      id: randomId('aud'),
      approvalId: input.approvalId,
      runId: input.runId,
      toolName: input.toolName,
      action: input.action,
      // Full arguments, never truncated. This is simultaneously the trust
      // feature and the primary debugging tool.
      toolArguments: input.args,
      decision: input.decision,
      scope: input.scope,
      decidedBy: input.decidedBy,
      at: input.at,
    });
  };

  /* -------- pending handle -------- */

  const pendingResult = (row: ApprovalRow): ApprovalPendingResult => {
    const message = 'Waiting for the user to approve this action.';
    return {
      pending: row.id,
      pollAfterMs: DEFAULT_POLL_AFTER_MS,
      message,
      status: 'pending',
      approval: toApproval(row),
      handle: ApprovalPendingHandleSchema.parse({
        status: 'pending_approval',
        approvalId: row.id,
        pollAfterMs: DEFAULT_POLL_AFTER_MS,
        message,
      }),
    };
  };

  const deniedResult = (row: ApprovalRow): ApprovalDeniedResult => ({
    denied: row.reason?.trim() || 'the user declined this action',
    approvalId: row.id,
    approval: toApproval(row),
  });

  /* -------- resolution helpers -------- */

  const emitResolved = (row: ApprovalRow, scope: ApprovalScope): void => {
    events.emit('approval:resolved', {
      approvalId: row.id,
      runId: row.runId,
      decision: row.decision ?? 'deny',
      scope,
    });
  };

  const service: ApprovalServiceInternals = {
    /* ---------------------------------------------------------------- */
    /* The gate                                                          */
    /* ---------------------------------------------------------------- */

    async check(toolName, args, ctx: ApprovalCheckContext = {}) {
      const at = nowIso();
      const argsObject = toJsonObject(args);
      const classification = classifiers.classify(toolName, argsObject);
      const policy = policies.get(toolName);

      /*
       * Fail closed. Precedence, most specific first:
       *   1. the classifier's per-call verdict — it is the only thing that has
       *      looked at the *action*, which for a dispatcher is the only thing
       *      that says whether this call writes;
       *   2. the caller's tool-level flag (`ToolDefinition.sideEffecting`);
       *   3. the tool policy registered with `registerTools`;
       *   4. `true`.
       * A tool the gate has never been told about is side-effecting, because
       * the cost of a missing registration must be an extra approval card and
       * never an ungated write.
       */
      const sideEffecting =
        classification.sideEffecting ??
        ctx.sideEffecting ??
        policy?.sideEffecting ??
        true;

      if (!sideEffecting) return 'allow';

      const runId = ctx.runId || UNATTRIBUTED_RUN_ID;
      const action = classification.action ?? '';
      const capability = capabilityFingerprint(toolName, classification);
      const argsHash = argumentsHash(argsObject);

      const log = ctx.logger ?? logger;
      const base = {
        runId,
        stepId: ctx.stepId,
        toolCallId: ctx.toolCallId,
        toolName,
        action,
        toolArguments: argsObject,
        fingerprint: capability,
        argsHash,
        title:
          classification.title ?? policy?.title ?? humanize(toolName, action),
        summary: (() => {
          if (classification.summary) return classification.summary;
          try {
            return policy?.summarize?.(argsObject) ?? '';
          } catch {
            return '';
          }
        })(),
        rawDetail: JSON.stringify(argsObject, null, 2),
      };
      if (!base.summary) base.summary = `${toolName} ${compact(argsObject)}`;

      /* -- 0. master switch ------------------------------------------ */
      if (!settings.requireForSideEffecting) {
        // Off is a deliberate, loud choice — and the one setting under which an
        // audit trail matters most, so the call is still recorded in full.
        const id = randomId('apr');
        db.transaction(() => {
          store.insertApproval({
            ...base,
            id,
            status: 'approved',
            decision: 'approve',
            grantedScope: 'always',
            decidedBy: 'system:gate-disabled',
            requestedAt: at,
            resolvedAt: at,
            consumedAt: at,
          });
          audit({
            approvalId: id,
            runId,
            toolName,
            action,
            args: argsObject,
            decision: 'approve',
            scope: 'always',
            decidedBy: 'system:gate-disabled',
            at,
          });
        });
        log.warn('approval gate is disabled; allowing side-effecting call', {
          toolName,
          approvalId: id,
        });
        return 'allow';
      }

      /* -- 1. is this the same call we already handled? --------------- */
      const prior = store.findPriorForCall({
        runId,
        toolCallId: ctx.toolCallId,
        toolName,
        fingerprint: capability,
        argsHash,
      });

      if (prior) {
        if (prior.status === 'pending') {
          // The agent is polling. Hand back the same card; never stack
          // duplicates in front of the user.
          return pendingResult(prior);
        }
        if (prior.status === 'approved' && !prior.consumedAt) {
          // The re-dispatch of an approved call. Spending it here is what makes
          // `once` mean once: the next identical call finds nothing to consume.
          store.consume(prior.id, at);
          log.debug('approval consumed', {
            approvalId: prior.id,
            toolName,
            scope: prior.grantedScope,
          });
          return 'allow';
        }
        if (prior.status === 'denied') {
          /*
           * Sticky denial. A human said no to this exact call; repeating it
           * must not put the card back in front of them. An agent that keeps
           * retrying a denied action is the signature of prompt injection, so
           * every repeat is audited rather than silently dropped.
           */
          audit({
            approvalId: prior.id,
            runId,
            toolName,
            action,
            args: argsObject,
            decision: 'deny',
            scope: 'once',
            decidedBy: `denied:${prior.id}`,
            at,
          });
          log.warn('retry of a denied tool call', {
            toolName,
            approvalId: prior.id,
          });
          return deniedResult(prior);
        }
        // expired / cancelled / already-consumed: fall through and ask again.
      }

      /* -- 2. standing grants ---------------------------------------- */
      const grant = store.findMatchingGrant({
        toolName,
        fingerprint: capability,
        runId,
        nowIso: at,
      });

      if (grant) {
        const id = randomId('apr');
        db.transaction(() => {
          store.insertApproval({
            ...base,
            id,
            status: 'approved',
            decision: 'approve',
            grantedScope: grant.scope,
            decidedBy: `grant:${grant.id}`,
            requestedAt: at,
            resolvedAt: at,
            // Auto-approvals are used the instant they are made.
            consumedAt: at,
          });
          audit({
            approvalId: id,
            runId,
            toolName,
            action,
            args: argsObject,
            decision: 'approve',
            scope: grant.scope,
            decidedBy: `grant:${grant.id}`,
            at,
          });
        });
        log.debug('standing grant matched', {
          toolName,
          action,
          grantId: grant.id,
          scope: grant.scope,
        });
        return 'allow';
      }

      /* -- 3. miss: park it and return immediately -------------------- */
      const id = randomId('apr');
      const ttl = settings.pendingTtlMs;
      const expiresAt =
        ttl > 0 ? new Date(clock().getTime() + ttl).toISOString() : undefined;

      const row = db.transaction(() =>
        store.insertApproval({
          ...base,
          id,
          status: 'pending',
          requestedAt: at,
          expiresAt,
        }),
      );

      const approval = toApproval(row);
      events.emit('approval:requested', { approval });
      log.info('approval requested', {
        approvalId: id,
        toolName,
        action,
        runId,
      });

      return pendingResult(row);
    },

    /* ---------------------------------------------------------------- */
    /* Resolution                                                        */
    /* ---------------------------------------------------------------- */

    resolve(resolution: ApprovalResolution): Approval {
      const parsed = ApprovalResolutionSchema.parse(resolution);
      const row = store.getRow(parsed.approvalId);
      if (!row) {
        throw new Error(`Unknown approval: ${parsed.approvalId}`);
      }
      if (row.status !== 'pending') {
        logger.warn('approval already resolved', {
          approvalId: row.id,
          status: row.status,
        });
        return toApproval(row);
      }

      const at = nowIso();
      let scope: ApprovalScope = parsed.scope;

      // A denial never creates a standing grant. "Deny, always" would be a
      // useful feature; it is not this one, and quietly building a negative
      // grant out of a positive-grant table would be worse than not having it.
      if (parsed.decision === 'deny') scope = 'once';

      if (scope === 'always' && !settings.allowAlwaysScope) {
        logger.warn('always-scope grants are disabled; downgrading to run', {
          approvalId: row.id,
        });
        scope = 'run';
      }

      const status = parsed.decision === 'approve' ? 'approved' : 'denied';

      const updated = db.transaction(() => {
        const next = store.markResolved({
          id: row.id,
          status,
          decision: parsed.decision,
          scope,
          decidedBy: 'user',
          reason: parsed.reason,
          at,
          // Left unconsumed on purpose: the tool call that raised this approval
          // has not run yet, and the re-dispatch is what spends it.
        });

        if (parsed.decision === 'approve' && scope !== 'once') {
          const label =
            scope === 'always'
              ? `Always allow: ${row.title}`
              : `Allow for this run: ${row.title}`;
          store.insertGrant({
            id: randomId('grn'),
            scope,
            toolName: row.toolName,
            action: row.action,
            runId: scope === 'run' ? row.runId : undefined,
            // Always the capability fingerprint. Never null — see the note at
            // the top of this file.
            fingerprint: row.fingerprint,
            label,
            createdAt: at,
            sourceApprovalId: row.id,
          });
        }

        audit({
          approvalId: row.id,
          runId: row.runId,
          toolName: row.toolName,
          action: row.action,
          args: row.toolArguments,
          decision: parsed.decision,
          scope,
          decidedBy: 'user',
          at,
        });

        return next;
      });

      const finalRow = updated ?? row;
      emitResolved(finalRow, scope);
      logger.info('approval resolved', {
        approvalId: row.id,
        decision: parsed.decision,
        scope,
        toolName: row.toolName,
      });
      return toApproval(finalRow);
    },

    /* ---------------------------------------------------------------- */
    /* Reads                                                             */
    /* ---------------------------------------------------------------- */

    listPending(filter: PendingFilter = {}): Approval[] {
      return store.listPendingRows(filter).map(toApproval);
    },

    getApproval(id: string): Approval | null {
      const row = store.getRow(id);
      return row ? toApproval(row) : null;
    },

    listGrants(filter: GrantFilter = {}): ApprovalGrant[] {
      // `once` is not a standing grant and can never match one.
      if (filter.scope === 'once') return [];
      return store.listGrants(filter);
    },

    revokeGrant(id: string): boolean {
      const revoked = store.revokeGrant(id, nowIso());
      if (revoked) logger.info('grant revoked', { grantId: id });
      return revoked;
    },

    queryAudit(filter: AuditFilter = {}): ApprovalAuditEntry[] {
      return store.queryAudit(filter);
    },

    countAudit(filter: AuditFilter = {}): number {
      return store.countAudit(filter);
    },

    /* ---------------------------------------------------------------- */
    /* Registration                                                      */
    /* ---------------------------------------------------------------- */

    registerTools(tools) {
      for (const tool of tools) {
        policies.set(tool.name, {
          sideEffecting: tool.sideEffecting,
          title: tool.annotations?.title,
          summarize: tool.summarize
            ? (args: JsonObject) =>
                (tool.summarize as (input: unknown) => string)(args)
            : undefined,
        });
      }
      logger.debug('tool policies registered', { count: policies.size });
    },

    registerToolPolicy(toolName, policy) {
      policies.set(toolName, policy);
    },

    registerClassifier(toolName: string, classifier: ApprovalClassifier) {
      classifiers.register(toolName, classifier);
    },

    setDefaultClassifier(classifier: ApprovalClassifier | null) {
      classifiers.setDefault(classifier);
    },

    /* ---------------------------------------------------------------- */
    /* Lifecycle                                                         */
    /* ---------------------------------------------------------------- */

    endRun(runId: string) {
      const at = nowIso();
      let grantsExpired = 0;
      let cancelled: ApprovalRow[] = [];

      db.transaction(() => {
        // `run` grants die with their run. Nothing else needs to happen for
        // correctness — a grant row carries its run id and can never match a
        // different one — but leaving them alive would make the grants screen
        // lie about what is still in force.
        grantsExpired = store.expireRunGrants(runId, at);
        cancelled = store.cancelPendingForRun(runId, at);
        for (const row of cancelled) {
          audit({
            approvalId: row.id,
            runId: row.runId,
            toolName: row.toolName,
            action: row.action,
            args: row.toolArguments,
            decision: 'deny',
            scope: 'once',
            decidedBy: 'system:run-ended',
            at,
          });
        }
      });

      for (const row of cancelled) {
        events.emit('approval:resolved', {
          approvalId: row.id,
          runId: row.runId,
          decision: 'deny',
          scope: 'once',
        });
      }

      if (grantsExpired > 0 || cancelled.length > 0) {
        logger.info('run ended; approvals cleaned up', {
          runId,
          grantsExpired,
          pendingCancelled: cancelled.length,
        });
      }
      return { grantsExpired, pendingCancelled: cancelled.length };
    },

    sweepExpired(now?: Date): number {
      const at = (now ?? clock()).toISOString();
      let expired: ApprovalRow[] = [];
      db.transaction(() => {
        expired = store.expirePending(at);
        for (const row of expired) {
          audit({
            approvalId: row.id,
            runId: row.runId,
            toolName: row.toolName,
            action: row.action,
            args: row.toolArguments,
            decision: 'deny',
            scope: 'once',
            decidedBy: 'system:ttl',
            at,
          });
        }
      });

      for (const row of expired) {
        events.emit('approval:resolved', {
          approvalId: row.id,
          runId: row.runId,
          decision: 'deny',
          scope: 'once',
        });
      }
      if (expired.length > 0) {
        logger.info('expired stale approvals', { count: expired.length });
      }
      return expired.length;
    },

    reloadPending(): Approval[] {
      // Sweep first so a machine that was asleep for a day does not repopulate
      // the UI with a day-old card.
      service.sweepExpired();
      const pending = store.listPendingRows().map(toApproval);
      for (const approval of pending) {
        events.emit('approval:requested', { approval });
      }
      if (pending.length > 0) {
        logger.info('restored pending approvals', { count: pending.length });
      }
      return pending;
    },

    applySettings(next: ApprovalSettings) {
      settings = next;
    },

    settings() {
      return settings;
    },
  };

  return service;
}
