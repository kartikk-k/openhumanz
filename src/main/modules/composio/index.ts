/**
 * The `composio` module.
 *
 * The bridge to third-party apps (Gmail, Slack, Calendar…) through the user's
 * own Composio account. It holds the API key (from settings), verifies it,
 * lists what is connected, sends the user to Composio's own site to connect
 * more (their UI owns the OAuth flow), and — the point — turns the connected
 * apps' actions into agent tools that the registry's dynamic-tool provider
 * surfaces in the internal MCP, so chat and Claude Code can use them live.
 *
 * The Composio SDK is reached only through {@link ComposioClient}, which loads
 * the ESM package via dynamic import — a module may not know the SDK is ESM.
 */
import type {
  AnyToolDefinition,
  AppModule,
  IpcHandlerMap,
  ModuleContext,
} from '../types';
import type { Logger } from '../../infra/logger';
import type {
  ComposioConnectResult,
  ComposioStatus,
  ComposioToolInfo,
  ComposioToolkit,
} from '../../../shared/ipc';
import type { ComposioClient } from './client';
import { createComposioClient } from './client';
import { composioToolToDefinition } from './tools';

/**
 * Where the user manages connections. Composio's own dashboard owns the OAuth
 * flow, so "Connect" just sends them here; we re-check status when they return.
 */
const COMPOSIO_DASHBOARD_URL = 'https://platform.composio.dev/connections';

/** A small, curated set of toolkits to surface first. */
const STARTER_TOOLKITS: { slug: string; name: string }[] = [
  { slug: 'gmail', name: 'Gmail' },
  { slug: 'googlecalendar', name: 'Google Calendar' },
  { slug: 'slack', name: 'Slack' },
  { slug: 'notion', name: 'Notion' },
  { slug: 'github', name: 'GitHub' },
  { slug: 'linear', name: 'Linear' },
];

/** Opens a URL in the user's browser. Injected so the module stays testable. */
export interface ComposioWiring {
  openExternal?: (url: string) => Promise<void>;
}

export interface ComposioModule extends AppModule {
  configure(wiring: ComposioWiring): void;
  /** Push the API key from settings (on boot and whenever settings change). */
  setApiKey(key: string): void;
  /**
   * The connected apps' tools, as agent tools. Returned live for the registry's
   * dynamic-tool provider, from a cache that {@link ComposioModule.refreshTools}
   * fills. Empty until the first refresh (or when nothing is connected).
   */
  dynamicTools(): AnyToolDefinition[];
  /** Re-fetch the connected apps' tools and rebuild the cache. */
  refreshTools(): Promise<void>;
}

