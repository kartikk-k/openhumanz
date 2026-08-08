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
  /**
   * The Composio entity the account belongs to. Connections made on Composio's
   * dashboard are filed under a Composio-assigned user id (e.g. `pg-test-…`),
   * not our local `default`. Executing or listing a toolkit's tools must use
   * *this* id or Composio answers 404 / "User ID is required". Empty when the
   * raw client did not surface it (then we fall back to {@link COMPOSIO_USER_ID}).
   */
  userId: string;
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
  /**
   * The underlying `@composio/client`. Its responses are snake_case and carry
   * fields the camelCase SDK view strips — notably `user_id`, the entity a
   * connected account belongs to, which `tools.execute` requires, and the tool
   * `tags` (`readOnlyHint` / `createHint` / …) we use to tell reads from writes.
   * Optional so a fake SDK need not provide it.
   */
  client?: {
    connectedAccounts: { list(query?: unknown): Promise<unknown> };
    tools: { list(query?: unknown): Promise<unknown> };
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
  /**
   * Raw tool descriptors (OpenAI function shape) for every ACTIVE toolkit,
   * for building agent tools. Returns [] when nothing is connected.
   */
  rawToolsForConnected(): Promise<unknown[]>;
  /**
   * The slugs of connected-toolkit tools that only *read* — Composio tags them
   * `readOnlyHint` (and no create/update/delete/destructive hint). Everything
   * not in this set is treated as side-effecting and routed through approval.
   * The function-shape descriptors from `rawToolsForConnected` drop these tags,
   * so we read them from the raw client's tool list. Returns an empty set when
   * the raw client is unavailable (then every tool is side-effecting — the
   * safe default).
   */
  readOnlySlugs(): Promise<Set<string>>;
  /** Execute one Composio tool. */
  execute(slug: string, args: Record<string, unknown>): Promise<unknown>;
}

/** Tags that mean a tool writes, overriding a stray `readOnlyHint`. */
const WRITE_HINT = /create|update|delete|destructive|write/i;

