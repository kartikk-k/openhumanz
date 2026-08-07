/**
 * Stub engine and stub MCP server.
 *
 * The engine adapter and the MCP server are built elsewhere and may not exist
 * yet. That is fine and it is the point of the interfaces in `./types`: the
 * orchestrator can be exercised end to end — multi-step runs, cancel, quota
 * failures, budgets, transcripts — without spawning a process or opening a
 * socket, which also means those paths are testable on a machine with no CLI
 * installed and in CI.
 *
 * These live in `src/` rather than in a test directory because they are the
 * executable form of the contract. If a real adapter cannot be swapped in for
 * one of these, the contract has drifted.
 */
import type { EngineInfo } from '../../../shared/engines';
import { nowIso } from '../../../shared/common';
import type {
  EngineAdapter,
  EngineEvent,
  EngineInvocation,
  EngineProvider,
  McpScopeRegistrar,
  McpStepScope,
  McpStepScopeRequest,
  McpToolCallEnd,
  McpToolCallStart,
} from './types';

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

/** What the stub was asked to do. Assert against this. */
export interface RecordedInvocation {
  runId: string;
  stepId: string;
  prompt: string;
  cwd: string;
  sessionId?: string;
  maxTurns: number;
  maxCostUsd: number;
  allowedTools: string[];
  mcpConfigPath?: string;
  model?: string;
}

/**
 * Produces the events for one invocation. Return an array for a fixed script,
 * or an async generator to control timing (which is what a cancel test needs).
 */
export type StubScript = (
  invocation: EngineInvocation,
  index: number,
) => EngineEvent[] | AsyncIterable<EngineEvent>;

export interface StubEngine extends EngineAdapter {
  readonly invocations: RecordedInvocation[];
  /** True while an invocation is mid-stream. A real one would hold a process. */
  readonly running: boolean;
  /** Set when the stream was shut down by `return()` — i.e. killed. */
  readonly closedByCaller: number;
}

export function createStubEngine(
  script: StubScript,
  engineOptions: { id?: string; available?: boolean } = {},
): StubEngine {
  const id = engineOptions.id ?? 'stub';
  const invocations: RecordedInvocation[] = [];
  let running = false;
  let closedByCaller = 0;

  const engine: StubEngine = {
    id,
    name: 'Stub engine',

    get invocations() {
      return invocations;
    },
    get running() {
      return running;
    },
    get closedByCaller() {
      return closedByCaller;
    },

    async detect(): Promise<EngineInfo> {
      return {
        id,
        name: 'Stub engine',
        available: engineOptions.available ?? true,
        supportsResume: true,
        supportsStreamingJson: true,
        detectedAt: nowIso(),
      };
    },

    run(invocation: EngineInvocation): AsyncIterable<EngineEvent> {
      const index = invocations.length;
      invocations.push({
        runId: invocation.runId,
        stepId: invocation.stepId,
        prompt: invocation.prompt,
        cwd: invocation.cwd,
        sessionId: invocation.sessionId,
        maxTurns: invocation.maxTurns,
        maxCostUsd: invocation.maxCostUsd,
        allowedTools: [...invocation.allowedTools],
        mcpConfigPath: invocation.mcpConfigPath,
        model: invocation.model,
      });

      const produced = script(invocation, index);

      return {
        [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
          const inner: AsyncIterator<EngineEvent> = Array.isArray(produced)
            ? asyncFromArray(produced)
            : produced[Symbol.asyncIterator]();

          running = true;
          return {
            async next() {
              const result = await inner.next();
              if (result.done) running = false;
              return result;
            },
            async return(value?: unknown) {
              // The real adapter kills the process tree here. The stub records
              // that it was asked to, which is what the cancel test asserts.
              closedByCaller += 1;
              running = false;
              await inner.return?.(value);
              return { done: true, value: undefined } as IteratorResult<
                EngineEvent,
                undefined
              >;
            },
          };
        },
      };
    },
  };

  return engine;
}

async function* asyncFromArray(
  events: EngineEvent[],
): AsyncGenerator<EngineEvent> {
  for (const event of events) {
    // A tick between events, so a cancel can land mid-stream the way it would
    // against a real subprocess.
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
    yield event;
  }
}

/** An {@link EngineProvider} over one or more stub adapters. */
export function createStubEngineProvider(
  ...adapters: EngineAdapter[]
): EngineProvider {
  const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  return {
    defaultEngineId: adapters[0]?.id ?? 'stub',
    get(engineId) {
      if (!engineId) return adapters[0];
      return byId.get(engineId);
    },
  };
}

/* ------------------------------------------------------------------ */
/* MCP                                                                 */
/* ------------------------------------------------------------------ */

export interface RecordedRegistration {
  runId: string;
  stepId: string;
  allowedTools: string[];
  cwd: string;
  revoked: boolean;
  /** Drive the timeline the way the real server would. */
  emitToolCall(call: McpToolCallStart): void;
  emitToolResult(result: McpToolCallEnd): void;
}

export interface StubMcp extends McpScopeRegistrar {
  readonly registrations: RecordedRegistration[];
  /** Registrations still live. Should be empty once a run finishes. */
  activeScopes(): RecordedRegistration[];
}

/**
 * Records what each step was scoped to and hands back a plausible server entry,
 * so the config the orchestrator writes can be inspected on disk.
 */
export function createStubMcp(
  mcpOptions: {
    serverName?: string;
    command?: string;
    /** Prefix applied to owned tool names, as the CLI would see them. */
    namespace?: (serverName: string, tool: string) => string;
    /** Which of a step's allowed tools this server actually owns. */
    owns?: (tool: string) => boolean;
  } = {},
): StubMcp {
  const serverName = mcpOptions.serverName ?? 'assistant';
  const command = mcpOptions.command ?? '/fake/electron';
  const namespace =
    mcpOptions.namespace ??
    ((server: string, tool: string) => `mcp__${server}__${tool}`);
  const owns = mcpOptions.owns ?? ((tool: string) => tool.includes('_'));

  const registrations: RecordedRegistration[] = [];

  return {
    registrations,
    activeScopes: () => registrations.filter((entry) => !entry.revoked),

    async register(request: McpStepScopeRequest): Promise<McpStepScope> {
      const owned = request.allowedTools.filter(owns);
      const entry: RecordedRegistration = {
        runId: request.runId,
        stepId: request.stepId,
        allowedTools: [...request.allowedTools],
        cwd: request.cwd,
        revoked: false,
        emitToolCall: (call) => request.onToolCall?.(call),
        emitToolResult: (result) => request.onToolResult?.(result),
      };
      registrations.push(entry);

      return {
        serverName,
        server: {
          command,
          args: ['/fake/shim.js', '--step', request.stepId],
          env: { ASSISTANT_MCP_TOKEN: 'stub-token' },
        },
        exposedToolNames: owned.map((tool) => namespace(serverName, tool)),
        async revoke() {
          entry.revoked = true;
        },
      };
    },
  };
}
