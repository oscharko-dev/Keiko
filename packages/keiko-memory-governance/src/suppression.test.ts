import { describe, expect, it } from "vitest";

import { GovernanceError } from "./errors.js";
import { isMemorySuppressedFromRetrieval } from "./suppression.js";
import { FIXED_NOW_MS, makeRecord } from "./_support.js";

describe("isMemorySuppressedFromRetrieval — status branch", () => {
  it("suppresses archived with reason 'archived'", () => {
    const m = makeRecord({ status: "archived" });
    expect(isMemorySuppressedFromRetrieval(m, FIXED_NOW_MS)).toEqual({
      suppressed: true,
      reason: "archived",
    });
  });

  it("suppresses forgotten with reason 'forgotten'", () => {
    const m = makeRecord({ status: "forgotten" });
    expect(isMemorySuppressedFromRetrieval(m, FIXED_NOW_MS)).toEqual({
      suppressed: true,
      reason: "forgotten",
    });
  });

  it("suppresses conflicted with reason 'conflicted'", () => {
    const m = makeRecord({ status: "conflicted" });
    expect(isMemorySuppressedFromRetrieval(m, FIXED_NOW_MS)).toEqual({
      suppressed: true,
      reason: "conflicted",
    });
  });

  it("suppresses rejected with reason 'rejected'", () => {
    const m = makeRecord({ status: "rejected" });
    expect(isMemorySuppressedFromRetrieval(m, FIXED_NOW_MS)).toEqual({
      suppressed: true,
      reason: "rejected",
    });
  });

  it("suppresses status='expired' with reason 'expired'", () => {
    const m = makeRecord({ status: "expired" });
    expect(isMemorySuppressedFromRetrieval(m, FIXED_NOW_MS)).toEqual({
      suppressed: true,
      reason: "expired",
    });
  });

  it("does NOT suppress accepted memories with healthy confidence and no expiry", () => {
    const m = makeRecord({ status: "accepted", confidence: 0.95 });
    expect(isMemorySuppressedFromRetrieval(m, FIXED_NOW_MS)).toEqual({ suppressed: false });
  });

  it("does NOT suppress proposed memories on the predicate alone (review-queue surfaces them)", () => {
    const m = makeRecord({ status: "proposed", confidence: 0.95 });
    expect(isMemorySuppressedFromRetrieval(m, FIXED_NOW_MS).suppressed).toBe(false);
  });

  it("does NOT suppress superseded by status alone (retrieval layer's includeSuperseded toggle decides)", () => {
    const m = makeRecord({ status: "superseded", confidence: 0.95 });
    expect(isMemorySuppressedFromRetrieval(m, FIXED_NOW_MS).suppressed).toBe(false);
  });
});

describe("isMemorySuppressedFromRetrieval — validity branch", () => {
  it("suppresses accepted memory whose validUntil <= nowMs", () => {
    const m = makeRecord({
      status: "accepted",
      confidence: 0.95,
      validFrom: 1_000,
      validUntil: FIXED_NOW_MS - 1,
    });
    expect(isMemorySuppressedFromRetrieval(m, FIXED_NOW_MS)).toEqual({
      suppressed: true,
      reason: "expired",
    });
  });

  it("suppresses at the exact boundary validUntil == nowMs (inclusive)", () => {
    const m = makeRecord({
      status: "accepted",
      confidence: 0.95,
      validFrom: 1_000,
      validUntil: FIXED_NOW_MS,
    });
    expect(isMemorySuppressedFromRetrieval(m, FIXED_NOW_MS)).toEqual({
      suppressed: true,
      reason: "expired",
    });
  });

  it("does NOT suppress when validUntil > nowMs", () => {
    const m = makeRecord({
      status: "accepted",
      confidence: 0.95,
      validFrom: 1_000,
      validUntil: FIXED_NOW_MS + 1,
    });
    expect(isMemorySuppressedFromRetrieval(m, FIXED_NOW_MS).suppressed).toBe(false);
  });

  it("does NOT apply the validity check when validUntil is undefined", () => {
    const m = makeRecord({ status: "accepted", confidence: 0.95 });
    expect(isMemorySuppressedFromRetrieval(m, FIXED_NOW_MS).suppressed).toBe(false);
  });
});

