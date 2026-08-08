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
import type {
  Approval,
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
  MemoryDoc,
  MemoryDocContent,
  MemoryGetRequest,
  MemoryIndexStatus,
  MemoryListQueryInput,
  MemorySearchHit,
  MemorySearchQueryInput,
  MemoryWriteRequestInput,
} from './memory';
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
    search: 'memory:search',
    get: 'memory:get',
    list: 'memory:list',
    write: 'memory:write',
    status: 'memory:status',
    reindex: 'memory:reindex',
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
  memoryIndexed: 'push:memory-indexed',
  memoryDocChanged: 'push:memory-doc-changed',
  settingsChanged: 'push:settings-changed',
  environmentChanged: 'push:environment-changed',
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

  /* memory -------------------------------------------------------- */
  'memory:search': {
    request: MemorySearchQueryInput;
    response: MemorySearchHit[];
  };
  'memory:get': {
    request: MemoryGetRequest;
    response: MemoryDocContent | null;
  };
  'memory:list': { request: MemoryListQueryInput; response: Page<MemoryDoc> };
  'memory:write': { request: MemoryWriteRequestInput; response: MemoryDoc };
  'memory:status': { request: Empty; response: MemoryIndexStatus };
  'memory:reindex': {
    request: { full?: boolean };
    response: MemoryIndexStatus;
  };

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
  'push:memory-indexed': { status: MemoryIndexStatus };
  /** A single vault doc was added, rewritten or removed. Path-scoped so the
   * memory browser can invalidate one row instead of the whole list. */
  'push:memory-doc-changed': { path: string; deleted: boolean };
  'push:settings-changed': { settings: Settings };
  'push:environment-changed': { status: EnvironmentStatus };
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
