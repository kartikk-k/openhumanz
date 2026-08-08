/**
 * Start a run.
 *
 * Limits are part of the composer rather than buried in settings, because
 * ARCHITECTURE.md is explicit that turn and budget limits go on **every** step
 * — cheaper than loop detection — and because the moment someone is about to
 * start something long is the moment the ceiling is worth seeing. The dialog
 * shows current spend next to the box you type the prompt into.
 *
 * The backend may not be wired up: the composer says so up front instead of
 * letting the user write three paragraphs and then fail.
 */
import { useEffect, useMemo, useState } from 'react';
import { CirclePlay, Coins, TriangleAlert } from 'lucide-react';
import type { Run } from '../../../shared/runs';
import { cn } from '../../lib/utils';
import { formatCost } from '../../lib/format';
import { isBridgeAvailable } from '../../lib/ipc';
import {
  Button,
  Dialog,
  Input,
  Select,
  Textarea,
  textMuted,
} from '../../components/ui';
import {
  useEnvironment,
  useRunsStore,
  useSettingsStore,
  toast,
} from '../../store';
import { useCostCeiling, useShowCosts } from './CostMeter';

/** First line of the prompt, clipped — the run's default title. */
function deriveTitle(prompt: string): string {
  const line = prompt.trim().split('\n')[0]?.trim() ?? '';
  if (line.length === 0) return 'Untitled run';
  return line.length > 70 ? `${line.slice(0, 69)}…` : line;
}

/** Parse a numeric field, treating blank and nonsense as "not set". */
function readNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export interface RunComposerProps {
  open: boolean;
  onClose: () => void;
  /** Seed the form — used by "re-run" from a history row. */
  seed?: { prompt: string; title?: string; engine?: string; cwd?: string };
  /** Called after `runs:start` resolves, so the caller can navigate to it. */
  onStarted: (run: Run) => void;
  /** Spend so far, for the headroom line. */
  spentUsd?: number;
}

export function RunComposer({
  open,
  onClose,
  seed,
  onStarted,
  spentUsd,
}: RunComposerProps) {
  const settings = useSettingsStore((state) => state.settings);
  const environment = useEnvironment();
  const startRun = useRunsStore((state) => state.startRun);
  const ceiling = useCostCeiling();
  const showCosts = useShowCosts();

  const [prompt, setPrompt] = useState('');
  const [engine, setEngine] = useState('');
  const [cwd, setCwd] = useState('');
  const [maxTurns, setMaxTurns] = useState('');
  const [maxCost, setMaxCost] = useState('');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Re-seed every time the dialog opens; a stale draft from last time is worse
  // than an empty box.
  useEffect(() => {
    if (!open) return;
    setPrompt(seed?.prompt ?? '');
    setEngine(seed?.engine ?? settings.engine.preferred);
    setCwd(seed?.cwd ?? settings.engine.defaultCwd);
    setMaxTurns(String(settings.engine.maxTurnsPerStep));
    setMaxCost(ceiling > 0 ? String(ceiling) : '');
    setFailure(null);
    setPending(false);
  }, [open, seed, settings.engine, ceiling]);

  const engineOptions = useMemo(() => {
    const detected = environment?.engines ?? [];
    if (detected.length > 0) {
      return detected.map((info) => ({
        value: info.id,
        label: info.available
          ? `${info.name}${info.version ? ` ${info.version}` : ''}`
          : `${info.name} — unavailable`,
      }));
    }
    return [
      {
        value: settings.engine.preferred,
        label: `${settings.engine.preferred} (not detected)`,
      },
    ];
  }, [environment, settings.engine.preferred]);

  const selected = environment?.engines.find((info) => info.id === engine);
  const bridge = isBridgeAvailable();
  const canSubmit = prompt.trim().length > 0 && !pending;

  const submit = async () => {
    if (!canSubmit) return;
    setPending(true);
    setFailure(null);

    const run = await startRun({
      title: seed?.title ?? deriveTitle(prompt),
      prompt: prompt.trim(),
      engine: engine || undefined,
      trigger: 'manual',
      cwd: cwd.trim() || undefined,
      maxTurns: readNumber(maxTurns),
      maxCostUsd: readNumber(maxCost),
    });

    setPending(false);

    if (!run) {
      const message =
        useRunsStore.getState().error ?? 'The run could not be started.';
      setFailure(message);
      return;
    }

    toast.success('Run started', { description: run.title });
    onStarted(run);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={pending ? () => {} : onClose}
      size="lg"
      title="Start a run"
      description="One prompt. The app owns the step boundary; limits apply to every step."
      footer={
        <>
          <div className="mr-auto flex items-center gap-1.5">
            {showCosts ? (
              <>
                <Coins size={12} aria-hidden="true" className="text-zinc-400" />
                <span className={cn('text-[11px] tabular-nums', textMuted)}>
                  {formatCost(spentUsd ?? 0)} spent so far
                  {ceiling > 0 ? ` · ${formatCost(ceiling)} cap per run` : ''}
                </span>
              </>
            ) : null}
          </div>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={CirclePlay}
            onClick={() => {
              void submit();
            }}
            loading={pending}
            disabled={!canSubmit}
          >
            Start run
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {!bridge ? (
          <Notice
            title="The app is not connected to its backend"
            body="Runs cannot start until the main process is wired up. You can still write the prompt — starting it will report the same error."
          />
        ) : null}

        {bridge && selected && !selected.available ? (
          <Notice
            title={`${selected.name} is not available`}
            body={
              selected.reason ??
              'The engine binary was not found on this machine.'
            }
          />
        ) : null}

        {failure ? (
          <Notice title="Could not start the run" body={failure} />
        ) : null}

        <Textarea
          label="Prompt"
          hint="What should the assistant do? The first line becomes the run title."
          rows={7}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Summarise everything unread from this week and draft replies to anything from the design team."
        />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select
            label="Engine"
            size="sm"
            options={engineOptions}
            value={engine}
            onChange={(event) => setEngine(event.target.value)}
          />
          <Input
            label="Working directory"
            size="sm"
            hint="Blank uses the workspace root."
            value={cwd}
            onChange={(event) => setCwd(event.target.value)}
            placeholder="~/.assistant"
          />
          <Input
            label="Max turns per step"
            size="sm"
            type="number"
            min={1}
            value={maxTurns}
            onChange={(event) => setMaxTurns(event.target.value)}
          />
          <Input
            label="Cost ceiling for this run"
            size="sm"
            type="number"
            min={0}
            step="0.5"
            hint="Blank means no ceiling for this run."
            value={maxCost}
            onChange={(event) => setMaxCost(event.target.value)}
            trailing={<span className="text-[11px] text-zinc-400">USD</span>}
          />
        </div>
      </div>
    </Dialog>
  );
}

/** Amber, not red: "not wired up yet" is a state, not a crash. */
function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-500/40 dark:bg-amber-500/10">
      <TriangleAlert
        size={14}
        aria-hidden="true"
        className="mt-[2px] shrink-0 text-amber-600 dark:text-amber-400"
      />
      <div className="min-w-0">
        <p className="text-[12.5px] font-medium text-zinc-900 dark:text-zinc-100">
          {title}
        </p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-700 dark:text-zinc-300">
          {body}
        </p>
      </div>
    </div>
  );
}

export default RunComposer;
