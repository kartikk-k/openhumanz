/**
 * The memory vault.
 *
 * Memory is Markdown files on disk that a human can open and edit. SQLite only
 * holds the index. Every retrieved chunk carries provenance back to a file and
 * a line range, because the memory browser shows it as files — because it is
 * files.
 */
import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema, JsonObjectSchema } from './common';

export const MemoryDocSchema = z.object({
  id: IdSchema,
  /** Path relative to the memory directory, POSIX separators, e.g. `people/ana.md`. */
  path: z.string().min(1),
  title: z.string().default(''),
  tags: z.array(z.string()).default([]),
  /** Parsed YAML front matter, if any. */
  frontmatter: JsonObjectSchema.default({}),
  /** First ~200 characters of body text, for list views. */
  excerpt: z.string().default(''),
  sizeBytes: z.number().int().nonnegative().default(0),
  /** Content hash. Re-index only when this changes. */
  contentHash: z.string().default(''),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  indexedAt: IsoDateTimeSchema.optional(),
});
export type MemoryDoc = z.infer<typeof MemoryDocSchema>;

/** A doc plus its full body. Returned by `memory:get`. */
export const MemoryDocContentSchema = z.object({
  doc: MemoryDocSchema,
  content: z.string(),
});
export type MemoryDocContent = z.infer<typeof MemoryDocContentSchema>;

export const MemoryChunkSchema = z.object({
  id: IdSchema,
  docId: IdSchema,
  docPath: z.string().min(1),
  /** Nearest enclosing Markdown heading, for provenance display. */
  heading: z.string().default(''),
  text: z.string(),
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  ordinal: z.number().int().nonnegative().default(0),
});
export type MemoryChunk = z.infer<typeof MemoryChunkSchema>;

export const MemorySearchHitSchema = z.object({
  chunk: MemoryChunkSchema,
  score: z.number(),
  /** Snippet with match markers, safe to render as plain text. */
  snippet: z.string().default(''),
  docTitle: z.string().default(''),
  /**
   * Tags on the containing doc. `MemorySearchQuery` filters on these, so
   * returning them is what lets a result render the chips it was matched by.
   */
  docTags: z.array(z.string()).default([]),
  updatedAt: IsoDateTimeSchema,
});
export type MemorySearchHit = z.infer<typeof MemorySearchHitSchema>;

export const MemorySearchQuerySchema = z.object({
  query: z.string().min(1),
  tags: z.array(z.string()).optional(),
  pathPrefix: z.string().optional(),
  limit: z.number().int().positive().max(100).default(10),
});
export type MemorySearchQuery = z.infer<typeof MemorySearchQuerySchema>;
export type MemorySearchQueryInput = z.input<typeof MemorySearchQuerySchema>;

export const MemoryListQuerySchema = z.object({
  pathPrefix: z.string().optional(),
  tag: z.string().optional(),
  limit: z.number().int().positive().max(1000).default(200),
  offset: z.number().int().nonnegative().default(0),
});
export type MemoryListQuery = z.infer<typeof MemoryListQuerySchema>;
export type MemoryListQueryInput = z.input<typeof MemoryListQuerySchema>;

export const MemoryGetRequestSchema = z.object({
  /** Either the doc id or its vault-relative path. */
  id: IdSchema.optional(),
  path: z.string().optional(),
});
export type MemoryGetRequest = z.infer<typeof MemoryGetRequestSchema>;

export const MemoryWriteRequestSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  /** Append to the doc instead of replacing it. */
  append: z.boolean().default(false),
});
export type MemoryWriteRequest = z.infer<typeof MemoryWriteRequestSchema>;
export type MemoryWriteRequestInput = z.input<typeof MemoryWriteRequestSchema>;

export const MemoryIndexStatusSchema = z.object({
  docCount: z.number().int().nonnegative(),
  chunkCount: z.number().int().nonnegative(),
  indexing: z.boolean(),
  lastIndexedAt: IsoDateTimeSchema.optional(),
  vaultPath: z.string(),
});
export type MemoryIndexStatus = z.infer<typeof MemoryIndexStatusSchema>;
