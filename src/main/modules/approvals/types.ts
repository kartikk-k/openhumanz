/**
 * The approval gate's public surface.
 *
 * {@link ApprovalGate} is deliberately tiny: it is the shape the MCP server
 * injects, and it is the only thing a tool-dispatch path needs to know about
 * approvals. Everything else the UI and the orchestrator need lives on
 * {@link ApprovalService}, which extends it.
 */
import type { JsonObject } from '../../../shared/common';
import type {
  Approval,
  ApprovalAuditEntry,
  ApprovalDecision,
  ApprovalGrant,
  ApprovalPendingHandle,
  ApprovalResolution,
  ApprovalScope,
} from '../../../shared/approvals';
import type { Logger } from '../../infra/logger';
import type { AnyToolDefinition } from '../types';
import type { ApprovalClassifier } from './classify';

/** Run id used when a call arrives with no run attached (IPC, tests, probes). */
export const UNATTRIBUTED_RUN_ID = 'unattributed';

/**
 * What the gate is told about the call it is checking. Every field is optional
 * so any caller-side context object structurally satisfies it — in particular
 * `modules/types.ToolCallContext`.
 */
export interface ApprovalCheckContext {
  readonly runId?: string;
  readonly stepId?: string;
  /**
   * Identity of this specific tool call. Supply it: it is what lets the gate
   * tell a *re-dispatch of the approved call* apart from *the next call that
   * happens to look the same*, which is the whole meaning of `once`.
   */
  readonly toolCallId?: string;
  /**
   * Overrides the registered tool policy for this call. Only pass this when
   * you know better than {@link ApprovalService.registerTools}.
   */
  readonly sideEffecting?: boolean;
  readonly logger?: Logger;
}

/**
 * The miss branch: a human has to decide.
 *
 * `pending` / `pollAfterMs` / `message` are exactly the fields
 * `services/mcp/approvals.ts` reads, so this composes with the MCP server with
 * no adapter. The rest is extra for the orchestrator and the UI.
 */
export interface ApprovalPendingResult {
  readonly pending: string;
  /** Hint for the agent's next poll. */
  readonly pollAfterMs: number;
  readonly message: string;
  readonly status: 'pending';
  readonly approval: Approval;
  /** Ready to serialise straight into an MCP tool result. */
  readonly handle: ApprovalPendingHandle;
}

/**
 * Refused. Returned for a repeat of a call a human already denied — the card is
 * never put back in front of them, and the agent is told plainly to stop.
 */
export interface ApprovalDeniedResult {
  /** Short, actionable; the MCP server shows this to the agent verbatim. */
  readonly denied: string;
  readonly approvalId: string;
  readonly approval: Approval;
}

export type ApprovalCheckResult =
  'allow' | ApprovalPendingResult | ApprovalDeniedResult;

/**
 * The injectable gate. Structurally identical to
 * `services/mcp/approvals.ts#ApprovalGate`, deliberately.
 *
 * `check` **never blocks on a human**. It returns within a database round trip:
 * `'allow'`, a handle to a persisted pending approval that the caller hands back
 * to the agent immediately, or an outright refusal. Holding an MCP response open
 * waiting for a person reliably hits client timeouts.
 */
export interface ApprovalGate {
  check(
    toolName: string,
    args: unknown,
    ctx?: ApprovalCheckContext,
  ): Promise<ApprovalCheckResult>;
}

/** What the gate needs to know about a tool. */
export interface ToolPolicy {
  /**
   * Fail-closed default. A tool the gate has never heard of is treated as
   * side-effecting, because the failure mode of a missing registration must be
   * "an extra approval card", not "an ungated write".
   */
  sideEffecting: boolean;
  /** Plain-language rendering for the card. */
  summarize?(args: JsonObject): string;
  title?: string;
}

export interface PendingFilter {
  runId?: string;
  limit?: number;
}

export interface GrantFilter {
  scope?: ApprovalScope;
  runId?: string;
  toolName?: string;
  /** Include revoked and expired grants. Default false. */
  includeInactive?: boolean;
}

export interface AuditFilter {
  approvalId?: string;
  runId?: string;
  toolName?: string;
  decision?: ApprovalDecision;
  /** ISO timestamps, inclusive. */
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface ApprovalService extends ApprovalGate {
  /* --- resolution ------------------------------------------------- */
  /**
   * Record a human decision. Creates a standing grant for `run` / `always`,
   * writes an audit row with the full arguments, emits `approval:resolved`.
   */
  resolve(resolution: ApprovalResolution): Approval;

  /* --- reads ------------------------------------------------------ */
  listPending(filter?: PendingFilter): Approval[];
  getApproval(id: string): Approval | null;
  listGrants(filter?: GrantFilter): ApprovalGrant[];
  revokeGrant(id: string): boolean;
  /** The audit log. Every decision, with the arguments it was made about. */
  queryAudit(filter?: AuditFilter): ApprovalAuditEntry[];

  /* --- registration ----------------------------------------------- */
  /** Take `sideEffecting` and `summarize` from the live MCP tool surface. */
  registerTools(tools: readonly AnyToolDefinition[]): void;
  registerToolPolicy(toolName: string, policy: ToolPolicy): void;
  /** The generic-dispatcher hook. See `classify.ts`. */
  registerClassifier(toolName: string, classifier: ApprovalClassifier): void;
  setDefaultClassifier(classifier: ApprovalClassifier | null): void;

  /* --- lifecycle -------------------------------------------------- */
  /** Expire `run`-scoped grants and cancel pendings for a finished run. */
  endRun(runId: string): { grantsExpired: number; pendingCancelled: number };
  /** Expire pendings older than `pendingTtlMs`. Returns how many. */
  sweepExpired(now?: Date): number;
  /**
   * Re-emit `approval:requested` for everything still pending. Called on start
   * so an app restart repopulates the UI rather than stranding the approvals.
   */
  reloadPending(): Approval[];
}