describe("isMemorySuppressedFromRetrieval — confidence branch", () => {
  it("suppresses with default threshold 0.3 when confidence <= 0.3", () => {
    const m = makeRecord({ status: "accepted", confidence: 0.2 });
    expect(isMemorySuppressedFromRetrieval(m, FIXED_NOW_MS)).toEqual({
      suppressed: true,
      reason: "stale-low-confidence",
    });
  });

  it("suppresses at the exact threshold (confidence == threshold)", () => {
    const m = makeRecord({ status: "accepted", confidence: 0.3 });
    expect(isMemorySuppressedFromRetrieval(m, FIXED_NOW_MS).suppressed).toBe(true);
  });

  it("does NOT suppress when confidence > threshold", () => {
    const m = makeRecord({ status: "accepted", confidence: 0.31 });
    expect(isMemorySuppressedFromRetrieval(m, FIXED_NOW_MS).suppressed).toBe(false);
  });

  it("honours an explicit staleConfidenceThreshold option", () => {
    const m = makeRecord({ status: "accepted", confidence: 0.5 });
    expect(
      isMemorySuppressedFromRetrieval(m, FIXED_NOW_MS, { staleConfidenceThreshold: 0.6 })
        .suppressed,
    ).toBe(true);
    expect(
      isMemorySuppressedFromRetrieval(m, FIXED_NOW_MS, { staleConfidenceThreshold: 0.4 })
        .suppressed,
    ).toBe(false);
  });

  it("throws GovernanceError('invalid-threshold') when staleConfidenceThreshold is NaN", () => {
    const m = makeRecord({ status: "accepted", confidence: 0.5 });
    expect(() =>
      isMemorySuppressedFromRetrieval(m, FIXED_NOW_MS, {
        staleConfidenceThreshold: Number.NaN,
      }),
    ).toThrow(GovernanceError);
  });

  it("throws GovernanceError('invalid-threshold') when staleConfidenceThreshold is out of range", () => {
    const m = makeRecord({ status: "accepted", confidence: 0.5 });
    expect(() =>
      isMemorySuppressedFromRetrieval(m, FIXED_NOW_MS, {
        staleConfidenceThreshold: 1.01,
      }),
    ).toThrow(/invalid-threshold/);
  });
});

describe("isMemorySuppressedFromRetrieval — precedence", () => {
  it("status takes precedence over validity (archived AND expired returns 'archived')", () => {
    const m = makeRecord({
      status: "archived",
      confidence: 0.05,
      validFrom: 1_000,
      validUntil: FIXED_NOW_MS - 1,
    });
    expect(isMemorySuppressedFromRetrieval(m, FIXED_NOW_MS)).toEqual({
      suppressed: true,
      reason: "archived",
    });
  });

  it("validity takes precedence over confidence (expired + low-conf returns 'expired')", () => {
    const m = makeRecord({
      status: "accepted",
      confidence: 0.05,
      validFrom: 1_000,
      validUntil: FIXED_NOW_MS - 1,
    });
    expect(isMemorySuppressedFromRetrieval(m, FIXED_NOW_MS).reason).toBe("expired");
  });
});

describe("isMemorySuppressedFromRetrieval — healthy memory", () => {
  it("does NOT suppress a healthy accepted memory with high confidence and no expiry", () => {
    const m = makeRecord({ status: "accepted", confidence: 0.95 });
    expect(isMemorySuppressedFromRetrieval(m, FIXED_NOW_MS)).toEqual({ suppressed: false });
  });
});
