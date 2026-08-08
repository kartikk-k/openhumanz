/**
 * What every Apple-app provider shares: the `check()` that decides whether it
 * can run, and the version verdict for one operation.
 *
 * Written once here rather than six times because the answer is always the same
 * four questions in the same order, and because the order is load-bearing: "not
 * macOS" must beat "not installed" must beat "permission denied", or a Linux
 * developer gets told to open System Settings.
 */
import type { AppleAppId } from '../apps';
import { APPLE_APPS } from '../apps';
import type { PermissionManager } from '../permissions';
import type { OsascriptRunner } from '../osascript';
import {
  checkOpSupport,
  type CapabilityOp,
  type MacosVersion,
  type OpVerdict,
} from '../version';
import type { ProviderCheck } from './types';

/** Everything an Apple provider needs from the module. */
export interface AppleProviderDeps {
  runner: OsascriptRunner;
  permissions: PermissionManager;
  /** Latest detected version, or null before detection / off macOS. */
  version(): MacosVersion | null;
  platform: NodeJS.Platform;
}

/**
 * Is this provider usable right now, and if not, why not.
 *
 * `undetermined` counts as usable on purpose. macOS will not tell us whether a
 * grant exists without sending an event, so refusing to try would mean the very
 * first call to Mail always fails — and that first call is exactly the one that
 * produces the permission prompt the user needs to see. Denial is different:
 * that is a decision already made, macOS will not re-ask, and continuing to
 * spawn `osascript` against it is a retry loop against a wall.
 */
export async function checkAppleApp(
  appId: AppleAppId,
  deps: AppleProviderDeps,
): Promise<ProviderCheck> {
  const app = APPLE_APPS[appId];

  if (deps.platform !== 'darwin') {
    return {
      usable: false,
      reason: `${app.displayName} is a macOS application; this machine is ${deps.platform}.`,
    };
  }

  if (!deps.permissions.isInstalled(appId)) {
    return {
      usable: false,
      reason: `${app.displayName} is not installed on this Mac.`,
    };
  }

  if (!deps.runner.isSupportedPlatform) {
    return {
      usable: false,
      reason: 'AppleScript is not available in this process.',
    };
  }

  const permission = deps.permissions.get('automation', appId);
  if (permission.state === 'denied') {
    return {
      usable: false,
      reason: `macOS is blocking us from controlling ${app.displayName}.`,
      permissions: [permission],
      remediation: permission.remediation,
    };
  }

  return {
    usable: true,
    degraded: permission.state === 'undetermined',
    degradedReason:
      permission.state === 'undetermined'
        ? `Permission to control ${app.displayName} has not been granted yet; the first request will ask for it.`
        : undefined,
    permissions: [permission],
  };
}

/** Version verdict for one operation, bound to the live detected version. */
export function supportsOp(
  op: CapabilityOp,
  deps: AppleProviderDeps,
): OpVerdict {
  return checkOpSupport(op, deps.version());
}

/** `true`/`false` as the prelude's `argBool` reads them. */
export function boolArg(value: boolean): string {
  return value ? '1' : '0';
}

/** A possibly-null date string from a script, normalised to `undefined`. */
export function optionalDate(value: string | null | undefined): string | undefined {
  return value ?? undefined;
}
