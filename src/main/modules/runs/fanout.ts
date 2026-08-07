/**
 * Run events -> renderer.
 *
 * An agent CLI in streaming mode emits events far faster than a UI can use
 * them, and one `webContents.send` per token pins a core for the whole run. So
 * nothing goes over IPC directly: events land in a per-run buffer and are
 * flushed on a short timer, or immediately once a buffer is large enough that
 * waiting only adds latency.
 *
 * Two channels, two policies:
 *  - `push:run-events` goes only to windows that asked for that run
 *    (`runs:subscribe`), because the timeline is one run at a time.
 *  - `push:run-status` is broadcast, because the runs list shows every run and
 *    status changes are rare and small.
 *
 * Electron is injected as a {@link RunPushSink} rather than imported: a module
 * gets db, logger, events and paths, and nothing else.
 */
import type { EventBus, Unsubscribe } from '../../infra/events';
import type { Logger } from '../../infra/logger';
import type { IpcPushPayload } from '../../../shared/ipc';
import { IPC_PUSH } from '../../../shared/ipc';
import type { RunEvent } from '../../../shared/runs';

/** The push channels this module owns. */
export type RunPushChannel = typeof IPC_PUSH.runEvents | typeof IPC_PUSH.runStatus;

/**
 * Whatever actually delivers a push. In `main.ts` this wraps
 * `BrowserWindow.webContents.send`; in tests it is an array.
 */
export interface RunPushSink {
  send<C extends RunPushChannel>(
    channel: C,
    payload: IpcPushPayload<C>,
    /** Target windows. `undefined` means every window. */
    senderIds?: readonly number[],
  ): void;
}

export interface RunFanoutOptions {
  events: EventBus;
  logger: Logger;
  /** Absent until `main.ts` wires one; buffering still happens, sending does not. */
  sink?: RunPushSink;
  /** Quiet period before a buffer is flushed. Default 50 ms. */
  flushIntervalMs?: number;
  /** Flush immediately once a run's buffer reaches this. Default 64. */
  maxBatchSize?: number;
  /** Hard cap per run, oldest dropped. The renderer refetches by seq. Default 2000. */
  maxBufferedPerRun?: number;
}

export interface RunFanout {
  /** Begin forwarding. Safe to call twice. */
  start(): void;
  /** Flush, unsubscribe, clear timers. Safe to call twice. */
  stop(): Promise<void>;
  /** Late wiring: `main.ts` has windows after the registry has started. */
  setSink(sink: RunPushSink | undefined): void;

  subscribe(runId: string, senderId?: number): void;
  unsubscribe(runId: string, senderId?: number): void;
  /** A window went away. */
  unsubscribeAll(senderId: number): void;
  subscribers(runId: string): number[];

  /** Send whatever is buffered right now. */
  flush(): void;
  /** Diagnostics and tests. */
  stats(): { buffered: number; runs: number; batchesSent: number };
}

export function createRunFanout(options: RunFanoutOptions): RunFanout {
  const {
    events,
    logger,
    flushIntervalMs = 50,
    maxBatchSize = 64,
    maxBufferedPerRun = 2000,
  } = options;

  let sink = options.sink;
  let started = false;
  let timer: NodeJS.Timeout | null = null;
  let batchesSent = 0;

  const buffers = new Map<string, RunEvent[]>();
  /** runId -> sender ids. An empty set means "subscribed from everywhere". */
  const subscriptions = new Map<string, Set<number>>();
  const unsubscribes: Unsubscribe[] = [];

  const targetsFor = (runId: string): number[] | undefined => {
    const ids = subscriptions.get(runId);
    if (!ids) return [];
    // A subscribe with no sender id (a test, a headless caller) means the sink
    // decides; represent that as "no filter".
    if (ids.size === 0) return undefined;
    return [...ids];
  };

  const flushRun = (runId: string): void => {
    const buffered = buffers.get(runId);
    if (!buffered || buffered.length === 0) return;
    buffers.delete(runId);

    const targets = targetsFor(runId);
    if (targets && targets.length === 0) return; // nobody is watching
    if (!sink) return;

    batchesSent += 1;
    sink.send(IPC_PUSH.runEvents, { runId, events: buffered }, targets);
  };

  const flushAll = (): void => {
    for (const runId of [...buffers.keys()]) flushRun(runId);
  };

  const scheduleFlush = (): void => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flushAll();
    }, flushIntervalMs);
    timer.unref?.();
  };

  const onRunEvent = ({
    runId,
    event,
  }: {
    runId: string;
    event: RunEvent;
  }): void => {
    const buffered = buffers.get(runId) ?? [];
    buffered.push(event);
    if (buffered.length > maxBufferedPerRun) {
      const dropped = buffered.length - maxBufferedPerRun;
      buffered.splice(0, dropped);
      logger.warn('run event buffer overflow', { runId, dropped });
    }
    buffers.set(runId, buffered);

    if (buffered.length >= maxBatchSize) {
      flushRun(runId);
      return;
    }
    scheduleFlush();
  };

  const fanout: RunFanout = {
    start() {
      if (started) return;
      started = true;
      unsubscribes.push(events.on('run:event', onRunEvent));
      unsubscribes.push(
        events.on('run:status', ({ runId, status }) => {
          // Ordering matters: a status push that overtakes its own events makes
          // the timeline look like it finished with steps missing.
          flushRun(runId);
          sink?.send(IPC_PUSH.runStatus, { runId, status });
        }),
      );
    },

    async stop() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      flushAll();
      while (unsubscribes.length > 0) unsubscribes.pop()?.();
      buffers.clear();
      subscriptions.clear();
      started = false;
    },

    setSink(next) {
      sink = next;
    },

    subscribe(runId, senderId) {
      const ids = subscriptions.get(runId) ?? new Set<number>();
      if (senderId !== undefined) ids.add(senderId);
      subscriptions.set(runId, ids);
    },

    unsubscribe(runId, senderId) {
      const ids = subscriptions.get(runId);
      if (!ids) return;
      if (senderId === undefined || ids.size === 0) {
        subscriptions.delete(runId);
        return;
      }
      ids.delete(senderId);
      if (ids.size === 0) subscriptions.delete(runId);
    },

    unsubscribeAll(senderId) {
      for (const [runId, ids] of subscriptions) {
        ids.delete(senderId);
        if (ids.size === 0) subscriptions.delete(runId);
      }
    },

    subscribers(runId) {
      return [...(subscriptions.get(runId) ?? [])];
    },

    flush: flushAll,

    stats() {
      let buffered = 0;
      for (const list of buffers.values()) buffered += list.length;
      return { buffered, runs: buffers.size, batchesSent };
    },
  };

  return fanout;
}
