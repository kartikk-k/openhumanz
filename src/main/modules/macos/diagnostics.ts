/**
 * A record of every `osascript` invocation.
 *
 * Under hardened runtime a blocked or failing Apple Event frequently returns
 * nothing useful to the calling process — exit 1, empty stderr, and the actual
 * reason written only to the unified log where nobody thinks to look. Without a
 * record of what was run, when, for how long and what came back, debugging that
 * is guesswork, and the guesses are usually "it must be a permissions thing".
 *
 * So every invocation is recorded: in a bounded in-memory ring for the
 * diagnostics screen, and in SQLite so a failure from yesterday is still
 * answerable today.
 *
 * **Arguments are recorded as lengths, not values.** They routinely contain a
 * search query, an email body or a contact's name, and a diagnostics table is
 * the last place personal data should accumulate. Lengths and a count are enough
 * to reconstruct the call shape. `ASSISTANT_MACOS_TRACE_ARGS=1` records the real
 * values for a developer who needs them and is a deliberate, visible act.
 */
import type { Db, Migration, Row } from '../../infra/db';
import { nowIso, type IsoDateTime } from '../../../shared/common';
import type { AppleAppId } from './apps';
import type { MacosErrorKind } from './errors';

/** Turn on full argument capture. Off by default; never on in a build. */
export const TRACE_ARGS_ENV_VAR = 'ASSISTANT_MACOS_TRACE_ARGS';

export function argsAreTraced(): boolean {
  return process.env[TRACE_ARGS_ENV_VAR] === '1';
}

export interface InvocationRecord {
  id: string;
  startedAt: IsoDateTime;
  /** Script basename, e.g. `mail-search`. */
  script: string;
  appId?: AppleAppId;
  argCount: number;
  /** Per-argument character counts, or the values themselves when traced. */
  argShapes: string[];
  /** Time spent waiting for a concurrency slot before the process started. */
  queueWaitMs: number;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  ok: boolean;
  stdoutBytes: number;
  /** Raw, untouched. This is the field that makes the table worth having. */
  stderr: string;
  errorKind?: MacosErrorKind;
  errorNumber?: number;
}

export interface DiagnosticsQuery {
  script?: string;
  appId?: AppleAppId;
  /** Only failures. */
  failedOnly?: boolean;
  limit?: number;
}

export interface DiagnosticsSummary {
  total: number;
  failed: number;
  timedOut: number;
  permissionDenied: number;
  /** Slowest invocation in the window, for spotting a Mail mailbox gone bad. */
  slowestMs: number;
  medianMs: number;
  byScript: { script: string; count: number; failed: number; p95Ms: number }[];
}

export const migrations: Migration[] = [
  {
    id: '001_init',
    description: 'osascript invocation log',
    up: [
      `CREATE TABLE IF NOT EXISTS macos_invocations (
         id             TEXT PRIMARY KEY,
         started_at     TEXT NOT NULL,
         script         TEXT NOT NULL,
         app_id         TEXT,
         arg_count      INTEGER NOT NULL DEFAULT 0,
         arg_shapes     TEXT NOT NULL DEFAULT '[]',
         queue_wait_ms  INTEGER NOT NULL DEFAULT 0,
         duration_ms    INTEGER NOT NULL DEFAULT 0,
         exit_code      INTEGER,
         signal         TEXT,
         timed_out      INTEGER NOT NULL DEFAULT 0,
         ok             INTEGER NOT NULL DEFAULT 0,
         stdout_bytes   INTEGER NOT NULL DEFAULT 0,
         stderr         TEXT NOT NULL DEFAULT '',
         error_kind     TEXT,
         error_number   INTEGER
       );`,
      `CREATE INDEX IF NOT EXISTS macos_invocations_recent
         ON macos_invocations (started_at DESC);`,
      `CREATE INDEX IF NOT EXISTS macos_invocations_script
         ON macos_invocations (script, started_at DESC);`,
    ],
  },
  {
    id: '002_permissions',
    description: 'last known permission state per app',
    up: [
      `CREATE TABLE IF NOT EXISTS macos_permissions (
         key           TEXT PRIMARY KEY,
         kind          TEXT NOT NULL,
         app_id        TEXT,
         state         TEXT NOT NULL,
         checked_at    TEXT NOT NULL,
         error_number  INTEGER,
         detail        TEXT NOT NULL DEFAULT ''
       );`,
    ],
  },
];

