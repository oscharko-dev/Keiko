import { expect } from "vitest";

type CheckedEnvelope =
  | { readonly ok: true; readonly value: object }
  | { readonly ok: false; readonly errors: readonly string[] };

/** A healthy envelope is admitted as the very object it was given. */
export function expectAcceptedReference<T extends object>(
  validate: (input: T) => CheckedEnvelope,
  value: T,
): void {
  const result = validate(value);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value).toBe(value);
}

/** Each refusal of `null` is a fresh envelope with a fresh errors array. */
export function expectIndependentFailures(
  validate: (input: null) => CheckedEnvelope,
  error: string,
): void {
  const first = validate(null);
  const second = validate(null);
  expect(first).toEqual({ ok: false, errors: [error] });
  expect(second).toEqual(first);
  expect(second).not.toBe(first);
  if (!first.ok && !second.ok) expect(second.errors).not.toBe(first.errors);
}
