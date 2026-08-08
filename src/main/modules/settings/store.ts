/**
 * `settings.json` — the file, and the only writer of it.
 *
 * Plain JSON in the workspace root, pretty-printed, written through
 * {@link writeJsonFileAtomic} so a crash mid-write can never leave a truncated
 * config. It is meant to be opened in an editor, which is why reads degrade per
 * field (see `./coerce`) instead of throwing.
 *
 * The read side never rewrites the file. Healing a hand-edited file behind the
 * user's back would delete the very line they are in the middle of fixing; the
 * corrected value lives in memory until something actually writes.
 */
import type { EventBus } from '../../infra/events';
import type { Logger } from '../../infra/logger';
import {
  pathExists,
  readJsonFile,
  writeJsonFileAtomic,
} from '../../infra/files';
import type { Settings, SettingsPatch } from '../../../shared/settings';
import { SettingsPatchSchema, SettingsSchema } from '../../../shared/settings';
import type { RejectedField } from './coerce';
import { coerceWithDefaults, summarizeRejections } from './coerce';

export interface SettingsLoadResult {
  settings: Settings;
  /** Values replaced by their default, plus unrecognised keys. */
  rejected: RejectedField[];
  /** True on first run: no file yet, pure defaults. */
  missing: boolean;
  /** True when the file existed but was not valid JSON at all. */
  unparseable: boolean;
}

export interface SettingsStore {
  /** Read from disk and refresh the cache. */
  load(): Promise<SettingsLoadResult>;
  /** Cached settings, loading once on first call. */
  get(): Promise<Settings>;
  /** Cached settings without touching disk. Defaults until the first load. */
  current(): Settings;
  /** Merge a partial patch, validate the result, write, announce. */
  set(patch: unknown): Promise<Settings>;
  /** What the last load refused. Empty when the file was clean. */
  rejected(): readonly RejectedField[];
}

export interface SettingsStoreOptions {
  /** Absolute path to `settings.json`. */
  file: string;
  logger: Logger;
  events: EventBus;
}

/**
 * Apply a patch to a settings object.
 *
 * Sections merge key by key; anything the patch does not mention keeps its
 * current value. This is the half that {@link SettingsPatchSchema} cannot do on
 * its own, and doing it here — rather than re-parsing the patch as if it were a
 * whole Settings — is what stops `{ui:{theme:'dark'}}` from resetting
 * `engine.maxTurnsPerStep`.
 */
export function mergeSettings(
  current: Settings,
  patch: SettingsPatch,
): Settings {
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const existing = merged[key];
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      typeof existing === 'object' &&
      existing !== null &&
      !Array.isArray(existing)
    ) {
      merged[key] = { ...(existing as object), ...(value as object) };
      continue;
    }
    merged[key] = value;
  }
  // Validate the *result*, not the patch: a patch is legal, an illegal result
  // is not, and this is where a bad combination is caught as a whole.
  return SettingsSchema.parse(merged);
}

export function createSettingsStore(
  options: SettingsStoreOptions,
): SettingsStore {
  const { file, logger, events } = options;

  let cache: Settings = SettingsSchema.parse({});
  let lastRejected: RejectedField[] = [];
  let loaded = false;
  /** Serialises read-modify-write so two concurrent patches cannot interleave. */
  let queue: Promise<unknown> = Promise.resolve();

  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    // Keep the chain alive even if this link rejects.
    queue = next.catch(() => undefined);
    return next;
  };

  const load = async (): Promise<SettingsLoadResult> => {
    // `readJsonFile` returns null for both "missing" and "not JSON"; the stat
    // is only to tell the two apart in the log line.
    const raw = await readJsonFile<unknown>(file);
    const missing = raw === null && !(await pathExists(file));
    const unparseable = raw === null && !missing;

    const { value, rejected } = coerceWithDefaults(SettingsSchema, raw ?? {});
    cache = value;
    lastRejected = rejected;
    loaded = true;

    if (unparseable) {
      logger.warn(
        'settings.json is not valid JSON; using defaults until it is fixed or overwritten',
        { file },
      );
    } else if (rejected.length > 0) {
      logger.warn('settings.json had values we could not use', {
        file,
        rejected: summarizeRejections(rejected),
      });
    } else if (missing) {
      logger.info('no settings.json yet; using defaults', { file });
    }

    return { settings: cache, rejected, missing, unparseable };
  };

  const get = async (): Promise<Settings> => {
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
        // Parsed with the patch schema, whose defaults are stripped, so
        // "absent" stays absent rather than becoming "reset to factory".
        const parsed = SettingsPatchSchema.parse(patch ?? {});
        const base = loaded ? cache : (await load()).settings;
        const next = mergeSettings(base, parsed);

        await writeJsonFileAtomic(file, next);
        cache = next;
        loaded = true;
        events.emit('settings:changed', { settings: next });
        logger.info('settings updated', { keys: Object.keys(parsed) });
        return next;
      }),
  };
}
