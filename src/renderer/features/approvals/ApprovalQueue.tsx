/**
 * The pending queue: the cards, the keyboard, and the two dialogs.
 *
 * Everything that decides *what a press means* lives here rather than in the
 * card, so the mouse path and the keyboard path are literally the same code.
 * A shortcut cannot skip the `always` confirmation because there is only one
 * place that opens it.
 *
 * Three rules the queue exists to enforce:
 *
 *  - **Selection is by id, never by index.** Approvals arrive by push while the
 *    screen is open. If selection were an index, a new arrival could slide a
 *    different card under the highlight between reading it and pressing a key.
 *  - **One decision per approval.** `resolve()` in the store is optimistic: it
 *    removes the card synchronously, so a second press finds nothing. The local
 *    in-flight set closes the remaining gap, the one where a dialog is open.
 *  - **An unreadable queue is not an empty queue.** When the channel fails we
 *    say so. "Nothing is waiting on you" is only ever printed when we actually
 *    looked.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Inbox, Keyboard, ShieldCheck } from 'lucide-react';
import type { Approval, ApprovalScope } from '../../../shared/approvals';
import { cn } from '../../lib/utils';
import { pluralize } from '../../lib/format';
import { APPROVAL_SCOPE_LABEL } from '../../lib/status';
import {
  Badge,
  ConfirmDialog,
  EmptyState,
  Spinner,
  Textarea,
  eyebrow,
  mono,
  textMuted,
} from '../../components/ui';
import { toast, useApprovalsStore, useSettingsStore } from '../../store';
import { ApprovalCard, defaultExpanded } from './ApprovalCard';
import { ChannelNotice } from './parts';
import {
  DENY_COPY,
  QUEUE_SHORTCUTS,
  alwaysGrantCoverage,
  approveScopeCopy,
} from './copy';
import { decisionFrom, useDecisionLog } from './decisionLog';
import { riskSignal } from './risk';

/** Keys that reach the queue only when the user is not typing into something. */
function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || !element.tagName) return false;
  const tag = element.tagName.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return element.isContentEditable === true;
}

/** Enter and Space belong to a focused control, not to the queue. */
function isActivatable(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || !element.tagName) return false;
  const tag = element.tagName.toUpperCase();
  if (tag === 'BUTTON' || tag === 'A') return true;
  return element.getAttribute('role') === 'button';
}

export interface ApprovalQueueProps {
  /** Ticking clock, shared with the rest of the screen. */
  now: number;
  onOpenRun?: (runId: string) => void;
  /** Navigate to the grants tab — offered after an `always` grant is made. */
  onShowGrants?: () => void;
  className?: string;
}

