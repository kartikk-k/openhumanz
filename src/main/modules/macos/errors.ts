/**
 * AppleScript error numbers, turned into something a person and a model can
 * both act on.
 *
 * The raw material is bad. `osascript` exits 1 and prints one line on stderr —
 * `execution error: Not authorized to send Apple events to Mail. (-1743)` — and
 * that string is localised, changes between releases, and under hardened runtime
 * is sometimes absent entirely with the real reason only in Console.app. Handing
 * it to the model produces a confident, wrong explanation; handing it to the
 * user produces a support ticket.
 *
 * So: the number is the signal. It is parsed out, mapped to a closed set of
 * kinds, and every kind carries what to do next. `-1743` in particular gets
 * first-class treatment — it is the failure users actually hit, it is not
 * fixable by retrying, and the only useful response is a card that opens the
 * right System Settings pane.
 */
import type { AppleAppId } from './apps';
import { APPLE_APPS } from './apps';

/* ------------------------------------------------------------------ */
/* Kinds                                                               */
/* ------------------------------------------------------------------ */

export const MACOS_ERROR_KINDS = [
  /** Automation permission refused for this source/target pair. */
  'permission-denied',
  /** A file the capability needs is behind Full Disk Access. */
  'full-disk-access-required',
  /** The target app is not running and we were not allowed to launch it. */
  'app-not-running',
  /** The app exists but could not be launched. */
  'app-launch-failed',
  /** The app quit or the connection dropped mid-call. */
  'app-connection-lost',
  /** No such mailbox / event / person. A normal outcome, not a fault. */
  'not-found',
  /** The app does not implement this any more, or never did. Version drift. */
  'unsupported',
  /** The app accepted the event and then never answered. */
  'apple-event-timeout',
  /** We killed it because it exceeded our own deadline. */
  'timeout',
  /** The user dismissed something the app put on screen. */
  'user-cancelled',
  /** Our script does not compile. Always our bug. */
  'script-error',
  /** stdout was not the JSON the schema requires. Also our bug. */
  'bad-output',
  /** Not macOS, or `osascript` is missing. */
  'unavailable',
  /** Everything else. Carries the raw stderr so diagnostics still work. */
  'unknown',
] as const;

export type MacosErrorKind = (typeof MACOS_ERROR_KINDS)[number];

/** Permission families macOS keeps separate, and so must we. */
export const PERMISSION_KINDS = [
  'automation',
  'full-disk-access',
  'accessibility',
] as const;
export type PermissionKind = (typeof PERMISSION_KINDS)[number];

/* ------------------------------------------------------------------ */
/* Settings deep links                                                 */
/* ------------------------------------------------------------------ */

/**
 * Deep links into the privacy panes.
 *
 * Two spellings per pane. Ventura rebuilt System Preferences as System Settings
 * and introduced the `com.apple.settings.PrivacySecurity.extension` bundle; the
 * old `com.apple.preference.security` identifier still resolves on Ventura
 * through at least Sequoia, and is the only one that works before Ventura. The
 * caller picks by OS version and falls back to the other.
 */
export interface SettingsPane {
  /** Preferred URL for macOS 13 and later. */
  url: string;
  /** Pre-Ventura spelling; also a working fallback afterwards. */
  legacyUrl: string;
  /** Breadcrumb to read out when the URL does not open, e.g. on a locked-down machine. */
  label: string;
}

export const SETTINGS_PANES: Record<PermissionKind, SettingsPane> = {
  automation: {
    url: 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Automation',
    legacyUrl:
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
    label: 'System Settings > Privacy & Security > Automation',
  },
  'full-disk-access': {
    url: 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles',
    legacyUrl:
      'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
    label: 'System Settings > Privacy & Security > Full Disk Access',
  },
  accessibility: {
    url: 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility',
    legacyUrl:
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    label: 'System Settings > Privacy & Security > Accessibility',
  },
};

/* ------------------------------------------------------------------ */
/* Remediation                                                         */
/* ------------------------------------------------------------------ */

