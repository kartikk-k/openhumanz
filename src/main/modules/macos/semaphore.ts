/**
 * A FIFO counting semaphore.
 *
 * Twenty lines, no dependency. It exists because the concurrency cap on
 * `osascript` is a correctness property, not a tuning knob — Mail and Calendar
 * handle simultaneous Apple Events badly enough to wedge — and a correctness
 * property deserves something that can be tested on its own, on any platform,
 * without spawning anything.
 *
 * FIFO matters: a LIFO or unordered queue starves the call that has already
 * waited longest, which under a burst is the one whose caller is closest to
 * giving up.
 */
export class Semaphore {
  private available: number;

  private readonly waiters: (() => void)[] = [];

  constructor(private readonly capacity: number) {
    this.available = capacity;
  }

  /** Slots currently held. */
  get inUse(): number {
    return this.capacity - this.available;
  }

  /** Callers waiting for a slot. Surfaced in diagnostics as queue depth. */
  get queued(): number {
    return this.waiters.length;
  }

  /**
   * Take a slot, resolving to the release function.
   *
   * The release function is idempotent, because it is called from a `finally`
   * that may also be reached by an exception path, and a double release would
   * silently raise the cap.
   */
  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return this.releaseOnce();
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    return this.releaseOnce();
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // Hand the slot straight to the next waiter rather than returning it to
      // the pool and letting them race for it.
      const next = this.waiters.shift();
      if (next) next();
      else this.available += 1;
    };
  }
}
