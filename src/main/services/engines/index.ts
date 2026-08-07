/**
 * The engine registry — one place that knows which adapters exist.
 *
 * Adding an engine is: write the adapter, add it to {@link createEngineRegistry}.
 * Nothing else in the app names an engine, because everything downstream takes
 * an {@link EngineAdapter} or an engine id string.
 *
 * `detectAll()` is also where the environment status the onboarding screen
 * renders comes from — including the stray-`ANTHROPIC_API_KEY` case, which is
 * promoted to the front of the warning list because it is the one that silently
 * costs money.
 */
import { getLogger } from '../../infra/logger';
import type { Logger } from '../../infra/logger';
import { nowIso } from '../../../shared/common';
import type { EngineInfo, EnvironmentStatus } from '../../../shared/engines';
import { ClaudeCodeAdapter, CLAUDE_CODE_ENGINE_ID } from './claude-code';
import { CodexAdapter, CODEX_ENGINE_ID } from './codex';
import { environmentWarnings, findApiKeyEnv } from './environment';
import type {
  DetectOptions,
  EngineAdapter,
  EngineAuthStatus,
  EngineDetection,
} from './types';

export * from './types';
export {
  AsyncEventQueue,
  batchEvents,
  isDroppableEvent,
  resolveBatchOptions,
} from './stream';
export {
  classifyErrorText,
  classifyResultSubtype,
  createParserState,
  flattenContent,
  parseModelUsage,
  parseStreamJsonLine,
  parseUsage,
} from './stream-json';
export type { StreamParserState } from './stream-json';
export { CostMeter, accumulateCost } from './cost';
export type { CostMeterLimits, CostSnapshot, ModelCostTotals } from './cost';
export {
  ALTERNATE_BACKEND_ENV_VARS,
  API_KEY_ENV_VARS,
  INHERITED_SESSION_ENV_VARS,
  buildAuthStatus,
  engineEnvOverrides,
  environmentWarnings,
  findApiKeyEnv,
} from './environment';
export type { ApiKeyEnvFinding, RawAuthStatus } from './environment';
export {
  CLAUDE_CODE_BINARY,
  CLAUDE_CODE_ENGINE_ID,
  ClaudeCodeAdapter,
  buildClaudeArgs,
  createClaudeCodeAdapter,
  parseVersion,
  unsupportedFlagFromOutput,
} from './claude-code';
export type { ClaudeCodeAdapterOptions } from './claude-code';
export {
  CODEX_BINARY,
  CODEX_ENGINE_ID,
  CodexAdapter,
  createCodexAdapter,
} from './codex';
export { runFinishedEvent, toRunEvents } from './run-events';
export type {
  MappedRunEvents,
  RunEventContext,
  ToolCallIndex,
} from './run-events';

/** The engine used when a caller does not name one. */
export const DEFAULT_ENGINE_ID = CLAUDE_CODE_ENGINE_ID;

/** Everything `detectAll` learned, ready for the UI. */
export interface EngineEnvironmentReport {
  detections: EngineDetection[];
  /** The `shared/engines.ts` shape, minus `providers`, which is another module. */
  status: Omit<EnvironmentStatus, 'providers'>;
  /** Auth per engine id, since `EngineInfo` has nowhere to carry it. */
  auth: Record<string, EngineAuthStatus>;
}

export interface EngineRegistry {
  readonly adapters: readonly EngineAdapter[];
  /** The adapter for `id`, or undefined. Never throws on an unknown id. */
  get(id: string): EngineAdapter | undefined;
  /** {@link get} but throws with the list of known ids. For orchestrator use. */
  require(id?: string): EngineAdapter;
  detect(id: string, options?: DetectOptions): Promise<EngineDetection>;
  detectAll(options?: DetectOptions): Promise<EngineEnvironmentReport>;
}