/**
 * Everything the UI needs to render a fix-it card, and nothing it would have to
 * parse. This is the shape that must never degrade into a stack trace.
 */
export interface RemediationCard {
  permission: PermissionKind;
  /** Which target app the grant is for. Automation is per pair. */
  appId?: AppleAppId;
  title: string;
  /** One or two sentences of plain language. No error numbers. */
  body: string;
  /** Numbered steps, written for someone who has never seen the pane. */
  steps: string[];
  settingsUrl: string;
  settingsUrlLegacy: string;
  settingsLabel: string;
  /**
   * True when trying the same call again could now succeed. False for a denial
   * the user has to reverse first — macOS will not re-prompt, so a retry loop
   * would spin forever against a decision that has already been made.
   */
  canRetry: boolean;
  /**
   * True when the fix requires quitting and reopening this app. Automation
   * grants apply immediately; Full Disk Access does not.
   */
  requiresRestart: boolean;
}

export function automationRemediation(appId: AppleAppId): RemediationCard {
  const app = APPLE_APPS[appId];
  const pane = SETTINGS_PANES.automation;
  return {
    permission: 'automation',
    appId,
    title: `Allow this app to control ${app.displayName}`,
    body:
      `macOS is blocking us from talking to ${app.displayName}. This permission is ` +
      'granted once, per app pair, and macOS will not ask again on its own — it has ' +
      'to be switched on by hand.',
    steps: [
      `Open ${pane.label}.`,
      'Find this app in the list on the left.',
      `Switch on ${app.displayName} underneath it.`,
      'Come back and try again.',
    ],
    settingsUrl: pane.url,
    settingsUrlLegacy: pane.legacyUrl,
    settingsLabel: pane.label,
    canRetry: false,
    requiresRestart: false,
  };
}

export function fullDiskAccessRemediation(reason: string): RemediationCard {
  const pane = SETTINGS_PANES['full-disk-access'];
  return {
    permission: 'full-disk-access',
    title: 'Give this app Full Disk Access',
    body: `${reason} Full Disk Access is a separate permission from Automation, and turning one on does not turn on the other.`,
    steps: [
      `Open ${pane.label}.`,
      'Click + and add this app, or switch it on if it is already listed.',
      'Quit this app completely and reopen it — the new permission only applies to a fresh launch.',
    ],
    settingsUrl: pane.url,
    settingsUrlLegacy: pane.legacyUrl,
    settingsLabel: pane.label,
    canRetry: false,
    requiresRestart: true,
  };
}

/* ------------------------------------------------------------------ */
/* The error                                                           */
/* ------------------------------------------------------------------ */

export interface MacosErrorInit {
  kind: MacosErrorKind;
  message: string;
  /** The AppleScript error number, when there was one. */
  number?: number;
  appId?: AppleAppId;
  script?: string;
  /** `osascript` exit code. */
  exitCode?: number | null;
  durationMs?: number;
  /** Kept for diagnostics. Never shown to the model. */
  stderr?: string;
  remediation?: RemediationCard;
  /** True when the same call, unchanged, might work next time. */
  retryable?: boolean;
  cause?: unknown;
}

/**
 * The only error type this module throws outward.
 *
 * {@link toToolResult} is what tools return — a structured failure value rather
 * than an exception, because an MCP tool that throws gives the model a string
 * and nothing to act on, and because "Mail is not running" is an outcome, not a
 * crash.
 */
export class MacosError extends Error {
  readonly kind: MacosErrorKind;

  readonly number?: number;

  readonly appId?: AppleAppId;

  readonly script?: string;

  readonly exitCode?: number | null;

  readonly durationMs?: number;

  /** Diagnostics only. Deliberately not part of `toToolResult`. */
  readonly stderr?: string;

  readonly remediation?: RemediationCard;

  readonly retryable: boolean;

