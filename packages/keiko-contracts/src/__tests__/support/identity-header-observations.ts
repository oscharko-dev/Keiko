import { expect } from "vitest";

type CheckedRecord =
  | { readonly ok: true; readonly value: object }
  | { readonly ok: false; readonly errors: readonly string[] };

/** The identity fields every Code Task record header begins with, in admission order. */
const SHARED_IDENTITY_HEADER = ["kind", "schemaVersion", "taskId", "runId"] as const;

interface HeaderObservation {
  readonly trace: readonly string[];
  readonly receivers: readonly unknown[];
}

/**
 * Replaces each header field of `input` with a getter that records the read and its receiver.
 * The getter of `fault.field`, when given, throws `fault.failure` instead of returning.
 */
export function observeHeaderFields<T extends object>(
  input: T,
  fields: readonly (keyof T & string)[],
  fault?: { readonly field: string; readonly failure: Error },
): HeaderObservation {
  const trace: string[] = [];
  const receivers: unknown[] = [];
  for (const field of fields) {
    const original: unknown = input[field];
    Object.defineProperty(input, field, {
      get(this: unknown): unknown {
        trace.push(field);
        receivers.push(this);
        if (field === fault?.field) throw fault.failure;
        return original;
      },
    });
  }
  return { trace, receivers };
}

/**
 * A healthy header is read once per field, in the `expected` order, on the original receiver.
 * `expected` is stated separately from `fields`, so shrinking the observed list fails the proof.
 */
export function expectHealthyHeaderReads<T extends object>(
  validate: (input: T) => CheckedRecord,
  input: T,
  fields: readonly (keyof T & string)[],
  expected: readonly string[],
): void {
  const { trace, receivers } = observeHeaderFields(input, fields);
  const result = validate(input);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value).toBe(input);
  expect(trace).toEqual(expected);
  expect(receivers).toHaveLength(expected.length);
  for (const receiver of receivers) expect(receiver).toBe(input);
}

/** Each shared identity getter's refusal propagates unchanged, before any later field is read. */
export function expectHeaderGetterRefusals<T extends object>(
  validate: (input: T) => CheckedRecord,
  input: () => T,
  fields: readonly (keyof T & string)[],
): void {
  for (const [index, field] of SHARED_IDENTITY_HEADER.entries()) {
    const failure: Error = Object.freeze(new TypeError("synthetic identity-header refusal"));
    const fixture = input();
    const { trace } = observeHeaderFields(fixture, fields, { field, failure });
    let observed: unknown;
    try {
      validate(fixture);
    } catch (error) {
      observed = error;
    }
    expect(observed).toBe(failure);
    expect(trace).toEqual(SHARED_IDENTITY_HEADER.slice(0, index + 1));
  }
}
