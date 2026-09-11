import { describe, expect, it } from "vitest";
import {
  VERIFICATION_DEPENDENCY_FAILURE_STATES,
  isVerificationDependencySummary,
  isVerificationReport,
  matchesOverallStatus,
  type VerificationDependencyState,
  type VerificationDependencySummary,
  type VerificationLockfileState,
  type VerificationReport,
  type VerificationResult,
  VERIFICATION_DETAIL_MAX_CHARS,
} from "./verification.js";

// Mirrors the guardedResult()/guardedReport() fixture shape in verification.test.ts (same package)
// rather than inventing a new one; this file only adds the dependencies-summary field on top.
function baseResult(): VerificationResult {
  return {
    kind: "typecheck",
    scriptName: "typecheck",
    command: "npm",
    args: ["run", "typecheck"],
    status: "failed",
    exitCode: 2,
    signal: null,
    durationMs: 1_200,
    truncated: false,
    redacted: true,
    outputSummary: "command output captured (128 bytes) and omitted from summary",
    appliedLimits: [
      { dimension: "wall-time", limit: 120_000, enforced: true },
      { dimension: "output-size", limit: 1_048_576, enforced: true },
      { dimension: "memory", limit: 0, enforced: false, note: "not enforced" },
      { dimension: "network", limit: "none", enforced: true },
    ],
  };
}

function baseReport(overrides: Partial<VerificationReport> = {}): VerificationReport {
  return {
    workspaceRoot: "/workspace",
    results: [baseResult()],
    overallStatus: "failed",
    startedAtMs: 1,
    durationMs: 2,
    counts: {
      passed: 0,
      failed: 1,
      skipped: 0,
      denied: 0,
      "timed-out": 0,
      cancelled: 0,
      "resource-exceeded": 0,
    },
    ...overrides,
  };
}

function dependencySummary(
  overrides: Partial<VerificationDependencySummary> = {},
): VerificationDependencySummary {
  return { state: "installed", lockfile: "absent", exitCode: 0, durationMs: 10, ...overrides };
}

const ALL_DEPENDENCY_STATES: readonly VerificationDependencyState[] = [
  "none",
  "current",
  "installed",
  "refused",
  "failed",
  "timed-out",
  "cancelled",
];
const ALL_LOCKFILE_STATES: readonly VerificationLockfileState[] = ["present", "created", "absent"];

describe("isVerificationDependencySummary", () => {
  it("accepts every valid state/lockfile combination", () => {
    for (const state of ALL_DEPENDENCY_STATES) {
      for (const lockfile of ALL_LOCKFILE_STATES) {
        expect(isVerificationDependencySummary(dependencySummary({ state, lockfile }))).toBe(true);
      }
    }
  });

  it("accepts a summary with a redacted detail string and a null exitCode", () => {
    const summary = dependencySummary({
      exitCode: null,
      detail: "package.json unreadable; dependency installation refused",
    });
    expect(isVerificationDependencySummary(summary)).toBe(true);
  });

  it("rejects a non-object value", () => {
    expect(isVerificationDependencySummary(null)).toBe(false);
    expect(isVerificationDependencySummary("installed")).toBe(false);
    expect(isVerificationDependencySummary(undefined)).toBe(false);
  });

  it("rejects an unknown top-level key", () => {
    expect(isVerificationDependencySummary({ ...dependencySummary(), extra: "hostile" })).toBe(
      false,
    );
  });

  it("rejects an unknown dependency state", () => {
    expect(isVerificationDependencySummary({ ...dependencySummary(), state: "queued" })).toBe(
      false,
    );
  });

  it("rejects an unknown lockfile state", () => {
    expect(isVerificationDependencySummary({ ...dependencySummary(), lockfile: "unknown" })).toBe(
      false,
    );
  });

  it("rejects an exit code outside the 0..255 byte range", () => {
    expect(isVerificationDependencySummary({ ...dependencySummary(), exitCode: -1 })).toBe(false);
    expect(isVerificationDependencySummary({ ...dependencySummary(), exitCode: 256 })).toBe(false);
    expect(isVerificationDependencySummary({ ...dependencySummary(), exitCode: 1.5 })).toBe(false);
  });

  it("rejects a negative or non-finite duration", () => {
    expect(isVerificationDependencySummary({ ...dependencySummary(), durationMs: -1 })).toBe(false);
    expect(
      isVerificationDependencySummary({
        ...dependencySummary(),
        durationMs: Number.POSITIVE_INFINITY,
      }),
    ).toBe(false);
  });

  it("rejects an oversize detail", () => {
    expect(
      isVerificationDependencySummary({ ...dependencySummary(), detail: "x".repeat(2_000) }),
    ).toBe(false);
  });

  it("rejects an empty detail string", () => {
    expect(isVerificationDependencySummary(dependencySummary({ detail: "" }))).toBe(false);
  });

  it("accepts a detail exactly at the accepted maximum length", () => {
    expect(
      isVerificationDependencySummary(
        dependencySummary({ detail: "x".repeat(VERIFICATION_DETAIL_MAX_CHARS) }),
      ),
    ).toBe(true);
  });

  it("rejects a detail one character longer than the accepted maximum", () => {
    expect(
      isVerificationDependencySummary(
        dependencySummary({ detail: "x".repeat(VERIFICATION_DETAIL_MAX_CHARS + 1) }),
      ),
    ).toBe(false);
  });
});