  constructor(init: MacosErrorInit) {
    super(init.message, init.cause ? { cause: init.cause } : undefined);
    this.name = 'MacosError';
    this.kind = init.kind;
    this.number = init.number;
    this.appId = init.appId;
    this.script = init.script;
    this.exitCode = init.exitCode;
    this.durationMs = init.durationMs;
    this.stderr = init.stderr;
    this.remediation = init.remediation;
    this.retryable = init.retryable ?? false;
  }

  /**
   * The compact, model-facing form. No stderr, no stack, no error number in the
   * prose — the number is a separate field so a UI can show it and the model
   * cannot mistake it for something to explain.
   */
  toToolResult(): {
    ok: false;
    error: {
      kind: MacosErrorKind;
      message: string;
      code?: number;
      app?: string;
      retryable: boolean;
      remediation?: RemediationCard;
    };
  } {
    return {
      ok: false,
      error: {
        kind: this.kind,
        message: this.message,
        code: this.number,
        app: this.appId,
        retryable: this.retryable,
        remediation: this.remediation,
      },
    };
  }
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Pull the AppleScript error number out of `osascript` stderr.
 *
 * The format is stable across releases even though the prose is not: the number
 * is the last parenthesised signed integer on the line. Taking the *last* match
 * matters — `Can't get message id 12345 of mailbox "x". (-1728)` contains a
 * number that is not the error code.
 */
export function parseErrorNumber(stderr: string): number | undefined {
  const matches = [...stderr.matchAll(/\((-?\d{1,6})\)/g)];
  if (matches.length === 0) return undefined;
  const value = Number(matches[matches.length - 1][1]);
  return Number.isFinite(value) ? value : undefined;
}

/** Strip `osascript`'s prefixes so the message reads as a sentence. */
export function cleanStderr(stderr: string): string {
  return stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^(execution|syntax) error:\s*/i, ''))
    .map((line) => line.replace(/^osascript:\s*/i, ''))
    .join(' ')
    .trim();
}

interface Mapping {
  kind: MacosErrorKind;
  message: string;
  retryable?: boolean;
}

/**
 * AppleScript / Apple Event error numbers we have an opinion about.
 *
 * Sources are Apple's `MacErrors.h` (`errAE*`, `procNotFound`) and the OSA
 * scripting component ranges. Anything not listed falls through to `unknown`
 * with the raw number preserved, which is strictly better than guessing.
 */
const ERROR_TABLE: Record<number, Mapping> = {
  [-128]: { kind: 'user-cancelled', message: 'The action was cancelled.' },
  [-600]: {
    kind: 'app-not-running',
    message: 'The application is not running.',
  },
  [-609]: {
    kind: 'app-connection-lost',
    message: 'The connection to the application was lost.',
    retryable: true,
  },
  [-610]: {
    kind: 'app-not-running',
    message: 'The application is not accepting events yet.',
    retryable: true,
  },
  [-905]: {
    kind: 'permission-denied',
    message: 'Remote Apple Events are not allowed.',
  },
  [-1700]: {
    kind: 'script-error',
    message: 'The application returned a value of an unexpected type.',
  },
  [-1701]: {
    kind: 'unsupported',
    message:
      'The application did not supply an expected value. This usually means its scripting support changed in this macOS version.',
  },
  [-1708]: {
    kind: 'unsupported',
    message: 'The application does not support this operation.',
  },
  [-1712]: {
    kind: 'apple-event-timeout',
    message: 'The application did not respond in time.',
    retryable: true,
  },
  [-1719]: {
    kind: 'not-found',
    message: 'No item at that position.',
  },
  [-1728]: {
    kind: 'not-found',
    message: 'The requested item does not exist.',
  },
  [-1743]: {
    kind: 'permission-denied',
    message: 'macOS has not granted permission to control this application.',
  },
  [-1751]: {
    kind: 'script-error',
    message: 'The script tried to use an invalid reference.',
  },
  [-2700]: {
    kind: 'script-error',
    message: 'The script failed.',
  },
  [-2703]: {
    kind: 'script-error',
    message: 'The script referred to something that does not exist.',
  },
  [-2740]: { kind: 'script-error', message: 'The script could not be parsed.' },
  [-2741]: { kind: 'script-error', message: 'The script could not be parsed.' },
  [-10004]: {
    kind: 'permission-denied',
    message: 'A privilege violation occurred.',
  },
  [-10660]: {
    kind: 'full-disk-access-required',
    message: 'The application could not read a file it needs.',
  },
  [-10810]: {
    kind: 'app-launch-failed',
    message: 'The application could not be launched.',
  },
  [-10814]: {
    kind: 'not-found',
    message: 'The application could not be found.',
  },
  [-10825]: {
    kind: 'app-launch-failed',
    message: 'The application is not available on this system.',
  },
};

