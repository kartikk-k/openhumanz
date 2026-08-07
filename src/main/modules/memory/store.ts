/**
 * The derived index.
 *
 * Everything in here is a cache of what is on disk. `memory/*.md` is the source
 * of truth; delete `assistant.db` and a full rebuild reproduces every row,
 * including the ids — which is why doc ids are derived from the path and chunk
 * ids from the content, never generated randomly.
 *
 * Three tables:
 *  - `memory_docs`   one row per file
 *  - `memory_chunks` one row per chunk, joined to the FTS table by `rowid`
 *  - `memory_fts`    FTS4, `body` (heading + text) and `meta` (title, tags, path)
 *
 * FTS4 rather than FTS5 because sql.js has no FTS5 module and cannot load one.
 * Ranking therefore happens in JS; see `query.ts`.
 *
 * Every statement here uses bound parameters. The only SQL assembled from
 * fragments is the optional `WHERE` in {@link searchChunks}, and the fragments
 * are constants — user values are always `?`.
 */
import type { Db, Row } from '../../infra/db';
import { shortHash, stableStringify } from '../../infra/crypto';
import type { JsonObject, Page } from '../../../shared/common';
import type {
  MemoryChunk,
  MemoryDoc,
  MemoryListQuery,
} from '../../../shared/memory';
import type { Migration } from '../types';
import { normalizeChunkText, type RawChunk } from './markdown';
import {
  MATCHINFO_FORMAT,
  bm25,
  decodeMatchinfo,
  type BuiltQuery,
} from './query';

/** How many rows a single MATCH may pull back before ranking. */
export const SEARCH_CANDIDATE_CAP = 500;

/** `body` outweighs `meta`: a hit in the prose beats a hit in the file name. */
const COLUMN_WEIGHTS = [1, 0.45];

const SNIPPET_START = '‹';
const SNIPPET_END = '›';
const SNIPPET_ELLIPSIS = '…';
/** FTS4 `snippet()` takes the column index *after* the markers, unlike FTS5. */
const SNIPPET_COLUMN = 0;
const SNIPPET_TOKENS = 18;

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

