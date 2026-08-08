/**
 * Zod schemas for what the scripts return.
 *
 * Every one of these describes output produced by an Apple application whose
 * scripting dictionary changes without notice, containing strings that came out
 * of somebody's inbox. Both facts point the same way: validate on the way in,
 * and never hand the model a value that has not been through one of these.
 *
 * The schemas are deliberately tolerant about *presence* and strict about
 * *shape*. A missing optional property is a normal consequence of a version
 * difference and should degrade to `undefined`; a string where a number belongs
 * means we are misreading the dictionary and must fail loudly with the field
 * name, because the alternative is a plausible wrong answer.
 */
import { z } from 'zod';

/** `jsonDate` in the prelude emits ISO-8601 with an offset, or JSON null. */
const OptionalDate = z.string().min(1).nullable().optional();

const OptionalText = z
  .string()
  .nullable()
  .optional()
  .transform((v) => v ?? '');

/* ------------------------------------------------------------------ */
/* Probe                                                               */
/* ------------------------------------------------------------------ */

export const ProbeResultSchema = z.object({
  running: z.boolean(),
  /** False when the app was not running and we declined to launch it. */
  probed: z.boolean(),
  name: z.string().nullable().optional(),
  version: z.string().nullable().optional(),
});
export type ProbeResult = z.infer<typeof ProbeResultSchema>;

/* ------------------------------------------------------------------ */
/* Mail                                                                */
/* ------------------------------------------------------------------ */

export const MailboxesSchema = z.object({
  accounts: z.array(
    z.object({
      account: OptionalText,
      enabled: z.boolean(),
      mailboxes: z.array(z.string()),
    }),
  ),
});
export type Mailboxes = z.infer<typeof MailboxesSchema>;

export const MailMessageSummarySchema = z.object({
  id: z.string(),
  mailbox: OptionalText,
  account: OptionalText,
  subject: OptionalText,
  sender: OptionalText,
  receivedAt: OptionalDate,
  unread: z.boolean(),
});
export type MailMessageSummary = z.infer<typeof MailMessageSummarySchema>;

export const MailSearchResultSchema = z.object({
  messages: z.array(MailMessageSummarySchema),
  count: z.number().int().nonnegative(),
  scanned: z.number().int().nonnegative(),
  scanTruncated: z.boolean(),
});
export type MailSearchResult = z.infer<typeof MailSearchResultSchema>;

export const MailMessageSchema = z.discriminatedUnion('found', [
  z.object({ found: z.literal(false) }),
  z.object({
    found: z.literal(true),
    id: z.string(),
    mailbox: OptionalText,
    account: OptionalText,
    subject: OptionalText,
    sender: OptionalText,
    replyTo: OptionalText,
    recipients: z.array(z.string()),
    receivedAt: OptionalDate,
    unread: z.boolean(),
    body: OptionalText,
    bodyTruncated: z.boolean(),
  }),
]);
export type MailMessage = z.infer<typeof MailMessageSchema>;

export const MailUnreadSchema = z.object({
  mailbox: OptionalText,
  unread: z.number().int().nonnegative(),
  accounts: z.array(
    z.object({
      account: OptionalText,
      unread: z.number().int().nonnegative(),
    }),
  ),
});
export type MailUnread = z.infer<typeof MailUnreadSchema>;

/**
 * `sent` is a literal `false`, not a boolean.
 *
 * If a future edit to the script ever produced a sent message, this schema stops
 * the result at the boundary rather than reporting success. It costs one line
 * and it makes the invariant machine-checked instead of a comment.
 */
export const MailDraftSchema = z.object({
  ok: z.literal(true),
  sent: z.literal(false),
  opened: z.boolean(),
  draftId: OptionalText,
  recipientCount: z.number().int().nonnegative(),
});
export type MailDraft = z.infer<typeof MailDraftSchema>;

/* ------------------------------------------------------------------ */
/* Calendar                                                            */
/* ------------------------------------------------------------------ */

export const CalendarsSchema = z.object({
  calendars: z.array(z.object({ name: OptionalText, writable: z.boolean() })),
  count: z.number().int().nonnegative(),
});
export type Calendars = z.infer<typeof CalendarsSchema>;

export const CalendarEventSummarySchema = z.object({
  uid: OptionalText,
  calendar: OptionalText,
  title: OptionalText,
  location: OptionalText,
  startsAt: OptionalDate,
  endsAt: OptionalDate,
  allDay: z.boolean(),
  recurrence: OptionalText,
});
export type CalendarEventSummary = z.infer<typeof CalendarEventSummarySchema>;

export const CalendarEventsSchema = z.object({
  events: z.array(CalendarEventSummarySchema),
  count: z.number().int().nonnegative(),
  limitReached: z.boolean(),
  /** Always false today. See the note in `calendar-events.applescript`. */
  recurringExpanded: z.boolean(),
  rangeStart: OptionalDate,
  rangeEnd: OptionalDate,
});
export type CalendarEvents = z.infer<typeof CalendarEventsSchema>;

