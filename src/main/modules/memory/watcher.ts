/**
 * The vault watcher.
 *
 * Editing `memory/people/ana.md` in a text editor is a supported way to use
 * this product, so the index has to follow the filesystem rather than the other
 * way round.
 *
 * Three things this has to get right:
 *
 *  - **Globs are gone in chokidar 4+.** `ignored` takes a
 *    `(path, stats) => boolean` matcher, so the directory is watched and
 *    non-Markdown files are filtered out in the predicate. The predicate must
 *    only reject *files* — rejecting a directory prunes everything under it.
 *  - **Bursts.** A `git checkout` or a "save all" fires dozens of events at
 *    once. Events are coalesced per path into a pending map and flushed after a
 *    quiet period; the last verb for a path wins, so create-then-delete ends as
 *    a delete rather than an index entry pointing at nothing.
 *  - **Serialisation.** sql.js is single-threaded and transactions do not nest
 *    across awaits, so flushes run on one promise chain. A batch that arrives
 *    mid-flush is queued, never interleaved.
 */
import path from 'node:path';
import type { Stats } from 'node:fs';
import type { Logger } from '../../infra/logger';
import { toPosixPath } from '../../infra/files';
import { MEMORY_EXTENSION } from './indexer';

/**
 * chokidar 5 is ESM-only (`"type": "module"`), and this file compiles to
 * CommonJS, so a static `import` is a type error before it is anything else.
 * A dynamic import is the sanctioned bridge; `webpackMode: "eager"` keeps
 * webpack from splitting it into a separate chunk, so the packaged main bundle
 * stays a single file and there is nothing extra to ship.
 */
type ChokidarModule = typeof import('chokidar', {
  with: { 'resolution-mode': 'import' },
});
type FSWatcher = import('chokidar', {
  with: { 'resolution-mode': 'import' },
}).FSWatcher;

let chokidar: ChokidarModule | null = null;

async function loadChokidar(): Promise<ChokidarModule> {
  if (!chokidar) {
    chokidar = await import(/* webpackMode: "eager" */ 'chokidar');
  }
  return chokidar;
}

/** Quiet period before a batch is applied. */
export const DEFAULT_DEBOUNCE_MS = 200;

/** How long chokidar waits for a file to stop growing before reporting it. */
export const DEFAULT_STABILITY_MS = 150;

export interface PendingChange {
  /** Vault-relative, POSIX. */
  path: string;
  deleted: boolean;
}

export interface WatcherOptions {
  directory: string;
  logger: Logger;
  /** Applies one coalesced batch. Never called concurrently with itself. */
  onChanges(changes: PendingChange[]): Promise<void>;
  debounceMs?: number;
  stabilityMs?: number;
  /** Chokidar's own fallback. Only worth enabling on network mounts. */
  usePolling?: boolean;
}

/**
 * Reject non-Markdown *files* only.
 *
 * chokidar calls this for directories too, and returning `true` for one stops
 * it descending, so a `false` for anything that is not a known file keeps
 * subdirectories live. Dotfiles are skipped, which conveniently also covers the
 * `.name.md.<hex>.tmp` files `writeFileAtomic` leaves for a few milliseconds.
 */
export function shouldIgnore(target: string, stats?: Stats): boolean {
  const base = path.basename(target);
  if (base.startsWith('.')) return true;
  if (stats && !stats.isFile()) return false;
  if (!stats) return false;
  return path.extname(base).toLowerCase() !== MEMORY_EXTENSION;
}

export class MemoryWatcher {
  private readonly options: Required<
    Omit<WatcherOptions, 'logger' | 'onChanges'>
  > &
    Pick<WatcherOptions, 'logger' | 'onChanges'>;

  private watcher: FSWatcher | null = null;

  private timer: NodeJS.Timeout | null = null;

  private pending = new Map<string, boolean>();

  /** The single chain every flush runs on. */
  private queue: Promise<void> = Promise.resolve();

  private stopped = false;

  constructor(options: WatcherOptions) {
    this.options = {
      directory: options.directory,
      logger: options.logger,
      onChanges: options.onChanges,
      debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      stabilityMs: options.stabilityMs ?? DEFAULT_STABILITY_MS,
      usePolling: options.usePolling ?? false,
    };
  }

  /** Resolves once chokidar has finished its initial scan. */
  async start(): Promise<void> {
    if (this.watcher) return;
    this.stopped = false;

    const { watch } = await loadChokidar();
    const watcher = watch(this.options.directory, {
      // chokidar 5 has no glob support; this predicate replaces `**/*.md`.
      ignored: (target: string, stats?: Stats) => shouldIgnore(target, stats),
      // The initial state is established by the indexer's own scan, which is
      // cheaper and gives us hashes; the watcher only reports deltas.
      ignoreInitial: true,
      persistent: true,
      followSymlinks: false,
      atomic: true,
      usePolling: this.options.usePolling,
      awaitWriteFinish: {
        stabilityThreshold: this.options.stabilityMs,
        pollInterval: 50,
      },
    });

    watcher.on('add', (target: string) => this.enqueue(target, false));
    watcher.on('change', (target: string) => this.enqueue(target, false));
    watcher.on('unlink', (target: string) => this.enqueue(target, true));
    watcher.on('error', (cause: unknown) => {
      this.options.logger.warn('memory watcher error', {
        error: cause instanceof Error ? cause.message : String(cause),
      });
    });

    this.watcher = watcher;

    await new Promise<void>((resolve) => {
      watcher.once('ready', () => resolve());
    });
    this.options.logger.debug('memory watcher ready', {
      directory: this.options.directory,
    });
  }

  private enqueue(target: string, deleted: boolean): void {
    if (this.stopped) return;
    const relative = toPosixPath(
      path.relative(this.options.directory, target),
    );
    if (!relative || relative.startsWith('..')) return;
    if (path.extname(relative).toLowerCase() !== MEMORY_EXTENSION) return;

    // Last verb wins: an add followed by an unlink is an unlink.
    this.pending.set(relative, deleted);

    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.options.debounceMs);
    this.timer.unref?.();
  }

  /** Apply whatever is pending now. Also the test hook for "did it see it?". */
  flush(): Promise<void> {
    if (this.pending.size === 0) return this.queue;
    const batch: PendingChange[] = [...this.pending].map(
      ([target, deleted]) => ({ path: target, deleted }),
    );
    this.pending.clear();

    this.queue = this.queue.then(async () => {
      try {
        await this.options.onChanges(batch);
      } catch (cause) {
        this.options.logger.error('memory watcher batch failed', {
          error: cause instanceof Error ? cause.message : String(cause),
          count: batch.length,
        });
      }
    });
    return this.queue;
  }

  /** Wait for every queued batch to finish. */
  async drain(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
    await this.queue;
  }

  /** Close the watcher and finish any work already accepted. Safe twice. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const watcher = this.watcher;
    this.watcher = null;
    if (watcher) await watcher.close();
    // Anything already accepted is still applied: dropping it would leave the
    // index disagreeing with the disk until the next full scan.
    await this.flush();
    await this.queue;
  }
}
