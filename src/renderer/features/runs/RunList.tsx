/**
 * Run history — the left half of the screen.
 *
 * Ordered newest-first with anything still moving pinned to the top, because
 * "what is happening right now" is the question this pane gets asked most and
 * it should never require scrolling. Virtualized: a machine that has been
 * running scheduled jobs for a month has thousands of rows.
 *
 * Filtering happens twice on purpose — the query goes to `runs:list` so the
 * backend can index it, and the same predicate runs locally so the list reacts
 * instantly and still behaves when main is not answering.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Activity,
  Inbox,
  Plug,
  RefreshCw,
  RotateCcw,
  Search,
  TriangleAlert,
} from 'lucide-react';
import type { Run, RunStatus } from '../../../shared/runs';
import { cn } from '../../lib/utils';
import { TONE_TEXT } from '../../lib/tone';
import { runStatusMeta } from '../../lib/status';
import {
  formatCost,
  formatDuration,
  formatElapsed,
  formatRelative,
  truncate,
} from '../../lib/format';
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Select,
  StatusDot,
  eyebrow,
  focusRingInset,
  textMuted,
} from '../../components/ui';
import { isRunLive, useRunList, useRunsStore } from '../../store';
import { failureKindLabel, isQuotaFailure, readFailureKind } from './failures';
import { useShowCosts } from './CostMeter';

/* ------------------------------------------------------------------ */
/* Filters                                                             */
/* ------------------------------------------------------------------ */

const FILTERS = {
  all: { label: 'All runs', statuses: [] as RunStatus[] },
  live: {
    label: 'Live',
    statuses: ['queued', 'running', 'awaiting_approval'] as RunStatus[],
  },
  waiting: {
    label: 'Waiting on you',
    statuses: ['awaiting_approval'] as RunStatus[],
  },
  succeeded: { label: 'Succeeded', statuses: ['succeeded'] as RunStatus[] },
  failed: { label: 'Failed', statuses: ['failed'] as RunStatus[] },
  cancelled: { label: 'Cancelled', statuses: ['cancelled'] as RunStatus[] },
} as const;

type FilterKey = keyof typeof FILTERS;

const FILTER_OPTIONS = (Object.keys(FILTERS) as FilterKey[]).map((key) => ({
  value: key,
  label: FILTERS[key].label,
}));

type ListRow =
  | { type: 'header'; key: string; label: string; count: number }
  | { type: 'run'; key: string; run: Run };

/* ------------------------------------------------------------------ */
/* Row                                                                 */
/* ------------------------------------------------------------------ */

interface RunRowProps {
  run: Run;
  selected: boolean;
  now: number;
  showCosts: boolean;
  onSelect: (id: string) => void;
  onRerun: (run: Run) => void;
}

