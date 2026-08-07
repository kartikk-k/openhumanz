/**
 * What this machine can actually do right now: which engine binaries exist,
 * which OS providers are reachable, and whether a stray `ANTHROPIC_API_KEY` is
 * about to burn credit.
 *
 * `available: false` is a normal state — the dev machine is Linux and the
 * product targets macOS — so nothing here treats unavailability as an error.
 */
import { useMemo } from 'react';
import { create } from 'zustand';
import { IPC } from '../../shared/ipc';
import type { EngineInfo, EnvironmentStatus } from '../../shared/engines';
import { IpcError, call } from '../lib/ipc';
import { initialLoadable, type LoadableState } from './types';

interface EnvironmentState extends LoadableState {
  /** Null until the first successful load. */
  environment: EnvironmentStatus | null;
  load: () => Promise<void>;
  /** Re-probe for engine binaries; `force` skips any cached result. */
  detectEngines: (force?: boolean) => Promise<EngineInfo[]>;
  applyPush: (status: EnvironmentStatus) => void;
}

export const useEnvironmentStore = create<EnvironmentState>((set) => ({
  ...initialLoadable,
  environment: null,

  load: async () => {
    set({ status: 'loading' });
    try {
      const environment = await call(IPC.engines.status, {});
      set({
        environment,
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

  detectEngines: async (force = false) => {
    try {
      const engines = await call(IPC.engines.detect, { force });
      set((state) =>
        state.environment ? { environment: { ...state.environment, engines } } : {},
      );
      return engines;
    } catch (cause) {
      set({ error: (cause as IpcError).message });
      return [];
    }
  },

  applyPush: (environment) =>
    set({ environment, status: 'ready', error: null }),
}));

/** The full status object, or null before the first load. */
export function useEnvironment(): EnvironmentStatus | null {
  return useEnvironmentStore((state) => state.environment);
}

/** The engine we would spawn, or null when none is usable. */
export function usePreferredEngine(preferredId?: string): EngineInfo | null {
  const environment = useEnvironment();
  return useMemo(() => {
    const engines = environment?.engines ?? [];
    if (engines.length === 0) return null;
    const preferred = preferredId
      ? engines.find((engine) => engine.id === preferredId)
      : undefined;
    return preferred ?? engines.find((engine) => engine.available) ?? engines[0];
  }, [environment, preferredId]);
}

/**
 * Everything worth interrupting the user about, as flat strings.
 * Combines the backend's own `warnings` with the API-key detection.
 */
export function useEnvironmentWarnings(): string[] {
  const environment = useEnvironment();
  return useMemo(() => {
    if (!environment) return [];
    const warnings = [...environment.warnings];
    if (environment.apiKeyEnvDetected) {
      warnings.unshift(
        'ANTHROPIC_API_KEY is set in the environment. Runs will bill the API instead of your subscription.',
      );
    }
    if (environment.engines.length > 0 && !environment.engines.some((e) => e.available)) {
      warnings.push('No agent CLI was found. Runs cannot start.');
    }
    return warnings;
  }, [environment]);
}
