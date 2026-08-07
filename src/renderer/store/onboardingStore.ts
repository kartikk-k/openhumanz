/**
 * First-run state.
 *
 * `loaded` is tracked separately from the state itself because "we have not
 * heard from main yet" and "onboarding is genuinely incomplete" must not look
 * the same — otherwise a missing IPC handler traps the user on the welcome
 * screen forever. Nothing redirects until a real answer arrives.
 */
import { create } from 'zustand';
import { IPC } from '../../shared/ipc';
import {
  DEFAULT_ONBOARDING_STATE,
  type OnboardingState,
  type OnboardingStateInput,
  type OnboardingStep,
} from '../../shared/settings';
import { IpcError, call } from '../lib/ipc';
import { initialLoadable, type LoadableState } from './types';

interface OnboardingSlice extends LoadableState {
  state: OnboardingState;
  /** True once main has answered at least once. */
  loaded: boolean;
  /** The user chose to skip onboarding for this session only. */
  dismissed: boolean;

  load: () => Promise<void>;
  update: (patch: Partial<OnboardingStateInput>) => Promise<boolean>;
  goToStep: (step: OnboardingStep) => Promise<boolean>;
  complete: () => Promise<boolean>;
  dismiss: () => void;
}

export const useOnboardingStore = create<OnboardingSlice>((set, get) => ({
  ...initialLoadable,
  state: DEFAULT_ONBOARDING_STATE,
  loaded: false,
  dismissed: false,

  load: async () => {
    set({ status: 'loading' });
    try {
      const state = await call(IPC.onboarding.get, {});
      set({
        state,
        loaded: true,
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

  update: async (patch) => {
    try {
      const state = await call(IPC.onboarding.set, patch);
      set({ state, loaded: true, status: 'ready', error: null });
      return true;
    } catch (cause) {
      set({ error: (cause as IpcError).message });
      return false;
    }
  },

  goToStep: (step) => get().update({ step }),

  complete: () =>
    get().update({
      completed: true,
      step: 'done',
      completedAt: new Date().toISOString(),
    }),

  dismiss: () => set({ dismissed: true }),
}));

/**
 * Should the app send the user to `/onboarding`?
 *
 * Only when main has actually answered and said "not done". An unreachable or
 * unregistered handler means no.
 */
export function useShouldOnboard(): boolean {
  return useOnboardingStore(
    (slice) => slice.loaded && !slice.state.completed && !slice.dismissed,
  );
}
