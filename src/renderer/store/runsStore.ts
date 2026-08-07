/**
 * Runs and their live event streams.
 *
 * The run timeline is the highest-value surface in the product, so this slice
 * is built for it:
 *
 *  - events are keyed by run and deduped/ordered by `seq`, because the stream
 *    arrives batched (per-token IPC pins a core) and a reconnect can replay;
 *  - a gap in `seq` is detectable, so the timeline can re-fetch from
 *    `runs:events` instead of quietly showing a hole;
 *  - the buffer is capped — a long run emits more events than any window needs
 *    to keep in memory, and the transcript on disk is the real record.
 */
import { useMemo } from 'react';
import { create } from 'zustand';
import { IPC } from '../../shared/ipc';
import type {
  Run,
  RunEvent,
  RunListQueryInput,
  RunStartRequestInput,
  RunStatus,
} from '../../shared/runs';
import { TERMINAL_RUN_STATUSES } from '../../shared/runs';
import { IpcError, call } from '../lib/ipc';
import { initialLoadable, type LoadableState } from './types';

/** Events retained per run in memory. Older ones stay on disk. */
const EVENT_BUFFER = 1500;

interface RunsState extends LoadableState {
  /** Every run we know about, by id. */
  runs: Record<string, Run>;
  /** Display order for the list view — newest first. */
  order: string[];
  /** Total matching the last query, for pagination. */
  total: number;
  /** The run the timeline is showing. */
  activeRunId: string | null;
  /** Live events, by run id, ascending by `seq`. */
  events: Record<string, RunEvent[]>;
  /** Highest `seq` seen per run. */
  lastSeq: Record<string, number>;
  /** Runs this window has asked main to stream to it. */
  watching: string[];

  loadRuns: (query?: RunListQueryInput) => Promise<void>;
  loadRun: (id: string) => Promise<void>;
  /** Backfill from `runs:events`; use after a detected gap or on mount. */
  loadEvents: (runId: string, sinceSeq?: number) => Promise<void>;

  startRun: (request: RunStartRequestInput) => Promise<Run | null>;
  cancelRun: (id: string) => Promise<boolean>;

  /** Ask main to push this run's events to this window. */
  watchRun: (runId: string) => Promise<void>;
  unwatchRun: (runId: string) => Promise<void>;
  setActiveRun: (runId: string | null) => void;

  /** From `push:run-events`. Deduped and ordered by `seq`. */
  applyEvents: (runId: string, events: RunEvent[]) => void;
  /** From `push:run-status`. */
  applyStatus: (runId: string, status: RunStatus) => void;
  upsertRun: (run: Run) => void;
  clearEvents: (runId: string) => void;
}

function mergeEvents(existing: RunEvent[], incoming: RunEvent[]): RunEvent[] {
  if (incoming.length === 0) return existing;
  const bySeq = new Map<number, RunEvent>();
  existing.forEach((event) => bySeq.set(event.seq, event));
  incoming.forEach((event) => bySeq.set(event.seq, event));
  const merged = Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
  return merged.length > EVENT_BUFFER ? merged.slice(-EVENT_BUFFER) : merged;
}

