/**
 * Runs, steps, tool calls and the run event stream.
 *
 * The run timeline is the highest-value surface in the product, so the event
 * stream is modelled explicitly rather than as an opaque chat log.
 */
import { z } from 'zod';
import {
  IdSchema,
  IsoDateTimeSchema,
  JsonObjectSchema,
  LogLevelSchema,
  UsageSchema,
} from './common';
import {
  ApprovalDecisionSchema,
  ApprovalSchema,
  ApprovalScopeSchema,
} from './approvals';

export const RUN_STATUSES = [
  'queued',
  'running',
  'awaiting_approval',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export const RunStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/** A run is finished when its status is one of these. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
];

export const RUN_TRIGGERS = [
  'manual',
  'schedule',
  'watcher',
  'system',
] as const;
export const RunTriggerSchema = z.enum(RUN_TRIGGERS);
export type RunTrigger = z.infer<typeof RunTriggerSchema>;

export const RUN_STEP_STATUSES = [
  'pending',
  'running',
  'awaiting_approval',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
] as const;
export const RunStepStatusSchema = z.enum(RUN_STEP_STATUSES);
export type RunStepStatus = z.infer<typeof RunStepStatusSchema>;

/**
 * Why a run or step ended badly.
 *
 * `quota` and `rate_limit` are separated from everything else on purpose: they
 * are the most likely real-world failure and the only ones where the right UI
 * copy is "your plan is out of capacity", not "something went wrong". A
 * timeline that can only say `failed` cannot tell those apart, which is why
 * this is a field rather than a substring of `error`.
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
export const FailureKindSchema = z.enum(FAILURE_KINDS);
export type FailureKind = z.infer<typeof FailureKindSchema>;

/** True when a failure means "the account is out of capacity", not "a bug". */
export function isQuotaFailure(kind: string | undefined): boolean {
  return kind === 'quota' || kind === 'rate_limit';
}

export const TOOL_CALL_STATUSES = [
  'pending',
  'awaiting_approval',
  'denied',
  'running',
  'succeeded',
  'failed',
] as const;
export const ToolCallStatusSchema = z.enum(TOOL_CALL_STATUSES);
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;

/**
 * A single tool invocation that terminated inside our process.
 * Native CLI tools (file read/edit/shell) do not produce these.
 */
export const ToolCallSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  stepId: IdSchema.optional(),
  name: z.string().min(1),
  arguments: JsonObjectSchema.default({}),
  sideEffecting: z.boolean().default(false),
  status: ToolCallStatusSchema.default('pending'),
  approvalId: IdSchema.optional(),
  startedAt: IsoDateTimeSchema,
  finishedAt: IsoDateTimeSchema.optional(),
  durationMs: z.number().int().nonnegative().optional(),
  /** Compact rendering of the result. Full payload lives in the transcript. */
  resultSummary: z.string().optional(),
  error: z.string().optional(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

/**
 * One engine invocation. The app controls the step boundary; the engine owns
 * the inner loop. Turn and budget limits are set on every step.
 */
export const RunStepSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  index: z.number().int().nonnegative(),
  name: z.string().min(1),
  status: RunStepStatusSchema.default('pending'),
  prompt: z.string().default(''),
  /** Tool names this step is scoped to. The MCP server enforces it too. */
  allowedTools: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  sessionId: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  maxCostUsd: z.number().positive().optional(),
  startedAt: IsoDateTimeSchema.optional(),
  finishedAt: IsoDateTimeSchema.optional(),
  durationMs: z.number().int().nonnegative().optional(),
  usage: UsageSchema.optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  /** Set whenever `status` is `failed`. Names the failure for the timeline. */
  failureKind: FailureKindSchema.optional(),
  metadata: JsonObjectSchema.default({}),
});
export type RunStep = z.infer<typeof RunStepSchema>;

export const RunSchema = z.object({
  id: IdSchema,
  title: z.string().min(1),
  status: RunStatusSchema.default('queued'),
  trigger: RunTriggerSchema.default('manual'),
  /** Engine adapter id, e.g. `claude-code`. */
  engine: z.string().min(1),
  prompt: z.string().default(''),
  cwd: z.string().optional(),
  sessionId: z.string().optional(),
  goalId: IdSchema.optional(),
  taskId: IdSchema.optional(),
  scheduledJobId: IdSchema.optional(),
  createdAt: IsoDateTimeSchema,
  startedAt: IsoDateTimeSchema.optional(),
  finishedAt: IsoDateTimeSchema.optional(),
  durationMs: z.number().int().nonnegative().optional(),
  usage: UsageSchema.optional(),
  error: z.string().optional(),
  /**
   * Set whenever `status` is `failed` (and to `cancelled` on a cancel). This
   * used to be mirrored into `metadata.failureKind` because there was no field
   * for it; the timeline reads it here now.
   */
  failureKind: FailureKindSchema.optional(),
  metadata: JsonObjectSchema.default({}),
});
export type Run = z.infer<typeof RunSchema>;

/** A run plus everything the timeline view needs in one payload. */
export const RunDetailSchema = z.object({
  run: RunSchema,
  steps: z.array(RunStepSchema),
  toolCalls: z.array(ToolCallSchema),
  pendingApprovals: z.array(ApprovalSchema),
});
export type RunDetail = z.infer<typeof RunDetailSchema>;

/* ------------------------------------------------------------------ */
/* Run events                                                          */
/* ------------------------------------------------------------------ */

/**
 * Fields present on every run event. `seq` is monotonic per run so the
 * renderer can detect gaps after a reconnect and re-fetch.
 */
const eventBase = {
  runId: IdSchema,
  seq: z.number().int().nonnegative(),
  at: IsoDateTimeSchema,
};

