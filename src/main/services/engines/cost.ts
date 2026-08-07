/**
 * The cost meter.
 *
 * The final `result` line of every invocation carries session id, turn count,
 * duration and per-model cost. Accumulating it is the whole of quota
 * accounting — there is nothing to estimate and nothing to price, so the only
 * way to get this wrong is to throw the data away.
 *
 * The meter is a plain accumulator with no I/O and no clock of its own, so the
 * orchestrator can rebuild one by replaying persisted result events after a
 * restart.
 */
import { nowIso } from '../../../shared/common';
import type { IsoDateTime, Usage } from '../../../shared/common';
import type { EngineEvent, ModelUsage } from './types';

/** Per-model totals, keyed by model name. */
export interface ModelCostTotals extends ModelUsage {
  /** How many invocations reported this model. */
  invocations: number;
}

/** What the UI renders as a running meter. */
export interface CostSnapshot {
  /** Invocations counted, i.e. `result` events seen. */
  invocations: number;
  turns: number;
  totalCostUsd: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  byModel: ModelCostTotals[];
  lastSessionId?: string;
  /** Set when a budget was supplied. */
  budgetUsd?: number;
  budgetRemainingUsd?: number;
  /** 0–1, clamped. Drives a progress bar without the UI doing arithmetic. */
  budgetUsedFraction?: number;
  overBudget: boolean;
  maxTurns?: number;
  turnsRemaining?: number;
  overTurns: boolean;
  updatedAt: IsoDateTime;
}

export interface CostMeterLimits {
  /** Ceiling across everything this meter counts. */
  budgetUsd?: number;
  maxTurns?: number;
}

function addInto(target: ModelCostTotals, source: ModelUsage): void {
  target.invocations += 1;
  target.inputTokens = (target.inputTokens ?? 0) + (source.inputTokens ?? 0);
  target.outputTokens = (target.outputTokens ?? 0) + (source.outputTokens ?? 0);
  target.cacheReadTokens =
    (target.cacheReadTokens ?? 0) + (source.cacheReadTokens ?? 0);
  target.cacheCreationTokens =
    (target.cacheCreationTokens ?? 0) + (source.cacheCreationTokens ?? 0);
  target.costUsd = (target.costUsd ?? 0) + (source.costUsd ?? 0);
  if (source.webSearchRequests !== undefined) {
    target.webSearchRequests =
      (target.webSearchRequests ?? 0) + source.webSearchRequests;
  }
  // Context window is a property of the model, not something to sum.
  if (source.contextWindow !== undefined) {
    target.contextWindow = source.contextWindow;
  }
}

/**
 * Accumulates cost and turns across one or many engine invocations.
 *
 * Feed it every event with {@link CostMeter.observe} and it ignores what it
 * does not need, so a caller can pipe the whole stream through without
 * filtering.
 */
export class CostMeter {
  private invocations = 0;

  private turns = 0;

  private totalCostUsd = 0;

  private durationMs = 0;

  private inputTokens = 0;

  private outputTokens = 0;

  private cacheReadTokens = 0;

  private cacheCreationTokens = 0;

  private models = new Map<string, ModelCostTotals>();

  private lastSessionId: string | undefined;

  private limits: CostMeterLimits;

  constructor(limits: CostMeterLimits = {}) {
    this.limits = limits;
  }

  /** Pipe the whole event stream through this; non-result events are ignored. */
  observe(event: EngineEvent): void {
    if (event.type === 'session') {
      this.lastSessionId = event.sessionId;
      return;
    }
    if (event.type !== 'result') return;
    if (event.sessionId) this.lastSessionId = event.sessionId;
    this.addResult(event.usage, event.byModel, event.turns, event.durationMs);
  }

