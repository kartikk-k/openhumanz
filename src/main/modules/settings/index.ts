/**
 * The `settings` module.
 *
 * Owns three files' worth of state and the three IPC slices that read it:
 * `settings:*` (preferences, in `settings.json`), `onboarding:*` (first-run
 * progress, in `onboarding.json`) and `engines:*` (what this machine can
 * actually do). They live together because the settings window and the
 * onboarding flow are the same screen asking the same question at two
 * different moments.
 *
 * It owns no tables. Everything here is a human-readable file in the workspace
 * root — settings you can open in an editor is a feature, not an oversight,
 * and it is why `./coerce` exists.
 *
 * Detection is *injected*. The engine adapters are a service, and a module may
 * not import one, so `bootstrap.ts` calls {@link configureSettings} with the
 * engine registry. Until it does, `engines:*` answers with a status whose
 * warnings say exactly that rather than throwing.
 */
import type { AppModule, IpcHandlerMap, ModuleContext } from '../types';
import type { SettingsStore } from './store';
import { createSettingsStore } from './store';
import type { OnboardingStore } from './onboarding';
import { createOnboardingStore } from './onboarding';
import type {
  EnvironmentCache,
  EnvironmentProvider,
  ProviderContributor,
} from './environment';
import { createEnvironmentCache } from './environment';
import { createEnvironmentTools } from './tools';
import { EngineDetectRequestSchema } from '../../../shared/engines';

export { createSettingsStore, mergeSettings } from './store';
export type { SettingsStore, SettingsLoadResult } from './store';
export { createOnboardingStore, mergeOnboarding } from './onboarding';
export type { OnboardingStore } from './onboarding';
export {
  createEnvironmentCache,
  environmentFingerprint,
  NOT_CONFIGURED_WARNING,
} from './environment';
export type {
  EnvironmentCache,
  EnvironmentDetectOptions,
  EnvironmentProvider,
  EnvironmentReport,
  ProviderContributor,
} from './environment';
export { coerceWithDefaults, summarizeRejections } from './coerce';
export type { RejectedField, CoercionResult } from './coerce';

/** What `bootstrap.ts` may hand this module. Every field is optional. */
export interface SettingsWiring {
  /**
   * Engine detection. `EngineRegistry` satisfies this as-is — pass it
   * directly. Without it `engines:*` reports "not configured".
   */
  environment?: EnvironmentProvider;
  /**
   * Contributors to `EnvironmentStatus.providers`, one per capability module
   * (macos, and whatever comes next). Replaces the list; call once with all of
   * them, or use {@link SettingsModule.addProviderContributor} to append.
   */
  providers?: readonly ProviderContributor[];
}

export interface SettingsModule extends AppModule {
  configure(wiring: SettingsWiring): void;
  /** Append one contributor without disturbing the others. */
  addProviderContributor(contributor: ProviderContributor): void;
  /** The live stores. Throw before `start()`. */
  settings(): SettingsStore;
  onboarding(): OnboardingStore;
  environment(): EnvironmentCache;
}

export function createSettingsModule(
  initial: SettingsWiring = {},
): SettingsModule {
  let settingsStore: SettingsStore | null = null;
  let onboardingStore: OnboardingStore | null = null;

  let provider: EnvironmentProvider | undefined = initial.environment;
  let contributors: ProviderContributor[] = [...(initial.providers ?? [])];

  const notStarted = (what: string): Error =>
    new Error(`The settings module has not started yet (asked for ${what}).`);

  const requireSettings = (): SettingsStore => {
    if (!settingsStore) throw notStarted('settings');
    return settingsStore;
  };
  const requireOnboarding = (): OnboardingStore => {
    if (!onboardingStore) throw notStarted('onboarding');
    return onboardingStore;
  };

  /**
   * The environment cache is built at `start()` like the stores, but it reads
   * its provider through a getter, so `configureSettings` may be called before
   * or after startup and the ordering never has to be remembered.
   */
  let environmentCache: EnvironmentCache | null = null;
  const requireEnvironment = (): EnvironmentCache => {
    if (!environmentCache) throw notStarted('environment');
    return environmentCache;
  };

  const ipc: IpcHandlerMap = {
    'settings:get': async () => requireSettings().get(),

    'settings:set': async (request) => requireSettings().set(request),

    'onboarding:get': async () => requireOnboarding().get(),

    'onboarding:set': async (request) => requireOnboarding().set(request),

    'engines:detect': async (request) => {
      const { force } = EngineDetectRequestSchema.parse(request ?? {});
      return requireEnvironment().engines({ force });
    },

    'engines:status': async () => requireEnvironment().status(),
  };

  return {
    id: 'settings',
    // No tables: this module's state is files a human can read.
    migrations: [],
    ipc,
    tools: createEnvironmentTools({
      status: (detectOptions) => requireEnvironment().status(detectOptions),
    }),

    configure(wiring) {
      if (wiring.environment !== undefined) provider = wiring.environment;
      if (wiring.providers !== undefined) {
        contributors = [...wiring.providers];
      }
      // A newly wired provider makes the cached "not configured" answer wrong.
      environmentCache?.invalidate();
    },

    addProviderContributor(contributor) {
      contributors = [
        ...contributors.filter((item) => item.id !== contributor.id),
        contributor,
      ];
      environmentCache?.invalidate();
    },

    settings: requireSettings,
    onboarding: requireOnboarding,
    environment: requireEnvironment,

    async start(ctx: ModuleContext) {
      settingsStore = createSettingsStore({
        file: ctx.paths.settingsFile,
        logger: ctx.logger.child('file'),
        events: ctx.events,
      });
      onboardingStore = createOnboardingStore({
        file: ctx.paths.onboardingFile,
        logger: ctx.logger.child('onboarding'),
      });
      environmentCache = createEnvironmentCache({
        provider: () => provider,
        contributors: () => contributors,
        logger: ctx.logger.child('environment'),
        events: ctx.events,
      });

      // Load eagerly so a hand-edited file is reported at startup, in the log,
      // next to the workspace path — not on the first click in the UI.
      const loaded = await settingsStore.load();
      if (loaded.rejected.length > 0) {
        ctx.logger.warn('using defaults for some settings', {
          count: loaded.rejected.length,
        });
      }
      await onboardingStore.load();
    },

    async stop() {
      settingsStore = null;
      onboardingStore = null;
      environmentCache = null;
    },
  };
}

/**
 * The instance the registry uses. The factory exists so tests can have their
 * own, exactly as in the runs module.
 */
export const settingsModule: SettingsModule = createSettingsModule();

/**
 * Wire engine detection (and any provider contributors) in from `bootstrap.ts`.
 *
 * ```ts
 * import settingsModule, { configureSettings } from './modules/settings';
 * // …
 * configureSettings({ environment: engines });
 * ```
 *
 * Safe to call before or after `registry.start()`, and safe to call again —
 * the cached environment is invalidated so the next probe uses the new wiring.
 */
export function configureSettings(wiring: SettingsWiring): void {
  settingsModule.configure(wiring);
}

/** The live settings, for services that need the user's limits. */
export function getSettingsStore(): SettingsStore {
  return settingsModule.settings();
}

export default settingsModule;
