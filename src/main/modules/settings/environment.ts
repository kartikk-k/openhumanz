/**
 * "What can this machine actually do right now?" — cached, and injected.
 *
 * Engine detection spawns binaries, and the code that knows how to do that is a
 * *service* (`src/main/services/engines/`). A module may not import a service,
 * so this file declares the narrowest interface it can live with
 * ({@link EnvironmentProvider}) and `bootstrap.ts` hands the real registry in
 * through `configureSettings`. Nothing here can reach execution, and the whole
 * thing is testable with a twelve-line stub.
 *
 * Two consequences worth stating:
 *
 * - With no provider wired the handlers still answer. They return a status
 *   whose `warnings` say plainly that detection is not configured, rather than
 *   throwing or pretending zero engines were found on a healthy machine.
 * - `providers` (mail, calendar, …) belongs to other capability modules. They
 *   register as {@link ProviderContributor}s; this file merges, it never
 *   hardcodes a list it would then have to keep in sync.
 */
import type { EventBus } from '../../infra/events';
import type { Logger } from '../../infra/logger';
import { nowIso } from '../../../shared/common';
import type {
  EngineInfo,
  EnvironmentStatus,
  ProviderAvailability,
} from '../../../shared/engines';

/** Options a detection accepts. A superset is fine; we only ever pass `force`. */
export interface EnvironmentDetectOptions {
  /** Ignore any cached probe and ask the machine again. */
  force?: boolean;
}

/**
 * What a detection returns. `providers` is deliberately absent — it is not the
 * engine layer's to know — and extra fields on the real report are ignored.
 */
export interface EnvironmentReport {
  status: Omit<EnvironmentStatus, 'providers'>;
}

/**
 * The engine layer, as this module needs to see it.
 *
 * Either method name satisfies it. `detectAll` is what `EngineRegistry`
 * already exposes, so the real wiring is `configureSettings({ environment:
 * engineRegistry })` with no adapter in between; `detect` is the shorter name a
 * hand-written stub or a future provider is likely to use.
 */
export type EnvironmentProvider =
  | {
      detectAll(options?: EnvironmentDetectOptions): Promise<EnvironmentReport>;
    }
  | { detect(options?: EnvironmentDetectOptions): Promise<EnvironmentReport> };

/**
 * A capability module contributing to `EnvironmentStatus.providers`.
 *
 * Contributors must not throw: an unavailable capability is a normal result
 * with `available: false` and a `reason`. One that throws anyway is caught,
 * logged, and skipped rather than failing the whole status call.
 */
export interface ProviderContributor {
  /** For the log line when this contributor misbehaves. */
  id: string;
  list(
    options?: EnvironmentDetectOptions,
  ): Promise<ProviderAvailability[]> | ProviderAvailability[];
}

export interface EnvironmentCache {
  /** Cached status, probing only on the first call or when forced. */
  status(options?: EnvironmentDetectOptions): Promise<EnvironmentStatus>;
  /** Engines only, for `engines:detect`. */
  engines(options?: EnvironmentDetectOptions): Promise<EngineInfo[]>;
  /** The last status computed, or null before the first probe. */
  last(): EnvironmentStatus | null;
  /** Drop the cache so the next call probes. */
  invalidate(): void;
}

export interface EnvironmentCacheOptions {
  /** Read at call time, so wiring order does not matter. */
  provider(): EnvironmentProvider | undefined;
  contributors(): readonly ProviderContributor[];
  logger: Logger;
  events: EventBus;
}

/** Shown when nothing was injected. Says what to do, not just what failed. */
export const NOT_CONFIGURED_WARNING =
  'Engine detection is not configured, so no agent CLI can be reported as ' +
  'available. Call configureSettings({ environment }) from bootstrap.ts.';

function callDetect(
  provider: EnvironmentProvider,
  options: EnvironmentDetectOptions,
): Promise<EnvironmentReport> {
  if ('detectAll' in provider) return provider.detectAll(options);
  return provider.detect(options);
}

/**
 * A comparison key that ignores the timestamps.
 *
 * Every probe stamps a fresh `checkedAt`/`detectedAt`, so a raw deep-equal
 * would report a change on every window focus and the UI would redraw forever.
 * What the UI cares about is whether an engine appeared, vanished, or changed
 * its auth — which is everything except the clock.
 */
export function environmentFingerprint(status: EnvironmentStatus): string {
  const stable = {
    platform: status.platform,
    apiKeyEnvDetected: status.apiKeyEnvDetected,
    warnings: status.warnings,
    engines: status.engines.map(({ detectedAt, ...rest }) => rest),
    providers: status.providers.map(({ checkedAt, ...rest }) => rest),
  };
  return JSON.stringify(stable);
}

export function createEnvironmentCache(
  options: EnvironmentCacheOptions,
): EnvironmentCache {
  const { provider, contributors, logger, events } = options;

  let cached: EnvironmentStatus | null = null;
  let fingerprint: string | null = null;
  /** Coalesces concurrent probes — window focus can fire several at once. */
  let inflight: Promise<EnvironmentStatus> | null = null;
  let inflightForced = false;

  const collectProviders = async (
    detectOptions: EnvironmentDetectOptions,
  ): Promise<ProviderAvailability[]> => {
    const lists = await Promise.all(
      contributors().map(async (contributor) => {
        try {
          return await contributor.list(detectOptions);
        } catch (cause) {
          logger.error('provider contributor failed', {
            contributor: contributor.id,
            error: (cause as Error).message,
          });
          return [] as ProviderAvailability[];
        }
      }),
    );
    return lists.flat();
  };

  const probe = async (
    detectOptions: EnvironmentDetectOptions,
  ): Promise<EnvironmentStatus> => {
    const active = provider();
    const providers = await collectProviders(detectOptions);

    if (!active) {
      logger.warn('environment probed with no engine provider wired');
      return {
        platform: process.platform,
        engines: [],
        providers,
        apiKeyEnvDetected: false,
        warnings: [NOT_CONFIGURED_WARNING],
        checkedAt: nowIso(),
      };
    }

    try {
      const report = await callDetect(active, detectOptions);
      return { ...report.status, providers };
    } catch (cause) {
      // Detection is a probe, not a transaction: report the failure as status.
      logger.error('engine detection failed', {
        error: (cause as Error).message,
      });
      return {
        platform: process.platform,
        engines: [],
        providers,
        apiKeyEnvDetected: false,
        warnings: [`Could not check for agent CLIs: ${(cause as Error).message}`],
        checkedAt: nowIso(),
      };
    }
  };

  const status = async (
    detectOptions: EnvironmentDetectOptions = {},
  ): Promise<EnvironmentStatus> => {
    const force = detectOptions.force === true;
    if (!force && cached) return cached;
    // A forced call may not settle for the answer an unforced probe is already
    // fetching, but two forced callers can share one probe.
    if (inflight && (!force || inflightForced)) return inflight;

    inflightForced = force;
    inflight = probe(detectOptions)
      .then((next) => {
        const nextPrint = environmentFingerprint(next);
        cached = next;
        if (nextPrint !== fingerprint) {
          fingerprint = nextPrint;
          events.emit('environment:changed', { status: next });
        }
        return next;
      })
      .finally(() => {
        inflight = null;
      });

    return inflight;
  };

  return {
    status,
    engines: async (detectOptions) => (await status(detectOptions)).engines,
    last: () => cached,
    invalidate: () => {
      cached = null;
    },
  };
}
