/**
 * Scheduled jobs.
 *
 * Two hard rules from ARCHITECTURE.md are encoded here:
 *  1. No natural-language date parser. The agent emits cron, we validate it
 *     with `cron-parser` and echo it back in English (`humanReadable`).
 *  2. A CLI invocation never sits on an unconditional timer. Every job carries
 *     a deterministic `condition` that must pass before anything is spawned.
 */
import { z } from 'zod';
import {
  IdSchema,
  IsoDateTimeSchema,
  JsonObjectSchema,
  patchSchema,
} from './common';
import { RunStatusSchema } from './runs';

/**
 * The cheap, deterministic precondition checked before spawning an engine.
 * `always` exists but should be rare — an unconditional five-minute heartbeat
 * exhausts a weekly quota by Tuesday.
 */
export const ScheduleConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('always') }),
  z.object({
    kind: z.literal('file-changed'),
    /** Absolute path or a path relative to the workspace root. */
    path: z.string().min(1),
    /** Last mtime we acted on, epoch ms. Updated by the schedule module. */
    lastSeenMtimeMs: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal('counter-changed'),
    /** Opaque source key, e.g. `mail:unread`. */
    source: z.string().min(1),
    lastSeenValue: z.number().int().optional(),
  }),
  z.object({
    kind: z.literal('time-window'),
    /** Local hours, 0-23, inclusive start / exclusive end. */
    startHour: z.number().int().min(0).max(23),
    endHour: z.number().int().min(0).max(24),
    /** 0 = Sunday. Empty means every day. */
    weekdays: z.array(z.number().int().min(0).max(6)).default([]),
  }),
]);
export type ScheduleCondition = z.infer<typeof ScheduleConditionSchema>;
export type ScheduleConditionKind = ScheduleCondition['kind'];

export const MISSED_RUN_POLICIES = ['skip', 'catch-up'] as const;
/**
 * What to do with an occurrence that came due while the app was closed (or
 * while the machine was asleep).
 *
 * - `skip`     — record the miss and move on to the next occurrence.
 * - `catch-up` — evaluate the condition now and dispatch once, collapsing every
 *                missed occurrence into a single run. Never a burst.
 */
export const MissedRunPolicySchema = z.enum(MISSED_RUN_POLICIES);
export type MissedRunPolicy = z.infer<typeof MissedRunPolicySchema>;

export const DEFAULT_MISSED_RUN_POLICY: MissedRunPolicy = 'skip';

export function isMissedRunPolicy(value: unknown): value is MissedRunPolicy {
  return (
    typeof value === 'string' &&
    (MISSED_RUN_POLICIES as readonly string[]).includes(value)
  );
}

export const ScheduledJobSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  description: z.string().default(''),
  /** Standard 5- or 6-field cron expression. Validated with cron-parser. */
  cron: z.string().min(1),
  /** IANA timezone. Defaults to the host zone at creation time. */
  timezone: z.string().default('UTC'),
  /** Plain-English rendering of `cron`, shown in the jobs table. */
  humanReadable: z.string().default(''),
  enabled: z.boolean().default(true),
  condition: ScheduleConditionSchema.default({ kind: 'always' }),
  /** Prompt handed to the engine when the job fires. */
  prompt: z.string().min(1),
  engine: z.string().optional(),
  allowedTools: z.array(z.string()).default([]),
  maxTurns: z.number().int().positive().optional(),
  maxCostUsd: z.number().positive().optional(),
  nextRunAt: IsoDateTimeSchema.optional(),
  lastRunAt: IsoDateTimeSchema.optional(),
  lastRunId: IdSchema.optional(),
  lastStatus: RunStatusSchema.optional(),
  /** Set when the condition failed, so the table can say "skipped: no new mail". */
  lastSkipReason: z.string().optional(),
  /** What to do with occurrences that came due while the app was closed. */
  missedRunPolicy: MissedRunPolicySchema.default(DEFAULT_MISSED_RUN_POLICY),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  metadata: JsonObjectSchema.default({}),
});
export type ScheduledJob = z.infer<typeof ScheduledJobSchema>;

