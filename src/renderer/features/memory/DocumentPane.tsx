/**
 * One document, as a file.
 *
 * `memory:get` reads from disk rather than from the index, so this is the file
 * as it is right now — including edits the user made in their own editor that
 * the watcher has not caught up with yet.
 *
 * Two views. **Rendered** is the safe-subset Markdown renderer in
 * `MarkdownView`. **Raw** is the bytes with real line numbers, which is what
 * makes a search hit's `L12–18` checkable rather than a claim.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOutletContext, useParams, useSearchParams } from 'react-router-dom';
import { Crosshair, FileWarning, Pencil, X } from 'lucide-react';
import { IPC, IPC_PUSH } from '../../../shared/ipc';
import { cn } from '../../lib/utils';
import {
  formatBytes,
  formatDateTime,
  formatJson,
  formatRelative,
} from '../../lib/format';
import { useQuery, useSubscription } from '../../lib/ipc';
import {
  Badge,
  Button,
  CodeBlock,
  CollapsibleSection,
  EmptyState,
  Spinner,
  Tabs,
} from '../../components/ui';
import { eyebrow, mono, textMuted } from '../../components/ui/styles';
import { LARGE_DOC_CHARS } from './markdown';
import { MarkdownView, markableTerms, type LineRange } from './MarkdownView';
import { ChannelNotice, CopyButton, Provenance, RawDocument } from './parts';
import { absolutePath, basename } from './tree';
import type { MemoryOutletContext } from './context';

type ViewMode = 'rendered' | 'raw';

const VIEW_TABS = [
  { value: 'rendered' as const, label: 'Rendered' },
  { value: 'raw' as const, label: 'Raw' },
];

/** `?l=12-18` — the chunk a search hit pointed at. */
export function parseLineParam(raw: string | null): LineRange | null {
  if (!raw) return null;
  const match = /^(\d{1,7})(?:-(\d{1,7}))?$/.exec(raw);
  if (!match) return null;
  const startLine = Number.parseInt(match[1], 10);
  if (startLine < 1) return null;
  const endLine = match[2] ? Number.parseInt(match[2], 10) : startLine;
  return { startLine, endLine: Math.max(startLine, endLine) };
}

