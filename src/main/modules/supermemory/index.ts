/**
 * The `supermemory` module — the app's memory engine.
 *
 * Memory is now backed by a local supermemory server (see {@link createSupervisor}):
 * on-device vector store, on-device embeddings, and fact extraction routed
 * through the user's own Claude via a local OpenAI-compatible shim
 * ({@link createLlmShim}). Nothing needs an external key, and memories, embeddings
 * and extraction all stay on the machine.
 *
 * This module owns the agent-facing tools — `memory_store` and `memory_search` —
 * and the `memory:*` IPC the Memory screen reads (list / search / add / forget /
 * status). It is the whole memory system; the old file-vault module is gone.
 *
 * `memory_store` feeds raw content to supermemory, which extracts the atomic
 * facts itself (splitting compound statements, updating the profile, and
 * superseding contradictions — "I love pizza" then "I love burgers" replaces
 * rather than duplicates). So the agent does not decide *what* the memory is; it
 * decides *when* something is worth remembering, and hands over the text.
 */
import { z } from 'zod';
import { defineTool } from '../types';
import type {
  AnyToolDefinition,
  AppModule,
  IpcHandlerMap,
  ModuleContext,
} from '../types';
import type { Logger } from '../../infra/logger';
import type {
  MemoryEngineStatus,
  MemoryItem,
  MemoryPage,
} from '../../../shared/supermemory';
import { createLlmShim } from './shim';
import type { LlmShim } from './shim';
import { createSupervisor } from './supervisor';
import type { SupermemorySupervisor } from './supervisor';
import { createSupermemoryClient } from './client';
import type { SupermemoryClient } from './client';

export interface SupermemoryModule extends AppModule {
  /** Push settings in (enabled/port/autoCapture). */
  configure(settings: { enabled?: boolean; port?: number }): void;
  /** True once the local server is answering. */
  isReady(): boolean;
}

/** Longest memory content a single store call accepts. */
const MAX_STORE_CHARS = 20_000;

/** How often the background loop looks for failed memories to retry. */
const RETRY_SWEEP_MS = 5 * 60_000;
/** Don't retry the same document forever — give up after this many attempts. */
const MAX_RETRIES_PER_DOC = 3;

