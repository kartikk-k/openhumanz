/**
 * Bridging module tools onto the MCP surface.
 *
 * Three jobs, all of them policy the rest of the server should not have to
 * think about:
 *
 * 1. **Descriptors.** `toolInputJsonSchema()` (io: 'input') is the only way a
 *    schema is allowed to reach the wire. `io: 'output'` marks defaulted fields
 *    required and the model then supplies every default by hand.
 * 2. **Refusing arbitrary code execution.** A generic shell tool or an
 *    arbitrary-AppleScript tool is remote code execution wearing a friendly
 *    schema, and no approval card can make it safe, because the card cannot
 *    show what the script will do. If a module registers one we refuse to
 *    start, loudly.
 * 3. **Compaction.** The agent pays tokens per byte of every result. Long lists
 *    are truncated with a count and a hint to fetch by id.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from '../../infra/logger';
import type { AnyToolDefinition } from '../../modules/types';
import { toolInputJsonSchema } from '../../modules/types';

/* ------------------------------------------------------------------ */
/* Descriptors                                                         */
/* ------------------------------------------------------------------ */

/** The subset of MCP's `Tool` we produce. */
export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export function describeTool(tool: AnyToolDefinition): McpToolDescriptor {
  const descriptor: McpToolDescriptor = {
    name: tool.name,
    description: tool.description,
    inputSchema: toolInputJsonSchema(tool),
  };
  if (tool.annotations) {
    descriptor.annotations = { ...tool.annotations };
  }
  return descriptor;
}

/* ------------------------------------------------------------------ */
/* Tools we refuse to expose                                           */
/* ------------------------------------------------------------------ */

/**
 * Names that are arbitrary code execution regardless of how the schema is
 * dressed. Matched case-insensitively against the whole name and against
 * underscore-delimited segments, so `mac_run_shell` is caught as well as
 * `shell`.
 */
const FORBIDDEN_NAME_PATTERNS: readonly RegExp[] = [
  /(^|_)(shell|bash|zsh|sh|cmd|powershell|pwsh)(_|$)/i,
  /(^|_)(exec|execute|eval|spawn|system|subprocess)(_|$)/i,
  /(^|_)(run_command|runcommand|command|terminal|console)(_|$)/i,
  /apple_?script/i,
  /osascript/i,
  /(^|_)jxa(_|$)/i,
  /(^|_)run_script(_|$)/i,
];

/**
 * Descriptions that advertise arbitrary execution. A module author who writes
 * "runs an arbitrary shell command" has told us exactly what this is.
 */
const FORBIDDEN_DESCRIPTION_PATTERNS: readonly RegExp[] = [
  /arbitrary\s+(shell|bash|command|code|script|applescript|osascript)/i,
  /\bany\s+(shell|terminal)\s+command\b/i,
  /execute\s+arbitrary/i,
];

/**
 * Why this tool may never be exposed, or null when it is fine.
 *
 * Exported so the orchestrator and tests can assert the rule without starting a
 * server.
 */
export function forbiddenToolReason(tool: AnyToolDefinition): string | null {
  for (const pattern of FORBIDDEN_NAME_PATTERNS) {
    if (pattern.test(tool.name)) {
      return `its name matches ${pattern} — generic command execution is never exposed over MCP`;
    }
  }
  for (const pattern of FORBIDDEN_DESCRIPTION_PATTERNS) {
    if (pattern.test(tool.description ?? '')) {
      return `its description advertises arbitrary execution (${pattern})`;
    }
  }
  return null;
}

/**
 * Throw if any tool in the list is one we refuse to expose. Called at server
 * start, before the socket is bound: a build that ships a shell tool should not
 * come up at all.
 */
