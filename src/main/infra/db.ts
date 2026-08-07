/**
 * The sql.js wrapper.
 *
 * sql.js is a WASM build of SQLite that holds the whole database in memory and
 * hands you bytes on demand, so three things have to be got right and are got
 * right here:
 *
 *  1. **Locating the runtime.** sql.js ships an emscripten glue file and a
 *     `.wasm` beside it, and emscripten looks for the `.wasm` relative to the
 *     *script* directory — wrong for a webpack bundle in dev and wrong inside
 *     `app.asar`. Worse, bundling the glue at all is unsafe: webpack rewrites
 *     the `typeof module !== "undefined" && (module.exports = Module)` line
 *     inside it to an unconditional assignment against a binding that is not
 *     there at runtime, and initialisation dies with "undefined is not an
 *     object". So the glue is **not** bundled. Both files are copied next to
 *     the output bundle at build time (see `.erb/configs/copy-files-plugin.ts`)
 *     and loaded here by absolute path with a require that webpack does not
 *     rewrite. {@link resolveSqlJsAssets} owns the candidate list.
 *  2. **Persistence.** Nothing reaches disk until `export()` is written out, so
 *     every mutation marks the database dirty and a debounced flush writes it
 *     atomically. `close()` flushes.
 *  3. **Parameters.** Every query goes through a prepared statement with bound
 *     parameters. There is no string-concatenated SQL in this file and there
 *     must be none in callers.
 */
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import type {
  Database as SqlDatabase,
  InitSqlJsStatic,
  SqlJsStatic,
  SqlValue,
  Statement,
} from 'sql.js';
import { writeFileAtomic } from './files';
import type { Logger } from './logger';

/**
 * Webpack rewrites `require` but leaves `__non_webpack_require__` as the real
 * one; outside a bundle the identifier does not exist and `typeof` on an
 * undeclared name is safe.
 */
declare const __non_webpack_require__: NodeRequire | undefined;

function runtimeRequire(): NodeRequire {
  if (typeof __non_webpack_require__ === 'function') {
    return __non_webpack_require__;
  }
  // Unbundled (bun, jest, ts-node). `createRequire` rather than a bare
  // `require` so webpack has no expression to warn about.
  const base =
    typeof __filename === 'string'
      ? __filename
      : path.join(process.cwd(), 'index.js');
  return createRequire(base);
}

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** A value that may be bound to a query parameter. */
export type SqlParam =
  string | number | boolean | null | undefined | Uint8Array;

/** Positional (`?`) or named (`:name`) parameters. */
export type SqlParams = SqlParam[] | Record<string, SqlParam>;

/** One row, as returned by `all` / `get`. */
export type Row = Record<string, SqlValue>;

/**
 * One schema change owned by a module.
 *
 * `id` must be stable forever and sort in application order within its module —
 * `001_init`, `002_add_tags`. Ids are namespaced by module in `_migrations`, so
 * two modules may both have `001_init`.
 *
 * `up` is either SQL (a string, or an array of statements applied in order) or
 * a function for data migrations that need logic. Everything in one migration
 * runs inside a single transaction.
 */
export interface Migration {
  id: string;
  up: string | string[] | ((db: Db) => void);
  /** Shown in logs. Optional. */
  description?: string;
}

export interface AppliedMigration {
  /** `<namespace>:<id>`. */
  key: string;
  namespace: string;
  id: string;
  appliedAt: string;
}

export interface DbOptions {
  /** Absolute path to the database file. Created if missing. */
  filePath: string;
  /**
   * Directory holding `sql-wasm.js` and `sql-wasm.wasm`. Skips
   * {@link resolveSqlJsAssets} when given.
   */
  sqlJsDir?: string;
  /** Extra directories to try before the built-in candidates. */
  sqlJsSearchDirs?: string[];
  /** Quiet period before a dirty database is written. Default 250 ms. */
  persistDebounceMs?: number;
  /** Force a write after this long even under continuous writes. Default 2000 ms. */
  persistMaxWaitMs?: number;
  /** Open in memory only; `persist()` becomes a no-op. For tests. */
  inMemory?: boolean;
  logger?: Logger;
  /** Called when a background flush fails. Default: log at error. */
  onPersistError?(error: Error): void;
}

export interface Db {
  /** Absolute path of the backing file, or `':memory:'`. */
  readonly filePath: string;

