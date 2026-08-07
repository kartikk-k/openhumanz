/**
 * The seam between the MCP server and the approval gate.
 *
 * The MCP server implements **no policy**. It knows one thing: before running a
 * side-effecting tool it asks a gate, and it acts on one of three answers. The
 * approvals module owns standing grants, persistence, the UI event and the
 * audit log; none of that appears here, and none of it should.
 *
 * The hard rule this interface exists to enforce: `check()` must resolve
 * **immediately**. It may return `{ pending }` and let a human take an hour,
 * but it may not hold the promise open waiting for one — an MCP response held
 * open past the client's timeout kills the run, and the run is the thing we are
 * trying to protect.
 */

/** What the gate is told about the call it is deciding on. */
export interface ApprovalGateContext {
  /** The run this step belongs to, from the step registration. */
  readonly runId: string;
  readonly stepId: string;
  /** Our id for this specific invocation. Ends up on the `ToolCall` row. */
  readonly toolCallId: string;
  /** `ToolDefinition.sideEffecting`. The gate should trust this, not the name. */
  readonly sideEffecting: boolean;
  /**
   * `tool.summarize(args)` when the tool supplies one — the plain-language line
   * for the approval card. Falls back to undefined, and the gate should then
   * render name + arguments itself.
   */
  readonly summary?: string;
  /** One-line tool description, for the card when there is no summary. */
  readonly description?: string;
  /** Aborted when the run is cancelled or the connection drops. */
  readonly signal?: AbortSignal;
}

/**
 * The gate's answer.
 *
 *  - `'allow'`           — a standing grant matched, or the call needs none.
 *  - `{ pending }`       — a human has to decide. The agent gets a handle back
 *                          immediately and polls; the orchestrator re-dispatches
 *                          once the approval resolves.
 *  - `{ denied }`        — refused outright. `denied` is the reason shown to
 *                          the agent, so keep it short and actionable.
 */
export type ApprovalCheckResult =
  | 'allow'
  | {
      /** Id of the persisted pending `Approval`. */
      pending: string;
      /** Hint for the agent's next poll. Default 2000 ms. */
      pollAfterMs?: number;
      /** Overrides the default "waiting for the user" line. */
      message?: string;
    }
  | {
      /** Reason, shown to the agent verbatim. */
      denied: string;
    };

export interface ApprovalGate {
  check(
    toolName: string,
    args: unknown,
    ctx: ApprovalGateContext,
  ): Promise<ApprovalCheckResult>;
}

/** True for the `{ pending }` variant. */
export function isPendingResult(
  result: ApprovalCheckResult,
): result is { pending: string; pollAfterMs?: number; message?: string } {
  return typeof result === 'object' && result !== null && 'pending' in result;
}

/** True for the `{ denied }` variant. */
export function isDeniedResult(
  result: ApprovalCheckResult,
): result is { denied: string } {
  return typeof result === 'object' && result !== null && 'denied' in result;
}

/**
 * The default when no gate is injected: everything runs.
 *
 * This is correct for tests and for the app before the approvals module is
 * wired, and it is *not* correct in production — `createMcpSocketServer` logs a
 * warning at start when it is holding this.
 */
export const allowAllApprovalGate: ApprovalGate = {
  async check() {
    return 'allow';
  },
};
