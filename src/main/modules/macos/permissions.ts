/**
 * Permission state, and the data an onboarding screen needs to fix it.
 *
 * Three facts about macOS permissions shape everything here, and all three are
 * things people get wrong:
 *
 *  1. **Automation permission is per source app / target app pair.** Being
 *     allowed to control Mail says nothing about Calendar. There is one row per
 *     pair, not one row for "AppleScript".
 *  2. **It prompts exactly once, and cannot be pre-granted or re-triggered.**
 *     There is no API to ask for it, no API to read it without asking, and once
 *     the user has answered, macOS never asks again. A denial is permanent until
 *     the user reverses it in System Settings by hand. That is why a
 *     `permission-denied` error is not retryable, why retry loops are a bug, and
 *     why the remediation card has to carry the exact pane.
 *  3. **Full Disk Access is a different permission and does not follow from
 *     Automation.** Talking to Mail via Apple Events needs Automation; reading
 *     `~/Library/Mail` off disk needs Full Disk Access. Conflating them produces
 *     an onboarding screen that tells the user to do the wrong thing.
 *
 * The only way to learn the Automation state is to send an event and see what
 * comes back — which will prompt, and which will launch the app if it is not
 * running. So probing is explicit and consent-driven: the state stays
 * `undetermined` until something deliberately probes, and by default we will not
 * launch an app the user did not open. Last known state is persisted so a
 * relaunch does not re-prompt for what we already know.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nowIso, type IsoDateTime } from '../../../shared/common';
import type { Db } from '../../infra/db';
import type { Logger } from '../../infra/logger';
import { APPLE_APPS, type AppleAppId } from './apps';
import {
  automationRemediation,
  fullDiskAccessRemediation,
  MacosError,
  SETTINGS_PANES,
  type PermissionKind,
  type RemediationCard,
} from './errors';
import { ProbeResultSchema } from './schema';
import type { OsascriptRunner } from './osascript';

export const PERMISSION_STATES = [
  'granted',
  'denied',
  /** Never probed, or probed without permission to launch a quit app. */
  'undetermined',
  /** The app is not installed, or this is not macOS. */
  'not-applicable',
] as const;
export type PermissionState = (typeof PERMISSION_STATES)[number];

/**
 * One permission row. This is the shape the onboarding screen renders and the
 * shape a capability's `reason` is derived from.
 */
export interface PermissionStatus {
  /** `automation:mail`, `full-disk-access`. Primary key. */
  key: string;
  kind: PermissionKind;
  appId?: AppleAppId;
  /** What the user calls the target, for the card. */
  appName?: string;
  state: PermissionState;
  checkedAt: IsoDateTime;
  /** The AppleScript error number that produced a denial, when there was one. */
  errorNumber?: number;
  /** One sentence, plain language. Safe to show verbatim. */
  detail: string;
  settingsUrl: string;
  settingsUrlLegacy: string;
  settingsLabel: string;
  /**
   * True when macOS will only ever ask the user once. Onboarding uses this to
   * explain why there is no "ask me again" button — there is no such API.
   */
  promptsOnce: boolean;
  /** Present whenever the state is `denied`. */
  remediation?: RemediationCard;
}

/** Apps whose Automation grant we track. System Events is not on the surface. */
export const TRACKED_AUTOMATION_APPS: readonly AppleAppId[] = [
  'mail',
  'calendar',
  'contacts',
  'notes',
  'reminders',
  'finder',
];

/**
 * A file only a process with Full Disk Access can open.
 *
 * Reading it is a *non-prompting* probe: without the grant the open fails with
 * EPERM and nothing appears on screen, which is what makes it safe to run at
 * startup. `~/Library/Mail` is the second probe because a machine with no Mail
 * data has no TCC user database either on a fresh account.
 */
export const FULL_DISK_ACCESS_PROBES = [
  'Library/Application Support/com.apple.TCC/TCC.db',
  'Library/Mail',
] as const;

export interface PermissionManagerOptions {
  runner: OsascriptRunner;
  logger: Logger;
  platform?: NodeJS.Platform;
  /** Overridden in tests. */
  homedir?: () => string;
  /** Overridden in tests; must not prompt. */
  probeFile?: (filePath: string) => Promise<'ok' | 'denied' | 'missing'>;
  /** Overridden in tests. */
  bundleExists?: (bundlePath: string) => boolean;
}

export class PermissionManager {
  private readonly runner: OsascriptRunner;

  private readonly logger: Logger;

  private readonly platform: NodeJS.Platform;

  private readonly homedir: () => string;

  private readonly probeFile: (
    filePath: string,
  ) => Promise<'ok' | 'denied' | 'missing'>;

  private readonly bundleExists: (bundlePath: string) => boolean;

