import { expect } from "vitest";
import type { GitRepositoryParseResult } from "../../git-wire-envelope-validation.js";

function observedReadEnvelope(
  input: Record<string, unknown>,
  reads: string[],
): Record<string, unknown> {
  const observed: ReadonlySet<PropertyKey> = new Set([
    "schemaVersion",
    "root",
    "state",
    "reason",
    "message",
    "repositoryRoot",
  ]);
  return new Proxy(input, {
    get(target, key, receiver): unknown {
      if (observed.has(key)) reads.push(String(key));
      return Reflect.get(target, key, receiver);
    },
  });
}

export function expectGitReadEnvelopeAdmission(
  parse: (input: unknown) => GitRepositoryParseResult<unknown>,
  fixture: () => object,
  expectedReasons: () => readonly string[],
  expectedReads: () => readonly string[],
): void {
  const healthy = fixture();
  const admitted = parse(healthy);
  expect(admitted.ok).toBe(true);
  if (admitted.ok) expect(admitted.value).toBe(healthy);
  const reads: string[] = [];
  const input = observedReadEnvelope(
    {
      ...healthy,
      schemaVersion: 0,
      root: 0,
      state: 0,
      reason: 0,
      message: 0,
      repositoryRoot: 0,
    },
    reads,
  );
  expect(parse(input)).toEqual({ ok: false, reasons: expectedReasons() });
  expect(reads).toEqual(expectedReads());
}

export function expectGitScalarIntegerPreservation<Response>(
  parse: (input: unknown) => GitRepositoryParseResult<Response>,
  inputForCount: (count: unknown) => unknown,
  readCount: (value: Response) => unknown,
  expectedReason: () => string,
): void {
  for (const count of [-0, 0, 1, 9_007_199_254_740_992]) {
    const input = inputForCount(count);
    const result = parse(input);
    if (!result.ok) throw new TypeError("Expected the existing integer admission");
    expect(result.value).toBe(input);
    expect(readCount(result.value)).toBe(count);
  }
  for (const count of [-1, 0.5, NaN, Infinity, "0", true, null]) {
    expect(parse(inputForCount(count))).toEqual({
      ok: false,
      reasons: [expectedReason()],
    });
  }
}
