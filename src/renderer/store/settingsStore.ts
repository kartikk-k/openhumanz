/**
 * Settings.
 *
 * Seeded with `DEFAULT_SETTINGS` from the shared schema, so `settings` is never
 * null and no screen has to guard it. A failed load leaves the defaults in
 * place and records the error.
 */
import { create } from 'zustand';
import { IPC } from '../../shared/ipc';
import {
  DEFAULT_SETTINGS,
  type Settings,
  type SettingsPatch,
} from '../../shared/settings';
import { IpcError, call } from '../lib/ipc';
import { initialLoadable, type LoadableState } from './types';

interface SettingsState extends LoadableState {
  settings: Settings;
  /** Fetch from main. Never throws. */
  load: () => Promise<void>;
  /** Merge a patch and persist it. Returns false if the write failed. */
  update: (patch: SettingsPatch) => Promise<boolean>;
  /** Apply a settings object received over `push:settings-changed`. */
  applyPush: (settings: Settings) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  ...initialLoadable,
  settings: DEFAULT_SETTINGS,

  load: async () => {
    set({ status: 'loading' });
    try {
      const settings = await call(IPC.settings.get, {});
      set({
        settings,
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
      const settings = await call(IPC.settings.set, patch);
      set({ settings, status: 'ready', error: null, unavailable: false });
      return true;
    } catch (cause) {
      set({ error: (cause as IpcError).message });
      return false;
    }
  },

  applyPush: (settings) => set({ settings, status: 'ready', error: null }),
}));

/** Just the UI slice — theme, density, whether to show costs. */
export function useUiSettings() {
  return useSettingsStore((state) => state.settings.ui);
}
