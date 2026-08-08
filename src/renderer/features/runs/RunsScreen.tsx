/**
 * `/runs` and everything under it.
 *
 * The route is a splat, so this file owns its own routing: the list pane is
 * always mounted and the nested `<Routes>` swaps only the right-hand pane
 * between "nothing selected" and `/runs/:runId`. Keeping the list outside the
 * nested router is deliberate — switching runs must not reset the history
 * pane's scroll position, filter or search.
 *
 * Layout is a fixed two-pane desktop split with independently scrolling
 * halves, not a page that scrolls as one. A run timeline is thousands of rows
 * long; the history beside it should not move when you scroll it.
 */
import { useCallback, useMemo, useState } from 'react';
import {
  Navigate,
  Route,
  Routes,
  useMatch,
  useNavigate,
} from 'react-router-dom';
import { Activity, ListTree, Plug, Plus } from 'lucide-react';
import type { Run } from '../../../shared/runs';
import { ROUTES } from '../../routes';
import { cn } from '../../lib/utils';
import { formatRelative, pluralize } from '../../lib/format';
import { runStatusMeta } from '../../lib/status';
import { TONE_TEXT } from '../../lib/tone';
import { PageHeader } from '../../components/layout/PageHeader';
import {
  Button,
  EmptyState,
  StatusDot,
  eyebrow,
  focusRingInset,
  textMuted,
} from '../../components/ui';
import {
  useFailedRuns,
  useLiveRuns,
  useRunList,
  useRunsStore,
  useWaitingRuns,
} from '../../store';
import { RunList } from './RunList';
import { RunDetail } from './RunDetail';
import { RunComposer } from './RunComposer';
import { SpendSummary } from './CostMeter';
import { useNow } from './useRunStream';

type ComposerSeed = {
  prompt: string;
  title?: string;
  engine?: string;
  cwd?: string;
};

