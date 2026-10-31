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

/** Admission returns the very input and nested references and leaves its serialized bytes intact. */
export function expectUnchangedAdmission<T extends object>(
  validate: (
    input: T,
  ) =>
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly errors: readonly string[] },
  input: T,
  nested: readonly (keyof T)[],
): void {
  const before = JSON.stringify(input);
  const result = validate(input);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toBe(input);
    for (const key of nested) expect(result.value[key]).toBe(input[key]);
  }
  expect(JSON.stringify(input)).toBe(before);
}

/** Admits a proxy of `target` that checks every read's receiver, and returns the field reads. */
export function receiverCheckedReads<T extends object>(
  validate: (input: T) => CheckedEnvelope,
  target: T,
): readonly string[] {
  const reads: string[] = [];
  const input: T = new Proxy(target, {
    get(original, key, receiver): unknown {
      expect(receiver).toBe(input);
      reads.push(String(key));
      return Reflect.get(original, key, receiver);
    },
  });
  expectAcceptedReference(validate, input);
  return reads;
}
