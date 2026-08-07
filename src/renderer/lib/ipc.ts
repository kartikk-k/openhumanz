/**
 * The renderer's IPC client.
 *
 * Everything the UI knows about main goes through here. Three layers:
 *
 *   call()          promise API, fully inferred from `IpcContract`, throws IpcError
 *   subscribe()     push channels, inferred from `IpcPushContract`
 *   useQuery()      the loading/error/data/refetch hook every screen needs
 *
 * There is no react-query in this project and none is coming, so `useQuery`
 * here is deliberately small: one request per hook, cache-less, refetch on
 * demand or on a push channel. If a screen needs something cleverer it should
 * own that state in a zustand slice, not grow this file.
 *
 * The bridge can legitimately be absent (unit tests, the SSR render check, a
 * renderer loaded outside Electron). That is not a crash — it is
 * `IpcError` with code `bridge_unavailable`, and every screen must render
 * sensibly against it. Same for `no_handler`, which is what you get before the
 * main-process module that owns a channel has been registered.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  IpcChannel,
  IpcPushChannel,
  IpcPushPayload,
  IpcReply,
  IpcRequest,
  IpcResponse,
} from '../../shared/ipc';

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/**
 * Every failure the client can produce.
 *
 * `code` is worth branching on:
 *  - `bridge_unavailable` — not running inside Electron.
 *  - `no_handler`         — main has not registered this channel yet.
 *  - anything else        — came from the handler itself.
 */
export class IpcError extends Error {
  readonly channel: string;

  readonly code: string;

  constructor(channel: string, message: string, code = 'ipc_error') {
    super(message);
    this.name = 'IpcError';
    this.channel = channel;
    this.code = code;
  }

  /** True when the failure means "not wired up yet" rather than "went wrong". */
  get isUnavailable(): boolean {
    return this.code === 'bridge_unavailable' || this.code === 'no_handler';
  }
}

/** Coerce anything thrown into an `IpcError` so callers only handle one type. */
export function toIpcError(channel: string, cause: unknown): IpcError {
  if (cause instanceof IpcError) return cause;
  if (cause instanceof Error) return new IpcError(channel, cause.message);
  return new IpcError(channel, String(cause));
}

/* ------------------------------------------------------------------ */
/* Bridge access                                                       */
/* ------------------------------------------------------------------ */

/** True when running inside Electron with the preload bridge installed. */
export function isBridgeAvailable(): boolean {
  return typeof window !== 'undefined' && Boolean(window.assistant);
}

/** `process.platform` as reported by the preload script. */
export function hostPlatform(): string {
  return (typeof window !== 'undefined' && window.assistant?.platform) || '';
}

/* ------------------------------------------------------------------ */
/* Request / response                                                  */
/* ------------------------------------------------------------------ */

/**
 * Invoke a channel and get the raw envelope back. Never throws.
 * Prefer {@link call} unless you specifically want to branch on `ok`.
 */
export async function callReply<C extends IpcChannel>(
  channel: C,
  request: IpcRequest<C>,
): Promise<IpcReply<IpcResponse<C>>> {
  const bridge = typeof window === 'undefined' ? undefined : window.assistant;
  if (!bridge) {
    return {
      ok: false,
      error: {
        message: 'The app is not running inside Electron.',
        code: 'bridge_unavailable',
      },
    };
  }
  try {
    return await bridge.invoke(channel, request);
  } catch (cause) {
    return {
      ok: false,
      error: {
        message: cause instanceof Error ? cause.message : String(cause),
        code: 'invoke_failed',
      },
    };
  }
}

/**
 * Invoke a channel, unwrap the envelope, throw {@link IpcError} on failure.
 * This is the one you want 95% of the time.
 */
export async function call<C extends IpcChannel>(
  channel: C,
  request: IpcRequest<C>,
): Promise<IpcResponse<C>> {
  const result = await callReply(channel, request);
  if (result.ok) return result.data;
  throw new IpcError(channel, result.error.message, result.error.code);
}

/**
 * Invoke a channel and fall back to a value on any failure. Handy for
 * best-effort reads where an empty screen beats an error screen.
 */
