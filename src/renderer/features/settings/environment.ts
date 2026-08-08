/**
 * Reading the environment report — defensively, and in the product's own words.
 *
 * Two jobs live here, both shared by the settings screen and by onboarding:
 *
 *  1. **Reading auth off an engine.** `EngineInfo` in `shared/engines.ts` does
 *     not declare an `auth` field yet (a sibling change is adding it), and a
 *     future `EnvironmentStatus.auth` sidecar map is equally plausible. So
 *     nothing here indexes a declared property: {@link readEngineAuth} narrows
 *     from `unknown`, checks the engine record first and the sidecar second,
 *     and reports which one it used. This compiles before and after that
 *     change, and it degrades to `null` rather than to a wrong answer.
 *
 *  2. **Saying what the state means.** Every string a user reads about engines,
 *     auth and the stray-API-key case is written here, once, so the two screens
 *     cannot drift into telling different stories about the same machine.
 *
 * The distinction the whole file is built around: *"we could not ask"* is not
 * *"the answer is no"*. A backend that has not registered its handlers yet must
 * never render as "no engine installed".
 */
import type { EngineInfo, EnvironmentStatus } from '../../../shared/engines';
import type { LoadStatus } from '../../store';
import type { Tone } from '../../lib/tone';

/* ------------------------------------------------------------------ */
/* Auth, read defensively                                              */
/* ------------------------------------------------------------------ */

export const ENGINE_AUTH_STATES = [
  'subscription',
  'api-key',
  'logged-out',
  'unknown',
] as const;
export type EngineAuthState = (typeof ENGINE_AUTH_STATES)[number];

export const ENGINE_AUTH_SEVERITIES = ['ok', 'warning', 'error'] as const;
export type EngineAuthSeverity = (typeof ENGINE_AUTH_SEVERITIES)[number];

/**
 * The normalised auth record the UI renders. Structurally the shape the engine
 * adapter builds, but every field is proven at runtime rather than trusted.
 */
export interface EngineAuthView {
  state: EngineAuthState;
  severity: EngineAuthSeverity;
  /** One sentence, safe to show verbatim. Always populated. */
  message: string;
  apiKeyEnvDetected: boolean;
  apiKeyEnvVars: string[];
  /** True when the adapter removes the key before spawning the CLI. */
  apiKeyEnvStripped: boolean;
  method?: string;
  email?: string;
  organization?: string;
  subscription?: string;
  /** Set when the auth probe itself failed — "we could not ask". */
  probeError?: string;
  /** Which of the two possible carriers this came from. */
  source: 'engine' | 'sidecar';
}

