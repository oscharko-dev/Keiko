import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonReporter } from "vitest/node";
import { Buffer } from "node:buffer";
import { processError } from "@vitest/utils/error";
import QualificationReporter, {
  observeQualification,
} from "../testing/chat-skills-lab/qualification-reporter.mjs";

afterEach(() => vi.restoreAllMocks());

async function actualReport(errors, reason = "passed") {
  let report;
  vi.spyOn(JsonReporter.prototype, "writeReport").mockImplementation((text) => {
    report = JSON.parse(text);
    return Promise.resolve();
  });
  const reporter = new QualificationReporter();
  reporter.onInit({ config: { passWithNoTests: true }, snapshot: { summary: {} } });
  await reporter.onTestRunEnd([], errors, reason);
  return report;
}

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
  it("retains the actual global error for private feedback without promoting its execution", async () => {
    const report = await actualReport([
      processError(new TypeError("Synthetic asynchronous collaborator failure")),
    ]);
    expect(report.qualification.unhandledErrors).toBe(1);
    expect(report.qualificationDiagnostics?.text).toContain(
      "Synthetic asynchronous collaborator failure",
    );
    expect(report.qualificationDiagnostics?.text).toContain("TypeError");
    expect(report.qualificationDiagnostics).toMatchObject({
      errorCount: 1,
      capturedErrorCount: 1,
      complete: true,
      truncated: false,
    });
  });

  it("bounds actual multibyte errors without splitting UTF-8 or losing the source count", async () => {
    const report = await actualReport([
      processError(new TypeError("🧪".repeat(5000))),
      processError(new RangeError("Later diagnostic beyond the original byte grant")),
    ]);
    const diagnostics = report.qualificationDiagnostics;
    expect(report.qualification.unhandledErrors).toBe(2);
    expect(Buffer.byteLength(diagnostics.text)).toBeLessThanOrEqual(8192);
    expect(diagnostics.text).toContain("TypeError");
    expect(diagnostics.text).not.toContain("\uFFFD");
    expect(diagnostics.text).not.toContain("Later diagnostic");
    expect(diagnostics).toMatchObject({
      errorCount: 2,
      capturedErrorCount: 1,
      complete: false,
      truncated: true,
    });
  });

  it("does not claim an error was captured when no complete character fits", async () => {
    const report = await actualReport([{ message: "x".repeat(8188) }, { message: "🧪" }]);
    expect(report.qualificationDiagnostics).toMatchObject({
      text: "x".repeat(8188),
      errorCount: 2,
      capturedErrorCount: 1,
      complete: false,
      truncated: true,
    });
  });

  it("keeps missing global observations unknown on interruption", async () => {
    const report = await actualReport(undefined, "interrupted");
    expect(report.qualification).toMatchObject({ endReason: "interrupted", unhandledErrors: null });
    expect(report.qualificationDiagnostics).toMatchObject({
      errorCount: null,
      capturedErrorCount: 0,
      text: "",
      complete: false,
    });
  });

  it("does not manufacture a cause from an error name without message or location", async () => {
    const report = await actualReport([{ name: "TypeError" }]);
    expect(report.qualificationDiagnostics).toMatchObject({
      errorCount: 1,
      capturedErrorCount: 0,
      text: "",
      complete: false,
      truncated: false,
    });
  });

  it("keeps a clean observation empty", async () => {
    const report = await actualReport([]);
    expect(report.qualificationDiagnostics).toEqual({
      schemaVersion: 1,
      errorCount: 0,
      capturedErrorCount: 0,
      text: "",
      complete: true,
      truncated: false,
    });
  });

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
