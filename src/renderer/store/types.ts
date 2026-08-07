/**
 * Conventions every slice in this directory follows.
 *
 * Three rules keep five people's slices interoperable:
 *
 *  1. **State is plain and serialisable.** Entities live in a `Record<id, T>`
 *     plus an `order: string[]`, never a Map or a Set — zustand snapshots are
 *     compared by reference and React DevTools has to be able to read them.
 *  2. **Derived values are computed in a hook with `useMemo`, not in a
 *     selector.** A selector that returns a fresh array on every call makes
 *     `useSyncExternalStore` loop. Each slice exports `useXxx()` hooks for
 *     anything derived.
 *  3. **Loads never throw.** `load()` catches, stores the message in `error`,
 *     and leaves the last good data in place. Every screen must survive a main
 *     process that has not registered its handlers yet.
 */

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/** The fields every slice that fetches something carries. */
export interface LoadableState {
  status: LoadStatus;
  /** Human-readable failure from the last load. Cleared on success. */
  error: string | null;
  /** True when the failure was "main has not wired this up yet". */
  unavailable: boolean;
  /** ISO timestamp of the last successful load. */
  loadedAt: string | null;
}

export const initialLoadable: LoadableState = {
  status: 'idle',
  error: null,
  unavailable: false,
  loadedAt: null,
};