export interface EngineRegistryOptions {
  logger?: Logger;
  /**
   * Override a binary path per engine id. This is the seam the fake-CLI tests
   * use, and it doubles as the settings-screen "use this binary" escape hatch.
   */
  binaryPaths?: Record<string, string>;
  /** Replace the built-in adapter list entirely. Tests only. */
  adapters?: EngineAdapter[];
}

export function createEngineRegistry(
  options: EngineRegistryOptions = {},
): EngineRegistry {
  const logger = options.logger ?? getLogger('engines');
  const adapters: EngineAdapter[] = options.adapters ?? [
    new ClaudeCodeAdapter({
      binaryPath: options.binaryPaths?.[CLAUDE_CODE_ENGINE_ID],
      logger: logger.child(CLAUDE_CODE_ENGINE_ID),
    }),
    new CodexAdapter({
      binaryPath: options.binaryPaths?.[CODEX_ENGINE_ID],
      logger: logger.child(CODEX_ENGINE_ID),
    }),
  ];

  const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));

  const get = (id: string): EngineAdapter | undefined => byId.get(id);

  return {
    adapters,
    get,

    require(id = DEFAULT_ENGINE_ID) {
      const adapter = get(id);
      if (!adapter) {
        throw new Error(
          `Unknown engine "${id}". Known engines: ${[...byId.keys()].join(', ')}.`,
        );
      }
      return adapter;
    },

    async detect(id, detectOptions) {
      const adapter = get(id);
      if (!adapter) throw new Error(`Unknown engine "${id}".`);
      return adapter.detect(detectOptions);
    },

    async detectAll(detectOptions) {
      const detections = await Promise.all(
        adapters.map(async (adapter) => {
          try {
            return await adapter.detect(detectOptions);
          } catch (error) {
            // Detection reports unavailable; it never throws at the caller.
            logger.error('engine detection failed', {
              engine: adapter.id,
              error: (error as Error).message,
            });
            const failed: EngineDetection = {
              info: {
                id: adapter.id,
                name: adapter.name,
                available: false,
                reason: `Detection failed: ${(error as Error).message}`,
                supportsResume: false,
                supportsStreamingJson: false,
                detectedAt: nowIso(),
              },
              auth: {
                state: 'unknown',
                severity: 'warning',
                message: `Could not check ${adapter.name}: ${(error as Error).message}`,
                apiKeyEnvDetected: false,
                apiKeyEnvVars: [],
                apiKeyEnvStripped: false,
              },
              capabilities: {
                streamingJson: false,
                resume: false,
                maxTurns: false,
                maxBudgetUsd: false,
                mcpConfig: false,
                strictMcpConfig: false,
                partialMessages: false,
              },
            };
            return failed;
          }
        }),
      );

      const apiKeyEnv = findApiKeyEnv();
      const engines: EngineInfo[] = detections.map(
        (detection) => detection.info,
      );
      const auth: Record<string, EngineAuthStatus> = {};
      for (const detection of detections) {
        auth[detection.info.id] = detection.auth;
      }

      // Only surface auth trouble for engines that are actually usable —
      // "Codex is not authenticated" is noise when Codex is not supported.
      const relevant = detections
        .filter((detection) => detection.info.available)
        .map((detection) => detection.auth);

      const warnings = environmentWarnings(relevant);
      if (
        apiKeyEnv.detected &&
        !warnings.some((warning) => warning.includes('ANTHROPIC'))
      ) {
        warnings.unshift(
          `${apiKeyEnv.vars.join(' and ')} is set in your environment. An API key overrides subscription login and bills pay-as-you-go; the app strips it from agent runs, but unsetting it in your shell profile is the real fix.`,
        );
      }
      for (const detection of detections) {
        if (!detection.info.available && detection.info.reason) {
          warnings.push(`${detection.info.name}: ${detection.info.reason}`);
        }
      }

      return {
        detections,
        auth,
        status: {
          platform: process.platform,
          engines,
          apiKeyEnvDetected: apiKeyEnv.detected,
          warnings,
          checkedAt: nowIso(),
        },
      };
    },
  };
}