export const CalendarEventSchema = z.discriminatedUnion('found', [
  z.object({ found: z.literal(false) }),
  z.object({
    found: z.literal(true),
    uid: z.string(),
    calendar: OptionalText,
    title: OptionalText,
    location: OptionalText,
    startsAt: OptionalDate,
    endsAt: OptionalDate,
    allDay: z.boolean(),
    recurrence: OptionalText,
    notes: OptionalText,
    notesTruncated: z.boolean(),
  }),
]);
export type CalendarEvent = z.infer<typeof CalendarEventSchema>;

export const CalendarCreatedSchema = z.object({
  ok: z.literal(true),
  uid: OptionalText,
  calendar: OptionalText,
  startsAt: OptionalDate,
  endsAt: OptionalDate,
});
export type CalendarCreated = z.infer<typeof CalendarCreatedSchema>;

/* ------------------------------------------------------------------ */
/* Contacts                                                            */
/* ------------------------------------------------------------------ */

export const ContactSummarySchema = z.object({
  id: OptionalText,
  name: OptionalText,
  organization: OptionalText,
  emails: z.array(z.string()),
  phones: z.array(z.string()),
});
export type ContactSummary = z.infer<typeof ContactSummarySchema>;

export const ContactsSearchSchema = z.object({
  contacts: z.array(ContactSummarySchema),
  count: z.number().int().nonnegative(),
  scanned: z.number().int().nonnegative(),
});
export type ContactsSearch = z.infer<typeof ContactsSearchSchema>;

export const ContactSchema = z.discriminatedUnion('found', [
  z.object({ found: z.literal(false) }),
  z.object({
    found: z.literal(true),
    id: z.string(),
    name: OptionalText,
    organization: OptionalText,
    jobTitle: OptionalText,
    emails: z.array(z.string()),
    phones: z.array(z.string()),
    note: OptionalText,
    noteTruncated: z.boolean(),
  }),
]);
export type Contact = z.infer<typeof ContactSchema>;

/* ------------------------------------------------------------------ */
/* Notes                                                               */
/* ------------------------------------------------------------------ */

export const NotesSearchSchema = z.object({
  notes: z.array(
    z.object({
      id: OptionalText,
      title: OptionalText,
      modifiedAt: OptionalDate,
      snippet: OptionalText,
    }),
  ),
  count: z.number().int().nonnegative(),
  scanned: z.number().int().nonnegative(),
  bodiesSearched: z.boolean(),
});
export type NotesSearch = z.infer<typeof NotesSearchSchema>;

export const NoteSchema = z.discriminatedUnion('found', [
  z.object({ found: z.literal(false) }),
  z.object({
    found: z.literal(true),
    id: z.string(),
    title: OptionalText,
    createdAt: OptionalDate,
    modifiedAt: OptionalDate,
    body: OptionalText,
    bodyTruncated: z.boolean(),
  }),
]);
export type Note = z.infer<typeof NoteSchema>;

export const NoteCreatedSchema = z.object({
  ok: z.literal(true),
  id: OptionalText,
  title: OptionalText,
});
export type NoteCreated = z.infer<typeof NoteCreatedSchema>;

/* ------------------------------------------------------------------ */
/* Reminders                                                           */
/* ------------------------------------------------------------------ */

export const RemindersListSchema = z.object({
  reminders: z.array(
    z.object({
      id: OptionalText,
      list: OptionalText,
      title: OptionalText,
      completed: z.boolean(),
      dueAt: OptionalDate,
      priority: z.number().int(),
    }),
  ),
  count: z.number().int().nonnegative(),
  skippedCompleted: z.number().int().nonnegative(),
  lists: z.array(z.string()),
});
export type RemindersList = z.infer<typeof RemindersListSchema>;

export const ReminderSchema = z.discriminatedUnion('found', [
  z.object({ found: z.literal(false) }),
  z.object({
    found: z.literal(true),
    id: z.string(),
    list: OptionalText,
    title: OptionalText,
    completed: z.boolean(),
    dueAt: OptionalDate,
    remindAt: OptionalDate,
    priority: z.number().int(),
    body: OptionalText,
    bodyTruncated: z.boolean(),
  }),
]);
export type Reminder = z.infer<typeof ReminderSchema>;

export const ReminderCreatedSchema = z.object({
  ok: z.literal(true),
  id: OptionalText,
  list: OptionalText,
  title: OptionalText,
  dueAt: OptionalDate,
});
export type ReminderCreated = z.infer<typeof ReminderCreatedSchema>;

/* ------------------------------------------------------------------ */
/* Finder                                                              */
/* ------------------------------------------------------------------ */

export const FinderSelectionSchema = z.object({
  selection: z.array(z.object({ path: OptionalText, name: OptionalText })),
  count: z.number().int().nonnegative(),
  frontWindowPath: OptionalText,
});
export type FinderSelection = z.infer<typeof FinderSelectionSchema>;