export interface DiagnosticsOptions {
  /** How many invocations to keep in memory. Default 200. */
  ringSize?: number;
  /** How many rows to keep in SQLite. Default 2000. */
  retainRows?: number;
  /** Longest stderr kept per row. Default 4 KiB. */
  maxStderrBytes?: number;
}

/**
 * The recorder. Usable with no database at all — the ring buffer works before
 * `start()` and in tests, which is deliberate: diagnostics that only exist once
 * everything is wired up are missing exactly when startup is what broke.
 */
export class Diagnostics {
  private readonly ring: InvocationRecord[] = [];

  private readonly ringSize: number;

  private readonly retainRows: number;

  private readonly maxStderrBytes: number;

  private db: Db | null = null;

  private sinceLastPrune = 0;

  constructor(options: DiagnosticsOptions = {}) {
    this.ringSize = options.ringSize ?? 200;
    this.retainRows = options.retainRows ?? 2000;
    this.maxStderrBytes = options.maxStderrBytes ?? 4096;
  }

  attach(db: Db): void {
    this.db = db;
  }

  detach(): void {
    this.db = null;
  }

  /** Argument shapes for a record: lengths, or values when tracing is on. */
  static shapeArgs(args: readonly string[]): string[] {
    if (argsAreTraced()) return [...args];
    return args.map((arg) => `len:${arg.length}`);
  }

  record(entry: InvocationRecord): void {
    const trimmed: InvocationRecord = {
      ...entry,
      stderr: entry.stderr.slice(-this.maxStderrBytes),
    };
    this.ring.push(trimmed);
    while (this.ring.length > this.ringSize) this.ring.shift();

