/**
 * The indexer: files in, index rows out.
 *
 * The rule this whole class exists to enforce is that `memory/*.md` is the
 * source of truth and the database is a cache. So:
 *
 *  - Reads of *content* go to disk, not to the index. `get()` returns what is
 *    in the file right now, even if the watcher has not caught up.
 *  - Every write path is idempotent. `syncAll()` after `syncAll()` inserts
 *    nothing, because a document whose hash is unchanged is skipped outright
 *    and, if it is not skipped, its chunks hash to the ids already stored.
 *  - Deleting the database is a supported operation, not a disaster. The next
 *    `syncAll()` rebuilds every row and every id from the files alone.
 *
 * A user opening a note in their editor and typing is a first-class workflow,
 * so all of this has to hold for changes we did not make.
 */
import path from 'node:path';
import type { Db } from '../../infra/db';
import type { EventBus } from '../../infra/events';
import type { Logger } from '../../infra/logger';
import type { WorkspacePaths } from '../../infra/paths';
import { isInside } from '../../infra/paths';
import { shortHash } from '../../infra/crypto';
import {
  ensureDir,
  listFiles,
  readTextFile,
  statOrNull,
  toPosixPath,
  writeTextFileAtomic,
} from '../../infra/files';
import { nowIso, type Page } from '../../../shared/common';
import {
  MemoryListQuerySchema,
  MemorySearchQuerySchema,
  MemoryWriteRequestSchema,
  type MemoryDoc,
  type MemoryDocContent,
  type MemoryIndexStatus,
  type MemoryListQueryInput,
  type MemorySearchHit,
  type MemorySearchQueryInput,
  type MemoryWriteRequestInput,
} from '../../../shared/memory';
import { chunkMarkdown, parseMarkdown } from './markdown';
import { buildFtsQuery } from './query';
import {
  clearIndex,
  counts,
  deleteDoc,
  docIdForPath,
  getChunkById,
  getDocById,
  getDocByPath,
  getState,
  identifyChunks,
  listDocPaths,
  listDocs,
  searchChunks,
  setState,
  upsertDoc,
  type RankedHit,
} from './store';

/** Only these are indexed. Anything else in the vault is the user's business. */
export const MEMORY_EXTENSION = '.md';

const STATE_LAST_INDEXED = 'lastIndexedAt';

export interface IndexerOptions {
  db: Db;
  paths: WorkspacePaths;
  events: EventBus;
  logger: Logger;
}

export interface IndexFileResult {
  path: string;
  /** False when the content hash was unchanged and nothing was touched. */
  changed: boolean;
  inserted: number;
  updated: number;
  deleted: number;
}

export interface SyncResult {
  scanned: number;
  indexed: number;
  removed: number;
  durationMs: number;
}

/**
 * Turn any caller-supplied path into a vault-relative POSIX path, or throw.
 *
 * Paths reach this from the renderer *and* from an MCP tool call, so traversal
 * is a live concern rather than a theoretical one. `..`, absolute paths, NUL
 * bytes and anything that resolves outside the vault are rejected; the `.md`
 * extension is added rather than demanded, because an agent asked to write
 * `people/ana` means `people/ana.md`.
 */
export function normalizeVaultPath(memoryDir: string, input: string): string {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('A memory path is required');
  if (raw.includes('\0')) throw new Error('Invalid memory path');
  // An absolute path is rejected rather than reinterpreted: silently turning
  // `/etc/passwd` into `<vault>/etc/passwd.md` is safe but astonishing, and a
  // caller that meant a real filesystem path deserves to be told no.
  if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw new Error(`Memory paths are relative to the vault: ${raw}`);
  }

  const cleaned = raw.replace(/\\/g, '/');
  const withExtension = /\.md$/i.test(cleaned) ? cleaned : `${cleaned}${MEMORY_EXTENSION}`;

  const absolute = path.resolve(memoryDir, withExtension);
  if (!isInside(memoryDir, absolute) || absolute === path.resolve(memoryDir)) {
    throw new Error(`Refusing a memory path outside the vault: ${raw}`);
  }
  return toPosixPath(path.relative(memoryDir, absolute));
}

