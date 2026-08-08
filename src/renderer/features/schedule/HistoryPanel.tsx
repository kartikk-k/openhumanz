/**
 * The right-hand rail: one job's definition and its evaluation history.
 *
 * It is a rail rather than a page because ARCHITECTURE.md asks for the jobs
 * table to be *one screen, no drilling* — selecting a job must not take the
 * table away.
 *
 * The history is the point of the panel. Every wake-up writes a record,
 * including the ones that decided not to spawn, so a healthy gated job shows
 * mostly `skipped / condition held`. Skips are therefore rendered as a
 * first-class outcome with their own reason line, not as a gap between runs,
 * and the header counts them out loud.
 */
import { useMemo } from 'react';
import {
  ExternalLink,
  Pencil,
  Play,
  Trash2,
  X,
  History as HistoryIcon,
} from 'lucide-react';
import { IPC, IPC_PUSH } from '../../../shared/ipc';
import type {
  ScheduleRunRecord,
  ScheduleRunStatus,
  ScheduledJob,
} from '../../../shared/schedule';
import { cn } from '../../lib/utils';
import { useQuery } from '../../lib/ipc';
import {
  formatDateTime,
  formatDuration,
  formatRelative,
  pluralize,
} from '../../lib/format';
import { runStatusMeta } from '../../lib/status';
import { TONE_TEXT } from '../../lib/tone';
import {
  Badge,
  Button,
  EmptyState,
  Spinner,
  Tabs,
  type TabItem,
} from '../../components/ui';
import { eyebrow, mono, textMuted } from '../../components/ui/styles';
import {
  BridgeNotice,
  ConditionChip,
  DetailRow,
  MISSED_RUN_POLICY_HINT,
  MISSED_RUN_POLICY_LABEL,
  OutcomeLine,
  TRIGGER_LABEL,
  describeCondition,
  scheduleRunMeta,
} from './parts';

/** Records fetched per job. Fifty wake-ups is weeks of history for a daily job. */
const HISTORY_LIMIT = 50;

type HistoryFilter = 'all' | ScheduleRunStatus;

export interface HistoryPanelProps {
  job: ScheduledJob;
  filter: HistoryFilter;
  onFilterChange: (filter: HistoryFilter) => void;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onRunNow: () => void;
  runNowPending: boolean;
  onOpenRun: (runId: string) => void;
  className?: string;
}

