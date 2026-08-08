/**
 * Standing grants — everything the user has said "always" (or "this run") to.
 *
 * This is the undo for the most consequential button on the card, so it is
 * built to be *complete* rather than tidy: every grant is listed, with the
 * thing that actually decides its reach shown as its own column. A grant with
 * no fingerprint matches **any** call to that tool; one with a fingerprint
 * matches only calls like the one that was approved. Those are very different
 * promises and the table says which is which rather than printing one word.
 *
 * Grants are read from the approvals store rather than a local `useQuery`,
 * because `resolve()` refreshes them itself after an `always` decision — the
 * new grant has to appear here without this panel being mounted at the time.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { KeyRound, RotateCcw, ShieldOff } from 'lucide-react';
import type { ApprovalGrant } from '../../../shared/approvals';
import { cn } from '../../lib/utils';
import { formatDateTime, formatRelative, pluralize } from '../../lib/format';
import { APPROVAL_SCOPE_LABEL } from '../../lib/status';
import type { Tone } from '../../lib/tone';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tabs,
  eyebrow,
  mono,
  textMuted,
} from '../../components/ui';
import { toast, useApprovalsStore } from '../../store';
import { ChannelNotice } from './parts';

type GrantFilter = 'all' | 'always' | 'run';

const SCOPE_TONE: Record<'run' | 'always', Tone> = {
  run: 'info',
  always: 'success',
};

/** What the grant actually covers, in the user's words rather than the gate's. */
function coverage(grant: ApprovalGrant): { label: string; broad: boolean } {
  if (grant.fingerprint) {
    return {
      label:
        grant.label ||
        `Calls to ${grant.toolName} that match the request you approved`,
      broad: false,
    };
  }
  return {
    label: grant.label || `Every call to ${grant.toolName}, whatever it asks`,
    broad: true,
  };
}

export interface GrantsPanelProps {
  now: number;
  className?: string;
}

