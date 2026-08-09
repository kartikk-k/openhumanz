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
 * and the `memory:*` supermemory IPC. The older file-vault module keeps its own
 * browser UI, but the agent's memory now lives here.
 *
 * `memory_store` feeds raw content to supermemory, which extracts the atomic
 * facts itself (splitting compound statements, updating the profile, and
 * superseding contradictions — "I love pizza" then "I love burgers" replaces
 * rather than duplicates). So the agent does not decide *what* the memory is; it
 * decides *when* something is worth remembering, and hands over the text.
 */
import { z } from 'zod';
import { defineTool } from '../types';
import type { AnyToolDefinition, AppModule, ModuleContext } from '../types';
import type { Logger } from '../../infra/logger';
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

export function createSupermemoryModule(): SupermemoryModule {
  let logger: Logger | null = null;
  let shim: LlmShim | null = null;
  let supervisor: SupermemorySupervisor | null = null;
  let client: SupermemoryClient | null = null;
  let enabled = true;
  let port = 8787;

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

  const tools: AnyToolDefinition[] = [store, search];

  return {
    id: 'supermemory',
    migrations: [],
    tools,

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
    },

    async stop(): Promise<void> {
      await supervisor?.stop().catch(() => {});
      await shim?.stop().catch(() => {});
      supervisor = null;
      shim = null;
      client = null;
    },
  };
}

export default createSupermemoryModule;
