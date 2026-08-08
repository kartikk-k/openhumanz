/**
 * Keeping `osascript` off the agent's own shell.
 *
 * The agent CLI has gated shell access. If it can also run `osascript` directly,
 * every control in this module is decoration: the argument escaping, the
 * allowlist of target apps, the ban on a send-mail tool, the approval gate on
 * writes — all of it is bypassed by one Bash call.
 *
 * There is a second, less obvious reason, and it is the one that actually
 * decides the design. **macOS attributes an Automation permission prompt to the
 * process that sent the Apple Event.** When our signed, notarised app sends it,
 * the user sees a dialog naming our app, and the grant they give is one they can
 * find and revoke later under our name. When the agent's shell sends it, the
 * prompt names the terminal, or `node`, or whatever the CLI happens to be
 * running as — a grant the user cannot reason about, attached to a process that
 * is not ours, which we cannot see the state of and cannot remediate. Routing
 * every Apple Event through this module is what makes the permission model
 * legible.
 *
 * What this file provides is deny rules for the CLI's own permission system plus
 * a matcher for auditing. Be honest about the limits: a shell is a programming
 * language and a determined caller can reach `osascript` through a path this
 * matcher does not recognise, or through a compiled binary, or through Python's
 * ScriptingBridge. This is defence in depth behind the CLI's allowlist, not the
 * primary control. The primary control is that shell access is granted narrowly
 * in the first place.
 */

/** Binaries that compile or execute AppleScript / JXA. */
export const OSA_BINARIES = [
  'osascript',
  'osacompile',
  'automator',
  'applescript',
] as const;

/**
 * Deny rules in the Claude Code permission vocabulary, to be merged into the
 * `deny` list of the settings we generate per invocation.
 *
 * Both the bare name and the absolute path are listed: a rule matching only
 * `osascript` does not match `/usr/bin/osascript`.
 */
export const OSASCRIPT_DENY_RULES: readonly string[] = [
  'Bash(osascript:*)',
  'Bash(/usr/bin/osascript:*)',
  'Bash(osacompile:*)',
  'Bash(/usr/bin/osacompile:*)',
  'Bash(automator:*)',
  'Bash(/usr/bin/automator:*)',
];

/**
 * Best-effort detection of a shell command that would execute AppleScript.
 *
 * Splits on shell operators so `foo && osascript -e ...` and `x | osascript` are
 * both caught, then compares the basename of each command position. Quoting and
 * variable expansion are not interpreted — a command that hides the binary name
 * behind a variable is not detected, which is the documented limit above.
 */
export function commandReachesOsascript(command: string): boolean {
  if (typeof command !== 'string' || command.trim() === '') return false;

  // Split on anything that can start a new command.
  const segments = command.split(/(?:\|\||&&|[;|&\n()`]|\$\()+/g);
  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index].replace(/^["']|["']$/g, '');
      // Skip leading assignments and common wrappers so `env FOO=1 osascript`
      // and `xargs osascript` are still seen.
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
      const base = token.split('/').pop() ?? token;
      if ((OSA_BINARIES as readonly string[]).includes(base.toLowerCase())) {
        return true;
      }
      // Only the first non-wrapper token is a command position; after that we
      // are looking at arguments, except for the wrappers listed here.
      if (
        !['env', 'sudo', 'nohup', 'xargs', 'time', 'command'].includes(base)
      ) {
        break;
      }
    }
  }
  return false;
}
