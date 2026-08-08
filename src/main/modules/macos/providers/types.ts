/**
 * The capability contract: what a capability can do, stated once, independently
 * of what happens to be implementing it.
 *
 * This is the type-level half of "prefer the local app when present, else fall
 * back". A capability is an interface; a provider is an implementation of it
 * that also says whether it is usable right now. The tool layer talks to the
 * interface and never learns which provider answered, which is what keeps tool
 * names stable — `mail_search` means the same thing whether Apple Mail, an IMAP
 * client or a hosted API is behind it, so swapping providers cannot invalidate
 * anything the model has learned about the surface.
 *
 * The shapes below are therefore deliberately **not** Apple's. No Mail message
 * ids leak into the signature, no AppleScript vocabulary, no `missing value`.
 * Where Apple's model is poorer than the interface (a message id that is only
 * unique within a mailbox) the provider carries the extra context in an opaque
 * `ref` rather than widening the interface for everyone.
 */
import type { RemediationCard } from '../errors';
import type { PermissionStatus } from '../permissions';
import type { CapabilityOp, OpVerdict } from '../version';

/* ------------------------------------------------------------------ */
/* Tiers                                                               */
/* ------------------------------------------------------------------ */

/**
 * Provider tiers, in resolution order.
 *
 *  - `local-app`      the user's own application on this machine. No credentials,
 *                     no network, no per-call cost, and it already holds the
 *                     accounts the user actually uses.
 *  - `local-protocol` a local daemon or an on-disk store (IMAP against a local
 *                     server, a CalDAV cache). Still local, but a second copy of
 *                     the truth.
 *  - `direct-api`     the vendor's API with the user's own credentials. Network,
 *                     OAuth, rate limits, but no third party.
 *  - `brokered`       someone else's server in the middle. Last, always: it is
 *                     the only tier that puts the user's mail on a machine
 *                     neither they nor we control.
 */
export const PROVIDER_TIERS = [
  'local-app',
  'local-protocol',
  'direct-api',
  'brokered',
] as const;
export type ProviderTier = (typeof PROVIDER_TIERS)[number];

export const TIER_PRIORITY: Record<ProviderTier, number> = {
  'local-app': 0,
  'local-protocol': 1,
  'direct-api': 2,
  brokered: 3,
};

/* ------------------------------------------------------------------ */
/* Neutral domain shapes                                               */
/* ------------------------------------------------------------------ */

/** Opaque handle for fetching one item back. Providers own its contents. */
export interface ItemRef {
  id: string;
  /** Extra context a provider needs to find it again, e.g. a mailbox name. */
  scope?: string;
  /** Second level of scope, e.g. an account name. */
  container?: string;
}

export interface MailSummary {
  ref: ItemRef;
  subject: string;
  from: string;
  receivedAt?: string;
  unread: boolean;
  mailbox: string;
  account: string;
}

export interface MailDetail extends MailSummary {
  to: string[];
  replyTo: string;
  body: string;
  bodyTruncated: boolean;
}

export interface MailFolder {
  account: string;
  enabled: boolean;
  mailboxes: string[];
}

export interface EventSummary {
  ref: ItemRef;
  title: string;
  calendar: string;
  location: string;
  startsAt?: string;
  endsAt?: string;
  allDay: boolean;
  recurring: boolean;
}

export interface EventDetail extends EventSummary {
  notes: string;
  notesTruncated: boolean;
}

export interface ContactSummaryItem {
  ref: ItemRef;
  name: string;
  organization: string;
  emails: string[];
  phones: string[];
}

export interface ContactDetail extends ContactSummaryItem {
  jobTitle: string;
  note: string;
  noteTruncated: boolean;
}

export interface NoteSummary {
  ref: ItemRef;
  title: string;
  modifiedAt?: string;
  snippet: string;
}

export interface NoteDetail extends NoteSummary {
  createdAt?: string;
  body: string;
  bodyTruncated: boolean;
}

export interface ReminderSummary {
  ref: ItemRef;
  title: string;
  list: string;
  completed: boolean;
  dueAt?: string;
  priority: number;
}

export interface ReminderDetail extends ReminderSummary {
  remindAt?: string;
  body: string;
  bodyTruncated: boolean;
}

export interface SelectedFile {
  path: string;
  name: string;
}

/* ------------------------------------------------------------------ */
/* Operations                                                          */
/* ------------------------------------------------------------------ */

/** Passed to every operation so cancellation and logging reach the runner. */
export interface OpContext {
  signal?: AbortSignal;
}

export interface MailOps {
  folders(ctx: OpContext): Promise<{ accounts: MailFolder[] }>;
  search(
    input: {
      query: string;
      mailbox: string;
      account?: string;
      limit: number;
      unreadOnly: boolean;
      scanLimit: number;
    },
    ctx: OpContext,
  ): Promise<{
    messages: MailSummary[];
    scanned: number;
    scanTruncated: boolean;
  }>;
  message(
    input: { ref: ItemRef; maxChars: number },
    ctx: OpContext,
  ): Promise<MailDetail | null>;
  unreadCount(
    input: { mailbox: string },
    ctx: OpContext,
  ): Promise<{
    total: number;
    byAccount: { account: string; unread: number }[];
  }>;
  /**
   * Creates a draft and opens it. Never sends: there is no send operation on
   * this interface, so no provider can offer one and no tool can reach one.
   */
  createDraft(
    input: {
      to: string[];
      cc: string[];
      bcc: string[];
      subject: string;
      body: string;
      from?: string;
    },
    ctx: OpContext,
  ): Promise<{ opened: boolean; draftId: string; recipientCount: number }>;
}

