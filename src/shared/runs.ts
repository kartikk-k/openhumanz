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
  z.object({ ...eventBase, type: z.literal('step.started'), step: RunStepSchema }),
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
  z.object({ ...eventBase, type: z.literal('tool.call'), call: ToolCallSchema }),
  z.object({ ...eventBase, type: z.literal('tool.result'), call: ToolCallSchema }),
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

export const RunStartRequestSchema = z.object({
  title: z.string().min(1).optional(),
  prompt: z.string().min(1),
  engine: z.string().optional(),
  trigger: RunTriggerSchema.default('manual'),
  cwd: z.string().optional(),
  goalId: IdSchema.optional(),
  taskId: IdSchema.optional(),
  scheduledJobId: IdSchema.optional(),
  allowedTools: z.array(z.string()).optional(),
  maxTurns: z.number().int().positive().optional(),
  maxCostUsd: z.number().positive().optional(),
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
