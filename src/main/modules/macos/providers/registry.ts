/**
 * Capability resolution: "prefer the local app when present, else fall back",
 * implemented once.
 *
 * The alternative — an `if (process.platform === 'darwin' && mailInstalled)` at
 * the top of every mail tool — is the shape this module is built to avoid. It
 * puts the same three-line decision in a dozen places, each of which drifts, and
 * it means adding a second mail backend touches every one of them. Here the
 * decision lives in {@link CapabilityRegistry.resolve} and a new provider is a
 * `register()` call.
 *
 * Resolution order is tier first (local app, then local protocol, then direct
 * API, then brokered), then declared priority, then registration order. Within
 * that order the first provider that is **usable now** *and* **supports the
 * requested operation on this OS version** wins. Both halves matter: a provider
 * can be perfectly healthy and still be the wrong answer for one operation
 * because Apple broke it in the current release, and the point of the fallback
 * chain is that this degrades to another provider rather than to a wrong
 * answer.
 *
 * Every failed candidate is reported, not swallowed. `attempted` is what turns
 * "mail search is unavailable" into "Apple Mail: permission denied; IMAP: not
 * configured", which is the difference between a support ticket and a fix.
 */
import { nowIso } from '../../../../shared/common';
import type { ProviderAvailability } from '../../../../shared/engines';
import type { Logger } from '../../../infra/logger';
import { MacosError, type RemediationCard } from '../errors';
import type { PermissionStatus } from '../permissions';
import type { CapabilityOp } from '../version';
import {
  CAPABILITY_IDS,
  TIER_PRIORITY,
  type AnyCapabilityProvider,
  type CapabilityId,
  type CapabilityOps,
  type CapabilityProvider,
  type ProviderCheck,
} from './types';

/** How long a check result is trusted before it is recomputed. */
export const CHECK_TTL_MS = 30_000;

export interface ProviderStatus {
  providerId: string;
  name: string;
  capability: CapabilityId;
  tier: string;
  usable: boolean;
  reason?: string;
  degraded: boolean;
  degradedReason?: string;
  permissions: PermissionStatus[];
  remediation?: RemediationCard;
  checkedAt: string;
}

export interface Resolution<C extends CapabilityId> {
  capability: C;
  op?: CapabilityOp;
  provider: CapabilityProvider<C> | null;
  operations: CapabilityOps[C] | null;
  /** Set when the chosen provider works but with a caveat. */
  caveat?: string;
  /** Every provider considered and why it was not chosen. */
  attempted: { providerId: string; name: string; reason: string }[];
  remediation?: RemediationCard;
}

export interface CapabilitySummary {
  capability: CapabilityId;
  available: boolean;
  /** Provider that would serve a call right now. */
  activeProviderId?: string;
  activeProviderName?: string;
  reason?: string;
  caveat?: string;
  providers: ProviderStatus[];
  remediation?: RemediationCard;
}

interface CachedCheck {
  at: number;
  result: ProviderCheck;
}

export interface CapabilityRegistryOptions {
  logger: Logger;
  /** Overridden in tests. */
  now?: () => number;
  ttlMs?: number;
  platform?: NodeJS.Platform;
}

export class CapabilityRegistry {
  private readonly providers: AnyCapabilityProvider[] = [];

  private readonly checks = new Map<string, CachedCheck>();

  private readonly inflight = new Map<string, Promise<ProviderCheck>>();

  private readonly logger: Logger;

  private readonly now: () => number;

  private readonly ttlMs: number;

  private readonly platform: NodeJS.Platform;

  constructor(options: CapabilityRegistryOptions) {
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? CHECK_TTL_MS;
    this.platform = options.platform ?? process.platform;
  }

  register(provider: AnyCapabilityProvider): void {
    if (this.providers.some((existing) => existing.id === provider.id)) {
      throw new Error(`Provider "${provider.id}" is already registered.`);
    }
    this.providers.push(provider);
  }

  all(): readonly AnyCapabilityProvider[] {
    return this.providers;
  }

