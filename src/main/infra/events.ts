/**
 * The in-process event bus.
 *
 * This is how modules talk to each other without importing each other. If
 * `memory` needs to know a run finished, it subscribes here; it never imports
 * `runs`. The name list below is the whole cross-module vocabulary — adding an
 * entry is a deliberate act, and a module that needs a name not on this list
 * should ask whether it really needs to know.
 *
 * Handlers are called synchronously. A throwing handler is caught and reported
 * so one bad subscriber cannot take down an emit.
 */
import { EventEmitter } from 'node:events';
import type { LogLevel } from '../../shared/common';
import type {
  Approval,
  ApprovalDecision,
  ApprovalScope,
} from '../../shared/approvals';
import type { Run, RunEvent, RunStatus } from '../../shared/runs';
import type { EnvironmentStatus } from '../../shared/engines';
import type { MemoryIndexStatus } from '../../shared/memory';
import type { Settings } from '../../shared/settings';
import type { ChatStreamEvent } from '../../shared/ipc';

/** Event name -> payload. The complete cross-module vocabulary. */
export interface AppEvents {
  /* runs */
  'run:created': { run: Run };
  'run:status': { runId: string; status: RunStatus };
  /** One raw timeline event. Subscribers that forward to IPC must batch. */
  'run:event': { runId: string; event: RunEvent };
  'run:finished': { runId: string; status: RunStatus; error?: string };

  /* approvals */
  'approval:requested': { approval: Approval };
  'approval:resolved': {
    approvalId: string;
    runId: string;
    decision: ApprovalDecision;
    scope: ApprovalScope;
  };

  /* domain state */
  'tasks:changed': { ids: string[] };
  'goals:changed': { ids: string[] };
  'schedule:changed': { ids: string[] };
  /** A job's cron fired and its deterministic condition passed. */
  'schedule:due': { jobId: string };
  'memory:indexed': { status: MemoryIndexStatus };
  'memory:doc-changed': { path: string; deleted: boolean };

  /* environment */
  'settings:changed': { settings: Settings };
  'environment:changed': { status: EnvironmentStatus };

  /* chat */
  'chat:updated': {
    sessionId: string | null;
    busy: boolean;
    sessionsChanged?: boolean;
  };
  /** A live event from a running chat turn, forwarded to the UI for streaming. */
  'chat:stream': { sessionId: string | null; event: ChatStreamEvent };

  /* composio */
  /** The user set a new Composio API key in the UI; persist it to settings. */
  'composio:save-key': { apiKey: string };
  /** A Composio connection was added/removed. */
  'composio:connections-changed': Record<string, never>;

  /* lifecycle */
  'module:started': { id: string };
  'module:stopped': { id: string };
  'app:quitting': Record<string, never>;

  /* diagnostics */
  log: { level: LogLevel; scope: string; message: string };
}

export type AppEventName = keyof AppEvents;
export type AppEventPayload<K extends AppEventName> = AppEvents[K];
export type AppEventListener<K extends AppEventName> = (
  payload: AppEvents[K],
) => void;

/** Call to stop listening. Always safe to call more than once. */
export type Unsubscribe = () => void;

export interface EventBus {
  emit<K extends AppEventName>(name: K, payload: AppEvents[K]): void;
  on<K extends AppEventName>(
    name: K,
    listener: AppEventListener<K>,
  ): Unsubscribe;
  once<K extends AppEventName>(
    name: K,
    listener: AppEventListener<K>,
  ): Unsubscribe;
  off<K extends AppEventName>(name: K, listener: AppEventListener<K>): void;
  /** Fires for every event. For the IPC forwarder and for debugging. */
  onAny(
    listener: <K extends AppEventName>(name: K, payload: AppEvents[K]) => void,
  ): Unsubscribe;
  /** Resolve on the next matching event, or reject after `timeoutMs`. */
  waitFor<K extends AppEventName>(
    name: K,
    options?: {
      timeoutMs?: number;
      filter?: (payload: AppEvents[K]) => boolean;
    },
  ): Promise<AppEvents[K]>;
  removeAllListeners(name?: AppEventName): void;
  listenerCount(name: AppEventName): number;
}