export const useRunsStore = create<RunsState>((set, get) => ({
  ...initialLoadable,
  runs: {},
  order: [],
  total: 0,
  activeRunId: null,
  events: {},
  lastSeq: {},
  watching: [],

  loadRuns: async (query = {}) => {
    set({ status: 'loading' });
    try {
      const page = await call(IPC.runs.list, query);
      const runs: Record<string, Run> = { ...get().runs };
      page.items.forEach((run) => {
        runs[run.id] = run;
      });
      set({
        runs,
        order: page.items.map((run) => run.id),
        total: page.total,
        status: 'ready',
        error: null,
        unavailable: false,
        loadedAt: new Date().toISOString(),
      });
    } catch (cause) {
      const error = cause as IpcError;
      set({
        status: 'error',
        error: error.message,
        unavailable: error.isUnavailable ?? false,
      });
    }
  },

  loadRun: async (id) => {
    try {
      const detail = await call(IPC.runs.get, { id });
      if (detail) get().upsertRun(detail.run);
    } catch (cause) {
      set({ error: (cause as IpcError).message });
    }
  },

  loadEvents: async (runId, sinceSeq) => {
    try {
      const from = sinceSeq ?? get().lastSeq[runId] ?? 0;
      const page = await call(IPC.runs.events, { runId, sinceSeq: from });
      get().applyEvents(page.runId, page.events);
    } catch (cause) {
      set({ error: (cause as IpcError).message });
    }
  },

  startRun: async (request) => {
    try {
      const run = await call(IPC.runs.start, request);
      get().upsertRun(run);
      set((state) => ({
        order: [run.id, ...state.order.filter((id) => id !== run.id)],
        activeRunId: run.id,
      }));
      return run;
    } catch (cause) {
      set({ error: (cause as IpcError).message });
      return null;
    }
  },

  cancelRun: async (id) => {
    try {
      const result = await call(IPC.runs.cancel, { id });
      get().applyStatus(result.id, result.status);
      return true;
    } catch (cause) {
      set({ error: (cause as IpcError).message });
      return false;
    }
  },

  watchRun: async (runId) => {
    if (get().watching.includes(runId)) return;
    set((state) => ({ watching: [...state.watching, runId] }));
    try {
      await call(IPC.runs.subscribe, { id: runId });
    } catch {
      // Main is not streaming yet; the local flag stays so a retry is cheap.
    }
  },

  unwatchRun: async (runId) => {
    set((state) => ({
      watching: state.watching.filter((id) => id !== runId),
    }));
    try {
      await call(IPC.runs.unsubscribe, { id: runId });
    } catch {
      // Nothing to do — the window is going away or main never started.
    }
  },

  setActiveRun: (runId) => set({ activeRunId: runId }),

  applyEvents: (runId, incoming) => {
    if (incoming.length === 0) return;
    set((state) => {
      const merged = mergeEvents(state.events[runId] ?? [], incoming);
      const highest = merged.length > 0 ? merged[merged.length - 1].seq : 0;

      // Keep the run row in step with the stream without a round trip.
      const runs = { ...state.runs };
      incoming.forEach((event) => {
        if (event.type === 'run.started') runs[event.runId] = event.run;
        if (event.type === 'run.status' && runs[event.runId]) {
          runs[event.runId] = { ...runs[event.runId], status: event.status };
        }
        if (event.type === 'run.finished' && runs[event.runId]) {
          runs[event.runId] = {
            ...runs[event.runId],
            status: event.status,
            usage: event.usage ?? runs[event.runId].usage,
            error: event.error ?? runs[event.runId].error,
            finishedAt: event.at,
          };
        }
      });

      const known = state.order.includes(runId);
      return {
        runs,
        order: known ? state.order : [runId, ...state.order],
        events: { ...state.events, [runId]: merged },
        lastSeq: {
          ...state.lastSeq,
          [runId]: Math.max(state.lastSeq[runId] ?? 0, highest),
        },
      };
    });
  },

  applyStatus: (runId, status) =>
    set((state) => {
      const run = state.runs[runId];
      if (!run) return {};
      return { runs: { ...state.runs, [runId]: { ...run, status } } };
    }),

  upsertRun: (run) =>
    set((state) => ({
      runs: { ...state.runs, [run.id]: run },
      order: state.order.includes(run.id)
        ? state.order
        : [run.id, ...state.order],
    })),

  clearEvents: (runId) =>
    set((state) => {
      const events = { ...state.events };
      const lastSeq = { ...state.lastSeq };
      delete events[runId];
      delete lastSeq[runId];
      return { events, lastSeq };
    }),
}));

/* ------------------------------------------------------------------ */
/* Derived hooks                                                       */
/* ------------------------------------------------------------------ */

/** True while a run has not reached a terminal status. */
export function isRunLive(run: Run): boolean {
  return !TERMINAL_RUN_STATUSES.includes(run.status);
}

/** Runs in `order`, resolved to objects. */
export function useRunList(): Run[] {
  const runs = useRunsStore((state) => state.runs);
  const order = useRunsStore((state) => state.order);
  return useMemo(
    () => order.map((id) => runs[id]).filter((run): run is Run => Boolean(run)),
    [runs, order],
  );
}

/** Everything queued, running or waiting on a human. Drives the status strip. */
export function useLiveRuns(): Run[] {
  const list = useRunList();
  return useMemo(() => list.filter(isRunLive), [list]);
}

/** Runs stopped at `awaiting_approval` — the "waiting on you" group. */
export function useWaitingRuns(): Run[] {
  const list = useRunList();
  return useMemo(
    () => list.filter((run) => run.status === 'awaiting_approval'),
    [list],
  );
}

/** Recently failed runs, newest first. */
export function useFailedRuns(limit = 5): Run[] {
  const list = useRunList();
  return useMemo(
    () => list.filter((run) => run.status === 'failed').slice(0, limit),
    [list, limit],
  );
}

/** The event buffer for a run, ascending by `seq`. */
export function useRunEvents(runId: string | null): RunEvent[] {
  const events = useRunsStore((state) => state.events);
  return useMemo(() => (runId ? (events[runId] ?? []) : []), [events, runId]);
}

/**
 * `seq` values missing from the local buffer. A non-empty result means the
 * timeline should call `loadEvents(runId, 0)` to backfill.
 */
export function findSeqGaps(events: RunEvent[]): number[] {
  const gaps: number[] = [];
  for (let i = 1; i < events.length; i += 1) {
    const expected = events[i - 1].seq + 1;
    for (let seq = expected; seq < events[i].seq; seq += 1) gaps.push(seq);
  }
  return gaps;
}
