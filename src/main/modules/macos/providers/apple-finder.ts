/**
 * Finder as a `files` provider, offering exactly one thing: what the user has
 * selected.
 *
 * That is the piece Claude Code's native filesystem tools genuinely cannot
 * supply — "the files I am looking at right now" is UI state, not a path. Every
 * other Finder verb is either something the native tools already do better under
 * their own gate (read, search, move) or irreversible (trash, empty trash), and
 * neither belongs on a second, parallel filesystem surface.
 */
import { buildArgv } from '../escape';
import { FinderSelectionSchema } from '../schema';
import type { CapabilityOp } from '../version';
import {
  checkAppleApp,
  supportsOp,
  type AppleProviderDeps,
} from './apple-base';
import type { CapabilityProvider, FilesOps } from './types';

const OPS: readonly CapabilityOp[] = ['files.finder-selection'];

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
