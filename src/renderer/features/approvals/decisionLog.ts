/**
 * Decisions made in this window, with the arguments they were made about.
 *
 * **This is the fallback, not the record.** The record lives in main:
 * `approvals_audit` holds every decision with its full arguments and
 * `approvals:list-audit` reads it, which is what `HistoryPanel` shows whenever
 * the channel answers. This store exists for the case where it does not — a
 * renderer with no bridge, or a main process that has not registered the
 * approvals module — so that a window which watched the user press a button
 * can still show what it saw instead of an empty page. It is labelled as
 * partial on screen, because it starts empty on every restart and never
 * contains the decisions a standing grant made in main.
 *
 * Deliberately *not* fed from `push:approval-resolved`: `store/bootstrap.ts`
 * owns that subscription, and a second listener for the same channel is how two
 * sources of truth start disagreeing. This records at the point of decision,
 * which is also the only place the arguments are still in hand.
 *
 * A module-level store rather than component state so the log survives
 * navigating away from `/approvals` and back.
 */
import { create } from 'zustand';
import { nanoIdish } from './ids';
import type {
  ApprovalDecision,
  ApprovalScope,
  Approval,
} from '../../../shared/approvals';
import type { JsonObject } from '../../../shared/common';

export interface DecisionRecord {
  id: string;
  approvalId: string;
  runId: string;
  toolName: string;
  title: string;
  summary: string;
  /** The payload the decision was made about. The point of an audit row. */
  toolArguments: JsonObject;
  decision: ApprovalDecision;
  scope: ApprovalScope;
  /** Always `you` here — a grant match is decided in main and not seen. */
  decidedBy: string;
  reason?: string;
  at: string;
}

/** Enough to answer "what did I just do"; not a substitute for the real log. */
const MAX_ENTRIES = 100;

interface DecisionLogState {
  /** Newest first. */
  entries: DecisionRecord[];
  record: (entry: Omit<DecisionRecord, 'id'>) => void;
  clear: () => void;
}

export const useDecisionLog = create<DecisionLogState>((set) => ({
  entries: [],

  record: (entry) =>
    set((state) => ({
      entries: [{ ...entry, id: nanoIdish() }, ...state.entries].slice(
        0,
        MAX_ENTRIES,
      ),
    })),

  clear: () => set({ entries: [] }),
}));

/** Build a record from the approval the user just answered. */
export function decisionFrom(
  approval: Approval,
  decision: ApprovalDecision,
  scope: ApprovalScope,
  reason?: string,
): Omit<DecisionRecord, 'id'> {
  return {
    approvalId: approval.id,
    runId: approval.runId,
    toolName: approval.toolName,
    title: approval.title,
    summary: approval.summary,
    toolArguments: approval.toolArguments,
    decision,
    // A denial never creates a grant: the gate forces scope back to `once`.
    scope: decision === 'deny' ? 'once' : scope,
    decidedBy: 'you',
    reason: reason?.trim() ? reason.trim() : undefined,
    at: new Date().toISOString(),
  };
}