export function HistoryPanel({
  job,
  filter,
  onFilterChange,
  onClose,
  onEdit,
  onDelete,
  onRunNow,
  runNowPending,
  onOpenRun,
  className,
}: HistoryPanelProps) {
  const history = useQuery(
    IPC.schedule.history,
    {
      jobId: job.id,
      status: filter === 'all' ? undefined : filter,
      limit: HISTORY_LIMIT,
    },
    { refetchOn: [IPC_PUSH.scheduleChanged] },
  );

  const records = history.data?.items ?? [];

  // Counted over what is loaded, and labelled as such — a rolling window is
  // honest here, an implied all-time total would not be.
  const counts = useMemo(() => {
    const tally = { dispatched: 0, skipped: 0, error: 0 };
    for (const record of records) tally[record.status] += 1;
    return tally;
  }, [records]);

  const tabs: readonly TabItem<HistoryFilter>[] = [
    { value: 'all', label: 'All' },
    { value: 'dispatched', label: 'Dispatched' },
    { value: 'skipped', label: 'Skipped' },
    { value: 'error', label: 'Errors' },
  ];

  const lastStatusMeta = job.lastStatus ? runStatusMeta(job.lastStatus) : null;

  return (
    <aside
      className={cn(
        'flex min-h-0 flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950',
        className,
      )}
      aria-label={`History for ${job.name}`}
    >
      {/* header ---------------------------------------------------- */}
      <div className="flex items-start gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[13.5px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            {job.name}
          </h2>
          <p className={cn('mt-0.5 truncate text-[11.5px]', textMuted)}>
            {job.humanReadable || job.cron} · {describeCondition(job.condition)}
          </p>
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          icon={X}
          aria-label="Close history"
          onClick={onClose}
        />
      </div>

      <div className="flex items-center gap-1.5 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <Button
          size="xs"
          variant="primary"
          icon={Play}
          loading={runNowPending}
          onClick={onRunNow}
        >
          Run now
        </Button>
        <Button size="xs" variant="outline" icon={Pencil} onClick={onEdit}>
          Edit
        </Button>
        <div className="flex-1" />
        <Button
          size="xs"
          variant="ghost"
          icon={Trash2}
          onClick={onDelete}
          className="text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10"
        >
          Delete
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* definition ---------------------------------------------- */}
        <section className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <p className={cn('mb-1.5', eyebrow)}>Definition</p>
          <DetailRow label="Schedule">
            <span className="block">{job.humanReadable || '—'}</span>
            <span className={cn('block text-[11px]', mono, textMuted)}>
              {job.cron} · {job.timezone}
            </span>
          </DetailRow>
          <DetailRow label="Condition">
            <ConditionChip condition={job.condition} />
          </DetailRow>
          <DetailRow label="Missed runs">
            <span className="block">
              {MISSED_RUN_POLICY_LABEL[job.missedRunPolicy]}
            </span>
            <span className={cn('block text-[11px] leading-4', textMuted)}>
              {MISSED_RUN_POLICY_HINT[job.missedRunPolicy]}
            </span>
          </DetailRow>
          <DetailRow label="Next run">
            {job.enabled ? (
              <>
                {formatDateTime(job.nextRunAt)}
                <span className={cn('ml-1.5 text-[11px]', textMuted)}>
                  {job.nextRunAt ? formatRelative(job.nextRunAt) : ''}
                </span>
              </>
            ) : (
              <span className={textMuted}>Disabled — will not fire</span>
            )}
          </DetailRow>
          <DetailRow label="Last run">
            {lastStatusMeta ? (
              <span className="flex flex-wrap items-center gap-1.5">
                <Badge tone={lastStatusMeta.tone} dot>
                  {lastStatusMeta.label}
                </Badge>
                <span className={cn('text-[11px]', textMuted)}>
                  {formatRelative(job.lastRunAt)}
                </span>
                {job.lastRunId ? (
                  <Button
                    size="xs"
                    variant="link"
                    iconRight={ExternalLink}
                    onClick={() => onOpenRun(job.lastRunId as string)}
                  >
                    Open run
                  </Button>
                ) : null}
              </span>
            ) : (
              <span className={textMuted}>Has not run yet</span>
            )}
          </DetailRow>
          {job.lastSkipReason ? (
            <DetailRow label="Last skip">{job.lastSkipReason}</DetailRow>
          ) : null}
          {job.engine || job.maxTurns || job.maxCostUsd ? (
            <DetailRow label="Limits">
              {[
                job.engine ? `engine ${job.engine}` : null,
                job.maxTurns ? `${job.maxTurns} turns` : null,
                job.maxCostUsd ? `$${job.maxCostUsd} cap` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </DetailRow>
          ) : null}
          <DetailRow label="Prompt">
            <span className="line-clamp-4 whitespace-pre-wrap">
              {job.prompt}
            </span>
          </DetailRow>
        </section>

        {/* history -------------------------------------------------- */}
        <section className="px-4 py-3">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <p className={eyebrow}>Evaluations</p>
            {records.length > 0 ? (
              <p className={cn('text-[11px] tabular-nums', textMuted)}>
                {pluralize(counts.skipped, 'gate held', 'gates held')} ·{' '}
                {counts.dispatched} dispatched
                {counts.error > 0 ? ` · ${counts.error} failed` : ''}
              </p>
            ) : null}
          </div>

          <Tabs
            items={tabs}
            value={filter}
            onValueChange={onFilterChange}
            variant="pill"
            label="Filter evaluations"
            className="mb-2.5"
          />

          {history.error ? (
            <BridgeNotice
              error={history.error}
              subject="this job’s history"
              actions={
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    void history.refetch();
                  }}
                >
                  Try again
                </Button>
              }
            />
          ) : null}

          {!history.error && history.loading ? (
            <div className="flex items-center gap-2 py-6 text-[12px] text-zinc-500">
              <Spinner size="sm" label={null} />
              Loading history…
            </div>
          ) : null}

          {!history.error && !history.loading && records.length === 0 ? (
            <EmptyState
              icon={HistoryIcon}
              size="sm"
              title={
                filter === 'all'
                  ? 'No evaluations recorded yet'
                  : `No ${filter} evaluations`
              }
              description={
                filter === 'all'
                  ? 'Every wake-up is recorded here — including the ones that check the condition and decide not to spawn.'
                  : 'Try another filter; the full list is under “All”.'
              }
            />
          ) : null}

          {records.length > 0 ? (
            <ol className="space-y-1.5">
              {records.map((record) => (
                <HistoryRow
                  key={record.id}
                  record={record}
                  onOpenRun={onOpenRun}
                />
              ))}
            </ol>
          ) : null}

          {history.data && history.data.total > records.length ? (
            <p className={cn('mt-2 text-[11px]', textMuted)}>
              Showing the most recent {records.length} of {history.data.total}.
            </p>
          ) : null}
        </section>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* One evaluation                                                      */
/* ------------------------------------------------------------------ */

function HistoryRow({
  record,
  onOpenRun,
}: {
  record: ScheduleRunRecord;
  onOpenRun: (runId: string) => void;
}) {
  const meta = scheduleRunMeta(record.status);

  return (
    <li className="rounded-md border border-zinc-200 px-2.5 py-2 dark:border-zinc-800">
      <div className="flex items-center gap-2">
        <meta.icon
          size={13}
          aria-hidden="true"
          className={cn('shrink-0', TONE_TEXT[meta.tone])}
        />
        <span className="text-[12.5px] font-medium text-zinc-800 dark:text-zinc-200">
          {meta.label}
        </span>
        <span className={cn('text-[11px]', textMuted)}>
          {TRIGGER_LABEL[record.trigger]}
        </span>
        <div className="flex-1" />
        <span
          className={cn('shrink-0 text-[11px] tabular-nums', textMuted)}
          title={formatDateTime(record.startedAt)}
        >
          {formatRelative(record.startedAt)}
        </span>
      </div>

      <OutcomeLine record={record} className="mt-1" />

      <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className={cn('text-[11px] tabular-nums', textMuted)}>
          {formatDuration(record.durationMs)}
        </span>
        {record.scheduledFor ? (
          <span className={cn('text-[11px] tabular-nums', textMuted)}>
            for {formatDateTime(record.scheduledFor)}
          </span>
        ) : null}
        {record.missedCount > 0 ? (
          <Badge tone="warning" variant="outline">
            {pluralize(record.missedCount, 'missed occurrence')} collapsed
          </Badge>
        ) : null}
        {record.runId ? (
          <Button
            size="xs"
            variant="link"
            iconRight={ExternalLink}
            onClick={() => onOpenRun(record.runId as string)}
          >
            Open run
          </Button>
        ) : null}
      </div>
    </li>
  );
}

export default HistoryPanel;