    const db = this.db;
    if (!db) return;
    try {
      db.run(
        `INSERT OR REPLACE INTO macos_invocations
           (id, started_at, script, app_id, arg_count, arg_shapes, queue_wait_ms,
            duration_ms, exit_code, signal, timed_out, ok, stdout_bytes, stderr,
            error_kind, error_number)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          trimmed.id,
          trimmed.startedAt,
          trimmed.script,
          trimmed.appId ?? null,
          trimmed.argCount,
          JSON.stringify(trimmed.argShapes),
          Math.round(trimmed.queueWaitMs),
          Math.round(trimmed.durationMs),
          trimmed.exitCode,
          trimmed.signal,
          trimmed.timedOut,
          trimmed.ok,
          trimmed.stdoutBytes,
          trimmed.stderr,
          trimmed.errorKind ?? null,
          trimmed.errorNumber ?? null,
        ],
      );
    } catch {
      // A diagnostics write must never take down the call it is describing.
      return;
    }

    this.sinceLastPrune += 1;
    if (this.sinceLastPrune >= 100) {
      this.sinceLastPrune = 0;
      this.prune();
    }
  }

  private prune(): void {
    const db = this.db;
    if (!db) return;
    try {
      db.run(
        `DELETE FROM macos_invocations WHERE id NOT IN (
           SELECT id FROM macos_invocations ORDER BY started_at DESC LIMIT ?
         )`,
        [this.retainRows],
      );
    } catch {
      /* best effort */
    }
  }

  /** Most recent first. Reads the ring, falling back to SQLite for history. */
  recent(query: DiagnosticsQuery = {}): InvocationRecord[] {
    const limit = query.limit ?? 50;
    const fromRing = [...this.ring]
      .reverse()
      .filter((entry) => matches(entry, query));
    if (fromRing.length >= limit || !this.db) return fromRing.slice(0, limit);

    // Older than the ring: go to disk. The ring is authoritative for anything
    // it still holds, so rows it already covers are filtered out by id.
    const seen = new Set(fromRing.map((entry) => entry.id));
    const rows = this.db.all(
      `SELECT * FROM macos_invocations ORDER BY started_at DESC LIMIT ?`,
      [Math.max(limit * 4, 200)],
    );
    const out = [...fromRing];
    for (const row of rows) {
      const entry = rowToRecord(row);
      if (seen.has(entry.id)) continue;
      if (!matches(entry, query)) continue;
      out.push(entry);
      if (out.length >= limit) break;
    }
    return out;
  }

  summary(windowSize = 200): DiagnosticsSummary {
    const entries = this.recent({ limit: windowSize });
    const durations = entries
      .map((entry) => entry.durationMs)
      .sort((a, b) => a - b);
    const byScript = new Map<string, number[]>();
    const failsByScript = new Map<string, number>();
    for (const entry of entries) {
      const list = byScript.get(entry.script) ?? [];
      list.push(entry.durationMs);
      byScript.set(entry.script, list);
      if (!entry.ok) {
        failsByScript.set(
          entry.script,
          (failsByScript.get(entry.script) ?? 0) + 1,
        );
      }
    }
    return {
      total: entries.length,
      failed: entries.filter((entry) => !entry.ok).length,
      timedOut: entries.filter((entry) => entry.timedOut).length,
      permissionDenied: entries.filter(
        (entry) => entry.errorKind === 'permission-denied',
      ).length,
      slowestMs: durations.length > 0 ? durations[durations.length - 1] : 0,
      medianMs: percentile(durations, 0.5),
      byScript: [...byScript.entries()].map(([script, list]) => ({
        script,
        count: list.length,
        failed: failsByScript.get(script) ?? 0,
        p95Ms: percentile(
          [...list].sort((a, b) => a - b),
          0.95,
        ),
      })),
    };
  }

  clear(): void {
    this.ring.length = 0;
  }
}

function matches(entry: InvocationRecord, query: DiagnosticsQuery): boolean {
  if (query.script && entry.script !== query.script) return false;
  if (query.appId && entry.appId !== query.appId) return false;
  if (query.failedOnly && entry.ok) return false;
  return true;
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[index];
}

function rowToRecord(row: Row): InvocationRecord {
  let argShapes: string[] = [];
  try {
    const parsed = JSON.parse(String(row.arg_shapes ?? '[]')) as unknown;
    if (Array.isArray(parsed)) argShapes = parsed.map((v) => String(v));
  } catch {
    argShapes = [];
  }
  return {
    id: String(row.id),
    startedAt: String(row.started_at),
    script: String(row.script),
    appId: (row.app_id as AppleAppId | null) ?? undefined,
    argCount: Number(row.arg_count ?? 0),
    argShapes,
    queueWaitMs: Number(row.queue_wait_ms ?? 0),
    durationMs: Number(row.duration_ms ?? 0),
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
    signal: row.signal === null ? null : String(row.signal),
    timedOut: Number(row.timed_out ?? 0) === 1,
    ok: Number(row.ok ?? 0) === 1,
    stdoutBytes: Number(row.stdout_bytes ?? 0),
    stderr: String(row.stderr ?? ''),
    errorKind: (row.error_kind as MacosErrorKind | null) ?? undefined,
    errorNumber:
      row.error_number === null ? undefined : Number(row.error_number),
  };
}

/** A blank record with the fields a caller always fills. */
export function startRecord(
  id: string,
  script: string,
  appId: AppleAppId | undefined,
  args: readonly string[],
): InvocationRecord {
  return {
    id,
    startedAt: nowIso(),
    script,
    appId,
    argCount: args.length,
    argShapes: Diagnostics.shapeArgs(args),
    queueWaitMs: 0,
    durationMs: 0,
    exitCode: null,
    signal: null,
    timedOut: false,
    ok: false,
    stdoutBytes: 0,
    stderr: '',
  };
}
