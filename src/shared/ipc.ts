/**
 * The typed IPC contract.
 *
 * One registry so nobody invents channel strings. Renderer and main both import
 * this file; neither is allowed to hard-code a literal channel name anywhere
 * else.
 *
 * Shape:
 *  - {@link IPC} is the const map of channel names, grouped by domain.
 *  - {@link IpcContract} maps every channel to its request and response types.
 *  - {@link IpcPushContract} maps main -> renderer push channels to payloads.
 *
 * Request types are deliberately the zod *input* types (`z.input`), because the
 * renderer sends unvalidated-but-well-shaped payloads and the main-side handler
 * parses them, filling defaults. Response types are output types.
 */
import type { Page } from './common';
import type { ChatTurn } from './claudeTranscript.fold';
import type {
  Approval,
  ApprovalAuditEntry,
  ApprovalAuditQueryInput,
  ApprovalDecision,
  ApprovalGrant,
  ApprovalResolution,
  ApprovalScope,
} from './approvals';
import type {
  Run,
  RunDetail,
  RunEvent,
  RunEventsQueryInput,
  RunListQueryInput,
  RunStartRequestInput,
  RunStatus,
} from './runs';
import type {
  Goal,
  GoalQueryInput,
  GoalWrite,
  Task,
  TaskCreateInput,
  TaskQueryInput,
  TaskUpdate,
} from './tasks';
import type {
  CronValidation,
  ScheduledJob,
  ScheduledJobCreateInput,
  ScheduledJobUpdate,
  ScheduleHistoryQueryInput,
  ScheduleRunNowRequestInput,
  ScheduleRunRecord,
} from './schedule';
import type {
  MemoryAddRequestInput,
  MemoryEngineStatus,
  MemoryForgetRequestInput,
  MemoryListRequestInput,
  MemoryPage,
  MemorySearchRequestInput,
} from './supermemory';
import type {
  EngineDetectRequestInput,
  EngineInfo,
  EnvironmentStatus,
} from './engines';
import type {
  OnboardingState,
  OnboardingStateInput,
  Settings,
  SettingsPatch,
} from './settings';
import type {
  BotCreateInput,
  BotMarkReadRequestInput,
  BotMessage,
  BotMessagesQueryInput,
  BotSendRequestInput,
  BotSendResult,
  BotUpdateInput,
  BotWithUnread,
} from './bots';

/* ------------------------------------------------------------------ */
/* Channel names                                                       */
/* ------------------------------------------------------------------ */

/**
 * Every renderer -> main request channel. Grouped for discoverability;
 * the values are what actually travels over `ipcRenderer.invoke`.
 */
