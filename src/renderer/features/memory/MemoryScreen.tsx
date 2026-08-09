/**
 * Memory.
 *
 * A plain list of what the assistant remembers about you, read straight from the
 * local memory engine — no indexing, no LLM on this screen, just the data the
 * server already holds. Search finds specific facts; the default view lists
 * everything you've saved, newest first. You can add a memory by hand or forget
 * one.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Brain, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { IPC } from '../../../shared/ipc';
import type { MemoryItem, MemoryPage } from '../../../shared/supermemory';
import { PageHeader } from '../../components/layout/PageHeader';
import {
  Button,
  EmptyState,
  Input,
  Spinner,
  textMuted,
  textSubtle,
} from '../../components/ui';
import { useQuery, useMutation } from '../../lib/ipc';
import { cn } from '../../lib/utils';
import { formatRelative } from '../../lib/format';

const EMPTY_PAGE: MemoryPage = {
  items: [],
  total: 0,
  page: 1,
  totalPages: 0,
  ready: false,
};

/** A debounced value — the search box shouldn't fire a request per keystroke. */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export function MemoryScreen() {
  const [rawQuery, setRawQuery] = useState('');
  const query = useDebounced(rawQuery.trim(), 250);
  const searching = query.length > 0;

  const status = useQuery(IPC.memory.status, {}, { pollMs: 5000 });
  const ready = status.data?.ready ?? false;
  const enabled = status.data?.enabled ?? true;

  const list = useQuery(
    IPC.memory.list,
    { page: 1, limit: 100 },
    {
      enabled: ready && !searching,
    },
  );
  const search = useQuery(
    IPC.memory.search,
    { query, limit: 30 },
    { enabled: ready && searching },
  );

  const active = searching ? search : list;
  const page: MemoryPage = active.data ?? EMPTY_PAGE;

  const forget = useMutation(IPC.memory.forget, {
    onSuccess: () => {
      void list.refetch();
      if (searching) void search.refetch();
    },
  });
  const retry = useMutation(IPC.memory.retry, {
    onSuccess: () => {
      // The retry re-adds the content as a new document; refresh to show it.
      void list.refetch();
    },
  });

  const refetchAll = (): void => {
    void status.refetch();
    void list.refetch();
    if (searching) void search.refetch();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Memory"
        description="What the assistant remembers about you — kept on this machine."
        actions={<AddMemory onAdded={refetchAll} disabled={!ready} />}
        toolbar={
          <div className="relative w-full max-w-md">
            <Search
              size={15}
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400"
            />
            <Input
              value={rawQuery}
              onChange={(e) => setRawQuery(e.target.value)}
              placeholder="Search memories…"
              className="pl-9 pr-9"
              aria-label="Search memories"
            />
            {rawQuery ? (
              <button
                type="button"
                onClick={() => setRawQuery('')}
                aria-label="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
              >
                <X size={15} />
              </button>
            ) : null}
          </div>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-5 py-5">
          <MemoryBody
            enabled={enabled}
            ready={ready}
            loading={active.loading}
            searching={searching}
            items={page.items}
            retrying={retry.pending}
            onForget={(id) => {
              void forget.mutate({ id });
            }}
            onRetry={(id) => {
              void retry.mutate({ id });
            }}
          />
        </div>
      </div>
    </div>
  );
}

function MemoryBody({
  enabled,
  ready,
  loading,
  searching,
  items,
  retrying,
  onForget,
  onRetry,
}: {
  enabled: boolean;
  ready: boolean;
  loading: boolean;
  searching: boolean;
  items: MemoryItem[];
  retrying: boolean;
  onForget: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  if (!enabled) {
    return (
      <EmptyState
        icon={Brain}
        title="Memory is turned off"
        description="Turn it on in Settings → Memory to let the assistant remember things about you."
      />
    );
  }
  if (!ready) {
    return (
      <div className={cn('flex items-center gap-2 py-10', textMuted)}>
        <Spinner size="sm" label={null} />
        Starting the memory engine… this can take a moment on first launch.
      </div>
    );
  }
  if (loading) {
    return (
      <div className={cn('flex items-center gap-2 py-10', textMuted)}>
        <Spinner size="sm" label={null} />
        Loading…
      </div>
    );
  }
  if (items.length === 0) {
    return searching ? (
      <EmptyState
        icon={Search}
        title="No matching memories"
        description="Nothing remembered matches that search yet."
      />
    ) : (
      <EmptyState
        icon={Brain}
        title="Nothing remembered yet"
        description="As you chat, the assistant will save preferences and facts about you here. You can also add one yourself."
      />
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => (
        <MemoryRow
          key={item.id}
          item={item}
          retrying={retrying}
          onForget={onForget}
          onRetry={onRetry}
        />
      ))}
    </ul>
  );
}

function MemoryRow({
  item,
  retrying,
  onForget,
  onRetry,
}: {
  item: MemoryItem;
  retrying: boolean;
  onForget: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  const failed = item.status === 'failed';
  const processing =
    item.status !== 'done' && item.status !== 'unknown' && !failed;
  return (
    <li className="group flex items-start gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] leading-relaxed text-zinc-800 dark:text-zinc-100">
          {item.memory || <span className={textMuted}>(empty)</span>}
        </p>
        <div
          className={cn(
            'mt-1 flex items-center gap-2 text-[11.5px]',
            textSubtle,
          )}
        >
          {item.createdAt ? (
            <span>{formatRelative(item.createdAt, Date.now())}</span>
          ) : null}
          {failed ? (
            <span className="rounded-full bg-rose-100 px-1.5 py-0.5 text-[10.5px] font-medium text-rose-700 dark:bg-rose-500/15 dark:text-rose-400">
              failed
            </span>
          ) : null}
          {processing ? (
            <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10.5px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-400">
              processing
            </span>
          ) : null}
        </div>
      </div>
      <div className="mt-0.5 flex shrink-0 items-center gap-1">
        {failed ? (
          <button
            type="button"
            onClick={() => onRetry(item.id)}
            disabled={retrying}
            aria-label="Retry this memory"
            title="Retry extraction"
            className="rounded p-1 text-zinc-400 transition hover:bg-indigo-50 hover:text-indigo-600 disabled:opacity-50 dark:hover:bg-indigo-500/10 dark:hover:text-indigo-400"
          >
            <RefreshCw size={15} className={retrying ? 'animate-spin' : ''} />
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => onForget(item.id)}
          aria-label="Forget this memory"
          className="rounded p-1 text-zinc-400 opacity-0 transition hover:bg-rose-50 hover:text-rose-600 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-rose-500/10 dark:hover:text-rose-400"
        >
          <Trash2 size={15} />
        </button>
      </div>
    </li>
  );
}

function AddMemory({
  onAdded,
  disabled,
}: {
  onAdded: () => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const add = useMutation(IPC.memory.add, {
    onSuccess: () => {
      setText('');
      setOpen(false);
      onAdded();
    },
  });

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const submit = (): void => {
    const content = text.trim();
    if (content) void add.mutate({ content });
  };

  const canAdd = useMemo(() => text.trim().length > 0, [text]);

  if (!open) {
    return (
      <Button
        size="sm"
        variant="secondary"
        icon={Plus}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        Add memory
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') setOpen(false);
        }}
        placeholder="Something to remember…"
        className="w-64"
      />
      <Button
        size="sm"
        variant="primary"
        loading={add.pending}
        disabled={!canAdd}
        onClick={submit}
      >
        Save
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setOpen(false);
          setText('');
        }}
      >
        Cancel
      </Button>
    </div>
  );
}

export default MemoryScreen;
