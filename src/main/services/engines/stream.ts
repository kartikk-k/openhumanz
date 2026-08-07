/**
 * The plumbing between a synchronous stdout callback and an async iterable,
 * plus the batching layer that sits in front of IPC.
 *
 * `spawnProcess` hands us lines from a `'data'` handler, which is synchronous
 * and cannot be awaited. {@link AsyncEventQueue} is the buffer in between. The
 * batcher exists because per-event IPC pins a core on a chatty run; the flush
 * interval is a caller's decision, so it is a parameter here rather than a
 * constant.
 */
import type { BatchOptions, EngineEvent, EngineEventType } from './types';
import { DEFAULT_BATCH } from './types';

/* ------------------------------------------------------------------ */
/* Queue                                                               */
/* ------------------------------------------------------------------ */

export interface QueueOverflow {
  dropped: number;
}

export interface AsyncEventQueueOptions<T> {
  /** Buffered events before shedding starts. Default 50000. */
  capacity?: number;
  /** Returns true when an event may be dropped under pressure. */
  droppable?: (value: T) => boolean;
  /** Called once, the first time something is dropped. */
  onOverflow?: (info: QueueOverflow) => void;
}

/**
 * A single-consumer async queue. Producers `push` synchronously; the consumer
 * awaits. `close()` ends the iteration cleanly — which is what makes a
 * cancelled run terminate rather than hang.
 */
export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];

  private waiting: ((result: IteratorResult<T>) => void)[] = [];

  private closed = false;

  private dropped = 0;

  private consumed = false;

  private readonly capacity: number;

  /** Returns true when an event may be dropped under pressure. */
  private readonly droppable: (value: T) => boolean;

  private readonly onOverflow?: (info: QueueOverflow) => void;

  constructor(options: AsyncEventQueueOptions<T> = {}) {
    this.capacity = options.capacity ?? 50_000;
    this.droppable = options.droppable ?? (() => false);
    this.onOverflow = options.onOverflow;
  }

  get size(): number {
    return this.buffer.length;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    if (this.buffer.length >= this.capacity) {
      // Shed the cheap events first; never silently drop a result or an error.
      const index = this.buffer.findIndex(this.droppable);
      if (index >= 0) {
        this.buffer.splice(index, 1);
      } else if (this.droppable(value)) {
        this.dropped += 1;
        if (this.dropped === 1) this.onOverflow?.({ dropped: this.dropped });
        return;
      } else {
        // Everything queued is load-bearing. Grow rather than lose it.
        this.buffer.push(value);
        return;
      }
      this.dropped += 1;
      if (this.dropped === 1) this.onOverflow?.({ dropped: this.dropped });
    }
    this.buffer.push(value);
  }

  /** End the stream once the buffer drains. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) {
      waiter({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.consumed) {
      throw new Error(
        'This engine run is already being consumed. Iterate the run or its batches(), not both.',
      );
    }
    this.consumed = true;
    return {
      next: async (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return { value: this.buffer.shift() as T, done: false };
        }
        if (this.closed)
          return { value: undefined as unknown as T, done: true };
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiting.push(resolve);
        });
      },
      return: async (): Promise<IteratorResult<T>> => {
        this.close();
        return { value: undefined as unknown as T, done: true };
      },
    };
  }
}

/* ------------------------------------------------------------------ */
/* Batching                                                            */
/* ------------------------------------------------------------------ */

export function resolveBatchOptions(
  ...layers: (BatchOptions | undefined)[]
): Required<BatchOptions> {
  const merged = { ...DEFAULT_BATCH };
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.maxEvents !== undefined) merged.maxEvents = layer.maxEvents;
    if (layer.flushIntervalMs !== undefined) {
      merged.flushIntervalMs = layer.flushIntervalMs;
    }
    if (layer.flushOn !== undefined) merged.flushOn = layer.flushOn;
  }
  merged.maxEvents = Math.max(1, Math.floor(merged.maxEvents));
  merged.flushIntervalMs = Math.max(0, merged.flushIntervalMs);
  return merged;
}

/**
 * Group a stream into arrays.
 *
 * A batch is emitted when it reaches `maxEvents`, when `flushIntervalMs` has
 * passed since the batch's first event, or immediately on a `flushOn` type —
 * so a result or an error never waits behind a timer. `flushIntervalMs: 0`
 * means one event per batch, which keeps the type stable for callers that do
 * not want batching at all.
 *
 * The source iterator is always closed, including when the consumer breaks out
 * early: that is what propagates a `break` down to killing the CLI.
 */
export async function* batchEvents<T extends { type: string }>(
  source: AsyncIterable<T>,
  options: Required<BatchOptions>,
): AsyncGenerator<T[], void, undefined> {
  const iterator = source[Symbol.asyncIterator]();
  const flushOn = new Set<string>(options.flushOn as unknown as string[]);
  let batch: T[] = [];
  let pending: Promise<IteratorResult<T>> | null = null;
  let deadline = 0;

  try {
    for (;;) {
      if (!pending) pending = iterator.next();

      let outcome: IteratorResult<T> | 'timeout';
      if (batch.length > 0 && options.flushIntervalMs > 0) {
        const wait = Math.max(0, deadline - Date.now());
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), wait);
          timer.unref?.();
        });
        // Sequential by nature: this is a stream, and the next event cannot be
        // requested before the current one has been dealt with.
        // eslint-disable-next-line no-await-in-loop
        outcome = await Promise.race([pending, timeout]);
        if (timer) clearTimeout(timer);
      } else {
        // eslint-disable-next-line no-await-in-loop
        outcome = await pending;
      }

      if (outcome === 'timeout') {
        yield batch;
        batch = [];
        continue;
      }

      // The race resolved from the source, so this promise is spent.
      pending = null;
      if (outcome.done) break;

      if (batch.length === 0) deadline = Date.now() + options.flushIntervalMs;
      batch.push(outcome.value);

      if (
        options.flushIntervalMs === 0 ||
        batch.length >= options.maxEvents ||
        flushOn.has(outcome.value.type)
      ) {
        yield batch;
        batch = [];
      }
    }
    if (batch.length > 0) yield batch;
  } finally {
    await iterator.return?.(undefined as never);
  }
}

/** Events cheap enough to shed when a consumer falls behind. */
export function isDroppableEvent(event: EngineEvent): boolean {
  const droppable: EngineEventType[] = ['raw', 'thinking', 'log'];
  return (droppable as string[]).includes(event.type);
}
