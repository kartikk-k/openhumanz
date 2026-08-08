/**
 * The macOS module.
 *
 * AppleScript reaches Mail, Calendar, Contacts, Notes, Reminders and Finder with
 * no credentials, no OAuth, no network and no per-call cost. That makes it the
 * highest-leverage capability in the product and, because it is arbitrary code
 * execution against the user's own accounts, the one with the most ways to be
 * wrong. The parts, in the order they matter:
 *
 *  - `escape.ts`      the only path from a value to AppleScript source, and the
 *                     argument to never touching it. Security-critical.
 *  - `scripts/*.applescript` + `scripts.ts` — bodies as files, prelude
 *                     concatenated, materialised out of `app.asar` so
 *                     `osascript` can read them.
 *  - `osascript.ts`   the single execution path: hard timeouts, one call at a
 *                     time per app, JSON validated by zod before anything sees it.
 *  - `errors.ts`      error numbers to typed failures, and `-1743` to a
 *                     remediation card rather than a stack trace.
 *  - `diagnostics.ts` every invocation recorded, because hardened runtime
 *                     failures tell Node nothing.
 *  - `permissions.ts` per app-pair Automation state, Full Disk Access separately.
 *  - `version.ts`     what each operation is prepared to run on, so a broken
 *                     release falls through instead of returning wrong data.
 *  - `providers/`     capability resolution, once, generically.
 *  - `tools.ts`       the MCP surface. Read-only first; every write is
 *                     `sideEffecting` and mail composition drafts, never sends.
 *
 * **On anything that is not macOS this module loads, starts, registers its tools
 * and reports every capability unavailable with a reason.** It does not throw
 * and it does not spawn anything. That is not a courtesy to the Linux
 * development machine — a tool that throws on an unsupported platform produces
 * an opaque failure the model retries, where an `available: false` with a reason
 * produces an explanation to the user.
 *
 * Wiring is in `docs/INTEGRATION.md`. In brief: add to the registry list, call
 * `macosProviderAvailability()` when building `EnvironmentStatus`, call
 * `refreshMacosPermissions()` on window focus, and merge
 * {@link OSASCRIPT_DENY_RULES} into the agent CLI's deny list.
 */
import path from 'node:path';
import { defineModule, type AppModule, type ModuleContext } from '../types';
import type { Logger } from '../../infra/logger';
import type { ProviderAvailability } from '../../../shared/engines';
import { APPLE_APPS, type AppleAppId } from './apps';
import {
  Diagnostics,
  migrations as diagnosticsMigrations,
  type DiagnosticsQuery,
  type DiagnosticsSummary,
  type InvocationRecord,
} from './diagnostics';
import { OsascriptRunner } from './osascript';
import { PermissionManager, type PermissionStatus } from './permissions';
import { ScriptStore } from './scripts';
import { createMacosTools } from './tools';
import {
  detectMacosVersion,
  type CapabilityOp,
  type MacosVersion,
} from './version';
import {
  CapabilityRegistry,
  type CapabilitySummary,
} from './providers/registry';
import type { AppleProviderDeps } from './providers/apple-base';
import { createAppleMailProvider } from './providers/apple-mail';
import { createAppleCalendarProvider } from './providers/apple-calendar';
import { createAppleContactsProvider } from './providers/apple-contacts';
import { createAppleNotesProvider } from './providers/apple-notes';
import { createAppleRemindersProvider } from './providers/apple-reminders';
import { createAppleFinderProvider } from './providers/apple-finder';

export const MACOS_MODULE_ID = 'macos';

/** Directory under the workspace root holding the materialised scripts. */
export const MATERIALIZED_SCRIPTS_DIRNAME = 'macos-scripts';

/* ------------------------------------------------------------------ */
/* The environment report                                              */
/* ------------------------------------------------------------------ */

/**
 * Everything an onboarding or settings screen needs about this Mac, in one
 * object. Also what the `macos_capabilities` tool returns, so the model and the
 * user are looking at the same facts.
 */