export function RunsScreen() {
  const navigate = useNavigate();
  const match = useMatch(`${ROUTES.runs}/:runId`);
  const selectedRunId = match?.params.runId ?? null;

  const runs = useRunList();
  const live = useLiveRuns();
  const total = useRunsStore((state) => state.total);

  // Relative timestamps go stale silently; a slow tick keeps the list honest
  // without putting a per-second render on a screen that may show 200 rows.
  const now = useNow(true, 30_000);

  const [composerOpen, setComposerOpen] = useState(false);
  const [seed, setSeed] = useState<ComposerSeed | undefined>(undefined);

  const spent = useMemo(
    () => runs.reduce((sum, run) => sum + (run.usage?.totalCostUsd ?? 0), 0),
    [runs],
  );

  const openComposer = useCallback((next?: ComposerSeed) => {
    setSeed(next);
    setComposerOpen(true);
  }, []);

  const rerun = useCallback(
    (run: Run) => {
      openComposer({
        prompt: run.prompt || run.title,
        title: run.title,
        engine: run.engine,
        cwd: run.cwd,
      });
    },
    [openComposer],
  );

  const select = useCallback(
    (id: string) => navigate(`${ROUTES.runs}/${id}`),
    [navigate],
  );

  const description =
    live.length > 0
      ? `${pluralize(live.length, 'run')} in flight · ${total || runs.length} in history`
      : 'Everything the assistant has done, step by step.';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Runs"
        description={description}
        sticky={false}
        actions={
          <>
            <SpendSummary runs={runs} />
            <Button
              size="sm"
              variant="primary"
              icon={Plus}
              onClick={() => openComposer(undefined)}
            >
              New run
            </Button>
          </>
        }
      />

      <div className="flex min-h-0 flex-1">
        <RunList
          className="w-[23rem] shrink-0 border-r border-zinc-200 dark:border-zinc-800"
          selectedRunId={selectedRunId}
          onSelect={select}
          onRerun={rerun}
          onStartFirst={() => openComposer(undefined)}
          now={now}
        />

        <div className="min-w-0 flex-1">
          <Routes>
            <Route
              index
              element={
                <NoRunSelected
                  onSelect={select}
                  onStart={() => openComposer(undefined)}
                  now={now}
                />
              }
            />
            <Route path=":runId" element={<RunDetail onRerun={rerun} />} />
            <Route path="*" element={<Navigate to={ROUTES.runs} replace />} />
          </Routes>
        </div>
      </div>

      <RunComposer
        open={composerOpen}
        seed={seed}
        spentUsd={spent}
        onClose={() => setComposerOpen(false)}
        onStarted={(run) => navigate(`${ROUTES.runs}/${run.id}`)}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Right pane, with nothing selected                                   */
/* ------------------------------------------------------------------ */

interface NoRunSelectedProps {
  onSelect: (id: string) => void;
  onStart: () => void;
  now: number;
}

/**
 * Not a blank panel. With no selection the pane still answers "is anything
 * happening, is anything stuck, did anything break" and offers the one action
 * worth having here.
 */
function NoRunSelected({ onSelect, onStart, now }: NoRunSelectedProps) {
  const live = useLiveRuns();
  const waiting = useWaitingRuns();
  const failed = useFailedRuns(3);
  const unavailable = useRunsStore((state) => state.unavailable);
  const anyRuns = useRunsStore((state) => state.order.length > 0);

  if (unavailable && !anyRuns) {
    return (
      <EmptyState
        icon={Plug}
        title="Not connected to the backend"
        description="The main process has not answered yet, so there is no history to show. Everything on this screen works the moment it does."
        action={
          <Button variant="primary" icon={Activity} onClick={onStart}>
            Write a run anyway
          </Button>
        }
      />
    );
  }

  if (!anyRuns) {
    return (
      <EmptyState
        icon={ListTree}
        title="Nothing has run yet"
        description="A run is a sequence of steps, each with its own tool calls, duration and cost. Start one and it unfolds here as it happens — not behind a spinner."
        action={
          <Button variant="primary" icon={Activity} onClick={onStart}>
            Start the first run
          </Button>
        }
      />
    );
  }

  const groups = [
    { label: 'Waiting on you', runs: waiting },
    { label: 'In flight', runs: live.filter((run) => !waiting.includes(run)) },
    { label: 'Recently failed', runs: failed },
  ].filter((group) => group.runs.length > 0);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 px-6 py-10">
      <EmptyState
        icon={ListTree}
        title="Select a run"
        description="Pick anything on the left to see its steps, tool calls, timings and cost."
        size="sm"
        action={
          <Button variant="outline" icon={Plus} onClick={onStart}>
            New run
          </Button>
        }
      />

      {groups.length > 0 ? (
        <div className="w-full max-w-md space-y-4">
          {groups.map((group) => (
            <div key={group.label}>
              <p className={cn('mb-1', eyebrow)}>{group.label}</p>
              <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
                {group.runs.map((run) => {
                  const meta = runStatusMeta(run.status);
                  return (
                    <button
                      key={run.id}
                      type="button"
                      onClick={() => onSelect(run.id)}
                      className={cn(
                        'flex w-full items-center gap-2 border-b border-zinc-100 px-3 py-2 text-left last:border-b-0 dark:border-zinc-800/70',
                        'hover:bg-zinc-50 dark:hover:bg-zinc-900/60',
                        focusRingInset,
                      )}
                    >
                      <StatusDot
                        tone={meta.tone}
                        pulse={meta.active}
                        label={meta.label}
                      />
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-zinc-800 dark:text-zinc-200">
                        {run.title}
                      </span>
                      <span
                        className={cn(
                          'shrink-0 text-[11px]',
                          TONE_TEXT[meta.tone],
                        )}
                      >
                        {meta.label}
                      </span>
                      <span className={cn('shrink-0 text-[11px]', textMuted)}>
                        {formatRelative(run.createdAt, now)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default RunsScreen;