export function GrantsPanel({ now, className }: GrantsPanelProps) {
  const grants = useApprovalsStore((state) => state.grants);
  const loadGrants = useApprovalsStore((state) => state.loadGrants);
  const revokeGrant = useApprovalsStore((state) => state.revokeGrant);
  const bridgeDown = useApprovalsStore((state) => state.unavailable);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<GrantFilter>('all');
  const [target, setTarget] = useState<ApprovalGrant | null>(null);

  /**
   * `loadGrants` swallows its failure into the slice's shared `error` field and
   * leaves `grants` untouched, so a message alone cannot tell this load from an
   * older one. A successful read always assigns a fresh array — identity is the
   * honest signal, and it is the only one the store gives us without editing it.
   */
  const refresh = useCallback(async () => {
    setLoading(true);
    const before = useApprovalsStore.getState().grants;
    await loadGrants();
    const after = useApprovalsStore.getState();
    setLoading(false);
    setError(
      after.grants === before
        ? (after.error ?? 'The grants channel did not answer.')
        : null,
    );
  }, [loadGrants]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const visible = useMemo(
    () =>
      filter === 'all'
        ? grants
        : grants.filter((grant) => grant.scope === filter),
    [grants, filter],
  );

  const counts = useMemo(
    () => ({
      all: grants.length,
      always: grants.filter((grant) => grant.scope === 'always').length,
      run: grants.filter((grant) => grant.scope === 'run').length,
    }),
    [grants],
  );

  const revoke = useCallback(
    async (grant: ApprovalGrant) => {
      const ok = await revokeGrant(grant.id);
      if (ok) {
        toast.success('Grant revoked', {
          description: `${grant.toolName} will ask you again next time.`,
        });
      } else {
        toast.error('Could not revoke that grant', {
          key: `revoke-${grant.id}`,
          description:
            'It is still in force. The approval gate was not reachable.',
        });
      }
    },
    [revokeGrant],
  );

  if (loading && grants.length === 0) {
    return (
      <div
        className={cn(
          'flex items-center justify-center gap-2 py-16 text-[13px]',
          textMuted,
          className,
        )}
      >
        <Spinner size="sm" label={null} />
        Reading standing grants…
      </div>
    );
  }

  if (error && grants.length === 0) {
    return (
      <ChannelNotice
        className={className}
        message={error}
        unavailable={bridgeDown}
        what="your standing grants"
        onRetry={() => {
          void refresh();
        }}
      />
    );
  }

  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={cn('max-w-xl text-xs leading-relaxed', textMuted)}>
          A grant is a question you have already answered. While one is in force
          the matching call runs without stopping here — so this list is the
          complete set of things the assistant may do without asking. Revoking
          one takes effect on the next call.
        </p>
        <Button
          size="xs"
          variant="ghost"
          icon={RotateCcw}
          onClick={() => {
            void refresh();
          }}
          loading={loading}
        >
          Refresh
        </Button>
      </div>

      {error ? (
        <ChannelNotice
          message={error}
          unavailable={bridgeDown}
          what="your standing grants"
          onRetry={() => {
            void refresh();
          }}
        />
      ) : null}

      <Tabs
        variant="pill"
        label="Grant scope"
        value={filter}
        onValueChange={setFilter}
        items={[
          { value: 'all', label: 'All', count: counts.all },
          {
            value: 'always',
            label: APPROVAL_SCOPE_LABEL.always,
            count: counts.always,
          },
          { value: 'run', label: 'This run only', count: counts.run },
        ]}
      />

      {visible.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          size="sm"
          title={
            grants.length === 0
              ? 'You have not said “always” to anything'
              : 'No grants in this scope'
          }
          description={
            grants.length === 0
              ? 'Every side-effecting call still stops and asks. Pick “Always allow” on a card and the standing grant appears here, where you can take it back.'
              : 'Switch the filter to see the grants you do have.'
          }
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
          <Table density="compact">
            <TableHead>
              <TableRow>
                <TableHeaderCell width="11.5rem">Scope</TableHeaderCell>
                <TableHeaderCell>What it covers</TableHeaderCell>
                <TableHeaderCell width="12rem">Tool</TableHeaderCell>
                <TableHeaderCell width="9rem">Given</TableHeaderCell>
                <TableHeaderCell width="6rem" align="right">
                  <span className="sr-only">Revoke</span>
                </TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {visible.map((grant) => {
                const cover = coverage(grant);
                return (
                  <TableRow key={grant.id}>
                    <TableCell nowrap>
                      <Badge tone={SCOPE_TONE[grant.scope]}>
                        {APPROVAL_SCOPE_LABEL[grant.scope]}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span className="text-[13px] text-zinc-800 dark:text-zinc-200">
                        {cover.label}
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
                        {cover.broad ? (
                          <Badge tone="warning" variant="outline">
                            Any arguments
                          </Badge>
                        ) : (
                          <span
                            className={cn('truncate text-[11px]', mono, textMuted)}
                            title={grant.fingerprint}
                          >
                            {grant.fingerprint}
                          </span>
                        )}
                        {grant.runId ? (
                          <span className={cn('text-[11px]', textMuted)}>
                            run{' '}
                            <span className={mono} title={grant.runId}>
                              {grant.runId.slice(0, 12)}
                            </span>
                          </span>
                        ) : null}
                        {grant.expiresAt ? (
                          <span className={cn('text-[11px]', textMuted)}>
                            expires {formatRelative(grant.expiresAt, now)}
                          </span>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell nowrap>
                      <span className={cn(mono, 'text-zinc-700 dark:text-zinc-300')}>
                        {grant.toolName}
                      </span>
                    </TableCell>
                    <TableCell nowrap>
                      <span
                        className={cn('text-[12px]', textMuted)}
                        title={formatDateTime(grant.createdAt)}
                      >
                        {formatRelative(grant.createdAt, now)}
                      </span>
                    </TableCell>
                    <TableCell align="right" nowrap>
                      <Button
                        size="xs"
                        variant="outline"
                        icon={ShieldOff}
                        onClick={() => setTarget(grant)}
                      >
                        Revoke
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {grants.length > 0 ? (
        <p className={cn(eyebrow)}>
          {pluralize(grants.length, 'standing grant')} · revoking one only
          affects future calls
        </p>
      ) : null}

      <ConfirmDialog
        open={target !== null}
        title="Revoke this grant?"
        description="The next matching call stops and asks you again. Nothing that already ran is undone."
        confirmLabel="Revoke"
        cancelLabel="Keep it"
        onCancel={() => setTarget(null)}
        onConfirm={async () => {
          if (target) await revoke(target);
          setTarget(null);
        }}
      >
        {target ? (
          <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950">
            <p className={cn(eyebrow, 'mb-1')}>Currently allowed</p>
            <p className="text-[13px] text-zinc-900 dark:text-zinc-100">
              {coverage(target).label}
            </p>
            <p className={cn('mt-1 truncate text-[11px]', mono, textMuted)}>
              {target.toolName} · given {formatDateTime(target.createdAt)}
            </p>
          </div>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}

export default GrantsPanel;
