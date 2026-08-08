/**
 * Settings. Owns `/settings` and everything under it.
 *
 * One long, scannable page rather than tabs: there are nine sections and a
 * person configuring a new machine reads most of them once, in order. The
 * section rail jumps; nothing is hidden behind a click.
 *
 * Three things this screen treats as load-bearing rather than decorative:
 *
 *  - **The environment report sits at the top**, above anything editable,
 *    because "which engine will actually run, and is it billing my
 *    subscription" is the question people open this screen with.
 *  - **The privacy statement is UI, not README.** No account, no telemetry, no
 *    backend of ours is the product's actual differentiator; a claim you have
 *    to go looking for is a claim nobody believes.
 *  - **Nothing invalid is persisted.** Every control validates against the leaf
 *    schema in `shared/settings.ts` before the patch is built, and the patch
 *    itself is re-validated in `useSettingsWriter` before it crosses the
 *    bridge.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Bell,
  Cpu,
  Database,
  FolderTree,
  Gauge,
  Library,
  Lock,
  Monitor,
  PlugZap,
  ScrollText,
  Search,
  ShieldCheck,
  Timer,
} from 'lucide-react';
import { APPROVAL_SCOPES, type ApprovalScope } from '../../../shared/approvals';
import { LOG_LEVELS, type LogLevel } from '../../../shared/common';
import { KNOWN_ENGINE_IDS } from '../../../shared/engines';
import {
  ApprovalSettingsSchema,
  EngineSettingsSchema,
  LoggingSettingsSchema,
  MemorySettingsSchema,
  ScheduleSettingsSchema,
  SettingsSchema,
  UiSettingsSchema,
  type SettingsPatch,
} from '../../../shared/settings';
import { APP_NAME, DEFAULT_WORKSPACE_HINT } from '../../constants';
import { cn } from '../../lib/utils';
import { formatBytes } from '../../lib/format';
import { isBridgeAvailable } from '../../lib/ipc';
import {
  Badge,
  Button,
  ConfirmDialog,
  Input,
  eyebrow,
  mono,
  textMuted,
  textSubtle,
} from '../../components/ui';
import { PageHeader } from '../../components/layout/PageHeader';
import { searchSettings } from './search';
import { useEnvironmentStore, useSettingsStore } from '../../store';
import { EnvironmentPanel } from './EnvironmentPanel';
import { Notice } from './Notice';
import { describeUnavailable } from './environment';
import {
  FieldGrid,
  NumberSetting,
  ReadOnlyFact,
  SelectSetting,
  SettingsSection,
  SwitchSetting,
  TextSetting,
} from './fields';
import { useSettingsWriter } from './writer';

/* ------------------------------------------------------------------ */
/* Section rail                                                        */
/* ------------------------------------------------------------------ */

const SECTIONS = [
  { id: 'environment', label: 'Environment', icon: PlugZap },
  { id: 'privacy', label: 'Privacy', icon: Lock },
  { id: 'workspace', label: 'Workspace', icon: FolderTree },
  { id: 'engine', label: 'Engine', icon: Cpu },
  { id: 'approvals', label: 'Approvals', icon: ShieldCheck },
  { id: 'memory', label: 'Memory', icon: Library },
  { id: 'schedule', label: 'Schedule', icon: Timer },
  { id: 'interface', label: 'Interface', icon: Monitor },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'logging', label: 'Logging', icon: ScrollText },
] as const;

const SECTION_ICONS = Object.fromEntries(
  SECTIONS.map((section) => [section.id, section.icon]),
);

function scrollToSection(id: string) {
  if (typeof document === 'undefined') return;
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // A brief highlight so the eye lands on the section it jumped to.
  el.classList.add('settings-jump-flash');
  window.setTimeout(() => el.classList.remove('settings-jump-flash'), 1200);
}

/**
 * The section rail, now with a fuzzy search over every section and the options
 * inside it. Typing filters the rail to matches (best first); Enter jumps to
 * the top match. Clearing the box restores the full rail in reading order.
 */
