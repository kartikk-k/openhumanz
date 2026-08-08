/**
 * The memory browser.
 *
 * ARCHITECTURE.md, "UI surfaces that matter" #4: *show it as files, because it
 * is files.* So the screen is a file browser first — folder tree, preview,
 * metadata — and a search engine second. The two are joined by provenance:
 * every hit carries its source file, heading breadcrumb and line range, and
 * clicking one opens that file at those lines with them highlighted.
 *
 * Layout, left to right:
 *
 *   ┌─ tree ─────┬─ results ────────┬─ document ─────────────────┐
 *   │ folders    │ ranked chunks,   │ rendered Markdown or raw   │
 *   │ + filter   │ each with        │ text with real line        │
 *   ├────────────┤ provenance       │ numbers, plus metadata     │
 *   │ index      │ (only while a    │                            │
 *   │ status     │  search is live) │                            │
 *   └────────────┴──────────────────┴────────────────────────────┘
 *
 * Routing: `/memory` is a splat owned by this file. The tree, the results and
 * the index panel live on a layout route so they survive navigation between
 * documents; `/memory/doc/<vault path>` selects one, and `?l=12-18&h=…` carries
 * the chunk to highlight. That means a search result is a real place you can go
 * back from.
 *
 * The memory push channels are wired here rather than in `store/bootstrap.ts`,
 * because they are this feature's own: `memoryIndexed` refetches the list and
 * the status, `memoryDocChanged` refetches the open document.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Navigate,
  Outlet,
  Route,
  Routes,
  useMatch,
  useNavigate,
  useOutletContext,
} from 'react-router-dom';
import { FilePlus2, Library, Search, X } from 'lucide-react';
import { IPC, IPC_PUSH } from '../../../shared/ipc';
import type { MemoryDoc, MemorySearchHit } from '../../../shared/memory';
import { ROUTES } from '../../routes';
import { cn } from '../../lib/utils';
import { useQuery } from '../../lib/ipc';
import { formatBytes, formatRelative, pluralize } from '../../lib/format';
import { PageHeader } from '../../components/layout/PageHeader';
import { Button, EmptyState, Input, Spinner } from '../../components/ui';
import { eyebrow, mono, textMuted } from '../../components/ui/styles';
import { DocumentPane } from './DocumentPane';
import { IndexStatusPanel } from './IndexStatusPanel';
import { SearchResults } from './SearchResults';
import { VaultTree } from './VaultTree';
import { WriteNoteDialog } from './WriteNoteDialog';
import { ChannelNotice } from './parts';
import { basename } from './tree';
import type { MemoryOutletContext } from './context';

/** How many docs the tree asks for. The schema caps the channel at 1000. */
const LIST_LIMIT = 1000;
/** Ranked hits per search. More than this is a scroll, not a result set. */
const SEARCH_LIMIT = 30;
/** Typing pause before a search crosses the IPC boundary. */
const SEARCH_DEBOUNCE_MS = 220;

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

const DOC_PATTERN = `${ROUTES.memory}/doc/*`;

/** Vault path -> route. Encoded per segment so the slashes stay structural. */
function docRoute(
  docPath: string,
  options: { line?: [number, number]; heading?: string } = {},
): string {
  const encoded = docPath.split('/').map(encodeURIComponent).join('/');
  const query = new URLSearchParams();
  if (options.line) {
    const [start, end] = options.line;
    query.set('l', end > start ? `${start}-${end}` : String(start));
  }
  if (options.heading) query.set('h', options.heading);
  const suffix = query.toString();
  return `${ROUTES.memory}/doc/${encoded}${suffix ? `?${suffix}` : ''}`;
}

/* ------------------------------------------------------------------ */
/* Index route: nothing selected                                       */
/* ------------------------------------------------------------------ */

