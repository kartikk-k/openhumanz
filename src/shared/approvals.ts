/**
 * The approval gate's data model.
 *
 * A side-effecting tool call that misses every standing grant becomes a
 * persisted `Approval` in state `pending`; the MCP response returns a handle
 * immediately and the orchestrator re-dispatches once a human resolves it.
 */
import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema, JsonObjectSchema } from './common';

/**
 * How far a granted approval reaches.
 * - `once`   — this call only.
 * - `run`    — every matching call for the rest of this run.
 * - `always` — a standing grant persisted across runs.
 *
 * All three ship from the start. Without `always`, users quit around the
 * fortieth calendar-read approval.
 */
export const APPROVAL_SCOPES = ['once', 'run', 'always'] as const;
export const ApprovalScopeSchema = z.enum(APPROVAL_SCOPES);
export type ApprovalScope = z.infer<typeof ApprovalScopeSchema>;

export const APPROVAL_DECISIONS = ['approve', 'deny'] as const;
export const ApprovalDecisionSchema = z.enum(APPROVAL_DECISIONS);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'denied',
  'expired',
  'cancelled',
] as const;
export const ApprovalStatusSchema = z.enum(APPROVAL_STATUSES);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

/**
 * A request for a human decision.
 *
 * `title` / `summary` are the plain-language rendering shown on the approval
 * card; `toolArguments` is the raw payload shown on expand.
 */
export const ApprovalSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  stepId: IdSchema.optional(),
  toolCallId: IdSchema.optional(),
  toolName: z.string().min(1),
  toolArguments: JsonObjectSchema.default({}),
  /** Stable hash of (toolName, normalised arguments). Grants match on this. */
  fingerprint: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().default(''),
  /** Verbatim command / request, shown when the card is expanded. */
  rawDetail: z.string().optional(),
  status: ApprovalStatusSchema.default('pending'),
  decision: ApprovalDecisionSchema.optional(),
  grantedScope: ApprovalScopeSchema.optional(),
  requestedAt: IsoDateTimeSchema,
  resolvedAt: IsoDateTimeSchema.optional(),
  expiresAt: IsoDateTimeSchema.optional(),
  /** Free-text note the user attached when denying. */
  reason: z.string().optional(),
});
export type Approval = z.infer<typeof ApprovalSchema>;
export type ApprovalInput = z.input<typeof ApprovalSchema>;

/**
 * A standing grant. Created when a user picks `run` or `always`.
 * `runId` is set for `run` scope and null for `always`.
 */
export const ApprovalGrantSchema = z.object({
  id: IdSchema,
  scope: z.enum(['run', 'always']),
  toolName: z.string().min(1),
  runId: IdSchema.optional(),
  /**
   * When present the grant only matches calls with this fingerprint;
   * when absent it matches any call to `toolName`.
   */
  fingerprint: z.string().optional(),
  createdAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema.optional(),
  /** Human-readable rendering, e.g. "Always allow reading calendar events". */
  label: z.string().default(''),
});
export type ApprovalGrant = z.infer<typeof ApprovalGrantSchema>;

/** Payload the UI sends back when the user presses a button on the card. */
export const ApprovalResolutionSchema = z.object({
  approvalId: IdSchema,
  decision: ApprovalDecisionSchema,
  scope: ApprovalScopeSchema.default('once'),
  reason: z.string().optional(),
});
export type ApprovalResolution = z.infer<typeof ApprovalResolutionSchema>;

/**
 * What a tool handler receives back from the gate when a decision is not yet
 * available. Returned to the agent immediately — never block the MCP response
 * on a human.
 */
export const ApprovalPendingHandleSchema = z.object({
  status: z.literal('pending_approval'),
  approvalId: IdSchema,
  pollAfterMs: z.number().int().positive().default(2000),
  message: z.string().default('Waiting for the user to approve this action.'),
});
export type ApprovalPendingHandle = z.infer<typeof ApprovalPendingHandleSchema>;

/** Audit row. Every decision is logged with full arguments. */
export const ApprovalAuditEntrySchema = z.object({
  id: IdSchema,
  approvalId: IdSchema,
  runId: IdSchema,
  toolName: z.string(),
  toolArguments: JsonObjectSchema.default({}),
  decision: ApprovalDecisionSchema,
  scope: ApprovalScopeSchema,
  /** `user` for an explicit press, `grant:<id>` when a standing grant matched. */
  decidedBy: z.string().default('user'),
  at: IsoDateTimeSchema,
});
export type ApprovalAuditEntry = z.infer<typeof ApprovalAuditEntrySchema>;