export const RunEventSchema = z.discriminatedUnion('type', [
  z.object({ ...eventBase, type: z.literal('run.started'), run: RunSchema }),
  z.object({
    ...eventBase,
    type: z.literal('run.status'),
    status: RunStatusSchema,
  }),
  z.object({
    ...eventBase,
    type: z.literal('step.started'),
    step: RunStepSchema,
  }),
  z.object({
    ...eventBase,
    type: z.literal('step.finished'),
    step: RunStepSchema,
  }),
  z.object({
    ...eventBase,
    type: z.literal('message'),
    stepId: IdSchema.optional(),
    role: z.enum(['assistant', 'user', 'system']),
    text: z.string(),
  }),
  z.object({
    ...eventBase,
    type: z.literal('tool.call'),
    call: ToolCallSchema,
  }),
  z.object({
    ...eventBase,
    type: z.literal('tool.result'),
    call: ToolCallSchema,
  }),
  z.object({
    ...eventBase,
    type: z.literal('approval.requested'),
    approval: ApprovalSchema,
  }),
  z.object({
    ...eventBase,
    type: z.literal('approval.resolved'),
    approvalId: IdSchema,
    decision: ApprovalDecisionSchema,
    scope: ApprovalScopeSchema,
  }),
  z.object({
    ...eventBase,
    type: z.literal('usage'),
    stepId: IdSchema.optional(),
    usage: UsageSchema,
  }),
  z.object({
    ...eventBase,
    type: z.literal('log'),
    level: LogLevelSchema,
    message: z.string(),
  }),
  z.object({
    ...eventBase,
    type: z.literal('run.finished'),
    status: RunStatusSchema,
    usage: UsageSchema.optional(),
    error: z.string().optional(),
    /** So a live timeline can say "out of quota" without re-fetching the run. */
    failureKind: FailureKindSchema.optional(),
  }),
]);
export type RunEvent = z.infer<typeof RunEventSchema>;
export type RunEventType = RunEvent['type'];

/** Narrow a `RunEvent` to one variant. */
export type RunEventOf<T extends RunEventType> = Extract<RunEvent, { type: T }>;

/* ------------------------------------------------------------------ */
/* Requests                                                            */
/* ------------------------------------------------------------------ */

export const RunListQuerySchema = z.object({
  status: z.array(RunStatusSchema).optional(),
  goalId: IdSchema.optional(),
  taskId: IdSchema.optional(),
  scheduledJobId: IdSchema.optional(),
  search: z.string().optional(),
  limit: z.number().int().positive().max(500).default(50),
  offset: z.number().int().nonnegative().default(0),
});
export type RunListQuery = z.infer<typeof RunListQuerySchema>;
export type RunListQueryInput = z.input<typeof RunListQuerySchema>;

/**
 * One step of an explicit decomposition supplied by the caller.
 *
 * Every ceiling is optional here and filled in by the planner, which clamps it
 * to the run-level budget — a step may ask for less than the run allows, never
 * more. This shape was the orchestrator's private `PlanInputSchema`; it is
 * contract now because the scheduler and the composer both send one.
 */
export const RunStepInputSchema = z.object({
  name: z.string().min(1),
  prompt: z.string().min(1),
  allowedTools: z.array(z.string()).optional(),
  maxTurns: z.number().int().positive().optional(),
  maxCostUsd: z.number().positive().optional(),
  cwd: z.string().optional(),
  /** Resume the previous step's engine session instead of starting fresh. */
  continueSession: z.boolean().optional(),
  model: z.string().optional(),
});
export type RunStepInput = z.infer<typeof RunStepInputSchema>;

/** An explicit decomposition: an optional title plus at least one step. */
export const RunPlanInputSchema = z.object({
  title: z.string().min(1).optional(),
  steps: z.array(RunStepInputSchema).min(1),
});
export type RunPlanInput = z.infer<typeof RunPlanInputSchema>;

export const RunStartRequestSchema = z.object({
  title: z.string().min(1).optional(),
  prompt: z.string().min(1),
  engine: z.string().optional(),
  trigger: RunTriggerSchema.default('manual'),
  cwd: z.string().optional(),
  goalId: IdSchema.optional(),
  taskId: IdSchema.optional(),
  scheduledJobId: IdSchema.optional(),
  /**
   * Resume a prior engine session instead of starting fresh, so the run
   * inherits that session's conversation history. Bots use this to give a bot
   * thread continuity across turns (each turn is a separate run, but they share
   * one engine session). Omit for a fresh, memoryless run.
   */
  resumeSessionId: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  maxTurns: z.number().int().positive().optional(),
  maxCostUsd: z.number().positive().optional(),
  /**
   * An explicit decomposition. Shorthand for `plan: { steps }`; if both are
   * given, `plan` wins because it can also carry a title.
   *
   * Omit both and the run is a single step containing the whole prompt — the
   * honest default, since guessing a decomposition without a model to do it
   * splits the budget without splitting the blast radius.
   */
  steps: z.array(RunStepInputSchema).min(1).optional(),
  plan: RunPlanInputSchema.optional(),
  metadata: JsonObjectSchema.optional(),
});
export type RunStartRequest = z.infer<typeof RunStartRequestSchema>;
export type RunStartRequestInput = z.input<typeof RunStartRequestSchema>;

export const RunEventsQuerySchema = z.object({
  runId: IdSchema,
  /** Return events with `seq` strictly greater than this. */
  sinceSeq: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().max(2000).default(1000),
});
export type RunEventsQuery = z.infer<typeof RunEventsQuerySchema>;
export type RunEventsQueryInput = z.input<typeof RunEventsQuerySchema>;