export function createComposioModule(): ComposioModule {
  let logger: Logger | null = null;
  let events: ModuleContext['events'] | null = null;
  let openExternal: ((url: string) => Promise<void>) | undefined;

  /** The current key and a memoised client for it. */
  let apiKey = '';
  let client: ComposioClient | null = null;
  let clientKey = '';
  /** The connected apps' tools, as agent tools. Rebuilt by refreshTools(). */
  let cachedTools: AnyToolDefinition[] = [];

  /** Build (or reuse) a client for the current key. Null when no key. */
  const getClient = async (): Promise<ComposioClient | null> => {
    if (!apiKey) return null;
    if (client && clientKey === apiKey) return client;
    client = await createComposioClient(apiKey);
    clientKey = apiKey;
    return client;
  };

  /** Rebuild the cached agent tools from the connected apps. */
  const refreshTools = async (): Promise<void> => {
    const c = await getClient().catch(() => null);
    if (!c) {
      cachedTools = [];
      return;
    }
    try {
      const [raw, readOnly] = await Promise.all([
        c.rawToolsForConnected(),
        c.readOnlySlugs().catch(() => new Set<string>()),
      ]);
      const built = raw
        .map((tool) => {
          const slug =
            (
              tool as {
                function?: { name?: string };
                slug?: string;
                name?: string;
              }
            ).function?.name ??
            (tool as { slug?: string }).slug ??
            (tool as { name?: string }).name ??
            '';
          return composioToolToDefinition(
            tool,
            (s, args) => c.execute(s, args),
            readOnly.has(slug),
          );
        })
        .filter((t): t is AnyToolDefinition => t !== null);
      cachedTools = built;
      logger?.info('composio tools refreshed', {
        count: built.length,
        readOnly: built.filter((t) => t.sideEffecting === false).length,
      });
    } catch (error) {
      logger?.error('composio tools refresh failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const readStatus = async (): Promise<ComposioStatus> => {
    if (!apiKey) {
      return { configured: false, verified: false, connectedToolkits: [] };
    }
    try {
      const c = await getClient();
      if (!c)
        return { configured: true, verified: false, connectedToolkits: [] };
      const verify = await c.verify();
      if (!verify.ok) {
        return {
          configured: true,
          verified: false,
          error: verify.error,
          connectedToolkits: [],
        };
      }
      const connections = await c.listConnections();
      return {
        configured: true,
        verified: true,
        connectedToolkits: connections
          .map((conn) => conn.toolkitSlug)
          .filter(Boolean),
      };
    } catch (error) {
      return {
        configured: true,
        verified: false,
        error: error instanceof Error ? error.message : String(error),
        connectedToolkits: [],
      };
    }
  };

  const ipc: IpcHandlerMap = {
    'composio:status': async () => {
      const status = await readStatus();
      // Re-reading status (e.g. after the user returns from connecting on
      // Composio's site) is a good moment to refresh the agent tool cache so a
      // newly-connected app's tools appear without a restart.
      void refreshTools();
      return status;
    },

    'composio:set-key': async (request) => {
      const key = (request.apiKey ?? '').trim();
      apiKey = key;
      client = null;
      clientKey = '';
      // Persist to settings so the key survives a restart. Bootstrap wires the
      // reverse direction (settings -> setApiKey) so both stay in sync.
      events?.emit('composio:save-key', { apiKey: key });
      return readStatus();
    },

    'composio:list-toolkits': async () => {
      let connected: string[] = [];
      try {
        const c = await getClient();
        if (c)
          connected = (await c.listConnections()).map((x) => x.toolkitSlug);
      } catch {
        /* offline / bad key — show the list unconnected */
      }
      const toolkits: ComposioToolkit[] = STARTER_TOOLKITS.map((tk) => ({
        slug: tk.slug,
        name: tk.name,
        connected: connected.includes(tk.slug),
      }));
      return toolkits;
    },

    // Connecting an app happens on Composio's own website — their UI owns the
    // OAuth flow. We just open it in the browser; when the user comes back, a
    // refresh (composio:status) picks up the new connection.
    'composio:connect': async (): Promise<ComposioConnectResult> => {
      if (!apiKey) {
        return {
          opened: false,
          url: COMPOSIO_DASHBOARD_URL,
          error: 'Add your Composio API key first.',
        };
      }
      if (openExternal) {
        await openExternal(COMPOSIO_DASHBOARD_URL).catch(() => {});
      }
      return { opened: true, url: COMPOSIO_DASHBOARD_URL };
    },

    'composio:tools-for': async (request): Promise<ComposioToolInfo[]> => {
      const c = await getClient();
      if (!c) return [];
      try {
        const tools = await c.toolsForToolkit(request.toolkitSlug);
        return tools.map((t) => ({
          slug: t.slug,
          name: t.name,
          description: t.description,
        }));
      } catch (error) {
        logger?.error('composio tools list failed', {
          toolkit: request.toolkitSlug,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    },
  };

  return {
    id: 'composio',
    migrations: [],
    ipc,

    configure(wiring) {
      if (wiring.openExternal) openExternal = wiring.openExternal;
    },

    setApiKey(key: string) {
      const next = (key ?? '').trim();
      if (next === apiKey) return;
      apiKey = next;
      client = null;
      clientKey = '';
      // Rebuild the tool cache for the new key (or clear it when removed).
      void refreshTools();
    },

    dynamicTools() {
      return cachedTools;
    },

    refreshTools,

    async start(ctx: ModuleContext) {
      logger = ctx.logger;
      events = ctx.events;
      // Seed the tool cache from whatever is already connected.
      await refreshTools();
    },
  };
}

export default createComposioModule;
