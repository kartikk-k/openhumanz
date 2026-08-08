/**
 * The vault as a folder tree.
 *
 * `memory:list` returns a flat page of docs whose `path` is POSIX and
 * vault-relative (`people/ana.md`). The browser shows folders because the vault
 * *is* folders, so the flat list is folded back into a tree here — pure
 * functions, no React, so the shape is testable on its own.
 */
import type { MemoryDoc } from '../../../shared/memory';

export interface TreeFile {
  kind: 'file';
  /** Full vault-relative path — also the node's stable key. */
  path: string;
  /** Last path segment, e.g. `ana.md`. */
  name: string;
  doc: MemoryDoc;
}

export interface TreeFolder {
  kind: 'folder';
  /** Vault-relative folder path, `''` for the root. */
  path: string;
  name: string;
  children: TreeNode[];
  /** Documents at or below this folder. */
  fileCount: number;
  /** Bytes at or below this folder. */
  sizeBytes: number;
}

export type TreeNode = TreeFolder | TreeFile;

function emptyFolder(path: string, name: string): TreeFolder {
  return {
    kind: 'folder',
    path,
    name,
    children: [],
    fileCount: 0,
    sizeBytes: 0,
  };
}

/** Folders first, then files; each group alphabetical and case-insensitive. */
function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

function sortRecursive(folder: TreeFolder): void {
  folder.children.sort(compareNodes);
  for (const child of folder.children) {
    if (child.kind === 'folder') sortRecursive(child);
  }
}

/**
 * Fold a flat doc list into a tree.
 *
 * A doc whose path has no separator lands at the root. Empty segments and a
 * leading slash are tolerated — these paths are written by an agent as well as
 * by the indexer.
 */
export function buildTree(docs: readonly MemoryDoc[]): TreeFolder {
  const root = emptyFolder('', '');
  const folders = new Map<string, TreeFolder>([['', root]]);

  for (const doc of docs) {
    const segments = doc.path.split('/').filter(Boolean);
    if (segments.length === 0) continue;
    const name = segments[segments.length - 1];

    let parent = root;
    let prefix = '';
    for (const segment of segments.slice(0, -1)) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      let folder = folders.get(prefix);
      if (!folder) {
        folder = emptyFolder(prefix, segment);
        folders.set(prefix, folder);
        parent.children.push(folder);
      }
      parent = folder;
    }

    parent.children.push({ kind: 'file', path: doc.path, name, doc });

    // Roll the counts up every ancestor, including the root.
    let cursor = '';
    root.fileCount += 1;
    root.sizeBytes += doc.sizeBytes;
    for (const segment of segments.slice(0, -1)) {
      cursor = cursor ? `${cursor}/${segment}` : segment;
      const folder = folders.get(cursor);
      if (!folder) continue;
      folder.fileCount += 1;
      folder.sizeBytes += doc.sizeBytes;
    }
  }

  sortRecursive(root);
  return root;
}

export interface TreeRow {
  node: TreeNode;
  depth: number;
  expanded: boolean;
}

/**
 * Depth-first walk of the visible rows, given the set of expanded folder
 * paths. The tree renders from this — one flat array, one map, no recursion in
 * the component.
 */
export function flattenTree(
  root: TreeFolder,
  expanded: ReadonlySet<string>,
): TreeRow[] {
  const rows: TreeRow[] = [];

  const walk = (folder: TreeFolder, depth: number): void => {
    for (const child of folder.children) {
      if (child.kind === 'file') {
        rows.push({ node: child, depth, expanded: false });
        continue;
      }
      const open = expanded.has(child.path);
      rows.push({ node: child, depth, expanded: open });
      if (open) walk(child, depth + 1);
    }
  };

  walk(root, 0);
  return rows;
}

/** Every folder path containing `docPath` — what to expand to reveal it. */
export function ancestorFolders(docPath: string): string[] {
  const segments = docPath.split('/').filter(Boolean).slice(0, -1);
  const out: string[] = [];
  let prefix = '';
  for (const segment of segments) {
    prefix = prefix ? `${prefix}/${segment}` : segment;
    out.push(prefix);
  }
  return out;
}

/** Every folder path in the tree — for expand-all. */
export function allFolders(root: TreeFolder): string[] {
  const out: string[] = [];
  const walk = (folder: TreeFolder): void => {
    for (const child of folder.children) {
      if (child.kind !== 'folder') continue;
      out.push(child.path);
      walk(child);
    }
  };
  walk(root);
  return out;
}

/** Distinct tags across the vault, with counts, most used first. */
export function collectTags(
  docs: readonly MemoryDoc[],
): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const doc of docs) {
    for (const tag of doc.tags) {
      const key = tag.trim();
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** Directory portion of a vault path, `''` at the root. */
export function dirname(docPath: string): string {
  const at = docPath.lastIndexOf('/');
  return at === -1 ? '' : docPath.slice(0, at);
}

/** Last segment of a vault path. */
export function basename(docPath: string): string {
  const at = docPath.lastIndexOf('/');
  return at === -1 ? docPath : docPath.slice(at + 1);
}

/**
 * Join the vault root and a relative path for display.
 *
 * Display only — the renderer never touches the filesystem. This is what the
 * copy-path button puts on the clipboard, and it has to be the real absolute
 * path or it is useless.
 */
export function absolutePath(vaultPath: string, docPath: string): string {
  if (!vaultPath) return docPath;
  return `${vaultPath.replace(/\/+$/, '')}/${docPath.replace(/^\/+/, '')}`;
}

/* ------------------------------------------------------------------ */
/* Path validation for the write form                                  */
/* ------------------------------------------------------------------ */

export interface PathCheck {
  ok: boolean;
  /** Cleaned path to submit, when `ok`. */
  value: string;
  error?: string;
}

/**
 * Validate a path the user typed into the write form.
 *
 * The main process re-checks all of this (`isInside`, atomic write) — this is
 * the copy that can say *why* before anything is written to disk.
 */
export function checkVaultPath(raw: string): PathCheck {
  const value = raw
    .trim()
    .replace(/^\.?\/+/, '')
    .replace(/\\/g, '/');
  if (!value) return { ok: false, value, error: 'A file name is required.' };
  if (value.length > 240) {
    return { ok: false, value, error: 'That path is too long.' };
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '..')) {
    return {
      ok: false,
      value,
      error: 'A path cannot climb out of the vault with `..`.',
    };
  }
  if (segments.some((segment) => segment === '')) {
    return {
      ok: false,
      value,
      error: 'A path cannot contain an empty folder.',
    };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f:*?"<>|]/.test(value)) {
    return {
      ok: false,
      value,
      error: 'That path contains illegal characters.',
    };
  }
  if (!/\.mdx?$/i.test(value)) {
    return {
      ok: false,
      value,
      error: 'The vault holds Markdown — end with `.md`.',
    };
  }
  return { ok: true, value };
}
