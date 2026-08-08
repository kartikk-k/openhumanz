/**
 * The scheduler: one timer, a condition gate, and a per-job dispatch lock.
 *
 * ## Timer discipline
 *
 * There is exactly **one** timer for the whole module, and it sleeps until the
 * soonest stored `nextRunAt` rather than polling. Two rules keep that honest
 * across the things that actually happen to a laptop:
 *
 *  - **Never trust elapsed time.** Waking up is only a hint. Every wake re-reads
 *    the clock and compares against absolute, persisted instants, so a DST
 *    shift, an NTP correction, or a lid closed for six hours changes nothing
 *    about *what* is due — only about how much of it is late.
 *  - **Cap the sleep.** A timer armed for four hours is a timer that may never
 *    fire correctly across a suspend (some platforms do not fire a long
 *    `setTimeout` at all after resume, others fire it late). The sleep is capped
 *    at {@link DEFAULT_MAX_SLEEP_MS}; on each wake we recompute. That is a
 *    safety net, not a poll — the wake does no work when nothing is due.
 *
 * ## Why a lock
 *
 * A slow run, a burst of ticks after a resume, and `run-now` pressed twice all
 * lead to the same failure: two engine invocations for one job. The lock is
 * taken *before* the condition is evaluated and released only when the
 * dispatcher has handed off.
 *
 * ## What it does not do
 *
 * It does not create runs. It emits `schedule:due` and the orchestrator
 * subscribes — this module must not import the runs module or the orchestrator,
 * and that is lint-enforced, not a convention.
 */
import { randomId } from '../../infra/crypto';
import type { Db } from '../../infra/db';
import type { EventBus, Unsubscribe } from '../../infra/events';
import type { Logger } from '../../infra/logger';
import type { WorkspacePaths } from '../../infra/paths';
import { nowIso } from '../../../shared/common';
import type { RunStatus } from '../../../shared/runs';
import {
  ScheduleRunNowRequestSchema,
  ScheduledJobCreateSchema,
  ScheduledJobUpdateSchema,
  type CronValidation,
  type ScheduleCondition,
  type ScheduledJob,
  type ScheduledJobCreateInput,
  type ScheduledJobUpdate,
  type ScheduleRunNowRequestInput,
} from '../../../shared/schedule';
import {
  assertValidCron,
  countOccurrencesBetween,
  nextRunAfter,
  validateCron,
} from './cron';
import { describeCron } from './describe';
import { evaluateCondition, seedCondition } from './conditions';
import {
  createStore,
  missedRunPolicyOf,
  policyFromMetadata,
  metadataWithoutPolicy,
  type JobPatch,
  type ScheduleStore,
} from './store';
import {
  systemClock,
  DEFAULT_MISSED_RUN_POLICY,
  type CounterReader,
  type MissedRunPolicy,
  type ScheduleClock,
  type ScheduleDispatcher,
  type ScheduleHistoryQuery,
  type ScheduleRunRecord,
  type ScheduleRunStatus,
  type ScheduleTrigger,
  type TimerHandle,
} from './types';

/** Longest the single timer will ever sleep. See the note above. */
export const DEFAULT_MAX_SLEEP_MS = 15 * 60 * 1000;

/**
 * How late an occurrence may be before it counts as *missed* rather than
 * merely served a moment after its instant. Normal operation is milliseconds
 * late; anything past this means the app was closed or the machine asleep.
 */
export const DEFAULT_MISSED_GRACE_MS = 60 * 1000;

export interface SchedulerOptions {
  clock?: ScheduleClock;
  /** Defaults to emitting `schedule:due` on the bus. */
  dispatch?: ScheduleDispatcher;
  /** Overrides the stored counter table for `counter-changed` conditions. */
  counterReader?: CounterReader;
  /** Zone used when a job does not carry one. Defaults to the host zone. */
  defaultTimezone?: string;
  maxSleepMs?: number;
  missedGraceMs?: number;
  /** False leaves everything queryable but arms no timer. */
  enabled?: boolean;
}

export interface SchedulerContext {
  db: Db;
  events: EventBus;
  logger: Logger;
  paths: WorkspacePaths;
}

export interface RunNowResult {
  jobId: string;
  runId: string | null;
  skipped?: string;
}

