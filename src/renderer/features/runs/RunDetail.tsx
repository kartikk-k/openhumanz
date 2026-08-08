/**
 * One run, in full: header, why it ended, what it cost, and the timeline.
 *
 * The header answers the four questions someone opens a run to ask — what was
 * it, how did it end, how long did it take, what did it cost — before any
 * scrolling happens. Everything below is detail.
 */
import { useCallback, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  CircleStop,
  Plug,
  RefreshCw,
  RotateCcw,
  SearchX,
  ShieldCheck,
} from 'lucide-react';
import type { Run } from '../../../shared/runs';
import { ROUTES } from '../../routes';
import { cn } from '../../lib/utils';
import { runStatusMeta } from '../../lib/status';
import {
  formatCost,
  formatDateTime,
  formatDuration,
  truncate,
} from '../../lib/format';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Spinner,
  mono,
  textMuted,
} from '../../components/ui';
import {
  toast,
  usePendingApprovalsForRun,
  useRunsStore,
} from '../../store';
import { FailureNotice } from './FailureNotice';
import { explainFailure } from './failures';
import { RunCostMeter } from './CostMeter';
import { RunTimeline } from './RunTimeline';
import { useRunStream } from './useRunStream';
import { elapsedMs } from './timeline';

/**
 * Long enough that cancelling might throw away real work, or it has already
 * cost money. Below this, a confirm dialog is just friction.
 */
function isLongRunning(run: Run, elapsed: number | undefined): boolean {
  if ((run.usage?.totalCostUsd ?? 0) > 0) return true;
  return (elapsed ?? 0) >= 30_000;
}

export interface RunDetailProps {
  /** Opens the composer seeded from this run. */
  onRerun: (run: Run) => void;
}

