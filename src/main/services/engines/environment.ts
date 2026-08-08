/**
 * Environment hygiene for spawned agent CLIs.
 *
 * The headline case: **a stray `ANTHROPIC_API_KEY` takes precedence over a
 * subscription login.** A user who once exported one for a script, and has
 * since signed in to their plan, will spend pay-as-you-go credit on every run
 * while believing they are covered — and nothing in the CLI's normal output
 * says so. That is why this is a first-class status with its own severity in
 * {@link EngineAuthStatus}, not a line in a log file.
 *
 * The adapter's default is to *remove* those variables from the child's
 * environment rather than merely report them, because reporting alone still
 * bills the user on the very first run.
 */
import type { EngineAuthStatus } from './types';

/**
 * Variables that route the CLI away from a subscription login.
 *
 * `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are credentials.
 * `ANTHROPIC_BASE_URL` and the Bedrock/Vertex switches redirect the request to
 * a different, separately-billed backend, which has the same effect on the
 * user's wallet even though it is not a key.
 */
export const API_KEY_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
] as const;

export const ALTERNATE_BACKEND_ENV_VARS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
] as const;

/**
 * Variables an already-running agent CLI exports into its children.
 *
 * If the app is ever launched from inside a Claude Code session — which is
 * exactly how it gets developed and tested — these leak into every spawn and
 * make the child think it is a nested tool invocation. Stripped unconditionally;
 * our spawns are top-level.
 */
export const INHERITED_SESSION_ENV_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  // In dev the app is launched with `NODE_OPTIONS="-r ts-node/register …"`.
  // The Electron main process inherits it, and without stripping it here it
  // would leak into the CLI *and* into the MCP shim the CLI spawns — a plain
  // node process that would then try to load ts-node, crash, and take the
  // whole `assistant` MCP server down ("status: failed", zero tools). Strip
  // the dev loader so every spawned helper starts as a clean node.
  'NODE_OPTIONS',
  'TS_NODE_PROJECT',
  'TS_NODE_TRANSPILE_ONLY',
  'TS_NODE_COMPILER_OPTIONS',
] as const;

export interface ApiKeyEnvFinding {
  detected: boolean;
  /** Variable names only. A value is a credential and is never read out. */
  vars: string[];
  /** Redirects to a separately-billed backend. Reported, never stripped. */
  backendVars: string[];
}

/** Which of the billing-relevant variables are set. Values are never touched. */
export function findApiKeyEnv(
  env: NodeJS.ProcessEnv = process.env,
): ApiKeyEnvFinding {
  const isSet = (name: string): boolean => {
    const value = env[name];
    return typeof value === 'string' && value.trim() !== '';
  };
  const vars = API_KEY_ENV_VARS.filter(isSet);
  const backendVars = ALTERNATE_BACKEND_ENV_VARS.filter(isSet);
  return { detected: vars.length > 0, vars: [...vars], backendVars };
}

/**
 * Env overrides for a spawn, in `spawnProcess`'s shape where `undefined`
 * removes a key.
 *
 * `allowApiKeyEnv` has to be an explicit opt-in: defaulting it to true would
 * make the safe behaviour the one you have to remember.
 */
export function engineEnvOverrides(options: {
  allowApiKeyEnv?: boolean;
  extra?: Record<string, string | undefined>;
  env?: NodeJS.ProcessEnv;
}): Record<string, string | undefined> {
  const overrides: Record<string, string | undefined> = {};

  for (const name of INHERITED_SESSION_ENV_VARS) overrides[name] = undefined;

  if (!options.allowApiKeyEnv) {
    for (const name of API_KEY_ENV_VARS) overrides[name] = undefined;
  }

  // Colour codes in a JSON stream help nobody.
  overrides.FORCE_COLOR = '0';
  overrides.NO_COLOR = '1';

  return { ...overrides, ...(options.extra ?? {}) };
}