function SectionRail() {
  const [query, setQuery] = useState('');
  const results = useMemo(() => searchSettings(query), [query]);
  const searching = query.trim().length > 0;

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && results.length > 0) {
      e.preventDefault();
      scrollToSection(results[0].entry.id);
    } else if (e.key === 'Escape') {
      setQuery('');
    }
  };

  return (
    <div className="flex flex-col gap-2 border-b border-zinc-200 pb-2 dark:border-zinc-800">
      <Input
        icon={Search}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Search settings…  (e.g. dark mode, cron, log retention)"
        aria-label="Search settings"
        className="h-8 text-[12.5px]"
      />
      <nav aria-label="Settings sections" className="flex flex-wrap gap-1">
        {searching && results.length === 0 ? (
          <span className={cn('px-1 py-1 text-[12px]', textMuted)}>
            No settings match “{query.trim()}”.
          </span>
        ) : (
          results.map(({ entry }) => {
            const Icon = SECTION_ICONS[entry.id];
            return (
              <Button
                key={entry.id}
                size="xs"
                variant="ghost"
                icon={Icon}
                onClick={() => scrollToSection(entry.id)}
              >
                {entry.label}
              </Button>
            );
          })
        )}
      </nav>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Storage map                                                         */
/* ------------------------------------------------------------------ */

interface StorageEntry {
  path: string;
  what: string;
}

function storageMap(memoryDir: string): StorageEntry[] {
  return [
    {
      path: 'settings.json',
      what: 'Everything on this screen. Plain JSON — editable by hand if you ever need to.',
    },
    {
      path: 'assistant.db',
      what: 'SQLite: runs, steps, tool calls, tasks, goals, scheduled jobs, approval decisions and the memory index.',
    },
    {
      path: `${memoryDir || 'memory'}/`,
      what: 'The memory vault, as Markdown files. Yours to read, edit or delete with any editor.',
    },
    {
      path: 'runs/<runId>/',
      what: 'transcript.jsonl and stderr.log for each run — the raw record behind every timeline.',
    },
    { path: 'logs/', what: 'Application logs, rotated by the rules below.' },
    {
      path: 'runtime/',
      what: 'The MCP socket and its per-launch token. Mode 0700, wiped and regenerated on every launch.',
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Screen                                                              */
/* ------------------------------------------------------------------ */

export function SettingsScreen() {
  const settings = useSettingsStore((state) => state.settings);
  const status = useSettingsStore((state) => state.status);
  const error = useSettingsStore((state) => state.error);
  const unavailable = useSettingsStore((state) => state.unavailable);
  const loadSettings = useSettingsStore((state) => state.load);
  const environment = useEnvironmentStore((state) => state.environment);
  const loadEnvironment = useEnvironmentStore((state) => state.load);

  const { write, saving, canWrite, blockedReason } = useSettingsWriter();
  const [confirmOpenGate, setConfirmOpenGate] = useState(false);

  /**
   * Fire-and-forget wrapper. Control handlers are `void`-returning by
   * signature; handing them a promise makes an unhandled rejection out of a
   * failure that `write` has already reported as a toast.
   */
  const save = (patch: SettingsPatch, label: string): void => {
    void write(patch, label);
  };

  useEffect(() => {
    if (useSettingsStore.getState().status === 'idle') void loadSettings();
    if (useEnvironmentStore.getState().status === 'idle')
      void loadEnvironment();
  }, [loadSettings, loadEnvironment]);

  const notice = describeUnavailable(
    { status, error, unavailable },
    isBridgeAvailable(),
    'Settings',
  );

  const workspaceRoot = settings.workspaceRoot || DEFAULT_WORKSPACE_HINT;
  const memoryPath = `${workspaceRoot.replace(/\/+$/, '')}/${settings.memory.directory}`;

  const engineOptions = useMemo(() => {
    const detected = environment?.engines ?? [];
    const ids = Array.from(
      new Set<string>([
        ...KNOWN_ENGINE_IDS,
        ...detected.map((engine) => engine.id),
        settings.engine.preferred,
      ]),
    );
    return ids.map((id) => {
      const match = detected.find((engine) => engine.id === id);
      let suffix = ' — not detected yet';
      if (match) suffix = match.available ? '' : ' — not installed';
      return { value: id, label: `${match?.name ?? id}${suffix}` };
    });
  }, [environment, settings.engine.preferred]);

  const timezoneSchema = useMemo(
    () => ({
      safeParse: (value: unknown) => {
        const base = ScheduleSettingsSchema.shape.timezone.safeParse(value);
        if (!base.success) return base;
        try {
          // Throws RangeError on an unknown zone. `Intl` is the only IANA
          // database we have, and it is the one the scheduler will use.
          Intl.DateTimeFormat(undefined, { timeZone: base.data });
        } catch {
          return {
            success: false as const,
            error: {
              issues: [
                {
                  path: [] as PropertyKey[],
                  message: `“${base.data}” is not a time zone this machine knows. Use an IANA name such as Europe/London or America/New_York.`,
                },
              ],
            },
          };
        }
        return base;
      },
    }),
    [],
  );

  const disabled = !canWrite || saving;

  return (
    <>
      <PageHeader
        title="Settings"
        description="Engine, workspace, approvals, notifications — and what this machine can actually do."
        toolbar={<SectionRail />}
      />

      <div className="mx-auto w-full max-w-3xl space-y-5 px-5 py-5">
        {notice ? (
          <Notice
            tone={notice.tone}
            icon={PlugZap}
            eyebrow="Not saved"
            title={notice.title}
            detail={notice.detail}
            detailLabel="bridge said"
            actions={
              notice.retryable ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    void loadSettings();
                  }}
                >
                  Try again
                </Button>
              ) : null
            }
          >
            <p>{notice.body}</p>
          </Notice>
        ) : null}

        {/* ---------------------------------------------------------- */}
        <SettingsSection
          id="environment"
          title="Environment"
          description="What this machine can do right now. Re-checked automatically whenever this window regains focus, because installing a CLI, signing in or granting a permission all happen somewhere else."
        >
          <EnvironmentPanel />
        </SettingsSection>

        {/* ---------------------------------------------------------- */}
        <section
          id="privacy"
          aria-labelledby="privacy-title"
          className="scroll-mt-6 rounded-lg border border-emerald-200 bg-emerald-50/60 px-4 py-3.5 dark:border-emerald-500/30 dark:bg-emerald-500/[0.07]"
        >
          <div className="flex gap-3">
            <Lock
              size={16}
              aria-hidden="true"
              className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400"
            />
            <div className="min-w-0">
              <h2
                id="privacy-title"
                className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-100"
              >
                No account, no telemetry, no backend of ours
              </h2>
              <p
                className={cn(
                  'mt-1 max-w-2xl text-[12.5px] leading-relaxed',
                  textSubtle,
                )}
              >
                {APP_NAME} has no server. There is nothing to sign up for,
                nothing phoning home, no crash reporting, no analytics and no
                licence check. Every setting, run transcript and memory file on
                this page lives in the folder below, on this disk, in formats
                you can open yourself.
              </p>
              <p
                className={cn(
                  'mt-1.5 max-w-2xl text-[12.5px] leading-relaxed',
                  textSubtle,
                )}
              >
                The only network traffic this app causes is your agent CLI
                talking to its own vendor, with your own credentials — the same
                traffic you would make running it in a terminal.
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Badge tone="success" size="sm">
                  No account
                </Badge>
                <Badge tone="success" size="sm">
                  No telemetry
                </Badge>
                <Badge tone="success" size="sm">
                  No crash reporting
                </Badge>
                <Badge tone="success" size="sm">
                  Offline except the CLI
                </Badge>
              </div>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------- */}
        <SettingsSection
          id="workspace"
          title="Workspace"
          description="One folder holds everything this app knows. Move it and you have moved the whole assistant."
        >
          <TextSetting
            id="workspace-root"
            label="Workspace folder"
            monospace
            placeholder={DEFAULT_WORKSPACE_HINT}
            hint={`Absolute path. Leave empty to use ${DEFAULT_WORKSPACE_HINT}. Changing this does not move existing data — point it at a folder you have already moved, or start fresh.`}
            value={settings.workspaceRoot}
            schema={SettingsSchema.shape.workspaceRoot}
            disabled={disabled}
            onCommit={(value) =>
              save({ workspaceRoot: value }, 'Workspace folder')
            }
          />

          <Notice
            tone="info"
            size="compact"
            icon={FolderTree}
            title="There is no folder picker in this build"
          >
            <p>
              Type or paste the path above. A native “Choose folder…” dialog
              needs a main-process channel that the IPC contract does not have
              yet, and inventing one here would only produce a button that does
              nothing.
            </p>
          </Notice>

          <div>
            <p className={eyebrow}>What is stored where</p>
            <ReadOnlyFact
              label="Resolved path"
              value={workspaceRoot}
              hint="Everything below is relative to this folder."
            />
            <ul className="mt-2 divide-y divide-zinc-100 dark:divide-zinc-800/70">
              {storageMap(settings.memory.directory).map((entry) => (
                <li key={entry.path} className="py-2">
                  <p className={cn(mono, 'text-zinc-800 dark:text-zinc-200')}>
                    {entry.path}
                  </p>
                  <p
                    className={cn(
                      'mt-0.5 text-[12.5px] leading-relaxed',
                      textMuted,
                    )}
                  >
                    {entry.what}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </SettingsSection>

        {/* ---------------------------------------------------------- */}
        <SettingsSection
          id="engine"
          title="Engine"
          description="Which agent CLI runs your work, and the ceilings every single step is given. Limits are cheaper than loop detection and they are applied whether or not you are watching."
        >
          <FieldGrid>
            <SelectSetting
              id="engine-preferred"
              label="Preferred engine"
              hint="Used when a run does not name one."
              value={settings.engine.preferred}
              schema={EngineSettingsSchema.shape.preferred}
              options={engineOptions}
              disabled={disabled}
              onCommit={(value) =>
                save({ engine: { preferred: value } }, 'Preferred engine')
              }
            />
            <TextSetting
              id="engine-binary"
              label="Binary path"
              monospace
              placeholder="(find it on PATH)"
              hint="Leave empty to search PATH. Set this if the CLI is installed somewhere the app cannot see."
              value={settings.engine.binaryPath}
              schema={EngineSettingsSchema.shape.binaryPath}
              disabled={disabled}
              onCommit={(value) =>
                save({ engine: { binaryPath: value } }, 'Binary path')
              }
            />
            <NumberSetting
              id="engine-max-turns"
              label="Turn limit per step"
              hint="Stops a step that has started talking to itself."
              value={settings.engine.maxTurnsPerStep}
              schema={EngineSettingsSchema.shape.maxTurnsPerStep}
              invalidMessage="Enter a whole number of turns, at least 1."
              min={1}
              step={1}
              disabled={disabled}
              onCommit={(value) =>
                save(
                  { engine: { maxTurnsPerStep: value } },
                  'Turn limit per step',
                )
              }
            />
            <NumberSetting
              id="engine-max-cost"
              label="Cost ceiling per run"
              unit={{ label: 'USD', factor: 1 }}
              hint="0 disables the check. A run that would cross this stops instead."
              value={settings.engine.maxCostUsdPerRun}
              schema={EngineSettingsSchema.shape.maxCostUsdPerRun}
              invalidMessage="Enter 0 or more. Use 0 to turn the ceiling off."
              min={0}
              step={0.5}
              disabled={disabled}
              onCommit={(value) =>
                save(
                  { engine: { maxCostUsdPerRun: value } },
                  'Cost ceiling per run',
                )
              }
            />
            <NumberSetting
              id="engine-step-timeout"
              label="Step timeout"
              unit={{ label: 'minutes', factor: 60_000 }}
              hint="Wall clock. A step that hangs is killed, not waited on."
              value={settings.engine.stepTimeoutMs}
              schema={EngineSettingsSchema.shape.stepTimeoutMs}
              invalidMessage="Enter a positive number of minutes."
              min={0.5}
              step={0.5}
              disabled={disabled}
              onCommit={(value) =>
                save({ engine: { stepTimeoutMs: value } }, 'Step timeout')
              }
            />
            <TextSetting
              id="engine-cwd"
              label="Default working directory"
              monospace
              placeholder="(the workspace folder)"
              hint="Where the CLI is spawned. Leave empty to use the workspace folder — a stale session in an unexpected directory can make an unattended run hang on a resume prompt."
              value={settings.engine.defaultCwd}
              schema={EngineSettingsSchema.shape.defaultCwd}
              disabled={disabled}
              onCommit={(value) =>
                save(
                  { engine: { defaultCwd: value } },
                  'Default working directory',
                )
              }
            />
          </FieldGrid>
        </SettingsSection>

        {/* ---------------------------------------------------------- */}
        <SettingsSection
          id="approvals"
          title="Approvals"
          description="The gate every side-effecting tool call passes through. This is the mechanism the whole product rests on."
        >
          <SwitchSetting
            id="approvals-require"
            label="Ask before side-effecting actions"
            description="Sending mail, writing files outside the workspace, changing a calendar. With this off, the agent acts without asking."
            checked={settings.approvals.requireForSideEffecting}
            disabled={disabled}
            onChange={(next) => {
              if (!next) {
                setConfirmOpenGate(true);
                return;
              }
              save(
                { approvals: { requireForSideEffecting: true } },
                'Approval gate',
              );
            }}
          />
          <SwitchSetting
            id="approvals-always"
            label="Offer the “always” button"
            description="Lets you grant a standing permission from the approval card. Without it, every calendar read is a fresh decision — which is how people end up turning the gate off entirely."
            checked={settings.approvals.allowAlwaysScope}
            disabled={disabled}
            onChange={(next) =>
              save({ approvals: { allowAlwaysScope: next } }, 'Always scope')
            }
          />
          <FieldGrid>
            <SelectSetting<ApprovalScope>
              id="approvals-scope"
              label="Pre-selected scope"
              hint="Which button the approval card highlights first."
              value={settings.approvals.defaultScope}
              schema={ApprovalSettingsSchema.shape.defaultScope}
              options={APPROVAL_SCOPES.filter(
                (scope) =>
                  scope !== 'always' || settings.approvals.allowAlwaysScope,
              ).map((scope) => ({
                value: scope,
                label: {
                  once: 'Just this once',
                  run: 'For the rest of this run',
                  always: 'Always',
                }[scope],
              }))}
              disabled={disabled}
              onCommit={(value) =>
                save(
                  { approvals: { defaultScope: value } },
                  'Pre-selected scope',
                )
              }
            />
            <NumberSetting
              id="approvals-ttl"
              label="Pending request expires after"
              unit={{ label: 'minutes', factor: 60_000 }}
              hint="0 keeps requests waiting forever. An expired request is denied, never approved."
              value={settings.approvals.pendingTtlMs}
              schema={ApprovalSettingsSchema.shape.pendingTtlMs}
              invalidMessage="Enter 0 or more minutes."
              min={0}
              step={5}
              disabled={disabled}
              onCommit={(value) =>
                save(
                  { approvals: { pendingTtlMs: value } },
                  'Pending request expiry',
                )
              }
            />
          </FieldGrid>
        </SettingsSection>

        {/* ---------------------------------------------------------- */}
        <SettingsSection
          id="memory"
          title="Memory"
          description="The vault is a folder of Markdown files. The index is derived — you can delete it and it rebuilds."
        >
          <FieldGrid>
            <TextSetting
              id="memory-directory"
              label="Vault folder"
              monospace
              hint={`Relative to the workspace folder. Currently ${memoryPath}`}
              value={settings.memory.directory}
              schema={MemorySettingsSchema.shape.directory}
              disabled={disabled}
              onCommit={(value) =>
                save({ memory: { directory: value } }, 'Vault folder')
              }
            />
          </FieldGrid>
          <SwitchSetting
            id="memory-watch"
            label="Watch the vault for changes"
            description="Re-indexes a file moments after you save it in your own editor."
            checked={settings.memory.watch}
            disabled={disabled}
            onChange={(next) =>
              save({ memory: { watch: next } }, 'Vault watching')
            }
          />
          <SwitchSetting
            id="memory-index-on-start"
            label="Index on start"
            description="Catches anything edited while the app was closed. Costs a few seconds at launch on a large vault."
            checked={settings.memory.indexOnStart}
            disabled={disabled}
            onChange={(next) =>
              save({ memory: { indexOnStart: next } }, 'Index on start')
            }
          />
        </SettingsSection>

        {/* ---------------------------------------------------------- */}
        <SettingsSection
          id="schedule"
          title="Schedule"
          description="Recurring jobs. Every wake-up checks a real condition before it spends anything — an unconditional timer would exhaust a weekly quota by Tuesday."
        >
          <SwitchSetting
            id="schedule-enabled"
            label="Run scheduled jobs"
            description="Turning this off pauses every job at once without deleting any of them."
            checked={settings.schedule.enabled}
            disabled={disabled}
            onChange={(next) =>
              save({ schedule: { enabled: next } }, 'Scheduler')
            }
          />
          <FieldGrid>
            <TextSetting
              id="schedule-timezone"
              label="Default time zone"
              monospace
              placeholder="UTC"
              hint="IANA name, used by any job that does not carry its own."
              value={settings.schedule.timezone}
              schema={timezoneSchema}
              disabled={disabled}
              onCommit={(value) =>
                save({ schedule: { timezone: value } }, 'Time zone')
              }
            />
            <NumberSetting
              id="schedule-tick"
              label="Scheduler tick"
              unit={{ label: 'seconds', factor: 1000 }}
              hint="How often the scheduler wakes to look for due jobs. Waking is cheap; spawning is what costs."
              value={settings.schedule.tickMs}
              schema={ScheduleSettingsSchema.shape.tickMs}
              invalidMessage="Enter a positive number of seconds."
              min={1}
              step={5}
              disabled={disabled}
              onCommit={(value) =>
                save({ schedule: { tickMs: value } }, 'Scheduler tick')
              }
            />
          </FieldGrid>
        </SettingsSection>

        {/* ---------------------------------------------------------- */}
        <SettingsSection
          id="interface"
          title="Interface"
          description="How this window looks and how much it tells you."
        >
          <FieldGrid>
            <SelectSetting<'system' | 'light' | 'dark'>
              id="ui-theme"
              label="Theme"
              value={settings.ui.theme}
              schema={UiSettingsSchema.shape.theme}
              options={[
                { value: 'system', label: 'Match the system' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
              disabled={disabled}
              onCommit={(value) => save({ ui: { theme: value } }, 'Theme')}
            />
            <SelectSetting<'comfortable' | 'compact'>
              id="ui-density"
              label="Density"
              hint="Compact fits more of a long run on screen."
              value={settings.ui.density}
              schema={UiSettingsSchema.shape.density}
              options={[
                { value: 'comfortable', label: 'Comfortable' },
                { value: 'compact', label: 'Compact' },
              ]}
              disabled={disabled}
              onCommit={(value) => save({ ui: { density: value } }, 'Density')}
            />
          </FieldGrid>
          <SwitchSetting
            id="ui-show-costs"
            label="Show cost and tokens in the run timeline"
            description="The engine reports both on every result. Hiding them does not stop them being recorded."
            checked={settings.ui.showCosts}
            disabled={disabled}
            onChange={(next) =>
              save({ ui: { showCosts: next } }, 'Cost display')
            }
          />
        </SettingsSection>

        {/* ---------------------------------------------------------- */}
        <SettingsSection
          id="notifications"
          title="Notifications"
          description="System notifications, from the OS. Nothing is sent anywhere."
        >
          <SwitchSetting
            id="notify-enabled"
            label="Allow notifications"
            checked={settings.notifications.enabled}
            disabled={disabled}
            onChange={(next) =>
              save({ notifications: { enabled: next } }, 'Notifications')
            }
          />
          <SwitchSetting
            id="notify-approval"
            label="When an action is waiting on me"
            description="The one worth keeping on — an unattended run stops until you answer."
            checked={settings.notifications.onApprovalRequired}
            disabled={disabled || !settings.notifications.enabled}
            onChange={(next) =>
              save(
                { notifications: { onApprovalRequired: next } },
                'Approval notifications',
              )
            }
          />
          <SwitchSetting
            id="notify-finished"
            label="When a run finishes"
            checked={settings.notifications.onRunFinished}
            disabled={disabled || !settings.notifications.enabled}
            onChange={(next) =>
              save(
                { notifications: { onRunFinished: next } },
                'Run notifications',
              )
            }
          />
        </SettingsSection>

        {/* ---------------------------------------------------------- */}
        <SettingsSection
          id="logging"
          title="Logging"
          description={`Written to ${workspaceRoot.replace(/\/+$/, '')}/logs. Local files, rotated on size — never uploaded.`}
        >
          <FieldGrid>
            <SelectSetting<LogLevel>
              id="log-level"
              label="Level"
              hint="debug is loud but it is the fastest way to explain a strange run."
              value={settings.logging.level}
              schema={LoggingSettingsSchema.shape.level}
              options={LOG_LEVELS.map((level) => ({
                value: level,
                label: level,
              }))}
              disabled={disabled}
              onCommit={(value) =>
                save({ logging: { level: value } }, 'Log level')
              }
            />
            <NumberSetting
              id="log-size"
              label="Rotate at"
              unit={{ label: 'MB', factor: 1024 * 1024 }}
              hint={`Currently ${formatBytes(settings.logging.maxFileBytes)} per file.`}
              value={settings.logging.maxFileBytes}
              schema={LoggingSettingsSchema.shape.maxFileBytes}
              invalidMessage="Enter a positive size in megabytes."
              min={0.1}
              step={1}
              disabled={disabled}
              onCommit={(value) =>
                save({ logging: { maxFileBytes: value } }, 'Log rotation size')
              }
            />
            <NumberSetting
              id="log-files"
              label="Files kept"
              hint="Older files past this count are deleted."
              value={settings.logging.maxFiles}
              schema={LoggingSettingsSchema.shape.maxFiles}
              invalidMessage="Keep at least 1 file."
              min={1}
              step={1}
              disabled={disabled}
              onCommit={(value) =>
                save({ logging: { maxFiles: value } }, 'Files kept')
              }
            />
          </FieldGrid>
        </SettingsSection>

        {blockedReason ? (
          <p
            className={cn(
              'flex items-start gap-2 pb-6 text-[12px] leading-relaxed',
              textMuted,
            )}
          >
            <Gauge size={13} aria-hidden="true" className="mt-0.5 shrink-0" />
            <span>{blockedReason}</span>
          </p>
        ) : (
          <p
            className={cn(
              'flex items-center gap-2 pb-6 text-[12px]',
              textMuted,
            )}
          >
            <Database size={13} aria-hidden="true" />
            <span>
              Changes save as you leave each field. Press Escape while editing
              to restore the stored value.
            </span>
          </p>
        )}
      </div>

      <ConfirmDialog
        open={confirmOpenGate}
        tone="danger"
        title="Let the agent act without asking?"
        description="Every side-effecting tool call — sending mail, writing files outside the workspace, changing your calendar — will run the moment the agent decides to make it, with no confirmation and no chance to stop it. Decisions are still logged, but only after the fact."
        confirmLabel="Turn the gate off"
        cancelLabel="Keep asking me"
        onCancel={() => setConfirmOpenGate(false)}
        onConfirm={async () => {
          setConfirmOpenGate(false);
          await write(
            { approvals: { requireForSideEffecting: false } },
            'Approval gate',
          );
        }}
      />
    </>
  );
}

export default SettingsScreen;
