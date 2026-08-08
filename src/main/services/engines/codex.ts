/**
 * Codex adapter — **a stub that reports itself unavailable.**
 *
 * `codex` is not installed on the development machine (`docs/API-NOTES.md` §9),
 * so its flag surface, its stream format and its resume semantics are all
 * unverified. Writing them from memory would produce an adapter that typechecks,
 * ships, and fails the first time a user with codex installed presses Run — and
 * it would fail in the hardest way to debug, by half-working.
 *
 * So this file does exactly two honest things: it detects whether the binary is
 * on PATH, and it refuses to run. `detect()` reports `available: false` with a
 * reason a human can act on even when the binary *is* found, because presence
 * is not support.
 *
 * Filling this in is a contained job: implement `run`/`resume` against the real
 * stream format, keep {@link EngineEvent} as the output, and nothing else in the
 * app changes. That is the point of the shared interface.
 */
/* eslint-disable max-classes-per-file */
import { nowIso } from '../../../shared/common';
import { getLogger } from '../../infra/logger';
import type { Logger } from '../../infra/logger';
import { whichSync } from '../../infra/spawn';
import { findApiKeyEnv } from './environment';
import { AsyncEventQueue, batchEvents, resolveBatchOptions } from './stream';
import type {
  BatchOptions,
  DetectOptions,
  EngineAdapter,
  EngineAuthStatus,
  EngineDetection,
  EngineEvent,
  EngineRun,
  EngineRunOptions,
  EngineRunSummary,
} from './types';

export const CODEX_ENGINE_ID = 'codex';
export const CODEX_BINARY = 'codex';

const UNSUPPORTED_REASON =
  'The Codex adapter is not implemented. Its headless flags and event stream have never been verified against a real install, so it is disabled rather than guessed at. Use Claude Code.';

const NOT_INSTALLED_REASON =
  'The Codex CLI was not found on PATH, and the Codex adapter is not implemented yet. Use Claude Code.';

/** A run that fails immediately, cleanly, with an explanation. */
class UnavailableRun implements EngineRun {
  readonly engineId = CODEX_ENGINE_ID;

  readonly sessionId = undefined;

  readonly pid = undefined;

  readonly done: Promise<EngineRunSummary>;

  private readonly queue = new AsyncEventQueue<EngineEvent>();

  private readonly batchDefaults: Required<BatchOptions>;

  constructor(reason: string, options?: EngineRunOptions) {
    this.batchDefaults = resolveBatchOptions(options?.batch);
    const at = nowIso();
    this.queue.push({
      at,
      type: 'error',
      kind: 'not-installed',
      message: reason,
    });
    this.queue.push({
      at,
      type: 'engine.finished',
      status: 'failed',
      exitCode: null,
      signal: null,
      durationMs: 0,
      error: reason,
      errorKind: 'not-installed',
    });
    this.queue.close();
    this.done = Promise.resolve({
      engineId: CODEX_ENGINE_ID,
      status: 'failed',
      usage: {},
      byModel: [],
      turns: 0,
      durationMs: 0,
      exitCode: null,
      signal: null,
      error: reason,
      errorKind: 'not-installed',
      attempts: 0,
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
    return this.queue[Symbol.asyncIterator]();
  }

  batches(overrides?: BatchOptions): AsyncIterable<EngineEvent[]> {
    return batchEvents(
      this,
      resolveBatchOptions(this.batchDefaults, overrides),
    );
  }

  async cancel(): Promise<void> {
    this.queue.close();
  }
}

export class CodexAdapter implements EngineAdapter {
  readonly id = CODEX_ENGINE_ID;

  readonly name = 'Codex';

  private readonly logger: Logger;

  constructor(
    private readonly options: { binaryPath?: string; logger?: Logger } = {},
  ) {
    this.logger = options.logger ?? getLogger('engines:codex');
  }

  async detect(options: DetectOptions = {}): Promise<EngineDetection> {
    const binaryPath =
      options.binaryPath ?? this.options.binaryPath ?? whichSync(CODEX_BINARY);
    const apiKeyEnv = findApiKeyEnv();

    const auth: EngineAuthStatus = {
      state: 'unknown',
      severity: 'warning',
      message: 'Codex is not supported yet, so its auth state is not checked.',
      apiKeyEnvDetected: apiKeyEnv.detected,
      apiKeyEnvVars: apiKeyEnv.vars,
      apiKeyEnvStripped: false,
    };

    // `available: false` even when the binary is present. Presence is not
    // support, and claiming otherwise would put a broken engine in a dropdown.
    return {
      info: {
        id: this.id,
        name: this.name,
        available: false,
        binaryPath: binaryPath ?? undefined,
        reason: binaryPath ? UNSUPPORTED_REASON : NOT_INSTALLED_REASON,
        supportsResume: false,
        supportsStreamingJson: false,
        auth,
        detectedAt: nowIso(),
      },
      auth,
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
  }

  run(_prompt: string, options: EngineRunOptions): EngineRun {
    this.logger.warn('codex run requested; adapter is not implemented');
    return new UnavailableRun(UNSUPPORTED_REASON, options);
  }

  resume(
    _sessionId: string,
    _prompt: string,
    options: EngineRunOptions,
  ): EngineRun {
    this.logger.warn('codex resume requested; adapter is not implemented');
    return new UnavailableRun(UNSUPPORTED_REASON, options);
  }
}

export function createCodexAdapter(options?: {
  binaryPath?: string;
  logger?: Logger;
}): CodexAdapter {
  return new CodexAdapter(options);
}
