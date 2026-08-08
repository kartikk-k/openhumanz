/**
 * Step 4 — the first data source.
 *
 * On the schema this step is still called `permissions`, and both meanings get
 * their space here: the thing you actually connect (a folder of notes, which
 * becomes the memory vault) and an honest list of the OS data sources this
 * machine can and cannot reach.
 *
 * Indexing is offered inline, because a data source you have not read is not a
 * data source — the doc count coming back is the first evidence that any of
 * this is wired to something real.
 */
import { useState } from 'react';
import { FileText, FolderSearch, Library } from 'lucide-react';
import { IPC } from '../../../shared/ipc';
import {
  MemorySettingsSchema,
  type SettingsPatch,
} from '../../../shared/settings';
import type { MemoryIndexStatus } from '../../../shared/memory';
import { DEFAULT_WORKSPACE_HINT } from '../../constants';
import { cn } from '../../lib/utils';
import { formatCount } from '../../lib/format';
import { isBridgeAvailable, useMutation } from '../../lib/ipc';
import { Button } from '../../components/ui';
import { mono, textMuted, textSubtle } from '../../components/ui/styles';
import { useSettingsStore } from '../../store';
import { ProvidersPanel } from '../settings/EnvironmentPanel';
import { Notice } from '../settings/Notice';
import { SwitchSetting, TextSetting } from '../settings/fields';
import { useSettingsWriter } from '../settings/writer';

export function DataSourceStep() {
  const settings = useSettingsStore((state) => state.settings);
  const { write, canWrite, saving } = useSettingsWriter();
  const [indexed, setIndexed] = useState<MemoryIndexStatus | null>(null);

  const reindex = useMutation(IPC.memory.reindex, {
    onSuccess: (status) => setIndexed(status),
  });

  const root = settings.workspaceRoot || DEFAULT_WORKSPACE_HINT;
  const vaultPath = `${root.replace(/\/+$/, '')}/${settings.memory.directory}`;
  const disabled = !canWrite || saving;
  const save = (patch: SettingsPatch, label: string): void => {
    void write(patch, label);
  };

  const indexUnavailable =
    reindex.error !== null && reindex.error.isUnavailable;

  return (
    <>
      <p className={cn('text-[13px] leading-relaxed', textSubtle)}>
        Memory is a folder of Markdown files. Anything in it becomes searchable
        by the assistant, and stays readable by you — no import step, no
        proprietary store, no copy living somewhere else.
      </p>

      <TextSetting
        id="onboarding-memory-directory"
        label="Notes folder"
        monospace
        hint={`Relative to your workspace folder. Right now that resolves to ${vaultPath}`}
        value={settings.memory.directory}
        schema={MemorySettingsSchema.shape.directory}
        disabled={disabled}
        onCommit={(value) =>
          save({ memory: { directory: value } }, 'Notes folder')
        }
      />

      <Notice
        tone="info"
        size="compact"
        icon={FolderSearch}
        title="Using notes you already have somewhere else"
      >
        <p>
          The vault path is interpreted relative to your workspace folder, and
          there is no setting for an absolute one — so to use an existing notes
          directory, symlink it in:
        </p>
        <p className={cn(mono, 'text-zinc-800 dark:text-zinc-200')}>
          ln -s ~/Documents/Notes {vaultPath}
        </p>
        <p>
          There is also no folder picker in this build; the IPC contract has no
          directory-picker channel, so the field above is typed rather than
          browsed.
        </p>
      </Notice>

      <div className="space-y-3 rounded-md border border-zinc-200 px-3 py-3 dark:border-zinc-800">
        <SwitchSetting
          id="onboarding-memory-watch"
          label="Keep it in sync"
          description="Re-reads a note moments after you save it in your own editor."
          checked={settings.memory.watch}
          disabled={disabled}
          onChange={(next) =>
            save({ memory: { watch: next } }, 'Vault watching')
          }
        />
        <SwitchSetting
          id="onboarding-memory-start"
          label="Index at launch"
          description="Catches anything you changed while the app was closed."
          checked={settings.memory.indexOnStart}
          disabled={disabled}
          onChange={(next) =>
            save({ memory: { indexOnStart: next } }, 'Index on start')
          }
        />

        <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800/70">
          <Button
            size="sm"
            variant="secondary"
            icon={Library}
            loading={reindex.pending}
            disabled={!isBridgeAvailable()}
            onClick={() => {
              void reindex.mutate({ full: true });
            }}
          >
            Read the folder now
          </Button>
          {indexed ? (
            <span className="flex items-center gap-1.5 text-[12.5px] text-emerald-700 dark:text-emerald-400">
              <FileText size={13} aria-hidden="true" />
              {formatCount(indexed.docCount)} notes,{' '}
              {formatCount(indexed.chunkCount)} chunks indexed from{' '}
              <span className={mono}>{indexed.vaultPath}</span>
            </span>
          ) : null}
        </div>

        {reindex.error ? (
          <p className={cn('text-[12px] leading-relaxed', textMuted)}>
            {indexUnavailable
              ? 'The memory service has not started yet, so the folder has not been read. This is a wiring gap inside the app, not a problem with your folder — indexing will happen on the next launch.'
              : `Indexing failed: ${reindex.error.message}`}
          </p>
        ) : null}
      </div>

      <div>
        <p className={cn('mb-1.5 text-[12.5px] leading-relaxed', textSubtle)}>
          Other sources — mail, calendar, reminders — are read through the OS
          rather than through an account you connect. Here is what this machine
          reports:
        </p>
        <ProvidersPanel />
      </div>
    </>
  );
}

export default DataSourceStep;