export function assertNoForbiddenTools(
  tools: readonly AnyToolDefinition[],
  logger?: Logger,
): void {
  const offences: string[] = [];
  for (const tool of tools) {
    const reason = forbiddenToolReason(tool);
    if (reason) offences.push(`  - "${tool.name}": ${reason}`);
  }
  if (offences.length === 0) return;

  const message =
    'Refusing to start the MCP server: a module registered a tool that is ' +
    'arbitrary code execution.\n' +
    `${offences.join('\n')}\n` +
    'ARCHITECTURE.md: never expose a generic shell tool or an ' +
    'arbitrary-AppleScript tool. Model the specific capability instead ' +
    '(send_message, create_event), so the approval card can show what will ' +
    'actually happen.';
  logger?.error('forbidden tool registered', { count: offences.length });
  throw new Error(message);
}

/* ------------------------------------------------------------------ */
/* Result compaction                                                   */
/* ------------------------------------------------------------------ */

export interface CompactOptions {
  /** Items kept from any array before it is summarised. Default 20. */
  maxItems?: number;
  /** Hard cap on the rendered text. Default 8000 characters. */
  maxChars?: number;
}

export const DEFAULT_MAX_ITEMS = 20;
export const DEFAULT_MAX_CHARS = 8000;

const MAX_DEPTH = 4;

function truncateArrays(value: unknown, maxItems: number, depth = 0): unknown {
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) {
    return value;
  }
  if (Array.isArray(value)) {
    const kept = value
      .slice(0, maxItems)
      .map((item) => truncateArrays(item, maxItems, depth + 1));
    if (value.length > maxItems) {
      kept.push(
        `… ${value.length - maxItems} more of ${value.length} omitted; narrow the query or fetch by id`,
      );
    }
    return kept;
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    out[key] = truncateArrays(source[key], maxItems, depth + 1);
  }
  return out;
}

/**
 * Render a tool's return value as the compact text that goes in the MCP result.
 *
 * Strings pass through; everything else is JSON with long arrays summarised.
 * Both the item count and the byte count are capped, because "the agent pays
 * tokens per byte" is a cost the tool author never sees.
 */
export function compactToolResult(
  value: unknown,
  options: CompactOptions = {},
): string {
  const { maxItems = DEFAULT_MAX_ITEMS, maxChars = DEFAULT_MAX_CHARS } =
    options;

  let text: string;
  if (value === undefined || value === null) {
    text = 'ok';
  } else if (typeof value === 'string') {
    text = value;
  } else if (typeof value !== 'object') {
    text = String(value);
  } else {
    const trimmed = truncateArrays(value, maxItems);
    try {
      text = JSON.stringify(trimmed) ?? 'ok';
    } catch {
      text = String(value);
    }
  }

  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n… truncated at ${maxChars} characters of ${text.length}; narrow the query or fetch by id`;
}

/* ------------------------------------------------------------------ */
/* Result shapes                                                       */
/* ------------------------------------------------------------------ */

/**
 * We only ever produce text content. Aliasing the SDK's own result type keeps
 * the request handlers assignable without a cast.
 */
export type ToolCallResult = CallToolResult;

export function textResult(text: string): ToolCallResult {
  return { content: [{ type: 'text', text }] };
}

/**
 * Errors are in-band, never thrown: the model has to *see* the failure to
 * correct it, and a thrown error becomes a protocol error it cannot read.
 */
export function errorResult(text: string): ToolCallResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * The handle returned instead of blocking on a human. Shape matches
 * `ApprovalPendingHandleSchema` in `src/shared/approvals.ts`.
 */
export function pendingApprovalResult(handle: {
  approvalId: string;
  pollAfterMs?: number;
  message?: string;
}): ToolCallResult {
  return textResult(
    JSON.stringify({
      status: 'pending_approval',
      approvalId: handle.approvalId,
      pollAfterMs: handle.pollAfterMs ?? 2000,
      message:
        handle.message ??
        'Waiting for the user to approve this action. Do not retry; continue with other work and check back.',
    }),
  );
}

/** Readable one-liner for a failed argument parse. */
export function describeInputError(cause: unknown): string {
  if (cause instanceof z.ZodError) {
    return z.prettifyError(cause).replace(/\n+/g, '; ');
  }
  return cause instanceof Error ? cause.message : String(cause);
}
