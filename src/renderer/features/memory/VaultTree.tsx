/**
 * The vault, as a folder tree.
 *
 * A real `role="tree"` with roving focus, because this is the primary
 * navigation for the screen and reaching for the mouse to move between notes
 * would be the wrong feel for a desktop tool: Up/Down move, Right opens a
 * folder, Left closes it or jumps to the parent, Home/End go to the ends.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import {
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  ListFilter,
  X,
} from 'lucide-react';
import type { MemoryDoc } from '../../../shared/memory';
import { cn } from '../../lib/utils';
import { formatBytes, formatRelative } from '../../lib/format';
import { Button, Input } from '../../components/ui';
import { focusRingInset, textMuted } from '../../components/ui/styles';
import {
  allFolders,
  ancestorFolders,
  buildTree,
  flattenTree,
  type TreeRow,
} from './tree';

export interface VaultTreeProps {
  docs: readonly MemoryDoc[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  className?: string;
}

function rowKey(row: TreeRow): string {
  return `${row.node.kind}:${row.node.path}`;
}

export function VaultTree({
  docs,
  selectedPath,
  onSelect,
  className,
}: VaultTreeProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState(0);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const seeded = useRef(false);

  const tree = useMemo(() => buildTree(docs), [docs]);

  // First-run: open every folder in a small vault, nothing in a large one.
  // A tree that starts entirely collapsed reads as an empty vault.
  useEffect(() => {
    if (seeded.current || docs.length === 0) return;
    seeded.current = true;
    const folders = allFolders(tree);
    if (folders.length <= 24) setExpanded(new Set(folders));
  }, [docs.length, tree]);

  // Reveal the selected document wherever it lives.
  useEffect(() => {
    if (!selectedPath) return;
    const needed = ancestorFolders(selectedPath);
    if (needed.length === 0) return;
    setExpanded((previous) => {
      if (needed.every((path) => previous.has(path))) return previous;
      const next = new Set(previous);
      for (const path of needed) next.add(path);
      return next;
    });
  }, [selectedPath]);

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return null;
    return docs
      .filter(
        (doc) =>
          doc.path.toLowerCase().includes(needle) ||
          doc.title.toLowerCase().includes(needle),
      )
      .slice(0, 300);
  }, [docs, filter]);

  const rows = useMemo(
    () => (filtered ? [] : flattenTree(tree, expanded)),
    [filtered, tree, expanded],
  );

  const toggle = useCallback((path: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const focusRow = useCallback((index: number) => {
    setActive(index);
    rowRefs.current[index]?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (rows.length === 0) return;
    const index = Math.min(active, rows.length - 1);
    const row = rows[index];

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusRow(Math.min(rows.length - 1, index + 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusRow(Math.max(0, index - 1));
        break;
      case 'Home':
        event.preventDefault();
        focusRow(0);
        break;
      case 'End':
        event.preventDefault();
        focusRow(rows.length - 1);
        break;
      case 'ArrowRight':
        if (row.node.kind === 'folder' && !row.expanded) {
          event.preventDefault();
          toggle(row.node.path);
        } else if (row.node.kind === 'folder') {
          event.preventDefault();
          focusRow(Math.min(rows.length - 1, index + 1));
        }
        break;
      case 'ArrowLeft':
        event.preventDefault();
        if (row.node.kind === 'folder' && row.expanded) {
          toggle(row.node.path);
          break;
        }
        // Jump to the enclosing folder row.
        for (let i = index - 1; i >= 0; i -= 1) {
          if (rows[i].depth < row.depth) {
            focusRow(i);
            break;
          }
        }
        break;
      default:
        break;
    }
  };

  const filterField = (
    <div className="border-b border-zinc-200 px-2 py-2 dark:border-zinc-800">
      <Input
        size="sm"
        icon={ListFilter}
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder="Filter by name"
        aria-label="Filter files by name"
        trailing={
          filter ? (
            <Button
              size="icon-sm"
              variant="ghost"
              icon={X}
              aria-label="Clear filter"
              className="h-5 w-5"
              onClick={() => setFilter('')}
            />
          ) : null
        }
      />
    </div>
  );

  if (filtered) {
    return (
      <div className={cn('flex min-h-0 flex-col', className)}>
        {filterField}
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <p className={cn('px-3 py-6 text-center text-xs', textMuted)}>
              No file name matches “{filter.trim()}”.
            </p>
          ) : (
            filtered.map((doc) => (
              <button
                key={doc.path}
                type="button"
                onClick={() => onSelect(doc.path)}
                title={doc.path}
                className={cn(
                  'flex w-full items-center gap-1.5 px-2 py-1 text-left transition-colors',
                  focusRingInset,
                  doc.path === selectedPath
                    ? 'bg-indigo-50 dark:bg-indigo-500/10'
                    : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/60',
                )}
              >
                <FileText
                  size={13}
                  aria-hidden="true"
                  className="shrink-0 text-zinc-400 dark:text-zinc-500"
                />
                <span
                  className={cn(
                    'truncate text-[12px]',
                    doc.path === selectedPath
                      ? 'font-medium text-indigo-700 dark:text-indigo-300'
                      : 'text-zinc-700 dark:text-zinc-300',
                  )}
                >
                  {doc.path}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      {filterField}
      {/*
        Focus lives on the rows (roving `tabIndex`), which is the tree pattern;
        the container carries `tabIndex={-1}` so it is a valid focus target for
        the keyboard handler rather than an unreachable interactive element.
      */}
      <div
        role="tree"
        aria-label="Memory vault"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-y-auto py-1 outline-none"
      >
        {rows.length === 0 ? (
          <p className={cn('px-3 py-6 text-center text-[11px]', textMuted)}>
            No files here yet.
          </p>
        ) : null}
        {rows.map((row, index) => {
          const { node } = row;
          const isSelected = node.kind === 'file' && node.path === selectedPath;
          const doc = node.kind === 'file' ? node.doc : null;

          return (
            <button
              key={rowKey(row)}
              ref={(element) => {
                rowRefs.current[index] = element;
              }}
              type="button"
              role="treeitem"
              aria-level={row.depth + 1}
              aria-selected={isSelected}
              aria-expanded={node.kind === 'folder' ? row.expanded : undefined}
              tabIndex={index === Math.min(active, rows.length - 1) ? 0 : -1}
              title={
                doc
                  ? `${doc.path}\n${formatBytes(doc.sizeBytes)} · edited ${formatRelative(doc.updatedAt)}`
                  : node.path
              }
              onFocus={() => setActive(index)}
              onClick={() => {
                if (node.kind === 'folder') toggle(node.path);
                else onSelect(node.path);
              }}
              style={{ paddingLeft: `${8 + row.depth * 12}px` }}
              className={cn(
                'flex w-full items-center gap-1.5 py-1 pr-2 text-left transition-colors',
                focusRingInset,
                isSelected
                  ? 'bg-indigo-50 dark:bg-indigo-500/10'
                  : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/60',
              )}
            >
              {node.kind === 'folder' ? (
                <>
                  <ChevronRight
                    size={12}
                    aria-hidden="true"
                    className={cn(
                      'shrink-0 text-zinc-400 transition-transform dark:text-zinc-500',
                      row.expanded && 'rotate-90',
                    )}
                  />
                  {row.expanded ? (
                    <FolderOpen
                      size={13}
                      aria-hidden="true"
                      className="shrink-0 text-zinc-400 dark:text-zinc-500"
                    />
                  ) : (
                    <Folder
                      size={13}
                      aria-hidden="true"
                      className="shrink-0 text-zinc-400 dark:text-zinc-500"
                    />
                  )}
                  <span className="truncate text-[12px] font-medium text-zinc-700 dark:text-zinc-300">
                    {node.name}
                  </span>
                  <span
                    className={cn(
                      'ml-auto shrink-0 pl-1 text-[10px] tabular-nums',
                      textMuted,
                    )}
                  >
                    {node.fileCount}
                  </span>
                </>
              ) : (
                <>
                  <span className="w-3 shrink-0" aria-hidden="true" />
                  <FileText
                    size={13}
                    aria-hidden="true"
                    className="shrink-0 text-zinc-400 dark:text-zinc-500"
                  />
                  <span
                    className={cn(
                      'truncate text-[12px]',
                      isSelected
                        ? 'font-medium text-indigo-700 dark:text-indigo-300'
                        : 'text-zinc-700 dark:text-zinc-300',
                    )}
                  >
                    {doc?.title || node.name}
                  </span>
                </>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default VaultTree;
