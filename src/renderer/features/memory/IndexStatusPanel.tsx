/**
 * Index status and the two ways to rebuild it.
 *
 * The database is a derived index over the Markdown files, and saying so out
 * loud is the point of this panel: it shows how many documents and chunks are
 * in the index, when it last caught up, and where the files actually live.
 *
 * Two controls, because they are genuinely different operations:
 *  - **Reindex** re-reads changed files. Cheap, idempotent, the usual fix.
 *  - **Rebuild** (`{ full: true }`) clears the index first and rebuilds every
 *    row from the files. It is behind a confirm, not because it can lose
 *    anything — the files are the source of truth — but because on a large
 *    vault it is the slow one.
 */
import { useState } from 'react';
import { DatabaseZap, FolderTree, RefreshCw } from 'lucide-react';
import { IPC } from '../../../shared/ipc';
import type { MemoryIndexStatus } from '../../../shared/memory';
import { cn } from '../../lib/utils';
import { formatCount, formatRelative, pluralize } from '../../lib/format';
import { useMutation, type IpcError } from '../../lib/ipc';
import { toast } from '../../store';
import { Button, ConfirmDialog, StatusDot, Tooltip } from '../../components/ui';
import { eyebrow, mono, textMuted } from '../../components/ui/styles';
import { CopyButton } from './parts';

export interface IndexStatusPanelProps {
  status: MemoryIndexStatus | undefined;
  error: IpcError | null;
  /** Called after a successful reindex so the screen can refetch. */
  onReindexed: (status: MemoryIndexStatus) => void;
  className?: string;
}

export function IndexStatusPanel({
  status,
  error,
  onReindexed,
  className,
}: IndexStatusPanelProps) {
  const [confirmFull, setConfirmFull] = useState(false);

  const reindex = useMutation(IPC.memory.reindex, {
    onSuccess: (next) => {
      toast.success('Index rebuilt', {
        description: `${pluralize(next.docCount, 'document')} · ${pluralize(
          next.chunkCount,
          'chunk',
        )}`,
      });
      onReindexed(next);
    },
    onError: (cause) => {
      toast.error('Reindex failed', {
        description: `${cause.message} (${cause.code})`,
        key: 'memory-reindex',
      });
    },
  });

  const indexing = status?.indexing === true;
  const busy = reindex.pending || indexing;
  const unavailable = Boolean(error) && !status;

  const dotTone = (() => {
    if (busy) return 'info' as const;
    if (unavailable) return 'warning' as const;
    if (status?.lastIndexedAt) return 'success' as const;
    return 'neutral' as const;
  })();

  const stateLabel = (() => {
    if (reindex.pending) return 'Reindexing…';
    if (indexing) return 'Indexing…';
    if (unavailable) return 'Index unavailable';
    if (status?.lastIndexedAt) {
      return `Indexed ${formatRelative(status.lastIndexedAt)}`;
    }
    return 'Not indexed yet';
  })();

  return (
    <div
      className={cn(
        'border-t border-zinc-200 bg-zinc-50 px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/60',
        className,
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className={eyebrow}>Index</span>
        <StatusDot
          tone={dotTone}
          pulse={busy}
          label={null}
          className="ml-0.5"
        />
        <span className={cn('truncate text-[11px]', textMuted)}>
          {stateLabel}
        </span>
      </div>

      <dl className="mt-1.5 flex items-center gap-3 text-[11px]">
        <div className="flex items-center gap-1">
          <dt className={cn('sr-only')}>Documents</dt>
          <dd className="font-medium tabular-nums text-zinc-700 dark:text-zinc-300">
            {status ? formatCount(status.docCount) : '—'}
          </dd>
          <span className={textMuted}>docs</span>
        </div>
        <div className="flex items-center gap-1">
          <dt className="sr-only">Chunks</dt>
          <dd className="font-medium tabular-nums text-zinc-700 dark:text-zinc-300">
            {status ? formatCount(status.chunkCount) : '—'}
          </dd>
          <span className={textMuted}>chunks</span>
        </div>
      </dl>

      <div className="mt-1.5 flex items-center gap-1">
        <FolderTree
          size={11}
          aria-hidden="true"
          className={cn('shrink-0', textMuted)}
        />
        <span
          className={cn('min-w-0 flex-1 truncate text-[11px]', mono, textMuted)}
          title={
            status?.vaultPath || 'Unknown — memory:status has not answered'
          }
        >
          {status?.vaultPath || 'vault path unknown'}
        </span>
        {status?.vaultPath ? (
          <CopyButton
            value={status.vaultPath}
            title="Copy the vault path"
            className="h-5 w-5"
          />
        ) : null}
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        <Button
          size="xs"
          variant="secondary"
          icon={RefreshCw}
          loading={reindex.pending && !confirmFull}
          disabled={busy}
          onClick={() => {
            void reindex.mutate({ full: false });
          }}
        >
          Reindex
        </Button>
        <Tooltip content="Clear the index and rebuild every row from the files.">
          <Button
            size="xs"
            variant="ghost"
            icon={DatabaseZap}
            disabled={busy}
            onClick={() => setConfirmFull(true)}
          >
            Rebuild
          </Button>
        </Tooltip>
      </div>

      <ConfirmDialog
        open={confirmFull}
        title="Rebuild the whole index?"
        description="The Markdown files are untouched — only the derived index is cleared and rewritten."
        confirmLabel="Rebuild index"
        onCancel={() => setConfirmFull(false)}
        onConfirm={async () => {
          await reindex.mutate({ full: true });
          setConfirmFull(false);
        }}
      >
        <p className={cn('text-xs leading-relaxed', textMuted)}>
          Every document in{' '}
          <span className={mono}>{status?.vaultPath || 'the vault'}</span> is
          re-read and re-chunked. On a large vault this takes a while, and
          search returns nothing until it finishes.
        </p>
      </ConfirmDialog>
    </div>
  );
}

export default IndexStatusPanel;
