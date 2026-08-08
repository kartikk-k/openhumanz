/**
 * Step 3 — where the data lives.
 *
 * Two capabilities this step would like and does not have: a native folder
 * picker, and a way to ask main whether a path is writable. Neither channel
 * exists in `shared/ipc.ts`, and inventing one from the renderer would produce
 * a button that does nothing or a green tick that means nothing. So the step
 * shows the resolved path, lets it be typed, and says plainly what it cannot
 * confirm.
 */
import { FolderTree, HardDrive } from 'lucide-react';
import { SettingsSchema, type SettingsPatch } from '../../../shared/settings';
import { DEFAULT_WORKSPACE_HINT } from '../../constants';
import { cn } from '../../lib/utils';
import { mono, textMuted, textSubtle } from '../../components/ui/styles';
import { useSettingsStore } from '../../store';
import { Notice } from '../settings/Notice';
import { TextSetting } from '../settings/fields';
import { useSettingsWriter } from '../settings/writer';

const CONTENTS: readonly { path: string; what: string }[] = [
  { path: 'settings.json', what: 'Your preferences, as plain JSON.' },
  {
    path: 'assistant.db',
    what: 'Runs, tasks, goals, schedules, approval decisions, memory index.',
  },
  {
    path: 'memory/',
    what: 'The vault — Markdown files you can edit yourself.',
  },
  {
    path: 'runs/<runId>/',
    what: 'transcript.jsonl and stderr.log for every run.',
  },
  { path: 'logs/', what: 'Application logs.' },
  {
    path: 'runtime/',
    what: 'The local socket and its per-launch token. Recreated on each start.',
  },
];

export function WorkspaceStep() {
  const settings = useSettingsStore((state) => state.settings);
  const { write, canWrite, saving, blockedReason } = useSettingsWriter();
  const resolved = settings.workspaceRoot || DEFAULT_WORKSPACE_HINT;
  const save = (patch: SettingsPatch, label: string): void => {
    void write(patch, label);
  };

  return (
    <>
      <TextSetting
        id="onboarding-workspace"
        label="Workspace folder"
        monospace
        placeholder={DEFAULT_WORKSPACE_HINT}
        hint={`Leave it empty and everything goes in ${DEFAULT_WORKSPACE_HINT}. That is a fine answer — you can move it later without losing anything.`}
        value={settings.workspaceRoot}
        schema={SettingsSchema.shape.workspaceRoot}
        disabled={!canWrite || saving}
        onCommit={(value) => save({ workspaceRoot: value }, 'Workspace folder')}
      />

      {blockedReason ? (
        <p className={cn('text-[12px] leading-relaxed', textMuted)}>
          {blockedReason} You can still continue — set the folder from Settings
          once the app is fully up.
        </p>
      ) : null}

      <Notice
        tone="info"
        size="compact"
        icon={FolderTree}
        title="Two things this screen cannot do yet"
      >
        <p>
          There is no native “Choose folder…” dialog in this build — the IPC
          contract has no directory-picker channel, so type or paste the path
          instead.
        </p>
        <p>
          And nothing here has checked that the folder exists or is writable;
          there is no channel to ask. The app creates it on first write, and if
          that fails you will see the error then rather than now.
        </p>
      </Notice>

      <div className="rounded-md border border-zinc-200 px-3 py-2.5 dark:border-zinc-800">
        <p className="flex items-center gap-1.5 text-[12px] font-medium text-zinc-700 dark:text-zinc-300">
          <HardDrive size={13} aria-hidden="true" />
          What ends up in {resolved}
        </p>
        <ul className="mt-1.5 divide-y divide-zinc-100 dark:divide-zinc-800/70">
          {CONTENTS.map((entry) => (
            <li key={entry.path} className="py-1.5">
              <span className={cn(mono, 'text-zinc-800 dark:text-zinc-200')}>
                {entry.path}
              </span>
              <p className={cn('text-[12px] leading-relaxed', textMuted)}>
                {entry.what}
              </p>
            </li>
          ))}
        </ul>
        <p className={cn('mt-2 text-[12px] leading-relaxed', textSubtle)}>
          No part of this is uploaded anywhere. Deleting the folder deletes the
          assistant.
        </p>
      </div>
    </>
  );
}

export default WorkspaceStep;