export class MemoryIndexer {
  private readonly db: Db;

  private readonly paths: WorkspacePaths;

  private readonly events: EventBus;

  private readonly logger: Logger;

  private indexing = false;

  constructor(options: IndexerOptions) {
    this.db = options.db;
    this.paths = options.paths;
    this.events = options.events;
    this.logger = options.logger;
  }

  get vaultPath(): string {
    return this.paths.memoryDir;
  }

  absolutePath(relativePath: string): string {
    return path.join(this.paths.memoryDir, relativePath);
  }

  /** `true` while a reindex or a watcher batch is in flight. */
  get isIndexing(): boolean {
    return this.indexing;
  }

  /* ---------------------------------------------------------------- */
  /* Status                                                            */
  /* ---------------------------------------------------------------- */

  status(): MemoryIndexStatus {
    const { docCount, chunkCount } = counts(this.db);
    return {
      docCount,
      chunkCount,
      indexing: this.indexing,
      lastIndexedAt: getState(this.db, STATE_LAST_INDEXED),
      vaultPath: this.paths.memoryDir,
    };
  }

  /** Publish the current status. The UI's index badge is driven by this. */
  emitStatus(): MemoryIndexStatus {
    const status = this.status();
    this.events.emit('memory:indexed', { status });
    return status;
  }

  /* ---------------------------------------------------------------- */
  /* Indexing                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Index one file.
   *
   * Returns `changed: false` when the file's content hash matches what is
   * already stored, which is the fast path for the watcher: an atomic write we
   * made ourselves fires a `change` event, and this turns it into a no-op
   * instead of a pointless rewrite of every chunk.
   */
  async indexFile(
    relativePath: string,
    options: { force?: boolean } = {},
  ): Promise<IndexFileResult | null> {
    const absolute = this.absolutePath(relativePath);
    const raw = await readTextFile(absolute);
    if (raw === null) {
      // Vanished between the scan and the read. Treat it as a delete.
      const removed = deleteDoc(this.db, relativePath);
      if (removed > 0 || getDocByPath(this.db, relativePath)) {
        this.events.emit('memory:doc-changed', {
          path: relativePath,
          deleted: true,
        });
      }
      return null;
    }

    const contentHash = shortHash(raw, 32);
    const existing = getDocByPath(this.db, relativePath);
    if (
      !options.force &&
      existing &&
      existing.contentHash === contentHash &&
      existing.indexedAt
    ) {
      return {
        path: relativePath,
        changed: false,
        inserted: 0,
        updated: 0,
        deleted: 0,
      };
    }

    const stats = await statOrNull(absolute);
    const parsed = parseMarkdown(relativePath, raw);
    const chunks = identifyChunks(relativePath, chunkMarkdown(parsed));
    const indexedAt = nowIso();
    const modifiedAt = stats
      ? new Date(stats.mtimeMs).toISOString()
      : indexedAt;

    const result = upsertDoc(
      this.db,
      {
        id: docIdForPath(relativePath),
        path: relativePath,
        title: parsed.title,
        tags: parsed.tags,
        frontmatter: parsed.frontmatter,
        excerpt: parsed.excerpt,
        sizeBytes: stats ? stats.size : Buffer.byteLength(raw, 'utf8'),
        contentHash,
        createdAt:
          existing?.createdAt ??
          (stats ? new Date(stats.birthtimeMs || stats.mtimeMs).toISOString() : indexedAt),
        updatedAt: modifiedAt,
        indexedAt,
      },
      chunks,
    );

    this.events.emit('memory:doc-changed', {
      path: relativePath,
      deleted: false,
    });
    this.logger.debug('indexed memory doc', { path: relativePath, ...result });
    return { path: relativePath, changed: true, ...result };
  }