/** True when a tool's Composio tags say it only reads. */
function isReadOnlyTags(tags: unknown): boolean {
  if (!Array.isArray(tags)) return false;
  const list = tags.filter((t): t is string => typeof t === 'string');
  return list.includes('readOnlyHint') && !list.some((t) => WRITE_HINT.test(t));
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

  /**
   * Read every ACTIVE connected account, resolving each account's real Composio
   * user id (entity) — the piece `tools.execute` requires. The camelCase SDK
   * view strips `user_id`, so we read it from the underlying raw client where
   * available and fall back to the SDK view (userId empty) otherwise.
   *
   * No userId filter on the list: connections made on Composio's dashboard are
   * filed under a Composio-assigned user id, and the API key already scopes to
   * the org — filtering by our local `default` would hide them all.
   */
  const readConnections = async (): Promise<ComposioConnection[]> => {
    const rawList = sdk.client?.connectedAccounts?.list;
    const response = (await (rawList
      ? sdk.client!.connectedAccounts.list({ statuses: ['ACTIVE'] })
      : sdk.connectedAccounts.list({ statuses: ['ACTIVE'] }))) as {
      items?: unknown[];
    };
    const items = Array.isArray(response.items) ? response.items : [];
    return items.map((raw) => {
      const item = raw as {
        id?: string;
        status?: string;
        toolkit?: { slug?: string };
        // snake_case from the raw client; camelCase from the SDK view.
        user_id?: string;
        userId?: string;
      };
      return {
        id: String(item.id ?? ''),
        toolkitSlug: String(item.toolkit?.slug ?? ''),
        status: String(item.status ?? ''),
        userId: String(item.user_id ?? item.userId ?? ''),
      };
    });
  };

  /**
   * toolkit slug -> the user id that toolkit's connected account belongs to.
   * Cached because every tool call needs it and it changes only when the user
   * connects/disconnects an app (a full refresh rebuilds the client anyway).
   */
  let userIdByToolkit: Map<string, string> | null = null;
  const toolkitUserIds = async (): Promise<Map<string, string>> => {
    if (userIdByToolkit) return userIdByToolkit;
    const map = new Map<string, string>();
    for (const conn of await readConnections()) {
      if (conn.toolkitSlug && !map.has(conn.toolkitSlug)) {
        map.set(conn.toolkitSlug, conn.userId || COMPOSIO_USER_ID);
      }
    }
    userIdByToolkit = map;
    return map;
  };

  /** The user id to execute a tool under, from its slug's toolkit prefix. */
  const userIdForSlug = async (slug: string): Promise<string> => {
    const map = await toolkitUserIds();
    // Tool slugs are `TOOLKIT_ACTION` (e.g. GMAIL_FETCH_EMAILS); the toolkit
    // slug is the lower-cased first segment.
    const toolkit = slug.split('_')[0]?.toLowerCase() ?? '';
    if (map.has(toolkit)) return map.get(toolkit)!;
    // Fall back to the only connected user id if there is exactly one, else the
    // local default (Composio will tell us plainly if that is wrong).
    const distinct = [...new Set(map.values())];
    return distinct.length === 1 ? distinct[0] : COMPOSIO_USER_ID;
  };

  return {
    async verify() {
      try {
        await sdk.connectedAccounts.list({ statuses: ['ACTIVE'], limit: 1 });
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async listConnections() {
      return readConnections();
    },

    async toolsForToolkit(toolkitSlug) {
      const map = await toolkitUserIds();
      const userId = map.get(toolkitSlug) ?? COMPOSIO_USER_ID;
      const raw = (await sdk.tools.get(userId, {
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

    async rawToolsForConnected() {
      const map = await toolkitUserIds();
      const slugs = [...map.keys()];
      if (slugs.length === 0) return [];
      // Fetch each toolkit's tools under the user id that owns its account, so
      // the tools we expose are the ones we can actually execute. (Fetching all
      // toolkits under one id would only work if they shared it.)
      const byUser = new Map<string, string[]>();
      for (const [toolkit, userId] of map) {
        byUser.set(userId, [...(byUser.get(userId) ?? []), toolkit]);
      }
      const out: unknown[] = [];
      for (const [userId, toolkits] of byUser) {
        // eslint-disable-next-line no-await-in-loop
        const raw = (await sdk.tools.get(userId, { toolkits })) as unknown;
        out.push(...toDescriptorList(raw));
      }
      return out;
    },

    async readOnlySlugs() {
      const rawList = sdk.client?.tools?.list;
      if (!rawList) return new Set<string>();
      const map = await toolkitUserIds();
      const readOnly = new Set<string>();
      for (const toolkit of map.keys()) {
        // Page through the toolkit's tools; the list is filtered by
        // `toolkit_slug` (snake_case — the camelCase form is ignored and
        // returns every toolkit).
        let cursor: string | undefined;
        for (let page = 0; page < 20; page += 1) {
          // eslint-disable-next-line no-await-in-loop
          const res = (await sdk.client!.tools.list({
            toolkit_slug: toolkit,
            limit: 100,
            ...(cursor ? { cursor } : {}),
          })) as { items?: unknown[]; next_cursor?: string | null };
          for (const item of res.items ?? []) {
            const t = item as { slug?: string; tags?: unknown };
            if (t.slug && isReadOnlyTags(t.tags)) readOnly.add(String(t.slug));
          }
          cursor = res.next_cursor ?? undefined;
          if (!cursor) break;
        }
      }
      return readOnly;
    },

    async execute(slug, args) {
      const userId = await userIdForSlug(slug);
      return sdk.tools.execute(slug, {
        // Execute under the user id that owns the toolkit's connected account.
        // Connections made on the dashboard belong to a Composio-assigned id,
        // not our local default; using the wrong id yields 404 / "User ID is
        // required with connected account".
        userId,
        arguments: args,
        // Composio refuses a manual `tools.execute` whose resolved toolkit
        // version is "latest" ("Toolkit version not specified") unless we opt
        // out of the version pin. We don't know which toolkit versions a
        // bring-your-own-key user has, and the tools we exposed were themselves
        // fetched at "latest", so we run against "latest" deliberately. The
        // documented risk is only that a future toolkit release could change a
        // tool's behaviour — acceptable for an interactive assistant, and far
        // better than the tool erroring out entirely.
        dangerouslySkipVersionCheck: true,
      } as Record<string, unknown>);
    },
  };
}
