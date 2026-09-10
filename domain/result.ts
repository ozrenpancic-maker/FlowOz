/**
 * Typed result envelope. Every adapter and every calculation in FLOWVISION
 * returns either a value or a typed failure — never `null` standing in for a
 * number, never a silent throw. `0` is a real discharge; a withheld result is
 * an `err`, and the UI must render it as withheld rather than as zero.
 */

export interface Ok<T> {
  ok: true;
  value: T;
}

export interface Err<E> {
  ok: false;
  error: E;
}

export type Result<T, E> = Ok<T> | Err<E>;

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

/** A failure carrying a stable code, a translation key and the raw detail. */
export interface FailureBase<C extends string> {
  code: C;
  /** i18n key for the operator-facing headline. */
  messageKey: string;
  /** Raw technical detail. Always surfaced somewhere in the UI, never swallowed. */
  detail?: string;
}
