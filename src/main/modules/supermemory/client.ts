/**
 * A thin client over the local supermemory server's REST API.
 *
 * Only the three calls the app needs: add a memory (the server extracts atomic
 * facts, updates the profile, and resolves contradictions itself), search, and
 * read the profile. The server runs on loopback and auto-applies its own API key
 * to localhost requests, so no key is needed here.
 *
 * Endpoints verified against server v0.0.7-rc.2:
 *   POST /v3/documents  { content, containerTag }  → { id, status: 'queued' }
 *   POST /v4/search     { q, containerTag }         → { results: [...], total }
 */
import type { Logger } from '../../infra/logger';

/** All memories for one app user live under this container. */
export const DEFAULT_CONTAINER_TAG = 'user_default';

export interface SupermemoryHit {
  id: string;
  /** The atomic remembered fact, e.g. "User's favorite food is burgers." */
  memory: string;
  /** Cosine similarity to the query, 0..1. */
  similarity: number;
  /** Bumped when a fact is superseded rather than duplicated. */
  version?: number;
  updatedAt?: string;
}

/** One remembered item as the list endpoint returns it. */
export interface SupermemoryItem {
  id: string;
  /** The remembered content — the atomic fact or the document summary. */
  memory: string;
  /** 'done' once extracted, 'queued'/'processing' while in flight, 'failed'. */
  status: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SupermemoryList {
  items: SupermemoryItem[];
  total: number;
  page: number;
  totalPages: number;
}

export interface SupermemoryClientOptions {
  /** Base server URL, e.g. `http://127.0.0.1:8787`. */
  baseUrl: string;
  logger: Logger;
  /** Request timeout. Default 15s (add is async and returns immediately). */
  timeoutMs?: number;
}

export interface SupermemoryClient {
  /**
   * Add raw content. The server queues it and asynchronously extracts atomic
   * memories from it (via the LLM shim) — this returns as soon as it's queued.
   */
  add(content: string, containerTag?: string): Promise<{ id: string }>;
  /** Search remembered facts for a query. */
  search(
    query: string,
    options?: { containerTag?: string; limit?: number },
  ): Promise<SupermemoryHit[]>;
  /**
   * List all remembered items, newest first, paginated. Pure REST — no LLM,
   * no extraction; just what the server already holds. Backs the Memory tab.
   */
  list(options?: {
    containerTag?: string;
    page?: number;
    limit?: number;
  }): Promise<SupermemoryList>;
  /** Forget (delete) one memory/document by id. */
  forget(id: string): Promise<boolean>;
  /** The ids of documents whose extraction failed. */
  failedIds(containerTag?: string): Promise<string[]>;
  /**
   * Re-run a document that failed to extract. supermemory has no retry endpoint,
   * so this reads the original content, deletes the failed document, and adds it
   * fresh — which re-runs extraction. Returns the new id, or null on failure.
   */
  retry(id: string, containerTag?: string): Promise<string | null>;
  /** A short natural-language profile of the container, if the server has one. */
  profile(containerTag?: string): Promise<string | null>;
}

export function createSupermemoryClient(
  options: SupermemoryClientOptions,
): SupermemoryClient {
  const { baseUrl, logger } = options;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const root = baseUrl.replace(/\/$/, '');

  const request = async (
    path: string,
    body: unknown,
    method = 'POST',
  ): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${root}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(
          `supermemory ${path} → ${res.status}: ${text.slice(0, 200)}`,
        );
      }
      return text ? JSON.parse(text) : {};
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async add(content, containerTag = DEFAULT_CONTAINER_TAG) {
      const result = (await request('/v3/documents', {
        content,
        containerTag,
      })) as { id?: string };
      logger.debug('supermemory add queued', { id: result.id });
      return { id: String(result.id ?? '') };
    },

