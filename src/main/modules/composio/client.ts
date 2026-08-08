/**
 * A thin wrapper over the Composio SDK.
 *
 * `@composio/core` is ESM-only, and this app's main process bundles as
 * CommonJS, so the client is loaded through a dynamic `import()` — the one
 * interop that works from here. The rest of the app never imports the SDK
 * directly; it goes through this wrapper, which keeps the surface small and the
 * dynamic import in one place.
 *
 * Each end user brings their own Composio API key: the key represents their own
 * Composio org, so their connected accounts (Gmail, Slack, …) live entirely in
 * their account. We scope everything to a single `userId` — a local identity,
 * since the key already isolates the user.
 */

/** The user scope for all Composio calls. The key isolates users; this is local. */
export const COMPOSIO_USER_ID = 'default';

export interface ComposioConnection {
  id: string;
  toolkitSlug: string;
  status: string;
}

export interface ComposioToolSummary {
  slug: string;
  name: string;
  description: string;
  toolkitSlug: string;
  inputSchema: unknown;
}

/** The narrow slice of the SDK we use, so tests can fake it. */
interface ComposioSdk {
  connectedAccounts: {
    list(query?: unknown): Promise<unknown>;
  };
  tools: {
    get(userId: string, filters: unknown): Promise<unknown>;
    execute(slug: string, body: unknown): Promise<unknown>;
  };
}

export interface ComposioClient {
  /** Confirm the key works by making a cheap authenticated call. */
  verify(): Promise<{ ok: boolean; error?: string }>;
  /**
   * Every ACTIVE connected account. Connections are made on Composio's own
   * website (their UI owns the OAuth flow); we just read what is connected.
   */
  listConnections(): Promise<ComposioConnection[]>;
  /** The tools available for one connected toolkit. */
  toolsForToolkit(toolkitSlug: string): Promise<ComposioToolSummary[]>;
  /** Execute one Composio tool. */
  execute(slug: string, args: Record<string, unknown>): Promise<unknown>;
}

/** Pull the tool-descriptor array out of whatever shape `tools.get` returns. */
function toDescriptorList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const items = (raw as { items?: unknown[] })?.items;
  return Array.isArray(items) ? items : [];
}

/** Load the ESM SDK and build a client for one API key. */
export async function createComposioClient(
  apiKey: string,
): Promise<ComposioClient> {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const dynamicImport = new Function('m', 'return import(m)') as (
    m: string,
  ) => Promise<{ Composio: new (opts: { apiKey: string }) => ComposioSdk }>;
  const { Composio } = await dynamicImport('@composio/core');
  const sdk = new Composio({ apiKey });

  return {
    async verify() {
      try {
        await sdk.connectedAccounts.list({
          userIds: [COMPOSIO_USER_ID],
          limit: 1,
        });
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async listConnections() {
      // No userId filter: connections made in the user's own Composio account
      // (e.g. from the dashboard) often have no userId, and the API key already
      // scopes to their org — so filtering by our local 'default' id would hide
      // their existing connections.
      const response = (await sdk.connectedAccounts.list({
        statuses: ['ACTIVE'],
      })) as { items?: unknown[] };
      const items = Array.isArray(response.items) ? response.items : [];
      return items.map((raw) => {
        const item = raw as {
          id?: string;
          status?: string;
          toolkit?: { slug?: string };
        };
        return {
          id: String(item.id ?? ''),
          toolkitSlug: String(item.toolkit?.slug ?? ''),
          status: String(item.status ?? ''),
        };
      });
    },

    async toolsForToolkit(toolkitSlug) {
      const raw = (await sdk.tools.get(COMPOSIO_USER_ID, {
        toolkits: [toolkitSlug],
      })) as unknown;
      // The default provider returns an array of tool descriptors. Normalise a
      // few shapes defensively — the SDK's wrapper output has churned.
      const list = toDescriptorList(raw);
      return list.map((raw2) => {
        const t = raw2 as {
          slug?: string;
          name?: string;
          function?: {
            name?: string;
            description?: string;
            parameters?: unknown;
          };
          description?: string;
          inputParameters?: unknown;
          toolkit?: { slug?: string };
        };
        const slug = t.slug ?? t.function?.name ?? '';
        return {
          slug: String(slug),
          name: String(t.name ?? t.function?.name ?? slug),
          description: String(t.description ?? t.function?.description ?? ''),
          toolkitSlug: String(t.toolkit?.slug ?? toolkitSlug),
          inputSchema: t.inputParameters ?? t.function?.parameters ?? {},
        };
      });
    },

    async execute(slug, args) {
      return sdk.tools.execute(slug, {
        userId: COMPOSIO_USER_ID,
        arguments: args,
      });
    },
  };
}
