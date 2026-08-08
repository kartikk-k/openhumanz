/**
 * Decision history — the durable one.
 *
 * `approvals_audit` records every decision with the full arguments it was made
 * about, including the ones a standing grant made on the user's behalf, and
 * `approvals:list-audit` reads it. That log is the trust feature: the answer to
 * "what has this thing actually been allowed to do", available after a restart
 * and not only for the window that happened to be open at the time.
 *
 * The read is renderer-only by design. There is no MCP tool over the audit log
 * — it is the user's record *of* the agent, and the agent has no business
 * reading it.
 *
 * When the channel cannot be reached the panel does **not** fall silent and it
 * does not print an empty list. It says the durable log is unknown, and then
 * shows the one thing this window can legitimately vouch for: the decisions it
 * watched being made, from `decisionLog.ts`. An empty history and an unreadable
 * history are opposite facts and this screen never renders them the same way.
 */
import { useCallback, useMemo, useState } from 'react';
import { History, Info, RotateCcw, Trash2 } from 'lucide-react';
import { IPC, IPC_PUSH } from '../../../shared/ipc';
import type {
  ApprovalAuditEntry,
  ApprovalDecision,
  ApprovalScope,
} from '../../../shared/approvals';
import type { JsonObject } from '../../../shared/common';
import { cn } from '../../lib/utils';
import { useQuery } from '../../lib/ipc';
import { formatDateTime, formatRelative, pluralize } from '../../lib/format';
import { APPROVAL_SCOPE_LABEL, approvalStatusMeta } from '../../lib/status';
import {
  Badge,
  Button,
  CodeBlock,
  CollapsibleSection,
  EmptyState,
  Select,
  Spinner,
  Tabs,
  eyebrow,
  mono,
  textMuted,
} from '../../components/ui';
import { ChannelNotice, NoticePanel, usePrettyJson } from './parts';
import { useDecisionLog, type DecisionRecord } from './decisionLog';

/** One screenful. The log is append-only and gets long. */
const PAGE_SIZE = 25;

type DecisionFilter = 'all' | ApprovalDecision;
type RangeKey = 'all' | '24h' | '7d' | '30d';

