import { describe, expect, it } from "vitest";

import { MAX_AGE_MS_DEFAULT, STALE_CONFIDENCE_DEFAULT } from "./_constants.js";
import { FIXED_NOW_MS, makeRecord, must } from "./_support.js";
import { findStaleMemories, type StaleOptions } from "./stale.js";

function options(overrides: Partial<StaleOptions> = {}): StaleOptions {
  return {
    nowMs: FIXED_NOW_MS,
    staleConfidenceThreshold: STALE_CONFIDENCE_DEFAULT,
    maxAgeMs: MAX_AGE_MS_DEFAULT,
    ...overrides,
  };
}

describe("findStaleMemories - expired (validUntil)", () => {
  it("flags a record whose validUntil is strictly before nowMs", () => {
    const r = makeRecord({ id: "m-1", validUntil: FIXED_NOW_MS - 1 });
    const flags = findStaleMemories([r], options());
    expect(flags).toHaveLength(1);
    expect(must(flags[0])).toMatchObject({
      memoryId: "m-1",
      reason: "expired",
      detectedAt: FIXED_NOW_MS,
    });
  });

  it("flags a record whose validUntil equals nowMs (boundary inclusive)", () => {
    const r = makeRecord({ id: "m-1", validUntil: FIXED_NOW_MS });
    const flags = findStaleMemories([r], options());
    expect(flags.map((f) => f.reason)).toContain("expired");
  });

  it("does NOT flag a record whose validUntil is undefined", () => {
    const r = makeRecord({ id: "m-1" });
    const flags = findStaleMemories([r], options());
    expect(flags.filter((f) => f.reason === "expired")).toEqual([]);
  });

  it("does NOT flag a record whose validUntil is strictly after nowMs", () => {
    const r = makeRecord({ id: "m-1", validUntil: FIXED_NOW_MS + 1 });
    const flags = findStaleMemories([r], options());
    expect(flags.filter((f) => f.reason === "expired")).toEqual([]);
  });
});

describe("findStaleMemories - low-confidence", () => {
  it("flags a record whose confidence is at or below the threshold", () => {
    const r = makeRecord({ id: "m-1", confidence: STALE_CONFIDENCE_DEFAULT });
    const flags = findStaleMemories([r], options());
    expect(flags.map((f) => f.reason)).toContain("low-confidence");
  });

  it("does NOT flag a record whose confidence is strictly above the threshold", () => {
    const r = makeRecord({ id: "m-1", confidence: STALE_CONFIDENCE_DEFAULT + 0.01 });
    const flags = findStaleMemories([r], options());
    expect(flags.filter((f) => f.reason === "low-confidence")).toEqual([]);
  });
});

describe("findStaleMemories - aged-out", () => {
  it("flags a record whose updatedAt + maxAgeMs is at or before nowMs (boundary inclusive)", () => {
    const r = makeRecord({
      id: "m-1",
      updatedAt: FIXED_NOW_MS - MAX_AGE_MS_DEFAULT,
    });
    const flags = findStaleMemories([r], options());
    expect(flags.map((f) => f.reason)).toContain("aged-out");
  });

  it("does NOT flag a record whose updatedAt + maxAgeMs is strictly after nowMs", () => {
    const r = makeRecord({
      id: "m-1",
      updatedAt: FIXED_NOW_MS - MAX_AGE_MS_DEFAULT + 1,
    });
    const flags = findStaleMemories([r], options());
    expect(flags.filter((f) => f.reason === "aged-out")).toEqual([]);
  });
});

describe("findStaleMemories - pinned exemption (AC: pinned memories never go stale)", () => {
  it.each([
    {
      name: "pinned + expired",
      overrides: { pinned: true, validUntil: FIXED_NOW_MS - 1 },
    },
    {
      name: "pinned + low-confidence",
      overrides: { pinned: true, confidence: 0.01 },
    },
    {
      name: "pinned + aged-out",
      overrides: {
        pinned: true,
        updatedAt: FIXED_NOW_MS - MAX_AGE_MS_DEFAULT - 1,
      },
    },
    {
      name: "pinned + all three signals at once",
      overrides: {
        pinned: true,
        validUntil: FIXED_NOW_MS - 1,
        confidence: 0.01,
        updatedAt: FIXED_NOW_MS - MAX_AGE_MS_DEFAULT - 1,
      },
    },
  ])("never flags $name", ({ overrides }) => {
    const r = makeRecord({ id: "m-1", ...overrides });
    expect(findStaleMemories([r], options())).toEqual([]);
  });
});

describe("findStaleMemories - already-terminal records skipped", () => {
  it.each(["forgotten", "rejected"] as const)("skips records in status %s", (status) => {
    const r = makeRecord({ id: "m-1", status, validUntil: FIXED_NOW_MS - 1 });
    expect(findStaleMemories([r], options())).toEqual([]);
  });
});

describe("findStaleMemories - multiple reasons on one record", () => {
  it("emits one flag per reason, sorted by reason ASC", () => {
    const r = makeRecord({
      id: "m-1",
      validUntil: FIXED_NOW_MS - 1,
      confidence: 0.01,
      updatedAt: FIXED_NOW_MS - MAX_AGE_MS_DEFAULT - 1,
    });
    const flags = findStaleMemories([r], options());
    expect(flags.map((f) => f.reason)).toEqual(["aged-out", "expired", "low-confidence"]);
  });
});

describe("findStaleMemories - deterministic ordering across input shuffles", () => {
  it("returns the same flags regardless of input order", () => {
    const a = makeRecord({ id: "m-a", validUntil: FIXED_NOW_MS - 1 });
    const b = makeRecord({ id: "m-b", confidence: 0.01 });
    expect(findStaleMemories([a, b], options())).toEqual(findStaleMemories([b, a], options()));
  });
});

describe("findStaleMemories - input immutability", () => {
  it("does not throw on a frozen input array of frozen records", () => {
    const r = Object.freeze(makeRecord({ id: "m-1", validUntil: FIXED_NOW_MS - 1 }));
    const input = Object.freeze([r]);
    expect(() => findStaleMemories(input, options())).not.toThrow();
  });
});
