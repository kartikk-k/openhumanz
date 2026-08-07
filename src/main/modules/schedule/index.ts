/**
 * The schedule module.
 *
 * Owns `schedule_jobs`, `schedule_runs` and `schedule_counters`; publishes the
 * six scheduling tools and the `schedule:*` IPC channels; runs one timer.
 *
 * The design constraint everything here bends around is in ARCHITECTURE.md
 * under "Background work": **never put a CLI invocation on an unconditional
 * timer.** So a job is not "a cron plus a prompt" — it is a cron, a prompt, and
 * a deterministic condition that is evaluated before anything is allowed to
 * spawn. The condition is a required part of the definition (`always` exists as
 * an explicit, visible escape hatch), and every evaluation is written to run
 * history including the ones that decided *not* to spawn. That skip history is
 * the evidence the gate is doing its job.
 *
 * Dispatch goes out as `schedule:due` on the event bus. This module does not
 * import the runs module or the orchestrator — modules must not import each
 * other, and `import/no-restricted-paths` enforces it.
 *
 * Wiring:
 *
 * ```ts
 * import scheduleModule from './modules/schedule';
 * const registry = createRegistry({ modules: [scheduleModule, ...], ... });
 * ```
 *
 * For tests, or to inject settings / a dispatcher that returns a run id, build
 * one explicitly with {@link createScheduleModule}.
 */
import { defineModule, type AppModule, type ModuleContext } from '../types';
import { createIpcHandlers } from './ipc';
import {
  createScheduler,
  type Scheduler,
  type SchedulerOptions,
} from './scheduler';
import { migrations } from './store';
import { createTools } from './tools';

export const SCHEDULE_MODULE_ID = 'schedule';

export interface ScheduleModuleOptions extends SchedulerOptions {}

/** A module plus the scheduler behind it, so tests can drive time directly. */
export interface ScheduleModule extends AppModule {
  readonly scheduler: Scheduler;
}

export function createScheduleModule(
  options: ScheduleModuleOptions = {},
): ScheduleModule {
  const scheduler = createScheduler(options);

  const module = defineModule({
    id: SCHEDULE_MODULE_ID,
    migrations,
    tools: createTools(scheduler),
    ipc: createIpcHandlers(scheduler),

    async start(ctx: ModuleContext) {
      await scheduler.start({
        db: ctx.db,
        events: ctx.events,
        logger: ctx.logger,
        paths: ctx.paths,
      });
    },

    async stop() {
      await scheduler.stop();
    },
  });

  return Object.assign(module, { scheduler });
}

/** The instance the registry uses. */
const scheduleModule = createScheduleModule();

export default scheduleModule;

/* Public surface for services and tests. */
export { createScheduler } from './scheduler';
export type { Scheduler, SchedulerOptions, RunNowResult } from './scheduler';
export {
  describeCron,
  describeCronDetailed,
  type CronDescription,
} from './describe';
export { validateCron, nextRunIsoAfter, nextRuns, CronError } from './cron';
export {
  describeCondition,
  evaluateCondition,
  seedCondition,
  type ConditionOutcome,
} from './conditions';
export { recordCounterReading, missedRunPolicyOf } from './store';
export {
  systemClock,
  MISSED_RUN_POLICIES,
  DEFAULT_MISSED_RUN_POLICY,
  type CounterReader,
  type MissedRunPolicy,
  type ScheduleClock,
  type ScheduleDispatch,
  type ScheduleDispatcher,
  type ScheduleHistoryQuery,
  type ScheduleRunRecord,
  type ScheduleRunStatus,
  type ScheduleTrigger,
} from './types';