  /** Execute a statement with bound parameters. Returns rows changed. */
  run(
    sql: string,
    params?: SqlParams,
  ): { changes: number; lastInsertRowId: number };
  /** All rows for a query. */
  all<T extends Row = Row>(sql: string, params?: SqlParams): T[];
  /** First row, or undefined. */
  get<T extends Row = Row>(sql: string, params?: SqlParams): T | undefined;
  /** First column of the first row, or undefined. */
  pluck<T extends SqlValue = SqlValue>(
    sql: string,
    params?: SqlParams,
  ): T | undefined;
  /**
   * Run multi-statement DDL. No parameters — this is the one entry point that
   * takes raw SQL, and it must never be handed user input.
   */
  exec(sql: string): void;

  /**
   * Run `fn` inside a transaction (a SAVEPOINT when already in one), rolling
   * back if it throws. Synchronous by design: sql.js is synchronous, and an
   * `await` inside a transaction would interleave with other work.
   */
  transaction<T>(fn: () => T): T;

  /** Apply a module's migrations. Idempotent; returns what it actually ran. */
  migrate(
    namespace: string,
    migrations: Migration[],
  ): Promise<AppliedMigration[]>;
  /** Migration keys already recorded in `_migrations`. */
  appliedMigrations(namespace?: string): AppliedMigration[];

  /** Mark dirty and schedule a debounced flush. Called for you by `run`/`exec`. */
  markDirty(): void;
  /** Flush now and wait for the bytes to land. */
  persist(): Promise<void>;
  /** Flush and release the WASM instance. Safe to call twice. */
  close(): Promise<void>;
  readonly closed: boolean;

  /** Escape hatch for code that genuinely needs the raw handle. Avoid. */
  raw(): SqlDatabase;
}

/* ------------------------------------------------------------------ */
/* Locating the sql.js runtime                                         */
/* ------------------------------------------------------------------ */

/**
 * Override the directory holding `sql-wasm.js` and `sql-wasm.wasm` without
 * touching code.
 */
export const WASM_ENV_VAR = 'ASSISTANT_SQLJS_DIR';

const WASM_FILENAME = 'sql-wasm.wasm';
const GLUE_FILENAME = 'sql-wasm.js';

/** The pair of files sql.js needs, resolved to one directory. */
export interface SqlJsAssets {
  /** Directory containing both files. */
  dir: string;
  /** Emscripten glue, `require`d at runtime rather than bundled. */
  jsPath: string;
  /** The WASM binary, read by us and handed over as `wasmBinary`. */
  wasmPath: string;
}

function bundleDir(): string {
  return typeof __dirname === 'string' ? __dirname : process.cwd();
}

