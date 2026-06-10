import { describe, expect, it } from "vitest";

import { RetrievalError } from "./errors.js";
import { isMemorySuppressed } from "./suppression.js";
import { buildRecord } from "./_support.js";

describe("isMemorySuppressed", () => {
  it("does not suppress accepted records inside their validity window", () => {
    const m = buildRecord({ status: "accepted", confidence: 0.8 });
    expect(isMemorySuppressed(m, 1_000, 0.3)).toEqual({ suppressed: false });
  });

  it.each(
    [["archived"], ["forgotten"], ["conflicted"], ["rejected"], ["expired"], ["proposed"]] as const,
  )(
    "suppresses status=%s",
    (status) => {
      const m = buildRecord({ status });
      const result = isMemorySuppressed(m, 1_000, 0.3);
      expect(result.suppressed).toBe(true);
      expect(result.reason).toBe(status);
    },
  );

  it("does not suppress superseded by status alone", () => {
    expect(isMemorySuppressed(buildRecord({ status: "superseded" }), 1_000, 0.3).suppressed).toBe(
      false,
    );
  });

  it("suppresses when validity.validUntil <= nowMs (expired by validity)", () => {
    const m = buildRecord({ status: "accepted", validFrom: 0, validUntil: 500 });
    const r = isMemorySuppressed(m, 500, 0.3);
    expect(r).toEqual({ suppressed: true, reason: "expired" });
  });

  it("does not suppress when validUntil is in the future", () => {
    const m = buildRecord({ status: "accepted", validFrom: 0, validUntil: 2_000 });
    expect(isMemorySuppressed(m, 1_000, 0.3).suppressed).toBe(false);
  });

  it("suppresses at the threshold boundary (<=)", () => {
    const m = buildRecord({ status: "accepted", confidence: 0.3 });
    expect(isMemorySuppressed(m, 1_000, 0.3)).toEqual({
      suppressed: true,
      reason: "stale-low-confidence",
    });
  });

  it("does not suppress when confidence is strictly above the threshold", () => {
    const m = buildRecord({ status: "accepted", confidence: 0.3001 });
    expect(isMemorySuppressed(m, 1_000, 0.3).suppressed).toBe(false);
  });

  it("throws RetrievalError('invalid-threshold') when threshold is NaN", () => {
    const m = buildRecord({ status: "accepted", confidence: 0.5 });
    expect(() => isMemorySuppressed(m, 1_000, Number.NaN)).toThrow(RetrievalError);
  });

  it("throws RetrievalError('invalid-threshold') when threshold is out of range", () => {
    const m = buildRecord({ status: "accepted", confidence: 0.5 });
    try {
      isMemorySuppressed(m, 1_000, 1.1);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(RetrievalError);
      expect((e as RetrievalError).code).toBe("invalid-threshold");
    }
  });
});
