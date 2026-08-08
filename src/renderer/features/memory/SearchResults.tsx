/**
 * Ranked search results.
 *
 * A hit is a **chunk**, not a document, and the contract for this screen is
 * that every one of them shows where it came from: source file, heading
 * breadcrumb, and the 1-based inclusive line range. Clicking a hit opens the
 * document at exactly those lines.
 *
 * The snippet arrives from FTS4 `snippet()` with the matched terms wrapped in
 * `‹›`. It is plain text and is rendered as plain text — {@link splitSnippet}
 * turns the markers into `<mark>` elements rather than letting anything
 * interpret the string.
 */
import { Search, SquareArrowOutUpRight } from 'lucide-react';
import type { MemorySearchHit } from '../../../shared/memory';
import { cn } from '../../lib/utils';
import { formatRelative } from '../../lib/format';
import { Badge, EmptyState, Spinner } from '../../components/ui';
import {
  eyebrow,
  focusRingInset,
  mono,
  textMuted,
} from '../../components/ui/styles';
import type { IpcError } from '../../lib/ipc';
import { splitSnippet } from './markdown';
import { ChannelNotice, Provenance } from './parts';
import { basename } from './tree';

export interface SearchResultsProps {
  query: string;
  hits: readonly MemorySearchHit[] | undefined;
  loading: boolean;
  error: IpcError | null;
  /** The chunk currently open in the preview, so the list shows the position. */
  activeChunkId: string | null;
  onOpen: (hit: MemorySearchHit) => void;
  onRetry: () => void;
  className?: string;
}

function Snippet({ text }: { text: string }) {
  const parts = splitSnippet(text);
  return (
    <p className="mt-1.5 line-clamp-4 break-words text-[12px] leading-[1.6] text-zinc-600 dark:text-zinc-400">
      {parts.map((part, index) =>
        part.match ? (
          <mark
            // Snippet parts are positional within one immutable string.
            // eslint-disable-next-line react/no-array-index-key
            key={index}
            className="rounded-[2px] bg-amber-200/70 px-px font-medium text-zinc-900 dark:bg-amber-400/25 dark:text-zinc-100"
          >
            {part.text}
          </mark>
        ) : (
          // eslint-disable-next-line react/no-array-index-key
          <span key={index}>{part.text}</span>
        ),
      )}
    </p>
  );
}

export function SearchResults({
  query,
  hits,
  loading,
  error,
  activeChunkId,
  onOpen,
  onRetry,
  className,
}: SearchResultsProps) {
  const trimmed = query.trim();

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <span className={eyebrow}>Results</span>
        {loading ? (
          <Spinner size="xs" label="Searching" />
        ) : (
          <span className={cn('text-[11px] tabular-nums', textMuted)}>
            {hits ? hits.length : 0}
          </span>
        )}
        <span className={cn('ml-auto truncate text-[11px]', textMuted)}>
          ranked by BM25
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <ChannelNotice
            error={error}
            what="search results"
            onRetry={onRetry}
            className="py-10"
          />
        ) : null}

        {!error && hits && hits.length === 0 && !loading ? (
          <EmptyState
            size="sm"
            icon={Search}
            title="Nothing matched"
            description={
              <>
                No chunk in the vault contains{' '}
                <span className={mono}>{trimmed}</span>. Search is whole-word —
                add <span className={mono}>*</span> for a prefix match.
              </>
            }
          />
        ) : null}

        {!error &&
          hits?.map((hit, index) => {
            const active = hit.chunk.id === activeChunkId;
            return (
              <button
                key={hit.chunk.id}
                type="button"
                onClick={() => onOpen(hit)}
                className={cn(
                  'group block w-full border-b border-zinc-100 px-3 py-2.5 text-left transition-colors dark:border-zinc-800/70',
                  focusRingInset,
                  active
                    ? 'bg-indigo-50/70 dark:bg-indigo-500/10'
                    : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/40',
                )}
              >
                <div className="flex items-baseline gap-2">
                  <span
                    className={cn(
                      'shrink-0 text-[10px] tabular-nums',
                      textMuted,
                    )}
                  >
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-zinc-800 dark:text-zinc-200">
                    {hit.docTitle || basename(hit.chunk.docPath)}
                  </span>
                  <SquareArrowOutUpRight
                    size={11}
                    aria-hidden="true"
                    className={cn(
                      'shrink-0 opacity-0 transition-opacity group-hover:opacity-100',
                      textMuted,
                    )}
                  />
                </div>

                <Provenance
                  className="mt-1"
                  docPath={hit.chunk.docPath}
                  heading={hit.chunk.heading}
                  startLine={hit.chunk.startLine}
                  endLine={hit.chunk.endLine}
                />

                <Snippet text={hit.snippet} />

                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {hit.docTags.slice(0, 4).map((tag) => (
                    <Badge key={tag} tone="accent" variant="soft">
                      {tag}
                    </Badge>
                  ))}
                  <span
                    className={cn(
                      'ml-auto text-[10px] tabular-nums',
                      textMuted,
                    )}
                    title={`BM25 score ${hit.score}`}
                  >
                    {formatRelative(hit.updatedAt)}
                  </span>
                </div>
              </button>
            );
          })}

        {loading && !hits ? (
          <div className="flex items-center justify-center gap-2 py-10">
            <Spinner size="sm" label={null} />
            <span className={cn('text-xs', textMuted)}>
              Searching the index…
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default SearchResults;