export interface MacosEnvironment {
  platform: NodeJS.Platform;
  isMac: boolean;
  /** Null off macOS, or when the probe failed. */
  osVersion: MacosVersion | null;
  /** One entry per app whose bundle we looked for. */
  apps: {
    id: AppleAppId;
    name: string;
    installed: boolean;
    automation: PermissionStatus;
  }[];
  capabilities: CapabilitySummary[];
  permissions: PermissionStatus[];
  /** Populated off macOS, and whenever nothing is usable. */
  reason?: string;
  checkedAt: string;
}

export interface MacosModuleOptions {
  /** Overridden in tests. */
  platform?: NodeJS.Platform;
  /** Extra directories to search for the `.applescript` sources. */
  scriptSourceDirs?: string[];
  /** Overridden in tests; otherwise `<workspace>/macos-scripts`. */
  scriptTargetDir?: string;
  appConcurrency?: number;
  globalConcurrency?: number;
}

export interface MacosModule extends AppModule {
  readonly registry: CapabilityRegistry;
  readonly diagnostics: Diagnostics;
  readonly permissions: PermissionManager;
  readonly runner: OsascriptRunner;
  readonly scripts: ScriptStore;
  environment(force?: boolean): Promise<MacosEnvironment>;
  availability(force?: boolean): Promise<ProviderAvailability[]>;
  refreshPermissions(options?: {
    allowLaunch?: boolean;
  }): Promise<PermissionStatus[]>;
  osVersion(): MacosVersion | null;
}

/* ------------------------------------------------------------------ */
/* Construction                                                        */
/* ------------------------------------------------------------------ */

/**
 * A {@link Logger} that resolves through `resolve` on every call.
 *
 * Lines written before `start()` are dropped rather than buffered: they are
 * construction-time noise, and a buffer that flushes on start would replay them
 * out of order with everything else in the log.
 */
function deferredLogger(
  resolve: () => Logger | null,
  scope = MACOS_MODULE_ID,
): Logger {
  const call = (
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    meta?: unknown,
  ): void => {
    const target = resolve();
    if (!target) return;
    if (level === 'error') target.error(message, meta);
    else target[level](message, meta as Record<string, unknown> | undefined);
  };
  return {
    debug: (message, meta) => call('debug', message, meta),
    info: (message, meta) => call('info', message, meta),
    warn: (message, meta) => call('warn', message, meta),
    error: (message, meta) => call('error', message, meta),
    child: (childScope: string) =>
      deferredLogger(() => resolve()?.child(childScope) ?? null, childScope),
    scope,
  };
}

