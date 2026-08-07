/**
 * The context bridge.
 *
 * This is the *only* file the renderer is allowed to share with main, and the
 * only place `ipcRenderer` is ever touched. It exposes a deliberately small
 * surface on `window.assistant`:
 *
 *   invoke(channel, request)          one request/response round trip
 *   subscribe(channel, listener)      main -> renderer push, returns a disposer
 *   unsubscribeAll(channel)           belt-and-braces cleanup
 *   platform / versions               inert strings, no Node APIs
 *
 * Two rules hold here:
 *
 *  1. **Channels are validated against the shared registry before forwarding.**
 *     We never expose a generic `ipcRenderer.invoke(anything, ...)` — that hands
 *     a compromised renderer the whole main-process surface, including channels
 *     Electron itself registers.
 *  2. **Failures are values, not rejections.** A rejected promise across the
 *     bridge loses its type and its stack, so every outcome comes back as an
 *     `IpcReply`. The renderer client re-throws a typed error if it wants one.
 *
 * `contextIsolation` stays on and nothing from `node:*` is exposed.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  isIpcChannel,
  isIpcPushChannel,
  type IpcChannel,
  type IpcPushChannel,
  type IpcPushPayload,
  type IpcReply,
  type IpcRequest,
  type IpcResponse,
} from '../shared/ipc';

/** Listener signature for a push channel. */
export type PushListener<C extends IpcPushChannel> = (
  payload: IpcPushPayload<C>,
) => void;

/** Disposer returned by {@link AssistantBridge.subscribe}. */
export type Unsubscribe = () => void;

function reply<T>(message: string, code: string): IpcReply<T> {
  return { ok: false, error: { message, code } };
}

/**
 * A handler is supposed to return an `IpcReply` already. If something upstream
 * returns a bare value (or nothing) we normalise rather than crash the caller.
 */
function normalise<T>(value: unknown, channel: string): IpcReply<T> {
  if (value && typeof value === 'object' && 'ok' in value) {
    return value as IpcReply<T>;
  }
  return reply<T>(
    `Handler for "${channel}" returned a malformed reply.`,
    'malformed_reply',
  );
}

async function invoke<C extends IpcChannel>(
  channel: C,
  request: IpcRequest<C>,
): Promise<IpcReply<IpcResponse<C>>> {
  if (!isIpcChannel(channel)) {
    return reply<IpcResponse<C>>(
      `Unknown IPC channel "${String(channel)}".`,
      'unknown_channel',
    );
  }
  try {
    const raw: unknown = await ipcRenderer.invoke(channel, request);
    return normalise<IpcResponse<C>>(raw, channel);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // The most common shape of this in normal development: the module that owns
    // the channel has not been registered yet.
    const code = /No handler registered/i.test(message)
      ? 'no_handler'
      : 'invoke_failed';
    return reply<IpcResponse<C>>(message, code);
  }
}

function subscribe<C extends IpcPushChannel>(
  channel: C,
  listener: PushListener<C>,
): Unsubscribe {
  if (!isIpcPushChannel(channel)) {
    throw new Error(`Unknown IPC push channel "${String(channel)}".`);
  }
  if (typeof listener !== 'function') {
    throw new TypeError('subscribe() requires a listener function.');
  }

  const handler = (_event: IpcRendererEvent, payload: unknown) => {
    listener(payload as IpcPushPayload<C>);
  };

  ipcRenderer.on(channel, handler);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    ipcRenderer.removeListener(channel, handler);
  };
}

function unsubscribeAll(channel: IpcPushChannel): void {
  if (!isIpcPushChannel(channel)) return;
  ipcRenderer.removeAllListeners(channel);
}

const bridge = {
  invoke,
  subscribe,
  unsubscribeAll,
  platform: process.platform,
  versions: {
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? '',
  },
};

export type AssistantBridge = typeof bridge;

contextBridge.exposeInMainWorld('assistant', bridge);
