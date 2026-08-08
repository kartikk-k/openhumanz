/**
 * `/schedule` and everything under it.
 *
 * ARCHITECTURE.md, "UI surfaces that matter" #3: *schedule in English, next
 * run, last status, toggle, run-now. One screen.* So this is one table and no
 * detail page. Selecting a job opens a rail beside the table rather than
 * replacing it, and `/schedule/:jobId` is that selection — a real place you can
 * go back from, nested here rather than in `App.tsx`.
 *
 * The two columns that do not appear on a normal cron UI are the ones that
 * matter most here:
 *
 *  - **Condition.** The deterministic gate checked before anything is spawned.
 *    It is what keeps a recurring job from exhausting a weekly quota, so it
 *    lives in the table, not behind an edit dialog. `always` is the only one
 *    coloured as a warning.
 *  - **Last output.** The previous evaluation's own verdict — the error, or the
 *    reason the gate held. Skips are outcomes, not absences.
 *
 * `push:schedule-changed` is wired here rather than in `store/bootstrap.ts`
 * because it is this feature's own channel.
 */
import { useCallback, useMemo, useState } from 'react';
import { useMatch, useNavigate } from 'react-router-dom';
import {
  CalendarClock,
  CalendarPlus,
  Pencil,
  Play,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import { IPC, IPC_PUSH } from '../../../shared/ipc';
import type {
  ScheduleRunRecord,
  ScheduleRunStatus,
  ScheduledJob,
} from '../../../shared/schedule';
import { ROUTES } from '../../routes';
import { cn } from '../../lib/utils';
import { useMutation, useQuery } from '../../lib/ipc';
import {
  formatDateTime,
  formatRelative,
  pluralize,
  truncate,
} from '../../lib/format';
import { runStatusMeta } from '../../lib/status';
import { useNow } from '../../hooks/useNow';
import { toast } from '../../store/toastStore';
import { PageHeader } from '../../components/layout/PageHeader';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Input,
  Spinner,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableEmptyRow,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tabs,
  Tooltip,
  type TabItem,
} from '../../components/ui';
import { mono, textMuted } from '../../components/ui/styles';
import { HistoryPanel } from './HistoryPanel';
import { JobDialog } from './JobDialog';
import {
  BridgeNotice,
  ConditionChip,
  MISSED_RUN_POLICY_LABEL,
  MISSED_RUN_POLICY_WORD,
  lastOutputPreview,
} from './parts';

/**
 * Records pulled across every job to build the "last output" column. One query
 * for the whole table beats one per row across the IPC boundary.
 */
const RECENT_HISTORY_LIMIT = 200;

/** Relative timestamps go stale silently; a slow tick keeps the table honest. */
const TICK_MS = 30_000;

type JobFilter = 'all' | 'enabled' | 'paused' | 'unconditional';

/** Newest record per job id. */
function latestByJob(
  records: readonly ScheduleRunRecord[],
): Map<string, ScheduleRunRecord> {
  const latest = new Map<string, ScheduleRunRecord>();
  for (const record of records) {
    const current = latest.get(record.jobId);
    if (!current || record.startedAt > current.startedAt) {
      latest.set(record.jobId, record);
    }
  }
  return latest;
}

function matchesFilter(job: ScheduledJob, filter: JobFilter): boolean {
  switch (filter) {
    case 'enabled':
      return job.enabled;
    case 'paused':
      return !job.enabled;
    case 'unconditional':
      return job.condition.kind === 'always';
    case 'all':
    default:
      return true;
  }
}

function matchesSearch(job: ScheduledJob, term: string): boolean {
  if (!term) return true;
  const haystack = [
    job.name,
    job.description,
    job.cron,
    job.humanReadable,
    job.prompt,
  ]
    .join('\n')
    .toLowerCase();
  return haystack.includes(term);
}

