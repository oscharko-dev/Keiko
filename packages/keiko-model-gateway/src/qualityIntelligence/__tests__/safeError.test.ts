import { describe, expect, it } from "vitest";
import {
  QualityIntelligenceSafeErrorException,
  makeBudgetExhaustedError,
  makeCancelledError,
  makeCapabilityMismatchError,
  makeProviderError,
  makeRedactionFailedError,
  makeTimeoutError,
} from "../safeError.js";

const FORBIDDEN_SUBSTRINGS = ["apikey", "Bearer ", "endpoint=", "prompt="] as const;

const SAMPLE_UNTRUSTED_EVIDENCE = ["BEGIN-SECRET ", "sk-", "very-secret-token END-SECRET"].join("");

function assertSafeMessage(message: string): void {
  for (const sub of FORBIDDEN_SUBSTRINGS) {
    expect(message.toLowerCase()).not.toContain(sub.toLowerCase());
  }
  expect(message).not.toContain(SAMPLE_UNTRUSTED_EVIDENCE);
}

describe("Quality Intelligence safe error taxonomy", () => {
  it("makeCapabilityMismatchError carries only profile id + missing list", () => {
    const err = makeCapabilityMismatchError("qi:judge-logic", ["structured-output"]);
    expect(err.code).toBe("qi/capability-mismatch");
    assertSafeMessage(err.message);
    expect(err.missingCapabilities).toEqual(["structured-output"]);
    expect(Object.isFrozen(err)).toBe(true);
    expect(Object.isFrozen(err.missingCapabilities)).toBe(true);
  });

  it("every safe-error factory yields a static, secret-free message", () => {
    const errors = [
      makeBudgetExhaustedError("qi:judge-logic"),
      makeTimeoutError("qi:judge-logic", 30_000),
      makeCancelledError("qi:judge-logic"),
      makeProviderError("qi:judge-logic"),
      makeRedactionFailedError("qi:judge-logic"),
    ];
    for (const err of errors) {
      assertSafeMessage(err.message);
      expect(Object.isFrozen(err)).toBe(true);
    }
  });

  it("QualityIntelligenceSafeErrorException preserves the safe payload", () => {
    const safe = makeTimeoutError("qi:judge-logic", 30_000);
    const exception = new QualityIntelligenceSafeErrorException(safe);
    expect(exception).toBeInstanceOf(Error);
    expect(exception.safe).toBe(safe);
    expect(exception.message).toBe(safe.message);
    expect(exception.name).toBe("QualityIntelligenceSafeErrorException");
    assertSafeMessage(exception.message);
  });
});