  /**
   * Add one invocation's figures. Separate from {@link observe} so a restarted
   * app can rebuild the meter from persisted rows without synthesising events.
   */
  addResult(
    usage: Usage,
    perModel?: ModelUsage[],
    turns?: number,
    durationMs?: number,
  ): void {
    const byModel = perModel ?? [];
    this.invocations += 1;
    this.turns += turns ?? usage.turns ?? 0;
    this.durationMs += durationMs ?? usage.durationMs ?? 0;
    this.totalCostUsd += usage.totalCostUsd ?? 0;

    // Prefer the per-model token counts; the flat `usage` block on a result
    // line reports only the last turn in some builds, which would undercount.
    if (byModel.length > 0) {
      for (const entry of byModel) {
        this.inputTokens += entry.inputTokens ?? 0;
        this.outputTokens += entry.outputTokens ?? 0;
        this.cacheReadTokens += entry.cacheReadTokens ?? 0;
        this.cacheCreationTokens += entry.cacheCreationTokens ?? 0;
        const existing = this.models.get(entry.model) ?? {
          model: entry.model,
          invocations: 0,
        };
        addInto(existing, entry);
        this.models.set(entry.model, existing);
      }
    } else {
      this.inputTokens += usage.inputTokens ?? 0;
      this.outputTokens += usage.outputTokens ?? 0;
      this.cacheReadTokens += usage.cacheReadTokens ?? 0;
      this.cacheCreationTokens += usage.cacheCreationTokens ?? 0;
      if (usage.model) {
        const existing = this.models.get(usage.model) ?? {
          model: usage.model,
          invocations: 0,
        };
        addInto(existing, {
          model: usage.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheCreationTokens: usage.cacheCreationTokens,
          costUsd: usage.totalCostUsd,
        });
        this.models.set(usage.model, existing);
      }
    }
  }

  setLimits(limits: CostMeterLimits): void {
    this.limits = { ...this.limits, ...limits };
  }

  /** Flat totals, in the shape `Usage` uses, for persisting on a run row. */
  toUsage(): Usage {
    const usage: Usage = {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheCreationTokens: this.cacheCreationTokens,
      totalCostUsd: round(this.totalCostUsd),
      durationMs: this.durationMs,
      turns: this.turns,
    };
    // Name a model only when there is exactly one; "several" is not a model.
    if (this.models.size === 1) {
      usage.model = [...this.models.keys()][0];
    }
    return usage;
  }

  snapshot(): CostSnapshot {
    const { budgetUsd, maxTurns } = this.limits;
    const cost = round(this.totalCostUsd);
    const snapshot: CostSnapshot = {
      invocations: this.invocations,
      turns: this.turns,
      totalCostUsd: cost,
      durationMs: this.durationMs,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheCreationTokens: this.cacheCreationTokens,
      byModel: [...this.models.values()]
        .map((entry) => ({ ...entry, costUsd: round(entry.costUsd ?? 0) }))
        .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0)),
      lastSessionId: this.lastSessionId,
      overBudget: budgetUsd !== undefined && cost >= budgetUsd,
      overTurns: maxTurns !== undefined && this.turns >= maxTurns,
      updatedAt: nowIso(),
    };
    if (budgetUsd !== undefined) {
      snapshot.budgetUsd = budgetUsd;
      snapshot.budgetRemainingUsd = round(Math.max(0, budgetUsd - cost));
      snapshot.budgetUsedFraction =
        budgetUsd > 0 ? Math.min(1, Math.max(0, cost / budgetUsd)) : 1;
    }
    if (maxTurns !== undefined) {
      snapshot.turnsRemaining = Math.max(0, maxTurns - this.turns);
    }
    return snapshot;
  }

  reset(): void {
    this.invocations = 0;
    this.turns = 0;
    this.totalCostUsd = 0;
    this.durationMs = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.cacheReadTokens = 0;
    this.cacheCreationTokens = 0;
    this.models = new Map();
    this.lastSessionId = undefined;
  }
}

/** Six decimals: sub-cent costs are real and rounding them away hides them. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** One-shot totals for a finished stream, when a live meter is overkill. */
export function accumulateCost(
  events: Iterable<EngineEvent>,
  limits?: CostMeterLimits,
): CostSnapshot {
  const meter = new CostMeter(limits);
  for (const event of events) meter.observe(event);
  return meter.snapshot();
}
