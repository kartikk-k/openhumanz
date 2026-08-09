/**
 * Environment hygiene for the child processes this module spawns (the local
 * server and the `claude` CLI behind the shim).
 *
 * A module may not import the engine services, so the small slice we need is
 * kept here: strip the app's dev loader (`NODE_OPTIONS=-r ts-node/register` and
 * the `TS_NODE_*` vars) so a spawned binary doesn't inherit a loader it can't
 * satisfy, and drop stray provider API keys so nothing picks up an ambient
 * credential. Mirrors what `services/engines/environment.ts` does for the CLI.
 */

/** Vars that carry the dev loader into a child and must be cleared. */
const DEV_LOADER_VARS = [
  'NODE_OPTIONS',
  'TS_NODE_PROJECT',
  'TS_NODE_TRANSPILE_ONLY',
  'TS_NODE_COMPILER_OPTIONS',
] as const;

/** Provider keys we never want a spawned child to inherit ambiently. */
const API_KEY_VARS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
] as const;

/** The CLI binary the shim drives. Resolved on PATH by the caller. */
export const CLAUDE_BINARY = 'claude';

/**
 * Env overrides for a spawned child: clear the dev loader (always) and, unless
 * `allowApiKeyEnv`, the ambient provider keys. Merge over the caller's `extra`.
 */
export function childEnvOverrides(
  options: {
    allowApiKeyEnv?: boolean;
    extra?: Record<string, string | undefined>;
  } = {},
): Record<string, string | undefined> {
  const overrides: Record<string, string | undefined> = {};
  for (const name of DEV_LOADER_VARS) overrides[name] = undefined;
  if (!options.allowApiKeyEnv) {
    for (const name of API_KEY_VARS) overrides[name] = undefined;
  }
  overrides.FORCE_COLOR = '0';
  overrides.NO_COLOR = '1';
  return { ...overrides, ...(options.extra ?? {}) };
}
