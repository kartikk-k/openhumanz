/**
 * Apple Contacts as a `contacts` provider. Read-only by design: there is no
 * write operation on the contacts interface, so there is nothing for a tool to
 * reach. Editing someone's address book is high-consequence, hard to review from
 * a summary line, and not something the first version of this needs.
 */
import { buildArgv } from '../escape';
import { ContactSchema, ContactsSearchSchema } from '../schema';
import type { CapabilityOp } from '../version';
import {
  checkAppleApp,
  supportsOp,
  type AppleProviderDeps,
} from './apple-base';
import type { CapabilityProvider, ContactsOps } from './types';

const OPS: readonly CapabilityOp[] = ['contacts.search', 'contacts.person'];

export function createAppleContactsProvider(
  deps: AppleProviderDeps,
): CapabilityProvider<'contacts'> {
  const operations: ContactsOps = {
    async search(input, ctx) {
      const result = await deps.runner.runScript({
        script: 'contacts-search',
        appId: 'contacts',
        args: buildArgv([input.query, input.limit, input.scanLimit]),
        schema: ContactsSearchSchema,
        signal: ctx.signal,
      });
      return {
        contacts: result.contacts.map((contact) => ({
          ref: { id: contact.id },
          name: contact.name,
          organization: contact.organization,
          emails: contact.emails,
          phones: contact.phones,
        })),
        scanned: result.scanned,
      };
    },

    async person(input, ctx) {
      const result = await deps.runner.runScript({
        script: 'contacts-person',
        appId: 'contacts',
        args: buildArgv([input.ref.id, input.maxChars]),
        schema: ContactSchema,
        signal: ctx.signal,
      });
      if (!result.found) return null;
      return {
        ref: { id: result.id },
        name: result.name,
        organization: result.organization,
        jobTitle: result.jobTitle,
        emails: result.emails,
        phones: result.phones,
        note: result.note,
        noteTruncated: result.noteTruncated,
      };
    },
  };

  return {
    id: 'apple-contacts',
    capability: 'contacts',
    name: 'Apple Contacts',
    tier: 'local-app',
    platforms: ['darwin'],
    ops: OPS,
    check: () => checkAppleApp('contacts', deps),
    supports: (op) => supportsOp(op, deps),
    operations,
  };
}
