/**
 * The schedule module's slice of the IPC surface.
 *
 * Channel names come from `shared/ipc.ts` rather than being spelled out here,
 * which is what makes a typo a compile error instead of a channel that is never
 * called. Handlers stay thin: parse, delegate to the scheduler, return.
 */
import { IPC } from '../../../shared/ipc';
import { ScheduleHistoryQuerySchema } from '../../../shared/schedule';
import type { IpcHandlerMap } from '../types';
import type { Scheduler } from './scheduler';

export function createIpcHandlers(scheduler: Scheduler): IpcHandlerMap {
  return {
    [IPC.schedule.list]: () => scheduler.list(),

    [IPC.schedule.get]: ({ id }) => scheduler.get(id) ?? null,

    [IPC.schedule.create]: (request) => scheduler.create(request),

    [IPC.schedule.update]: (request) => scheduler.update(request),

    [IPC.schedule.remove]: ({ id }) => scheduler.remove(id),

    [IPC.schedule.runNow]: (request) => scheduler.runNow(request),

    /**
     * The composer's confirm step: the renderer (or the agent, via the UI)
     * sends a cron expression and gets back validity, the English rendering and
     * the next few instants — everything needed to show "is this what you
     * meant?" before it is stored.
     */
    [IPC.schedule.validateCron]: ({ cron, timezone }) =>
      scheduler.validate(cron, timezone),

    /**
     * Evaluation history, including the wake-ups that decided *not* to spawn.
     * A page of `skipped / condition did not pass` rows is the condition gate
     * visibly working, so the screen wants them alongside the dispatches.
     */
    [IPC.schedule.history]: (request) => {
      const query = ScheduleHistoryQuerySchema.parse(request ?? {});
      return {
        items: scheduler.history(query),
        total: scheduler.historyCount({
          jobId: query.jobId,
          status: query.status,
        }),
        limit: query.limit,
        offset: query.offset,
      };
    },
  };
}