export async function callOr<C extends IpcChannel>(
  channel: C,
  request: IpcRequest<C>,
  fallback: IpcResponse<C>,
): Promise<IpcResponse<C>> {
  const result = await callReply(channel, request);
  return result.ok ? result.data : fallback;
}

/* ------------------------------------------------------------------ */
/* Push channels                                                       */
/* ------------------------------------------------------------------ */

export type PushListener<C extends IpcPushChannel> = (
  payload: IpcPushPayload<C>,
) => void;

/**
 * Listen to a main -> renderer push channel.
 * Returns a disposer; calling it twice is safe. A no-op (returning a no-op
 * disposer) when the bridge is absent.
 */
export function subscribe<C extends IpcPushChannel>(
  channel: C,
  listener: PushListener<C>,
): () => void {
  const bridge = typeof window === 'undefined' ? undefined : window.assistant;
  if (!bridge) return () => {};
  return bridge.subscribe(channel, listener);
}

/**
 * `subscribe` as a hook. The listener is held in a ref, so an inline arrow
 * function does not resubscribe on every render — only a change of `channel`
 * or `enabled` does.
 */
export function useSubscription<C extends IpcPushChannel>(
  channel: C,
  listener: PushListener<C>,
  options: { enabled?: boolean } = {},
): void {
  const { enabled = true } = options;
  const ref = useRef(listener);
  ref.current = listener;

  useEffect(() => {
    if (!enabled) return undefined;
    return subscribe(channel, (payload) => {
      ref.current(payload);
    });
  }, [channel, enabled]);
}

/* ------------------------------------------------------------------ */
/* useQuery                                                            */
/* ------------------------------------------------------------------ */

export interface QueryOptions<C extends IpcChannel> {
  /** Skip the request entirely (and report `loading: false`). Default true. */
  enabled?: boolean;
  /** Seed value shown before the first response resolves. */
  initialData?: IpcResponse<C>;
  /**
   * Push channels that should trigger a silent refetch. e.g. a task list
   * passes `['push:tasks-changed']`.
   */
  refetchOn?: readonly IpcPushChannel[];
  /** Poll every N ms while mounted. Off by default — prefer `refetchOn`. */
  pollMs?: number;
  onSuccess?: (data: IpcResponse<C>) => void;
  onError?: (error: IpcError) => void;
}

export interface QueryResult<T> {
  data: T | undefined;
  error: IpcError | null;
  /** True only while a request with no data yet is in flight. */
  loading: boolean;
  /** True while any request is in flight, including a background refetch. */
  fetching: boolean;
  /** Re-run the request. Resolves when it settles; never rejects. */
  refetch: () => Promise<void>;
  /** Optimistically patch the local copy without a round trip. */
  setData: (updater: T | ((previous: T | undefined) => T)) => void;
}

/**
 * One channel, one request, loading/error/data/refetch.
 *
 * The request object is compared by JSON value, not identity, so passing an
 * object literal inline is fine and does not loop. Keep requests small and
 * JSON-serialisable — they cross a process boundary anyway.
 */
