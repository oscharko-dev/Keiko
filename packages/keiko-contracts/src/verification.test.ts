import { describe, expect, it } from "vitest";
import {
  DEFAULT_VERIFICATION_LIMITS,
  VERIFICATION_FAILURE_MESSAGE_MAX_CHARS,
  VERIFICATION_MAX_FAILURE_LOCATIONS,
  isVerificationFailureLocation,
  isVerificationReport,
  isVerificationResult,
  type VerificationFailureLocation,
  type VerificationReport,
  type VerificationResult,
} from "./verification.js";

// A result fixture in the pre-#2210 shape (no `locations` field) must still be a valid
// VerificationResult — the `locations` extension is additive and optional (ADR-0126 D3).
function baselineResult(): VerificationResult {
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
    appliedLimits: [],
  };
}

function guardedResult(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    ...baselineResult(),
    appliedLimits: [
      { dimension: "wall-time", limit: 120_000, enforced: true },
      { dimension: "output-size", limit: 1_048_576, enforced: true },
      { dimension: "memory", limit: 0, enforced: false, note: "not enforced" },
      { dimension: "network", limit: "none", enforced: true },
    ],
    ...overrides,
  };
}

function guardedReport(result: VerificationResult = guardedResult()): VerificationReport {
  return {
    workspaceRoot: "/workspace",
    results: [result],
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
  };
}

describe("VerificationResult.locations (additive)", () => {
  it("keeps the pre-existing shape valid without a locations field (backward compatible)", () => {
    const result = baselineResult();
    expect(result.locations).toBeUndefined();
    expect("locations" in result).toBe(false);
  });

  it("carries structured failure locations when present", () => {
    const location: VerificationFailureLocation = {
      file: "src/a.ts",
      line: 12,
      column: 34,
      message: "Type 'string' is not assignable to type 'number'.",
      ruleId: "TS2322",
    };
    const result: VerificationResult = { ...baselineResult(), locations: [location] };
    expect(result.locations).toHaveLength(1);
    expect(result.locations?.[0]?.ruleId).toBe("TS2322");
  });

  it("allows a location with only a file (line/column/ruleId optional)", () => {
    const location: VerificationFailureLocation = { file: "src/b.ts", message: "boom" };
    expect(location.line).toBeUndefined();
    expect(location.column).toBeUndefined();
    expect(location.ruleId).toBeUndefined();
  });
});

describe("verification failure-location caps", () => {
  it("exposes frozen, positive numeric bounds the parser must honor", () => {
    expect(Number.isInteger(VERIFICATION_MAX_FAILURE_LOCATIONS)).toBe(true);
    expect(VERIFICATION_MAX_FAILURE_LOCATIONS).toBeGreaterThan(0);
    expect(Number.isInteger(VERIFICATION_FAILURE_MESSAGE_MAX_CHARS)).toBe(true);
    expect(VERIFICATION_FAILURE_MESSAGE_MAX_CHARS).toBeGreaterThan(0);
  });

  it("leaves the existing default limits unchanged", () => {
    expect(DEFAULT_VERIFICATION_LIMITS.wallTimeMs).toBe(120_000);
    expect(DEFAULT_VERIFICATION_LIMITS.network).toBe("none");
  });
});

describe("deep verification wire guards", () => {
  it("accepts the canonical producer shape", () => {
    expect(isVerificationResult(guardedResult())).toBe(true);
    expect(isVerificationReport(guardedReport())).toBe(true);
  });

  it("rejects open-ended or non-redacted result shapes", () => {
    const result = guardedResult();
    expect(isVerificationResult({ ...result, kind: "deploy" })).toBe(false);
    expect(isVerificationResult({ ...result, status: "warning" })).toBe(false);
    expect(isVerificationResult({ ...result, redacted: false })).toBe(false);
    expect(isVerificationResult({ ...result, extra: "hostile" })).toBe(false);
    expect(isVerificationResult({ ...result, durationMs: Number.NaN })).toBe(false);
    expect(isVerificationResult({ ...result, durationMs: -1 })).toBe(false);
  });

  it("requires a complete, unique, exact applied-limit shape", () => {
    const result = guardedResult();
    expect(
      isVerificationResult({ ...result, appliedLimits: result.appliedLimits.slice(0, 3) }),
    ).toBe(false);
    expect(
      isVerificationResult({
        ...result,
        appliedLimits: [result.appliedLimits[0], ...result.appliedLimits.slice(0, 3)],
      }),
    ).toBe(false);
    expect(
      isVerificationResult({
        ...result,
        appliedLimits: [{ dimension: "cpu", limit: 1, enforced: true }],
      }),
    ).toBe(false);
    expect(
      isVerificationResult({
        ...result,
        appliedLimits: [
          { ...result.appliedLimits[0], note: "ok", secret: "leak" },
          ...result.appliedLimits.slice(1),
        ],
      }),
    ).toBe(false);
  });

  it("validates bounded, workspace-relative failure locations deeply", () => {
    const valid = { file: "src/a.ts", line: 1, column: 2, message: "boom", ruleId: "TS1" };
    expect(isVerificationFailureLocation(valid)).toBe(true);
    for (const file of [
      "/etc/passwd",
      "../escape.ts",
      "src/../escape.ts",
      "C:\\x.ts",
      "\\\\host\\x.ts",
      "src\\a.ts",
      "src/a\u0000.ts",
    ]) {
      expect(isVerificationFailureLocation({ ...valid, file })).toBe(false);
    }
    expect(isVerificationFailureLocation({ ...valid, line: 0 })).toBe(false);
    expect(isVerificationFailureLocation({ ...valid, column: 2_147_483_648 })).toBe(false);
    expect(isVerificationFailureLocation({ ...valid, line: undefined, column: 2 })).toBe(false);
    expect(
      isVerificationFailureLocation({
        ...valid,
        message: "x".repeat(VERIFICATION_FAILURE_MESSAGE_MAX_CHARS + 1),
      }),
    ).toBe(false);
    expect(isVerificationFailureLocation({ ...valid, extra: true })).toBe(false);
  });

  it("rejects oversized location arrays and malformed nested locations", () => {
    const valid = { file: "src/a.ts", message: "boom" };
    expect(
      isVerificationResult({
        ...guardedResult(),
        locations: Array.from({ length: VERIFICATION_MAX_FAILURE_LOCATIONS + 1 }, () => valid),
      }),
    ).toBe(false);
    expect(
      isVerificationResult({ ...guardedResult(), locations: [{ ...valid, file: "/host/a.ts" }] }),
    ).toBe(false);
  });

  it("requires finite consistent status counts and bounded exact report fields", () => {
    const report = guardedReport();
    expect(isVerificationReport({ ...report, overallStatus: "unknown" })).toBe(false);
    expect(isVerificationReport({ ...report, overallStatus: "passed" })).toBe(false);
    expect(isVerificationReport({ ...report, durationMs: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isVerificationReport({ ...report, startedAtMs: -1 })).toBe(false);
    expect(isVerificationReport({ ...report, extra: true })).toBe(false);
    expect(isVerificationReport({ ...report, counts: { ...report.counts, failed: 0 } })).toBe(
      false,
    );
    expect(isVerificationReport({ ...report, counts: { ...report.counts, other: 1 } })).toBe(false);
    expect(
      isVerificationReport({ ...report, counts: { ...report.counts, failed: Number.NaN } }),
    ).toBe(false);
    expect(isVerificationReport({ ...report, workspaceRoot: `/${"😀".repeat(2_048)}` })).toBe(
      false,
    );
  });
});
