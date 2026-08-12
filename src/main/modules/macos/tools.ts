/**
 * The macOS slice of the MCP surface.
 *
 * Naming rule, and it is the one thing here that must not change: **a tool name
 * describes the capability, never the provider.** `mail_search`, not
 * `apple_mail_search`. The model learns a surface once; if swapping Apple Mail
 * for something else renamed half the tools, every prompt, every memory note and
 * every scheduled job that mentions them silently rots.
 *
 * What is deliberately absent, and must stay absent:
 *
 *  - **No send.** `mail_create_draft` opens a draft. There is no send tool, no
 *    send operation on the provider interface, and no `send` anywhere in the
 *    scripts. Three layers, because the cost of being wrong once is unbounded.
 *  - **No generic shell and no arbitrary-AppleScript tool.** Both are remote
 *    code execution with a friendly schema. See `shell-guard.ts`.
 *  - **No delete, no trash, no empty trash, no mark-complete.** Nothing here is
 *    irreversible from the user's own UI.
 *
 * `send_notification` is the one deliberate exception to the "no agent-callable
 * side channel" instinct: by product decision the agent must be able to alert
 * the user directly (a reminder firing, a task finishing) without routing
 * through a shell/osascript Bash call that hits the approval gate. It posts a
 * `display notification` banner — a message to the user, not a consequential
 * outside-world action — so it is marked non-side-effecting and always allowed.
 *
 * Every result is compact: lists are capped, bodies are truncated with an
 * explicit flag, and detail is fetched by id. Failures are values — a structured
 * `{ok:false, error}` the model can read and act on — never exceptions, and
 * never raw script output.
 */
import { z } from 'zod';
import { defineTool, type AnyToolDefinition } from '../types';
import { runProcess } from '../../infra/spawn';
import { appleScriptStringExpr } from './escape';
import { OSASCRIPT_PATH } from './osascript';
import { asMacosError, type RemediationCard } from './errors';
import {
  unavailableResult,
  type CapabilityRegistry,
  type Resolution,
} from './providers/registry';
import type { CapabilityId, CapabilityOps, OpContext } from './providers/types';
import type { CapabilityOp } from './version';

/* ------------------------------------------------------------------ */
/* Shared plumbing                                                     */
/* ------------------------------------------------------------------ */

export interface ToolDeps {
  registry: CapabilityRegistry;
  /** Provider-independent summary for `macos_capabilities`. */
  describeEnvironment(force: boolean): Promise<unknown>;
}

/** What every macOS tool returns on failure. */
interface FailureResult {
  ok: false;
  error: unknown;
  remediation?: RemediationCard;
}

/**
 * Resolve, run, and turn anything that goes wrong into a value.
 *
 * The `caveat` from resolution is attached to successful results, so a caller
 * that receives a mail search which only covered recent messages, or a calendar
 * that cannot expand recurrences, is told so in the same payload rather than
 * having to know.
 */
async function withCapability<C extends CapabilityId, TOut extends object>(
  deps: ToolDeps,
  capability: C,
  op: CapabilityOp,
  ctx: OpContext,
  run: (operations: CapabilityOps[C], ctx: OpContext) => Promise<TOut>,
): Promise<TOut | FailureResult | ReturnType<typeof unavailableResult>> {
  let resolution: Resolution<C>;
  try {
    resolution = await deps.registry.resolve(capability, op);
  } catch (cause) {
    return asMacosError(cause).toToolResult();
  }
  if (!resolution.operations) return unavailableResult(resolution);

  try {
    const result = await run(resolution.operations, ctx);
    return resolution.caveat ? { ...result, note: resolution.caveat } : result;
  } catch (cause) {
    const error = asMacosError(cause);
    return error.toToolResult();
  }
}