describe("matchesOverallStatus with a dependency summary (ADR-0043 D17)", () => {
  it("requires 'failed' for every VERIFICATION_DEPENDENCY_FAILURE_STATES member, regardless of step statuses", () => {
    for (const state of VERIFICATION_DEPENDENCY_FAILURE_STATES) {
      const dependencies = dependencySummary({ state });
      expect(matchesOverallStatus("failed", [{ status: "skipped" }], dependencies)).toBe(true);
      expect(matchesOverallStatus("passed", [{ status: "skipped" }], dependencies)).toBe(false);
      expect(matchesOverallStatus("skipped", [{ status: "skipped" }], dependencies)).toBe(false);
    }
  });

  it("falls back to the ordinary items-based rule when dependencies did not fail", () => {
    const dependencies = dependencySummary({ state: "installed" });
    expect(matchesOverallStatus("passed", [{ status: "passed" }], dependencies)).toBe(true);
    expect(matchesOverallStatus("failed", [{ status: "passed" }], dependencies)).toBe(false);
  });

  it("still matches 'cancelled' regardless of a dependency failure state", () => {
    const dependencies = dependencySummary({ state: "failed" });
    expect(matchesOverallStatus("cancelled", [{ status: "passed" }], dependencies)).toBe(true);
  });

  it("keeps the no-dependencies overload behaviour unchanged", () => {
    expect(matchesOverallStatus("passed", [{ status: "passed" }])).toBe(true);
  });
});

describe("isVerificationReport with dependencies", () => {
  it("accepts a report without a dependencies field (pre-existing shape)", () => {
    const report = baseReport();
    expect("dependencies" in report).toBe(false);
    expect(isVerificationReport(report)).toBe(true);
  });

  it("accepts a report carrying a valid dependency summary consistent with overallStatus", () => {
    const report = baseReport({ dependencies: dependencySummary({ state: "failed" }) });
    expect(isVerificationReport(report)).toBe(true);
  });

  it("rejects a report carrying a malformed dependency summary", () => {
    const report = baseReport();
    expect(
      isVerificationReport({
        ...report,
        dependencies: { ...dependencySummary(), state: "queued" },
      }),
    ).toBe(false);
  });

  it("rejects a report whose overallStatus disagrees with a failed dependency bootstrap", () => {
    // matchesOverallStatus requires "failed" whenever dependencies.state is a failure state
    // (ADR-0043 D17); "skipped" here would hide a bootstrap that never let any step run.
    const report = baseReport({
      overallStatus: "skipped",
      dependencies: dependencySummary({ state: "failed" }),
    });
    expect(isVerificationReport(report)).toBe(false);
  });
});
