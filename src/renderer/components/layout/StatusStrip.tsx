import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Hourglass, X, XCircle } from 'lucide-react';
import { cn } from '../../lib/utils';
import { formatDuration, pluralize, truncate } from '../../lib/format';
import { useNow } from '../../hooks/useNow';
import { ROUTES } from '../../routes';
import { Spinner } from '../ui/Spinner';
import { StatusDot } from '../ui/Badge';
import { Tooltip } from '../ui/Tooltip';
import { focusRing } from '../ui/styles';
import {
  useEnvironmentWarnings,
  useFailedRuns,
  useLiveRuns,
  usePendingApprovalCount,
  useWaitingRuns,
} from '../../store';

function Segment({
  onClick,
  tone,
  children,
  title,
}: {
  onClick?: () => void;
  tone?: 'warning' | 'danger';
  children: React.ReactNode;
  title?: string;
}) {
  const classes = cn(
    'inline-flex h-6 items-center gap-1.5 rounded px-1.5 text-[11.5px] transition-colors',
    tone === 'warning' && 'text-amber-700 dark:text-amber-400',
    tone === 'danger' && 'text-rose-700 dark:text-rose-400',
    !tone && 'text-zinc-600 dark:text-zinc-400',
    onClick && 'hover:bg-zinc-100 dark:hover:bg-zinc-800',
    onClick && focusRing,
  );

  if (!onClick) {
    return (
      <span className={classes} title={title}>
        {children}
      </span>
    );
  }
  return (
    <button type="button" onClick={onClick} className={classes} title={title}>
      {children}
    </button>
  );
}

/**
 * The live status strip.
 *
 * Answers the three questions the user actually has when they look at this app:
 * what is running, what is waiting on me, what broke. Always visible, one line,
 * every part clickable through to the thing it names.
 *
 * Deliberately quiet when idle — a strip that shouts at rest teaches people to
 * stop reading it.
 */
export function StatusStrip() {
  const navigate = useNavigate();
  const live = useLiveRuns();
  const waiting = useWaitingRuns();
  const failed = useFailedRuns(5);
  const pendingApprovals = usePendingApprovalCount();

  const active = live.filter((run) => run.status !== 'awaiting_approval');
  const now = useNow(1000, active.length > 0);
  const head = active[0];

  const elapsed = head?.startedAt
    ? formatDuration(now - new Date(head.startedAt).getTime())
    : null;

  return (
    <div
      className="draggable-region flex h-9 shrink-0 items-center gap-1 border-b border-zinc-200/60 px-2 dark:border-zinc-800/60"
      role="status"
      aria-live="polite"
      aria-label="Activity"
    >
      {head ? (
        <Segment
          onClick={() => navigate(`${ROUTES.runs}/${head.id}`)}
          title={head.title}
        >
          <Spinner size="xs" label={null} className="text-sky-500" />
          <span className="font-medium text-zinc-800 dark:text-zinc-200">
            {truncate(head.title, 52)}
          </span>
          {elapsed ? (
            <span className="tabular-nums text-zinc-400 dark:text-zinc-500">
              {elapsed}
            </span>
          ) : null}
          {active.length > 1 ? (
            <span className="text-zinc-400 dark:text-zinc-500">
              +{active.length - 1} more
            </span>
          ) : null}
        </Segment>
      ) : (
        <Segment>
          <StatusDot tone="neutral" label={null} />
          <span>Idle</span>
        </Segment>
      )}

      <div className="flex-1" />

      {pendingApprovals > 0 || waiting.length > 0 ? (
        <Segment tone="warning" onClick={() => navigate(ROUTES.approvals)}>
          <Hourglass size={12} aria-hidden="true" />
          <span className="font-medium">
            {pendingApprovals > 0
              ? `${pluralize(pendingApprovals, 'action')} waiting on you`
              : `${pluralize(waiting.length, 'run')} paused`}
          </span>
        </Segment>
      ) : null}

      {failed.length > 0 ? (
        <Tooltip
          side="bottom"
          content={failed
            .slice(0, 3)
            .map((run) => run.title)
            .join(' · ')}
        >
          <Segment tone="danger" onClick={() => navigate(ROUTES.runs)}>
            <XCircle size={12} aria-hidden="true" />
            <span className="font-medium">
              {pluralize(failed.length, 'run')} failed
            </span>
          </Segment>
        </Tooltip>
      ) : null}
    </div>
  );
}

/**
 * Environment problems that change what the app can do — a missing CLI, a
 * stray `ANTHROPIC_API_KEY`. Loud on purpose: the API-key case silently spends
 * money, so it is not a toast that disappears.
 */
export function EnvironmentBanner() {
  const warnings = useEnvironmentWarnings();
  const [dismissed, setDismissed] = useState<string[]>([]);
  const visible = warnings.filter((warning) => !dismissed.includes(warning));

  if (visible.length === 0) return null;

  return (
    <div className="shrink-0 border-b border-amber-200 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/10">
      {visible.map((warning) => (
        <div
          key={warning}
          className="flex items-start gap-2 px-3 py-1.5 text-[11.5px] leading-relaxed text-amber-900 dark:text-amber-200"
        >
          <AlertTriangle
            size={13}
            aria-hidden="true"
            className="mt-px shrink-0 text-amber-600 dark:text-amber-400"
          />
          <span className="flex-1">{warning}</span>
          <button
            type="button"
            aria-label="Dismiss warning"
            onClick={() => setDismissed((list) => [...list, warning])}
            className={cn(
              'shrink-0 rounded p-0.5 text-amber-700/70 hover:bg-amber-100 hover:text-amber-900 dark:text-amber-300/70 dark:hover:bg-amber-500/20',
              focusRing,
            )}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}

export default StatusStrip;
