/**
 * Everything the detail pane needs to render one run, live.
 *
 * Three sources are folded together here so no component has to know the
 * difference between them:
 *
 *  - `runs:get` — the stored `RunDetail`. Authoritative for a finished run and
 *    for anything that scrolled out of the in-memory event buffer.
 *  - the store's event buffer — what has streamed in since we started watching.
 *  - the store's `runs` record — the list row, which the push channel keeps in
 *    step with the run's status without a round trip.
 *
 * Holes in the stream are treated as a fact to be reported, not smoothed over:
 * {@link findSeqGaps} drives one backfill attempt per distinct gap signature,
 * and the gap list stays visible until it actually closes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IPC } from '../../../shared/ipc';
import type { Run, RunDetail } from '../../../shared/runs';
import { useQuery, type IpcError } from '../../lib/ipc';
import {
  findSeqGaps,
  isRunLive,
  useRunEvents,
  useRunsStore,
} from '../../store';
import { buildTimeline, effectiveRun, type TimelineModel } from './timeline';
import { readFailureKind, type FailureKind } from './failures';

/**
 * A clock that only ticks while something is actually moving.
 *
 * Running steps show live elapsed time; a finished run must not re-render once
 * a second forever.
 */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);

  return now;
}

export interface RunStream {
  /** The run as the header should show it: stored row patched by the stream. */
  run: Run | undefined;
  detail: RunDetail | null;
  model: TimelineModel;
  /** `seq` values the buffer never saw. Empty is the happy path. */
  gaps: number[];
  /** Classified failure, read defensively from the field or from metadata. */
  failureKind: FailureKind | undefined;
  /** Verbatim error from the stream or the stored row. */
  failureDetail: string | undefined;
  live: boolean;
  /** Ticking wall clock while the run is live; frozen otherwise. */
  now: number;
  /** True only before the first answer for this run arrives. */
  loading: boolean;
  error: IpcError | null;
  /** The failure is "main has not wired this up yet", not "went wrong". */
  unavailable: boolean;
  /** Re-read `runs:get` and replay the transcript from `seq` 0. */
  reload: () => Promise<void>;
}

/** Watch one run and fold its detail + event stream into a render model. */
export function useRunStream(runId: string | null): RunStream {
  const query = useQuery(
    IPC.runs.get,
    { id: runId ?? '' },
    { enabled: Boolean(runId) },
  );

  const events = useRunEvents(runId);
  const storedRun = useRunsStore((state) =>
    runId ? state.runs[runId] : undefined,
  );
  const watchRun = useRunsStore((state) => state.watchRun);
  const unwatchRun = useRunsStore((state) => state.unwatchRun);
  const loadEvents = useRunsStore((state) => state.loadEvents);
  const setActiveRun = useRunsStore((state) => state.setActiveRun);

  // Ask main to stream this run to this window for as long as it is on screen.
  useEffect(() => {
    if (!runId) return undefined;
    setActiveRun(runId);
    void watchRun(runId);
    void loadEvents(runId, 0);
    return () => {
      void unwatchRun(runId);
      setActiveRun(null);
    };
  }, [runId, watchRun, unwatchRun, loadEvents, setActiveRun]);

  const detail = query.data ?? null;
  const model = useMemo(() => buildTimeline(detail, events), [detail, events]);
  const gaps = useMemo(() => findSeqGaps(events), [events]);

  // One backfill per distinct gap signature — a hole that survives the refetch
  // is a real hole, and retrying it in a loop would just burn IPC.
  const backfilled = useRef<string>('');
  useEffect(() => {
    if (!runId || gaps.length === 0) return;
    const signature = `${runId}:${gaps[0]}:${gaps[gaps.length - 1]}:${gaps.length}`;
    if (backfilled.current === signature) return;
    backfilled.current = signature;
    void loadEvents(runId, 0);
  }, [runId, gaps, loadEvents]);

  const run = useMemo(
    () => effectiveRun(storedRun ?? detail?.run, model),
    [storedRun, detail, model],
  );

  const live = run ? isRunLive(run) : false;
  const now = useNow(live);

  const reload = useCallback(async () => {
    backfilled.current = '';
    await Promise.all([
      query.refetch(),
      runId ? loadEvents(runId, 0) : Promise.resolve(),
    ]);
  }, [query, runId, loadEvents]);

  return {
    run,
    detail,
    model,
    gaps,
    failureKind: readFailureKind(run ?? detail?.run),
    failureDetail: model.streamError ?? run?.error,
    live,
    now,
    loading: query.loading,
    error: query.error,
    unavailable: query.error?.isUnavailable ?? false,
    reload,
  };
}
