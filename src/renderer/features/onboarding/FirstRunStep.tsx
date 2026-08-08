/**
 * Step 5 — end on proof.
 *
 * Everything before this was configuration, which is a promise. This step
 * spends one real invocation of the CLI and shows what came back, so the last
 * thing the user sees during setup is the product working rather than a claim
 * that it will.
 *
 * The default prompt is deliberately read-only: it proves the spawn, the
 * streaming result and the MCP tool surface without tripping the approval gate
 * on the very first run, which would end onboarding on a modal instead of an
 * answer.
 */
import { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  CircleSlash,
  ExternalLink,
  Play,
  Square,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { Run } from '../../../shared/runs';
import { TERMINAL_RUN_STATUSES } from '../../../shared/runs';
import { ROUTES } from '../../routes';
import { cn } from '../../lib/utils';
import { formatCost, formatDuration } from '../../lib/format';
import { isBridgeAvailable } from '../../lib/ipc';
import { runStatusMeta } from '../../lib/status';
import { Badge, Button, Spinner, Textarea } from '../../components/ui';
import { textMuted, textSubtle } from '../../components/ui/styles';
import {
  useEnvironmentStore,
  usePreferredEngine,
  useRunsStore,
  useSettingsStore,
} from '../../store';
import { Notice } from '../settings/Notice';

const DEFAULT_PROMPT =
  'Say hello in one sentence, then list the assistant tools you can see. Do not create, change or delete anything.';

export interface FirstRunStepProps {
  /** Called the first time a run reaches a successful terminal state. */
  onSucceeded?: () => void;
}

export function FirstRunStep({ onSucceeded }: FirstRunStepProps) {
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [runId, setRunId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [reported, setReported] = useState(false);
  const onSucceededRef = useRef(onSucceeded);
  onSucceededRef.current = onSucceeded;

  const startRun = useRunsStore((state) => state.startRun);
  const cancelRun = useRunsStore((state) => state.cancelRun);
  const watchRun = useRunsStore((state) => state.watchRun);
  const run: Run | undefined = useRunsStore((state) =>
    runId ? state.runs[runId] : undefined,
  );

  const preferredId = useSettingsStore(
    (state) => state.settings.engine.preferred,
  );
  const environment = useEnvironmentStore((state) => state.environment);
  const engine = usePreferredEngine(preferredId);

  const bridge = isBridgeAvailable();
  const engineKnown = environment !== null;
  const engineUsable = engine?.available === true;

  const finished = run ? TERMINAL_RUN_STATUSES.includes(run.status) : false;
  const succeeded = run?.status === 'succeeded';
  const live = run !== undefined && !finished;

  useEffect(() => {
    if (!succeeded || reported) return;
    setReported(true);
    onSucceededRef.current?.();
  }, [succeeded, reported]);

  const start = async () => {
    setStarting(true);
    setStartError(null);
    const started = await startRun({
      title: 'First run',
      prompt,
      trigger: 'manual',
    });
    setStarting(false);
    if (!started) {
      setStartError(
        useRunsStore.getState().error ??
          'The run could not be started and the app did not say why.',
      );
      return;
    }
    setRunId(started.id);
    void watchRun(started.id);
  };

  /* ---- why the button might be off ---- */
  let blocked: string | null = null;
  if (!bridge) {
    blocked =
      'This window is not attached to the desktop app, so nothing can be spawned from here.';
  } else if (!engineKnown) {
    blocked =
      'Engine detection has not answered yet, so there is nothing to spawn. That is a gap in the app, not a missing CLI — go back a step and re-check.';
  } else if (!engineUsable) {
    blocked = `No usable agent CLI was found${
      engine?.reason ? ` (${engine.reason})` : ''
    }, so there is nothing to run the task with.`;
  }

  const meta = run ? runStatusMeta(run.status) : null;

  return (
    <>
      <Textarea
        id="onboarding-first-prompt"
        label="What should it do?"
        hint="Read-only on purpose. Anything with a side effect would stop at an approval card, and a modal is a poor last impression."
        rows={3}
        value={prompt}
        disabled={live || starting}
        onChange={(event) => setPrompt(event.target.value)}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          icon={Play}
          loading={starting}
          disabled={blocked !== null || live || prompt.trim().length === 0}
          onClick={() => {
            void start();
          }}
        >
          {run ? 'Run it again' : 'Run it'}
        </Button>
        {live && runId ? (
          <Button
            variant="ghost"
            icon={Square}
            onClick={() => {
              void cancelRun(runId);
            }}
          >
            Stop
          </Button>
        ) : null}
        {runId ? (
          <Button
            variant="ghost"
            icon={ExternalLink}
            onClick={() => navigate(`${ROUTES.runs}/${runId}`)}
          >
            Open the timeline
          </Button>
        ) : null}
      </div>

      {blocked ? (
        <Notice
          tone="warning"
          size="compact"
          icon={CircleSlash}
          title="Nothing to run this with yet"
        >
          <p>{blocked}</p>
          <p>
            You can finish setup anyway — everything else is already saved, and
            this screen is the only part that needs a working CLI.
          </p>
        </Notice>
      ) : null}

      {startError ? (
        <Notice
          tone="danger"
          size="compact"
          icon={CircleSlash}
          title="The run did not start"
          detail={startError}
          detailLabel="app said"
        >
          <p>
            Nothing was spawned, so nothing was spent. Your settings are already
            saved.
          </p>
        </Notice>
      ) : null}

      {run ? (
        <div
          className={cn(
            'rounded-lg border px-4 py-3',
            succeeded
              ? 'border-emerald-200 bg-emerald-50/70 dark:border-emerald-500/30 dark:bg-emerald-500/10'
              : 'border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/60',
          )}
        >
          <div className="flex flex-wrap items-center gap-2">
            {live ? <Spinner size="xs" label={null} /> : null}
            {succeeded ? (
              <CheckCircle2
                size={16}
                aria-hidden="true"
                className="text-emerald-600 dark:text-emerald-400"
              />
            ) : null}
            <span className="text-[13px] font-medium text-zinc-900 dark:text-zinc-100">
              {succeeded ? 'It works.' : run.title}
            </span>
            {meta ? (
              <Badge tone={meta.tone} size="sm">
                {meta.label}
              </Badge>
            ) : null}
            <span className={cn('text-[12px]', textMuted)}>
              {run.engine}
              {run.durationMs ? ` · ${formatDuration(run.durationMs)}` : ''}
              {run.usage?.totalCostUsd
                ? ` · ${formatCost(run.usage.totalCostUsd)}`
                : ''}
            </span>
          </div>

          {succeeded ? (
            <p
              className={cn('mt-1.5 text-[12.5px] leading-relaxed', textSubtle)}
            >
              That was a real invocation of your CLI, orchestrated by this app,
              recorded step by step. The full transcript is on the run timeline
              and the raw JSONL is in your workspace folder.
            </p>
          ) : null}

          {run.error ? (
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-rose-700 dark:text-rose-400">
              {run.error}
            </p>
          ) : null}

          {live ? (
            <p className={cn('mt-1.5 text-[12.5px]', textMuted)}>
              Running. You can leave this screen — it keeps going and it will be
              waiting on the Runs page.
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export default FirstRunStep;
