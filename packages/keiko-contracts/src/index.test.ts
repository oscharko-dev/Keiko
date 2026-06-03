import { describe, it, expect } from "vitest";
import {
  KEIKO_CONTRACTS_VERSION,
  HARNESS_CODES,
  DEFAULT_LIMITS,
  EVIDENCE_SCHEMA_VERSION,
  DEFAULT_RETENTION,
  DEFAULT_PATCH_LIMITS,
  DEFAULT_VERIFICATION_LIMITS,
  EVAL_SCORECARD_SCHEMA_VERSION,
  TERMINAL_STATES,
} from "./index.js";

describe("keiko-contracts package surface", () => {
  it("exposes the version constant pinned at 0.1.0", () => {
    expect(KEIKO_CONTRACTS_VERSION).toBe("0.1.0");
  });

  it("HARNESS_CODES.LIMIT_ITERATIONS is the canonical code string", () => {
    expect(HARNESS_CODES.LIMIT_ITERATIONS).toBe("HARNESS_LIMIT_ITERATIONS");
  });

  it("DEFAULT_LIMITS.maxIterations is 10", () => {
    expect(DEFAULT_LIMITS.maxIterations).toBe(10);
  });

  it("EVIDENCE_SCHEMA_VERSION is the literal string '1'", () => {
    expect(EVIDENCE_SCHEMA_VERSION).toBe("1");
  });

  it("DEFAULT_RETENTION.maxRuns is 50", () => {
    expect(DEFAULT_RETENTION.maxRuns).toBe(50);
  });

  it("DEFAULT_PATCH_LIMITS has a positive maxFilesChanged", () => {
    expect(DEFAULT_PATCH_LIMITS.maxFilesChanged).toBeGreaterThan(0);
  });

  it("DEFAULT_VERIFICATION_LIMITS has a positive wallTimeMs", () => {
    expect(DEFAULT_VERIFICATION_LIMITS.wallTimeMs).toBeGreaterThan(0);
  });

  it("EVAL_SCORECARD_SCHEMA_VERSION is the literal string '1'", () => {
    expect(EVAL_SCORECARD_SCHEMA_VERSION).toBe("1");
  });

  it("TERMINAL_STATES contains 'completed' and 'failed'", () => {
    expect(TERMINAL_STATES.has("completed")).toBe(true);
    expect(TERMINAL_STATES.has("failed")).toBe(true);
  });
});
