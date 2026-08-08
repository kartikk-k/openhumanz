/**
 * The `composio` module.
 *
 * The bridge to third-party apps (Gmail, Slack, Calendar…) through the user's
 * own Composio account. This foundation slice: holds the API key (from
 * settings), verifies it, lists what is connected, sends the user to Composio's
 * own site to connect more (their UI owns the OAuth flow), and lists the tools
 * a connected toolkit exposes — enough to prove the pipe end to end.
 *
 * It does NOT yet register those tools with the agent; that is the next step
 * (dynamic tool registration into the MCP surface). Keeping this slice narrow
 * lets us confirm the SDK, the key model, and the desktop OAuth flow first.
 *
 * The Composio SDK is reached only through {@link ComposioClient}, which loads
 * the ESM package via dynamic import — a module may not know the SDK is ESM.
 */
import type { AppModule, IpcHandlerMap, ModuleContext } from '../types';
import type { Logger } from '../../infra/logger';
import type {
  ComposioConnectResult,
  ComposioStatus,
  ComposioToolInfo,
  ComposioToolkit,
} from '../../../shared/ipc';
import type { ComposioClient } from './client';
import { createComposioClient } from './client';

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
}

export function createComposioModule(): ComposioModule {
  let logger: Logger | null = null;
  let events: ModuleContext['events'] | null = null;
  let openExternal: ((url: string) => Promise<void>) | undefined;

  /** The current key and a memoised client for it. */
  let apiKey = '';
  let client: ComposioClient | null = null;
  let clientKey = '';

  /** Build (or reuse) a client for the current key. Null when no key. */
  const getClient = async (): Promise<ComposioClient | null> => {
    if (!apiKey) return null;
    if (client && clientKey === apiKey) return client;
    client = await createComposioClient(apiKey);
    clientKey = apiKey;
    return client;
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
    'composio:status': async () => readStatus(),

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
    },

    async start(ctx: ModuleContext) {
      logger = ctx.logger;
      events = ctx.events;
    },
  };
}

export default createComposioModule;
