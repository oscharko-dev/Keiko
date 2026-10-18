import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyGeneratedTests } from "../testing/chat-skills-lab/verify-tests.mjs";

const execution = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: execution.run }));
const roots = [];

function report(failed = false) {
  return {
    numTotalTests: 1,
    numPassedTests: failed ? 0 : 1,
    numFailedTests: failed ? 1 : 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [{ assertionResults: [{ status: failed ? "failed" : "passed" }] }],
    qualification: {
      schemaVersion: 1,
      endReason: failed ? "failed" : "passed",
      observedTests: 1,
      passedTests: failed ? 0 : 1,
      assertionFailures: failed ? 1 : 0,
      runtimeFailures: 0,
      unclassifiedFailures: 0,
      skippedTests: 0,
      expectedFailureTests: 0,
      focusedTests: 0,
      retriedTests: 0,
      repeatedTests: 0,
      collectionErrors: 0,
      missingDiagnostics: 0,
      unhandledErrors: 0,
    },
  };
}

function verify(baseline, mutation) {
  const root = mkdtempSync(join(tmpdir(), "keiko-skill-verifier-"));
  roots.push(root);
  const dependencies = join(root, "dependencies");
  mkdirSync(dependencies);
  const results = [baseline, mutation];
  execution.run.mockImplementation((command, args) => {
    expect(command).toBe("docker");
    if (args[0] === "rm") return "";
    const result = results.shift();
    const output = JSON.stringify(result);
    if (result.numFailedTests > 0)
      throw Object.assign(new Error("test-failure"), { status: 1, stdout: output });
    return output;
  });
  return verifyGeneratedTests("```tsx\nexport {};\n```", join(root, "run"), dependencies);
}

afterEach(() => {
  execution.run.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("generated-test qualification uses complete actual runner observations", () => {
  it("accepts a clean correct subject and an assertion-only independent defect", () => {
    expect(verify(report(), report(true)).passed).toBe(true);
  });

  it("refuses an unhandled error hidden by the standard JSON reporter", () => {
    const mutation = report(true);
    mutation.qualification.unhandledErrors = 1;
    expect(verify(report(), mutation).passed).toBe(false);
  });

  it("does not count a test runtime failure as an assertion detecting a defect", () => {
    const mutation = report(true);
    mutation.qualification.assertionFailures = 0;
    mutation.qualification.runtimeFailures = 1;
    expect(verify(report(), mutation).passed).toBe(false);
  });

  it.each([
    "expectedFailureTests",
    "focusedTests",
    "skippedTests",
    "retriedTests",
    "repeatedTests",
  ])("refuses a correct-subject observation containing %s", (field) => {
    const baseline = report();
    baseline.qualification[field] = 1;
    expect(verify(baseline, report(true)).passed).toBe(false);
  });

  it("keeps missing runner error evidence unknown instead of defaulting it to zero", () => {
    const mutation = report(true);
    delete mutation.qualification;
    expect(verify(report(), mutation).passed).toBe(false);
  });

  it("requires the actual global error observation", () => {
    const mutation = report(true);
    delete mutation.qualification.unhandledErrors;
    const result = verify(report(), mutation);
    expect(result.passed).toBe(false);
    expect(result.mutation.runtimeErrors).toBeNull();
  });

  it("refuses interrupted runner observations", () => {
    const mutation = report(true);
    mutation.qualification.endReason = "interrupted";
    expect(verify(report(), mutation).passed).toBe(false);
  });

  it("refuses inconsistent runner observations", () => {
    const mutation = report(true);
    mutation.qualification.observedTests = 2;
    expect(verify(report(), mutation).passed).toBe(false);
  });

  it("requires the actual test-case inventory to agree with reported totals", () => {
    const mutation = report(true);
    mutation.testResults[0].assertionResults = [];
    expect(verify(report(), mutation).passed).toBe(false);
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, "0"])(
    "refuses an invalid observed error count %s",
    (count) => {
      const mutation = report(true);
      mutation.qualification.unhandledErrors = count;
      expect(verify(report(), mutation).passed).toBe(false);
    },
  );
});
