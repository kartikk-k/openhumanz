/**
 * Money, on screen, before it is spent.
 *
 * The engine reports per-model cost on its final result, so the cost meter is
 * free data — and quota exhaustion is the failure a real user hits first. That
 * makes headroom a first-class thing to show, not a detail buried in a
 * settings pane. Two views:
 *
 *  - {@link RunCostMeter}   this run's spend against the per-run ceiling.
 *  - {@link SpendSummary}   a rolling total across the loaded history.
 *
 * Both go quiet when `settings.ui.showCosts` is off. They never invent a
 * number: an engine that reported no usage shows a dash, not `$0`.
 */
import { useMemo } from 'react';
import { Coins, Gauge, Hash, Cpu, Timer } from 'lucide-react';
import type { Usage } from '../../../shared/common';
import type { Run } from '../../../shared/runs';
import { cn } from '../../lib/utils';
import { TONE_DOT, TONE_TEXT, type Tone } from '../../lib/tone';
import { formatCost, formatCount, formatDuration } from '../../lib/format';
import { eyebrow, textMuted } from '../../components/ui';
import { useSettingsStore } from '../../store';

/** The per-run ceiling from settings. `0` means "no ceiling configured". */
export function useCostCeiling(): number {
  return useSettingsStore((state) => state.settings.engine.maxCostUsdPerRun);
}

/** Whether cost and token counts are shown at all. */
export function useShowCosts(): boolean {
  return useSettingsStore((state) => state.settings.ui.showCosts);
}

/** Green until it matters, amber when it is close, red when it is over. */
function headroomTone(fraction: number): Tone {
  if (fraction >= 1) return 'danger';
  if (fraction >= 0.75) return 'warning';
  return 'success';
}

interface BarProps {
  fraction: number;
  tone: Tone;
  className?: string;
}

function Bar({ fraction, tone, className }: BarProps) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <div
      className={cn(
        'h-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800',
        className,
      )}
    >
      <div
        className={cn('h-full rounded-full transition-[width]', TONE_DOT[tone])}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

interface StatProps {
  icon: typeof Coins;
  label: string;
  value: string;
  tone?: Tone;
  title?: string;
}

/** One `icon · label · value` column. The unit of the meter. */
function Stat({ icon: Icon, label, value, tone, title }: StatProps) {
  return (
    <div className="min-w-0" title={title}>
      <p className={cn('flex items-center gap-1', eyebrow)}>
        <Icon size={11} aria-hidden="true" />
        {label}
      </p>
      <p
        className={cn(
          'mt-0.5 truncate font-mono text-[13px] tabular-nums',
          tone ? TONE_TEXT[tone] : 'text-zinc-800 dark:text-zinc-200',
        )}
      >
        {value}
      </p>
    </div>
  );
}

export interface RunCostMeterProps {
  usage: Usage | undefined;
  /** True when `usage` was summed from steps rather than reported by the run. */
  derived?: boolean;
  /** Live elapsed milliseconds — the run may still be going. */
  elapsedMs?: number;
  className?: string;
}

/**
 * Spend, turns, tokens, model and wall clock for one run, with the per-run
 * ceiling drawn as a bar so headroom is a shape rather than a subtraction the
 * user has to do in their head.
 */
export function RunCostMeter({
  usage,
  derived = false,
  elapsedMs,
  className,
}: RunCostMeterProps) {
  const ceiling = useCostCeiling();
  const showCosts = useShowCosts();

  const spend = usage?.totalCostUsd;
  const fraction = ceiling > 0 && spend !== undefined ? spend / ceiling : 0;
  const tone = headroomTone(fraction);
  const tokens =
    usage === undefined
      ? undefined
      : (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);

  return (
    <div
      className={cn(
        'rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/60',
        className,
      )}
    >
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        {showCosts ? (
          <Stat
            icon={Coins}
            label={derived ? 'Cost (summed)' : 'Cost'}
            value={formatCost(spend)}
            tone={spend !== undefined && ceiling > 0 ? tone : undefined}
            title={
              derived
                ? 'Summed from the steps — the run has not reported its own total yet.'
                : undefined
            }
          />
        ) : null}
        <Stat
          icon={Timer}
          label="Elapsed"
          value={formatDuration(elapsedMs ?? usage?.durationMs)}
        />
        <Stat icon={Hash} label="Turns" value={formatCount(usage?.turns)} />
        {showCosts ? (
          <Stat icon={Cpu} label="Tokens" value={formatCount(tokens)} />
        ) : null}
        {!showCosts ? (
          <Stat
            icon={Cpu}
            label="Model"
            value={usage?.model ?? '—'}
            title={usage?.model}
          />
        ) : null}
      </div>

      {showCosts && ceiling > 0 ? (
        <div className="mt-2.5">
          <Bar fraction={fraction} tone={tone} />
          <p className={cn('mt-1 flex items-center gap-1.5 text-[11px]', textMuted)}>
            <Gauge size={11} aria-hidden="true" />
            <span className="tabular-nums">
              {formatCost(spend ?? 0)} of the {formatCost(ceiling)} per-run
              ceiling
            </span>
            {usage?.model ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate font-mono">{usage.model}</span>
              </>
            ) : null}
          </p>
        </div>
      ) : null}
    </div>
  );
}

export interface SpendSummaryProps {
  /** The runs currently loaded into the list. */
  runs: readonly Run[];
  className?: string;
}

/**
 * Rolling spend across the loaded history, sat next to the New-run button so
 * the number is in view at the moment someone decides to start something long.
 */
export function SpendSummary({ runs, className }: SpendSummaryProps) {
  const ceiling = useCostCeiling();
  const showCosts = useShowCosts();

  const total = useMemo(
    () =>
      runs.reduce((sum, run) => sum + (run.usage?.totalCostUsd ?? 0), 0),
    [runs],
  );
  const counted = useMemo(
    () => runs.filter((run) => run.usage?.totalCostUsd !== undefined).length,
    [runs],
  );

  if (!showCosts || runs.length === 0) return null;

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1 dark:border-zinc-800 dark:bg-zinc-900/60',
        className,
      )}
      title={
        counted === runs.length
          ? undefined
          : `${runs.length - counted} of these runs reported no usage.`
      }
    >
      <Coins size={13} aria-hidden="true" className="text-zinc-400" />
      <span className="font-mono text-[12px] font-medium tabular-nums text-zinc-800 dark:text-zinc-200">
        {formatCost(total)}
      </span>
      <span className={cn('text-[11px]', textMuted)}>
        across {counted} run{counted === 1 ? '' : 's'}
        {ceiling > 0 ? ` · ${formatCost(ceiling)} cap per run` : ''}
      </span>
    </div>
  );
}