/** Parse an ISO-ish date the agent supplied, or return null. */
export function parseDateInput(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const IsoInput = z
  .string()
  .min(4)
  .describe('A date-time, e.g. "2026-08-07" or "2026-08-07T09:00:00".');

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const EmptyInput = z.object({});

const MailSearchInput = z.object({
  query: z
    .string()
    .max(500)
    .default('')
    .describe(
      'Text to match against the subject and sender. Leave empty to list recent messages.',
    ),
  mailbox: z
    .string()
    .max(200)
    .default('INBOX')
    .describe('Mailbox name, e.g. "INBOX", "Sent", "Archive".'),
  account: z
    .string()
    .max(200)
    .optional()
    .describe('Restrict to one account. Omit to search every account.'),
  unreadOnly: z.boolean().default(false),
  limit: z.number().int().positive().max(50).default(20),
  scanLimit: z
    .number()
    .int()
    .positive()
    .max(1000)
    .default(300)
    .describe(
      'How many recent messages to look through. Higher is slower; this is not a full-mailbox search.',
    ),
});

const MailGetInput = z.object({
  id: z.string().min(1).describe('Message id from mail_search.'),
  mailbox: z
    .string()
    .default('INBOX')
    .describe('The mailbox the id came from. Message ids are per-mailbox.'),
  account: z.string().optional().describe('The account the id came from.'),
  maxChars: z.number().int().positive().max(20000).default(2000),
});

const MailUnreadInput = z.object({
  mailbox: z.string().default('INBOX'),
});

const MailDraftInput = z.object({
  to: z
    .array(z.string().min(3))
    .min(1)
    .max(50)
    .describe('Recipient addresses.'),
  cc: z.array(z.string().min(3)).max(50).default([]),
  bcc: z.array(z.string().min(3)).max(50).default([]),
  subject: z.string().max(500).default(''),
  body: z.string().max(50000).default(''),
  from: z
    .string()
    .optional()
    .describe('Sender address, if the user has more than one account.'),
});
type MailDraftInputType = z.infer<typeof MailDraftInput>;

const CalendarEventsInput = z.object({
  start: IsoInput.optional().describe('Range start. Defaults to now.'),
  end: IsoInput.optional().describe('Range end. Defaults to seven days out.'),
  calendar: z.string().optional(),
  limit: z.number().int().positive().max(200).default(50),
});

const CalendarGetInput = z.object({
  uid: z.string().min(1).describe('Event uid from calendar_list_events.'),
  maxChars: z.number().int().positive().max(20000).default(2000),
});

const CalendarCreateInput = z.object({
  title: z.string().min(1).max(500),
  start: IsoInput,
  end: IsoInput,
  calendar: z
    .string()
    .optional()
    .describe('Defaults to the first writable calendar.'),
  location: z.string().max(500).default(''),
  notes: z.string().max(10000).default(''),
  allDay: z.boolean().default(false),
});
type CalendarCreateInputType = z.infer<typeof CalendarCreateInput>;

const ContactsSearchInput = z.object({
  query: z
    .string()
    .max(200)
    .default('')
    .describe('Matched against name, organisation and email address.'),
  limit: z.number().int().positive().max(50).default(20),
  scanLimit: z.number().int().positive().max(5000).default(2000),
});

const ContactsGetInput = z.object({
  id: z.string().min(1).describe('Contact id from contacts_search.'),
  maxChars: z.number().int().positive().max(10000).default(1000),
});

const NotesSearchInput = z.object({
  query: z.string().max(200).default(''),
  folder: z.string().optional(),
  limit: z.number().int().positive().max(50).default(20),
  scanLimit: z.number().int().positive().max(2000).default(500),
  searchBodies: z
    .boolean()
    .default(false)
    .describe(
      'Also match note contents. Much slower; ask for it only when needed.',
    ),
});

const NotesGetInput = z.object({
  id: z.string().min(1).describe('Note id from notes_search.'),
  maxChars: z.number().int().positive().max(40000).default(4000),
});

const NotesCreateInput = z.object({
  title: z.string().min(1).max(500),
  body: z.string().max(100000).default(''),
  folder: z.string().optional(),
});
type NotesCreateInputType = z.infer<typeof NotesCreateInput>;

const RemindersListInput = z.object({
  list: z
    .string()
    .optional()
    .describe('Reminders list name. Omit for all lists.'),
  includeCompleted: z.boolean().default(false),
  limit: z.number().int().positive().max(200).default(50),
});

const RemindersGetInput = z.object({
  id: z.string().min(1).describe('Reminder id from reminders_list.'),
  maxChars: z.number().int().positive().max(10000).default(2000),
});

const RemindersCreateInput = z.object({
  title: z.string().min(1).max(500),
  due: IsoInput.optional(),
  list: z.string().optional(),
  body: z.string().max(10000).default(''),
});
type RemindersCreateInputType = z.infer<typeof RemindersCreateInput>;

const FilesSelectionInput = z.object({
  limit: z.number().int().positive().max(200).default(50),
});

const CapabilitiesInput = z.object({
  refresh: z
    .boolean()
    .default(false)
    .describe('Re-check availability rather than using the cached answer.'),
});

const SendNotificationInput = z.object({
  title: z.string().min(1).max(256).describe('The notification title.'),
  body: z
    .string()
    .max(2000)
    .default('')
    .describe('The notification body text.'),
});
type SendNotificationInputType = z.infer<typeof SendNotificationInput>;

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

export function createMacosTools(deps: ToolDeps): AnyToolDefinition[] {
  /* ---------------- capabilities ---------------- */

  const capabilities = defineTool<z.infer<typeof CapabilitiesInput>>({
    name: 'macos_capabilities',
    description:
      'What this Mac can currently do — mail, calendar, contacts, notes, reminders, files — and for anything unavailable, why. Call this before telling the user something is impossible; the reason is usually a permission they can grant.',
    inputSchema: CapabilitiesInput,
    sideEffecting: false,
    annotations: { title: 'macOS capabilities', readOnlyHint: true },
    handler: (input) => deps.describeEnvironment(input.refresh),
  });

  /* ---------------- mail ---------------- */

  const mailMailboxes = defineTool<z.infer<typeof EmptyInput>>({
    name: 'mail_list_mailboxes',
    description:
      'List the mail accounts and their mailbox names. Use this to find the exact mailbox name before searching.',
    inputSchema: EmptyInput,
    sideEffecting: false,
    annotations: { title: 'List mailboxes', readOnlyHint: true },
    handler: (_input, ctx) =>
      withCapability(deps, 'mail', 'mail.mailboxes', ctx, (ops, opCtx) =>
        ops.folders(opCtx),
      ),
  });

  const mailSearch = defineTool<z.infer<typeof MailSearchInput>>({
    name: 'mail_search',
    description:
      'Search recent mail by subject and sender. Returns short summaries with an id; use mail_get_message with that id, its mailbox and its account to read one. This looks through the most recent messages in a mailbox, not the entire mailbox.',
    inputSchema: MailSearchInput,
    sideEffecting: false,
    annotations: { title: 'Search mail', readOnlyHint: true },
    handler: (input, ctx) =>
      withCapability(deps, 'mail', 'mail.search', ctx, async (ops, opCtx) => {
        const result = await ops.search(
          {
            query: input.query,
            mailbox: input.mailbox,
            account: input.account,
            limit: input.limit,
            unreadOnly: input.unreadOnly,
            scanLimit: input.scanLimit,
          },
          opCtx,
        );
        return {
          ok: true as const,
          count: result.messages.length,
          scanned: result.scanned,
          exhaustive: !result.scanTruncated,
          messages: result.messages.map((message) => ({
            id: message.ref.id,
            mailbox: message.mailbox,
            account: message.account,
            subject: message.subject,
            from: message.from,
            receivedAt: message.receivedAt,
            unread: message.unread,
          })),
        };
      }),
  });

  const mailGet = defineTool<z.infer<typeof MailGetInput>>({
    name: 'mail_get_message',
    description:
      'Read one email by id. The id, mailbox and account must all come from the same mail_search result — message ids are only unique within a mailbox.',
    inputSchema: MailGetInput,
    sideEffecting: false,
    annotations: { title: 'Read an email', readOnlyHint: true },
    handler: (input, ctx) =>
      withCapability(deps, 'mail', 'mail.message', ctx, async (ops, opCtx) => {
        const message = await ops.message(
          {
            ref: {
              id: input.id,
              scope: input.mailbox,
              container: input.account,
            },
            maxChars: input.maxChars,
          },
          opCtx,
        );
        if (!message) return { ok: true as const, found: false as const };
        return {
          ok: true as const,
          found: true as const,
          id: message.ref.id,
          mailbox: message.mailbox,
          account: message.account,
          subject: message.subject,
          from: message.from,
          replyTo: message.replyTo,
          to: message.to,
          receivedAt: message.receivedAt,
          unread: message.unread,
          body: message.body,
          bodyTruncated: message.bodyTruncated,
        };
      }),
  });

  const mailUnread = defineTool<z.infer<typeof MailUnreadInput>>({
    name: 'mail_unread_count',
    description:
      'How many unread messages there are, in total and per account. Cheap — prefer this over a search when you only need a number.',
    inputSchema: MailUnreadInput,
    sideEffecting: false,
    annotations: { title: 'Unread mail count', readOnlyHint: true },
    handler: (input, ctx) =>
      withCapability(
        deps,
        'mail',
        'mail.unread-count',
        ctx,
        async (ops, opCtx) => {
          const result = await ops.unreadCount(
            { mailbox: input.mailbox },
            opCtx,
          );
          return { ok: true as const, ...result };
        },
      ),
  });

  const mailDraft = defineTool<MailDraftInputType>({
    name: 'mail_create_draft',
    description:
      'Write an email and open it as a draft in Mail for the user to review. It is NOT sent — the user reads it and presses send themselves. There is no tool that sends mail.',
    inputSchema: MailDraftInput,
    sideEffecting: true,
    annotations: { title: 'Create a mail draft' },
    summarize: (input) => {
      const recipients = [...input.to, ...input.cc, ...input.bcc];
      const who =
        recipients.length <= 2
          ? recipients.join(' and ')
          : `${recipients[0]} and ${recipients.length - 1} others`;
      const subject = input.subject.trim() || '(no subject)';
      return `Open a draft email to ${who}, subject "${subject}" (${input.body.length} characters). It will not be sent.`;
    },
    handler: (input, ctx) =>
      withCapability(
        deps,
        'mail',
        'mail.create-draft',
        ctx,
        async (ops, opCtx) => {
          const result = await ops.createDraft(
            {
              to: input.to,
              cc: input.cc,
              bcc: input.bcc,
              subject: input.subject,
              body: input.body,
              from: input.from,
            },
            opCtx,
          );
          return {
            ok: true as const,
            sent: false as const,
            opened: result.opened,
            draftId: result.draftId,
            recipientCount: result.recipientCount,
            note: 'The draft is open in Mail. Nothing has been sent.',
          };
        },
      ),
  });

  /* ---------------- calendar ---------------- */

  const calendarCalendars = defineTool<z.infer<typeof EmptyInput>>({
    name: 'calendar_list_calendars',
    description: 'List the calendars, and which of them can be written to.',
    inputSchema: EmptyInput,
    sideEffecting: false,
    annotations: { title: 'List calendars', readOnlyHint: true },
    handler: (_input, ctx) =>
      withCapability(
        deps,
        'calendar',
        'calendar.calendars',
        ctx,
        (ops, opCtx) => ops.calendars(opCtx),
      ),
  });

  const calendarEvents = defineTool<z.infer<typeof CalendarEventsInput>>({
    name: 'calendar_list_events',
    description:
      'Events between two date-times. Recurring events are listed once, at their first occurrence — Calendar cannot expand a repeat over a range, so do not present this as a complete day view when recurring is true.',
    inputSchema: CalendarEventsInput,
    sideEffecting: false,
    annotations: { title: 'List calendar events', readOnlyHint: true },
    handler: (input, ctx) =>
      withCapability(
        deps,
        'calendar',
        'calendar.events',
        ctx,
        async (ops, opCtx) => {
          const start = parseDateInput(input.start) ?? new Date();
          const end =
            parseDateInput(input.end) ??
            new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
          if (end <= start) {
            return {
              ok: false as const,
              error: { kind: 'bad-input', message: 'end must be after start.' },
            };
          }
          const result = await ops.events(
            { calendar: input.calendar, start, end, limit: input.limit },
            opCtx,
          );
          return {
            ok: true as const,
            count: result.events.length,
            limitReached: result.limitReached,
            recurringExpanded: result.recurringExpanded,
            events: result.events.map((event) => ({
              uid: event.ref.id,
              title: event.title,
              calendar: event.calendar,
              location: event.location || undefined,
              startsAt: event.startsAt,
              endsAt: event.endsAt,
              allDay: event.allDay,
              recurring: event.recurring,
            })),
          };
        },
      ),
  });

  const calendarGet = defineTool<z.infer<typeof CalendarGetInput>>({
    name: 'calendar_get_event',
    description: 'Read one event by uid, including its notes.',
    inputSchema: CalendarGetInput,
    sideEffecting: false,
    annotations: { title: 'Read a calendar event', readOnlyHint: true },
    handler: (input, ctx) =>
      withCapability(
        deps,
        'calendar',
        'calendar.event',
        ctx,
        async (ops, opCtx) => {
          const event = await ops.event(
            { ref: { id: input.uid }, maxChars: input.maxChars },
            opCtx,
          );
          if (!event) return { ok: true as const, found: false as const };
          return {
            ok: true as const,
            found: true as const,
            uid: event.ref.id,
            title: event.title,
            calendar: event.calendar,
            location: event.location || undefined,
            startsAt: event.startsAt,
            endsAt: event.endsAt,
            allDay: event.allDay,
            recurring: event.recurring,
            notes: event.notes,
            notesTruncated: event.notesTruncated,
          };
        },
      ),
  });

  const calendarCreate = defineTool<CalendarCreateInputType>({
    name: 'calendar_create_event',
    description:
      'Add an event to a calendar. No invitations are sent and no attendees are added.',
    inputSchema: CalendarCreateInput,
    sideEffecting: true,
    annotations: { title: 'Create a calendar event' },
    summarize: (input) => {
      const where = input.location ? ` at ${input.location}` : '';
      const cal = input.calendar ? ` in the "${input.calendar}" calendar` : '';
      return `Create the event "${input.title}"${where} from ${input.start} to ${input.end}${cal}.`;
    },
    handler: (input, ctx) =>
      withCapability(
        deps,
        'calendar',
        'calendar.create-event',
        ctx,
        async (ops, opCtx) => {
          const start = parseDateInput(input.start);
          const end = parseDateInput(input.end);
          if (!start || !end) {
            return {
              ok: false as const,
              error: {
                kind: 'bad-input',
                message: 'start and end must both be readable date-times.',
              },
            };
          }
          if (end <= start) {
            return {
              ok: false as const,
              error: { kind: 'bad-input', message: 'end must be after start.' },
            };
          }
          const result = await ops.createEvent(
            {
              calendar: input.calendar,
              title: input.title,
              location: input.location,
              notes: input.notes,
              allDay: input.allDay,
              start,
              end,
            },
            opCtx,
          );
          return { ok: true as const, ...result };
        },
      ),
  });

  /* ---------------- contacts ---------------- */

  const contactsSearch = defineTool<z.infer<typeof ContactsSearchInput>>({
    name: 'contacts_search',
    description:
      "Search the user's address book by name, organisation or email address. Returns ids for contacts_get.",
    inputSchema: ContactsSearchInput,
    sideEffecting: false,
    annotations: { title: 'Search contacts', readOnlyHint: true },
    handler: (input, ctx) =>
      withCapability(
        deps,
        'contacts',
        'contacts.search',
        ctx,
        async (ops, opCtx) => {
          const result = await ops.search(input, opCtx);
          return {
            ok: true as const,
            count: result.contacts.length,
            scanned: result.scanned,
            contacts: result.contacts.map((contact) => ({
              id: contact.ref.id,
              name: contact.name,
              organization: contact.organization || undefined,
              emails: contact.emails,
              phones: contact.phones,
            })),
          };
        },
      ),
  });

  const contactsGet = defineTool<z.infer<typeof ContactsGetInput>>({
    name: 'contacts_get',
    description: 'Read one contact by id.',
    inputSchema: ContactsGetInput,
    sideEffecting: false,
    annotations: { title: 'Read a contact', readOnlyHint: true },
    handler: (input, ctx) =>
      withCapability(
        deps,
        'contacts',
        'contacts.person',
        ctx,
        async (ops, opCtx) => {
          const contact = await ops.person(
            { ref: { id: input.id }, maxChars: input.maxChars },
            opCtx,
          );
          if (!contact) return { ok: true as const, found: false as const };
          return {
            ok: true as const,
            found: true as const,
            id: contact.ref.id,
            name: contact.name,
            organization: contact.organization || undefined,
            jobTitle: contact.jobTitle || undefined,
            emails: contact.emails,
            phones: contact.phones,
            note: contact.note,
            noteTruncated: contact.noteTruncated,
          };
        },
      ),
  });

  /* ---------------- notes ---------------- */

  const notesSearch = defineTool<z.infer<typeof NotesSearchInput>>({
    name: 'notes_search',
    description:
      'Search Notes. Matches titles by default; set searchBodies to look inside notes, which is considerably slower.',
    inputSchema: NotesSearchInput,
    sideEffecting: false,
    annotations: { title: 'Search notes', readOnlyHint: true },
    handler: (input, ctx) =>
      withCapability(deps, 'notes', 'notes.search', ctx, async (ops, opCtx) => {
        const result = await ops.search(input, opCtx);
        return {
          ok: true as const,
          count: result.notes.length,
          scanned: result.scanned,
          bodiesSearched: result.bodiesSearched,
          notes: result.notes.map((note) => ({
            id: note.ref.id,
            title: note.title,
            modifiedAt: note.modifiedAt,
            snippet: note.snippet || undefined,
          })),
        };
      }),
  });

  const notesGet = defineTool<z.infer<typeof NotesGetInput>>({
    name: 'notes_get',
    description: 'Read one note by id, as plain text.',
    inputSchema: NotesGetInput,
    sideEffecting: false,
    annotations: { title: 'Read a note', readOnlyHint: true },
    handler: (input, ctx) =>
      withCapability(deps, 'notes', 'notes.note', ctx, async (ops, opCtx) => {
        const note = await ops.note(
          { ref: { id: input.id }, maxChars: input.maxChars },
          opCtx,
        );
        if (!note) return { ok: true as const, found: false as const };
        return {
          ok: true as const,
          found: true as const,
          id: note.ref.id,
          title: note.title,
          createdAt: note.createdAt,
          modifiedAt: note.modifiedAt,
          body: note.body,
          bodyTruncated: note.bodyTruncated,
        };
      }),
  });

  const notesCreate = defineTool<NotesCreateInputType>({
    name: 'notes_create',
    description:
      'Create a new note. Existing notes are never modified — there is no update tool.',
    inputSchema: NotesCreateInput,
    sideEffecting: true,
    annotations: { title: 'Create a note' },
    summarize: (input) => {
      const where = input.folder ? ` in the "${input.folder}" folder` : '';
      return `Create a note titled "${input.title}"${where} (${input.body.length} characters).`;
    },
    handler: (input, ctx) =>
      withCapability(deps, 'notes', 'notes.create', ctx, async (ops, opCtx) => {
        const result = await ops.create(input, opCtx);
        return { ok: true as const, ...result };
      }),
  });

  /* ---------------- reminders ---------------- */

  const remindersList = defineTool<z.infer<typeof RemindersListInput>>({
    name: 'reminders_list',
    description:
      'List reminders, by default only the outstanding ones. Returns ids for reminders_get.',
    inputSchema: RemindersListInput,
    sideEffecting: false,
    annotations: { title: 'List reminders', readOnlyHint: true },
    handler: (input, ctx) =>
      withCapability(
        deps,
        'reminders',
        'reminders.list',
        ctx,
        async (ops, opCtx) => {
          const result = await ops.list(input, opCtx);
          return {
            ok: true as const,
            count: result.reminders.length,
            skippedCompleted: result.skippedCompleted,
            lists: result.lists,
            reminders: result.reminders.map((reminder) => ({
              id: reminder.ref.id,
              list: reminder.list,
              title: reminder.title,
              completed: reminder.completed,
              dueAt: reminder.dueAt,
              priority: reminder.priority || undefined,
            })),
          };
        },
      ),
  });

  const remindersGet = defineTool<z.infer<typeof RemindersGetInput>>({
    name: 'reminders_get',
    description: 'Read one reminder by id.',
    inputSchema: RemindersGetInput,
    sideEffecting: false,
    annotations: { title: 'Read a reminder', readOnlyHint: true },
    handler: (input, ctx) =>
      withCapability(
        deps,
        'reminders',
        'reminders.reminder',
        ctx,
        async (ops, opCtx) => {
          const reminder = await ops.reminder(
            { ref: { id: input.id }, maxChars: input.maxChars },
            opCtx,
          );
          if (!reminder) return { ok: true as const, found: false as const };
          return {
            ok: true as const,
            found: true as const,
            id: reminder.ref.id,
            list: reminder.list,
            title: reminder.title,
            completed: reminder.completed,
            dueAt: reminder.dueAt,
            remindAt: reminder.remindAt,
            priority: reminder.priority || undefined,
            body: reminder.body,
            bodyTruncated: reminder.bodyTruncated,
          };
        },
      ),
  });

  const remindersCreate = defineTool<RemindersCreateInputType>({
    name: 'reminders_create',
    description:
      'Add a reminder. Existing reminders are never changed or completed — there is no tool for that.',
    inputSchema: RemindersCreateInput,
    sideEffecting: true,
    annotations: { title: 'Create a reminder' },
    summarize: (input) => {
      const when = input.due ? ` due ${input.due}` : '';
      const where = input.list ? ` on the "${input.list}" list` : '';
      return `Add the reminder "${input.title}"${when}${where}.`;
    },
    handler: (input, ctx) =>
      withCapability(
        deps,
        'reminders',
        'reminders.create',
        ctx,
        async (ops, opCtx) => {
          const due = parseDateInput(input.due);
          if (input.due && !due) {
            return {
              ok: false as const,
              error: {
                kind: 'bad-input',
                message: `"${input.due}" is not a readable date-time.`,
              },
            };
          }
          const result = await ops.create(
            { list: input.list, title: input.title, body: input.body, due },
            opCtx,
          );
          return { ok: true as const, ...result };
        },
      ),
  });

  /* ---------------- notifications ---------------- */

  const sendNotification = defineTool<SendNotificationInputType>({
    name: 'send_notification',
    description:
      'Post a macOS notification banner with a title and body. Use this to ' +
      'alert the user directly (e.g. when a reminder fires or a task finishes). ' +
      'Delivered via the system, so it needs no separate notification permission.',
    inputSchema: SendNotificationInput,
    // Not routed through the approval gate: posting a banner is not a
    // consequential, outside-world action — it just shows the user a message.
    // Per product decision, AppleScript notifications are always allowed.
    sideEffecting: false,
    annotations: { title: 'Send a notification' },
    summarize: (input) => `Notify: "${input.title}".`,
    handler: async (input) => {
      if (process.platform !== 'darwin') {
        return {
          ok: false as const,
          error: {
            kind: 'unavailable',
            message: `Notifications are only available on macOS; this is ${process.platform}.`,
          },
        };
      }
      try {
        // The audited escaper guarantees title/body can't break out of the
        // AppleScript string context, whatever characters they contain.
        const src =
          `display notification ${appleScriptStringExpr(input.body)} ` +
          `with title ${appleScriptStringExpr(input.title)}`;
        const result = await runProcess(OSASCRIPT_PATH, ['-e', src], {
          timeoutMs: 10_000,
          label: 'osascript-notify',
          collectStdout: true,
          env: {
            ELECTRON_RUN_AS_NODE: undefined,
            ELECTRON_NO_ATTACH_CONSOLE: undefined,
            NODE_OPTIONS: undefined,
          },
        });
        if (result.timedOut || result.code !== 0) {
          return {
            ok: false as const,
            error: {
              kind: 'script-failed',
              message:
                result.stderrTail?.trim() ||
                'The notification could not be shown.',
            },
          };
        }
        return { ok: true as const };
      } catch (cause) {
        return {
          ok: false as const,
          error: {
            kind: 'unknown',
            message: cause instanceof Error ? cause.message : String(cause),
          },
        };
      }
    },
  });

  /* ---------------- files ---------------- */

  const filesSelection = defineTool<z.infer<typeof FilesSelectionInput>>({
    name: 'files_finder_selection',
    description:
      'The files and folders the user currently has selected in Finder, and the folder the front Finder window is showing. Use this when the user says "this file" or "these files". For reading or editing them, use the normal file tools.',
    inputSchema: FilesSelectionInput,
    sideEffecting: false,
    annotations: { title: 'Finder selection', readOnlyHint: true },
    handler: (input, ctx) =>
      withCapability(
        deps,
        'files',
        'files.finder-selection',
        ctx,
        async (ops, opCtx) => {
          const result = await ops.selection(input, opCtx);
          return {
            ok: true as const,
            count: result.selection.length,
            frontWindowPath: result.frontWindowPath || undefined,
            selection: result.selection,
          };
        },
      ),
  });

  return [
    capabilities,
    mailMailboxes,
    mailSearch,
    mailGet,
    mailUnread,
    mailDraft,
    calendarCalendars,
    calendarEvents,
    calendarGet,
    calendarCreate,
    contactsSearch,
    contactsGet,
    notesSearch,
    notesGet,
    notesCreate,
    remindersList,
    remindersGet,
    remindersCreate,
    sendNotification,
    filesSelection,
  ];
}

/** Names of every tool this module publishes. Asserted stable by test. */
export const MACOS_TOOL_NAMES = [
  'macos_capabilities',
  'mail_list_mailboxes',
  'mail_search',
  'mail_get_message',
  'mail_unread_count',
  'mail_create_draft',
  'calendar_list_calendars',
  'calendar_list_events',
  'calendar_get_event',
  'calendar_create_event',
  'contacts_search',
  'contacts_get',
  'notes_search',
  'notes_get',
  'notes_create',
  'reminders_list',
  'reminders_get',
  'reminders_create',
  'send_notification',
  'files_finder_selection',
] as const;

/** The ones that change something. Everything else must be read-only. */
export const MACOS_SIDE_EFFECTING_TOOLS = [
  'mail_create_draft',
  'calendar_create_event',
  'notes_create',
  'reminders_create',
] as const;
