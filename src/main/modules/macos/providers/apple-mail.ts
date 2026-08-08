/**
 * Apple Mail as a `mail` provider.
 *
 * The mapping layer between AppleScript's world and the neutral interface lives
 * here and nowhere else. In particular: a Mail message `id` is only unique
 * within its mailbox, so it is never handed out bare — the `ItemRef` carries the
 * mailbox and account alongside it, and `mail_get_message` hands the whole ref
 * back. A caller that passed just the number would silently read a different
 * message from a different account.
 */
import { buildArgv, joinArgList } from '../escape';
import {
  MailboxesSchema,
  MailDraftSchema,
  MailMessageSchema,
  MailSearchResultSchema,
  MailUnreadSchema,
} from '../schema';
import type { CapabilityOp } from '../version';
import {
  boolArg,
  checkAppleApp,
  optionalDate,
  supportsOp,
  type AppleProviderDeps,
} from './apple-base';
import type { CapabilityProvider, MailOps } from './types';

const OPS: readonly CapabilityOp[] = [
  'mail.mailboxes',
  'mail.search',
  'mail.message',
  'mail.unread-count',
  'mail.create-draft',
];

export function createAppleMailProvider(
  deps: AppleProviderDeps,
): CapabilityProvider<'mail'> {
  const operations: MailOps = {
    async folders(ctx) {
      const result = await deps.runner.runScript({
        script: 'mail-mailboxes',
        appId: 'mail',
        schema: MailboxesSchema,
        signal: ctx.signal,
      });
      return {
        accounts: result.accounts.map((account) => ({
          account: account.account,
          enabled: account.enabled,
          mailboxes: account.mailboxes,
        })),
      };
    },

    async search(input, ctx) {
      const result = await deps.runner.runScript({
        script: 'mail-search',
        appId: 'mail',
        args: buildArgv([
          input.query,
          input.mailbox,
          input.account ?? '',
          input.limit,
          boolArg(input.unreadOnly),
          input.scanLimit,
        ]),
        schema: MailSearchResultSchema,
        signal: ctx.signal,
      });
      return {
        messages: result.messages.map((message) => ({
          ref: {
            id: message.id,
            scope: message.mailbox,
            container: message.account,
          },
          subject: message.subject,
          from: message.sender,
          receivedAt: optionalDate(message.receivedAt),
          unread: message.unread,
          mailbox: message.mailbox,
          account: message.account,
        })),
        scanned: result.scanned,
        scanTruncated: result.scanTruncated,
      };
    },

    async message(input, ctx) {
      const result = await deps.runner.runScript({
        script: 'mail-message',
        appId: 'mail',
        args: buildArgv([
          input.ref.id,
          input.ref.scope ?? 'INBOX',
          input.ref.container ?? '',
          input.maxChars,
        ]),
        schema: MailMessageSchema,
        signal: ctx.signal,
      });
      if (!result.found) return null;
      return {
        ref: {
          id: result.id,
          scope: result.mailbox,
          container: result.account,
        },
        subject: result.subject,
        from: result.sender,
        replyTo: result.replyTo,
        to: result.recipients,
        receivedAt: optionalDate(result.receivedAt),
        unread: result.unread,
        mailbox: result.mailbox,
        account: result.account,
        body: result.body,
        bodyTruncated: result.bodyTruncated,
      };
    },

    async unreadCount(input, ctx) {
      const result = await deps.runner.runScript({
        script: 'mail-unread-count',
        appId: 'mail',
        args: buildArgv([input.mailbox]),
        schema: MailUnreadSchema,
        signal: ctx.signal,
      });
      return {
        total: result.unread,
        byAccount: result.accounts.map((entry) => ({
          account: entry.account,
          unread: entry.unread,
        })),
      };
    },

    async createDraft(input, ctx) {
      const result = await deps.runner.runScript({
        script: 'mail-create-draft',
        appId: 'mail',
        args: buildArgv([
          joinArgList(input.to),
          joinArgList(input.cc),
          joinArgList(input.bcc),
          input.subject,
          input.body,
          input.from ?? '',
        ]),
        schema: MailDraftSchema,
        signal: ctx.signal,
      });
      return {
        opened: result.opened,
        draftId: result.draftId,
        recipientCount: result.recipientCount,
      };
    },
  };

  return {
    id: 'apple-mail',
    capability: 'mail',
    name: 'Apple Mail',
    tier: 'local-app',
    platforms: ['darwin'],
    ops: OPS,
    check: () => checkAppleApp('mail', deps),
    supports: (op) => supportsOp(op, deps),
    operations,
  };
}
