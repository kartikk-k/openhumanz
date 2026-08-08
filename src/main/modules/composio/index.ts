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
import { readComposioTool } from './tools';
import type { RouterToolEntry } from './router';
import { createRouterTools } from './router';

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
   * The agent's Composio surface: the three static router tools
   * (`composio_connected_apps` / `composio_app_tools` / `composio_app_execute`).
   * Constant regardless of how many apps are connected — the connected apps'
   * hundreds of tools are held as data behind the router, not put on the surface.
   */
  dynamicTools(): AnyToolDefinition[];
  /** True when the given connected-app tool slug is read-only (never gated). */
  isReadOnlyTool(slug: string): boolean;
  /** True when the slug is a known connected-app tool. */
  isKnownTool(slug: string): boolean;
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

  /**
   * The connected apps' tools, as data (not agent tools). The agent's surface is
   * the three static router tools; this cache is what they read. Keyed by tool
   * slug so the router can look one up on execute.
   */
  const toolCache = new Map<string, RouterToolEntry>();
  /** Human-readable app names, keyed by slug (e.g. `linear` -> `Linear`). */
  const appNames = new Map<string, string>();

  /** A nice display name for an app slug — from connections, else title-cased. */
  const appDisplayName = (slug: string): string => {
    const known = appNames.get(slug);
    if (known) return known;
    return slug.replace(
      /(^|[-_])(\w)/g,
      (_, sep, ch) => (sep ? ' ' : '') + ch.toUpperCase(),
    );
  };

  /** Build (or reuse) a client for the current key. Null when no key. */
  const getClient = async (): Promise<ComposioClient | null> => {
    if (!apiKey) return null;
    if (client && clientKey === apiKey) return client;
    client = await createComposioClient(apiKey);
    clientKey = apiKey;
    return client;
  };

  /** Rebuild the tool cache from the connected apps. */
  const refreshTools = async (): Promise<void> => {
    const c = await getClient().catch(() => null);
    if (!c) {
      toolCache.clear();
      appNames.clear();
      return;
    }
    try {
      const [raw, readOnly, connections] = await Promise.all([
        c.rawToolsForConnected(),
        c.readOnlySlugs().catch(() => new Set<string>()),
        c.listConnections().catch(() => []),
      ]);

      appNames.clear();
      for (const conn of connections) {
        if (conn.toolkitSlug) {
          appNames.set(conn.toolkitSlug, appDisplayName(conn.toolkitSlug));
        }
      }

      toolCache.clear();
      for (const rawTool of raw) {
        const parsed = readComposioTool(rawTool);
        if (!parsed) continue;
        // Tool slugs are `TOOLKIT_ACTION`; the app is the first segment.
        const app = parsed.name.split('_')[0]?.toLowerCase() ?? '';
        toolCache.set(parsed.name, {
          slug: parsed.name,
          app,
          name: parsed.name,
          description: parsed.description,
          parameters: parsed.parameters ?? {},
          readOnly: readOnly.has(parsed.name),
        });
      }
      logger?.info('composio tools refreshed', {
        tools: toolCache.size,
        apps: new Set([...toolCache.values()].map((t) => t.app)).size,
        readOnly: [...toolCache.values()].filter((t) => t.readOnly).length,
      });
    } catch (error) {
      logger?.error('composio tools refresh failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /** Group the cache by app for the `apps()` / `toolsForApp()` router backend. */
  const appsSummary = (): {
    slug: string;
    name: string;
    toolCount: number;
  }[] => {
    const counts = new Map<string, number>();
    for (const t of toolCache.values()) {
      counts.set(t.app, (counts.get(t.app) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([slug, toolCount]) => ({
        slug,
        name: appDisplayName(slug),
        toolCount,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  };

  /** The three router tools, wired to this module's live cache. */
  const routerTools = createRouterTools({
    apps: appsSummary,
    toolsForApp: (app) => {
      const wanted = app.toLowerCase();
      return [...toolCache.values()].filter((t) => t.app === wanted);
    },
    toolBySlug: (slug) => toolCache.get(slug),
    execute: async (slug, args) => {
      const c = await getClient();
      if (!c) throw new Error('Composio is not configured.');
      return c.execute(slug, args);
    },
  });

  /** The read-only status of a Composio tool slug, for the gate's classifier. */
  const isReadOnlyTool = (slug: string): boolean =>
    toolCache.get(slug)?.readOnly ?? false;
  /** Whether a slug is a known connected-app tool. */
  const isKnownTool = (slug: string): boolean => toolCache.has(slug);

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
      // Always the three router tools; they read the live cache internally.
      return routerTools;
    },

    isReadOnlyTool,
    isKnownTool,

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
