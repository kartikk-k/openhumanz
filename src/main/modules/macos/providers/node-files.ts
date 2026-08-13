/**
 * Local filesystem as a `files` provider.
 *
 * Text I/O (create, read, move, list, mkdir) uses Node `fs/promises`. Paths
 * never become shell or AppleScript source. Trash is a Finder verb and lives
 * on the Finder provider; there is no empty-trash operation and no generic
 * shell.
 */
import {
  createFile,
  ensureNotAborted,
  listDir,
  makeFolder,
  movePath,
  readFileText,
  unsupportedFileOp,
} from '../files-io';
import {
  checkOpSupport,
  type CapabilityOp,
  type MacosVersion,
} from '../version';
import type { CapabilityProvider, FilesOps } from './types';

const OPS: readonly CapabilityOp[] = [
  'files.create',
  'files.read',
  'files.move',
  'files.list',
  'files.make-folder',
];

export interface NodeFilesProviderDeps {
  version(): MacosVersion | null;
}

export function createNodeFilesProvider(
  deps: NodeFilesProviderDeps,
): CapabilityProvider<'files'> {
  const operations: FilesOps = {
    selection: async () => unsupportedFileOp('files.finder-selection'),
    trash: async () => unsupportedFileOp('files.trash'),

    async create(input, ctx) {
      ensureNotAborted(ctx);
      return createFile(input.path, input.content);
    },

    async read(input, ctx) {
      ensureNotAborted(ctx);
      return readFileText(input.path, input.maxChars);
    },

    async move(input, ctx) {
      ensureNotAborted(ctx);
      return movePath(input.from, input.to);
    },

    async list(input, ctx) {
      ensureNotAborted(ctx);
      return listDir(input.dir);
    },

    async makeFolder(input, ctx) {
      ensureNotAborted(ctx);
      return makeFolder(input.path);
    },
  };

  return {
    id: 'node-files',
    capability: 'files',
    name: 'Local filesystem',
    tier: 'local-protocol',
    platforms: ['darwin'],
    ops: OPS,
    check: async () => ({ usable: true }),
    supports: (op) => checkOpSupport(op, deps.version()),
    operations,
  };
}
