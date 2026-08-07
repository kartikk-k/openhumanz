import { IPC, IPC_PUSH } from '../../../shared/ipc';
import { PageHeader } from '../../components/layout/PageHeader';
import { Placeholder } from '../../components/shared/Placeholder';

/** PLACEHOLDER — replace this whole file. Owns `/tasks` and everything under it. */
export function TasksScreen() {
  return (
    <>
      <PageHeader
        title="Tasks"
        description="Work in flight, and the goals it belongs to."
      />
      <Placeholder
        filePath="src/renderer/features/tasks/TasksScreen.tsx"
        summary="Tasks grouped by status, with goals as the long-lived intent above them. Structured state lives in SQLite; the prose lives in the memory vault."
        requirements={[
          'Task list with status, priority, due date, tags and source (user / agent / schedule:<jobId>).',
          'Inline create and edit; status changes should not require a dialog.',
          'Goals section: horizon, status, metric, and the tasks attached to each.',
          'Refetch on the tasks/goals push channels rather than polling.',
          'Empty state that explains tasks can arrive from the agent as well as from you.',
        ]}
        channels={[
          IPC.tasks.list,
          IPC.tasks.get,
          IPC.tasks.create,
          IPC.tasks.update,
          IPC.tasks.remove,
          IPC.goals.list,
          IPC.goals.get,
          IPC.goals.write,
          IPC.goals.remove,
        ]}
        pushChannels={[IPC_PUSH.tasksChanged, IPC_PUSH.goalsChanged]}
      />
    </>
  );
}

export default TasksScreen;