/** Walk up from `start` collecting `node_modules/sql.js/dist`. */
function nodeModulesCandidates(start: string): string[] {
  const out: string[] = [];
  let dir = path.resolve(start);
  for (let depth = 0; depth < 12; depth += 1) {
    out.push(path.join(dir, 'node_modules', 'sql.js', 'dist'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

/**
 * Every directory the sql.js runtime might live in, in priority order.
 *
 * - env override, for packaging experiments and tests
 * - caller-supplied directories
 * - beside the bundle: the webpack main config copies both files into the
 *   output directory, so this hits in dev (`.erb/dll/`) and packaged
 *   (`dist/main/`, read transparently through `app.asar`)
 * - `resourcesPath`, if someone ships them as extra resources instead
 * - a `node_modules` walk up from the bundle and from the cwd, which is what
 *   makes plain `bun` scripts and jest work with no build step
 */
export function sqlJsDirCandidates(extraDirs: string[] = []): string[] {
  const candidates: string[] = [];
  const fromEnv = process.env[WASM_ENV_VAR];
  if (fromEnv) candidates.push(fromEnv);

  candidates.push(...extraDirs);

  const here = bundleDir();
  candidates.push(here);
  candidates.push(path.join(here, '..'));

  const resources = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  if (typeof resources === 'string' && resources) {
    candidates.push(resources);
    candidates.push(path.join(resources, 'app.asar.unpacked'));
    candidates.push(path.join(resources, 'app.asar.unpacked', 'dist', 'main'));
  }

  candidates.push(...nodeModulesCandidates(here));
  candidates.push(...nodeModulesCandidates(process.cwd()));

  return [...new Set(candidates)];
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * First directory holding both files. Throws with the full candidate list when
 * none do, because "sql.js failed to initialise" with no path is the least
 * debuggable error in this codebase.
 */
export function resolveSqlJsAssets(extraDirs: string[] = []): SqlJsAssets {
  const candidates = sqlJsDirCandidates(extraDirs);
  for (const dir of candidates) {
    const jsPath = path.join(dir, GLUE_FILENAME);
    const wasmPath = path.join(dir, WASM_FILENAME);
    if (isFile(jsPath) && isFile(wasmPath)) return { dir, jsPath, wasmPath };
  }
  throw new Error(
    `Could not locate ${GLUE_FILENAME} + ${WASM_FILENAME}. Set ${WASM_ENV_VAR} ` +
      'to the directory holding them, or copy them next to the main bundle. ' +
      `Tried:\n  ${candidates.join('\n  ')}`,
  );
}

/** Convenience wrapper for callers that only care about the WASM binary. */
export function resolveSqlWasmPath(extraDirs: string[] = []): string {
  return resolveSqlJsAssets(extraDirs).wasmPath;
}

/* ------------------------------------------------------------------ */
/* sql.js runtime, initialised once per process                        */
/* ------------------------------------------------------------------ */

let runtime: Promise<SqlJsStatic> | null = null;

/**
 * Initialise the WASM runtime. Idempotent — every database in the process
 * shares one instance, which is how sql.js is meant to be used.
 */
export function initSqlRuntime(
  options: { sqlJsDir?: string; sqlJsSearchDirs?: string[] } = {},
): Promise<SqlJsStatic> {
  if (!runtime) {
    const assets = resolveSqlJsAssets(
      options.sqlJsDir ? [options.sqlJsDir] : (options.sqlJsSearchDirs ?? []),
    );

    // Loaded at runtime, never bundled: see the note at the top of this file.
    const loaded = runtimeRequire()(assets.jsPath) as
      InitSqlJsStatic | { default: InitSqlJsStatic };
    const factory =
      typeof loaded === 'function'
        ? loaded
        : (loaded.default as InitSqlJsStatic);

    const bytes = fs.readFileSync(assets.wasmPath);
    // Handing over the bytes directly sidesteps emscripten's own file lookup,
    // which is relative to the script directory and therefore wrong in a bundle.
    const wasmBinary = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;

    runtime = factory({
      wasmBinary,
      locateFile: () => assets.wasmPath,
    }).catch((cause: unknown) => {
      runtime = null;
      throw cause;
    });
  }
  return runtime;
}

/** Drop the cached runtime. Tests only. */
export function resetSqlRuntime(): void {
  runtime = null;
}

/* ------------------------------------------------------------------ */
/* Parameter normalisation                                             */
/* ------------------------------------------------------------------ */

function normalizeValue(value: SqlParam): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function normalizeParams(
  params: SqlParams | undefined,
): SqlValue[] | Record<string, SqlValue> | null {
  if (params === undefined) return null;
  if (Array.isArray(params)) return params.map(normalizeValue);
  const out: Record<string, SqlValue> = {};
  for (const [key, value] of Object.entries(params)) {
    // sql.js wants the sigil in the key; accept both spellings.
    const name = /^[:@$]/.test(key) ? key : `:${key}`;
    out[name] = normalizeValue(value);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Open                                                                */
/* ------------------------------------------------------------------ */

const MAX_CACHED_STATEMENTS = 64;

/** Every open database, so `main.ts` can flush them all on quit. */
const openDatabases = new Set<Db>();

/** Flush and close every open database. Call from `before-quit`. */
export async function closeAllDatabases(): Promise<void> {
  await Promise.all([...openDatabases].map((db) => db.close()));
  openDatabases.clear();
}

/**
 * Open (or create) a database.
 *
 * Loads the file if it exists, starts empty if it does not, and writes an
 * initial snapshot so the file exists from the first launch.
 */
export async function openDatabase(options: DbOptions): Promise<Db> {
  const {
    filePath,
    sqlJsDir,
    sqlJsSearchDirs,
    persistDebounceMs = 250,
    persistMaxWaitMs = 2000,
    inMemory = false,
    logger,
    onPersistError,
  } = options;

  const SQL = await initSqlRuntime({ sqlJsDir, sqlJsSearchDirs });

  let initial: Uint8Array | undefined;
  if (!inMemory) {
    try {
      initial = fs.readFileSync(filePath);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    }
  }

  const handle = new SQL.Database(initial ?? null);

  // Connection-scoped settings. Re-applied after every export(): see flush().
  const applyPragmas = (): void => {
    // Foreign keys are off by default in SQLite and every module assumes they
    // are on.
    handle.run('PRAGMA foreign_keys = ON;');
  };
  applyPragmas();

  /* -------- statement cache -------- */

  const cache = new Map<string, { statement: Statement; busy: boolean }>();

  const acquire = (sql: string): { statement: Statement; cached: boolean } => {
    const entry = cache.get(sql);
    if (entry && !entry.busy) {
      entry.busy = true;
      entry.statement.reset();
      return { statement: entry.statement, cached: true };
    }
    // Either uncached, or the cached one is mid-iteration on an outer frame.
    const statement = handle.prepare(sql);
    if (!entry && cache.size < MAX_CACHED_STATEMENTS) {
      cache.set(sql, { statement, busy: true });
      return { statement, cached: true };
    }
    return { statement, cached: false };
  };

  const release = (
    sql: string,
    statement: Statement,
    cached: boolean,
  ): void => {
    if (!cached) {
      statement.free();
      return;
    }
    const entry = cache.get(sql);
    if (entry && entry.statement === statement) {
      entry.busy = false;
      entry.statement.reset();
    } else {
      statement.free();
    }
  };

  const freeStatements = (): void => {
    for (const entry of cache.values()) {
      try {
        entry.statement.free();
      } catch {
        /* already freed */
      }
    }
    cache.clear();
  };

  /* -------- persistence -------- */

  let dirty = false;
  let closed = false;
  let timer: NodeJS.Timeout | null = null;
  let firstDirtyAt = 0;
  let writing: Promise<void> = Promise.resolve();

  const reportPersistError = (error: Error): void => {
    if (onPersistError) onPersistError(error);
    else if (logger) logger.error('database flush failed', error);
    // eslint-disable-next-line no-console
    else console.error('[db] flush failed', error);
  };

  /**
   * Serialise and write.
   *
   * `Database.export()` is not the innocent getter it looks like: sql.js
   * finalises every prepared statement, closes the connection, reads the file
   * out of the emscripten filesystem and reopens it. So the statement cache is
   * dead afterwards and connection-scoped PRAGMAs are gone. Both are dealt with
   * here, immediately and synchronously — nothing may observe the database
   * between the export and the repair.
   *
   * It also means a flush must never happen inside a transaction. It cannot:
   * `transaction()` is synchronous, so the debounce timer cannot fire during
   * one, and `persist()` is only ever awaited from outside.
   */
  const flush = async (): Promise<void> => {
    if (inMemory || !dirty || closed) return;
    dirty = false;
    firstDirtyAt = 0;
    const bytes = handle.export();
    cache.clear();
    applyPragmas();
    await writeFileAtomic(filePath, bytes, { mode: 0o600 });
    logger?.debug('database persisted', {
      filePath,
      bytes: bytes.byteLength,
    });
  };

  const flushSerialized = (): Promise<void> => {
    writing = writing.then(flush, flush);
    return writing;
  };

  const cancelTimer = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (): void => {
    if (inMemory || closed) return;
    const now = Date.now();
    if (firstDirtyAt === 0) firstDirtyAt = now;
    cancelTimer();
    // Trailing debounce, but never starve: a continuous write loop still lands
    // on disk every persistMaxWaitMs.
    const wait = Math.min(
      persistDebounceMs,
      Math.max(0, firstDirtyAt + persistMaxWaitMs - now),
    );
    timer = setTimeout(() => {
      timer = null;
      flushSerialized().catch(reportPersistError);
    }, wait);
    timer.unref?.();
  };

  const markDirty = (): void => {
    dirty = true;
    schedule();
  };

  /* -------- transactions -------- */

  let depth = 0;

  /* -------- the handle -------- */

  const db: Db = {
    filePath: inMemory ? ':memory:' : filePath,

    get closed() {
      return closed;
    },

    raw: () => handle,

    run(sql, params) {
      const { statement, cached } = acquire(sql);
      try {
        statement.run(normalizeParams(params));
      } finally {
        release(sql, statement, cached);
      }
      const changes = handle.getRowsModified();
      markDirty();
      const rowId = handle.exec('SELECT last_insert_rowid() AS id;');
      const lastInsertRowId = Number(rowId[0]?.values?.[0]?.[0] ?? 0);
      return { changes, lastInsertRowId };
    },

    all<T extends Row = Row>(sql: string, params?: SqlParams): T[] {
      const { statement, cached } = acquire(sql);
      const rows: T[] = [];
      try {
        statement.bind(normalizeParams(params));
        while (statement.step()) {
          rows.push(statement.getAsObject() as T);
        }
      } finally {
        release(sql, statement, cached);
      }
      return rows;
    },

    get<T extends Row = Row>(sql: string, params?: SqlParams): T | undefined {
      const { statement, cached } = acquire(sql);
      try {
        statement.bind(normalizeParams(params));
        if (!statement.step()) return undefined;
        return statement.getAsObject() as T;
      } finally {
        release(sql, statement, cached);
      }
    },

    pluck<T extends SqlValue = SqlValue>(
      sql: string,
      params?: SqlParams,
    ): T | undefined {
      const { statement, cached } = acquire(sql);
      try {
        statement.bind(normalizeParams(params));
        if (!statement.step()) return undefined;
        return statement.get()[0] as T;
      } finally {
        release(sql, statement, cached);
      }
    },

    exec(sql) {
      handle.exec(sql);
      markDirty();
    },

    transaction<T>(fn: () => T): T {
      const savepoint = `sp_${depth}`;
      const begin = depth === 0 ? 'BEGIN' : `SAVEPOINT ${savepoint}`;
      const commit = depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`;
      const rollback =
        depth === 0
          ? 'ROLLBACK'
          : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`;

      handle.exec(begin);
      depth += 1;
      try {
        const result = fn();
        depth -= 1;
        handle.exec(commit);
        markDirty();
        return result;
      } catch (cause) {
        depth -= 1;
        try {
          handle.exec(rollback);
        } catch {
          /* the transaction is already gone */
        }
        throw cause;
      }
    },

    appliedMigrations(namespace) {
      ensureMigrationsTable(db);
      const rows = namespace
        ? db.all<{
            key: string;
            namespace: string;
            id: string;
            applied_at: string;
          }>(
            'SELECT key, namespace, id, applied_at FROM _migrations WHERE namespace = ? ORDER BY key',
            [namespace],
          )
        : db.all<{
            key: string;
            namespace: string;
            id: string;
            applied_at: string;
          }>(
            'SELECT key, namespace, id, applied_at FROM _migrations ORDER BY key',
          );
      return rows.map((row) => ({
        key: String(row.key),
        namespace: String(row.namespace),
        id: String(row.id),
        appliedAt: String(row.applied_at),
      }));
    },

    async migrate(namespace, migrations) {
      return runMigrations(db, namespace, migrations, logger);
    },

    markDirty,

    async persist() {
      cancelTimer();
      await flushSerialized();
    },

    async close() {
      if (closed) return;
      cancelTimer();
      await flushSerialized();
      closed = true;
      freeStatements();
      handle.close();
      openDatabases.delete(db);
    },
  };

  // First launch: make the file exist so backup tooling and the user can see it.
  if (!inMemory && !initial) {
    dirty = true;
    await flushSerialized();
  }

  openDatabases.add(db);
  return db;
}

/* ------------------------------------------------------------------ */
/* Migrations                                                          */
/* ------------------------------------------------------------------ */

function ensureMigrationsTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      key         TEXT PRIMARY KEY,
      namespace   TEXT NOT NULL,
      id          TEXT NOT NULL,
      applied_at  TEXT NOT NULL
    );
  `);
}

/**
 * Apply `migrations` in array order under `namespace`, skipping any already
 * recorded. Each migration runs in its own transaction, so a failure leaves
 * every earlier migration applied and this one not — re-running resumes.
 */
export async function runMigrations(
  db: Db,
  namespace: string,
  migrations: Migration[],
  logger?: Logger,
): Promise<AppliedMigration[]> {
  ensureMigrationsTable(db);

  const seen = new Set<string>();
  for (const migration of migrations) {
    if (seen.has(migration.id)) {
      throw new Error(
        `Duplicate migration id "${migration.id}" in "${namespace}"`,
      );
    }
    seen.add(migration.id);
  }

  const already = new Set(
    db
      .all<{ key: string }>('SELECT key FROM _migrations WHERE namespace = ?', [
        namespace,
      ])
      .map((row) => String(row.key)),
  );

  const applied: AppliedMigration[] = [];

  for (const migration of migrations) {
    const key = `${namespace}:${migration.id}`;
    if (already.has(key)) continue;

    const appliedAt = new Date().toISOString();
    db.transaction(() => {
      if (typeof migration.up === 'function') {
        migration.up(db);
      } else {
        const statements = Array.isArray(migration.up)
          ? migration.up
          : [migration.up];
        for (const sql of statements) {
          if (sql.trim()) db.exec(sql);
        }
      }
      db.run(
        'INSERT INTO _migrations (key, namespace, id, applied_at) VALUES (?, ?, ?, ?)',
        [key, namespace, migration.id, appliedAt],
      );
    });

    logger?.info('migration applied', {
      key,
      description: migration.description,
    });
    applied.push({ key, namespace, id: migration.id, appliedAt });
  }

  if (applied.length > 0) await db.persist();
  return applied;
}
