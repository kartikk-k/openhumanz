/**
 * App startup: the initial loads and the push-channel wiring.
 *
 * Subscriptions live here rather than inside the slices so that there is
 * exactly one place that knows what a push channel means, and so the slices
 * stay pure state + actions (trivially testable, no side effects on import).
 *
 * Call {@link useAppBootstrap} once, from the shell. Feature screens subscribe
 * to their own channels with `useQuery(..., { refetchOn })` or
 * `useSubscription`.
 */
import { useEffect } from 'react';
import { IPC_PUSH } from '../../shared/ipc';
import { subscribe } from '../lib/ipc';
import { useApprovalsStore } from './approvalsStore';
import { useChatStore } from './chatStore';
import { useEnvironmentStore } from './environmentStore';
import { useOnboardingStore } from './onboardingStore';
import { useRunsStore } from './runsStore';
import { useSettingsStore } from './settingsStore';
import { toast } from './toastStore';

/** Fire the initial reads. Safe to call more than once. */
export async function loadInitialState(): Promise<void> {
  await Promise.all([
    useSettingsStore.getState().load(),
    useEnvironmentStore.getState().load(),
    useOnboardingStore.getState().load(),
    useApprovalsStore.getState().load(),
    useRunsStore.getState().loadRuns({ limit: 50 }),
  ]);
}

/**
 * Attach every cross-cutting push listener. Returns a disposer that removes
 * all of them.
 */
export function connectPushChannels(): () => void {
  const disposers = [
    subscribe(IPC_PUSH.runEvents, ({ runId, events }) => {
      useRunsStore.getState().applyEvents(runId, events);
    }),

    subscribe(IPC_PUSH.runStatus, ({ runId, status }) => {
      useRunsStore.getState().applyStatus(runId, status);
      if (status === 'failed') {
        const run = useRunsStore.getState().runs[runId];
        toast.error(`Run failed: ${run?.title ?? runId}`, {
          key: `run-failed-${runId}`,
          description: run?.error,
        });
      }
    }),

    subscribe(IPC_PUSH.approvalRequested, ({ approval }) => {
      useApprovalsStore.getState().applyRequested(approval);
    }),

    subscribe(IPC_PUSH.approvalResolved, ({ approvalId }) => {
      useApprovalsStore.getState().applyResolved(approvalId);
    }),

    subscribe(IPC_PUSH.settingsChanged, ({ settings }) => {
      useSettingsStore.getState().applyPush(settings);
    }),

    subscribe(IPC_PUSH.environmentChanged, ({ status }) => {
      useEnvironmentStore.getState().applyPush(status);
    }),

    subscribe(IPC_PUSH.chatUpdated, (payload) => {
      useChatStore.getState().applyUpdate(payload);
    }),

    subscribe(IPC_PUSH.chatStream, (payload) => {
      useChatStore.getState().applyStreamEvent(payload);
    }),
  ];

  return () => disposers.forEach((dispose) => dispose());
}

/**
 * The shell's one-line startup. Loads cross-cutting state and keeps it live for
 * as long as the app is mounted.
 */
export function useAppBootstrap(): void {
  useEffect(() => {
    const disconnect = connectPushChannels();
    void loadInitialState();
    return disconnect;
  }, []);
}