export function ApprovalQueue({
  now,
  onOpenRun,
  onShowGrants,
  className,
}: ApprovalQueueProps) {
  const pending = useApprovalsStore((state) => state.pending);
  const resolving = useApprovalsStore((state) => state.resolving);
  const status = useApprovalsStore((state) => state.status);
  const error = useApprovalsStore((state) => state.error);
  const unavailable = useApprovalsStore((state) => state.unavailable);
  const load = useApprovalsStore((state) => state.load);
  const resolve = useApprovalsStore((state) => state.resolve);

  const approvalSettings = useSettingsStore((state) => state.settings.approvals);
  const allowAlways = approvalSettings.allowAlwaysScope;
  const defaultScope = approvalSettings.defaultScope;

  const record = useDecisionLog((state) => state.record);

  const listRef = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});

  /** Approvals with a decision in flight, including one sitting in a dialog. */
  const inFlight = useRef<Set<string>>(new Set());

  const [confirmScope, setConfirmScope] = useState<{
    approval: Approval;
    scope: ApprovalScope;
  } | null>(null);
  const [denyTarget, setDenyTarget] = useState<Approval | null>(null);
  const [denyReason, setDenyReason] = useState('');

  const dialogOpen = confirmScope !== null || denyTarget !== null;

  // Selection resolves through the list every render: an id that has left the
  // queue falls back to the head, which is where the eye already is.
  const selectedIndex = useMemo(() => {
    const index = pending.findIndex((item) => item.id === selectedId);
    return index >= 0 ? index : 0;
  }, [pending, selectedId]);
  const selected: Approval | undefined = pending[selectedIndex];

  const isExpanded = useCallback(
    (approval: Approval) =>
      expandedIds[approval.id] ?? defaultExpanded(approval),
    [expandedIds],
  );

  const setExpanded = useCallback((id: string, open: boolean) => {
    setExpandedIds((previous) => ({ ...previous, [id]: open }));
  }, []);

  /* ---------------------------------------------------------------- */
  /* Committing a decision                                             */
  /* ---------------------------------------------------------------- */

  const commit = useCallback(
    async (
      approval: Approval,
      decision: 'approve' | 'deny',
      scope: ApprovalScope,
      reason?: string,
    ): Promise<void> => {
      if (inFlight.current.has(approval.id)) return;
      inFlight.current.add(approval.id);

      // Built before the call: the store drops the card optimistically, and the
      // arguments — the whole point of an audit row — go with it.
      const entry = decisionFrom(approval, decision, scope, reason);

      try {
        const ok = await resolve({
          approvalId: approval.id,
          decision,
          scope,
          reason: reason?.trim() ? reason.trim() : undefined,
        });

        if (!ok) {
          toast.error('That decision did not reach the approval gate', {
            key: `approval-failed-${approval.id}`,
            description: `${approval.title} is back in the queue, still waiting. Nothing ran.`,
          });
          return;
        }

        record(entry);

        if (decision === 'approve' && scope === 'always') {
          toast.success(`Standing grant created for ${approval.toolName}`, {
            key: `grant-${approval.fingerprint}`,
            description: alwaysGrantCoverage(approval.toolName),
            action: onShowGrants
              ? { label: 'Manage grants', onClick: onShowGrants }
              : undefined,
          });
        }
      } finally {
        inFlight.current.delete(approval.id);
      }
    },
    [resolve, record, onShowGrants],
  );

  /**
   * A press on one of the three approve buttons.
   *
   * `once` and `run` land immediately — they are bounded, and a dialog in front
   * of the common case is how a gate gets clicked through without reading.
   * `always` outlives the run, so it takes an explicit second beat.
   */
  const requestApprove = useCallback(
    (approval: Approval, scope: ApprovalScope) => {
      if (inFlight.current.has(approval.id)) return;
      if (scope === 'always') {
        setConfirmScope({ approval, scope });
        return;
      }
      void commit(approval, 'approve', scope);
    },
    [commit],
  );

  const requestDeny = useCallback((approval: Approval) => {
    if (inFlight.current.has(approval.id)) return;
    setDenyReason('');
    setDenyTarget(approval);
  }, []);

  /* ---------------------------------------------------------------- */
  /* Keyboard                                                          */
  /* ---------------------------------------------------------------- */

  const move = useCallback(
    (delta: number) => {
      if (pending.length === 0) return;
      const next = Math.min(
        pending.length - 1,
        Math.max(0, selectedIndex + delta),
      );
      setSelectedId(pending[next].id);
    },
    [pending, selectedIndex],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // A dialog owns the keyboard while it is up, and it is the one place a
      // consequential decision is confirmed.
      if (dialogOpen) return;
      if (isTypingTarget(event.target)) return;

      const current = pending[selectedIndex];

      switch (event.key) {
        case 'ArrowDown':
        case 'j':
          event.preventDefault();
          move(1);
          return;
        case 'ArrowUp':
        case 'k':
          event.preventDefault();
          move(-1);
          return;
        default:
          break;
      }

      if (!current) return;

      if (event.key === 'Enter' || event.key === ' ') {
        // A focused button already means something by Enter. Never both.
        if (isActivatable(event.target)) return;
        event.preventDefault();
        setExpanded(current.id, !isExpanded(current));
        return;
      }

      const key = event.key.toLowerCase();
      if (key === 'a') {
        event.preventDefault();
        requestApprove(current, 'once');
      } else if (key === 'r') {
        event.preventDefault();
        requestApprove(current, 'run');
      } else if (key === 'l' && allowAlways) {
        event.preventDefault();
        requestApprove(current, 'always');
      } else if (key === 'd') {
        event.preventDefault();
        requestDeny(current);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    dialogOpen,
    pending,
    selectedIndex,
    move,
    isExpanded,
    setExpanded,
    requestApprove,
    requestDeny,
    allowAlways,
  ]);

  // Keep the highlighted card on screen when the arrows walk past the fold.
  const selectedCardId = selected?.id;
  useEffect(() => {
    if (!selectedCardId) return;
    const escaped =
      typeof CSS !== 'undefined' && CSS.escape
        ? CSS.escape(selectedCardId)
        : selectedCardId;
    const node = listRef.current?.querySelector<HTMLElement>(
      `[data-approval-id="${escaped}"]`,
    );
    node?.scrollIntoView({ block: 'nearest' });
  }, [selectedCardId]);

  /* ---------------------------------------------------------------- */
  /* States                                                            */
  /* ---------------------------------------------------------------- */

  if (pending.length === 0) {
    if (status === 'loading') {
      return (
        <div
          className={cn(
            'flex items-center justify-center gap-2 py-16 text-[13px]',
            textMuted,
            className,
          )}
        >
          <Spinner size="sm" label={null} />
          Reading the approval queue…
        </div>
      );
    }

    if (error) {
      return (
        <ChannelNotice
          className={className}
          message={error}
          unavailable={unavailable}
          what="the approval queue"
          onRetry={() => {
            void load();
          }}
        />
      );
    }

    return (
      <EmptyState
        className={className}
        icon={Inbox}
        title="Nothing is waiting on you"
        description="When the assistant tries to do something with a side effect — send a message, change a calendar, write a file outside the vault — it stops here and asks first. Until then this stays empty."
        footer={
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck size={12} aria-hidden="true" />
            The gate is on: nothing side-effecting runs without a decision.
          </span>
        }
      />
    );
  }

  const confirmCopy = confirmScope
    ? approveScopeCopy(confirmScope.scope)
    : null;
  const confirmRisk = confirmScope ? riskSignal(confirmScope.approval) : null;

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-zinc-700 dark:text-zinc-300">
          <span className="font-medium">
            {pluralize(pending.length, 'action')}
          </span>{' '}
          <span className={textMuted}>waiting on you · oldest first</span>
        </p>
        <p
          className={cn(
            'inline-flex items-center gap-1.5 text-[11px]',
            textMuted,
          )}
        >
          <Keyboard size={12} aria-hidden="true" />
          {QUEUE_SHORTCUTS}
        </p>
      </div>

      {error ? (
        <ChannelNotice
          className="mb-3"
          message={error}
          unavailable={unavailable}
          what="the approval queue"
          onRetry={() => {
            void load();
          }}
        />
      ) : null}

      <div ref={listRef} className="space-y-3">
        {pending.map((approval) => (
          <ApprovalCard
            key={approval.id}
            approval={approval}
            now={now}
            selected={approval.id === selected?.id}
            busy={resolving.includes(approval.id)}
            expanded={isExpanded(approval)}
            onExpandedChange={(open) => setExpanded(approval.id, open)}
            onSelect={() => setSelectedId(approval.id)}
            onApprove={requestApprove}
            onDeny={requestDeny}
            allowAlways={allowAlways}
            defaultScope={defaultScope}
            onOpenRun={onOpenRun}
          />
        ))}
      </div>

      {/* The one extra beat in front of a decision that outlives the run. */}
      <ConfirmDialog
        open={confirmScope !== null}
        title={APPROVAL_SCOPE_LABEL.always}
        description={confirmCopy?.consequence}
        confirmLabel={APPROVAL_SCOPE_LABEL.always}
        cancelLabel="Back"
        onCancel={() => setConfirmScope(null)}
        onConfirm={async () => {
          // Awaited before closing, so the dialog's own spinner covers the
          // round trip and a second Enter cannot land on a stale button.
          if (confirmScope) {
            await commit(confirmScope.approval, 'approve', confirmScope.scope);
          }
          setConfirmScope(null);
        }}
      >
        {confirmScope ? (
          <div className="space-y-2.5">
            <p>{alwaysGrantCoverage(confirmScope.approval.toolName)}</p>
            <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950">
              <p className={cn(eyebrow, 'mb-1')}>Approving now</p>
              <p className="text-[13px] font-medium text-zinc-900 dark:text-zinc-100">
                {confirmScope.approval.title}
              </p>
              <p className={cn('mt-1 truncate text-[11px]', mono, textMuted)}>
                {confirmScope.approval.toolName} ·{' '}
                {confirmScope.approval.fingerprint}
              </p>
            </div>
            {confirmRisk ? (
              <p className="flex items-center gap-1.5">
                <Badge tone={confirmRisk.tone}>{confirmRisk.label}</Badge>
                <span className={cn('text-xs', textMuted)}>
                  every matching call, not just this one.
                </span>
              </p>
            ) : null}
          </div>
        ) : null}
      </ConfirmDialog>

      {/* Deny. The reason is optional and goes to the agent, not just the log. */}
      <ConfirmDialog
        open={denyTarget !== null}
        title={`Deny ${denyTarget?.toolName ?? 'this call'}?`}
        description={DENY_COPY.consequence}
        confirmLabel="Deny"
        cancelLabel="Keep waiting"
        onCancel={() => setDenyTarget(null)}
        onConfirm={async () => {
          if (denyTarget) await commit(denyTarget, 'deny', 'once', denyReason);
          setDenyTarget(null);
          setDenyReason('');
        }}
      >
        {denyTarget ? (
          <div className="space-y-3">
            <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950">
              <p className={cn(eyebrow, 'mb-1')}>Will not run</p>
              <p className="text-[13px] font-medium text-zinc-900 dark:text-zinc-100">
                {denyTarget.title}
              </p>
            </div>
            <Textarea
              label="Why not? (optional)"
              hint="The assistant sees this, so it can pick a different approach instead of asking again."
              rows={3}
              value={denyReason}
              onChange={(event) => setDenyReason(event.target.value)}
              placeholder="e.g. wrong calendar — use the work one"
            />
          </div>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}

export default ApprovalQueue;