export interface MapErrorInput {
  errorNumber?: number;
  stderr?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  appId?: AppleAppId;
  script?: string;
  durationMs?: number;
}

/**
 * Turn one failed `osascript` invocation into a typed error.
 *
 * Precedence is deliberate: our own timeout wins over anything the process
 * managed to say, because we killed it and whatever it printed is a fragment.
 * Then the error number. Then, only as a last resort, text matching — some
 * hardened-runtime failures print a recognisable sentence with no number at all,
 * and `-1743` with no number is still `-1743`.
 */
export function mapAppleScriptError(input: MapErrorInput): MacosError {
  const stderr = input.stderr ?? '';
  const cleaned = cleanStderr(stderr);
  const errorNumber = input.errorNumber ?? parseErrorNumber(stderr);

  if (input.timedOut) {
    return new MacosError({
      kind: 'timeout',
      message:
        'The application did not answer before the deadline and was stopped.',
      appId: input.appId,
      script: input.script,
      exitCode: input.exitCode,
      durationMs: input.durationMs,
      stderr,
      retryable: true,
    });
  }

  const mapped = errorNumber !== undefined ? ERROR_TABLE[errorNumber] : undefined;
  if (mapped) {
    return finish(mapped, errorNumber);
  }

  // No usable number. Under hardened runtime a blocked event can come back with
  // an empty stderr and exit 1, so these text probes are the only signal left.
  if (/not authori[sz]ed|not permitted|doesn.t have permission/i.test(cleaned)) {
    return finish(ERROR_TABLE[-1743], -1743);
  }
  if (/operation not permitted/i.test(cleaned)) {
    return finish(ERROR_TABLE[-10660], -10660);
  }
  if (/(isn.t|is not) running/i.test(cleaned)) {
    return finish(ERROR_TABLE[-600], -600);
  }

  return new MacosError({
    kind: 'unknown',
    message:
      cleaned ||
      'The application failed without reporting a reason. The details are in Console.app.',
    number: errorNumber,
    appId: input.appId,
    script: input.script,
    exitCode: input.exitCode,
    durationMs: input.durationMs,
    stderr,
    retryable: false,
  });

  function finish(mapping: Mapping, code: number | undefined): MacosError {
    const app = input.appId ? APPLE_APPS[input.appId] : undefined;
    const withApp = app
      ? mapping.message.replace(
          /\bthe application\b/i,
          (match) => (match[0] === 'T' ? app.displayName : app.displayName),
        )
      : mapping.message;

    let remediation: RemediationCard | undefined;
    if (mapping.kind === 'permission-denied' && input.appId) {
      remediation = automationRemediation(input.appId);
    } else if (mapping.kind === 'full-disk-access-required') {
      remediation = fullDiskAccessRemediation(withApp);
    }

    return new MacosError({
      kind: mapping.kind,
      message: withApp,
      number: code,
      appId: input.appId,
      script: input.script,
      exitCode: input.exitCode,
      durationMs: input.durationMs,
      stderr,
      remediation,
      retryable: mapping.retryable ?? false,
    });
  }
}

/** Wrap anything at all as a `MacosError` without losing what it was. */
export function asMacosError(cause: unknown): MacosError {
  if (cause instanceof MacosError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  return new MacosError({ kind: 'unknown', message, cause });
}
