/**
 * The approval queue.
 *
 * This slice is cross-cutting on purpose: the sidebar badge, the status strip
 * and the run timeline all read the same pending list, so a decision made on
 * one surface disappears from the others immediately.
 *
 * Resolution is optimistic — the card leaves the queue the moment the user
 * presses a button, and comes back if the write fails. Waiting on a round trip
 * to remove a card the user just answered feels broken.
 */
import { useMemo } from 'react';
import { create } from 'zustand';
import { IPC } from '../../shared/ipc';
import type {
  Approval,
  ApprovalGrant,
  ApprovalResolution,
  ApprovalScope,
} from '../../shared/approvals';
import { IpcError, call } from '../lib/ipc';
import { initialLoadable, type LoadableState } from './types';

interface ApprovalsState extends LoadableState {
  /** Oldest first — the queue is answered in arrival order. */
  pending: Approval[];
  grants: ApprovalGrant[];
  /** Approval ids with a resolve request in flight. */
  resolving: string[];

  load: (runId?: string) => Promise<void>;
  loadGrants: (filter?: { scope?: ApprovalScope; runId?: string }) => Promise<void>;
  /** Resolve one approval. Returns false if the write failed. */
  resolve: (resolution: ApprovalResolution) => Promise<boolean>;
  revokeGrant: (id: string) => Promise<boolean>;

  /** From `push:approval-requested`. */
  applyRequested: (approval: Approval) => void;
  /** From `push:approval-resolved`. */
  applyResolved: (approvalId: string) => void;
}

function sortByRequestedAt(list: Approval[]): Approval[] {
  return [...list].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

export const useApprovalsStore = create<ApprovalsState>((set, get) => ({
  ...initialLoadable,
  pending: [],
  grants: [],
  resolving: [],

  load: async (runId) => {
    set({ status: 'loading' });
    try {
      const pending = await call(IPC.approvals.listPending, { runId });
      set({
        pending: sortByRequestedAt(pending),
        status: 'ready',
        error: null,
        unavailable: false,
        loadedAt: new Date().toISOString(),
      });
    } catch (cause) {
      const error = cause as IpcError;
      set({
        status: 'error',
        error: error.message,
        unavailable: error.isUnavailable ?? false,
      });
    }
  },

  loadGrants: async (filter = {}) => {
    try {
      const grants = await call(IPC.approvals.listGrants, filter);
      set({ grants });
    } catch (cause) {
      set({ error: (cause as IpcError).message });
    }
  },

  resolve: async (resolution) => {
    const previous = get().pending;
    set({
      pending: previous.filter((item) => item.id !== resolution.approvalId),
      resolving: [...get().resolving, resolution.approvalId],
    });
    try {
      await call(IPC.approvals.resolve, resolution);
      if (resolution.scope !== 'once' && resolution.decision === 'approve') {
        void get().loadGrants();
      }
      return true;
    } catch (cause) {
      // Put the card back; the user's decision did not land.
      set({ pending: previous, error: (cause as IpcError).message });
      return false;
    } finally {
      set({
        resolving: get().resolving.filter(
          (id) => id !== resolution.approvalId,
        ),
      });
    }
  },

  revokeGrant: async (id) => {
    try {
      await call(IPC.approvals.revokeGrant, { id });
      set({ grants: get().grants.filter((grant) => grant.id !== id) });
      return true;
    } catch (cause) {
      set({ error: (cause as IpcError).message });
      return false;
    }
  },

  applyRequested: (approval) =>
    set((state) => {
      const without = state.pending.filter((item) => item.id !== approval.id);
      return {
        pending: sortByRequestedAt([...without, approval]),
        status: 'ready',
      };
    }),

  applyResolved: (approvalId) =>
    set((state) => ({
      pending: state.pending.filter((item) => item.id !== approvalId),
    })),
}));

/** Pending count. The number on the sidebar badge. */
export function usePendingApprovalCount(): number {
  return useApprovalsStore((state) => state.pending.length);
}

/** Pending approvals for one run — the timeline's inline cards. */
export function usePendingApprovalsForRun(runId: string | null): Approval[] {
  const pending = useApprovalsStore((state) => state.pending);
  return useMemo(
    () => (runId ? pending.filter((item) => item.runId === runId) : []),
    [pending, runId],
  );
}