export function useQuery<C extends IpcChannel>(
  channel: C,
  request: IpcRequest<C>,
  options: QueryOptions<C> = {},
): QueryResult<IpcResponse<C>> {
  type Data = IpcResponse<C>;
  const {
    enabled = true,
    initialData,
    refetchOn,
    pollMs,
    onSuccess,
    onError,
  } = options;

  const [data, setDataState] = useState<Data | undefined>(initialData);
  const [error, setError] = useState<IpcError | null>(null);
  const [fetching, setFetching] = useState<boolean>(enabled);

  // Value-identity for the request; lets callers pass literals safely.
  const requestKey = JSON.stringify(request ?? null);
  const requestRef = useRef(request);
  requestRef.current = request;

  const callbacksRef = useRef({ onSuccess, onError });
  callbacksRef.current = { onSuccess, onError };

  const mountedRef = useRef(true);
  const runIdRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(async (): Promise<void> => {
    if (!enabled) return;
    runIdRef.current += 1;
    const runId = runIdRef.current;
    setFetching(true);
    const result = await callReply(channel, requestRef.current);
    // A newer request superseded this one, or we unmounted.
    if (!mountedRef.current || runId !== runIdRef.current) return;

    if (result.ok) {
      setDataState(result.data);
      setError(null);
      callbacksRef.current.onSuccess?.(result.data);
    } else {
      const ipcError = new IpcError(
        channel,
        result.error.message,
        result.error.code,
      );
      setError(ipcError);
      callbacksRef.current.onError?.(ipcError);
    }
    setFetching(false);
    // requestKey is the real dependency; requestRef carries the value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, enabled, requestKey]);

  useEffect(() => {
    if (!enabled) {
      setFetching(false);
      return;
    }
    void run();
  }, [run, enabled]);

  useEffect(() => {
    if (!enabled || !pollMs) return undefined;
    const timer = setInterval(() => {
      void run();
    }, pollMs);
    return () => clearInterval(timer);
  }, [run, enabled, pollMs]);

  // Refetch when any of the named push channels fires.
  const channels = useMemo(() => refetchOn ?? [], [refetchOn]);
  const channelsKey = channels.join('|');
  useEffect(() => {
    if (!enabled || channels.length === 0) return undefined;
    const disposers = channels.map((pushChannel) =>
      subscribe(pushChannel, () => {
        void run();
      }),
    );
    return () => disposers.forEach((dispose) => dispose());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, enabled, channelsKey]);

  const setData = useCallback(
    (updater: Data | ((previous: Data | undefined) => Data)) => {
      setDataState((previous) =>
        typeof updater === 'function'
          ? (updater as (p: Data | undefined) => Data)(previous)
          : updater,
      );
    },
    [],
  );

  return {
    data,
    error,
    loading: fetching && data === undefined,
    fetching,
    refetch: run,
    setData,
  };
}

/* ------------------------------------------------------------------ */
/* useMutation                                                         */
/* ------------------------------------------------------------------ */

export interface MutationResult<C extends IpcChannel> {
  /** Fires the request. Resolves with the response, or `null` on failure. */
  mutate: (request: IpcRequest<C>) => Promise<IpcResponse<C> | null>;
  /** Same, but throws {@link IpcError} instead of resolving to `null`. */
  mutateOrThrow: (request: IpcRequest<C>) => Promise<IpcResponse<C>>;
  pending: boolean;
  error: IpcError | null;
  data: IpcResponse<C> | undefined;
  reset: () => void;
}

/**
 * Write-side companion to {@link useQuery}: tracks `pending` and the last
 * error so a form does not have to.
 */
export function useMutation<C extends IpcChannel>(
  channel: C,
  options: {
    onSuccess?: (data: IpcResponse<C>) => void;
    onError?: (error: IpcError) => void;
  } = {},
): MutationResult<C> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<IpcError | null>(null);
  const [data, setData] = useState<IpcResponse<C> | undefined>(undefined);

  const callbacksRef = useRef(options);
  callbacksRef.current = options;

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const mutate = useCallback(
    async (request: IpcRequest<C>): Promise<IpcResponse<C> | null> => {
      setPending(true);
      setError(null);
      const result = await callReply(channel, request);
      if (!mountedRef.current) return result.ok ? result.data : null;
      setPending(false);
      if (result.ok) {
        setData(result.data);
        callbacksRef.current.onSuccess?.(result.data);
        return result.data;
      }
      const ipcError = new IpcError(
        channel,
        result.error.message,
        result.error.code,
      );
      setError(ipcError);
      callbacksRef.current.onError?.(ipcError);
      return null;
    },
    [channel],
  );

  const mutateOrThrow = useCallback(
    async (request: IpcRequest<C>): Promise<IpcResponse<C>> => {
      const result = await mutate(request);
      if (result === null) {
        throw new IpcError(channel, 'Request failed.', 'mutation_failed');
      }
      return result;
    },
    [mutate, channel],
  );

  const reset = useCallback(() => {
    setPending(false);
    setError(null);
    setData(undefined);
  }, []);

  return { mutate, mutateOrThrow, pending, error, data, reset };
}