  /** Providers for one capability, in resolution order. */
  providersFor<C extends CapabilityId>(
    capability: C,
  ): CapabilityProvider<C>[] {
    return this.providers
      .map((provider, index) => ({ provider, index }))
      .filter((entry) => entry.provider.capability === capability)
      .sort((a, b) => {
        const tier =
          TIER_PRIORITY[a.provider.tier] - TIER_PRIORITY[b.provider.tier];
        if (tier !== 0) return tier;
        const priority =
          (a.provider.priority ?? 0) - (b.provider.priority ?? 0);
        if (priority !== 0) return priority;
        return a.index - b.index;
      })
      .map((entry) => entry.provider as CapabilityProvider<C>);
  }

  /** Drop cached checks so the next resolve re-probes. Window focus calls this. */
  invalidate(providerId?: string): void {
    if (providerId) this.checks.delete(providerId);
    else this.checks.clear();
  }

  /**
   * A provider's check result, cached and deduplicated.
   *
   * A throwing `check()` is a bug in the provider, and the registry treats it as
   * unusable with the error text as the reason rather than propagating: one
   * broken provider must not be able to take down resolution for a capability
   * that has a working fallback behind it.
   */
  async check(
    provider: AnyCapabilityProvider,
    force = false,
  ): Promise<ProviderCheck> {
    if (!provider.platforms.includes(this.platform)) {
      return {
        usable: false,
        reason: `${provider.name} needs ${provider.platforms.join(' or ')}; this is ${this.platform}.`,
      };
    }

    const cached = this.checks.get(provider.id);
    if (!force && cached && this.now() - cached.at < this.ttlMs) {
      return cached.result;
    }

    const existing = this.inflight.get(provider.id);
    if (existing) return existing;

    const pending = (async (): Promise<ProviderCheck> => {
      try {
        return await provider.check();
      } catch (cause) {
        const message =
          cause instanceof MacosError
            ? cause.message
            : cause instanceof Error
              ? cause.message
              : String(cause);
        this.logger.warn('provider check threw', {
          providerId: provider.id,
          error: message,
        });
        return { usable: false, reason: message };
      }
    })();

    this.inflight.set(provider.id, pending);
    try {
      const result = await pending;
      this.checks.set(provider.id, { at: this.now(), result });
      return result;
    } finally {
      this.inflight.delete(provider.id);
    }
  }