export interface CalendarOps {
  calendars(
    ctx: OpContext,
  ): Promise<{ calendars: { name: string; writable: boolean }[] }>;
  events(
    input: {
      calendar?: string;
      start: Date;
      end: Date;
      limit: number;
    },
    ctx: OpContext,
  ): Promise<{
    events: EventSummary[];
    limitReached: boolean;
    recurringExpanded: boolean;
  }>;
  event(
    input: { ref: ItemRef; maxChars: number },
    ctx: OpContext,
  ): Promise<EventDetail | null>;
  createEvent(
    input: {
      calendar?: string;
      title: string;
      location: string;
      notes: string;
      allDay: boolean;
      start: Date;
      end: Date;
    },
    ctx: OpContext,
  ): Promise<{ uid: string; calendar: string }>;
}

export interface ContactsOps {
  search(
    input: { query: string; limit: number; scanLimit: number },
    ctx: OpContext,
  ): Promise<{ contacts: ContactSummaryItem[]; scanned: number }>;
  person(
    input: { ref: ItemRef; maxChars: number },
    ctx: OpContext,
  ): Promise<ContactDetail | null>;
}

export interface NotesOps {
  search(
    input: {
      query: string;
      folder?: string;
      limit: number;
      scanLimit: number;
      searchBodies: boolean;
    },
    ctx: OpContext,
  ): Promise<{
    notes: NoteSummary[];
    scanned: number;
    bodiesSearched: boolean;
  }>;
  note(
    input: { ref: ItemRef; maxChars: number },
    ctx: OpContext,
  ): Promise<NoteDetail | null>;
  create(
    input: { title: string; body: string; folder?: string },
    ctx: OpContext,
  ): Promise<{ id: string; title: string }>;
}

export interface RemindersOps {
  list(
    input: { list?: string; limit: number; includeCompleted: boolean },
    ctx: OpContext,
  ): Promise<{
    reminders: ReminderSummary[];
    skippedCompleted: number;
    lists: string[];
  }>;
  reminder(
    input: { ref: ItemRef; maxChars: number },
    ctx: OpContext,
  ): Promise<ReminderDetail | null>;
  create(
    input: { list?: string; title: string; body: string; due: Date | null },
    ctx: OpContext,
  ): Promise<{ id: string; list: string; title: string }>;
}

export interface FilesOps {
  selection(
    input: { limit: number },
    ctx: OpContext,
  ): Promise<{ selection: SelectedFile[]; frontWindowPath: string }>;
}

/** Capability id -> the interface it promises. The registry is keyed by this. */
export interface CapabilityOps {
  mail: MailOps;
  calendar: CalendarOps;
  contacts: ContactsOps;
  notes: NotesOps;
  reminders: RemindersOps;
  files: FilesOps;
}

export type CapabilityId = keyof CapabilityOps;

export const CAPABILITY_IDS: readonly CapabilityId[] = [
  'mail',
  'calendar',
  'contacts',
  'notes',
  'reminders',
  'files',
];

/* ------------------------------------------------------------------ */
/* Providers                                                           */
/* ------------------------------------------------------------------ */

/**
 * The answer to "can you do this right now, and if not, why not".
 *
 * `reason` is required when `usable` is false and is written for a person. It
 * ends up in `ProviderAvailability.reason`, in an onboarding row and in the
 * tool result the model sees, so "ENOENT" is not an acceptable value.
 */
export interface ProviderCheck {
  usable: boolean;
  reason?: string;
  /** Usable, but something about the results is compromised. */
  degraded?: boolean;
  degradedReason?: string;
  /** Rows an onboarding screen should render for this provider. */
  permissions?: PermissionStatus[];
  /** Present when a user action would make it usable. */
  remediation?: RemediationCard;
}

export interface CapabilityProvider<C extends CapabilityId = CapabilityId> {
  /** Stable, e.g. `apple-mail`. Appears in diagnostics, never in a tool name. */
  id: string;
  capability: C;
  /** For the settings screen, e.g. "Apple Mail". */
  name: string;
  tier: ProviderTier;
  /** `process.platform` values this could ever work on. */
  platforms: string[];
  /** Tie-break inside a tier. Lower wins. Default 0. */
  priority?: number;
  /** Operations it implements at all. */
  ops: readonly CapabilityOp[];
  /** Whether it can run right now. Cheap, and must never throw. */
  check(): Promise<ProviderCheck>;
  /** Whether this OS version allows one operation. Cheap and synchronous. */
  supports(op: CapabilityOp): OpVerdict;
  /** The implementation. */
  operations: CapabilityOps[C];
}

/** A provider of any capability, for collections. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCapabilityProvider = CapabilityProvider<any>;
