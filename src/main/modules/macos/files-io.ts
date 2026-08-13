/**
 * Node filesystem helpers for the file tools.
 *
 * Paths are arguments to `fs` APIs only — never interpolated into a shell or
 * AppleScript source. Trash is not here: moving to Trash is a Finder verb.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fullDiskAccessRemediation, MacosError } from './errors';
import type { FileListEntry, OpContext } from './providers/types';

export const FILE_LIST_LIMIT = 200;

export function resolveUserPath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) {
    return path.resolve(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

export function unsupportedFileOp(op: string): never {
  throw new MacosError({
    kind: 'unsupported',
    message: `This provider does not implement ${op}.`,
  });
}

export function ensureNotAborted(ctx: OpContext): void {
  if (ctx.signal?.aborted) {
    throw new MacosError({
      kind: 'timeout',
      message: 'The file operation was cancelled.',
    });
  }
}

export function mapFsError(cause: unknown, target: string): MacosError {
  if (cause instanceof MacosError) return cause;
  const err = cause as NodeJS.ErrnoException;
  const code = err?.code;
  if (code === 'ENOENT') {
    return new MacosError({
      kind: 'not-found',
      message: `Nothing exists at ${target}.`,
    });
  }
  if (code === 'EACCES' || code === 'EPERM') {
    const message = `Access to ${target} was denied.`;
    if (process.platform === 'darwin') {
      return new MacosError({
        kind: 'full-disk-access-required',
        message,
        remediation: fullDiskAccessRemediation(message),
      });
    }
    return new MacosError({
      kind: 'permission-denied',
      message: `Permission denied for ${target}.`,
    });
  }
  if (code === 'EISDIR') {
    return new MacosError({
      kind: 'unsupported',
      message: `${target} is a folder, not a file.`,
    });
  }
  if (code === 'ENOTDIR') {
    return new MacosError({
      kind: 'unsupported',
      message: `${target} is not a folder.`,
    });
  }
  if (code === 'EEXIST') {
    return new MacosError({
      kind: 'unsupported',
      message: `${target} already exists and is not a folder.`,
    });
  }
  return new MacosError({
    kind: 'unknown',
    message: err?.message || `The file operation failed for ${target}.`,
    cause,
  });
}

export async function createFile(
  filePath: string,
  content: string,
): Promise<{ path: string }> {
  const resolved = resolveUserPath(filePath);
  try {
    await fsp.mkdir(path.dirname(resolved), { recursive: true });
    await fsp.writeFile(resolved, content, 'utf8');
    return { path: resolved };
  } catch (cause) {
    throw mapFsError(cause, resolved);
  }
}

export async function readFileText(
  filePath: string,
  maxChars: number,
): Promise<{
  path: string;
  content: string;
  truncated: boolean;
  chars: number;
}> {
  const resolved = resolveUserPath(filePath);
  try {
    const stat = await fsp.stat(resolved);
    if (stat.isDirectory()) {
      throw new MacosError({
        kind: 'unsupported',
        message: `${resolved} is a folder, not a file.`,
      });
    }
    const cap = Math.max(0, maxChars);
    const byteCap = Math.min(stat.size, cap * 4);
    const handle = await fsp.open(resolved, 'r');
    try {
      const buf = Buffer.alloc(byteCap);
      const { bytesRead } =
        byteCap > 0 ? await handle.read(buf, 0, byteCap, 0) : { bytesRead: 0 };
      const decoded = buf.subarray(0, bytesRead).toString('utf8');
      const truncatedByChars = decoded.length > cap;
      const content = truncatedByChars ? decoded.slice(0, cap) : decoded;
      return {
        path: resolved,
        content,
        truncated: truncatedByChars || bytesRead < stat.size,
        chars: content.length,
      };
    } finally {
      await handle.close();
    }
  } catch (cause) {
    throw mapFsError(cause, resolved);
  }
}

export async function movePath(
  from: string,
  to: string,
): Promise<{ from: string; to: string }> {
  const src = resolveUserPath(from);
  const dest = resolveUserPath(to);
  try {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fsp.rename(src, dest);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EXDEV') throw cause;
      await fsp.cp(src, dest, { recursive: true });
      await fsp.rm(src, { recursive: true, force: true });
    }
    return { from: src, to: dest };
  } catch (cause) {
    throw mapFsError(cause, src);
  }
}

export async function listDir(
  dir: string,
  limit = FILE_LIST_LIMIT,
): Promise<{
  dir: string;
  entries: FileListEntry[];
  truncated: boolean;
}> {
  const resolved = resolveUserPath(dir);
  try {
    const stat = await fsp.stat(resolved);
    if (!stat.isDirectory()) {
      throw new MacosError({
        kind: 'unsupported',
        message: `${resolved} is not a folder.`,
      });
    }
    const dirents = await fsp.readdir(resolved, { withFileTypes: true });
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    const truncated = dirents.length > limit;
    const entries = dirents.slice(0, limit).map((entry) => ({
      name: entry.name,
      path: path.join(resolved, entry.name),
      kind: entry.isDirectory() ? ('dir' as const) : ('file' as const),
    }));
    return { dir: resolved, entries, truncated };
  } catch (cause) {
    throw mapFsError(cause, resolved);
  }
}

export async function makeFolder(dirPath: string): Promise<{ path: string }> {
  const resolved = resolveUserPath(dirPath);
  try {
    await fsp.mkdir(resolved, { recursive: true });
    return { path: resolved };
  } catch (cause) {
    throw mapFsError(cause, resolved);
  }
}
