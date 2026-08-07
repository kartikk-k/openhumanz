import { IPC, IPC_PUSH } from '../../../shared/ipc';
import { PageHeader } from '../../components/layout/PageHeader';
import { Placeholder } from '../../components/shared/Placeholder';

/**
 * PLACEHOLDER — replace this whole file.
 *
 * Owns `/runs` and everything under it (the route is a splat, so add
 * `/runs/:runId` with a nested `<Routes>` here).
 */
export function RunsScreen() {
  return (
    <>
      <PageHeader
        title="Runs"
        description="Everything the assistant has done, step by step."
      />
      <Placeholder
        filePath="src/renderer/features/runs/RunsScreen.tsx"
        summary="The run list and the run timeline — the highest-value surface in the product. Not a chat log: collapsible steps with tool name, arguments, output, duration and cost."
        requirements={[
          'A list pane (virtualize with @tanstack/react-virtual) and a timeline pane for the selected run.',
          'Timeline rows built from CollapsibleSection; raw arguments and results in CodeBlock.',
          'Live updates via the runs store: watchRun(runId) on mount, unwatchRun on unmount, applyEvents from the push channel.',
          'Detect gaps with findSeqGaps() and backfill with loadEvents(runId, 0) rather than showing a hole.',
          'Inline approval cards for this run — usePendingApprovalsForRun(runId).',
          'Show cost and tokens when settings.ui.showCosts is on.',
          'Nested route /runs/:runId, and an empty state that offers to start the first run.',
        ]}
        channels={[
          IPC.runs.list,
          IPC.runs.get,
          IPC.runs.start,
          IPC.runs.cancel,
          IPC.runs.events,
          IPC.runs.subscribe,
          IPC.runs.unsubscribe,
        ]}
        pushChannels={[IPC_PUSH.runEvents, IPC_PUSH.runStatus]}
      />
    </>
  );
}

export default RunsScreen;
