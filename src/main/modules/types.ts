/**
 * The module contract.
 *
 * A domain module lives in `src/main/modules/<name>/` and default-exports an
 * {@link AppModule}. It owns its own tables, its slice of the MCP tool surface
 * and its slice of the IPC surface, and it **must not import another module** —
 * cross-module communication goes through the event bus or a service. That rule
 * is enforced by `import/no-restricted-paths`, not by good intentions.
 *
 * Adding a capability should mean: write the module, add it to the registry
 * list. If it requires editing anything else, a boundary has been broken.
 */
import { z } from 'zod';
import type { Db, Migration } from '../infra/db';
import type { EventBus } from '../infra/events';
import type { Logger } from '../infra/logger';
import type { WorkspacePaths } from '../infra/paths';
import type { IpcChannel, IpcRequest, IpcResponse } from '../../shared/ipc';

export type { Migration } from '../infra/db';

/* ------------------------------------------------------------------ */
/* Context                                                             */
/* ------------------------------------------------------------------ */

/**
 * Everything a module is given, and nothing else. No electron, no registry, no
 * sibling modules — if you need something that is not here, it belongs on the
 * event bus or in a service.
 */
export interface ModuleContext {
  /** The module's own id, for log lines and migration namespacing. */
  readonly moduleId: string;
  /** Shared database handle. Tables are namespaced by convention: `<id>_*`. */
  readonly db: Db;
  /** Already scoped to this module. */
  readonly logger: Logger;
  readonly events: EventBus;
  readonly paths: WorkspacePaths;
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

/** What a tool handler is told about the call it is serving. */
export interface ToolCallContext {
  /** Present when the call came from an engine step. */
  readonly runId?: string;
  readonly stepId?: string;
  readonly toolCallId?: string;
  /** Aborted when the run is cancelled. Long tools should honour it. */
  readonly signal?: AbortSignal;
  readonly logger: Logger;
}

/**
 * One tool on the MCP surface.
 *
 * `sideEffecting` is the flag the approval gate reads. It is not a hint: `true`
 * means the call is routed through the gate before the handler runs, and a
 * handler for a `true` tool may find itself invoked a second time after a human
 * approves, so handlers must be safe to re-dispatch.
 *
 * Keep results compact. Truncate lists, return counts, offer fetch-by-id.
 */
export interface ToolDefinition<TInput = unknown> {
  /** Unique across every module. Namespaced by convention: `memory_search`. */
  name: string;
  /** One or two sentences. This is what the model reads to choose the tool. */
  description: string;
  /** Zod schema for the arguments; also the JSON Schema published over MCP. */
  inputSchema: z.ZodType<TInput, any>;
  /** True when calling this changes something outside our process. */
  sideEffecting: boolean;
  /**
   * Plain-language rendering for the approval card, e.g.
   * "Send an email to ana@example.com". Falls back to name + arguments.
   */
  summarize?(input: TInput): string;
  /**
   * The implementation. The return value is JSON-serialised into the MCP
   * result, so keep it small and stable.
   */
  handler(input: TInput, ctx: ToolCallContext): Promise<unknown> | unknown;
  /** MCP-style hints. Advisory; the gate trusts `sideEffecting`, not these. */
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
}

/**
 * A tool of unknown input shape. Use this in collections — `ToolDefinition[]`
 * would make the handler parameter contravariant and reject concrete tools.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any>;

/** JSON Schema shape MCP expects for `inputSchema`. */
export interface JsonSchemaObject {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean | Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Convert a tool's zod schema to JSON Schema for the MCP tool list.
 *
 * `io: 'input'` matters: with `io: 'output'` a field with a default is reported
 * as required, and the model then dutifully supplies every default by hand.
 */
export function toolInputJsonSchema(tool: AnyToolDefinition): JsonSchemaObject {
  const json = z.toJSONSchema(tool.inputSchema, {
    io: 'input',
    target: 'draft-07',
    unrepresentable: 'any',
    cycles: 'ref',
  }) as Record<string, unknown>;
  if (json.type !== 'object') {
    // MCP requires an object at the top level; wrap anything else.
    return { type: 'object', properties: { value: json }, required: ['value'] };
  }
  return json as JsonSchemaObject;
}

/** Parse and validate a tool's arguments. Throws a zod error on bad input. */
export function parseToolInput<TInput>(
  tool: ToolDefinition<TInput>,
  input: unknown,
): TInput {
  return tool.inputSchema.parse(input ?? {});
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

/** What an IPC handler is told about the caller. */
export interface IpcInvocation {
  /** `event.sender.id`, when the call came from a window. */
  readonly senderId?: number;
  readonly logger: Logger;
}

export type IpcHandler<C extends IpcChannel> = (
  request: IpcRequest<C>,
  ctx: IpcInvocation,
) => Promise<IpcResponse<C>> | IpcResponse<C>;

/**
 * A module's slice of the IPC surface. Keys are channels from
 * `shared/ipc.ts` — there is no way to register a channel that is not in the
 * contract, which is the point.
 */
export type IpcHandlerMap = {
  [C in IpcChannel]?: IpcHandler<C>;
};

/* ------------------------------------------------------------------ */
/* The module                                                          */
/* ------------------------------------------------------------------ */

export interface AppModule {
  /** Stable, lowercase, matches the directory name. Used to namespace tables. */
  id: string;
  /** Owned schema. Applied in array order, tracked in `_migrations`. */
  migrations: Migration[];
  tools?: AnyToolDefinition[];
  ipc?: IpcHandlerMap;
  /** Long-lived work: watchers, timers. Called after migrations. */
  start?(ctx: ModuleContext): Promise<void> | void;
  /** Release everything `start` acquired. Must be safe to call twice. */
  stop?(): Promise<void> | void;
}

/**
 * Identity helper that pins the type at the definition site, so a typo in a
 * channel name or a missing `sideEffecting` is an error in the module's own
 * file rather than in the registry list.
 */
export function defineModule(module: AppModule): AppModule {
  return module;
}

/** Same, for a single tool, preserving the input type. */
export function defineTool<TInput>(
  tool: ToolDefinition<TInput>,
): ToolDefinition<TInput> {
  return tool;
}