function RunRow({
  run,
  selected,
  now,
  showCosts,
  onSelect,
  onRerun,
}: RunRowProps) {
  const meta = runStatusMeta(run.status);
  const live = isRunLive(run);
  const kind = readFailureKind(run);
  const duration = live
    ? formatElapsed(run.startedAt ?? run.createdAt, undefined)
    : formatDuration(run.durationMs);
  const cost = run.usage?.totalCostUsd;
  const subtitle = run.prompt && run.prompt !== run.title ? run.prompt : '';

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={() => onSelect(run.id)}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'flex w-full flex-col gap-1 border-b border-zinc-100 px-3 py-2.5 text-left transition-colors dark:border-zinc-800/70',
          focusRingInset,
          selected
            ? 'bg-indigo-50/70 dark:bg-indigo-500/10'
            : 'hover:bg-zinc-50 dark:hover:bg-zinc-900/60',
        )}
      >
        <div className="flex items-center gap-2">
          <StatusDot
            tone={meta.tone}
            pulse={meta.active}
            label={meta.label}
            size="md"
          />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-zinc-800 dark:text-zinc-200">
            {run.title}
          </span>
          <span
            className={cn(
              'shrink-0 text-[11px] tabular-nums',
              live ? TONE_TEXT.info : 'text-zinc-400 dark:text-zinc-500',
            )}
          >
            {/* `now` keeps this honest for a run that is still going. */}
            {live ? duration : formatRelative(run.createdAt, now)}
          </span>
        </div>

        {subtitle ? (
          <p className="truncate pl-4 text-[11.5px] leading-snug text-zinc-500 dark:text-zinc-400">
            {truncate(subtitle.replace(/\s+/g, ' '), 120)}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 pl-4 text-[11px] tabular-nums text-zinc-500 dark:text-zinc-500">
          <span className={TONE_TEXT[meta.tone]}>{meta.label}</span>
          {kind ? (
            <Badge
              tone={isQuotaFailure(kind) ? 'warning' : 'danger'}
              variant="outline"
            >
              {failureKindLabel(kind)}
            </Badge>
          ) : null}
          {!live && run.durationMs !== undefined ? (
            <span>{duration}</span>
          ) : null}
          {showCosts && cost !== undefined ? (
            <span>{formatCost(cost)}</span>
          ) : null}
          {run.usage?.turns !== undefined ? (
            <span>{run.usage.turns} turns</span>
          ) : null}
          {run.trigger !== 'manual' ? (
            <span className="uppercase tracking-wide">{run.trigger}</span>
          ) : null}
        </div>
      </button>

      <div className="absolute right-2 top-2 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <Button
          size="icon-sm"
          variant="ghost"
          icon={RotateCcw}
          title="Re-run with the same prompt"
          aria-label={`Re-run ${run.title}`}
          onClick={() => onRerun(run)}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pane                                                                */
/* ------------------------------------------------------------------ */

export interface RunListProps {
  selectedRunId: string | null;
  onSelect: (id: string) => void;
  onRerun: (run: Run) => void;
  onStartFirst: () => void;
  /** Wall clock, so relative times and live durations stay truthful. */
  now: number;
  className?: string;
}

export function RunList({
  selectedRunId,
  onSelect,
  onRerun,
  onStartFirst,
  now,
  className,
}: RunListProps) {
  const runs = useRunList();
  const loadRuns = useRunsStore((state) => state.loadRuns);
  const status = useRunsStore((state) => state.status);
  const error = useRunsStore((state) => state.error);
  const unavailable = useRunsStore((state) => state.unavailable);
  const showCosts = useShowCosts();

  const [filter, setFilter] = useState<FilterKey>('all');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const statuses = FILTERS[filter].statuses;
  const statusKey = statuses.join(',');

  const reload = useCallback(() => {
    void loadRuns({
      status: statuses.length > 0 ? statuses : undefined,
      search: debounced || undefined,
      limit: 200,
    });
    // `statusKey` is the value-identity of `statuses`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadRuns, statusKey, debounced]);

  useEffect(reload, [reload]);

  const visible = useMemo(() => {
    const needle = debounced.toLowerCase();
    return runs.filter((run) => {
      if (statuses.length > 0 && !statuses.includes(run.status)) return false;
      if (needle === '') return true;
      return (
        run.title.toLowerCase().includes(needle) ||
        run.prompt.toLowerCase().includes(needle)
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs, statusKey, debounced]);

  // Anything still moving is pinned above the history.
  const rows = useMemo<ListRow[]>(() => {
    const live = visible.filter(isRunLive);
    const rest = visible.filter((run) => !isRunLive(run));
    const out: ListRow[] = [];
    if (live.length > 0) {
      out.push({
        type: 'header',
        key: 'h:live',
        label: 'In flight',
        count: live.length,
      });
      live.forEach((run) => out.push({ type: 'run', key: run.id, run }));
    }
    if (rest.length > 0) {
      out.push({
        type: 'header',
        key: 'h:history',
        label: live.length > 0 ? 'History' : 'All runs',
        count: rest.length,
      });
      rest.forEach((run) => out.push({ type: 'run', key: run.id, run }));
    }
    return out;
  }, [visible]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index].type === 'header' ? 26 : 74),
    getItemKey: (index) => rows[index].key,
    overscan: 8,
    // A sensible window before the ResizeObserver reports, so the first
    // paint is real rows rather than an empty box.
    initialRect: { width: 0, height: 640 },
  });

  const filtered = statuses.length > 0 || debounced !== '';

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <Input
          size="sm"
          icon={Search}
          placeholder="Search runs"
          aria-label="Search runs"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          containerClassName="min-w-0 flex-1"
        />
        <Select
          size="sm"
          aria-label="Filter by status"
          options={FILTER_OPTIONS}
          value={filter}
          onChange={(event) => setFilter(event.target.value as FilterKey)}
          containerClassName="w-[8.5rem] shrink-0"
        />
        <Button
          size="icon-sm"
          variant="ghost"
          icon={RefreshCw}
          title="Reload"
          aria-label="Reload runs"
          onClick={reload}
        />
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <ListPlaceholder
            loading={status === 'loading'}
            unavailable={unavailable}
            error={error}
            filtered={filtered}
            onRetry={reload}
            onClearFilters={() => {
              setFilter('all');
              setSearch('');
            }}
            onStartFirst={onStartFirst}
          />
        ) : (
          <div
            style={{
              height: virtualizer.getTotalSize(),
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${item.start}px)`,
                  }}
                >
                  {row.type === 'header' ? (
                    <div
                      className={cn(
                        'flex items-center gap-1.5 border-b border-zinc-200 bg-zinc-50 px-3 py-1 dark:border-zinc-800 dark:bg-zinc-900/60',
                        eyebrow,
                      )}
                    >
                      {row.label}
                      <span className="text-zinc-400 dark:text-zinc-600">
                        {row.count}
                      </span>
                    </div>
                  ) : (
                    <RunRow
                      run={row.run}
                      selected={row.run.id === selectedRunId}
                      now={now}
                      showCosts={showCosts}
                      onSelect={onSelect}
                      onRerun={onRerun}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Empty / error                                                       */
/* ------------------------------------------------------------------ */

interface ListPlaceholderProps {
  loading: boolean;
  unavailable: boolean;
  error: string | null;
  filtered: boolean;
  onRetry: () => void;
  onClearFilters: () => void;
  onStartFirst: () => void;
}

/**
 * Four genuinely different nothings, said differently. "Not wired up yet",
 * "the handler failed", "your filter excludes everything" and "you have never
 * run anything" are not the same problem and must not share a message.
 */
function ListPlaceholder({
  loading,
  unavailable,
  error,
  filtered,
  onRetry,
  onClearFilters,
  onStartFirst,
}: ListPlaceholderProps) {
  if (unavailable) {
    return (
      <EmptyState
        icon={Plug}
        size="sm"
        title="Not connected to the backend"
        description="The run history lives in the main process, which has not answered yet. Nothing is lost — this pane fills in as soon as it does."
        action={
          <Button
            size="sm"
            variant="outline"
            icon={RefreshCw}
            onClick={onRetry}
          >
            Try again
          </Button>
        }
        footer={error ?? undefined}
      />
    );
  }

  if (error) {
    return (
      <EmptyState
        icon={TriangleAlert}
        size="sm"
        title="Could not load runs"
        description={error}
        action={
          <Button
            size="sm"
            variant="outline"
            icon={RefreshCw}
            onClick={onRetry}
          >
            Try again
          </Button>
        }
      />
    );
  }

  if (loading) {
    return (
      <p className={cn('px-3 py-6 text-center text-[12px]', textMuted)}>
        Loading runs…
      </p>
    );
  }

  if (filtered) {
    return (
      <EmptyState
        icon={Search}
        size="sm"
        title="No runs match"
        description="Nothing in the history matches this filter."
        action={
          <Button size="sm" variant="ghost" onClick={onClearFilters}>
            Clear filters
          </Button>
        }
      />
    );
  }

  return (
    <EmptyState
      icon={Inbox}
      size="sm"
      title="No runs yet"
      description="Start one and every step, tool call and cost lands here as it happens."
      action={
        <Button
          size="sm"
          variant="primary"
          icon={Activity}
          onClick={onStartFirst}
        >
          Start the first run
        </Button>
      }
    />
  );
}

export default RunList;
