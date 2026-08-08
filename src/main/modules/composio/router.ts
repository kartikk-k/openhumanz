/**
 * The Composio tool router — three meta-tools instead of hundreds.
 *
 * Dumping every connected app's tools into the agent's surface does not scale:
 * three apps is already ~280 tools, and the CLI defers them behind ToolSearch,
 * where the model often fails to find the one it needs. With fifty connected
 * apps the surface would be nothing but Composio.
 *
 * So Composio contributes a fixed, tiny surface regardless of how many apps are
 * connected — progressive disclosure, the same shape Composio's own tool-router
 * uses:
 *
 *   composio_connected_apps()                  → which apps are connected
 *   composio_app_tools(app)                    → that app's tools (names + docs)
 *   composio_app_execute(app, tool, arguments) → run one
 *
 * The model lists apps, asks for one app's tools, then executes — paying context
 * only for what it is actually using.
 *
 * Approval still lands on the real action, not on the router: `composio_app_execute`
 * is a generic dispatcher, and its classifier (registered in bootstrap) keys the
 * capability on the `tool` argument and reads the read-only set, so an "always
 * allow" on `LINEAR_LIST_LINEAR_PROJECTS` never authorises `LINEAR_DELETE_ISSUE`,
 * and reads pass through while writes are gated.
 */
import { z } from 'zod';
import type { AnyToolDefinition, ToolDefinition } from '../types';

/** One connected-app tool, as the router holds it. */
export interface RouterToolEntry {
  /** The tool slug, e.g. `LINEAR_LIST_LINEAR_PROJECTS`. */
  slug: string;
  /** Toolkit/app slug, e.g. `linear`. */
  app: string;
  name: string;
  description: string;
  /** JSON Schema for the arguments, shown by `composio_app_tools`. */
  parameters: unknown;
  /** True when the tool only reads (never routed through approval). */
  readOnly: boolean;
}

/** What the router needs from the module: the live tool cache + how to run one. */
export interface RouterBackend {
  /** Connected apps, e.g. `[{ slug: 'linear', name: 'Linear', toolCount: 47 }]`. */
  apps(): { slug: string; name: string; toolCount: number }[];
  /** Every cached tool for one app slug (case-insensitive). */
  toolsForApp(app: string): RouterToolEntry[];
  /** Look one tool up by its slug. */
  toolBySlug(slug: string): RouterToolEntry | undefined;
  /** Execute a tool by slug. */
  execute(slug: string, args: Record<string, unknown>): Promise<unknown>;
}

/** The name the classifier is registered under and the gate dispatches on. */
export const COMPOSIO_EXECUTE_TOOL = 'composio_app_execute';

/**
 * Build the three router tools from a backend. Static: their names and schemas
 * never change, so the agent's surface is constant no matter what is connected.
 */
export function createRouterTools(backend: RouterBackend): AnyToolDefinition[] {
  const connectedApps: ToolDefinition<Record<string, unknown>> = {
    name: 'composio_connected_apps',
    description:
      'List the third-party apps connected through Composio (Gmail, Slack, ' +
      'Linear, …). Call this first to see what is available, then use ' +
      'composio_app_tools to see one app’s tools. Cheap and read-only.',
    inputSchema: z.object({}).passthrough() as z.ZodType<
      Record<string, unknown>
    >,
    sideEffecting: false,
    annotations: { title: 'List connected apps', readOnlyHint: true },
    handler: async () => {
      const apps = backend.apps();
      return {
        apps: apps.map((a) => ({
          app: a.slug,
          name: a.name,
          toolCount: a.toolCount,
        })),
        next: 'Call composio_app_tools with one app to see its tools.',
      };
    },
  };

  const appTools: ToolDefinition<{ app: string }> = {
    name: 'composio_app_tools',
    description:
      'List the tools available for one connected app (e.g. app "linear"). ' +
      'Returns each tool’s slug, description and arguments. Then call ' +
      'composio_app_execute with the tool slug you want. Read-only.',
    inputSchema: z.object({
      app: z
        .string()
        .describe('The app slug from composio_connected_apps, e.g. "linear".'),
    }),
    sideEffecting: false,
    annotations: { title: 'List an app’s tools', readOnlyHint: true },
    handler: async ({ app }) => {
      const tools = backend.toolsForApp(app);
      if (tools.length === 0) {
        const known = backend.apps().map((a) => a.slug);
        return {
          app,
          tools: [],
          error: `No connected app "${app}". Connected apps: ${
            known.join(', ') || '(none)'
          }.`,
        };
      }
      return {
        app,
        tools: tools.map((t) => ({
          tool: t.slug,
          description: t.description,
          readOnly: t.readOnly,
          arguments: t.parameters,
        })),
        next: 'Call composio_app_execute with { app, tool, arguments }.',
      };
    },
  };

  const appExecute: ToolDefinition<{
    app: string;
    tool: string;
    arguments?: Record<string, unknown>;
  }> = {
    name: COMPOSIO_EXECUTE_TOOL,
    description:
      'Run one connected-app tool. Provide the app slug, the tool slug (from ' +
      'composio_app_tools) and its arguments. Writes ask for your approval; ' +
      'reads run directly.',
    inputSchema: z.object({
      app: z.string().describe('App slug, e.g. "linear".'),
      tool: z
        .string()
        .describe(
          'Tool slug from composio_app_tools, e.g. "LINEAR_LIST_LINEAR_PROJECTS".',
        ),
      arguments: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('The tool’s arguments as an object.'),
    }),
    // The gate's classifier decides per call (by the `tool` arg) whether this is
    // side-effecting; the tool-level flag is the fail-closed default.
    sideEffecting: true,
    annotations: { title: 'Run a connected-app tool' },
    summarize: (input) => {
      const entry = backend.toolBySlug(input.tool);
      const verb = entry?.readOnly ? 'Read via' : 'Run';
      return `${verb} ${input.app} · ${input.tool}`;
    },
    handler: async ({ tool, arguments: args }) => {
      const entry = backend.toolBySlug(tool);
      if (!entry) {
        return {
          error: `Unknown tool "${tool}". Call composio_app_tools first to list valid tool slugs.`,
        };
      }
      return backend.execute(tool, args ?? {});
    },
  };

  return [
    connectedApps as AnyToolDefinition,
    appTools as AnyToolDefinition,
    appExecute as AnyToolDefinition,
  ];
}
