/**
 * The memory module.
 *
 * Markdown files on disk, a SQLite full-text index over them, and a file
 * watcher. That is the whole design, deliberately: no chunk-sealing cascade, no
 * topic tree, no embeddings, no summarisation pipeline. Those are only
 * justified once flat search demonstrably fails, and until then they are
 * machinery that has to be kept correct for no measured benefit.
 *
 * The parts:
 *  - `markdown.ts` — front matter, headings, deterministic chunking
 *  - `store.ts`    — the schema, content-addressed ids, FTS4 reads and writes
 *  - `query.ts`    — safe MATCH construction and BM25 over `matchinfo`
 *  - `indexer.ts`  — files → index, and every read the UI and the agent make
 *  - `watcher.ts`  — chokidar, debounced and serialised
 *  - `tools.ts`    — the MCP surface
 *
 * See `store.ts` for why this is FTS4 and not FTS5, and `query.ts` for why the
 * ranking is in JavaScript.
 */
import { defineModule, type ModuleContext } from '../types';
import { MemoryIndexer } from './indexer';
import { migrations } from './store';
import { MemoryWatcher } from './watcher';
import { createMemoryTools } from './tools';

/* ------------------------------------------------------------------ */
/* Module state                                                        */
/* ------------------------------------------------------------------ */

let indexer: MemoryIndexer | null = null;
let watcher: MemoryWatcher | null = null;

/**
 * The indexer, or a clear error.
 *
 * The registry binds IPC handlers before it calls `start()`, so a renderer that
 * is already up can reach a channel a millisecond early. Saying so beats a
 * `Cannot read properties of null`.
 */
function requireIndexer(): MemoryIndexer {
  if (!indexer) {
    throw new Error('The memory module is not started yet.');
  }
  return indexer;
}

/** Exposed for tests and for the memory browser's "is it ready" check. */
export function getMemoryIndexer(): MemoryIndexer | null {
  return indexer;
}

/* ------------------------------------------------------------------ */
/* The module                                                          */
/* ------------------------------------------------------------------ */

export default defineModule({
  id: 'memory',
  migrations,
  tools: createMemoryTools(requireIndexer),

  ipc: {
    'memory:search': (request) => requireIndexer().search(request),
    'memory:get': (request) => requireIndexer().get(request),
    'memory:list': (request) => requireIndexer().list(request),
    'memory:write': (request) => requireIndexer().write(request),
    'memory:status': () => requireIndexer().status(),
    'memory:reindex': async (request) => {
      const memory = requireIndexer();
      await memory.syncAll({ full: request?.full === true });
      return memory.status();
    },
  },

  async start(ctx: ModuleContext): Promise<void> {
    indexer = new MemoryIndexer({
      db: ctx.db,
      paths: ctx.paths,
      events: ctx.events,
      logger: ctx.logger,
    });

    // Awaited rather than backgrounded: a personal vault is small, and an index
    // that is half-built when the first search arrives is worse than a start
    // that takes another moment. A failure here is logged, not fatal — the
    // files are all still there and a manual reindex can recover.
    try {
      await indexer.syncAll();
    } catch (cause) {
      ctx.logger.error('initial memory index failed', {
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }

    watcher = new MemoryWatcher({
      directory: ctx.paths.memoryDir,
      logger: ctx.logger,
      onChanges: (changes) => requireIndexer().applyChanges(changes),
    });
    await watcher.start();
  },

  async stop(): Promise<void> {
    const running = watcher;
    watcher = null;
    if (running) await running.stop();
    indexer = null;
  },
});

export { MemoryIndexer } from './indexer';
export { MemoryWatcher } from './watcher';
export type { IndexFileResult, SyncResult } from './indexer';
