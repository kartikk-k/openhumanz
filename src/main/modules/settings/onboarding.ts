/**
 * `onboarding.json` — where the first-run flow left off.
 *
 * Separate from `settings.json` on purpose: it is progress, not preference.
 * Deleting it replays onboarding without touching a single configured value,
 * which is exactly what someone debugging the first-run experience wants.
 *
 * First run has no file, and that is the normal case, not an error: a missing
 * file reads as `DEFAULT_ONBOARDING_STATE` and nothing is written until the
 * user actually does something.
 */
import type { Logger } from '../../infra/logger';
import { readJsonFile, writeJsonFileAtomic } from '../../infra/files';
import { nowIso } from '../../../shared/common';
import type {
  OnboardingState,
  OnboardingStatePatch,
} from '../../../shared/settings';
import {
  OnboardingStatePatchSchema,
  OnboardingStateSchema,
} from '../../../shared/settings';
import type { RejectedField } from './coerce';
import { coerceWithDefaults, summarizeRejections } from './coerce';

export interface OnboardingStore {
  load(): Promise<OnboardingState>;
  get(): Promise<OnboardingState>;
  current(): OnboardingState;
  set(patch: unknown): Promise<OnboardingState>;
  rejected(): readonly RejectedField[];
}

export interface OnboardingStoreOptions {
  /** Absolute path to `onboarding.json`. */
  file: string;
  logger: Logger;
}

/**
 * Merge a patch over the stored state.
 *
 * Flat, so a key-by-key spread is the whole story — plus one convenience:
 * finishing onboarding stamps `completedAt` if the caller did not, so the
 * timestamp cannot go missing depending on which button was pressed.
 */
export function mergeOnboarding(
  current: OnboardingState,
  patch: OnboardingStatePatch,
): OnboardingState {
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    merged[key] = value;
  }
  if (merged.completed === true && !merged.completedAt) {
    merged.completedAt = nowIso();
  }
  return OnboardingStateSchema.parse(merged);
}

export function createOnboardingStore(
  options: OnboardingStoreOptions,
): OnboardingStore {
  const { file, logger } = options;

  let cache: OnboardingState = OnboardingStateSchema.parse({});
  let lastRejected: RejectedField[] = [];
  let loaded = false;
  let queue: Promise<unknown> = Promise.resolve();

  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  const load = async (): Promise<OnboardingState> => {
    const raw = await readJsonFile<unknown>(file);
    const { value, rejected } = coerceWithDefaults(
      OnboardingStateSchema,
      raw ?? {},
    );
    cache = value;
    lastRejected = rejected;
    loaded = true;
    if (rejected.length > 0) {
      logger.warn('onboarding.json had values we could not use', {
        file,
        rejected: summarizeRejections(rejected),
      });
    }
    return cache;
  };

  const get = async (): Promise<OnboardingState> => {
    if (!loaded) await load();
    return cache;
  };

  return {
    load: () => serialize(load),
    get: () => serialize(get),
    current: () => cache,
    rejected: () => lastRejected,

    set: (patch: unknown) =>
      serialize(async () => {
        const parsed = OnboardingStatePatchSchema.parse(patch ?? {});
        const base = loaded ? cache : await load();
        const next = mergeOnboarding(base, parsed);
        await writeJsonFileAtomic(file, next);
        cache = next;
        loaded = true;
        return next;
      }),
  };
}