const FALLBACK_AUTH_MESSAGE: Record<EngineAuthState, string> = {
  subscription: 'Signed in. Runs use your subscription.',
  'api-key': 'Authenticated with an API key. Runs are billed pay-as-you-go.',
  'logged-out':
    'Not signed in. Run `claude auth login` in a terminal, then re-check.',
  unknown: 'The sign-in state could not be determined.',
};

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function readAuthRecord(
  raw: unknown,
  source: EngineAuthView['source'],
): EngineAuthView | null {
  if (raw === null || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;

  const rawState = record.state;
  const state = ENGINE_AUTH_STATES.includes(rawState as EngineAuthState)
    ? (rawState as EngineAuthState)
    : 'unknown';

  const rawSeverity = record.severity;
  const severity = ENGINE_AUTH_SEVERITIES.includes(
    rawSeverity as EngineAuthSeverity,
  )
    ? (rawSeverity as EngineAuthSeverity)
    : 'warning';

  return {
    state,
    severity,
    message: readString(record.message) ?? FALLBACK_AUTH_MESSAGE[state],
    apiKeyEnvDetected: record.apiKeyEnvDetected === true,
    apiKeyEnvVars: readStringArray(record.apiKeyEnvVars),
    apiKeyEnvStripped: record.apiKeyEnvStripped === true,
    method: readString(record.method),
    email: readString(record.email),
    organization: readString(record.organization),
    subscription: readString(record.subscription),
    probeError: readString(record.probeError),
    source,
  };
}

/**
 * The optional `auth` map hanging off the environment report, keyed by engine
 * id. Undefined whenever the backend does not publish one.
 */
export function authSidecarOf(
  environment: EnvironmentStatus | null | undefined,
): Record<string, unknown> | undefined {
  const carrier = environment as { auth?: unknown } | null | undefined;
  const value = carrier?.auth;
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * `engine.auth`, falling back to `sidecar[engine.id]`. Null when neither
 * carries anything readable — which means "not reported", never "logged out".
 */
export function readEngineAuth(
  engine: EngineInfo,
  sidecar?: Record<string, unknown>,
): EngineAuthView | null {
  const own = (engine as { auth?: unknown }).auth;
  return (
    readAuthRecord(own, 'engine') ??
    readAuthRecord(sidecar?.[engine.id], 'sidecar')
  );
}

/* ------------------------------------------------------------------ */
/* The stray key                                                       */
/* ------------------------------------------------------------------ */

export interface ApiKeyFinding {
  detected: boolean;
  /** Variable names, e.g. `['ANTHROPIC_API_KEY']`. Never empty when detected. */
  vars: string[];
  /**
   * Whether the app removes the key before spawning the CLI.
   * `unknown` when no engine reported auth — do not claim either way.
   */
  stripped: 'yes' | 'no' | 'unknown';
}

export const NO_API_KEY_FINDING: ApiKeyFinding = {
  detected: false,
  vars: [],
  stripped: 'unknown',
};

/**
 * Combine the environment-level flag with whatever each engine's auth record
 * says. The flag alone is enough to warn; the engine records add the variable
 * names and whether we strip them.
 */
export function apiKeyFinding(
  environment: EnvironmentStatus | null | undefined,
): ApiKeyFinding {
  if (!environment) return NO_API_KEY_FINDING;

  const sidecar = authSidecarOf(environment);
  const auths = environment.engines
    .map((engine) => readEngineAuth(engine, sidecar))
    .filter((auth): auth is EngineAuthView => auth !== null);

  const flagged = auths.filter((auth) => auth.apiKeyEnvDetected);
  const detected = environment.apiKeyEnvDetected || flagged.length > 0;
  if (!detected) return NO_API_KEY_FINDING;

  const vars = Array.from(
    new Set(flagged.flatMap((auth) => auth.apiKeyEnvVars)),
  );

  let stripped: ApiKeyFinding['stripped'] = 'unknown';
  if (flagged.length > 0) {
    stripped = flagged.every((auth) => auth.apiKeyEnvStripped) ? 'yes' : 'no';
  }

  return {
    detected: true,
    vars: vars.length > 0 ? vars : ['ANTHROPIC_API_KEY'],
    stripped,
  };
}

export interface ApiKeyCopy {
  eyebrow: string;
  title: string;
  /** Why it matters. Two sentences at most. */
  body: string;
  /** What the app is doing about it right now, if anything. */
  status: string;
  /** What the user should do. */
  action: string;
  command: string;
  tone: Tone;
}

/**
 * The stray-key copy. This is the one warning in the product that costs real
 * money to ignore, so it names the variable, states the precedence rule that
 * makes it invisible, and gives the exact command.
 */
export function apiKeyCopy(finding: ApiKeyFinding): ApiKeyCopy {
  const names = finding.vars.join(' and ');
  const isPlural = finding.vars.length > 1;

  const status = {
    yes: 'This app removes it from every agent run it starts, so runs from here use your subscription. Anything you run yourself in a terminal still bills the API.',
    no: 'Runs started from this app will use it. Your subscription is sitting there unused while the meter runs.',
    unknown:
      'We could not confirm whether runs started from here strip it, so assume they do not.',
  }[finding.stripped];

  return {
    eyebrow: 'Billing',
    title: `${names} ${isPlural ? 'are' : 'is'} set — runs may bill your API account instead of your subscription`,
    body: `The Claude Code CLI reads ${names} before it reads your subscription login, so the key silently wins. \`claude auth status\` can say you are signed in and every run can still be charged pay-as-you-go against your API credit — which is exactly what makes this easy to miss.`,
    status,
    action: `Unset it in the shell profile that launches this app (remove the \`export ${finding.vars[0] ?? 'ANTHROPIC_API_KEY'}=…\` line from \`~/.zshrc\` or \`~/.bashrc\`), quit the app completely, and open it again. Then re-check below.`,
    command: finding.vars
      .map((name) => `unset ${name}`)
      .join('\n')
      .concat('\n# then quit and relaunch the app'),
    tone: finding.stripped === 'yes' ? 'warning' : 'danger',
  };
}

/* ------------------------------------------------------------------ */
/* Engines                                                             */
/* ------------------------------------------------------------------ */

export interface EngineView {
  engine: EngineInfo;
  auth: EngineAuthView | null;
  tone: Tone;
  /** Short status word for a badge. */
  label: string;
  /** One line under the name explaining the label. */
  detail: string;
  /** True when this engine could actually execute a run right now. */
  runnable: boolean;
}

export function describeEngine(
  engine: EngineInfo,
  auth: EngineAuthView | null,
): EngineView {
  if (!engine.available) {
    return {
      engine,
      auth,
      tone: 'neutral',
      label: 'Not installed',
      detail:
        engine.reason ??
        'The binary was not found on PATH and no explicit path is set.',
      runnable: false,
    };
  }

  if (!auth) {
    return {
      engine,
      auth,
      tone: 'info',
      label: 'Installed',
      detail:
        'Found and runnable. This build did not report a sign-in state for it.',
      runnable: true,
    };
  }

  if (auth.state === 'logged-out') {
    return {
      engine,
      auth,
      tone: 'danger',
      label: 'Not signed in',
      detail: auth.message,
      runnable: false,
    };
  }

  if (auth.state === 'api-key') {
    return {
      engine,
      auth,
      tone: 'warning',
      label: 'API-key billing',
      detail: auth.message,
      runnable: true,
    };
  }

  if (auth.state === 'unknown') {
    return {
      engine,
      auth,
      tone: 'warning',
      label: 'Sign-in unclear',
      detail: auth.message,
      runnable: true,
    };
  }

  return {
    engine,
    auth,
    tone: 'success',
    label: 'Signed in',
    detail: auth.message,
    runnable: true,
  };
}

/**
 * Which engine we would actually spawn, and — the part users ask about — why
 * that one and not the one they picked.
 */
export function activeEngineReason(
  engines: readonly EngineInfo[],
  preferredId: string,
  active: EngineInfo | null,
): string {
  if (engines.length === 0) {
    return 'No engines have been reported, so nothing can be selected yet.';
  }
  if (!active) {
    return `No usable engine was found, so runs cannot start. \`${preferredId}\` is the preference and it is not available.`;
  }
  const preferredEntry = engines.find((engine) => engine.id === preferredId);
  if (!preferredEntry) {
    return `\`${preferredId}\` is set as the preferred engine but no adapter with that id was reported, so \`${active.id}\` is used instead.`;
  }
  if (preferredEntry.id !== active.id) {
    return `\`${preferredId}\` is preferred but unavailable (${preferredEntry.reason ?? 'not found'}), so \`${active.id}\` is used instead.`;
  }
  if (!active.available) {
    return `\`${active.id}\` is the preferred engine, but it is not available: ${active.reason ?? 'not found'}. Runs cannot start.`;
  }
  return `\`${active.id}\` is the preferred engine and it was found${
    active.binaryPath ? ` at ${active.binaryPath}` : ' on PATH'
  }.`;
}

/* ------------------------------------------------------------------ */
/* "We could not ask" vs "the answer is no"                            */
/* ------------------------------------------------------------------ */

export type UnavailableKind = 'no-bridge' | 'no-handler' | 'failed';

export interface UnavailableNotice {
  kind: UnavailableKind;
  tone: Tone;
  title: string;
  body: string;
  /** Verbatim error from the bridge, if there was one worth showing. */
  detail?: string;
  /** True when retrying could plausibly help. */
  retryable: boolean;
}

export interface LoadableLike {
  status: LoadStatus;
  error: string | null;
  unavailable: boolean;
}

/**
 * Turn a slice's `{status, error, unavailable}` into something a human can act
 * on, distinguishing the three ways a read can come back empty.
 *
 * `bridgeAvailable` is what separates "not running inside Electron" from "the
 * main-process module that owns this channel has not registered yet" — the
 * store flattens both into `unavailable: true`, and they need different words.
 *
 * Returns null when there is nothing wrong.
 */
export function describeUnavailable(
  slice: LoadableLike,
  bridgeAvailable: boolean,
  subject: string,
): UnavailableNotice | null {
  if (slice.status !== 'error') return null;

  if (!bridgeAvailable) {
    return {
      kind: 'no-bridge',
      tone: 'neutral',
      title: `${subject} is running without its desktop bridge`,
      body: 'This window is not attached to the Electron main process, so nothing can be read or saved. Everything below is the built-in default, shown so the screen still makes sense.',
      detail: slice.error ?? undefined,
      retryable: false,
    };
  }

  if (slice.unavailable) {
    return {
      kind: 'no-handler',
      tone: 'info',
      title: `${subject} is not connected yet`,
      body: 'The app is running, but the part of it that owns this data has not started. This is a wiring gap, not a problem with your machine or your setup — values below are defaults and changes cannot be saved.',
      detail: slice.error ?? undefined,
      retryable: true,
    };
  }

  return {
    kind: 'failed',
    tone: 'danger',
    title: `${subject} could not be read`,
    body: 'The request reached the app and came back with an error. The last known values are shown below.',
    detail: slice.error ?? undefined,
    retryable: true,
  };
}