export interface EventBusOptions {
  /** Node warns at 10 listeners; a dozen modules plus the UI exceeds that. */
  maxListeners?: number;
  /** Called when a listener throws. Defaults to `console.error`. */
  onListenerError?(error: Error, name: AppEventName): void;
}

const ANY = Symbol('any');

export function createEventBus(options: EventBusOptions = {}): EventBus {
  const { maxListeners = 100, onListenerError } = options;
  const emitter = new EventEmitter();
  emitter.setMaxListeners(maxListeners);

  const reportError = (error: unknown, name: AppEventName): void => {
    const err = error instanceof Error ? error : new Error(String(error));
    if (onListenerError) onListenerError(err, name);
    // eslint-disable-next-line no-console
    else console.error(`[events] listener for "${name}" threw:`, err);
  };

  const wrap = <K extends AppEventName>(
    name: K,
    listener: AppEventListener<K>,
  ) => {
    const guarded = (payload: AppEvents[K]): void => {
      try {
        listener(payload);
      } catch (cause) {
        reportError(cause, name);
      }
    };
    // Keep a back-reference so `off(name, original)` works.
    (guarded as unknown as { original?: unknown }).original = listener;
    return guarded;
  };

  const bus: EventBus = {
    emit(name, payload) {
      emitter.emit(name, payload);
      emitter.emit(ANY as unknown as string, name, payload);
    },

    on(name, listener) {
      const guarded = wrap(name, listener);
      emitter.on(name, guarded as (...args: unknown[]) => void);
      return () => {
        emitter.off(name, guarded as (...args: unknown[]) => void);
      };
    },

    once(name, listener) {
      const guarded = wrap(name, listener);
      emitter.once(name, guarded as (...args: unknown[]) => void);
      return () => {
        emitter.off(name, guarded as (...args: unknown[]) => void);
      };
    },

    off(name, listener) {
      for (const registered of emitter.listeners(name)) {
        const original = (registered as { original?: unknown }).original;
        if (original === listener || registered === listener) {
          emitter.off(name, registered as (...args: unknown[]) => void);
        }
      }
    },

    onAny(listener) {
      const handler = (name: AppEventName, payload: unknown): void => {
        try {
          (listener as (n: AppEventName, p: unknown) => void)(name, payload);
        } catch (cause) {
          reportError(cause, name);
        }
      };
      emitter.on(
        ANY as unknown as string,
        handler as (...a: unknown[]) => void,
      );
      return () => {
        emitter.off(
          ANY as unknown as string,
          handler as (...a: unknown[]) => void,
        );
      };
    },

    waitFor(name, waitOptions = {}) {
      const { timeoutMs, filter } = waitOptions;
      return new Promise((resolve, reject) => {
        let timer: NodeJS.Timeout | undefined;
        const stop = bus.on(name, (payload) => {
          if (filter && !filter(payload)) return;
          if (timer) clearTimeout(timer);
          stop();
          resolve(payload);
        });
        if (timeoutMs !== undefined) {
          timer = setTimeout(() => {
            stop();
            reject(new Error(`Timed out waiting for "${name}"`));
          }, timeoutMs);
          timer.unref?.();
        }
      });
    },

    removeAllListeners(name) {
      if (name) emitter.removeAllListeners(name);
      else emitter.removeAllListeners();
    },

    listenerCount(name) {
      return emitter.listenerCount(name);
    },
  };

  return bus;
}

/**
 * The process-wide bus. `main.ts` wires it into the registry; modules receive
 * it as `ctx.events` and should use that rather than importing this directly,
 * so they stay testable with an isolated bus.
 */
export const appEvents: EventBus = createEventBus();