export const IPC = {
  runs: {
    list: 'runs:list',
    get: 'runs:get',
    start: 'runs:start',
    cancel: 'runs:cancel',
    events: 'runs:events',
    subscribe: 'runs:subscribe',
    unsubscribe: 'runs:unsubscribe',
  },
  approvals: {
    listPending: 'approvals:list-pending',
    resolve: 'approvals:resolve',
    listGrants: 'approvals:list-grants',
    revokeGrant: 'approvals:revoke-grant',
    listAudit: 'approvals:list-audit',
  },
  tasks: {
    list: 'tasks:list',
    get: 'tasks:get',
    create: 'tasks:create',
    update: 'tasks:update',
    remove: 'tasks:delete',
  },
  goals: {
    list: 'goals:list',
    get: 'goals:get',
    write: 'goals:write',
    remove: 'goals:delete',
  },
  schedule: {
    list: 'schedule:list',
    get: 'schedule:get',
    create: 'schedule:create',
    update: 'schedule:update',
    remove: 'schedule:delete',
    runNow: 'schedule:run-now',
    validateCron: 'schedule:validate-cron',
    history: 'schedule:history',
  },
  memory: {
    list: 'memory:list',
    search: 'memory:search',
    add: 'memory:add',
    forget: 'memory:forget',
    retry: 'memory:retry',
    status: 'memory:status',
  },
  settings: {
    get: 'settings:get',
    set: 'settings:set',
  },
  engines: {
    detect: 'engines:detect',
    status: 'engines:status',
  },
  onboarding: {
    get: 'onboarding:get',
    set: 'onboarding:set',
  },
  dialog: {
    pickDirectory: 'dialog:pick-directory',
  },
  system: {
    micStatus: 'system:mic-status',
    requestMic: 'system:request-mic',
    openMicSettings: 'system:open-mic-settings',
  },
  voice: {
    transcribe: 'voice:transcribe',
  },
  chat: {
    sessions: 'chat:sessions',
    transcript: 'chat:transcript',
    send: 'chat:send',
    newSession: 'chat:new',
    selectSession: 'chat:select',
    cancel: 'chat:cancel',
    subscribe: 'chat:subscribe',
    unsubscribe: 'chat:unsubscribe',
  },
  composio: {
    status: 'composio:status',
    setKey: 'composio:set-key',
    connect: 'composio:connect',
    listToolkits: 'composio:list-toolkits',
    toolsFor: 'composio:tools-for',
  },
  bots: {
    list: 'bots:list',
    get: 'bots:get',
    messages: 'bots:messages',
    create: 'bots:create',
    update: 'bots:update',
    archive: 'bots:archive',
    send: 'bots:send',
    markRead: 'bots:mark-read',
  },
  // `satisfies` makes drift between this map and IpcContract a compile error.
} as const satisfies Record<string, Record<string, IpcChannel>>;

/**
 * Main -> renderer push channels. Delivered with `webContents.send`, received
 * with `ipcRenderer.on`. Run events are batched; see {@link IpcPushContract}.
 */
export const IPC_PUSH = {
  runEvents: 'push:run-events',
  runStatus: 'push:run-status',
  approvalRequested: 'push:approval-requested',
  approvalResolved: 'push:approval-resolved',
  tasksChanged: 'push:tasks-changed',
  goalsChanged: 'push:goals-changed',
  scheduleChanged: 'push:schedule-changed',
  settingsChanged: 'push:settings-changed',
  environmentChanged: 'push:environment-changed',
  chatUpdated: 'push:chat-updated',
  chatStream: 'push:chat-stream',
  botThread: 'push:bot-thread',
} as const satisfies Record<string, IpcPushChannel>;

/* ------------------------------------------------------------------ */
/* Request / response types                                            */
/* ------------------------------------------------------------------ */

/** Placeholder request for channels that take no arguments. */
export type Empty = Record<string, never>;

/** Generic acknowledgement for mutations that have nothing to return. */
export interface Ack {
  ok: true;
}

/** Response for a delete-by-id channel. */
export interface Deleted {
  id: string;
  deleted: boolean;
}

/** Request shape for the many `{ id }` channels. */
export interface ByIdRequest {
  id: string;
}

/**
 * Channel -> `{ request, response }`.
 *
 * Adding a channel means adding it to {@link IPC} *and* here; the two are kept
 * in sync by {@link IpcChannel} being derived from this interface and
 * {@link IPC_CHANNELS} being checked against it at compile time.
 */
export interface IpcContract {
  /* runs ---------------------------------------------------------- */
  'runs:list': { request: RunListQueryInput; response: Page<Run> };
  'runs:get': { request: ByIdRequest; response: RunDetail | null };
  'runs:start': { request: RunStartRequestInput; response: Run };
  'runs:cancel': {
    request: ByIdRequest;
    response: { id: string; status: RunStatus };
  };
  'runs:events': {
    request: RunEventsQueryInput;
    response: { runId: string; events: RunEvent[]; lastSeq: number };
  };
  /** Start receiving {@link IPC_PUSH.runEvents} for this run on this window. */
  'runs:subscribe': { request: ByIdRequest; response: Ack };
  'runs:unsubscribe': { request: ByIdRequest; response: Ack };

