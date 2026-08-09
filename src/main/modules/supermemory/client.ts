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
  /** A short natural-language profile of the container, if the server has one. */
  profile(containerTag?: string): Promise<string | null>;
}

export function createSupermemoryClient(
  options: SupermemoryClientOptions,
): SupermemoryClient {
  const { baseUrl, logger } = options;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const root = baseUrl.replace(/\/$/, '');

  const request = async (path: string, body: unknown): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${root}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
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
