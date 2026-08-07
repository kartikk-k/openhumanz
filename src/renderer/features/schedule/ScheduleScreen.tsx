import { IPC, IPC_PUSH } from '../../../shared/ipc';
import { PageHeader } from '../../components/layout/PageHeader';
import { Placeholder } from '../../components/shared/Placeholder';

/** PLACEHOLDER — replace this whole file. Owns `/schedule` and everything under it. */
export function ScheduleScreen() {
  return (
    <>
      <PageHeader
        title="Schedule"
        description="Recurring jobs, when they next fire, how they last went."
      />
      <Placeholder
        filePath="src/renderer/features/schedule/ScheduleScreen.tsx"
        summary="One screen: the scheduled jobs table. Schedule in English, next run, last status, enable toggle, run now."
        requirements={[
          'A single table (Table + TableRow) — name, humanReadable schedule, condition, next run, last status, toggle, run now.',
          'Show the condition, not just the cron: a job with condition "file-changed" that skipped says "skipped: no new mail" via lastSkipReason.',
          'Cron editing validates through schedule:validate-cron and echoes humanReadable + nextRuns back before saving. Never parse dates in the renderer.',
          'Run now uses ScheduleRunNowRequest (ignoreCondition defaults true) and should link to the run it created.',
          'ConfirmDialog before deleting a job.',
        ]}
        channels={[
          IPC.schedule.list,
          IPC.schedule.get,
          IPC.schedule.create,
          IPC.schedule.update,
          IPC.schedule.remove,
          IPC.schedule.runNow,
          IPC.schedule.validateCron,
        ]}
        pushChannels={[IPC_PUSH.scheduleChanged]}
      />
    </>
  );
}

export default ScheduleScreen;
