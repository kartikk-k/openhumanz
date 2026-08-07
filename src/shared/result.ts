/**
 * A tiny Result type. Used at boundaries where "failed" is an expected outcome
 * (tool handlers, engine detection, file parsing) rather than an exception.
 *
 * Imports nothing. Safe to use from main, renderer and the shim.
 */

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export type Result<T, E = string> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/** Narrow an unknown thrown value into a human-readable message. */
export function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  if (cause === null || cause === undefined) return 'Unknown error';
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

/** Coerce an unknown thrown value into a real Error, preserving the original. */
export function toError(cause: unknown): Error {
  if (cause instanceof Error) return cause;
  const wrapped = new Error(errorMessage(cause));
  (wrapped as Error & { cause?: unknown }).cause = cause;
  return wrapped;
}

export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  throw toError(result.error);
}

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

export function mapOk<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => U,
): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

export function mapErr<T, E, F>(
  result: Result<T, E>,
  fn: (error: E) => F,
): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}

/** Run a sync or async thunk, capturing throws as `Err<Error>`. */
export async function attempt<T>(
  fn: () => T | Promise<T>,
): Promise<Result<T, Error>> {
  try {
    return ok(await fn());
  } catch (cause) {
    return err(toError(cause));
  }
}

/** Synchronous sibling of {@link attempt}. */
export function attemptSync<T>(fn: () => T): Result<T, Error> {
  try {
    return ok(fn());
  } catch (cause) {
    return err(toError(cause));
  }
}