export interface Scheduler {
  /** Attach to the module context, resolve missed runs, arm the timer. */
  start(ctx: SchedulerContext): Promise<void>;
  /** Cancel the timer and drop subscriptions. Safe to call twice. */
  stop(): Promise<void>;

  list(): ScheduledJob[];
  get(id: string): ScheduledJob | undefined;
  create(input: ScheduledJobCreateInput): Promise<ScheduledJob>;
  update(input: ScheduledJobUpdate): Promise<ScheduledJob>;
  remove(id: string): Promise<{ id: string; deleted: boolean }>;
  runNow(request: ScheduleRunNowRequestInput): Promise<RunNowResult>;
  history(query?: ScheduleHistoryQuery): ScheduleRunRecord[];
  historyCount(query?: Pick<ScheduleHistoryQuery, 'jobId' | 'status'>): number;
  validate(cron: string, timezone?: string): CronValidation;

  /** Evaluate everything due now. Exposed so tests need not wait on a timer. */
  tick(): Promise<void>;
  /** Instant the single timer is currently armed for, or null. */
  nextWakeAt(): string | null;
}

function hostTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function sameCondition(a: ScheduleCondition, b: ScheduleCondition): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function createScheduler(options: SchedulerOptions = {}): Scheduler {
  const clock = options.clock ?? systemClock;
  const maxSleepMs = options.maxSleepMs ?? DEFAULT_MAX_SLEEP_MS;
  const missedGraceMs = options.missedGraceMs ?? DEFAULT_MISSED_GRACE_MS;
  const enabled = options.enabled ?? true;
  const defaultTimezone = options.defaultTimezone ?? hostTimezone();

  let ctx: SchedulerContext | null = null;
  let store: ScheduleStore | null = null;
  let timer: TimerHandle | null = null;
  let armedFor: number | null = null;
  let stopped = true;
  let ticking = false;
  /** Job ids with a dispatch in flight. The double-fire guard. */
  const inFlight = new Set<string>();
  const subscriptions: Unsubscribe[] = [];

  const requireStore = (): ScheduleStore => {
    if (!store) {
      throw new Error(
        'The schedule module has not been started; no database is attached.',
      );
    }
    return store;
  };

  const log = (): Logger | null => ctx?.logger ?? null;

  /* ---------------------------------------------------------------- */
  /* Timer                                                            */
  /* ---------------------------------------------------------------- */

  const disarm = (): void => {
    if (timer !== null) {
      clock.clearTimer(timer);
      timer = null;
    }
    armedFor = null;
  };

  /**
   * Late binding for the one cycle in this file: `arm` schedules `tick`, and
   * `tick` re-arms when it is done. Assigned once, immediately below `tick`.
   */
  const wake: { tick: () => Promise<void> } = { tick: async () => {} };

  const arm = (): void => {
    disarm();
    if (stopped || !enabled || !store) return;

    let soonest = Number.POSITIVE_INFINITY;
    for (const job of store.listJobs()) {
      if (!job.enabled || !job.nextRunAt) continue;
      const at = Date.parse(job.nextRunAt);
      if (Number.isFinite(at) && at < soonest) soonest = at;
    }
    if (!Number.isFinite(soonest)) return;

    const now = clock.now();
    // Clamped both ways: never busy-spin, never sleep so long that a suspend
    // or a clock change can strand the timer.
    const delay = Math.min(Math.max(soonest - now, 1), maxSleepMs);
    armedFor = now + delay;
    timer = clock.setTimer(() => {
      timer = null;
      armedFor = null;
      void wake.tick();
    }, delay);
  };

  /* ---------------------------------------------------------------- */
  /* History                                                          */
  /* ---------------------------------------------------------------- */

  const record = (entry: {
    job: ScheduledJob;
    trigger: ScheduleTrigger;
    scheduledFor: string | null;
    startedMs: number;
    status: ScheduleRunStatus;
    conditionPassed: boolean;
    conditionReason: string;
    missedCount: number;
    runId?: string | null;
    error?: string | null;
  }): ScheduleRunRecord => {
    const finishedMs = clock.now();
    const item: ScheduleRunRecord = {
      id: randomId('schrun'),
      jobId: entry.job.id,
      trigger: entry.trigger,
      scheduledFor: entry.scheduledFor,
      startedAt: new Date(entry.startedMs).toISOString(),
      finishedAt: new Date(finishedMs).toISOString(),
      durationMs: Math.max(0, finishedMs - entry.startedMs),
      status: entry.status,
      conditionKind: entry.job.condition.kind,
      conditionPassed: entry.conditionPassed,
      conditionReason: entry.conditionReason,
      missedCount: entry.missedCount,
      runId: entry.runId ?? null,
      error: entry.error ?? null,
    };
    requireStore().insertRun(item);
    return item;
  };

  /* ---------------------------------------------------------------- */
  /* Fire                                                             */
  /* ---------------------------------------------------------------- */

  const defaultDispatch: ScheduleDispatcher = ({ job }) => {
    ctx?.events.emit('schedule:due', { jobId: job.id });
  };
  const dispatch = options.dispatch ?? defaultDispatch;

  const readCounter: CounterReader =
    options.counterReader ?? ((source) => requireStore().readCounter(source));

  /**
   * Evaluate the condition and, only if it passes, hand the job to the
   * dispatcher. This is the single place in the module where anything may
   * cause an engine to spawn.
   */
  const evaluateAndDispatch = async (
    job: ScheduledJob,
    trigger: ScheduleTrigger,
    scheduledFor: string | null,
    missedCount: number,
    ignoreCondition = false,
  ): Promise<RunNowResult> => {
    const jobs = requireStore();

    // Taken before any `await`, so two callers in the same turn cannot both
    // pass. This is the whole double-fire guard.
    if (inFlight.has(job.id)) {
      const reason = 'a dispatch for this job is already in progress';
      record({
        job,
        trigger,
        scheduledFor,
        startedMs: clock.now(),
        status: 'skipped',
        conditionPassed: false,
        conditionReason: reason,
        missedCount,
      });
      log()?.warn('schedule dispatch skipped: already in flight', {
        jobId: job.id,
      });
      return { jobId: job.id, runId: null, skipped: reason };
    }
    inFlight.add(job.id);

    const startedMs = clock.now();
    try {
      let passed = true;
      let reason = 'condition ignored (manual run)';

      if (!ignoreCondition) {
        const outcome = await evaluateCondition(job.condition, {
          paths: (ctx as SchedulerContext).paths,
          nowMs: clock.now(),
          timezone: job.timezone || defaultTimezone,
          readCounter,
        });
        passed = outcome.passed;
        reason = outcome.reason;
        // Advance the baseline even on a skip when the check moved one (the
        // first-look case), so the next tick has something to compare against.
        if (outcome.next && !sameCondition(outcome.next, job.condition)) {
          jobs.saveCondition(job.id, outcome.next);
        }
      }

      if (!passed) {
        record({
          job,
          trigger,
          scheduledFor,
          startedMs,
          status: 'skipped',
          conditionPassed: false,
          conditionReason: reason,
          missedCount,
        });
        jobs.updateJob(job.id, { last_skip_reason: reason });
        ctx?.events.emit('schedule:changed', { ids: [job.id] });
        log()?.info('schedule job skipped', { jobId: job.id, reason });
        return { jobId: job.id, runId: null, skipped: reason };
      }

      let runId: string | null = null;
      let error: string | null = null;
      try {
        const result = await dispatch({
          job,
          trigger,
          scheduledFor: scheduledFor ?? new Date(startedMs).toISOString(),
          missedCount,
        });
        runId = result?.runId ?? null;
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }

      const patch: JobPatch = {
        last_run_at: new Date(clock.now()).toISOString(),
        last_skip_reason: null,
        last_status: (error ? 'failed' : 'queued') satisfies RunStatus,
      };
      if (runId) patch.last_run_id = runId;
      jobs.updateJob(job.id, patch);

      record({
        job,
        trigger,
        scheduledFor,
        startedMs,
        status: error ? 'error' : 'dispatched',
        conditionPassed: true,
        conditionReason: reason,
        missedCount,
        runId,
        error,
      });
      ctx?.events.emit('schedule:changed', { ids: [job.id] });

      if (error) {
        log()?.error('schedule dispatch failed', { jobId: job.id, error });
        return { jobId: job.id, runId: null, skipped: error };
      }
      log()?.info('schedule job dispatched', {
        jobId: job.id,
        trigger,
        missedCount,
      });
      return { jobId: job.id, runId };
    } finally {
      inFlight.delete(job.id);
    }
  };

  /** Move `next_run_at` on before doing anything that can fail. */
  const advance = (job: ScheduledJob, fromMs: number): string | null => {
    // A one-shot job has now spent its single occurrence: disable it (keeping
    // the row as history) rather than scheduling the next cron occurrence.
    if (!job.recurring) {
      requireStore().updateJob(job.id, {
        next_run_at: null,
        enabled: false,
      });
      log()?.info('one-shot schedule job disabled after firing', {
        jobId: job.id,
      });
      return null;
    }
    try {
      const next = nextRunAfter(
        job.cron,
        job.timezone || defaultTimezone,
        fromMs,
      );
      const iso = new Date(next).toISOString();
      requireStore().updateJob(job.id, { next_run_at: iso });
      return iso;
    } catch (cause) {
      // An expression that no longer parses would otherwise spin the loop on
      // the same overdue instant forever. Park the job instead.
      const message = cause instanceof Error ? cause.message : String(cause);
      requireStore().updateJob(job.id, {
        next_run_at: null,
        enabled: false,
        last_skip_reason: `disabled: ${message}`,
      });
      log()?.error('schedule job disabled: unusable cron', {
        jobId: job.id,
        error: message,
      });
      return null;
    }
  };

  const handleDue = async (job: ScheduledJob, nowMs: number): Promise<void> => {
    const scheduledFor = job.nextRunAt as string;
    const scheduledMs = Date.parse(scheduledFor);
    const lateBy = nowMs - scheduledMs;

    // Advance first: whatever happens below, this occurrence is spent.
    advance(job, Math.max(nowMs, scheduledMs));

    if (lateBy <= missedGraceMs) {
      await evaluateAndDispatch(job, 'cron', scheduledFor, 0);
      return;
    }

    // Missed while the app was closed (or the machine was asleep).
    const missedCount = countOccurrencesBetween(
      job.cron,
      job.timezone || defaultTimezone,
      scheduledMs,
      nowMs,
    );
    const policy: MissedRunPolicy = missedRunPolicyOf(job);

    if (policy === 'skip') {
      const reason = `missed while the app was closed (${missedCount || 1} occurrence${
        (missedCount || 1) === 1 ? '' : 's'
      }, policy: skip)`;
      record({
        job,
        trigger: 'cron',
        scheduledFor,
        startedMs: clock.now(),
        status: 'skipped',
        conditionPassed: false,
        conditionReason: reason,
        missedCount,
      });
      requireStore().updateJob(job.id, { last_skip_reason: reason });
      ctx?.events.emit('schedule:changed', { ids: [job.id] });
      log()?.info('schedule job missed run skipped', {
        jobId: job.id,
        missedCount,
      });
      return;
    }

    // catch-up: one dispatch, never a burst — and the condition still decides.
    await evaluateAndDispatch(job, 'catch-up', scheduledFor, missedCount);
  };

  const tick = async (): Promise<void> => {
    if (stopped || !store) return;
    if (ticking) return;
    ticking = true;
    try {
      const now = clock.now();
      for (const job of store.listJobs()) {
        if (stopped) break;
        if (!job.enabled) continue;
        const due = job.nextRunAt ? Date.parse(job.nextRunAt) : Number.NaN;
        if (!Number.isFinite(due)) {
          // No promise on record (fresh job, or re-enabled): make one.
          advance(job, now);
          continue;
        }
        if (due > now) continue;
        // Sequential on purpose: a burst of due jobs should queue, not race.
        // eslint-disable-next-line no-await-in-loop
        await handleDue(job, now);
      }
    } catch (cause) {
      log()?.error('schedule tick failed', {
        error: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      ticking = false;
      arm();
    }
  };
  wake.tick = tick;

  /* ---------------------------------------------------------------- */
  /* Write paths                                                      */
  /* ---------------------------------------------------------------- */

  const create = async (
    input: ScheduledJobCreateInput,
  ): Promise<ScheduledJob> => {
    const jobs = requireStore();
    const parsed = ScheduledJobCreateSchema.parse(input);
    // The schema default is 'UTC'; "not supplied" means the host zone.
    const timezone =
      (input as { timezone?: string }).timezone?.trim() || defaultTimezone;

    assertValidCron(parsed.cron, timezone);

    const now = clock.now();
    const at = new Date(now).toISOString();
    // Careful: `.partial({k:true})` makes a key optional on the *input* but
    // leaves its `.default(...)` in place, and zod v4 still applies it. So
    // `parsed.x` is always populated here and the `??` fallbacks below are
    // belt-and-braces, not the thing doing the work. To tell "the caller said
    // this" from "the schema filled it in" you must look at the raw input —
    // which is what the timezone above and the policy below both do.
    const metadata = parsed.metadata ?? {};
    const isEnabled = parsed.enabled ?? true;
    const condition = await seedCondition(
      parsed.condition ?? { kind: 'always' },
      {
        paths: (ctx as SchedulerContext).paths,
        readCounter,
      },
    );
    // The real field wins when the caller actually sent one. Otherwise the
    // legacy `metadata.missedRunPolicy` alias is honoured, so a caller written
    // against the old shape still means what it said; failing that, the
    // schema's (quota-safe) default stands.
    // `.partial()` marks it optional in the *type* even though the default
    // means it is always present at runtime — hence the final `??`.
    const parsedPolicy = parsed.missedRunPolicy ?? DEFAULT_MISSED_RUN_POLICY;
    const policy: MissedRunPolicy =
      (input as { missedRunPolicy?: unknown }).missedRunPolicy !== undefined
        ? parsedPolicy
        : policyFromMetadata(metadata, parsedPolicy);

    const job = jobs.insertJob({
      id: randomId('sch'),
      name: parsed.name,
      description: parsed.description ?? '',
      cron: parsed.cron,
      timezone,
      human_readable: describeCron(parsed.cron, timezone),
      enabled: isEnabled,
      recurring: parsed.recurring ?? true,
      condition_json: condition,
      missed_run_policy: policy,
      prompt: parsed.prompt,
      engine: parsed.engine,
      allowed_tools_json: parsed.allowedTools ?? [],
      max_turns: parsed.maxTurns,
      max_cost_usd: parsed.maxCostUsd,
      next_run_at: isEnabled
        ? new Date(nextRunAfter(parsed.cron, timezone, now)).toISOString()
        : null,
      created_at: at,
      updated_at: at,
      metadata_json: metadataWithoutPolicy(metadata),
    });

    ctx?.events.emit('schedule:changed', { ids: [job.id] });
    arm();
    return job;
  };

  const update = async (input: ScheduledJobUpdate): Promise<ScheduledJob> => {
    const jobs = requireStore();
    const parsed = ScheduledJobUpdateSchema.parse(input);
    const existing = jobs.getJob(parsed.id);
    if (!existing) throw new Error(`No scheduled job with id "${parsed.id}"`);

    const patch: JobPatch = { updated_at: new Date(clock.now()).toISOString() };

    const cron = parsed.cron ?? existing.cron;
    const timezone = parsed.timezone ?? existing.timezone;
    const cronChanged =
      cron !== existing.cron || timezone !== existing.timezone;
    if (cronChanged) {
      assertValidCron(cron, timezone);
      patch.cron = cron;
      patch.timezone = timezone;
      patch.human_readable = describeCron(cron, timezone);
    }

    if (parsed.name !== undefined) patch.name = parsed.name;
    if (parsed.description !== undefined)
      patch.description = parsed.description;
    if (parsed.prompt !== undefined) patch.prompt = parsed.prompt;
    if (parsed.engine !== undefined) patch.engine = parsed.engine;
    if (parsed.allowedTools !== undefined) {
      patch.allowed_tools_json = parsed.allowedTools;
    }
    if (parsed.maxTurns !== undefined) patch.max_turns = parsed.maxTurns;
    if (parsed.maxCostUsd !== undefined) patch.max_cost_usd = parsed.maxCostUsd;

    if (parsed.metadata !== undefined) {
      patch.metadata_json = metadataWithoutPolicy(parsed.metadata);
      // Legacy callers still express the policy through metadata; an explicit
      // `missedRunPolicy` below overrides whatever this decides.
      patch.missed_run_policy = policyFromMetadata(
        parsed.metadata,
        missedRunPolicyOf(existing),
      );
    }

    if (parsed.missedRunPolicy !== undefined) {
      patch.missed_run_policy = parsed.missedRunPolicy;
    }

    if (parsed.condition !== undefined) {
      // Re-baseline: an edited condition must not inherit a stale watermark.
      patch.condition_json = await seedCondition(parsed.condition, {
        paths: (ctx as SchedulerContext).paths,
        readCounter,
      });
    }

    const willBeEnabled = parsed.enabled ?? existing.enabled;
    if (parsed.enabled !== undefined) patch.enabled = parsed.enabled;

    const now = clock.now();
    if (!willBeEnabled) {
      patch.next_run_at = null;
    } else if (cronChanged || !existing.enabled || !existing.nextRunAt) {
      // Re-enabling recomputes from now rather than replaying whatever was
      // stored when the job was switched off.
      patch.next_run_at = new Date(
        nextRunAfter(cron, timezone, now),
      ).toISOString();
    }

    const updated = jobs.updateJob(parsed.id, patch);
    if (!updated) throw new Error(`No scheduled job with id "${parsed.id}"`);
    ctx?.events.emit('schedule:changed', { ids: [updated.id] });
    arm();
    return updated;
  };

  const remove = async (
    id: string,
  ): Promise<{ id: string; deleted: boolean }> => {
    const deleted = requireStore().deleteJob(id);
    if (deleted) {
      ctx?.events.emit('schedule:changed', { ids: [id] });
      arm();
    }
    return { id, deleted };
  };

  const runNow = async (
    request: ScheduleRunNowRequestInput,
  ): Promise<RunNowResult> => {
    const parsed = ScheduleRunNowRequestSchema.parse(request);
    const job = requireStore().getJob(parsed.id);
    if (!job) throw new Error(`No scheduled job with id "${parsed.id}"`);
    return evaluateAndDispatch(job, 'manual', null, 0, parsed.ignoreCondition);
  };

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                        */
  /* ---------------------------------------------------------------- */

  const scheduler: Scheduler = {
    async start(context) {
      ctx = context;
      store = createStore(context.db);
      stopped = false;

      // Close the loop on run outcomes without importing the runs module: the
      // orchestrator publishes, we match on the run id we were handed back.
      subscriptions.push(
        context.events.on('run:finished', ({ runId, status }) => {
          const jobId = store?.findJobIdByRunId(runId);
          if (jobId) store?.updateJob(jobId, { last_status: status });
        }),
      );

      const now = clock.now();
      let seeded = 0;
      for (const job of store.listJobs()) {
        if (job.enabled && !job.nextRunAt) {
          advance(job, now);
          seeded += 1;
        }
      }

      // Resolve anything that came due while we were closed, per each job's
      // policy, before arming. `tick` re-arms on the way out.
      await tick();

      context.logger.info('scheduler started', {
        jobs: store.listJobs().length,
        seeded,
        nextWakeAt: scheduler.nextWakeAt(),
        enabled,
      });
    },

    async stop() {
      stopped = true;
      disarm();
      for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
      inFlight.clear();
      ctx = null;
      store = null;
    },

    list() {
      const jobs = requireStore();
      const now = clock.now();
      return jobs.listJobs().map((job) => {
        // Fill in a missing promise, but never overwrite a stored one — an
        // overdue `nextRunAt` is exactly what the missed-run policy reads.
        if (!job.enabled || job.nextRunAt) return job;
        const iso = advance(job, now);
        return iso ? { ...job, nextRunAt: iso } : job;
      });
    },

    get(id) {
      return requireStore().getJob(id);
    },

    create,
    update,
    remove,
    runNow,

    history(query) {
      return requireStore().listRuns(query);
    },

    historyCount(query) {
      return requireStore().countRuns(query);
    },

    validate(cron, timezone) {
      return validateCron(cron, timezone ?? defaultTimezone, clock.now());
    },

    tick,

    nextWakeAt() {
      return armedFor === null ? null : new Date(armedFor).toISOString();
    },
  };

  return scheduler;
}

/** `nowIso` is re-exported so callers need not reach into shared for it. */
export { nowIso };
