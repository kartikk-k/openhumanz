import { IPC, IPC_PUSH } from '../../../shared/ipc';
import { PageHeader } from '../../components/layout/PageHeader';
import { Placeholder } from '../../components/shared/Placeholder';

/** PLACEHOLDER — replace this whole file. Owns `/settings` and everything under it. */
export function SettingsScreen() {
  return (
    <>
      <PageHeader
        title="Settings"
        description="Engine, workspace, approvals, notifications."
      />
      <Placeholder
        filePath="src/renderer/features/settings/SettingsScreen.tsx"
        summary="Grouped settings backed by SettingsSchema, plus the environment report: which engine was found, which OS providers are available and why the rest are not."
        requirements={[
          'One section per group in SettingsSchema: workspace, engine, approvals, memory, schedule, ui, notifications, logging.',
          'Write with useSettingsStore().update(patch) — send a partial patch, never the whole object.',
          'Turning off approvals.requireForSideEffecting is a deliberate, loud choice: ConfirmDialog with tone="danger".',
          'Environment section: engines with version/binaryPath/reason, providers with availability and reason, and the ANTHROPIC_API_KEY warning stated plainly.',
          'available: false is normal on this platform — render the reason, never an error.',
        ]}
        channels={[
          IPC.settings.get,
          IPC.settings.set,
          IPC.engines.status,
          IPC.engines.detect,
        ]}
        pushChannels={[IPC_PUSH.settingsChanged, IPC_PUSH.environmentChanged]}
      />
    </>
  );
}

export default SettingsScreen;
