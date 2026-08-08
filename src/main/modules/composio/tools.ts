/**
 * Turn Composio's connected-app actions into the app's own {@link ToolDefinition}s
 * so they appear in the internal MCP surface — usable by chat and Claude Code.
 *
 * Composio returns tools in OpenAI function-calling shape:
 *   { type: 'function', function: { name, description, parameters: <JSON Schema> } }
 *
 * Our tools carry a zod `inputSchema` (the MCP layer converts it back to JSON
 * Schema for the tool list), so we bridge JSON Schema -> zod with a small,
 * defensive converter covering the shapes Composio actually emits. Anything it
 * cannot model degrades to a permissive `z.unknown()` rather than dropping the
 * field — a missing tool is worse than a loosely-typed argument the server will
 * validate anyway.
 */
import { z } from 'zod';
import type { AnyToolDefinition, ToolDefinition } from '../types';

/** One Composio tool in OpenAI function shape (only the bits we read). */
interface ComposioFunctionTool {
  type?: string;
  function?: {
    name?: string;
    description?: string;
    parameters?: JsonSchema;
  };
  // Some SDK shapes put these at the top level instead.
  slug?: string;
  name?: string;
  description?: string;
  inputParameters?: JsonSchema;
}

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  description?: string;
  default?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  [key: string]: unknown;
}

/** A union of the given zod types, or the single type if there is only one. */
function unionOf(options: z.ZodTypeAny[]): z.ZodTypeAny {
  if (options.length === 0) return z.unknown();
  if (options.length === 1) return options[0];
  return z.union(
    options as unknown as readonly [
      z.ZodTypeAny,
      z.ZodTypeAny,
      ...z.ZodTypeAny[],
    ],
  );
}

/** Convert one JSON-Schema node to a zod type. Best-effort, never throws. */
function jsonSchemaToZod(schema: JsonSchema | undefined): z.ZodTypeAny {
  if (!schema || typeof schema !== 'object') return z.unknown();

  // Union shapes.
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union) && union.length > 0) {
    return unionOf(union.map((s) => jsonSchemaToZod(s)));
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    // String enums map to z.enum; mixed enums fall back to a literal union.
    const values = schema.enum;
    if (values.every((v) => typeof v === 'string')) {
      return z.enum(values as [string, ...string[]]);
    }
    return unionOf(
      values.map((v) => z.literal(v as string | number | boolean)),
    );
  }

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case 'string':
      return withMeta(z.string(), schema);
    case 'number':
      return withMeta(z.number(), schema);
    case 'integer':
      return withMeta(z.number().int(), schema);
    case 'boolean':
      return withMeta(z.boolean(), schema);
    case 'array':
      return withMeta(z.array(jsonSchemaToZod(schema.items)), schema);
    case 'object':
      return objectToZod(schema);
    default:
      // No/unknown type — accept anything so the field still exists.
      return z.unknown();
  }
}

/** Attach description/default (metadata that survives to the JSON Schema). */
function withMeta(zodType: z.ZodTypeAny, schema: JsonSchema): z.ZodTypeAny {
  let out = zodType;
  if (typeof schema.description === 'string') {
    out = out.describe(schema.description);
  }
  if (schema.default !== undefined) {
    out = out.default(schema.default as never);
  }
  return out;
}

function objectToZod(schema: JsonSchema): z.ZodTypeAny {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, propSchema] of Object.entries(properties)) {
    let field = jsonSchemaToZod(propSchema);
    // A field with a default is effectively optional input; and anything not
    // in `required` is optional.
    if (!required.has(key) && propSchema?.default === undefined) {
      field = field.optional();
    }
    shape[key] = field;
  }
  const base = z.object(shape);
  // Composio schemas are closed by default; allow extras so a newer field the
  // model sends does not get stripped before it reaches Composio.
  return withMeta(base.passthrough(), schema);
}

/** Read a Composio tool's name/description/parameters from either shape. */
function readComposioTool(raw: unknown): {
  name: string;
  description: string;
  parameters: JsonSchema | undefined;
} | null {
  const tool = raw as ComposioFunctionTool;
  const name = tool.function?.name ?? tool.slug ?? tool.name;
  if (!name) return null;
  return {
    name,
    description: tool.function?.description ?? tool.description ?? '',
    parameters: tool.function?.parameters ?? tool.inputParameters,
  };
}

/**
 * Build a ToolDefinition for one Composio tool. The handler executes it through
 * the injected `execute` (which calls Composio server-side). Marked
 * `sideEffecting: true` so every connected-app call routes through the approval
 * gate — the app should never send mail or delete a message unattended.
 */
export function composioToolToDefinition(
  raw: unknown,
  execute: (slug: string, args: Record<string, unknown>) => Promise<unknown>,
): AnyToolDefinition | null {
  const parsed = readComposioTool(raw);
  if (!parsed) return null;

  const definition: ToolDefinition<Record<string, unknown>> = {
    name: parsed.name,
    description: parsed.description,
    inputSchema: jsonSchemaToZod(parsed.parameters) as z.ZodType<
      Record<string, unknown>
    >,
    sideEffecting: true,
    annotations: { title: parsed.name },
    handler: async (input) => execute(parsed.name, input ?? {}),
  };
  return definition as AnyToolDefinition;
}