    async search(query, opts = {}) {
      const result = (await request('/v4/search', {
        q: query,
        containerTag: opts.containerTag ?? DEFAULT_CONTAINER_TAG,
        ...(opts.limit ? { limit: opts.limit } : {}),
      })) as { results?: unknown[] };
      const rows = Array.isArray(result.results) ? result.results : [];
      return rows.map((raw) => {
        const row = raw as {
          id?: string;
          memory?: string;
          content?: string;
          text?: string;
          similarity?: number;
          version?: number;
          updatedAt?: string;
        };
        return {
          id: String(row.id ?? ''),
          memory: String(row.memory ?? row.content ?? row.text ?? ''),
          similarity: typeof row.similarity === 'number' ? row.similarity : 0,
          version: row.version,
          updatedAt: row.updatedAt,
        };
      });
    },

    async list(opts = {}) {
      const result = (await request('/v3/memories/list', {
        containerTag: opts.containerTag ?? DEFAULT_CONTAINER_TAG,
        page: opts.page ?? 1,
        limit: opts.limit ?? 50,
      })) as {
        memories?: unknown[];
        pagination?: {
          currentPage?: number;
          totalItems?: number;
          totalPages?: number;
        };
      };
      const rows = Array.isArray(result.memories) ? result.memories : [];
      const items = rows.map((raw) => {
        const row = raw as {
          id?: string;
          memory?: string;
          summary?: string;
          title?: string;
          content?: string;
          status?: string;
          createdAt?: string;
          updatedAt?: string;
        };
        return {
          id: String(row.id ?? ''),
          memory: String(
            row.memory ?? row.summary ?? row.title ?? row.content ?? '',
          ),
          status: String(row.status ?? 'unknown'),
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };
      });
      return {
        items,
        total: result.pagination?.totalItems ?? items.length,
        page: result.pagination?.currentPage ?? opts.page ?? 1,
        totalPages: result.pagination?.totalPages ?? 1,
      };
    },

    async forget(id) {
      // Bulk delete works whether or not the document has finished processing;
      // the single-id `DELETE /v3/documents/:id` returns 409 while it is still
      // extracting, so we always use the bulk route with one id.
      try {
        const result = (await request(
          '/v3/documents/bulk',
          { ids: [id] },
          'DELETE',
        )) as { success?: boolean; deletedCount?: number };
        return result.success === true || (result.deletedCount ?? 0) > 0;
      } catch (error) {
        logger.warn('supermemory forget failed', {
          id,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },

    async failedIds(containerTag = DEFAULT_CONTAINER_TAG) {
      // Walk the (small) memory list and collect failed documents.
      const result = (await request('/v3/memories/list', {
        containerTag,
        page: 1,
        limit: 200,
      })) as { memories?: { id?: string; status?: string }[] };
      const rows = Array.isArray(result.memories) ? result.memories : [];
      return rows
        .filter((row) => row.status === 'failed' && row.id)
        .map((row) => String(row.id));
    },

    async retry(id, containerTag = DEFAULT_CONTAINER_TAG) {
      try {
        // Read the original content the document carried.
        const doc = (await request(
          `/v3/documents/${encodeURIComponent(id)}`,
          undefined,
          'GET',
        )) as { content?: string; title?: string };
        const content = doc.content ?? doc.title ?? '';
        if (!content.trim()) return null;
        // Delete the failed document, then add the content fresh so extraction
        // re-runs.
        await request('/v3/documents/bulk', { ids: [id] }, 'DELETE').catch(
          () => undefined,
        );
        const added = (await request('/v3/documents', {
          content,
          containerTag,
        })) as { id?: string };
        return added.id ? String(added.id) : null;
      } catch (error) {
        logger.warn('supermemory retry failed', {
          id,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },

    async profile(containerTag = DEFAULT_CONTAINER_TAG) {
      try {
        const result = (await request('/v4/profile', { containerTag })) as {
          profile?: string;
          description?: string;
        };
        return result.profile ?? result.description ?? null;
      } catch (error) {
        // Profile is a nice-to-have; never fail a caller over it.
        logger.debug('supermemory profile unavailable', {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
  };
}