/** Route element for `/runs/:runId`. */
export function RunDetail({ onRerun }: RunDetailProps) {
  const { runId = null } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const cancelRun = useRunsStore((state) => state.cancelRun);

  const stream = useRunStream(runId);
  const { run, model, gaps, live, now, failureKind, failureDetail } = stream;

  const approvals = usePendingApprovalsForRun(runId);
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const elapsed = useMemo(
    () =>
      run
        ? elapsedMs(run.startedAt ?? run.createdAt, run.finishedAt, now)
        : undefined,
    [run, now],
  );

  const doCancel = useCallback(async () => {
    if (!run) return;
    setCancelling(true);
    const ok = await cancelRun(run.id);
    setCancelling(false);
    setConfirming(false);
    if (ok) {
      toast.success('Cancelling the run', { description: run.title });
    } else {
      toast.error('Could not cancel the run', {
        description: useRunsStore.getState().error ?? undefined,
      });
    }
  }, [run, cancelRun]);

  const requestCancel = useCallback(() => {
    if (!run) return;
    if (isLongRunning(run, elapsed)) {
      setConfirming(true);
      return;
    }
    void doCancel();
  }, [run, elapsed, doCancel]);

  /* --- nothing to show -------------------------------------------- */

  if (!run) {
    if (stream.loading) {
      return (
        <div className="flex h-full items-center justify-center">
          <Spinner size="md" label="Loading run" />
        </div>
      );
    }
    if (stream.unavailable) {
      return (
        <EmptyState
          icon={Plug}
          title="Not connected to the backend"
          description="This run lives in the main process, which has not answered yet. The timeline appears as soon as it does — nothing here is lost."
          action={
            <Button
              variant="outline"
              icon={RefreshCw}
              onClick={() => {
                void stream.reload();
              }}
            >
              Try again
            </Button>
          }
          footer={stream.error?.message}
        />
      );
    }
    return (
      <EmptyState
        icon={SearchX}
        title="Run not found"
        description={
          stream.error?.message ??
          'This run is not in the history. It may have been pruned, or the id is stale.'
        }
        action={
          <Button variant="outline" onClick={() => navigate(ROUTES.runs)}>
            Back to all runs
          </Button>
        }
      />
    );
  }

  const meta = runStatusMeta(run.status);
  const ended = run.status === 'failed' || run.status === 'cancelled';
  const explanation = ended ? explainFailure(failureKind) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* --- header ------------------------------------------------ */}
      <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Badge tone={meta.tone} variant="soft" icon={meta.icon}>
                {meta.label}
              </Badge>
              <h2 className="min-w-0 truncate text-[15px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
                {run.title}
              </h2>
            </div>
            <p
              className={cn(
                'mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px]',
                textMuted,
              )}
            >
              <span className={mono}>{run.engine}</span>
              <span aria-hidden="true">·</span>
              <span>{run.trigger}</span>
              <span aria-hidden="true">·</span>
              <span>started {formatDateTime(run.startedAt ?? run.createdAt)}</span>
              {run.finishedAt ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    finished {formatDateTime(run.finishedAt)} in{' '}
                    {formatDuration(run.durationMs ?? elapsed)}
                  </span>
                </>
              ) : null}
              {run.cwd ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span className={mono} title={run.cwd}>
                    {truncate(run.cwd, 40)}
                  </span>
                </>
              ) : null}
              {run.sessionId ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span className={mono} title={run.sessionId}>
                    session {truncate(run.sessionId, 12)}
                  </span>
                </>
              ) : null}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              icon={RefreshCw}
              title="Reload the transcript"
              aria-label="Reload the transcript"
              onClick={() => {
                void stream.reload();
              }}
            />
            <Button
              size="sm"
              variant="outline"
              icon={RotateCcw}
              onClick={() => onRerun(run)}
            >
              Re-run
            </Button>
            {live ? (
              <Button
                size="sm"
                variant="destructive"
                icon={CircleStop}
                loading={cancelling}
                onClick={requestCancel}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </div>

        {/* --- why it ended, then what it cost ---------------------- */}
        <div className="mt-3 space-y-2.5">
          {ended ? (
            <FailureNotice
              kind={failureKind}
              detail={failureDetail}
              actions={
                <Button
                  size="sm"
                  variant={explanation?.retryPointless ? 'outline' : 'primary'}
                  icon={RotateCcw}
                  onClick={() => onRerun(run)}
                >
                  {explanation?.retryPointless ? 'Re-run anyway' : 'Re-run'}
                </Button>
              }
            />
          ) : null}

          {approvals.length > 0 ? (
            <div className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-500/40 dark:bg-amber-500/10">
              <ShieldCheck
                size={15}
                aria-hidden="true"
                className="shrink-0 text-amber-600 dark:text-amber-400"
              />
              <p className="min-w-0 flex-1 text-[12.5px] text-zinc-800 dark:text-zinc-200">
                <span className="font-medium">
                  {approvals.length} action{approvals.length === 1 ? '' : 's'}{' '}
                  waiting on you.
                </span>{' '}
                The run is paused until you decide.
              </p>
              <Button
                size="xs"
                variant="outline"
                onClick={() => navigate(ROUTES.approvals)}
              >
                Review
              </Button>
            </div>
          ) : null}

          <RunCostMeter
            usage={model.usage}
            derived={model.usageIsDerived}
            elapsedMs={elapsed}
          />
        </div>
      </div>

      {/* --- the timeline ------------------------------------------ */}
      <RunTimeline
        key={run.id}
        model={model}
        gaps={gaps}
        now={now}
        live={live}
        onReload={() => {
          void stream.reload();
        }}
      />

      <ConfirmDialog
        open={confirming}
        tone="danger"
        title="Cancel this run?"
        description="The engine is stopped and its process tree is killed. Work already finished is kept; nothing further is started."
        confirmLabel="Cancel the run"
        cancelLabel="Keep running"
        onConfirm={doCancel}
        onCancel={() => setConfirming(false)}
      >
        <p className={cn('text-[12.5px]', textMuted)}>
          Running for {formatDuration(elapsed)}
          {model.usage?.totalCostUsd !== undefined
            ? ` · ${formatCost(model.usage.totalCostUsd)} spent so far`
            : ''}
          .
        </p>
      </ConfirmDialog>
    </div>
  );
}

export default RunDetail;