function RecentNotes({
  docs,
  onOpenDoc,
}: {
  docs: readonly MemoryDoc[];
  onOpenDoc: (path: string) => void;
}) {
  const recent = useMemo(
    () =>
      [...docs]
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .slice(0, 6),
    [docs],
  );

  if (recent.length === 0) return null;

  return (
    <div className="mx-auto mt-8 w-full max-w-md text-left">
      <p className={cn(eyebrow, 'mb-1.5')}>Recently edited</p>
      <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
        {recent.map((doc) => (
          <button
            key={doc.path}
            type="button"
            onClick={() => onOpenDoc(doc.path)}
            className="flex w-full items-center gap-3 border-b border-zinc-100 px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-zinc-50 dark:border-zinc-800/70 dark:hover:bg-zinc-800/40"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-medium text-zinc-800 dark:text-zinc-200">
                {doc.title || basename(doc.path)}
              </span>
              <span
                className={cn('block truncate text-[11px]', mono, textMuted)}
              >
                {doc.path}
              </span>
            </span>
            <span
              className={cn('shrink-0 text-[11px] tabular-nums', textMuted)}
            >
              {formatRelative(doc.updatedAt)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** The right-hand pane before anything is selected. */
function NoSelection() {
  const context = useOutletContext<MemoryOutletContext>();
  const { docs, vaultPath, listError, onRetry, onCreate, onOpenDoc } = context;

  const totalBytes = docs.reduce((sum, doc) => sum + doc.sizeBytes, 0);

  // "Could not ask" is not "there is nothing there".
  if (listError && docs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <ChannelNotice error={listError} what="the vault" onRetry={onRetry} />
      </div>
    );
  }

  if (docs.length === 0) {
    return (
      <div className="flex h-full items-start justify-center overflow-y-auto py-16">
        <EmptyState
          icon={Library}
          title="The vault is empty"
          description={
            <>
              Memory is Markdown files in{' '}
              <span className={mono}>{vaultPath || '~/.assistant/memory'}</span>
              . Write the first note here, or drop{' '}
              <span className={mono}>.md</span> files into that folder and
              reindex — the assistant will find them either way.
            </>
          }
          action={
            <Button variant="primary" icon={FilePlus2} onClick={onCreate}>
              New note
            </Button>
          }
          footer="Nothing is stored anywhere but that directory."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full items-start justify-center overflow-y-auto py-14">
      <div className="w-full max-w-md px-6">
        <EmptyState
          icon={Library}
          title="Pick a note, or search the vault"
          description={
            <>
              {pluralize(docs.length, 'document')} · {formatBytes(totalBytes)}{' '}
              of Markdown. Search returns chunks, each with the file, heading
              and line range it came from.
            </>
          }
        />
        <RecentNotes docs={docs} onOpenDoc={onOpenDoc} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Layout route                                                        */
/* ------------------------------------------------------------------ */

interface WriteState {
  open: boolean;
  mode: 'create' | 'edit';
  path: string;
  content: string;
}

const CLOSED_WRITE: WriteState = {
  open: false,
  mode: 'create',
  path: '',
  content: '',
};

function MemoryLayout() {
  const navigate = useNavigate();
  const match = useMatch(DOC_PATTERN);
  const selectedPath = match?.params['*'] ?? null;

  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [activeChunkId, setActiveChunkId] = useState<string | null>(null);
  const [write, setWrite] = useState<WriteState>(CLOSED_WRITE);
  const searchRef = useRef<HTMLInputElement>(null);

  /* ---------------- queries ---------------- */

  const status = useQuery(
    IPC.memory.status,
    {},
    { refetchOn: [IPC_PUSH.memoryIndexed] },
  );

  const list = useQuery(
    IPC.memory.list,
    { limit: LIST_LIMIT },
    { refetchOn: [IPC_PUSH.memoryIndexed, IPC_PUSH.memoryDocChanged] },
  );

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const searching = debounced.trim().length > 0;
  const search = useQuery(
    IPC.memory.search,
    { query: debounced.trim(), limit: SEARCH_LIMIT },
    { enabled: searching, refetchOn: [IPC_PUSH.memoryIndexed] },
  );

  const docs = useMemo(() => list.data?.items ?? [], [list.data]);
  const vaultPath = status.data?.vaultPath ?? '';

  /* ---------------- navigation ---------------- */

  const openDoc = useCallback(
    (docPath: string) => {
      setActiveChunkId(null);
      navigate(docRoute(docPath));
    },
    [navigate],
  );

  const openHit = useCallback(
    (hit: MemorySearchHit) => {
      setActiveChunkId(hit.chunk.id);
      navigate(
        docRoute(hit.chunk.docPath, {
          line: [hit.chunk.startLine, hit.chunk.endLine],
          heading: hit.chunk.heading,
        }),
      );
    },
    [navigate],
  );

  /* ---------------- write dialog ---------------- */

  const onCreate = useCallback(() => {
    setWrite({ open: true, mode: 'create', path: '', content: '' });
  }, []);

  const onEdit = useCallback((docPath: string, content: string) => {
    setWrite({ open: true, mode: 'edit', path: docPath, content });
  }, []);

  const onWritten = useCallback(
    (doc: MemoryDoc) => {
      void list.refetch();
      void status.refetch();
      navigate(docRoute(doc.path));
    },
    [list, status, navigate],
  );

  /* ---------------- keyboard ---------------- */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  /* ---------------- context for child routes ---------------- */

  const onRetry = useCallback(() => {
    void list.refetch();
    void status.refetch();
    // `list` and `status` are recreated every render; the refetch closures they
    // carry are the stable part, so depending on them here is deliberate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.refetch, status.refetch]);

  const context = useMemo<MemoryOutletContext>(
    () => ({
      vaultPath,
      docs,
      listError: list.error,
      searchQuery: searching ? debounced : '',
      onRetry,
      onEdit,
      onCreate,
      onOpenDoc: openDoc,
    }),
    [
      vaultPath,
      docs,
      list.error,
      searching,
      debounced,
      onRetry,
      onEdit,
      onCreate,
      openDoc,
    ],
  );

  const existingPaths = useMemo(() => docs.map((doc) => doc.path), [docs]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        sticky={false}
        title="Memory"
        description="The vault, as files — because it is files."
        actions={
          <Button
            variant="primary"
            size="sm"
            icon={FilePlus2}
            onClick={onCreate}
          >
            New note
          </Button>
        }
        toolbar={
          <Input
            ref={searchRef}
            size="sm"
            icon={Search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query) {
                event.stopPropagation();
                setQuery('');
              }
            }}
            placeholder="Search the vault — full text over every chunk"
            aria-label="Search memory"
            trailing={
              // eslint-disable-next-line no-nested-ternary
              search.fetching ? (
                <Spinner size="xs" label="Searching" />
              ) : query ? (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  icon={X}
                  aria-label="Clear search"
                  className="h-5 w-5"
                  onClick={() => setQuery('')}
                />
              ) : (
                <kbd
                  className={cn(
                    'rounded border border-zinc-200 px-1 text-[10px] dark:border-zinc-700',
                    textMuted,
                  )}
                >
                  /
                </kbd>
              )
            }
          />
        }
      />

      {list.error ? (
        <ChannelNotice
          variant="inline"
          error={list.error}
          what="the vault"
          onRetry={onRetry}
        />
      ) : null}

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-200 dark:border-zinc-800">
          {list.loading ? (
            <div className="flex flex-1 items-center justify-center">
              <Spinner size="sm" label="Loading the vault" />
            </div>
          ) : (
            <VaultTree
              className="flex-1"
              docs={docs}
              selectedPath={selectedPath}
              onSelect={openDoc}
            />
          )}
          <IndexStatusPanel
            status={status.data}
            error={status.error}
            onReindexed={onRetry}
          />
        </aside>

        {searching ? (
          <aside className="flex w-[21rem] shrink-0 flex-col border-r border-zinc-200 dark:border-zinc-800">
            <SearchResults
              className="flex-1"
              query={debounced}
              hits={search.data}
              loading={search.loading}
              error={search.error}
              activeChunkId={activeChunkId}
              onOpen={openHit}
              onRetry={() => {
                void search.refetch();
              }}
            />
          </aside>
        ) : null}

        <section className="min-w-0 flex-1">
          <Outlet context={context} />
        </section>
      </div>

      <WriteNoteDialog
        open={write.open}
        mode={write.mode}
        initialPath={write.path}
        initialContent={write.content}
        vaultPath={vaultPath}
        existingPaths={existingPaths}
        onClose={() => setWrite(CLOSED_WRITE)}
        onWritten={onWritten}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Route table                                                         */
/* ------------------------------------------------------------------ */

/**
 * Owns `/memory` and everything under it.
 *
 * `MemoryLayout` is a pathless layout route, so the tree, the search results
 * and the index panel are mounted once and stay mounted while the document
 * pane changes underneath them.
 */
export function MemoryScreen() {
  return (
    <Routes>
      <Route element={<MemoryLayout />}>
        <Route index element={<NoSelection />} />
        <Route path="doc/*" element={<DocumentPane />} />
        <Route path="*" element={<Navigate to={ROUTES.memory} replace />} />
      </Route>
    </Routes>
  );
}

export default MemoryScreen;
