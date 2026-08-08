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
 * but it may not hold the promise open waiting for one.
 *
 * That rule is right for a *run*: a run is fire-and-forget, and an MCP response
 * held open past the CLI's tool timeout is indistinguishable from a denial. But
 * an interactive *chat* turn wants the opposite — the user is sitting there, and
 * the turn should stay alive and continue the instant they decide, rather than
 * ending and stranding the pending card in a separate tab. For that path the
 * gate exposes {@link ApprovalGate.waitForDecision}: after `check()` returns
 * `{ pending }`, the caller may opt in to awaiting the human's decision. The
 * caller (the MCP server) is responsible for keeping the response alive past the
 * client timeout — it sends MCP progress heartbeats while it waits.
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

/** The human's decision on a pending approval, once one has been made. */
export interface ApprovalDecisionResult {
  /** `true` when the user allowed the call (any scope), `false` on a denial. */
  readonly approved: boolean;
  /** Short reason to show the agent when `approved` is false. */
  readonly reason?: string;
}

export interface ApprovalGate {
  check(
    toolName: string,
    args: unknown,
    ctx: ApprovalGateContext,
  ): Promise<ApprovalCheckResult>;

  /**
   * Await the human's decision on a pending approval.
   *
   * Optional: a gate that does not implement it forces the caller down the
   * return-immediately path (correct for runs). When present, the caller may
   * hold the tool call open until the user decides — used by interactive chat so
   * the turn continues in place. Resolves when the approval is resolved (allow
   * or deny), and rejects if `signal` aborts (connection dropped, run cancelled)
   * or the approval expires/cancels without a human decision.
   */
  waitForDecision?(
    approvalId: string,
    signal?: AbortSignal,
  ): Promise<ApprovalDecisionResult>;
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
  // Nothing ever reaches `pending` under this gate, so this is unreachable in
  // practice; it exists to satisfy the interface and to fail loudly if it isn't.
  async waitForDecision() {
    return { approved: true };
  },
};
