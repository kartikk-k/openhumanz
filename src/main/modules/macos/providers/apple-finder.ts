/**
 * Finder as a `files` provider: the current selection, and moving a path to
 * Trash.
 *
 * Selection is UI state Node cannot see. Trash is a Finder verb — the same
 * `delete` that puts an item in the Trash so the user can restore it. There is
 * no empty-trash operation and no hard delete. Text I/O (create, read, move,
 * list, mkdir) lives on the local-filesystem provider and uses Node `fs`, not
 * AppleScript. There is no generic shell.
 */
import fsp from 'node:fs/promises';
import { buildArgv } from '../escape';
import { mapFsError, resolveUserPath, unsupportedFileOp } from '../files-io';
import { FinderSelectionSchema, FinderTrashSchema } from '../schema';
import type { CapabilityOp } from '../version';
import {
  checkAppleApp,
  supportsOp,
  type AppleProviderDeps,
} from './apple-base';
import type { CapabilityProvider, FilesOps } from './types';

const OPS: readonly CapabilityOp[] = ['files.finder-selection', 'files.trash'];

export function createAppleFinderProvider(
  deps: AppleProviderDeps,
): CapabilityProvider<'files'> {
  const operations: FilesOps = {
    async selection(input, ctx) {
      const result = await deps.runner.runScript({
        script: 'finder-selection',
        appId: 'finder',
        args: buildArgv([input.limit]),
        schema: FinderSelectionSchema,
        signal: ctx.signal,
      });
      return {
        selection: result.selection.map((entry) => ({
          path: entry.path,
          name: entry.name,
        })),
        frontWindowPath: result.frontWindowPath,
      };
    },

    async trash(input, ctx) {
      const resolved = resolveUserPath(input.path);
      try {
        await fsp.access(resolved);
      } catch (cause) {
        throw mapFsError(cause, resolved);
      }
      const result = await deps.runner.runScript({
        script: 'finder-trash',
        appId: 'finder',
        args: buildArgv([resolved]),
        schema: FinderTrashSchema,
        signal: ctx.signal,
      });
      return { path: result.path || resolved };
    },

    create: async () => unsupportedFileOp('files.create'),
    read: async () => unsupportedFileOp('files.read'),
    move: async () => unsupportedFileOp('files.move'),
    list: async () => unsupportedFileOp('files.list'),
    makeFolder: async () => unsupportedFileOp('files.make-folder'),
  };

  return {
    id: 'apple-finder',
    capability: 'files',
    name: 'Finder',
    tier: 'local-app',
    platforms: ['darwin'],
    ops: OPS,
    check: () => checkAppleApp('finder', deps),
    supports: (op) => supportsOp(op, deps),
    operations,
  };
}