const RANGE_OPTIONS: readonly { value: RangeKey; label: string }[] = [
  { value: 'all', label: 'All time' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
];

const RANGE_MS: Record<Exclude<RangeKey, 'all'>, number> = {
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
  '30d': 30 * 24 * 60 * 60_000,
};

/**
 * The `since` bound for a window, resolved once when the user picks it rather
 * than on every render — a bound that moves each render is a request key that
 * changes each render, which is a refetch loop.
 */
function sinceFor(range: RangeKey): string | undefined {
  if (range === 'all') return undefined;
  return new Date(Date.now() - RANGE_MS[range]).toISOString();
}

/**
 * Who decided, in the user's words.
 *
 * `decided_by` is machine text — `user`, `grant:<id>`, `system:ttl` — and the
 * two `system:` values matter most: they are refusals nobody pressed a button
 * for, and reading them as "denied by you" would be a small lie about the
 * user's own record.
 */
function decidedByLabel(decidedBy: string): string {
  if (decidedBy === 'user' || decidedBy === 'you') return 'You';
  if (decidedBy.startsWith('grant:')) return 'A standing grant you gave';
  if (decidedBy === 'system:ttl') return 'Nobody — it expired unanswered';
  if (decidedBy === 'system:run-ended') return 'Nobody — the run ended first';
  return decidedBy;
}

/**
 * What a row shows, whichever source it came from.
 *
 * The audit row is the authority and carries no title or summary — those are
 * properties of the card, not of the decision — so the tool name is the
 * heading there. Normalising both sources through one shape keeps the fallback
 * looking like the real thing instead of like a second, lesser screen.
 */
interface HistoryRow {
  key: string;
  toolName: string;
  heading: string;
  summary?: string;
  reason?: string;
  toolArguments: JsonObject;
  decision: ApprovalDecision;
  scope: ApprovalScope;
  decidedBy: string;
  runId: string;
  at: string;
}

function rowFromAudit(entry: ApprovalAuditEntry): HistoryRow {
  return {
    key: entry.id,
    toolName: entry.toolName,
    heading: entry.toolName,
    toolArguments: entry.toolArguments,
    decision: entry.decision,
    scope: entry.scope,
    decidedBy: entry.decidedBy,
    runId: entry.runId,
    at: entry.at,
  };
}

function rowFromSession(entry: DecisionRecord): HistoryRow {
  return {
    key: entry.id,
    toolName: entry.toolName,
    heading: entry.title || entry.toolName,
    summary: entry.summary,
    reason: entry.reason,
    toolArguments: entry.toolArguments,
    decision: entry.decision,
    scope: entry.scope,
    decidedBy: entry.decidedBy,
    runId: entry.runId,
    at: entry.at,
  };
}

export interface HistoryPanelProps {
  now: number;
  className?: string;
}

export function HistoryPanel({ now, className }: HistoryPanelProps) {
  const sessionEntries = useDecisionLog((state) => state.entries);
  const clearSession = useDecisionLog((state) => state.clear);

  const [decision, setDecision] = useState<DecisionFilter>('all');
  const [range, setRange] = useState<RangeKey>('all');
  const [since, setSince] = useState<string | undefined>(undefined);
  const [offset, setOffset] = useState(0);

  const request = useMemo(
    () => ({
      limit: PAGE_SIZE,
      offset,
      decision: decision === 'all' ? undefined : decision,
      since,
    }),
    [decision, since, offset],
  );

  const audit = useQuery(IPC.approvals.listAudit, request, {
    refetchOn: [IPC_PUSH.approvalResolved],
  });

  const changeDecision = useCallback((next: DecisionFilter) => {
    setDecision(next);
    setOffset(0);
  }, []);

  const changeRange = useCallback((next: RangeKey) => {
    setRange(next);
    setSince(sinceFor(next));
    setOffset(0);
  }, []);

  const refetch = audit.refetch;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);

  const page = audit.data;
  const rows = useMemo(
    () => (page ? page.items.map(rowFromAudit) : []),
    [page],
  );
  const sessionRows = useMemo(
    () => sessionEntries.map(rowFromSession),
    [sessionEntries],
  );

  const filtered = decision !== 'all' || range !== 'all';

  /* The log has never answered. A spinner, not an empty state — see below. */
  if (audit.loading) {
    return (
      <div
        className={cn(
          'flex items-center justify-center gap-2 py-16 text-[13px]',
          textMuted,
          className,
        )}
      >
        <Spinner size="sm" label={null} />
        Reading the decision log…
      </div>
    );
  }

  /*
   * The read failed and there is nothing to show from it. This is the case the
   * whole panel is shaped around: "no decisions" and "cannot see the
   * decisions" are opposite claims, and only one of them may be printed here.
   */
  if (!page) {
    return (
      <div className={cn('space-y-3', className)}>
        <ChannelNotice
          message={audit.error?.message ?? 'The audit channel did not answer.'}
          unavailable={audit.error?.isUnavailable ?? false}
          what="your decision history"
          onRetry={retry}
        />
        <SessionFallback rows={sessionRows} now={now} onClear={clearSession} />
      </div>
    );
  }

  const first = page.total === 0 ? 0 : page.offset + 1;
  const last = page.offset + page.items.length;
  const hasPaging = page.total > page.items.length;

  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={cn('max-w-xl text-xs leading-relaxed', textMuted)}>
          Every decision ever made about a side-effecting call, with the exact
          arguments it was made about — including the calls a standing grant
          answered for you. Written when the decision happens and never edited.
        </p>
        <Button
          size="xs"
          variant="ghost"
          icon={RotateCcw}
          onClick={retry}
          loading={audit.fetching}
        >
          Refresh
        </Button>
      </div>

      {/* A refetch that failed while older rows are still on screen. Say so
          above them rather than replacing them with an error. */}
      {audit.error ? (
        <ChannelNotice
          message={audit.error.message}
          unavailable={audit.error.isUnavailable}
          what="the newest decisions"
          onRetry={retry}
        />
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs
          variant="pill"
          label="Decision"
          value={decision}
          onValueChange={changeDecision}
          items={[
            { value: 'all', label: 'All' },
            { value: 'approve', label: 'Approved' },
            { value: 'deny', label: 'Denied' },
          ]}
        />
        <Select
          size="sm"
          aria-label="Time range"
          value={range}
          options={RANGE_OPTIONS}
          onChange={(event) => changeRange(event.target.value as RangeKey)}
        />
      </div>

      {page.items.length === 0 ? (
        <EmptyState
          icon={History}
          size="sm"
          title={
            filtered
              ? 'No decisions match this filter'
              : 'Nothing has been decided yet'
          }
          description={
            filtered
              ? 'Widen the time range, or switch back to all decisions.'
              : 'The log is empty — no side-effecting call has been approved or denied on this machine. Answer something in the queue and it is recorded here, permanently, with the arguments it was answered about.'
          }
        />
      ) : (
        <>
          <p className={eyebrow}>
            {hasPaging
              ? `Showing ${first}–${last} of ${pluralize(page.total, 'decision')}`
              : pluralize(page.total, 'decision')}
          </p>

          <div className="space-y-1.5">
            {rows.map((row) => (
              <HistoryEntry key={row.key} row={row} now={now} />
            ))}
          </div>

          {hasPaging ? (
            <div className="flex items-center justify-between gap-2">
              <Button
                size="xs"
                variant="outline"
                disabled={page.offset === 0}
                onClick={() => setOffset(Math.max(0, page.offset - PAGE_SIZE))}
              >
                Newer
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={last >= page.total}
                onClick={() => setOffset(page.offset + PAGE_SIZE)}
              >
                Older
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * What this window watched happen, shown only when the durable log could not
 * be read. Labelled as partial, because a history surface that quietly omits
 * yesterday's decisions is worse than none: it looks complete.
 */
function SessionFallback({
  rows,
  now,
  onClear,
}: {
  rows: HistoryRow[];
  now: number;
  onClear: () => void;
}) {
  if (rows.length === 0) return null;

  return (
    <>
      <NoticePanel
        tone="info"
        icon={Info}
        eyebrow="Partial view"
        title="Meanwhile: the decisions this window watched you make"
        detail={`${IPC.approvals.listAudit} · unreachable`}
      >
        These are held in memory by this window only. They are already in the
        durable log in main — this list is not a second record, it is the part
        of the record this window can still vouch for while the channel is down.
        It starts empty every time the app restarts.
      </NoticePanel>

      <div className="flex items-center justify-between gap-2">
        <p className={eyebrow}>
          {pluralize(rows.length, 'decision')} this session
        </p>
        <Button size="xs" variant="ghost" icon={Trash2} onClick={onClear}>
          Clear
        </Button>
      </div>

      <div className="space-y-1.5">
        {rows.map((row) => (
          <HistoryEntry key={row.key} row={row} now={now} />
        ))}
      </div>
    </>
  );
}

function HistoryEntry({ row, now }: { row: HistoryRow; now: number }) {
  const [open, setOpen] = useState(false);
  const args = usePrettyJson(row.toolArguments);
  const meta = approvalStatusMeta(
    row.decision === 'approve' ? 'approved' : 'denied',
  );
  const onOpenChange = useCallback((next: boolean) => setOpen(next), []);

  return (
    <CollapsibleSection
      density="compact"
      open={open}
      onOpenChange={onOpenChange}
      title={row.heading}
      subtitle={
        row.heading === row.toolName ? null : (
          <span className={mono}>{row.toolName}</span>
        )
      }
      meta={
        <>
          <Badge tone={meta.tone} icon={meta.icon}>
            {meta.label}
          </Badge>
          {row.decision === 'approve' ? (
            <span className={textMuted}>{APPROVAL_SCOPE_LABEL[row.scope]}</span>
          ) : null}
          <span title={formatDateTime(row.at)}>
            {formatRelative(row.at, now)}
          </span>
        </>
      }
    >
      <div className="space-y-2">
        {row.summary ? (
          <p className="text-[13px] leading-relaxed text-zinc-700 dark:text-zinc-300">
            {row.summary}
          </p>
        ) : null}
        {row.reason ? (
          <p className={cn('text-xs italic', textMuted)}>
            Reason given: “{row.reason}”
          </p>
        ) : null}
        <CodeBlock code={args} language="json" maxHeight="16rem" />
        <p
          className={cn(
            'flex flex-wrap gap-x-3 gap-y-1 text-[11px]',
            textMuted,
          )}
        >
          <span>
            <span className={eyebrow}>Decided by</span>{' '}
            <span title={row.decidedBy}>{decidedByLabel(row.decidedBy)}</span>
          </span>
          <span>
            <span className={eyebrow}>Scope</span>{' '}
            {APPROVAL_SCOPE_LABEL[row.scope]}
          </span>
          <span>
            <span className={eyebrow}>Run</span>{' '}
            <span className={mono} title={row.runId}>
              {row.runId.slice(0, 12)}
            </span>
          </span>
          <span>
            <span className={eyebrow}>At</span> {formatDateTime(row.at)}
          </span>
        </p>
      </div>
    </CollapsibleSection>
  );
}

export default HistoryPanel;
