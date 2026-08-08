/**
 * Cross-cutting state.
 *
 * These five slices are the ones more than one screen needs: runs and their
 * live events, the approval queue, environment/engine status, settings and
 * onboarding — plus toasts, which anything may raise.
 *
 * **Feature screens add their own file here** (`tasksStore.ts`,
 * `scheduleStore.ts`, ...) and export it from this barrel. Slices stay
 * separate: one `create()` per domain, no god store. If two slices need to talk,
 * do it in `bootstrap.ts`, not by importing one into the other.
 *
 * Read `types.ts` before adding one — it documents the three conventions that
 * keep these interchangeable.
 */
export {
  useApprovalsStore,
  usePendingApprovalCount,
  usePendingApprovalsForRun,
} from './approvalsStore';
export {
  useEnvironment,
  useEnvironmentStore,
  useEnvironmentWarnings,
  usePreferredEngine,
} from './environmentStore';
export { useOnboardingStore, useShouldOnboard } from './onboardingStore';
export { useChatStore } from './chatStore';
export {
  findSeqGaps,
  isRunLive,
  useFailedRuns,
  useLiveRuns,
  useRunEvents,
  useRunList,
  useRunsStore,
  useWaitingRuns,
} from './runsStore';
export { useSettingsStore, useUiSettings } from './settingsStore';
export {
  toast,
  useToastStore,
  type ToastAction,
  type ToastItem,
  type ToastOptions,
} from './toastStore';
export {
  connectPushChannels,
  loadInitialState,
  useAppBootstrap,
} from './bootstrap';
export { initialLoadable, type LoadStatus, type LoadableState } from './types';
