import { expect } from "vitest";

interface DiagnosticCase {
  readonly input: unknown;
  readonly reasons: readonly string[];
}

/** Every validator refuses each case with exactly its reasons, and the witness counts them. */
export function expectDiagnosticRefusals(
  cases: readonly DiagnosticCase[],
  validators: readonly ((input: unknown) => object)[],
  count: (input: unknown) => number,
): void {
  for (const { input, reasons } of cases) {
    for (const validate of validators) expect(validate(input)).toEqual({ ok: false, reasons });
    expect(count(input)).toBe(reasons.length);
  }
}