  private readonly cache = new Map<string, PermissionStatus>();

  private db: Db | null = null;

  constructor(options: PermissionManagerOptions) {
    this.runner = options.runner;
    this.logger = options.logger;
    this.platform = options.platform ?? process.platform;
    this.homedir = options.homedir ?? os.homedir;
    this.probeFile = options.probeFile ?? defaultProbeFile;
    this.bundleExists =
      options.bundleExists ??
      ((bundlePath) => {
        try {
          return fs.existsSync(bundlePath);
        } catch {
          return false;
        }
      });
  }

  attach(db: Db): void {
    this.db = db;
    this.loadFromDb();
  }

  detach(): void {
    this.db = null;
  }

  get isMac(): boolean {
    return this.platform === 'darwin';
  }

  /** Whether the app bundle is present. No Apple Event, no prompt. */
  isInstalled(appId: AppleAppId): boolean {
    if (!this.isMac) return false;
    return APPLE_APPS[appId].bundlePaths.some((bundlePath) =>
      this.bundleExists(bundlePath),
    );
  }

  /** Last known state, without probing. */
  get(kind: PermissionKind, appId?: AppleAppId): PermissionStatus {
    const key = permissionKey(kind, appId);
    const cached = this.cache.get(key);
    if (cached) return cached;
    return this.blank(kind, appId);
  }

  /** Every tracked permission, last known state. */
  all(): PermissionStatus[] {
    const out: PermissionStatus[] = [];
    for (const appId of TRACKED_AUTOMATION_APPS) {
      out.push(this.get('automation', appId));
    }
    out.push(this.get('full-disk-access'));
    return out;
  }

  /**
   * Probe one app's Automation grant.
   *
   * `allowLaunch` is off by default and the script honours it: with the app quit
   * we report `undetermined` rather than opening Mail behind the user's back.
   * Onboarding, where the user has just pressed a button that says what will
   * happen, is the one caller that passes true.
   */
  async probeAutomation(
    appId: AppleAppId,
    options: { allowLaunch?: boolean } = {},
  ): Promise<PermissionStatus> {
    if (!this.isMac) {
      return this.store({
        ...this.blank('automation', appId),
        state: 'not-applicable',
        detail: `AppleScript is only available on macOS; this is ${this.platform}.`,
      });
    }
    if (!this.isInstalled(appId)) {
      return this.store({
        ...this.blank('automation', appId),
        state: 'not-applicable',
        detail: `${APPLE_APPS[appId].displayName} is not installed.`,
      });
    }

    try {
      const result = await this.runner.runScript({
        script: 'probe-app',
        appId,
        args: [options.allowLaunch ? '1' : '0'],
        schema: ProbeResultSchema,
        timeoutMs: 10_000,
      });

      if (!result.probed) {
        return this.store({
          ...this.blank('automation', appId),
          state:
            this.get('automation', appId).state === 'granted'
              ? 'granted'
              : 'undetermined',
          detail: `${APPLE_APPS[appId].displayName} is not running, so permission could not be checked without opening it.`,
        });
      }

      return this.store({
        ...this.blank('automation', appId),
        state: 'granted',
        detail: `Allowed to control ${APPLE_APPS[appId].displayName}.`,
      });
    } catch (cause) {
      const error =
        cause instanceof MacosError
          ? cause
          : new MacosError({ kind: 'unknown', message: String(cause) });

      if (error.kind === 'permission-denied') {
        return this.store({
          ...this.blank('automation', appId),
          state: 'denied',
          errorNumber: error.number,
          detail: `macOS is blocking us from controlling ${APPLE_APPS[appId].displayName}.`,
          remediation: automationRemediation(appId),
        });
      }
      // A timeout or a launch failure says nothing about the permission, so the
      // recorded state is left alone rather than downgraded on a transient.
      this.logger.debug('automation probe inconclusive', {
        appId,
        kind: error.kind,
        number: error.number,
      });
      return this.store({
        ...this.get('automation', appId),
        checkedAt: nowIso(),
        detail: `Could not check: ${error.message}`,
      });
    }
  }

