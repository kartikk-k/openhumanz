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
import { IdSchema, IsoDateTimeSchema, JsonObjectSchema } from './common';
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
});
export type ScheduledJobCreate = z.infer<typeof ScheduledJobCreateSchema>;
export type ScheduledJobCreateInput = z.input<typeof ScheduledJobCreateSchema>;

export const ScheduledJobUpdateSchema = ScheduledJobSchema.omit({
  createdAt: true,
  updatedAt: true,
})
  .partial()
  .extend({ id: IdSchema });
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

/** Result of validating a cron expression before it is stored. */
export const CronValidationSchema = z.object({
  valid: z.boolean(),
  humanReadable: z.string().default(''),
  nextRuns: z.array(IsoDateTimeSchema).default([]),
  error: z.string().optional(),
});
export type CronValidation = z.infer<typeof CronValidationSchema>;
