/**
 * Create / edit a scheduled job.
 *
 * Two rules from ARCHITECTURE.md shape this form and are worth restating where
 * someone might be tempted to "improve" it:
 *
 * 1. **No natural-language date parser.** The field takes a cron expression.
 *    Every keystroke goes to `schedule:validate-cron`, and the English the
 *    backend gives back is echoed at the point of decision — right above the
 *    save button — so nobody confirms a schedule they cannot read. A
 *    description we generated in the renderer would be a second parser to keep
 *    in sync and would get confirmed when it was wrong.
 *
 * 2. **The condition is not an advanced setting.** It is the thing that stops
 *    an unconditional timer from exhausting a weekly quota, so it gets a
 *    section of its own and `always` says out loud what it costs.
 *
 * When validation itself is unreachable (the backend is not wired up yet) the
 * form stays usable and says so, rather than locking the save button behind a
 * channel that is never going to answer.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CalendarCheck,
  CheckCircle2,
  Clock3,
  PlugZap,
} from 'lucide-react';
import { IPC } from '../../../shared/ipc';
import {
  MISSED_RUN_POLICIES,
  type MissedRunPolicy,
  type ScheduleCondition,
  type ScheduleConditionKind,
  type ScheduledJob,
} from '../../../shared/schedule';
import { cn } from '../../lib/utils';
import { useMutation, useQuery, type IpcError } from '../../lib/ipc';
import { formatDateTime } from '../../lib/format';
import {
  Button,
  Dialog,
  Field,
  Input,
  Select,
  Switch,
  Textarea,
} from '../../components/ui';
import { eyebrow, mono, textMuted } from '../../components/ui/styles';
import {
  MISSED_RUN_POLICY_HINT,
  MISSED_RUN_POLICY_LABEL,
  conditionMeta,
} from './parts';

/** Typing pause before a cron expression crosses the IPC boundary. */
const VALIDATE_DEBOUNCE_MS = 250;

/** The host zone, which is what a new job should default to. */
function hostTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * A handful of expressions covering most of what a personal assistant is asked
 * to do. Presets, not a parser — clicking one fills the cron field, which is
 * then validated and described by the backend like anything else.
 */
