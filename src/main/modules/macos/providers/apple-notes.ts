/**
 * Apple Notes as a `notes` provider.
 *
 * Only create is offered as a write. There is no update and no delete: a note is
 * the user's own writing, an overwrite is not recoverable through any UI they
 * have, and "append to the wrong note" is a data-loss bug wearing a helpful
 * face. Creating a new note is always additive.
 */
import { buildArgv } from '../escape';
import { NoteCreatedSchema, NoteSchema, NotesSearchSchema } from '../schema';
import type { CapabilityOp } from '../version';
import {
  boolArg,
  checkAppleApp,
  optionalDate,
  supportsOp,
  type AppleProviderDeps,
} from './apple-base';
import type { CapabilityProvider, NotesOps } from './types';

const OPS: readonly CapabilityOp[] = [
  'notes.search',
  'notes.note',
  'notes.create',
];

export function createAppleNotesProvider(
  deps: AppleProviderDeps,
): CapabilityProvider<'notes'> {
  const operations: NotesOps = {
    async search(input, ctx) {
      const result = await deps.runner.runScript({
        script: 'notes-search',
        appId: 'notes',
        args: buildArgv([
          input.query,
          input.limit,
          input.folder ?? '',
          input.scanLimit,
          boolArg(input.searchBodies),
        ]),
        schema: NotesSearchSchema,
        signal: ctx.signal,
      });
      return {
        notes: result.notes.map((note) => ({
          ref: { id: note.id },
          title: note.title,
          modifiedAt: optionalDate(note.modifiedAt),
          snippet: note.snippet,
        })),
        scanned: result.scanned,
        bodiesSearched: result.bodiesSearched,
      };
    },

    async note(input, ctx) {
      const result = await deps.runner.runScript({
        script: 'notes-note',
        appId: 'notes',
        args: buildArgv([input.ref.id, input.maxChars]),
        schema: NoteSchema,
        signal: ctx.signal,
      });
      if (!result.found) return null;
      return {
        ref: { id: result.id },
        title: result.title,
        createdAt: optionalDate(result.createdAt),
        modifiedAt: optionalDate(result.modifiedAt),
        snippet: '',
        body: result.body,
        bodyTruncated: result.bodyTruncated,
      };
    },

    async create(input, ctx) {
      const result = await deps.runner.runScript({
        script: 'notes-create',
        appId: 'notes',
        args: buildArgv([input.title, input.body, input.folder ?? '']),
        schema: NoteCreatedSchema,
        signal: ctx.signal,
      });
      return { id: result.id, title: result.title };
    },
  };

  return {
    id: 'apple-notes',
    capability: 'notes',
    name: 'Apple Notes',
    tier: 'local-app',
    platforms: ['darwin'],
    ops: OPS,
    check: () => checkAppleApp('notes', deps),
    supports: (op) => supportsOp(op, deps),
    operations,
  };
}
