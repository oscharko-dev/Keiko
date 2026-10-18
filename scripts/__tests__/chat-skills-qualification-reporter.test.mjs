import { describe, expect, it } from "vitest";
import { processError } from "@vitest/utils/error";
import { observeQualification } from "../testing/chat-skills-lab/qualification-reporter.mjs";

expect.extend({
  toBeSyntheticOne(actual) {
    return { pass: actual === 1, message: () => "Synthetic matcher expectation failed" };
  },
});

function matcherError(negated) {
  try {
    if (negated) expect(1).not.toBeSyntheticOne();
    else expect(2).toBeSyntheticOne();
  } catch (error) {
    return processError(error);
  }
  throw new TypeError("Synthetic matcher must fail");
}

function observe(errors, state = "failed", diagnosticAvailable = true) {
  const test = {
    options: { mode: state === "skipped" ? "skip" : "run" },
    result: () => ({ state, errors }),
    diagnostic: () => (diagnosticAvailable ? { retryCount: 0, repeatCount: 0 } : undefined),
  };
  const module = {
    errors: () => [],
    children: { allSuites: () => [], allTests: () => [test] },
  };
  return observeQualification([module], [], "failed");
}

describe("actual runner error and lifecycle observations", () => {
  it.each([false, true])(
    "recognizes the actual serialized matcher error, negated=%s",
    (negated) => {
      const error = matcherError(negated);
      expect(error.name).toBe("Error");
      expect(observe([error])).toMatchObject({ assertionFailures: 1, unclassifiedFailures: 0 });
    },
  );

  it("does not promote a plain Error to assertion evidence", () => {
    expect(observe([processError(new Error("Synthetic unclassified failure"))])).toMatchObject({
      assertionFailures: 0,
      unclassifiedFailures: 1,
    });
  });

  it("retains runtime failure when the same test also has an assertion failure", () => {
    expect(
      observe([matcherError(false), processError(new TypeError("Synthetic runtime"))]),
    ).toMatchObject({
      assertionFailures: 0,
      runtimeFailures: 1,
    });
  });

  it("observes a skipped test even when no diagnostic was produced", () => {
    expect(observe(undefined, "skipped", false)).toMatchObject({
      skippedTests: 1,
      missingDiagnostics: 1,
    });
  });

  it("preserves unavailable global error evidence as unknown", () => {
    expect(observeQualification([], undefined, "interrupted")).toMatchObject({
      endReason: "interrupted",
      unhandledErrors: null,
    });
  });
});
