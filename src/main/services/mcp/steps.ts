/**
 * Per-step tool scoping.
 *
 * The orchestrator registers a step id before it spawns the CLI and revokes it
 * after. A connection that handshakes with an unregistered — or already
 * revoked — step id gets nothing.
 *
 * This is the second of the two independent gates. The first is the CLI's own
 * `--allowedTools`, which lives on the far side of the protocol and which the
 * agent could in principle be talked around. This one lives on our side of the
 * socket, is derived from the step the orchestrator actually planned, and is
 * applied to `tools/list` *and* `tools/call`. Both have to fail for a step to
 * reach a tool it was not given.
 */

export interface StepRegistrationInput {
  /** Must be unique for the lifetime of the registration. */
  stepId: string;
  /** The run this step belongs to. Threaded into every tool call context. */
  runId: string;
  /** Exactly the tool names this step may see and call. */
  allowedTools: Iterable<string>;
  /**
   * A human is watching this step live (chat), so a pending approval should
   * hold the tool call open and continue in place once they decide, rather than
   * returning a "pending" handle and ending the turn. Defaults to false — runs
   * are fire-and-forget and must never block an MCP response on a human.
   */
  interactive?: boolean;
}

export interface StepScope {
  readonly stepId: string;
  readonly runId: string;
  readonly allowedTools: ReadonlySet<string>;
  readonly registeredAt: number;
  /** See {@link StepRegistrationInput.interactive}. */
  readonly interactive: boolean;
}

/** What `registerStep` hands back. Revoking twice is a no-op. */
export interface RegisteredStep extends StepScope {
  /**
   * Environment for the shim, to be embedded in the generated MCP config.
   * Contains the token, so it goes in a 0600 file and never in a log line.
   */
  env(): Record<string, string>;
  revoke(): void;
}

export interface StepScopeRegistry {
  register(input: StepRegistrationInput): StepScope;
  revoke(stepId: string): boolean;
  get(stepId: string): StepScope | undefined;
  has(stepId: string): boolean;
  list(): StepScope[];
  clear(): void;
  readonly size: number;
}

export function createStepScopeRegistry(): StepScopeRegistry {
  const scopes = new Map<string, StepScope>();

  return {
    register(input) {
      const { stepId, runId } = input;
      if (!stepId) throw new Error('registerStep: stepId is required');
      if (!runId) throw new Error('registerStep: runId is required');
      if (scopes.has(stepId)) {
        throw new Error(
          `registerStep: step "${stepId}" is already registered. Revoke it first.`,
        );
      }
      const allowedTools = new Set<string>();
      for (const name of input.allowedTools) {
        if (typeof name === 'string' && name.length > 0) allowedTools.add(name);
      }
      const scope: StepScope = {
        stepId,
        runId,
        allowedTools,
        registeredAt: Date.now(),
        interactive: input.interactive === true,
      };
      scopes.set(stepId, scope);
      return scope;
    },

    revoke(stepId) {
      return scopes.delete(stepId);
    },

    get(stepId) {
      return scopes.get(stepId);
    },

    has(stepId) {
      return scopes.has(stepId);
    },

    list() {
      return [...scopes.values()];
    },

    clear() {
      scopes.clear();
    },

    get size() {
      return scopes.size;
    },
  };
}
