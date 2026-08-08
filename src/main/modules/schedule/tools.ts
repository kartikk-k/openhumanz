/**
 * The schedule module's slice of the MCP surface: the six operations, and
 * nothing else.
 *
 * Two things carry real weight here.
 *
 * **`summarize()` is the approval card.** For a mutating tool that string is
 * what a human reads before saying yes, so it says what will happen in English
 * — including the cron *described*, not quoted. "every weekday at 9:00 AM" is
 * checkable at a glance; `0 9 * * 1-5` is not. That is the whole plain-English
 * composer loop: the agent emits cron, we validate it and echo it back.
 *
 * **Results stay compact.** Lists are truncated and return a total; full detail
 * is a fetch-by-id away. A tool that returns forty jobs with their prompts
 * spends the context window the jobs were supposed to save.
 */
import { z } from 'zod';
import {
  ScheduleConditionSchema,
  type ScheduledJob,
} from '../../../shared/schedule';
import { defineTool, type AnyToolDefinition } from '../types';
import { describeCondition } from './conditions';
import { describeCron } from './describe';
import { MISSED_RUN_POLICIES } from './types';
import { missedRunPolicyOf } from './store';
import type { Scheduler } from './scheduler';

const MissedRunPolicySchema = z
  .enum(MISSED_RUN_POLICIES)
  .default('skip')
  .describe(
    'What to do with an occurrence that came due while the app was closed. ' +
      '"skip" records the miss and waits for the next one; "catch-up" runs it ' +
      'once on relaunch.',
  );

const CronField = z
  .string()
  .min(1)
  .describe(
    'A 5- or 6-field cron expression, e.g. "0 9 * * 1-5" for every weekday at ' +
      '09:00. Validated before it is stored and echoed back in English.',
  );

const ConditionField = ScheduleConditionSchema.describe(
  'The cheap, deterministic check made before anything is spawned. Prefer a ' +
    'real condition ("file-changed", "counter-changed", "time-window"); ' +
    '"always" runs the job on every tick and should be rare.',
);