  /* approvals ----------------------------------------------------- */
  'approvals:list-pending': {
    request: { runId?: string };
    response: Approval[];
  };
  'approvals:resolve': { request: ApprovalResolution; response: Approval };
  'approvals:list-grants': {
    request: { scope?: ApprovalScope; runId?: string };
    response: ApprovalGrant[];
  };
  'approvals:revoke-grant': { request: ByIdRequest; response: Deleted };
  /**
   * The durable decision log — every approval that was ever answered, with the
   * arguments it was answered about, including the ones a standing grant
   * answered on the user's behalf.
   *
   * Renderer-only, deliberately. This is the user's oversight record of the
   * agent, so it is never published as an MCP tool: the agent has no business
   * reading the log of what it was allowed to do.
   */
  'approvals:list-audit': {
    request: ApprovalAuditQueryInput;
    response: Page<ApprovalAuditEntry>;
  };

  /* tasks --------------------------------------------------------- */
  'tasks:list': { request: TaskQueryInput; response: Page<Task> };
  'tasks:get': { request: ByIdRequest; response: Task | null };
  'tasks:create': { request: TaskCreateInput; response: Task };
  'tasks:update': { request: TaskUpdate; response: Task };
  'tasks:delete': { request: ByIdRequest; response: Deleted };

  /* goals --------------------------------------------------------- */
  'goals:list': { request: GoalQueryInput; response: Goal[] };
  'goals:get': { request: ByIdRequest; response: Goal | null };
  'goals:write': { request: GoalWrite; response: Goal };
  'goals:delete': { request: ByIdRequest; response: Deleted };

  /* schedule ------------------------------------------------------ */
  'schedule:list': { request: Empty; response: ScheduledJob[] };
  'schedule:get': { request: ByIdRequest; response: ScheduledJob | null };
  'schedule:create': {
    request: ScheduledJobCreateInput;
    response: ScheduledJob;
  };
  'schedule:update': { request: ScheduledJobUpdate; response: ScheduledJob };
  'schedule:delete': { request: ByIdRequest; response: Deleted };
  'schedule:run-now': {
    request: ScheduleRunNowRequestInput;
    response: { jobId: string; runId: string | null; skipped?: string };
  };
  'schedule:validate-cron': {
    request: { cron: string; timezone?: string };
    response: CronValidation;
  };
  /**
   * Evaluation history for a job — including the wake-ups that decided *not*
   * to spawn, which is how the jobs screen shows a condition gate working.
   */
  'schedule:history': {
    request: ScheduleHistoryQueryInput;
    response: Page<ScheduleRunRecord>;
  };

  /* memory (supermemory) ------------------------------------------ */
  'memory:list': { request: MemoryListRequestInput; response: MemoryPage };
  'memory:search': { request: MemorySearchRequestInput; response: MemoryPage };
  'memory:add': { request: MemoryAddRequestInput; response: { id: string } };
  'memory:forget': {
    request: MemoryForgetRequestInput;
    response: { ok: boolean };
  };
  'memory:retry': {
    request: MemoryForgetRequestInput;
    response: { ok: boolean };
  };
  'memory:status': { request: Empty; response: MemoryEngineStatus };

  /* settings ------------------------------------------------------ */
  'settings:get': { request: Empty; response: Settings };
  'settings:set': { request: SettingsPatch; response: Settings };

  /* engines ------------------------------------------------------- */
  'engines:detect': {
    request: EngineDetectRequestInput;
    response: EngineInfo[];
  };
  'engines:status': { request: Empty; response: EnvironmentStatus };

  /* onboarding ---------------------------------------------------- */
  'onboarding:get': { request: Empty; response: OnboardingState };
  'onboarding:set': {
    request: Partial<OnboardingStateInput>;
    response: OnboardingState;
  };

  /* dialog -------------------------------------------------------- */
  'dialog:pick-directory': {
    request: DirectoryPickRequest;
    response: DirectoryPickResult;
  };

