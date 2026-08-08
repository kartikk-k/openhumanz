/**
 * The module's MCP surface: exactly one read-only tool.
 *
 * **Nothing here mutates settings, and nothing here ever should.** The approval
 * gate reads `settings.approvals`; a `settings_set` tool would let a model turn
 * off the gate that governs it, or raise the cost ceiling that bounds it, in a
 * single unremarkable-looking call. That is not a policy we enforce with a
 * warning in a description — the capability simply does not exist. Settings are
 * changed by a human in the settings window.
 *
 * The one tool that does exist answers a question the agent otherwise guesses
 * at: "is there a Mail integration on this machine, or should I stop offering?"
 * It is `sideEffecting: false` and returns no secrets — engine paths, names and
 * availability, never a key or a value from the environment.
 */
import { z } from 'zod';
import { defineTool } from '../types';
import type { AnyToolDefinition } from '../types';
import type { EnvironmentStatus } from '../../../shared/engines';

export interface EnvironmentToolDeps {
  status(options?: { force?: boolean }): Promise<EnvironmentStatus>;
}

const EnvironmentInputSchema = z.object({
  /** Re-probe instead of using the cached answer. Costs a process spawn. */
  refresh: z.boolean().default(false),
});

/** Compact by design: this lands in a context window, not on a dashboard. */
function summarize(status: EnvironmentStatus): unknown {
  return {
    platform: status.platform,
    engines: status.engines.map((engine) => ({
      id: engine.id,
      name: engine.name,
      available: engine.available,
      version: engine.version,
      reason: engine.reason,
      auth: engine.auth
        ? { state: engine.auth.state, severity: engine.auth.severity }
        : undefined,
    })),
    capabilities: status.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      available: provider.available,
      reason: provider.reason,
    })),
    warnings: status.warnings,
    checkedAt: status.checkedAt,
  };
}

export function createEnvironmentTools(
  deps: EnvironmentToolDeps,
): AnyToolDefinition[] {
  return [
    defineTool({
      name: 'environment_status',
      description:
        'Report what this machine can do: which agent CLIs are installed and ' +
        'authenticated, and which host capabilities (mail, calendar, notes, ' +
        'reminders) are available. Call this before offering to use a ' +
        'capability, so you do not promise something the machine cannot do. ' +
        'Read-only; it changes no configuration.',
      inputSchema: EnvironmentInputSchema,
      sideEffecting: false,
      annotations: {
        title: 'Check environment',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      async handler(input) {
        return summarize(await deps.status({ force: input.refresh }));
      },
    }),
  ];
}