/** Trim a prompt for display without pretending it is complete. */
function truncate(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** The shape returned by every job-shaped tool result. Small on purpose. */
function compactJob(job: ScheduledJob): Record<string, unknown> {
  return {
    id: job.id,
    name: job.name,
    schedule: job.humanReadable || describeCron(job.cron, job.timezone),
    cron: job.cron,
    timezone: job.timezone,
    enabled: job.enabled,
    recurring: job.recurring,
    condition: describeCondition(job.condition),
    missedRunPolicy: missedRunPolicyOf(job),
    nextRunAt: job.nextRunAt ?? null,
    lastRunAt: job.lastRunAt ?? null,
    lastStatus: job.lastStatus ?? null,
    lastSkipReason: job.lastSkipReason ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Input schemas                                                       */
/* ------------------------------------------------------------------ */

const CreateInput = z.object({
  name: z.string().min(1).describe('Short label shown in the jobs table.'),
  cron: CronField,
  prompt: z
    .string()
    .min(1)
    .describe('The prompt handed to the engine when the job fires.'),
  description: z.string().default(''),
  timezone: z
    .string()
    .optional()
    .describe('IANA timezone, e.g. "Europe/Lisbon". Defaults to this machine.'),
  condition: ConditionField.default({ kind: 'always' }),
  missedRunPolicy: MissedRunPolicySchema,
  enabled: z.boolean().default(true),
  recurring: z
    .boolean()
    .default(true)
    .describe(
      'Whether the job repeats. Set false for a one-time reminder — it fires ' +
        'once at the next cron occurrence and is then disabled (kept in the ' +
        'list as history, not deleted).',
    ),
  engine: z.string().optional(),
  allowedTools: z.array(z.string()).default([]),
  maxTurns: z.number().int().positive().optional(),
  maxCostUsd: z.number().positive().optional(),
});
type CreateArgs = z.infer<typeof CreateInput>;

const ListInput = z.object({
  enabledOnly: z.boolean().default(false),
  limit: z.number().int().positive().max(100).default(50),
});
type ListArgs = z.infer<typeof ListInput>;

const UpdateInput = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  cron: CronField.optional(),
  prompt: z.string().min(1).optional(),
  description: z.string().optional(),
  timezone: z.string().optional(),
  condition: ConditionField.optional(),
  missedRunPolicy: z.enum(MISSED_RUN_POLICIES).optional(),
  enabled: z.boolean().optional(),
  engine: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  maxTurns: z.number().int().positive().optional(),
  maxCostUsd: z.number().positive().optional(),
});
type UpdateArgs = z.infer<typeof UpdateInput>;

const DeleteInput = z.object({ id: z.string().min(1) });
type DeleteArgs = z.infer<typeof DeleteInput>;

const RunNowInput = z.object({
  id: z.string().min(1),
  ignoreCondition: z
    .boolean()
    .default(true)
    .describe(
      "Run even when the job's condition says there is nothing to do. Set " +
        'false to test whether the condition currently passes.',
    ),
});
type RunNowArgs = z.infer<typeof RunNowInput>;

const HistoryInput = z.object({
  jobId: z.string().optional(),
  status: z.enum(['dispatched', 'skipped', 'error']).optional(),
  limit: z.number().int().positive().max(100).default(20),
});
type HistoryArgs = z.infer<typeof HistoryInput>;

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

export function createTools(scheduler: Scheduler): AnyToolDefinition[] {
  const create = defineTool<CreateArgs>({
    name: 'schedule_create',
    description:
      'Create a scheduled job. Give a cron expression (no natural-language ' +
      'dates) and a condition that must pass before the job is allowed to ' +
      'spawn a run. The cron is validated and returned in English.',
    inputSchema: CreateInput,
    sideEffecting: true,
    annotations: { title: 'Create scheduled job' },
    summarize: (input) => {
      const when = describeCron(input.cron, input.timezone);
      const parsed = ScheduleConditionSchema.safeParse(input.condition);
      const gate = parsed.success
        ? describeCondition(parsed.data)
        : 'always (no precondition)';
      return (
        `Create scheduled job "${input.name}" — ${when}, ${gate}. ` +
        `It will run: "${truncate(input.prompt)}"`
      );
    },
    handler: async (input) => {
      const job = await scheduler.create({
        name: input.name,
        description: input.description,
        cron: input.cron,
        timezone: input.timezone,
        prompt: input.prompt,
        condition: input.condition,
        enabled: input.enabled,
        recurring: input.recurring,
        engine: input.engine,
        allowedTools: input.allowedTools,
        maxTurns: input.maxTurns,
        maxCostUsd: input.maxCostUsd,
        missedRunPolicy: input.missedRunPolicy,
      });
      return compactJob(job);
    },
  });

  const list = defineTool<ListArgs>({
    name: 'schedule_list',
    description:
      'List scheduled jobs with their schedule in English, next run time, ' +
      'condition and last outcome.',
    inputSchema: ListInput,
    sideEffecting: false,
    annotations: { title: 'List scheduled jobs', readOnlyHint: true },
    handler: (input) => {
      const all = scheduler
        .list()
        .filter((job) => (input.enabledOnly ? job.enabled : true));
      return {
        total: all.length,
        returned: Math.min(all.length, input.limit),
        jobs: all.slice(0, input.limit).map(compactJob),
      };
    },
  });

  const update = defineTool<UpdateArgs>({
    name: 'schedule_update',
    description:
      'Change a scheduled job: its cron, condition, prompt, enabled state or ' +
      'missed-run policy. Only the fields you pass are touched.',
    inputSchema: UpdateInput,
    sideEffecting: true,
    annotations: { title: 'Update scheduled job' },
    summarize: (input) => {
      const changes: string[] = [];
      if (input.cron)
        changes.push(`run ${describeCron(input.cron, input.timezone)}`);
      if (input.condition) {
        const parsed = ScheduleConditionSchema.safeParse(input.condition);
        if (parsed.success)
          changes.push(`only ${describeCondition(parsed.data)}`);
      }
      if (input.enabled !== undefined) {
        changes.push(input.enabled ? 'turn it on' : 'turn it off');
      }
      if (input.missedRunPolicy) {
        changes.push(`missed runs: ${input.missedRunPolicy}`);
      }
      if (input.prompt)
        changes.push(`new prompt "${truncate(input.prompt, 60)}"`);
      if (input.name) changes.push(`rename to "${input.name}"`);
      const existing = scheduler.get(input.id);
      const label = existing ? `"${existing.name}"` : input.id;
      return changes.length > 0
        ? `Update scheduled job ${label}: ${changes.join('; ')}.`
        : `Update scheduled job ${label}.`;
    },
    handler: async (input) => {
      const job = await scheduler.update({
        id: input.id,
        name: input.name,
        description: input.description,
        cron: input.cron,
        timezone: input.timezone,
        prompt: input.prompt,
        condition: input.condition,
        enabled: input.enabled,
        engine: input.engine,
        allowedTools: input.allowedTools,
        maxTurns: input.maxTurns,
        maxCostUsd: input.maxCostUsd,
        missedRunPolicy: input.missedRunPolicy,
      });
      return compactJob(job);
    },
  });

  const remove = defineTool<DeleteArgs>({
    name: 'schedule_delete',
    description: 'Delete a scheduled job and its run history.',
    inputSchema: DeleteInput,
    sideEffecting: true,
    annotations: { title: 'Delete scheduled job', destructiveHint: true },
    summarize: (input) => {
      const existing = scheduler.get(input.id);
      return existing
        ? `Delete the scheduled job "${existing.name}" (${existing.humanReadable}) and its run history.`
        : `Delete the scheduled job ${input.id}.`;
    },
    handler: async (input) => scheduler.remove(input.id),
  });

  const runNow = defineTool<RunNowArgs>({
    name: 'schedule_run_now',
    description:
      'Run a scheduled job immediately. By default the condition is ignored; ' +
      'pass ignoreCondition=false to check whether it currently passes.',
    inputSchema: RunNowInput,
    sideEffecting: true,
    annotations: { title: 'Run scheduled job now' },
    summarize: (input) => {
      const existing = scheduler.get(input.id);
      const label = existing ? `"${existing.name}"` : input.id;
      return input.ignoreCondition
        ? `Run the scheduled job ${label} right now, without checking its condition first.`
        : `Run the scheduled job ${label} right now, but only if its condition passes.`;
    },
    handler: async (input) => scheduler.runNow(input),
  });

  const history = defineTool<HistoryArgs>({
    name: 'schedule_history',
    description:
      'Recent scheduled-job evaluations, including the ones that were skipped ' +
      'because their condition did not pass. Shows duration, status and why.',
    inputSchema: HistoryInput,
    sideEffecting: false,
    annotations: { title: 'Scheduled job history', readOnlyHint: true },
    handler: (input) => {
      const runs = scheduler.history({
        jobId: input.jobId,
        status: input.status,
        limit: input.limit,
      });
      return {
        total: scheduler.historyCount({
          jobId: input.jobId,
          status: input.status,
        }),
        returned: runs.length,
        runs: runs.map((run) => ({
          id: run.id,
          jobId: run.jobId,
          at: run.startedAt,
          trigger: run.trigger,
          status: run.status,
          durationMs: run.durationMs,
          conditionKind: run.conditionKind,
          conditionPassed: run.conditionPassed,
          reason: run.conditionReason,
          missedCount: run.missedCount,
          runId: run.runId,
          error: run.error,
        })),
      };
    },
  });

  return [create, list, update, remove, runNow, history];
}