export const migrations: Migration[] = [
  {
    id: '001_init',
    description: 'memory docs, chunks and the FTS4 index',
    up: [
      `CREATE TABLE IF NOT EXISTS memory_docs (
         id            TEXT PRIMARY KEY,
         path          TEXT NOT NULL UNIQUE,
         title         TEXT NOT NULL DEFAULT '',
         tags          TEXT NOT NULL DEFAULT '[]',
         frontmatter   TEXT NOT NULL DEFAULT '{}',
         excerpt       TEXT NOT NULL DEFAULT '',
         size_bytes    INTEGER NOT NULL DEFAULT 0,
         content_hash  TEXT NOT NULL DEFAULT '',
         created_at    TEXT NOT NULL,
         updated_at    TEXT NOT NULL,
         indexed_at    TEXT
       );`,
      `CREATE INDEX IF NOT EXISTS memory_docs_updated
         ON memory_docs (updated_at DESC);`,
      `CREATE TABLE IF NOT EXISTS memory_chunks (
         id          TEXT PRIMARY KEY,
         doc_id      TEXT NOT NULL,
         doc_path    TEXT NOT NULL,
         heading     TEXT NOT NULL DEFAULT '',
         text        TEXT NOT NULL,
         start_line  INTEGER NOT NULL DEFAULT 0,
         end_line    INTEGER NOT NULL DEFAULT 0,
         ordinal     INTEGER NOT NULL DEFAULT 0
       );`,
      `CREATE INDEX IF NOT EXISTS memory_chunks_doc
         ON memory_chunks (doc_id, ordinal);`,
      // FTS4, not FTS5: sql.js ships without the fts5 module and cannot load
      // it (OMIT_LOAD_EXTENSION). unicode61 folds case and diacritics.
      `CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts
         USING fts4(body, meta, tokenize=unicode61);`,
      `CREATE TABLE IF NOT EXISTS memory_state (
         key    TEXT PRIMARY KEY,
         value  TEXT
       );`,
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

/**
 * A doc's id is a hash of its vault-relative path.
 *
 * Deterministic on purpose: the database is derived, so the same file must get
 * the same id after a rebuild, or every link the UI holds breaks.
 */
export function docIdForPath(relativePath: string): string {
  return `md_${shortHash(stableStringify(['memory-doc', relativePath]), 24)}`;
}

/**
 * A chunk's id is a hash of its normalised content, scoped to its document.
 *
 * This is the guarantee that re-ingesting an unchanged file inserts nothing:
 * the ids come out identical, so the reconciler sees an empty add-set. The
 * occurrence counter disambiguates two byte-identical paragraphs in one file;
 * position is deliberately *not* part of the hash, so editing the top of a note
 * does not re-mint every chunk below it.
 */
export function chunkId(
  relativePath: string,
  normalizedText: string,
  occurrence: number,
): string {
  return `mc_${shortHash(
    stableStringify(['memory-chunk', relativePath, occurrence, normalizedText]),
    24,
  )}`;
}

/** Chunks with their content-addressed ids, ready to persist. */
export interface IdentifiedChunk extends RawChunk {
  id: string;
  normalized: string;
}

export function identifyChunks(
  relativePath: string,
  chunks: RawChunk[],
): IdentifiedChunk[] {
  const occurrences = new Map<string, number>();
  return chunks.map((chunk) => {
    const normalized = normalizeChunkText(chunk.text);
    const seen = occurrences.get(normalized) ?? 0;
    occurrences.set(normalized, seen + 1);
    return {
      ...chunk,
      normalized,
      id: chunkId(relativePath, normalized, seen),
    };
  });
}

/* ------------------------------------------------------------------ */
/* Row mapping                                                         */
/* ------------------------------------------------------------------ */

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function rowToDoc(row: Row): MemoryDoc {
  return {
    id: String(row.id),
    path: String(row.path),
    title: String(row.title ?? ''),
    tags: parseJson<string[]>(row.tags, []),
    frontmatter: parseJson<JsonObject>(row.frontmatter, {}),
    excerpt: String(row.excerpt ?? ''),
    sizeBytes: Number(row.size_bytes ?? 0),
    contentHash: String(row.content_hash ?? ''),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    indexedAt: row.indexed_at ? String(row.indexed_at) : undefined,
  };
}

function rowToChunk(row: Row): MemoryChunk {
  return {
    id: String(row.id),
    docId: String(row.doc_id),
    docPath: String(row.doc_path),
    heading: String(row.heading ?? ''),
    text: String(row.text ?? ''),
    startLine: Number(row.start_line ?? 0),
    endLine: Number(row.end_line ?? 0),
    ordinal: Number(row.ordinal ?? 0),
  };
}

/** What goes into the FTS `meta` column: everything about the file itself. */
export function metaText(doc: {
  title: string;
  tags: string[];
  path: string;
}): string {
  return [doc.title, doc.tags.join(' '), doc.path.replace(/[/\\]/g, ' ')]
    .filter(Boolean)
    .join(' ');
}

/** What goes into the FTS `body` column: the chunk plus its heading trail. */
export function bodyText(heading: string, text: string): string {
  return heading ? `${heading}\n${text}` : text;
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

const DOC_COLUMNS =
  'id, path, title, tags, frontmatter, excerpt, size_bytes, content_hash, created_at, updated_at, indexed_at';

export function getDocByPath(db: Db, relativePath: string): MemoryDoc | undefined {
  const row = db.get(
    `SELECT ${DOC_COLUMNS} FROM memory_docs WHERE path = ?`,
    [relativePath],
  );
  return row ? rowToDoc(row) : undefined;
}

export function getDocById(db: Db, id: string): MemoryDoc | undefined {
  const row = db.get(`SELECT ${DOC_COLUMNS} FROM memory_docs WHERE id = ?`, [id]);
  return row ? rowToDoc(row) : undefined;
}

export function listDocPaths(db: Db): string[] {
  return db
    .all<{ path: string }>('SELECT path FROM memory_docs')
    .map((row) => String(row.path));
}

export function listDocs(db: Db, query: MemoryListQuery): Page<MemoryDoc> {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (query.pathPrefix) {
    // substr/= rather than LIKE, so `%` and `_` in a path need no escaping.
    where.push('substr(path, 1, ?) = ?');
    params.push(query.pathPrefix.length, query.pathPrefix);
  }
  if (query.tag) {
    where.push(
      'EXISTS (SELECT 1 FROM json_each(memory_docs.tags) WHERE json_each.value = ?)',
    );
    params.push(query.tag.trim().toLowerCase());
  }

  const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
  const total = Number(
    db.pluck(`SELECT COUNT(*) FROM memory_docs${clause}`, params) ?? 0,
  );
  const rows = db.all(
    `SELECT ${DOC_COLUMNS} FROM memory_docs${clause}
     ORDER BY updated_at DESC, path ASC LIMIT ? OFFSET ?`,
    [...params, query.limit, query.offset],
  );

  return {
    items: rows.map(rowToDoc),
    total,
    limit: query.limit,
    offset: query.offset,
  };
}

export function getChunkById(db: Db, id: string): MemoryChunk | undefined {
  const row = db.get(
    `SELECT id, doc_id, doc_path, heading, text, start_line, end_line, ordinal
     FROM memory_chunks WHERE id = ?`,
    [id],
  );
  return row ? rowToChunk(row) : undefined;
}

export function counts(db: Db): { docCount: number; chunkCount: number } {
  return {
    docCount: Number(db.pluck('SELECT COUNT(*) FROM memory_docs') ?? 0),
    chunkCount: Number(db.pluck('SELECT COUNT(*) FROM memory_chunks') ?? 0),
  };
}

export function getState(db: Db, key: string): string | undefined {
  const value = db.pluck('SELECT value FROM memory_state WHERE key = ?', [key]);
  return value === undefined || value === null ? undefined : String(value);
}

export function setState(db: Db, key: string, value: string): void {
  db.run(
    'INSERT INTO memory_state (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

export interface DocRecord {
  id: string;
  path: string;
  title: string;
  tags: string[];
  frontmatter: JsonObject;
  excerpt: string;
  sizeBytes: number;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  indexedAt: string;
}

export interface ReconcileResult {
  inserted: number;
  updated: number;
  deleted: number;
}

/**
 * Replace a document's index entry, inserting only what is genuinely new.
 *
 * The reconciliation is a set difference over content-addressed ids, which is
 * what makes re-indexing idempotent: identical content yields identical ids,
 * so `toInsert` is empty and no row is duplicated. Runs in one transaction, so
 * a crash mid-write leaves the previous index intact rather than a half-updated
 * one.
 */
export function upsertDoc(
  db: Db,
  doc: DocRecord,
  chunks: IdentifiedChunk[],
): ReconcileResult {
  return db.transaction(() => {
    db.run(
      `INSERT INTO memory_docs
         (id, path, title, tags, frontmatter, excerpt, size_bytes, content_hash,
          created_at, updated_at, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         path = excluded.path,
         title = excluded.title,
         tags = excluded.tags,
         frontmatter = excluded.frontmatter,
         excerpt = excluded.excerpt,
         size_bytes = excluded.size_bytes,
         content_hash = excluded.content_hash,
         updated_at = excluded.updated_at,
         indexed_at = excluded.indexed_at`,
      [
        doc.id,
        doc.path,
        doc.title,
        JSON.stringify(doc.tags),
        JSON.stringify(doc.frontmatter),
        doc.excerpt,
        doc.sizeBytes,
        doc.contentHash,
        doc.createdAt,
        doc.updatedAt,
        doc.indexedAt,
      ],
    );

    const existing = db.all<{
      rid: number;
      id: string;
      heading: string;
      text: string;
      start_line: number;
      end_line: number;
      ordinal: number;
    }>(
      `SELECT rowid AS rid, id, heading, text, start_line, end_line, ordinal
       FROM memory_chunks WHERE doc_id = ?`,
      [doc.id],
    );
    const byId = new Map(existing.map((row) => [String(row.id), row]));
    const wanted = new Set(chunks.map((chunk) => chunk.id));

    let deleted = 0;
    for (const row of existing) {
      if (wanted.has(String(row.id))) continue;
      db.run('DELETE FROM memory_fts WHERE docid = ?', [row.rid]);
      db.run('DELETE FROM memory_chunks WHERE rowid = ?', [row.rid]);
      deleted += 1;
    }

    const meta = metaText(doc);
    let inserted = 0;
    let updated = 0;

    for (const chunk of chunks) {
      const previous = byId.get(chunk.id);
      const body = bodyText(chunk.heading, chunk.text);

      if (!previous) {
        const { lastInsertRowId } = db.run(
          `INSERT INTO memory_chunks
             (id, doc_id, doc_path, heading, text, start_line, end_line, ordinal)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            chunk.id,
            doc.id,
            doc.path,
            chunk.heading,
            chunk.text,
            chunk.startLine,
            chunk.endLine,
            chunk.ordinal,
          ],
        );
        db.run('INSERT INTO memory_fts (docid, body, meta) VALUES (?, ?, ?)', [
          lastInsertRowId,
          body,
          meta,
        ]);
        inserted += 1;
        continue;
      }

      // The chunk survived. Its text is identical by construction (same hash),
      // but its position, heading trail and the document's title/tags may have
      // moved, so the row and its FTS entry are refreshed.
      db.run(
        `UPDATE memory_chunks
           SET doc_path = ?, heading = ?, text = ?, start_line = ?, end_line = ?, ordinal = ?
         WHERE rowid = ?`,
        [
          doc.path,
          chunk.heading,
          chunk.text,
          chunk.startLine,
          chunk.endLine,
          chunk.ordinal,
          previous.rid,
        ],
      );
      db.run('UPDATE memory_fts SET body = ?, meta = ? WHERE docid = ?', [
        body,
        meta,
        previous.rid,
      ]);
      updated += 1;
    }

    return { inserted, updated, deleted };
  });
}

/** Remove a document and everything derived from it. Returns rows removed. */
export function deleteDoc(db: Db, relativePath: string): number {
  return db.transaction(() => {
    const doc = db.get<{ id: string }>(
      'SELECT id FROM memory_docs WHERE path = ?',
      [relativePath],
    );
    if (!doc) return 0;
    const rows = db.all<{ rid: number }>(
      'SELECT rowid AS rid FROM memory_chunks WHERE doc_id = ?',
      [String(doc.id)],
    );
    for (const row of rows) {
      db.run('DELETE FROM memory_fts WHERE docid = ?', [row.rid]);
    }
    db.run('DELETE FROM memory_chunks WHERE doc_id = ?', [String(doc.id)]);
    db.run('DELETE FROM memory_docs WHERE id = ?', [String(doc.id)]);
    return rows.length;
  });
}

/** Drop every indexed row. The files are untouched; this is the derived side. */
export function clearIndex(db: Db): void {
  db.transaction(() => {
    db.run('DELETE FROM memory_fts');
    db.run('DELETE FROM memory_chunks');
    db.run('DELETE FROM memory_docs');
  });
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

export interface RankedHit {
  chunk: MemoryChunk;
  score: number;
  snippet: string;
  docTitle: string;
  docTags: string[];
  updatedAt: string;
}

export interface SearchOptions {
  pathPrefix?: string;
  /** A doc must carry every tag listed. */
  tags?: string[];
  limit: number;
}

/**
 * Run one MATCH and rank the rows in JS.
 *
 * `query.expression` is built by {@link BuiltQuery}, never taken from the user,
 * and it is still bound as a parameter. The candidate cap keeps a two-letter
 * query from materialising the whole vault before ranking.
 */
export function searchChunks(
  db: Db,
  query: BuiltQuery,
  options: SearchOptions,
): RankedHit[] {
  const where: string[] = ['memory_fts MATCH ?'];
  // Projection parameters come first: matchinfo's format, then snippet's
  // markers. They are constants, but they are bound rather than interpolated so
  // that this file contains no assembled SQL values at all.
  const params: (string | number)[] = [
    MATCHINFO_FORMAT,
    SNIPPET_START,
    SNIPPET_END,
    SNIPPET_ELLIPSIS,
    SNIPPET_COLUMN,
    SNIPPET_TOKENS,
    query.expression,
  ];

  if (options.pathPrefix) {
    where.push('substr(d.path, 1, ?) = ?');
    params.push(options.pathPrefix.length, options.pathPrefix);
  }

  const rows = db.all(
    `SELECT c.id, c.doc_id, c.doc_path, c.heading, c.text,
            c.start_line, c.end_line, c.ordinal,
            d.title AS doc_title, d.tags AS doc_tags, d.updated_at,
            matchinfo(memory_fts, ?) AS mi,
            snippet(memory_fts, ?, ?, ?, ?, ?) AS snip
       FROM memory_fts
       JOIN memory_chunks c ON c.rowid = memory_fts.docid
       JOIN memory_docs   d ON d.id = c.doc_id
      WHERE ${where.join(' AND ')}
      LIMIT ?`,
    [...params, SEARCH_CANDIDATE_CAP],
  );

  const wantedTags = (options.tags ?? [])
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);

  const hits: RankedHit[] = [];
  for (const row of rows) {
    const docTags = parseJson<string[]>(row.doc_tags, []);
    if (wantedTags.length > 0 && !wantedTags.every((tag) => docTags.includes(tag))) {
      continue;
    }
    const info = decodeMatchinfo(row.mi);
    const chunk = rowToChunk(row);
    const snippet = String(row.snip ?? '').trim();
    hits.push({
      chunk,
      score: info ? bm25(info, { weights: COLUMN_WEIGHTS }) : 0,
      // A match confined to the `meta` column produces no body snippet; fall
      // back to the head of the chunk so a result is never blank.
      snippet: snippet || chunk.text.slice(0, 200),
      docTitle: String(row.doc_title ?? ''),
      docTags,
      updatedAt: String(row.updated_at ?? ''),
    });
  }

  hits.sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id));
  return hits.slice(0, options.limit);
}
