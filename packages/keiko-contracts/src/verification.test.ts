import { describe, expect, it } from "vitest";
import {
  DEFAULT_VERIFICATION_LIMITS,
  VERIFICATION_FAILURE_MESSAGE_MAX_CHARS,
  VERIFICATION_MAX_FAILURE_LOCATIONS,
  type VerificationFailureLocation,
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