export function ScheduleScreen() {
  const navigate = useNavigate();
  const match = useMatch(`${ROUTES.schedule}/:jobId`);
  const selectedId = match?.params.jobId ?? null;

  const now = useNow(TICK_MS);
  const [filter, setFilter] = useState<JobFilter>('all');
  const [search, setSearch] = useState('');
  const [historyFilter, setHistoryFilter] = useState<'all' | ScheduleRunStatus>(
    'all',
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduledJob | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ScheduledJob | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  const jobs = useQuery(
    IPC.schedule.list,
    {},
    { refetchOn: [IPC_PUSH.scheduleChanged] },
  );
  const recent = useQuery(
    IPC.schedule.history,
    { limit: RECENT_HISTORY_LIMIT },
    { refetchOn: [IPC_PUSH.scheduleChanged] },
  );

  const update = useMutation(IPC.schedule.update);
  const remove = useMutation(IPC.schedule.remove);
  const runNow = useMutation(IPC.schedule.runNow);

  const allJobs = useMemo(() => jobs.data ?? [], [jobs.data]);
  const latest = useMemo(
    () => latestByJob(recent.data?.items ?? []),
    [recent.data],
  );

  const term = search.trim().toLowerCase();
  const visible = useMemo(
    () =>
      allJobs
        .filter((job) => matchesFilter(job, filter) && matchesSearch(job, term))
        .sort((a, b) => {
          if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
          const left = a.nextRunAt ?? '￿';
          const right = b.nextRunAt ?? '￿';
          if (left !== right) return left < right ? -1 : 1;
          return a.name.localeCompare(b.name);
        }),
    [allJobs, filter, term],
  );

  const selected = useMemo(
    () => allJobs.find((job) => job.id === selectedId) ?? null,
    [allJobs, selectedId],
  );

  const select = useCallback(
    (id: string) => {
      navigate(
        selectedId === id ? ROUTES.schedule : `${ROUTES.schedule}/${id}`,
      );
    },
    [navigate, selectedId],
  );

  const closeRail = useCallback(() => navigate(ROUTES.schedule), [navigate]);

  /* --- mutations ------------------------------------------------- */

  const setEnabled = useCallback(
    async (job: ScheduledJob, enabled: boolean) => {
      // Optimistic: a toggle that waits on a round trip feels broken.
      jobs.setData((previous) =>
        (previous ?? []).map((entry) =>
          entry.id === job.id ? { ...entry, enabled } : entry,
        ),
      );
      const saved = await update.mutate({ id: job.id, enabled });
      if (!saved) {
        jobs.setData((previous) =>
          (previous ?? []).map((entry) =>
            entry.id === job.id ? { ...entry, enabled: job.enabled } : entry,
          ),
        );
        toast.error(`Could not ${enabled ? 'enable' : 'pause'} “${job.name}”`, {
          description: update.error?.isUnavailable
            ? 'The scheduler is not answering. Nothing was changed.'
            : update.error?.message,
          key: `schedule-toggle-${job.id}`,
        });
        return;
      }
      void jobs.refetch();
    },
    [jobs, update],
  );

  const dispatch = useCallback(
    async (job: ScheduledJob) => {
      setRunningId(job.id);
      const result = await runNow.mutate({ id: job.id, ignoreCondition: true });
      setRunningId(null);

      if (!result) {
        toast.error(`Could not start “${job.name}”`, {
          description: runNow.error?.isUnavailable
            ? 'The scheduler is not answering yet, so nothing was dispatched.'
            : runNow.error?.message,
          key: `schedule-run-${job.id}`,
        });
        return;
      }
      if (result.runId) {
        toast.success(`“${job.name}” dispatched`, {
          description: 'Ignoring the condition, because you asked for it now.',
          action: {
            label: 'Open run',
            onClick: () => navigate(`${ROUTES.runs}/${result.runId}`),
          },
        });
      } else {
        toast.warning(`“${job.name}” did not start`, {
          description: result.skipped ?? 'The scheduler declined to dispatch.',
        });
      }
      void jobs.refetch();
      void recent.refetch();
    },
    [runNow, jobs, recent, navigate],
  );

  const confirmDelete = useCallback(async () => {
    const job = pendingDelete;
    if (!job) return;
    const result = await remove.mutate({ id: job.id });
    setPendingDelete(null);
    if (!result) {
      toast.error(`Could not delete “${job.name}”`, {
        description: remove.error?.isUnavailable
          ? 'The scheduler is not answering. The job is untouched.'
          : remove.error?.message,
      });
      return;
    }
    if (selectedId === job.id) closeRail();
    toast.success(`Deleted “${job.name}”`);
    void jobs.refetch();
  }, [pendingDelete, remove, selectedId, closeRail, jobs]);

  /* --- header ------------------------------------------------------ */

  const enabledCount = allJobs.filter((job) => job.enabled).length;
  const unconditional = allJobs.filter(
    (job) => job.condition.kind === 'always' && job.enabled,
  ).length;
  const nextUp = useMemo(
    () =>
      allJobs
        .filter((job) => job.enabled && job.nextRunAt)
        .sort((a, b) => (a.nextRunAt! < b.nextRunAt! ? -1 : 1))[0],
    [allJobs],
  );

  const description = (() => {
    if (jobs.error)
      return 'Recurring jobs, when they next fire, how they last went.';
    if (allJobs.length === 0) {
      return 'Recurring jobs, when they next fire, how they last went.';
    }
    const parts = [
      `${pluralize(allJobs.length, 'job')}, ${enabledCount} enabled`,
    ];
    if (nextUp?.nextRunAt) {
      parts.push(
        `next: ${nextUp.name} ${formatRelative(nextUp.nextRunAt, now)}`,
      );
    }
    return parts.join(' · ');
  })();

  const tabs: readonly TabItem<JobFilter>[] = [
    { value: 'all', label: 'All', count: allJobs.length },
    { value: 'enabled', label: 'Enabled', count: enabledCount },
    {
      value: 'paused',
      label: 'Paused',
      count: allJobs.length - enabledCount,
    },
    { value: 'unconditional', label: 'Unconditional', count: unconditional },
  ];

  const showTable = allJobs.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Schedule"
        description={description}
        sticky={false}
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              icon={RefreshCw}
              loading={jobs.fetching && !jobs.loading}
              onClick={() => {
                void jobs.refetch();
                void recent.refetch();
              }}
            >
              Refresh
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={CalendarPlus}
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              New job
            </Button>
          </>
        }
        toolbar={
          showTable ? (
            <div className="flex items-center gap-3">
              <Tabs
                items={tabs}
                value={filter}
                onValueChange={setFilter}
                variant="pill"
                label="Filter jobs"
              />
              <div className="flex-1" />
              <Input
                size="sm"
                icon={Search}
                value={search}
                placeholder="Filter by name, cron or prompt"
                aria-label="Filter jobs"
                containerClassName="w-64"
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          ) : null
        }
      />

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto">
          {jobs.error ? (
            <div className="p-5">
              <BridgeNotice
                error={jobs.error}
                subject="the scheduled jobs"
                actions={
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      icon={RefreshCw}
                      onClick={() => {
                        void jobs.refetch();
                      }}
                    >
                      Try again
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={CalendarPlus}
                      onClick={() => {
                        setEditing(null);
                        setDialogOpen(true);
                      }}
                    >
                      Draft a job anyway
                    </Button>
                  </>
                }
              />
            </div>
          ) : null}

          {!jobs.error && jobs.loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-zinc-500">
              <Spinner size="sm" label={null} />
              Loading scheduled jobs…
            </div>
          ) : null}

          {!jobs.error && !jobs.loading && !showTable ? (
            <EmptyState
              icon={CalendarClock}
              title="Nothing is scheduled"
              description="A scheduled job fires on a cron expression, checks one deterministic condition, and only then spawns the engine. You can create one here; the assistant can also create one for you when you ask it to check something regularly."
              action={
                <Button
                  variant="primary"
                  icon={CalendarPlus}
                  onClick={() => {
                    setEditing(null);
                    setDialogOpen(true);
                  }}
                >
                  Create the first job
                </Button>
              }
              footer="Schedules are written as cron and echoed back in English before they are saved."
            />
          ) : null}

          {showTable ? (
            <Table density="compact" className="min-w-[62rem]">
              <TableHead sticky>
                <TableRow>
                  <TableHeaderCell>Job</TableHeaderCell>
                  <TableHeaderCell width="15rem">Schedule</TableHeaderCell>
                  <TableHeaderCell width="11rem">Only when</TableHeaderCell>
                  <TableHeaderCell width="9rem">Next run</TableHeaderCell>
                  <TableHeaderCell width="9rem">Last run</TableHeaderCell>
                  <TableHeaderCell>Last outcome</TableHeaderCell>
                  <TableHeaderCell width="4.5rem" align="center">
                    On
                  </TableHeaderCell>
                  <TableHeaderCell width="7rem" align="right">
                    Actions
                  </TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {visible.length === 0 ? (
                  <TableEmptyRow colSpan={8}>
                    <EmptyState
                      size="sm"
                      icon={Search}
                      title="No jobs match"
                      description="Clear the filter or the search box to see the rest."
                      action={
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setFilter('all');
                            setSearch('');
                          }}
                        >
                          Clear filters
                        </Button>
                      }
                    />
                  </TableEmptyRow>
                ) : (
                  visible.map((job) => (
                    <JobRow
                      key={job.id}
                      job={job}
                      last={latest.get(job.id)}
                      now={now}
                      selected={job.id === selectedId}
                      running={runningId === job.id}
                      onSelect={() => select(job.id)}
                      onToggle={(enabled) => {
                        void setEnabled(job, enabled);
                      }}
                      onRunNow={() => {
                        void dispatch(job);
                      }}
                      onEdit={() => {
                        setEditing(job);
                        setDialogOpen(true);
                      }}
                      onDelete={() => setPendingDelete(job)}
                    />
                  ))
                )}
              </TableBody>
            </Table>
          ) : null}

          {showTable && recent.error ? (
            <p className={cn('px-5 py-3 text-[11.5px]', textMuted)}>
              Run history is unavailable ({recent.error.code}), so the last
              outcome column is empty. The jobs themselves are current.
            </p>
          ) : null}
        </div>

        {selected ? (
          <HistoryPanel
            job={selected}
            filter={historyFilter}
            onFilterChange={setHistoryFilter}
            onClose={closeRail}
            onEdit={() => {
              setEditing(selected);
              setDialogOpen(true);
            }}
            onDelete={() => setPendingDelete(selected)}
            onRunNow={() => {
              void dispatch(selected);
            }}
            runNowPending={runningId === selected.id}
            onOpenRun={(runId) => navigate(`${ROUTES.runs}/${runId}`)}
            className="w-[26rem] shrink-0"
          />
        ) : null}
      </div>

      <JobDialog
        open={dialogOpen}
        job={editing}
        onClose={() => setDialogOpen(false)}
        onSaved={(job) => {
          setDialogOpen(false);
          setEditing(null);
          toast.success(
            editing ? `Saved “${job.name}”` : `Created “${job.name}”`,
          );
          void jobs.refetch();
        }}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        tone="danger"
        title={`Delete “${pendingDelete?.name ?? ''}”?`}
        description="The job and its evaluation history are removed. Runs it already started are kept."
        confirmLabel="Delete job"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => confirmDelete()}
      >
        {pendingDelete ? (
          <p className={cn('text-[12px]', textMuted)}>
            {pendingDelete.humanReadable || pendingDelete.cron} ·{' '}
            {MISSED_RUN_POLICY_LABEL[pendingDelete.missedRunPolicy]}
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One row                                                             */
/* ------------------------------------------------------------------ */

interface JobRowProps {
  job: ScheduledJob;
  last: ScheduleRunRecord | undefined;
  now: number;
  selected: boolean;
  running: boolean;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
  onRunNow: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function JobRow({
  job,
  last,
  now,
  selected,
  running,
  onSelect,
  onToggle,
  onRunNow,
  onEdit,
  onDelete,
}: JobRowProps) {
  const statusMeta = job.lastStatus ? runStatusMeta(job.lastStatus) : null;
  const preview = job.lastSkipReason || lastOutputPreview(last);

  return (
    <TableRow
      interactive
      selected={selected}
      onClick={onSelect}
      className={cn(!job.enabled && 'opacity-60')}
    >
      {/* name */}
      <TableCell className="max-w-[18rem]">
        <span className="block truncate text-[13px] font-medium text-zinc-900 dark:text-zinc-100">
          {job.name}
        </span>
        {job.description ? (
          <span className={cn('block truncate text-[11px]', textMuted)}>
            {job.description}
          </span>
        ) : null}
      </TableCell>

      {/* schedule, in English */}
      <TableCell>
        <span className="block truncate text-[12.5px] text-zinc-700 dark:text-zinc-300">
          {job.humanReadable || job.cron}
        </span>
        <span className={cn('block truncate text-[11px]', mono, textMuted)}>
          {job.cron}
          {job.timezone && job.timezone !== 'UTC' ? ` · ${job.timezone}` : ''}
        </span>
      </TableCell>

      {/* the gate */}
      <TableCell>
        <ConditionChip condition={job.condition} />
        <span className={cn('mt-0.5 block text-[10.5px]', textMuted)}>
          if missed: {MISSED_RUN_POLICY_WORD[job.missedRunPolicy]}
        </span>
      </TableCell>

      {/* next run */}
      <TableCell nowrap>
        {job.enabled && job.nextRunAt ? (
          <>
            <span
              className="block text-[12.5px] text-zinc-700 dark:text-zinc-300"
              title={formatDateTime(job.nextRunAt)}
            >
              {formatRelative(job.nextRunAt, now)}
            </span>
            <span className={cn('block text-[11px] tabular-nums', textMuted)}>
              {formatDateTime(job.nextRunAt)}
            </span>
          </>
        ) : (
          <span className={cn('text-[12px]', textMuted)}>
            {job.enabled ? 'Not scheduled' : 'Paused'}
          </span>
        )}
      </TableCell>

      {/* last run */}
      <TableCell nowrap>
        {statusMeta ? (
          <>
            <Badge tone={statusMeta.tone} dot>
              {statusMeta.label}
            </Badge>
            <span className={cn('mt-0.5 block text-[11px]', textMuted)}>
              {formatRelative(job.lastRunAt, now)}
            </span>
          </>
        ) : (
          <span className={cn('text-[12px]', textMuted)}>Never run</span>
        )}
      </TableCell>

      {/* last outcome */}
      <TableCell className="max-w-[20rem]">
        {preview ? (
          <span
            className="block text-[12px] leading-snug text-zinc-600 dark:text-zinc-400"
            title={preview}
          >
            {truncate(preview, 90)}
          </span>
        ) : (
          <span className={cn('text-[12px]', textMuted)}>—</span>
        )}
      </TableCell>

      {/* enabled */}
      <TableCell align="center">
        <span
          className="inline-flex"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          role="presentation"
        >
          <Switch
            size="sm"
            checked={job.enabled}
            onChange={onToggle}
            aria-label={`${job.enabled ? 'Pause' : 'Enable'} ${job.name}`}
          />
        </span>
      </TableCell>

      {/* actions */}
      <TableCell align="right">
        <span
          className="inline-flex items-center gap-0.5"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          role="presentation"
        >
          <Tooltip content="Run now — ignores the condition">
            <Button
              size="icon-sm"
              variant="ghost"
              icon={Play}
              loading={running}
              aria-label={`Run ${job.name} now`}
              onClick={onRunNow}
            />
          </Tooltip>
          <Tooltip content="Edit">
            <Button
              size="icon-sm"
              variant="ghost"
              icon={Pencil}
              aria-label={`Edit ${job.name}`}
              onClick={onEdit}
            />
          </Tooltip>
          <Tooltip content="Delete">
            <Button
              size="icon-sm"
              variant="ghost"
              icon={Trash2}
              aria-label={`Delete ${job.name}`}
              className="text-zinc-400 hover:text-rose-600 dark:hover:text-rose-400"
              onClick={onDelete}
            />
          </Tooltip>
        </span>
      </TableCell>
    </TableRow>
  );
}

export default ScheduleScreen;