  /* system -------------------------------------------------------- */
  /** Current OS microphone permission (macOS: not-determined/granted/denied/…). */
  'system:mic-status': { request: Empty; response: MicPermissionResult };
  /**
   * Ensure OS microphone access: triggers the native prompt when the status is
   * not-determined (registering the app in the OS privacy list), and returns
   * the resulting status. Call before getUserMedia.
   */
  'system:request-mic': { request: Empty; response: MicPermissionResult };
  /** Open the OS microphone privacy pane so the user can grant access. */
  'system:open-mic-settings': { request: Empty; response: Ack };

  /* voice --------------------------------------------------------- */
  /**
   * Transcribe recorded audio to text via OpenAI. The renderer records with
   * MediaRecorder and hands the raw bytes (base64) plus the container mime type
   * here; main forwards to OpenAI's transcription API using the key in settings.
   */
  'voice:transcribe': {
    request: VoiceTranscribeRequest;
    response: VoiceTranscribeResult;
  };

  /* chat ---------------------------------------------------------- */
  'chat:sessions': { request: Empty; response: ChatSessionList };
  'chat:transcript': {
    request: ChatTranscriptRequest;
    response: ChatTranscript;
  };
  'chat:send': { request: ChatSendRequest; response: ChatSendAck };
  'chat:new': { request: Empty; response: ChatSessionRef };
  'chat:select': { request: ChatSelectRequest; response: ChatSessionRef };
  'chat:cancel': { request: Empty; response: Ack };
  'chat:subscribe': { request: Empty; response: Ack };
  'chat:unsubscribe': { request: Empty; response: Ack };

  /* composio ------------------------------------------------------ */
  'composio:status': { request: Empty; response: ComposioStatus };
  'composio:set-key': { request: { apiKey: string }; response: ComposioStatus };
  'composio:connect': { request: Empty; response: ComposioConnectResult };
  'composio:list-toolkits': { request: Empty; response: ComposioToolkit[] };
  'composio:tools-for': {
    request: { toolkitSlug: string };
    response: ComposioToolInfo[];
  };

  /* bots ---------------------------------------------------------- */
  /** The roster, each bot with its live unread count. */
  'bots:list': {
    request: { includeArchived?: boolean };
    response: BotWithUnread[];
  };
  'bots:get': { request: ByIdRequest; response: BotWithUnread | null };
  /** A bot's thread, oldest-first. Blocks are the folded chat render model. */
  'bots:messages': {
    request: BotMessagesQueryInput;
    response: { botId: string; messages: BotMessage[] };
  };
  'bots:create': { request: BotCreateInput; response: BotWithUnread };
  'bots:update': { request: BotUpdateInput; response: BotWithUnread };
  /** Soft-delete (archive). The Main bot cannot be archived. */
  'bots:archive': { request: ByIdRequest; response: Deleted };
  /** Send a prompt to a bot: append the user message, kick the thread runner. */
  'bots:send': { request: BotSendRequestInput; response: BotSendResult };
  'bots:mark-read': {
    request: BotMarkReadRequestInput;
    response: { botId: string; unread: number };
  };
}

/** Whether Composio is configured and what is connected. */
export interface ComposioStatus {
  /** True once a non-empty API key is saved. */
  configured: boolean;
  /** True if the saved key passed a verification call. */
  verified: boolean;
  /** Verification error, if the key was rejected. */
  error?: string;
  /** Slugs of the user's ACTIVE connected toolkits. */
  connectedToolkits: string[];
}

/** A toolkit the user can connect (Gmail, Slack, …). */
export interface ComposioToolkit {
  slug: string;
  name: string;
  /** True if the user already has an active connection to it. */
  connected: boolean;
}

/** Outcome of opening Composio's connections page. */
export interface ComposioConnectResult {
  /** True if the browser was opened to the connections page. */
  opened: boolean;
  /** The URL (so the UI can offer a manual link if the browser didn't open). */
  url: string;
  error?: string;
}