export function createSupermemoryModule(): SupermemoryModule {
  let logger: Logger | null = null;
  let shim: LlmShim | null = null;
  let supervisor: SupermemorySupervisor | null = null;
  let client: SupermemoryClient | null = null;
  let enabled = true;
  let port = 8787;
  let retryTimer: NodeJS.Timeout | null = null;
  /** How many times we've retried each doc id, so we stop after a few. */
  const retryCounts = new Map<string, number>();

  /** The client, or a clear error when the engine is off/not ready. */
  const requireClient = (): SupermemoryClient => {
    if (!enabled) {
      throw new Error('The memory engine is turned off in Settings.');
    }
    if (!client || !supervisor?.ready) {
      throw new Error(
        'The memory engine is still starting up. Try again in a moment.',
      );
    }
    return client;
  };

  const StoreInput = z.object({
    content: z
      .string()
      .min(1)
      .max(MAX_STORE_CHARS)
      .describe(
        'The thing to remember, in plain language — a fact, preference, ' +
          'decision, or detail about the user. State it plainly; the memory ' +
          'engine extracts and organises the atomic facts itself.',
      ),
  });

  const SearchInput = z.object({
    query: z
      .string()
      .min(1)
      .max(500)
      .describe(
        'What to recall, e.g. "food preferences" or "where they live".',
      ),
    limit: z
      .number()
      .int()
      .positive()
      .max(25)
      .default(8)
      .describe('Maximum memories to return.'),
  });

  const store = defineTool<z.infer<typeof StoreInput>>({
    name: 'memory_store',
    description:
      'Remember something about the user for the long term — a preference, ' +
      'fact, decision, or detail worth recalling in future conversations ' +
      '(e.g. "the user prefers burgers over pizza", "the user lives in ' +
      'Bangalore"). Call this whenever the user reveals something durable, ' +
      'without being asked. The engine extracts the atomic facts, keeps the ' +
      'profile current, and supersedes anything it contradicts.',
    inputSchema: StoreInput,
    // Not gated: this is the app's own on-device memory, not an outward-facing
    // side effect. It appears in the chat as a tool call, so it is never silent.
    sideEffecting: false,
    annotations: { title: 'Remember this' },
    handler: async (input) => {
      const result = await requireClient().add(input.content);
      return {
        ok: true,
        queued: result.id,
        note: 'Saved to memory. Facts are extracted in the background.',
      };
    },
  });

  const search = defineTool<z.infer<typeof SearchInput>>({
    name: 'memory_search',
    description:
      'Recall what you remember about the user — preferences, facts, past ' +
      'decisions. Returns short remembered statements ranked by relevance. ' +
      'Use this before answering anything that depends on who the user is or ' +
      'what they like.',
    inputSchema: SearchInput,
    sideEffecting: false,
    annotations: { title: 'Recall memory', readOnlyHint: true },
    handler: async (input) => {
      const hits = await requireClient().search(input.query, {
        limit: input.limit,
      });
      return {
        count: hits.length,
        memories: hits.map((hit) => ({
          id: hit.id,
          memory: hit.memory,
          relevance: Number(hit.similarity.toFixed(3)),
        })),
      };
    },
  });

  const ListInput = z.object({
    limit: z
      .number()
      .int()
      .positive()
      .max(200)
      .default(50)
      .describe('Maximum items to return, newest first.'),
  });

  const list = defineTool<z.infer<typeof ListInput>>({
    name: 'memory_list',
    description:
      'List everything currently remembered about the user, newest first. Use ' +
      'this to review the whole memory, or to find the id of a memory you want ' +
      'to update or forget.',
    inputSchema: ListInput,
    sideEffecting: false,
    annotations: { title: 'List memories', readOnlyHint: true },
    handler: async (input) => {
      const page = await requireClient().list({ limit: input.limit });
      return {
        count: page.items.length,
        memories: page.items.map((item) => ({
          id: item.id,
          memory: item.memory,
          status: item.status,
        })),
      };
    },
  });

  const ForgetInput = z.object({
    id: z
      .string()
      .min(1)
      .describe('The memory id to delete, from memory_list or memory_search.'),
  });

  const forget = defineTool<z.infer<typeof ForgetInput>>({
    name: 'memory_forget',
    description:
      'Delete one memory by id (get the id from memory_list or memory_search). ' +
      'Use this when the user asks you to forget something, or a memory is wrong.',
    inputSchema: ForgetInput,
    // A delete is a real change, but to the app's own local memory — not an
    // outward side effect. It shows in chat as a tool call, so it is not silent.
    sideEffecting: false,
    annotations: { title: 'Forget a memory' },
    handler: async (input) => {
      const ok = await requireClient().forget(input.id);
      return ok
        ? { ok: true, forgotten: input.id }
        : { ok: false, error: `Could not forget memory "${input.id}".` };
    },
  });

  const UpdateInput = z.object({
    id: z
      .string()
      .min(1)
      .describe('The memory id to replace, from memory_list or memory_search.'),
    content: z
      .string()
      .min(1)
      .max(MAX_STORE_CHARS)
      .describe('The corrected fact to remember in its place.'),
  });

  const update = defineTool<z.infer<typeof UpdateInput>>({
    name: 'memory_update',
    description:
      'Replace a memory: forget the one with the given id and store the ' +
      'corrected fact, in one step. Note the engine also supersedes outdated ' +
      'facts on its own when you memory_store a contradicting one — use this ' +
      'only when you specifically want to replace a known id.',
    inputSchema: UpdateInput,
    sideEffecting: false,
    annotations: { title: 'Update a memory' },
    handler: async (input) => {
      const c = requireClient();
      await c.forget(input.id).catch(() => false);
      const result = await c.add(input.content);
      return {
        ok: true,
        replaced: input.id,
        queued: result.id,
        note: 'Replaced. The new fact is extracted in the background.',
      };
    },
  });

  const tools: AnyToolDefinition[] = [store, search, list, forget, update];

  /** Whether the engine is up, for the UI to show a "starting…" state. */
  const engineStatus = (): MemoryEngineStatus => ({
    ready: Boolean(supervisor?.ready),
    enabled,
  });

  /** An empty, not-ready page — returned when the engine is off/starting. */
  const emptyPage = (): MemoryPage => ({
    items: [],
    total: 0,
    page: 1,
    totalPages: 0,
    ready: false,
  });

  /**
   * Find failed memories and retry their extraction. Extraction is occasionally
   * flaky (the model returns prose instead of tool calls), and a fresh attempt
   * usually succeeds — so a periodic sweep quietly heals the vault. Each doc is
   * retried at most {@link MAX_RETRIES_PER_DOC} times so a genuinely-broken one
   * doesn't loop forever.
   */
  const sweepFailed = async (): Promise<void> => {
    if (!client || !supervisor?.ready) return;
    let failed: string[] = [];
    try {
      failed = await client.failedIds();
    } catch {
      return;
    }
    for (const id of failed) {
      const tries = retryCounts.get(id) ?? 0;
      if (tries >= MAX_RETRIES_PER_DOC) continue;
      retryCounts.set(id, tries + 1);
      // eslint-disable-next-line no-await-in-loop
      const newId = await client.retry(id).catch(() => null);
      if (newId) {
        // The retry created a new document id; carry the attempt count over so a
        // repeatedly-failing item still hits the cap.
        retryCounts.delete(id);
        retryCounts.set(newId, tries + 1);
        logger?.info('retried failed memory', { from: id, to: newId });
      }
    }
  };

  const ipc: IpcHandlerMap = {
    'memory:status': async () => engineStatus(),

    'memory:list': async (request): Promise<MemoryPage> => {
      if (!client || !supervisor?.ready) return emptyPage();
      const page = await client.list({
        page: request?.page ?? 1,
        limit: request?.limit ?? 50,
      });
      return {
        items: page.items.map((item): MemoryItem => ({
          id: item.id,
          memory: item.memory,
          status: item.status,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        })),
        total: page.total,
        page: page.page,
        totalPages: page.totalPages,
        ready: true,
      };
    },

    'memory:search': async (request): Promise<MemoryPage> => {
      if (!client || !supervisor?.ready) return emptyPage();
      const hits = await client.search(request.query, {
        limit: request?.limit ?? 20,
      });
      return {
        items: hits.map((hit): MemoryItem => ({
          id: hit.id,
          memory: hit.memory,
          status: 'done',
          updatedAt: hit.updatedAt,
          relevance: Number(hit.similarity.toFixed(3)),
        })),
        total: hits.length,
        page: 1,
        totalPages: 1,
        ready: true,
      };
    },

    'memory:add': async (request): Promise<{ id: string }> => {
      const result = await requireClient().add(request.content);
      return { id: result.id };
    },

    'memory:forget': async (request): Promise<{ ok: boolean }> => {
      const ok = await requireClient().forget(request.id);
      return { ok };
    },

    'memory:retry': async (request): Promise<{ ok: boolean }> => {
      const newId = await requireClient().retry(request.id);
      return { ok: newId !== null };
    },
  };

  return {
    id: 'supermemory',
    migrations: [],
    tools,
    ipc,

    configure(next) {
      if (typeof next.enabled === 'boolean') enabled = next.enabled;
      if (typeof next.port === 'number') port = next.port;
    },

    isReady() {
      return Boolean(supervisor?.ready);
    },

    async start(ctx: ModuleContext): Promise<void> {
      logger = ctx.logger;
      if (!enabled) {
        logger.info('memory engine disabled in settings');
        return;
      }
      // Bring up the LLM shim first (the server needs it to boot), then the
      // server, then the client. All local; failures degrade to "memory
      // unavailable" rather than crashing the app.
      shim = createLlmShim({ logger: logger.child('shim') });
      await shim.start();
      supervisor = createSupervisor({
        logger: logger.child('server'),
        llmBaseUrl: shim.baseUrl,
        port,
      });
      client = createSupermemoryClient({
        baseUrl: supervisor.url,
        logger: logger.child('client'),
      });
      // Start the server in the background — installing/booting can take a while
      // (binary + model download on first run) and must not block app start.
      void supervisor.start().catch((error) => {
        logger?.error('memory engine failed to start', {
          error: error instanceof Error ? error.message : String(error),
        });
      });

      // Periodically heal failed extractions in the background.
      retryTimer = setInterval(() => {
        void sweepFailed();
      }, RETRY_SWEEP_MS);
      retryTimer.unref?.();
    },

    async stop(): Promise<void> {
      if (retryTimer) {
        clearInterval(retryTimer);
        retryTimer = null;
      }
      await supervisor?.stop().catch(() => {});
      await shim?.stop().catch(() => {});
      supervisor = null;
      shim = null;
      client = null;
    },
  };
}

export default createSupermemoryModule;