  /** Drop a document from the index. The file itself is not touched. */
  removeFile(relativePath: string): boolean {
    const existed = Boolean(getDocByPath(this.db, relativePath));
    deleteDoc(this.db, relativePath);
    if (existed) {
      this.events.emit('memory:doc-changed', {
        path: relativePath,
        deleted: true,
      });
      this.logger.debug('removed memory doc from index', { path: relativePath });
    }
    return existed;
  }

  /**
   * Walk the vault and make the index match it.
   *
   * `full` clears the index first, which is the "something is wrong, start
   * over" button; the result is byte-identical either way because every id is
   * derived from the files.
   */
  async syncAll(
    options: { force?: boolean; full?: boolean } = {},
  ): Promise<SyncResult> {
    const startedAt = Date.now();
    this.indexing = true;
    this.emitStatus();

    try {
      await ensureDir(this.paths.memoryDir);
      if (options.full) clearIndex(this.db);

      const files = await listFiles(this.paths.memoryDir, {
        recursive: true,
        extensions: [MEMORY_EXTENSION],
        skipHidden: true,
      });

      const onDisk = new Set<string>();
      let indexed = 0;
      for (const file of files) {
        onDisk.add(file.relativePath);
        // Sequential on purpose: sql.js is single-threaded and every write goes
        // through one transaction depth counter.
        // eslint-disable-next-line no-await-in-loop
        const result = await this.indexFile(file.relativePath, {
          force: options.force || options.full,
        });
        if (result?.changed) indexed += 1;
      }

      let removed = 0;
      for (const stored of listDocPaths(this.db)) {
        if (onDisk.has(stored)) continue;
        if (this.removeFile(stored)) removed += 1;
      }

      setState(this.db, STATE_LAST_INDEXED, nowIso());
      await this.db.persist();

      const result: SyncResult = {
        scanned: files.length,
        indexed,
        removed,
        durationMs: Date.now() - startedAt,
      };
      this.logger.info('memory index synchronised', { ...result });
      return result;
    } finally {
      this.indexing = false;
      this.emitStatus();
    }
  }