  /**
   * Pick the provider that should serve this call.
   *
   * Never throws and never returns a partly-usable provider. When nothing can
   * serve the call, `provider` is null and `attempted` explains every candidate
   * — including the ones eliminated by the OS version, which is the case that is
   * otherwise impossible to diagnose from the outside.
   */
  async resolve<C extends CapabilityId>(
    capability: C,
    op?: CapabilityOp,
    options: { force?: boolean } = {},
  ): Promise<Resolution<C>> {
    const attempted: Resolution<C>['attempted'] = [];
    let remediation: RemediationCard | undefined;

    for (const provider of this.providersFor(capability)) {
      if (op && !provider.ops.includes(op)) {
        attempted.push({
          providerId: provider.id,
          name: provider.name,
          reason: `${provider.name} does not implement ${op}.`,
        });
        continue;
      }

      const verdict = op ? provider.supports(op) : { supported: true, degraded: false };
      if (!verdict.supported) {
        attempted.push({
          providerId: provider.id,
          name: provider.name,
          reason: verdict.reason ?? `${provider.name} cannot do this on this macOS version.`,
        });
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const check = await this.check(provider, options.force);
      if (!check.usable) {
        attempted.push({
          providerId: provider.id,
          name: provider.name,
          reason: check.reason ?? `${provider.name} is not available.`,
        });
        remediation = remediation ?? check.remediation;
        continue;
      }

      const caveats = [verdict.reason, check.degradedReason].filter(
        (value): value is string => Boolean(value),
      );
      return {
        capability,
        op,
        provider,
        operations: provider.operations as CapabilityOps[C],
        caveat: caveats.length > 0 ? caveats.join(' ') : undefined,
        attempted,
      };
    }

    return {
      capability,
      op,
      provider: null,
      operations: null,
      attempted,
      remediation,
    };
  }

  /** Full status of every provider for one capability. */
  async summarize<C extends CapabilityId>(
    capability: C,
    options: { force?: boolean } = {},
  ): Promise<CapabilitySummary> {
    const providers = this.providersFor(capability);
    const statuses: ProviderStatus[] = [];

    for (const provider of providers) {
      // eslint-disable-next-line no-await-in-loop
      const check = await this.check(provider, options.force);
      statuses.push({
        providerId: provider.id,
        name: provider.name,
        capability,
        tier: provider.tier,
        usable: check.usable,
        reason: check.reason,
        degraded: check.degraded ?? false,
        degradedReason: check.degradedReason,
        permissions: check.permissions ?? [],
        remediation: check.remediation,
        checkedAt: nowIso(),
      });
    }

    const active = statuses.find((status) => status.usable);
    return {
      capability,
      available: Boolean(active),
      activeProviderId: active?.providerId,
      activeProviderName: active?.name,
      reason: active
        ? undefined
        : statuses.length === 0
          ? `Nothing on this machine provides ${capability}.`
          : statuses
              .map((status) => `${status.name}: ${status.reason ?? 'unavailable'}`)
              .join('; '),
      caveat: active?.degradedReason,
      providers: statuses,
      remediation: active
        ? undefined
        : statuses.find((status) => status.remediation)?.remediation,
    };
  }

  /** Every capability, for the settings and onboarding screens. */
  async summarizeAll(
    options: { force?: boolean } = {},
  ): Promise<CapabilitySummary[]> {
    const out: CapabilitySummary[] = [];
    for (const capability of CAPABILITY_IDS) {
      // eslint-disable-next-line no-await-in-loop
      out.push(await this.summarize(capability, options));
    }
    return out;
  }

  /**
   * The same information in `shared/engines.ts`'s `ProviderAvailability` shape,
   * one row per capability, so a service can merge it straight into
   * `EnvironmentStatus.providers` with no adapter.
   */
  async availability(
    options: { force?: boolean } = {},
  ): Promise<ProviderAvailability[]> {
    const summaries = await this.summarizeAll(options);
    const checkedAt = nowIso();
    return summaries.map((summary) => {
      const platforms = [
        ...new Set(
          this.providersFor(summary.capability).flatMap(
            (provider) => provider.platforms,
          ),
        ),
      ];
      const permissions = summary.providers.flatMap(
        (status) => status.permissions,
      );
      const requiresPermission = permissions.length > 0;
      const granted =
        requiresPermission &&
        permissions.every((permission) => permission.state === 'granted');
      return {
        id: summary.capability,
        name: summary.activeProviderName ?? capabilityLabel(summary.capability),
        available: summary.available,
        platforms,
        // The schema promises this is never empty when unavailable.
        reason: summary.available
          ? undefined
          : summary.reason || 'Unavailable on this machine.',
        requiresPermission,
        permissionGranted: requiresPermission ? granted : undefined,
        checkedAt,
      };
    });
  }
}

function capabilityLabel(capability: CapabilityId): string {
  return capability.charAt(0).toUpperCase() + capability.slice(1);
}

/**
 * What a tool returns when no provider can serve the call.
 *
 * A value, not an exception. The model can read it, decide the capability is
 * out and say so to the user; an exception would arrive as an opaque string and
 * usually produces a retry.
 */
export interface UnavailableResult {
  ok: false;
  available: false;
  capability: CapabilityId;
  error: { kind: 'unavailable'; message: string };
  tried: { provider: string; reason: string }[];
  remediation?: RemediationCard;
}

export function unavailableResult<C extends CapabilityId>(
  resolution: Resolution<C>,
): UnavailableResult {
  const message =
    resolution.attempted.length === 0
      ? `Nothing on this machine can do ${resolution.capability}${resolution.op ? ` (${resolution.op})` : ''}.`
      : resolution.attempted.map((entry) => entry.reason).join(' ');
  return {
    ok: false,
    available: false,
    capability: resolution.capability,
    error: { kind: 'unavailable', message },
    tried: resolution.attempted.map((entry) => ({
      provider: entry.name,
      reason: entry.reason,
    })),
    remediation: resolution.remediation,
  };
}