const PRESETS: readonly { label: string; cron: string }[] = [
  { label: 'Weekdays 09:00', cron: '0 9 * * 1-5' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 15 min', cron: '*/15 * * * *' },
  { label: 'Daily 07:30', cron: '30 7 * * *' },
  { label: 'Mondays 08:00', cron: '0 8 * * 1' },
];

const CONDITION_OPTIONS: readonly {
  value: ScheduleConditionKind;
  label: string;
}[] = [
  { value: 'always', label: 'Always — no gate' },
  { value: 'file-changed', label: 'Only when a file has changed' },
  { value: 'counter-changed', label: 'Only when a counter has moved' },
  { value: 'time-window', label: 'Only inside a time window' },
];

const WEEKDAYS = [
  { value: 0, label: 'Sun' },
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
];

interface Draft {
  name: string;
  description: string;
  prompt: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  conditionKind: ScheduleConditionKind;
  filePath: string;
  counterSource: string;
  startHour: number;
  endHour: number;
  weekdays: number[];
  missedRunPolicy: MissedRunPolicy;
  engine: string;
  allowedTools: string;
  maxTurns: string;
  maxCostUsd: string;
}

function emptyDraft(): Draft {
  return {
    name: '',
    description: '',
    prompt: '',
    cron: '',
    timezone: hostTimezone(),
    enabled: true,
    conditionKind: 'always',
    filePath: '',
    counterSource: '',
    startHour: 9,
    endHour: 18,
    weekdays: [],
    missedRunPolicy: 'skip',
    engine: '',
    allowedTools: '',
    maxTurns: '',
    maxCostUsd: '',
  };
}

function draftFrom(job: ScheduledJob): Draft {
  const base = emptyDraft();
  const { condition } = job;
  return {
    ...base,
    name: job.name,
    description: job.description ?? '',
    prompt: job.prompt,
    cron: job.cron,
    timezone: job.timezone || base.timezone,
    enabled: job.enabled,
    conditionKind: condition.kind,
    filePath: condition.kind === 'file-changed' ? condition.path : '',
    counterSource: condition.kind === 'counter-changed' ? condition.source : '',
    startHour: condition.kind === 'time-window' ? condition.startHour : 9,
    endHour: condition.kind === 'time-window' ? condition.endHour : 18,
    weekdays: condition.kind === 'time-window' ? [...condition.weekdays] : [],
    missedRunPolicy: job.missedRunPolicy,
    engine: job.engine ?? '',
    allowedTools: job.allowedTools.join(', '),
    maxTurns: job.maxTurns === undefined ? '' : String(job.maxTurns),
    maxCostUsd: job.maxCostUsd === undefined ? '' : String(job.maxCostUsd),
  };
}

function buildCondition(draft: Draft): ScheduleCondition {
  switch (draft.conditionKind) {
    case 'file-changed':
      return { kind: 'file-changed', path: draft.filePath.trim() };
    case 'counter-changed':
      return { kind: 'counter-changed', source: draft.counterSource.trim() };
    case 'time-window':
      return {
        kind: 'time-window',
        startHour: draft.startHour,
        endHour: draft.endHour,
        weekdays: [...draft.weekdays].sort((a, b) => a - b),
      };
    case 'always':
    default:
      return { kind: 'always' };
  }
}

function parseList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parsePositiveInt(value: string): number | undefined {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parsePositiveFloat(value: string): number | undefined {
  const parsed = Number.parseFloat(value.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** What is missing before this draft can be saved, in the user's words. */
function draftProblem(draft: Draft): string | null {
  if (!draft.name.trim()) return 'Give the job a name.';
  if (!draft.prompt.trim()) return 'The job needs a prompt to hand the engine.';
  if (!draft.cron.trim()) return 'Enter a cron expression.';
  if (draft.conditionKind === 'file-changed' && !draft.filePath.trim()) {
    return 'Name the file to watch.';
  }
  if (
    draft.conditionKind === 'counter-changed' &&
    !draft.counterSource.trim()
  ) {
    return 'Name the counter to watch.';
  }
  if (
    draft.conditionKind === 'time-window' &&
    draft.endHour <= draft.startHour
  ) {
    return 'The window has to end after it starts.';
  }
  return null;
}

export interface JobDialogProps {
  open: boolean;
  /** Null creates a new job. */
  job: ScheduledJob | null;
  onClose: () => void;
  onSaved: (job: ScheduledJob) => void;
}

export function JobDialog({ open, job, onClose, onSaved }: JobDialogProps) {
  const [draft, setDraft] = useState<Draft>(() =>
    job ? draftFrom(job) : emptyDraft(),
  );
  const [debouncedCron, setDebouncedCron] = useState(draft.cron);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Re-seed whenever the dialog is opened on a different job.
  useEffect(() => {
    if (!open) return;
    const next = job ? draftFrom(job) : emptyDraft();
    setDraft(next);
    setDebouncedCron(next.cron);
    setSaveError(null);
  }, [open, job]);

  useEffect(() => {
    const timer = setTimeout(
      () => setDebouncedCron(draft.cron),
      VALIDATE_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [draft.cron]);

  const trimmedCron = debouncedCron.trim();
  const validation = useQuery(
    IPC.schedule.validateCron,
    { cron: trimmedCron, timezone: draft.timezone },
    { enabled: open && trimmedCron.length > 0 },
  );

  const create = useMutation(IPC.schedule.create);
  const update = useMutation(IPC.schedule.update);
  const pending = create.pending || update.pending;

  const patch = (next: Partial<Draft>) =>
    setDraft((previous) => ({ ...previous, ...next }));

  const problem = draftProblem(draft);
  const stale = draft.cron.trim() !== trimmedCron;
  const cronUnverifiable = Boolean(validation.error);
  const cronRejected =
    !cronUnverifiable &&
    validation.data !== undefined &&
    !validation.data.valid;
  const cronConfirmed =
    !cronUnverifiable &&
    !stale &&
    validation.data !== undefined &&
    validation.data.valid;

  const canSave = !problem && !cronRejected && !pending;

  const submit = async () => {
    if (!canSave) return;
    setSaveError(null);
    const condition = buildCondition(draft);
    const shared = {
      name: draft.name.trim(),
      description: draft.description.trim(),
      cron: draft.cron.trim(),
      timezone: draft.timezone.trim() || hostTimezone(),
      enabled: draft.enabled,
      condition,
      prompt: draft.prompt.trim(),
      engine: draft.engine.trim() || undefined,
      allowedTools: parseList(draft.allowedTools),
      maxTurns: parsePositiveInt(draft.maxTurns),
      maxCostUsd: parsePositiveFloat(draft.maxCostUsd),
      missedRunPolicy: draft.missedRunPolicy,
    };

    const saved = job
      ? await update.mutate({ id: job.id, ...shared })
      : await create.mutate(shared);

    if (!saved) {
      const failure: IpcError | null = job ? update.error : create.error;
      setSaveError(
        failure?.isUnavailable
          ? 'The scheduler is not answering, so the job could not be saved. Nothing was changed.'
          : (failure?.message ?? 'The job could not be saved.'),
      );
      return;
    }
    onSaved(saved);
  };

  const nextRuns = validation.data?.nextRuns ?? [];
  const conditionRationale = conditionMeta(draft.conditionKind).rationale;

  const echo = useMemo(() => {
    if (cronUnverifiable) {
      return {
        tone: 'unverified' as const,
        title: 'Cannot check this expression right now',
        body: 'The scheduler is not answering, so it has not been validated or described. It will be checked when it is saved.',
      };
    }
    if (!draft.cron.trim()) {
      return {
        tone: 'idle' as const,
        title: 'Enter a cron expression',
        body: 'Five or six fields, e.g. 0 9 * * 1-5. It is described back to you in English before you can save it.',
      };
    }
    if (stale || validation.loading) {
      return {
        tone: 'idle' as const,
        title: 'Checking…',
        body: 'Validating the expression with the scheduler.',
      };
    }
    if (cronRejected) {
      return {
        tone: 'invalid' as const,
        title: 'Not a valid cron expression',
        body: validation.data?.error ?? 'The scheduler could not parse it.',
      };
    }
    return {
      tone: 'valid' as const,
      title: validation.data?.humanReadable || draft.cron.trim(),
      body: '',
    };
  }, [
    cronUnverifiable,
    cronRejected,
    draft.cron,
    stale,
    validation.loading,
    validation.data,
  ]);

  return (
    <Dialog
      open={open}
      onClose={pending ? () => {} : onClose}
      size="lg"
      title={job ? `Edit “${job.name}”` : 'New scheduled job'}
      description={
        job
          ? 'Changes take effect at the next occurrence.'
          : 'A job spawns the engine on a cron schedule — but only when its condition passes.'
      }
      footer={
        <div className="flex w-full items-center gap-3">
          <div className="min-w-0 flex-1">
            {cronConfirmed ? (
              <p className="flex items-center gap-1.5 truncate text-[12px] text-emerald-700 dark:text-emerald-400">
                <CheckCircle2
                  size={13}
                  aria-hidden="true"
                  className="shrink-0"
                />
                <span className="truncate">
                  Saves as:{' '}
                  {validation.data?.humanReadable || draft.cron.trim()}
                </span>
              </p>
            ) : (
              <p className={cn('truncate text-[12px]', textMuted)}>
                {problem ?? echo.title}
              </p>
            )}
          </div>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              void submit();
            }}
            loading={pending}
            disabled={!canSave}
          >
            {job ? 'Save changes' : 'Create job'}
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        {saveError ? (
          <p className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-[12.5px] text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-300">
            {saveError}
          </p>
        ) : null}

        {/* ---- what it does ---------------------------------------- */}
        <section className="space-y-3">
          <p className={eyebrow}>What it does</p>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Name"
              required
              value={draft.name}
              placeholder="Morning mail triage"
              onChange={(event) => patch({ name: event.target.value })}
            />
            <Input
              label="Description"
              value={draft.description}
              placeholder="Optional — one line for the table"
              onChange={(event) => patch({ description: event.target.value })}
            />
          </div>
          <Textarea
            label="Prompt"
            required
            rows={3}
            value={draft.prompt}
            placeholder="Summarise anything that arrived overnight and needs a reply."
            hint="Handed to the engine verbatim when the job fires."
            onChange={(event) => patch({ prompt: event.target.value })}
          />
        </section>

        {/* ---- when ------------------------------------------------- */}
        <section className="space-y-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <p className={eyebrow}>When it fires</p>
          <div className="grid grid-cols-[1fr_14rem] gap-3">
            <Input
              label="Cron expression"
              required
              value={draft.cron}
              spellCheck={false}
              placeholder="0 9 * * 1-5"
              inputClassName="font-mono"
              onChange={(event) => patch({ cron: event.target.value })}
            />
            <Input
              label="Timezone"
              value={draft.timezone}
              spellCheck={false}
              onChange={(event) => patch({ timezone: event.target.value })}
            />
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className={cn('mr-1 text-[11px]', textMuted)}>Presets</span>
            {PRESETS.map((preset) => (
              <Button
                key={preset.cron}
                size="xs"
                variant={draft.cron === preset.cron ? 'secondary' : 'outline'}
                onClick={() => patch({ cron: preset.cron })}
              >
                {preset.label}
              </Button>
            ))}
          </div>

          <CronEcho
            tone={echo.tone}
            title={echo.title}
            body={echo.body}
            cron={draft.cron.trim()}
            nextRuns={nextRuns}
          />
        </section>

        {/* ---- the gate --------------------------------------------- */}
        <section className="space-y-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <div>
            <p className={eyebrow}>Only run when</p>
            <p className={cn('mt-1 text-[12px] leading-relaxed', textMuted)}>
              Checked before anything is spawned. This is what keeps a recurring
              job from spending a weekly quota on occurrences with nothing to
              do.
            </p>
          </div>

          <Select
            label="Condition"
            value={draft.conditionKind}
            options={CONDITION_OPTIONS}
            hint={conditionRationale}
            onChange={(event) =>
              patch({
                conditionKind: event.target.value as ScheduleConditionKind,
              })
            }
          />

          {draft.conditionKind === 'always' ? (
            <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12.5px] leading-relaxed text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
              <AlertTriangle
                size={14}
                className="mt-0.5 shrink-0"
                aria-hidden="true"
              />
              <span>
                No gate. Every occurrence spawns the engine, whether or not
                there is anything to do — a 15-minute unconditional job is
                roughly 2,900 runs a month.
              </span>
            </p>
          ) : null}

          {draft.conditionKind === 'file-changed' ? (
            <Input
              label="File to watch"
              required
              spellCheck={false}
              value={draft.filePath}
              placeholder="~/.assistant/memory/inbox.md"
              hint="Absolute, or relative to the workspace root. Compared by mtime."
              inputClassName="font-mono"
              onChange={(event) => patch({ filePath: event.target.value })}
            />
          ) : null}

          {draft.conditionKind === 'counter-changed' ? (
            <Input
              label="Counter source"
              required
              spellCheck={false}
              value={draft.counterSource}
              placeholder="mail:unread"
              hint="An opaque source key. The job runs when its value differs from the last one seen."
              inputClassName="font-mono"
              onChange={(event) => patch({ counterSource: event.target.value })}
            />
          ) : null}

          {draft.conditionKind === 'time-window' ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="From (hour)"
                  type="number"
                  min={0}
                  max={23}
                  value={String(draft.startHour)}
                  onChange={(event) =>
                    patch({ startHour: Number(event.target.value) || 0 })
                  }
                />
                <Input
                  label="To (hour, exclusive)"
                  type="number"
                  min={0}
                  max={24}
                  value={String(draft.endHour)}
                  onChange={(event) =>
                    patch({ endHour: Number(event.target.value) || 0 })
                  }
                />
              </div>
              <Field label="Weekdays" hint="None selected means every day.">
                <div className="flex flex-wrap gap-1">
                  {WEEKDAYS.map((day) => {
                    const on = draft.weekdays.includes(day.value);
                    return (
                      <Button
                        key={day.value}
                        size="xs"
                        variant={on ? 'primary' : 'outline'}
                        aria-pressed={on}
                        onClick={() =>
                          patch({
                            weekdays: on
                              ? draft.weekdays.filter((d) => d !== day.value)
                              : [...draft.weekdays, day.value],
                          })
                        }
                      >
                        {day.label}
                      </Button>
                    );
                  })}
                </div>
              </Field>
            </div>
          ) : null}

          <Select
            label="If an occurrence is missed"
            value={draft.missedRunPolicy}
            options={MISSED_RUN_POLICIES.map((policy) => ({
              value: policy,
              label: MISSED_RUN_POLICY_LABEL[policy],
            }))}
            hint={MISSED_RUN_POLICY_HINT[draft.missedRunPolicy]}
            onChange={(event) =>
              patch({ missedRunPolicy: event.target.value as MissedRunPolicy })
            }
          />
        </section>

        {/* ---- limits ------------------------------------------------ */}
        <section className="space-y-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <div>
            <p className={eyebrow}>Limits</p>
            <p className={cn('mt-1 text-[12px] leading-relaxed', textMuted)}>
              Set on every step — cheaper than building loop detection.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Input
              label="Engine"
              value={draft.engine}
              placeholder="default"
              onChange={(event) => patch({ engine: event.target.value })}
            />
            <Input
              label="Max turns"
              type="number"
              min={1}
              value={draft.maxTurns}
              placeholder="—"
              onChange={(event) => patch({ maxTurns: event.target.value })}
            />
            <Input
              label="Max cost (USD)"
              type="number"
              min={0}
              step="0.01"
              value={draft.maxCostUsd}
              placeholder="—"
              onChange={(event) => patch({ maxCostUsd: event.target.value })}
            />
          </div>
          <Input
            label="Allowed tools"
            value={draft.allowedTools}
            spellCheck={false}
            placeholder="memory_search, mail_list"
            hint="Comma separated. Empty means the engine's default set for a scheduled step."
            onChange={(event) => patch({ allowedTools: event.target.value })}
          />
          <Switch
            layout="row"
            checked={draft.enabled}
            onChange={(checked) => patch({ enabled: checked })}
            label="Enabled"
            description="A disabled job keeps its history and its next-run time but never fires."
          />
        </section>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* The echo                                                            */
/* ------------------------------------------------------------------ */

const ECHO_STYLE = {
  idle: 'border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/60',
  valid:
    'border-emerald-300 bg-emerald-50/70 dark:border-emerald-500/40 dark:bg-emerald-500/10',
  invalid:
    'border-rose-300 bg-rose-50 dark:border-rose-500/40 dark:bg-rose-500/10',
  unverified:
    'border-amber-300 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-500/10',
} as const;

const ECHO_ICON = {
  idle: Clock3,
  valid: CalendarCheck,
  invalid: AlertTriangle,
  unverified: PlugZap,
} as const;

const ECHO_ICON_TONE = {
  idle: 'text-zinc-400 dark:text-zinc-500',
  valid: 'text-emerald-600 dark:text-emerald-400',
  invalid: 'text-rose-600 dark:text-rose-400',
  unverified: 'text-amber-600 dark:text-amber-400',
} as const;

/**
 * The confirmation surface: the backend's own English rendering of the
 * expression, plus the next few occurrences it computed. Never generated here.
 */
function CronEcho({
  tone,
  title,
  body,
  cron,
  nextRuns,
}: {
  tone: keyof typeof ECHO_STYLE;
  title: string;
  body: string;
  cron: string;
  nextRuns: readonly string[];
}) {
  const Icon = ECHO_ICON[tone];
  return (
    <div className={cn('rounded-lg border px-3 py-2.5', ECHO_STYLE[tone])}>
      <div className="flex gap-2.5">
        <Icon
          size={15}
          aria-hidden="true"
          className={cn('mt-0.5 shrink-0', ECHO_ICON_TONE[tone])}
        />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">
            {title}
          </p>
          {body ? (
            <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-400">
              {body}
            </p>
          ) : null}
          {tone === 'valid' && cron ? (
            <p className={cn('mt-1 text-[11px]', mono, textMuted)}>{cron}</p>
          ) : null}
          {nextRuns.length > 0 ? (
            <div className="mt-2">
              <p className={cn('mb-0.5', eyebrow)}>Next occurrences</p>
              <ul className="space-y-0.5">
                {nextRuns.slice(0, 5).map((iso) => (
                  <li
                    key={iso}
                    className="text-[11.5px] tabular-nums text-zinc-600 dark:text-zinc-400"
                  >
                    {formatDateTime(iso)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default JobDialog;
