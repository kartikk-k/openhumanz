/**
 * The plain-file side of storage.
 *
 * Structured state lives in SQLite; content lives in files a human can open.
 * Everything that writes goes through {@link writeFileAtomic} — temp file in
 * the same directory, fsync, rename — so a crash mid-write never truncates a
 * memory note or the database.
 */
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export interface FileEntry {
  /** Base name, e.g. `ana.md`. */
  name: string;
  /** Absolute path. */
  path: string;
  /** Path relative to the directory that was listed, POSIX separators. */
  relativePath: string;
  isDirectory: boolean;
  sizeBytes: number;
  /** ISO-8601. */
  modifiedAt: string;
  modifiedMs: number;
}

export interface ListFilesOptions {
  /** Descend into subdirectories. Default false. */
  recursive?: boolean;
  /** Keep only these extensions, with the dot, e.g. `['.md']`. */
  extensions?: string[];
  /** Include directory entries in the result. Default false. */
  includeDirectories?: boolean;
  /** Skip dotfiles and dot-directories. Default true. */
  skipHidden?: boolean;
  /** Stop after this many entries. */
  limit?: number;
}

export interface WriteOptions {
  /** File mode, e.g. `0o600` for anything holding a secret. */
  mode?: number;
  /** fsync the file before rename. Default true. */
  fsync?: boolean;
}

/** Convert a platform path to POSIX separators, for storage and display. */
export function toPosixPath(input: string): string {
  return input.split(path.sep).join('/');
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

/** `stat`, or null when the path does not exist. Other errors still throw. */
export async function statOrNull(target: string): Promise<fs.Stats | null> {
  try {
    return await fsp.stat(target);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw cause;
  }
}

export async function ensureDir(dir: string, mode?: number): Promise<string> {
  await fsp.mkdir(dir, { recursive: true, mode });
  return dir;
}

/** File contents as UTF-8, or null when the file does not exist. */
export async function readTextFile(file: string): Promise<string | null> {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw cause;
  }
}

/** File contents as bytes, or null when the file does not exist. */
export async function readFileBytes(file: string): Promise<Uint8Array | null> {
  try {
    return await fsp.readFile(file);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw cause;
  }
}

/**
 * Write via temp + rename, so readers see either the old file or the new one
 * and never a half-written one. The temp file is created in the destination
 * directory because rename is only atomic within a filesystem.
 */
export async function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
  options: WriteOptions = {},
): Promise<void> {
  const { mode, fsync = true } = options;
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });

  const temp = path.join(
    dir,
    `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`,
  );

  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(temp, 'w', mode ?? 0o666);
    await handle.writeFile(data);
    if (fsync) await handle.sync();
    await handle.close();
    handle = undefined;
    if (mode !== undefined) await fsp.chmod(temp, mode);
    await fsp.rename(temp, file);
  } catch (cause) {
    if (handle) await handle.close().catch(() => undefined);
    await fsp.rm(temp, { force: true }).catch(() => undefined);
    throw cause;
  }
}

/** UTF-8 alias of {@link writeFileAtomic}. */
export async function writeTextFileAtomic(
  file: string,
  content: string,
  options?: WriteOptions,
): Promise<void> {
  return writeFileAtomic(file, content, options);
}

/**
 * Append, creating parent directories as needed. Append is not atomic, and it
 * does not need to be: transcripts and stderr logs are line-oriented and a
 * torn tail is recoverable.
 */
export async function appendTextFile(
  file: string,
  content: string,
): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.appendFile(file, content, 'utf8');
}

/** Append one JSON value as a line. Used for `transcript.jsonl`. */
export async function appendJsonLine(
  file: string,
  value: unknown,
): Promise<void> {
  await appendTextFile(file, `${JSON.stringify(value)}\n`);
}

/**
 * Read a `.jsonl` file. Malformed lines are skipped rather than throwing —
 * a transcript truncated by a crash must still render.
 */
export async function readJsonLines<T = unknown>(
  file: string,
  options: { limit?: number; skip?: number } = {},
): Promise<T[]> {
  const raw = await readTextFile(file);
  if (raw === null) return [];
  const { limit, skip = 0 } = options;
  const out: T[] = [];
  let index = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    index += 1;
    if (index <= skip) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      continue;
    }
    if (limit !== undefined && out.length >= limit) break;
  }
  return out;
}

/**
 * Parse a JSON file. Returns null when the file is missing *or* unparseable,
 * so a corrupt settings file falls back to defaults instead of blocking start.
 */
export async function readJsonFile<T = unknown>(
  file: string,
): Promise<T | null> {
  const raw = await readTextFile(file);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writeJsonFileAtomic(
  file: string,
  value: unknown,
  options?: WriteOptions,
): Promise<void> {
  return writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, options);
}

export async function removeFile(file: string): Promise<void> {
  await fsp.rm(file, { force: true });
}

export async function removeDir(dir: string): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true });
}

/** Move a file, falling back to copy+unlink across filesystems. */
export async function movePath(from: string, to: string): Promise<void> {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  try {
    await fsp.rename(from, to);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EXDEV') throw cause;
    await fsp.copyFile(from, to);
    await fsp.rm(from, { force: true });
  }
}

/**
 * List a directory. Returns `[]` for a missing directory — an empty memory
 * vault is a normal first-run state, not an error.
 */
export async function listFiles(
  dir: string,
  options: ListFilesOptions = {},
): Promise<FileEntry[]> {
  const {
    recursive = false,
    extensions,
    includeDirectories = false,
    skipHidden = true,
    limit,
  } = options;

  const wanted = extensions?.map((ext) => ext.toLowerCase());
  const results: FileEntry[] = [];

  const walk = async (current: string): Promise<void> => {
    if (limit !== undefined && results.length >= limit) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw cause;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (limit !== undefined && results.length >= limit) return;
      if (skipHidden && entry.name.startsWith('.')) continue;

      const absolute = path.join(current, entry.name);
      const isDirectory = entry.isDirectory();

      if (isDirectory) {
        if (includeDirectories) {
          // Sequential on purpose: a directory listing has to stay ordered and
          // `limit` has to be respected.
          // eslint-disable-next-line no-await-in-loop
          results.push(await toEntry(dir, absolute, true));
        }
        if (recursive) {
          // eslint-disable-next-line no-await-in-loop
          await walk(absolute);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (wanted && !wanted.includes(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      results.push(await toEntry(dir, absolute, false));
    }
  };

  await walk(dir);
  return results;
}

async function toEntry(
  base: string,
  absolute: string,
  isDirectory: boolean,
): Promise<FileEntry> {
  const stats = await fsp.stat(absolute);
  return {
    name: path.basename(absolute),
    path: absolute,
    relativePath: toPosixPath(path.relative(base, absolute)),
    isDirectory,
    sizeBytes: isDirectory ? 0 : stats.size,
    modifiedAt: new Date(stats.mtimeMs).toISOString(),
    modifiedMs: stats.mtimeMs,
  };
}