  /**
   * Apply one watcher batch.
   *
   * Kept separate from {@link syncAll} so a burst of editor saves costs a few
   * file reads rather than a full vault walk.
   */
  async applyChanges(
    changes: { path: string; deleted: boolean }[],
  ): Promise<void> {
    if (changes.length === 0) return;
    this.indexing = true;
    try {
      for (const change of changes) {
        try {
          if (change.deleted) this.removeFile(change.path);
          // eslint-disable-next-line no-await-in-loop
          else await this.indexFile(change.path);
        } catch (cause) {
          this.logger.warn('failed to index memory change', {
            path: change.path,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
      setState(this.db, STATE_LAST_INDEXED, nowIso());
      await this.db.persist();
    } finally {
      this.indexing = false;
      this.emitStatus();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Queries                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Full-text search, ranked in JS from `matchinfo`.
   *
   * Two passes, in this order:
   *
   *  1. **`AND`** — chunks containing every term. These are what the caller
   *     asked for and they always come first, whatever their BM25 score.
   *  2. **`OR`** — run only when the first pass did not fill `limit`, and
   *     appended below. There is no stemmer (the `unicode61` tokeniser folds
   *     case and diacritics but does not stem), so a note saying "allergic to
   *     shellfish" does not match `shellfish allergy` under `AND`. Losing that
   *     result entirely would be worse than showing it in second place.
   *
   * A query with no searchable token returns `[]` rather than throwing — the
   * caller may be an agent relaying text it does not control.
   */
  search(request: MemorySearchQueryInput): MemorySearchHit[] {
    const query = MemorySearchQuerySchema.parse(request);
    const options = {
      pathPrefix: query.pathPrefix
        ? normalizePrefix(query.pathPrefix)
        : undefined,
      tags: query.tags,
      limit: query.limit,
    };

    const hits = this.runSearch(query.query, 'AND', options);
    if (hits.length < query.limit) {
      const seen = new Set(hits.map((hit) => hit.chunk.id));
      for (const hit of this.runSearch(query.query, 'OR', options)) {
        if (seen.has(hit.chunk.id)) continue;
        hits.push(hit);
        if (hits.length >= query.limit) break;
      }
    }

    return hits.map((hit) => ({
      chunk: hit.chunk,
      score: Number(hit.score.toFixed(6)),
      snippet: hit.snippet,
      docTitle: hit.docTitle,
      updatedAt: hit.updatedAt || nowIso(),
    }));
  }

  private runSearch(
    raw: string,
    operator: 'AND' | 'OR',
    options: { pathPrefix?: string; tags?: string[]; limit: number },
  ): RankedHit[] {
    const built = buildFtsQuery(raw, operator);
    if (!built) return [];
    try {
      return searchChunks(this.db, built, options);
    } catch (cause) {
      // Should be unreachable — the expression is built from a whitelist — but
      // a search that throws would take down a run, and a search that returns
      // nothing will not.
      this.logger.warn('memory search failed', {
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return [];
    }
  }

  /** A doc plus its body, read from disk. Null when the file is gone. */
  async get(request: {
    id?: string;
    path?: string;
  }): Promise<MemoryDocContent | null> {
    let doc: MemoryDoc | undefined;
    if (request.id) {
      doc = getDocById(this.db, request.id);
      if (!doc) {
        // Accept a chunk id too: it is what a search result hands the caller.
        const chunk = getChunkById(this.db, request.id);
        if (chunk) doc = getDocById(this.db, chunk.docId);
      }
    }
    if (!doc && request.path) {
      doc = getDocByPath(
        this.db,
        normalizeVaultPath(this.paths.memoryDir, request.path),
      );
    }
    if (!doc) return null;

    const content = await readTextFile(this.absolutePath(doc.path));
    if (content === null) {
      // The index outlived the file. Correct it rather than lie to the caller.
      this.removeFile(doc.path);
      return null;
    }
    return { doc, content };
  }

  list(request: MemoryListQueryInput): Page<MemoryDoc> {
    const query = MemoryListQuerySchema.parse(request);
    return listDocs(this.db, {
      ...query,
      pathPrefix: query.pathPrefix
        ? normalizePrefix(query.pathPrefix)
        : undefined,
    });
  }

  /* ---------------------------------------------------------------- */
  /* Writes                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Write a note and index it.
   *
   * The file is written first and atomically, because the file is the record.
   * Indexing happens inline so the caller gets a doc that already reflects the
   * write; the watcher will also see it, find the hash unchanged, and do
   * nothing.
   */
  async write(request: MemoryWriteRequestInput): Promise<MemoryDoc> {
    const parsed = MemoryWriteRequestSchema.parse(request);
    const relativePath = normalizeVaultPath(
      this.paths.memoryDir,
      parsed.path,
    );
    const absolute = this.absolutePath(relativePath);

    let content = parsed.content;
    if (parsed.append) {
      const existing = (await readTextFile(absolute)) ?? '';
      const separator = !existing || existing.endsWith('\n') ? '' : '\n';
      content = `${existing}${separator}${parsed.content}`;
    }
    if (content && !content.endsWith('\n')) content += '\n';

    await ensureDir(path.dirname(absolute));
    await writeTextFileAtomic(absolute, content);
    await this.indexFile(relativePath, { force: true });
    setState(this.db, STATE_LAST_INDEXED, nowIso());
    await this.db.persist();
    this.emitStatus();

    const doc = getDocByPath(this.db, relativePath);
    if (!doc) throw new Error(`Failed to index ${relativePath} after writing`);
    return doc;
  }
}

/** Vault-relative, POSIX, no leading slash — the form `path` is stored in. */
function normalizePrefix(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\/+/, '');
}
