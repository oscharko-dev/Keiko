import { describe, expect, it } from "vitest";
import type { AuditResultEntry, VerificationResultSummary } from "./verification-summary.js";
import type { VerificationFailureLocation } from "./verification.js";

const location: VerificationFailureLocation = { file: "src/a.ts", line: 3, message: "bad" };

// ADR-0126 D3: locations propagate into the UI/evidence-facing summary projection, and NEVER into the
// content-free audit projection. TypeScript enforces the audit exclusion at compile time; these tests
// pin the two projections' observable shape.
describe("VerificationResultSummary.locations propagation (ADR-0126 D3)", () => {
  it("carries structured failure locations on the UI-facing summary projection", () => {
    const summary: VerificationResultSummary = {
      kind: "typecheck",
      scriptName: "typecheck",
      command: "npm",
      status: "failed",
      exitCode: 2,
      durationMs: 10,
      truncated: false,
      outputSummary: "",
      appliedLimits: [],
      detail: undefined,
      locations: [location],
    };
    expect(summary.locations).toEqual([location]);
  });

  it("remains valid without locations (additive/optional)", () => {
    const summary: VerificationResultSummary = {
      kind: "lint",
      scriptName: "lint",
      command: "npm",
      status: "passed",
      exitCode: 0,
      durationMs: 5,
      truncated: false,
      outputSummary: "",
      appliedLimits: [],
      detail: undefined,
    };
    expect(summary.locations).toBeUndefined();
  });
});

describe("AuditResultEntry excludes command-derived content (ADR-0126 D3)", () => {
  it("carries no outputSummary, detail, or locations field", () => {
    const audit: AuditResultEntry = {
      kind: "typecheck",
      scriptName: "typecheck",
      command: "npm",
      status: "failed",
      exitCode: 2,
      durationMs: 10,
      truncated: false,
      appliedLimits: [],
    };
    expect("outputSummary" in audit).toBe(false);
    expect("detail" in audit).toBe(false);
    expect("locations" in audit).toBe(false);
  });
});