export function DocumentPane() {
  const params = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const context = useOutletContext<MemoryOutletContext>();

  const docPath = params['*'] ?? '';
  const highlight = parseLineParam(searchParams.get('l'));
  const heading = searchParams.get('h') ?? '';

  const [view, setView] = useState<ViewMode>('rendered');

  const result = useQuery(
    IPC.memory.get,
    { path: docPath },
    { enabled: docPath.length > 0 },
  );
  const { refetch } = result;

  // A doc the agent (or the user's editor) rewrote under us. Path-scoped so
  // one changed note does not refetch every open pane.
  useSubscription(IPC_PUSH.memoryDocChanged, (payload) => {
    if (payload.path === docPath) void refetch();
  });

  const content = result.data?.content ?? '';
  const doc = result.data?.doc;

  const terms = useMemo(
    () => markableTerms(context.searchQuery),
    [context.searchQuery],
  );

  // Very large notes are shown raw first: the parser copes, but the rendered
  // tree is thousands of nodes and the raw view is what you want anyway.
  const oversized = content.length > LARGE_DOC_CHARS;
  useEffect(() => {
    if (oversized) setView('raw');
  }, [oversized, docPath]);

  // Scroll the highlighted chunk into view once per (document, range, view).
  const scrollKey = `${docPath}:${highlight?.startLine ?? ''}:${view}`;
  const scrolled = useRef('');
  useEffect(() => {
    scrolled.current = '';
  }, [scrollKey]);

  const focusRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || scrolled.current === scrollKey) return;
      scrolled.current = scrollKey;
      if (typeof node.scrollIntoView === 'function') {
        node.scrollIntoView({ block: 'center' });
      }
    },
    [scrollKey],
  );

  const clearHighlight = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('l');
    next.delete('h');
    setSearchParams(next, { replace: true });
  };

  if (!docPath) return null;

  /* ---------------- states before the document ---------------- */

  if (result.error && !result.data) {
    return (
      <div className="flex h-full items-center justify-center">
        <ChannelNotice
          error={result.error}
          what={`“${basename(docPath)}”`}
          onRetry={() => {
            void refetch();
          }}
        />
      </div>
    );
  }

  if (result.loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2">
        <Spinner size="sm" label={null} />
        <span className={cn('text-xs', textMuted)}>Reading {docPath}…</span>
      </div>
    );
  }

  if (!result.data) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          icon={FileWarning}
          title="That note is not in the vault"
          description={
            <>
              <span className={mono}>{docPath}</span> was not found. It may have
              been renamed or deleted since the index last ran.
            </>
          }
        />
      </div>
    );
  }

  const absolute = absolutePath(context.vaultPath, docPath);
  const frontmatterKeys = Object.keys(doc?.frontmatter ?? {});

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ---------------- header ---------------- */}
      <div className="shrink-0 border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
              {doc?.title || basename(docPath)}
            </h2>
            <div className="mt-1 flex min-w-0 items-center gap-1">
              <span
                className={cn('min-w-0 truncate text-[11px]', mono, textMuted)}
                title={absolute}
              >
                {absolute}
              </span>
              <CopyButton
                value={absolute}
                title="Copy the absolute file path"
                className="h-5 w-5"
              />
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <Tabs
              items={VIEW_TABS}
              value={view}
              onValueChange={(next) => setView(next as ViewMode)}
              variant="pill"
              label="Document view"
            />
            <Button
              size="sm"
              variant="outline"
              icon={Pencil}
              onClick={() => context.onEdit(docPath, content)}
            >
              Edit
            </Button>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          {doc?.tags.map((tag) => (
            <Badge key={tag} tone="accent" variant="soft">
              {tag}
            </Badge>
          ))}
          <span className={cn('tabular-nums', textMuted)}>
            {formatBytes(doc?.sizeBytes)}
          </span>
          <span className={textMuted} title={formatDateTime(doc?.updatedAt)}>
            edited {formatRelative(doc?.updatedAt)}
          </span>
          <span className={textMuted} title={formatDateTime(doc?.createdAt)}>
            created {formatRelative(doc?.createdAt)}
          </span>
          {doc?.indexedAt ? (
            <span className={textMuted} title={formatDateTime(doc.indexedAt)}>
              indexed {formatRelative(doc.indexedAt)}
            </span>
          ) : (
            <span className="text-amber-600 dark:text-amber-400">
              not in the index
            </span>
          )}
          {result.fetching ? <Spinner size="xs" label="Refreshing" /> : null}
        </div>

        {/*
          There is no IPC channel that reveals a file in the OS — no `shell:*`
          in src/shared/ipc.ts — so the honest affordance is the real path and
          a copy button. See the note in MemoryScreen.
        */}
        <p className={cn('mt-1.5 text-[11px]', textMuted)}>
          Open it in your editor with the path above — the app cannot launch one
          yet.
        </p>
      </div>

      {/* ---------------- provenance banner ---------------- */}
      {highlight ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-200 bg-amber-50 px-5 py-1.5 dark:border-amber-500/30 dark:bg-amber-500/10">
          <Crosshair
            size={12}
            aria-hidden="true"
            className="shrink-0 text-amber-600 dark:text-amber-400"
          />
          <span className="shrink-0 text-[11px] font-medium text-amber-800 dark:text-amber-200">
            Search hit
          </span>
          <Provenance
            className="min-w-0 flex-1 text-amber-800/80 dark:text-amber-200/80"
            docPath={docPath}
            heading={heading}
            startLine={highlight.startLine}
            endLine={highlight.endLine}
          />
          <Button
            size="xs"
            variant="ghost"
            icon={X}
            onClick={clearHighlight}
            className="shrink-0"
          >
            Clear
          </Button>
        </div>
      ) : null}

      {/* ---------------- body ---------------- */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {frontmatterKeys.length > 0 ? (
          <CollapsibleSection
            title="Front matter"
            subtitle={`${frontmatterKeys.length} field${frontmatterKeys.length === 1 ? '' : 's'}`}
            density="compact"
            className="mb-4"
          >
            <CodeBlock
              code={formatJson(doc?.frontmatter)}
              language="json"
              wrap
              maxHeight="16rem"
            />
          </CollapsibleSection>
        ) : null}

        {oversized ? (
          <p
            className={cn(
              'mb-3 rounded-md border border-dashed border-zinc-300 px-3 py-2 text-xs dark:border-zinc-700',
              textMuted,
            )}
          >
            <span className={eyebrow}>Large file</span> —{' '}
            {formatBytes(content.length)} of Markdown. Showing raw text; the
            rendered view is available but will be slow.
          </p>
        ) : null}

        <DocumentBody
          content={content}
          docPath={docPath}
          view={view}
          highlight={highlight}
          terms={terms}
          focusRef={focusRef}
          onOpenDoc={context.onOpenDoc}
        />
      </div>
    </div>
  );
}

interface DocumentBodyProps {
  content: string;
  docPath: string;
  view: ViewMode;
  highlight: LineRange | null;
  terms: readonly string[];
  focusRef: (node: HTMLDivElement | null) => void;
  onOpenDoc: (path: string) => void;
}

function DocumentBody({
  content,
  docPath,
  view,
  highlight,
  terms,
  focusRef,
  onOpenDoc,
}: DocumentBodyProps) {
  if (content.length === 0) {
    return (
      <EmptyState
        size="sm"
        title="This file is empty"
        description="Nothing has been written to it yet."
      />
    );
  }
  if (view === 'raw') {
    return (
      <RawDocument
        content={content}
        highlight={highlight}
        focusRef={focusRef}
      />
    );
  }
  return (
    <MarkdownView
      source={content}
      docPath={docPath}
      highlight={highlight}
      terms={terms}
      focusRef={focusRef}
      onOpenDoc={onOpenDoc}
    />
  );
}

export default DocumentPane;