export const ScheduledJobCreateSchema = ScheduledJobSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  nextRunAt: true,
  lastRunAt: true,
  lastRunId: true,
  lastStatus: true,
  lastSkipReason: true,
  humanReadable: true,
}).partial({
  description: true,
  timezone: true,
  enabled: true,
  condition: true,
  allowedTools: true,
  metadata: true,
  missedRunPolicy: true,
});
export type ScheduledJobCreate = z.infer<typeof ScheduledJobCreateSchema>;
export type ScheduledJobCreateInput = z.input<typeof ScheduledJobCreateSchema>;

/**
 * A patch. {@link patchSchema}, not `.partial()` — the same hazard as the task
 * and goal patches: `.partial()` would have `parse({ id })` come back with
 * `enabled: true`, `condition: {kind:'always'}` and `timezone: 'UTC'`, so
 * renaming a job would re-enable it, drop its condition gate (turning a gated
 * job into an unconditional heartbeat) and move it to UTC.
 */
export const ScheduledJobUpdateSchema = patchSchema(
  ScheduledJobSchema.omit({ createdAt: true, updatedAt: true }),
).extend({ id: IdSchema });
export type ScheduledJobUpdate = z.infer<typeof ScheduledJobUpdateSchema>;

export const ScheduleRunNowRequestSchema = z.object({
  id: IdSchema,
  /** Run even if the deterministic condition says there is nothing to do. */
  ignoreCondition: z.boolean().default(true),
});
export type ScheduleRunNowRequest = z.infer<typeof ScheduleRunNowRequestSchema>;
export type ScheduleRunNowRequestInput = z.input<
  typeof ScheduleRunNowRequestSchema
>;

/* ------------------------------------------------------------------ */
/* Run history                                                         */
/* ------------------------------------------------------------------ */

/** Why a job fired. */
export const SCHEDULE_TRIGGERS = ['cron', 'catch-up', 'manual'] as const;
export const ScheduleTriggerSchema = z.enum(SCHEDULE_TRIGGERS);
export type ScheduleTrigger = z.infer<typeof ScheduleTriggerSchema>;

export const SCHEDULE_RUN_STATUSES = [
  'dispatched',
  'skipped',
  'error',
] as const;
export const ScheduleRunStatusSchema = z.enum(SCHEDULE_RUN_STATUSES);
export type ScheduleRunStatus = z.infer<typeof ScheduleRunStatusSchema>;

/**
 * One evaluation of a job.
 *
 * Every wake-up writes one of these, including the ones that decided *not* to
 * spawn. The skip history is the evidence that the condition gate works; a
 * table full of `skipped / condition did not pass` rows is the design
 * succeeding, not failing.
 */
export const ScheduleRunRecordSchema = z.object({
  id: IdSchema,
  jobId: IdSchema,
  trigger: ScheduleTriggerSchema,
  /** The cron occurrence being served, ISO-8601. Null for a manual run. */
  scheduledFor: IsoDateTimeSchema.nullable(),
  startedAt: IsoDateTimeSchema,
  finishedAt: IsoDateTimeSchema,
  /** Wall time spent evaluating the condition and handing off the dispatch. */
  durationMs: z.number().int().nonnegative(),
  status: ScheduleRunStatusSchema,
  conditionKind: z.string(),
  conditionPassed: z.boolean(),
  /** Plain-language outcome, e.g. "unread count unchanged (7)". */
  conditionReason: z.string(),
  missedCount: z.number().int().nonnegative(),
  /** Set when the dispatcher came back with one. */
  runId: IdSchema.nullable(),
  error: z.string().nullable(),
});
export type ScheduleRunRecord = z.infer<typeof ScheduleRunRecordSchema>;

/** Query for {@link ScheduleRunRecord} history. */
export const ScheduleHistoryQuerySchema = z.object({
  jobId: IdSchema.optional(),
  status: ScheduleRunStatusSchema.optional(),
  limit: z.number().int().positive().max(500).default(50),
  offset: z.number().int().nonnegative().default(0),
});
export type ScheduleHistoryQuery = z.infer<typeof ScheduleHistoryQuerySchema>;
export type ScheduleHistoryQueryInput = z.input<
  typeof ScheduleHistoryQuerySchema
>;

/** Result of validating a cron expression before it is stored. */
export const CronValidationSchema = z.object({
  valid: z.boolean(),
  humanReadable: z.string().default(''),
  nextRuns: z.array(IsoDateTimeSchema).default([]),
  error: z.string().optional(),
});
export type CronValidation = z.infer<typeof CronValidationSchema>;