  /**
   * Check Full Disk Access by trying to open a protected file.
   *
   * Deliberately not an Apple Event: FDA is a filesystem grant and the
   * filesystem is where it has to be tested. This never prompts.
   */
  async checkFullDiskAccess(): Promise<PermissionStatus> {
    if (!this.isMac) {
      return this.store({
        ...this.blank('full-disk-access'),
        state: 'not-applicable',
        detail: `Full Disk Access is a macOS permission; this is ${this.platform}.`,
      });
    }

    const home = this.homedir();
    let sawMissing = false;
    for (const relative of FULL_DISK_ACCESS_PROBES) {
      const target = path.join(home, relative);
      // eslint-disable-next-line no-await-in-loop
      const outcome = await this.probeFile(target);
      if (outcome === 'ok') {
        return this.store({
          ...this.blank('full-disk-access'),
          state: 'granted',
          detail: 'Full Disk Access is granted.',
        });
      }
      if (outcome === 'denied') {
        return this.store({
          ...this.blank('full-disk-access'),
          state: 'denied',
          detail:
            'Reading protected files is blocked, so anything that needs Full Disk Access is unavailable.',
          remediation: fullDiskAccessRemediation(
            'Reading protected files is blocked.',
          ),
        });
      }
      sawMissing = true;
    }

    return this.store({
      ...this.blank('full-disk-access'),
      state: sawMissing ? 'undetermined' : 'undetermined',
      detail:
        'Full Disk Access could not be determined: none of the files used to test it exist on this machine.',
    });
  }

  /**
   * Re-check everything. Called on window focus, because the user may have just
   * been in System Settings — there is no notification when a grant changes.
   */
  async refresh(
    options: { allowLaunch?: boolean } = {},
  ): Promise<PermissionStatus[]> {
    const out: PermissionStatus[] = [];
    for (const appId of TRACKED_AUTOMATION_APPS) {
      // Serial on purpose: parallel probes would fan out one Apple Event per app
      // at the same instant, which is exactly the pattern these apps handle
      // worst, and would stack six permission prompts on the user at once.
      // eslint-disable-next-line no-await-in-loop
      out.push(await this.probeAutomation(appId, options));
    }
    out.push(await this.checkFullDiskAccess());
    return out;
  }

  private blank(kind: PermissionKind, appId?: AppleAppId): PermissionStatus {
    const pane = SETTINGS_PANES[kind];
    return {
      key: permissionKey(kind, appId),
      kind,
      appId,
      appName: appId ? APPLE_APPS[appId].displayName : undefined,
      state: 'undetermined',
      checkedAt: nowIso(),
      detail:
        kind === 'automation'
          ? `Permission to control ${appId ? APPLE_APPS[appId].displayName : 'the app'} has not been requested yet.`
          : 'Not checked yet.',
      settingsUrl: pane.url,
      settingsUrlLegacy: pane.legacyUrl,
      settingsLabel: pane.label,
      promptsOnce: kind === 'automation',
    };
  }

  private store(status: PermissionStatus): PermissionStatus {
    const next: PermissionStatus = { ...status, checkedAt: nowIso() };
    this.cache.set(next.key, next);
    const db = this.db;
    if (db) {
      try {
        db.run(
          `INSERT OR REPLACE INTO macos_permissions
             (key, kind, app_id, state, checked_at, error_number, detail)
           VALUES (?,?,?,?,?,?,?)`,
          [
            next.key,
            next.kind,
            next.appId ?? null,
            next.state,
            next.checkedAt,
            next.errorNumber ?? null,
            next.detail,
          ],
        );
      } catch (cause) {
        this.logger.debug('could not persist permission state', {
          key: next.key,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    return next;
  }

  private loadFromDb(): void {
    const db = this.db;
    if (!db) return;
    try {
      const rows = db.all(
        'SELECT key, kind, app_id, state, checked_at, error_number, detail FROM macos_permissions',
      );
      for (const row of rows) {
        const kind = String(row.kind) as PermissionKind;
        const appId = (row.app_id as AppleAppId | null) ?? undefined;
        const base = this.blank(kind, appId);
        const state = String(row.state) as PermissionState;
        this.cache.set(base.key, {
          ...base,
          state,
          checkedAt: String(row.checked_at),
          errorNumber:
            row.error_number === null ? undefined : Number(row.error_number),
          detail: String(row.detail ?? base.detail),
          remediation:
            state === 'denied'
              ? kind === 'automation' && appId
                ? automationRemediation(appId)
                : fullDiskAccessRemediation(String(row.detail ?? ''))
              : undefined,
        });
      }
    } catch (cause) {
      this.logger.debug('could not load permission state', {
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
}

export function permissionKey(
  kind: PermissionKind,
  appId?: AppleAppId,
): string {
  return appId ? `${kind}:${appId}` : kind;
}

/**
 * Try to open a file for reading, classifying the failure.
 *
 * EPERM (and EACCES, which some volumes report instead) means the sandbox
 * refused; ENOENT means the file is simply not there and says nothing about the
 * permission. Anything else is treated as missing rather than denied, because a
 * false "denied" sends the user to a settings pane for no reason.
 */
async function defaultProbeFile(
  filePath: string,
): Promise<'ok' | 'denied' | 'missing'> {
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(filePath, 'r');
    return 'ok';
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') return 'denied';
    if (code === 'EISDIR') return 'ok';
    return 'missing';
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