/** One tool available for a connected toolkit — proof the wiring works. */
export interface ComposioToolInfo {
  slug: string;
  name: string;
  description: string;
}

/**
 * A live event streamed from a chat turn as it runs, so the UI can render the
 * response token-by-token, show tool calls the moment they happen, and surface
 * subagent activity in real time. This is a UI-facing normalization of the
 * engine's event stream — the transcript file remains the durable record.
 */
export type ChatStreamEvent =
  /** A chunk of assistant prose. `partial` chunks accumulate; a non-partial is
   *  the complete block for that message. */
  | { kind: 'text'; text: string; partial: boolean; subagent?: string }
  /** A chunk of extended thinking. Same accumulation rule as text. */
  | { kind: 'thinking'; text: string; partial: boolean; subagent?: string }
  /** The assistant invoked a tool. */
  | {
      kind: 'tool-call';
      id: string;
      name: string;
      input: unknown;
      subagent?: string;
    }
  /** A tool returned. Matched to its call by id. */
  | {
      kind: 'tool-result';
      id: string;
      ok: boolean;
      text: string;
      subagent?: string;
    }
  /** A subagent (Task tool) started; `id` is its parent tool-call id. */
  | { kind: 'subagent-start'; id: string; name: string }
  /** A subagent finished — the UI can collapse its live steps into the call. */
  | { kind: 'subagent-end'; id: string }
  /** The turn ended. `ok=false` carries an error message. */
  | { kind: 'done'; ok: boolean; error?: string };

/** One chat session's identity and summary, for the session list. */
export interface ChatSessionSummary {
  sessionId: string;
  /** ai-title from the transcript, else a derived first-line title. */
  title: string | null;
  updatedMs: number;
  /** Rough message count, for the list. */
  messageCount: number;
}

export interface ChatSessionList {
  sessions: ChatSessionSummary[];
  /** The session the UI should show — the resumed/last-active one. */
  currentSessionId: string | null;
}

export interface ChatSessionRef {
  currentSessionId: string | null;
}

export interface ChatTranscriptRequest {
  /** Omit to read the current session. */
  sessionId?: string;
}

/**
 * A session's folded transcript. `turns` is `ChatTurn[]` from the shared
 * transcript parser; typed as unknown-ish here to keep this contract file free
 * of a parser import cycle — the chat store casts it to the parser's type.
 */
export interface ChatTranscript {
  sessionId: string | null;
  title: string | null;
  turns: ChatTurn[];
  /** True while a turn is streaming for this session. */
  busy: boolean;
}

export interface ChatSendRequest {
  prompt: string;
  /** Omit to continue the current session; the module resolves which. */
  sessionId?: string;
  /**
   * Which UI sent this. 'home' layers the minimal tag-protocol system prompt on
   * top (so the home screen renders only tagged, user-facing output); 'chat'
   * (default) is the full chat-tab experience with no tag protocol.
   */
  surface?: 'home' | 'chat';
}

export interface ChatSendAck {
  sessionId: string | null;
  accepted: boolean;
}

export interface ChatSelectRequest {
  sessionId: string;
}

/** Options for the native directory picker. All fields optional. */
export interface DirectoryPickRequest {
  /** Title of the OS dialog. */
  title?: string;
  /** Directory the dialog opens in. */
  defaultPath?: string;
  /** Label on the confirm button, e.g. "Choose". */
  buttonLabel?: string;
}

/** Result of the native directory picker. */
export interface DirectoryPickResult {
  /** The chosen absolute path, or null if the user cancelled. */
  path: string | null;
}

/** OS microphone permission state (mirrors Electron's getMediaAccessStatus). */
export interface MicPermissionResult {
  /** 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'. */
  status: 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';
}