/* ------------------------------------------------------------------ */
/* Auth status                                                         */
/* ------------------------------------------------------------------ */

/** Parsed shape of `claude auth status --json`. Every field optional. */
export interface RawAuthStatus {
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
  email?: string;
  orgName?: string;
  orgId?: string;
  subscriptionType?: string;
}

/**
 * Turn a CLI auth probe plus the environment scan into one renderable status.
 *
 * Precedence is deliberate: a key in the environment outranks a healthy
 * subscription login in the message, because that is the order the CLI itself
 * resolves credentials in, and the login being fine is exactly what makes the
 * problem invisible.
 */
export function buildAuthStatus(input: {
  raw?: RawAuthStatus;
  probeError?: string;
  apiKeyEnv: ApiKeyEnvFinding;
  /** True when the adapter will remove the keys before spawning. */
  stripping: boolean;
}): EngineAuthStatus {
  const { raw, probeError, apiKeyEnv, stripping } = input;

  const base = {
    apiKeyEnvDetected: apiKeyEnv.detected,
    apiKeyEnvVars: apiKeyEnv.vars,
    apiKeyEnvStripped: stripping && apiKeyEnv.detected,
    method: raw?.authMethod,
    email: raw?.email,
    organization: raw?.orgName,
    subscription: raw?.subscriptionType,
    probeError,
  };

  if (apiKeyEnv.detected) {
    const names = apiKeyEnv.vars.join(' and ');
    return {
      ...base,
      state: 'api-key',
      severity: stripping ? 'warning' : 'error',
      message: stripping
        ? `${names} is set in your environment. An API key overrides your Claude subscription and bills pay-as-you-go, so the app removes it from each agent run. Unset it in your shell profile to silence this.`
        : `${names} is set in your environment and API-key mode is enabled. Runs will be billed pay-as-you-go rather than against your subscription.`,
    };
  }

  if (apiKeyEnv.backendVars.length > 0) {
    return {
      ...base,
      state: 'unknown',
      severity: 'warning',
      message: `${apiKeyEnv.backendVars.join(' and ')} redirects the CLI to a different, separately-billed backend. Unset it to run against your subscription.`,
    };
  }

  if (probeError) {
    return {
      ...base,
      state: 'unknown',
      severity: 'warning',
      message: `Could not read the CLI's auth status (${probeError}). Run \`claude auth status\` in a terminal to check it.`,
    };
  }

  if (raw?.loggedIn === false) {
    return {
      ...base,
      state: 'logged-out',
      severity: 'error',
      message:
        'Not signed in. Run `claude auth login` in a terminal, then re-check.',
    };
  }

  if (raw?.loggedIn === true) {
    const viaKey =
      (raw.authMethod ?? '').toLowerCase().includes('key') ||
      (raw.apiProvider ?? '').toLowerCase().includes('key');
    if (viaKey) {
      return {
        ...base,
        state: 'api-key',
        severity: 'warning',
        message:
          'The CLI is authenticated with an API key rather than a subscription login. Runs are billed pay-as-you-go.',
      };
    }
    const who = raw.email ? ` as ${raw.email}` : '';
    const plan = raw.subscriptionType ? ` (${raw.subscriptionType} plan)` : '';
    return {
      ...base,
      state: 'subscription',
      severity: 'ok',
      message: `Signed in${who}${plan}. Runs use your subscription.`,
    };
  }

  return {
    ...base,
    state: 'unknown',
    severity: 'warning',
    message:
      'Could not determine how the CLI is authenticated. Run `claude auth status` in a terminal to check it.',
  };
}

/**
 * Warnings for `EnvironmentStatus.warnings`. The stray-key case leads, because
 * it is the one that costs money.
 */
export function environmentWarnings(statuses: EngineAuthStatus[]): string[] {
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const status of statuses) {
    if (status.severity === 'ok') continue;
    if (seen.has(status.message)) continue;
    seen.add(status.message);
    warnings.push(status.message);
  }
  return warnings;
}