export function createMacosModule(
  options: MacosModuleOptions = {},
): MacosModule {
  const platform = options.platform ?? process.platform;

  let context: ModuleContext | null = null;
  let version: MacosVersion | null = null;
  let started = false;

  const diagnostics = new Diagnostics();
  // Placeholders until start() supplies the real workspace path. Building them
  // now rather than in start() means `tools` can be a stable array on the module
  // object, which the registry collects before start() runs.
  const scripts = new ScriptStore({
    targetDir:
      options.scriptTargetDir ??
      path.join(process.cwd(), MATERIALIZED_SCRIPTS_DIRNAME),
    sourceDirs: options.scriptSourceDirs,
  });

  // Everything below is constructed before `start()`, because the registry
  // collects `tools` first and the tools close over these. So they get a logger
  // that resolves through the module context on every call and discards lines
  // written before there is one.
  const logger = deferredLogger(() => context?.logger ?? null);

  const runner = new OsascriptRunner({
    scripts,
    diagnostics,
    logger,
    platform,
    appConcurrency: options.appConcurrency,
    globalConcurrency: options.globalConcurrency,
  });

  const permissions = new PermissionManager({
    runner,
    logger,
    platform,
  });

  const deps: AppleProviderDeps = {
    runner,
    permissions,
    version: () => version,
    platform,
  };

  const capabilities = new CapabilityRegistry({ logger, platform });

  capabilities.register(createAppleMailProvider(deps));
  capabilities.register(createAppleCalendarProvider(deps));
  capabilities.register(createAppleContactsProvider(deps));
  capabilities.register(createAppleNotesProvider(deps));
  capabilities.register(createAppleRemindersProvider(deps));
  capabilities.register(createAppleFinderProvider(deps));

  const environment = async (force = false): Promise<MacosEnvironment> => {
    if (force) capabilities.invalidate();
    const summaries = await capabilities.summarizeAll({ force });
    const apps = (Object.keys(APPLE_APPS) as AppleAppId[])
      .filter((id) => id !== 'systemevents')
      .map((id) => ({
        id,
        name: APPLE_APPS[id].displayName,
        installed: permissions.isInstalled(id),
        automation: permissions.get('automation', id),
      }));

    const anyAvailable = summaries.some((summary) => summary.available);
    return {
      platform,
      isMac: platform === 'darwin',
      osVersion: version,
      apps,
      capabilities: summaries,
      permissions: permissions.all(),
      reason:
        platform !== 'darwin'
          ? `These capabilities need macOS; this machine is ${platform}.`
          : anyAvailable
            ? undefined
            : 'No macOS capability is usable right now. See each capability for the reason.',
      checkedAt: new Date().toISOString(),
    };
  };

  const tools = createMacosTools({
    registry: capabilities,
    describeEnvironment: async (force: boolean) => {
      const report = await environment(force);
      // The model gets the decision-shaped subset. Permission rows and app
      // bundle paths are for the UI; feeding them to the model is tokens spent
      // on something it cannot act on.
      return {
        ok: true as const,
        platform: report.platform,
        macOSVersion: report.osVersion?.raw,
        reason: report.reason,
        capabilities: report.capabilities.map((summary) => ({
          capability: summary.capability,
          available: summary.available,
          via: summary.activeProviderName,
          reason: summary.reason,
          caveat: summary.caveat,
          remediation: summary.remediation
            ? {
                title: summary.remediation.title,
                whatToDo: summary.remediation.steps,
                settings: summary.remediation.settingsLabel,
              }
            : undefined,
        })),
      };
    },
  });

  const module = defineModule({
    id: MACOS_MODULE_ID,
    migrations: diagnosticsMigrations,
    tools,

    async start(ctx: ModuleContext): Promise<void> {
      context = ctx;
      started = true;
      diagnostics.attach(ctx.db);
      permissions.attach(ctx.db);

      if (platform !== 'darwin') {
        ctx.logger.info('macOS capabilities are unavailable on this platform', {
          platform,
        });
        return;
      }

      // A failed version probe is not fatal; `checkOpSupport` treats an unknown
      // version as supported-but-unverified rather than refusing to work.
      try {
        version = await detectMacosVersion({ platform });
        ctx.logger.info('macOS detected', {
          version: version?.raw,
          source: version?.source,
        });
      } catch (cause) {
        ctx.logger.warn('could not determine the macOS version', {
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }

      // Materialising can fail (a read-only workspace, a missing asset). That
      // makes every capability unavailable with a reason, which is a state the
      // UI already renders — it is not a reason to fail startup.
      try {
        scripts.setTargetDir(ctx.paths.resolve(MATERIALIZED_SCRIPTS_DIRNAME));
        const written = await scripts.prepare();
        ctx.logger.debug('AppleScript assets prepared', {
          count: written.length,
          directory: scripts.directory,
        });
      } catch (cause) {
        ctx.logger.error('could not prepare the AppleScript assets', {
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }

      // Deliberately no permission probing here. Probing sends an Apple Event,
      // which prompts, and a prompt at launch — before the user has asked for
      // anything — is how an app teaches people to click Don't Allow. Last known
      // state was just loaded from the database; onboarding calls
      // refreshPermissions({allowLaunch:true}) when the user asks for it.
    },

    async stop(): Promise<void> {
      started = false;
      capabilities.invalidate();
      diagnostics.detach();
      permissions.detach();
      await scripts.cleanup();
      context = null;
    },
  });

  return Object.assign(module, {
    registry: capabilities,
    diagnostics,
    permissions,
    runner,
    scripts,
    environment,
    availability: (force = false) => capabilities.availability({ force }),
    refreshPermissions: async (
      refreshOptions: { allowLaunch?: boolean } = {},
    ) => {
      const result = await permissions.refresh(refreshOptions);
      // Permission state is an input to every provider check, so a change has
      // to invalidate them or the next resolve answers from a stale cache.
      capabilities.invalidate();
      return result;
    },
    osVersion: () => version,
    get isStarted() {
      return started;
    },
  }) as MacosModule;
}

/** The instance the registry uses. */
const macosModule = createMacosModule();

export default macosModule;

/* ------------------------------------------------------------------ */
/* Accessors for services and the shell                                */
/* ------------------------------------------------------------------ */

/** Availability rows to merge into `EnvironmentStatus.providers`. */
export function macosProviderAvailability(
  force = false,
): Promise<ProviderAvailability[]> {
  return macosModule.availability(force);
}

/** Full report for the onboarding and settings screens. */
export function macosEnvironment(force = false): Promise<MacosEnvironment> {
  return macosModule.environment(force);
}

/**
 * Re-check permissions. Call on window focus: the user may have just changed a
 * grant in System Settings and macOS does not notify anyone when they do.
 *
 * `allowLaunch` opens an app that is not running in order to probe it. Pass it
 * only from a screen where the user pressed a button that says so.
 */
export function refreshMacosPermissions(options?: {
  allowLaunch?: boolean;
}): Promise<PermissionStatus[]> {
  return macosModule.refreshPermissions(options);
}

/** Recent `osascript` invocations, for the diagnostics view. */
export function macosDiagnostics(query?: DiagnosticsQuery): InvocationRecord[] {
  return macosModule.diagnostics.recent(query);
}

export function macosDiagnosticsSummary(): DiagnosticsSummary {
  return macosModule.diagnostics.summary();
}

/* Public surface for services and tests. */
export {
  OSASCRIPT_DENY_RULES,
  commandReachesOsascript,
  OSA_BINARIES,
} from './shell-guard';
export { MACOS_TOOL_NAMES, MACOS_SIDE_EFFECTING_TOOLS } from './tools';
export {
  MacosError,
  mapAppleScriptError,
  parseErrorNumber,
  SETTINGS_PANES,
  automationRemediation,
  fullDiskAccessRemediation,
  type MacosErrorKind,
  type PermissionKind,
  type RemediationCard,
} from './errors';
export {
  appleScriptStringExpr,
  appleScriptAppLiteral,
  renderScript,
  buildArgv,
  dateArgs,
  joinArgList,
  AppleScriptEscapeError,
  ArgvError,
} from './escape';
export {
  ScriptStore,
  SCRIPT_SPECS,
  composeScript,
  resolveScriptDir,
} from './scripts';
export { OsascriptRunner, OSASCRIPT_PATH } from './osascript';
export { Semaphore } from './semaphore';
export { Diagnostics } from './diagnostics';
export { PermissionManager, TRACKED_AUTOMATION_APPS } from './permissions';
export {
  CapabilityRegistry,
  unavailableResult,
  type CapabilitySummary,
  type ProviderStatus,
  type Resolution,
} from './providers/registry';
export {
  CAPABILITY_IDS,
  PROVIDER_TIERS,
  TIER_PRIORITY,
  type CapabilityId,
  type CapabilityProvider,
  type ProviderTier,
} from './providers/types';
export {
  detectMacosVersion,
  checkOpSupport,
  parseProductVersion,
  macosVersionFromDarwin,
  SUPPORT_MATRIX,
  CAPABILITY_OPS,
  type MacosVersion,
} from './version';
export { APPLE_APPS, APPLE_APP_IDS, type AppleAppId } from './apps';
export type { CapabilityOp };
export type { PermissionStatus } from './permissions';
export type {
  DiagnosticsQuery,
  DiagnosticsSummary,
  InvocationRecord,
} from './diagnostics';