/** Recorded audio to transcribe. */
export interface VoiceTranscribeRequest {
  /** Base64-encoded audio bytes (the MediaRecorder blob). */
  audioBase64: string;
  /** Container mime type, e.g. 'audio/webm' or 'audio/mp4'. */
  mimeType: string;
  /** Optional BCP-47 language hint (e.g. 'en') to improve accuracy. */
  language?: string;
  /** Optional vocabulary/context hint sent to the transcriber to bias spelling of names/jargon. */
  prompt?: string;
}

/** Transcription outcome. `text` is empty when nothing was heard. */
export interface VoiceTranscribeResult {
  text: string;
}

/** Union of every renderer -> main channel name. */
export type IpcChannel = keyof IpcContract;

/** Request payload for a channel. */
export type IpcRequest<C extends IpcChannel> = IpcContract[C]['request'];

/** Response payload for a channel. */
export type IpcResponse<C extends IpcChannel> = IpcContract[C]['response'];

/* ------------------------------------------------------------------ */
/* Push payloads                                                       */
/* ------------------------------------------------------------------ */

/**
 * Push channel -> payload.
 *
 * Run events arrive batched. Per-token IPC traffic pins a core, so the
 * orchestrator coalesces before sending.
 */
export interface IpcPushContract {
  'push:run-events': { runId: string; events: RunEvent[] };
  'push:run-status': { runId: string; status: RunStatus };
  'push:approval-requested': { approval: Approval };
  'push:approval-resolved': {
    approvalId: string;
    runId: string;
    decision: ApprovalDecision;
    scope: ApprovalScope;
  };
  'push:tasks-changed': { ids: string[] };
  'push:goals-changed': { ids: string[] };
  'push:schedule-changed': { ids: string[] };
  'push:settings-changed': { settings: Settings };
  'push:environment-changed': { status: EnvironmentStatus };
  /** A chat session's transcript changed (new content) or its busy state
   *  flipped. The renderer re-reads `chat:transcript` for the session. */
  'push:chat-updated': {
    sessionId: string | null;
    busy: boolean;
    /** True when the set of sessions changed (new/selected). */
    sessionsChanged?: boolean;
  };
  /** A live event from the running chat turn, for token-level streaming. */
  'push:chat-stream': { sessionId: string | null; event: ChatStreamEvent };
  /**
   * A bot's thread changed — a message appended, a streaming bot message grew,
   * or its unread moved. The renderer re-reads `bots:messages` (and, when
   * `rosterChanged`, `bots:list`) for the affected bot.
   */
  'push:bot-thread': { botId: string; rosterChanged?: boolean };
}

export type IpcPushChannel = keyof IpcPushContract;
export type IpcPushPayload<C extends IpcPushChannel> = IpcPushContract[C];

/* ------------------------------------------------------------------ */
/* Runtime helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Flat list of every request channel, for registration loops and for asserting
 * that a handler map covers what it claims to.
 */
export const IPC_CHANNELS = Object.values(IPC).flatMap((group) =>
  Object.values(group),
) as readonly IpcChannel[];

export const IPC_PUSH_CHANNELS = Object.values(
  IPC_PUSH,
) as readonly IpcPushChannel[];

const CHANNEL_SET: ReadonlySet<string> = new Set<string>(IPC_CHANNELS);
const PUSH_CHANNEL_SET: ReadonlySet<string> = new Set<string>(
  IPC_PUSH_CHANNELS,
);

export function isIpcChannel(value: unknown): value is IpcChannel {
  return typeof value === 'string' && CHANNEL_SET.has(value);
}

export function isIpcPushChannel(value: unknown): value is IpcPushChannel {
  return typeof value === 'string' && PUSH_CHANNEL_SET.has(value);
}

/**
 * The envelope every handler's return value is wrapped in before it crosses the
 * bridge. A rejected promise across `ipcRenderer.invoke` loses its type and its
 * stack, so failures are values here, not exceptions.
 */
export type IpcReply<T> =
  | { ok: true; data: T }
  | { ok: false; error: { message: string; code?: string } };
