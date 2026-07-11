import { describe, expect, it } from "vitest";
import { DEFAULT_TEST_LIMITS, validateIntakeLimits } from "./config.js";

describe("finite production limits", () => {
  it.each([0, -1, Number.POSITIVE_INFINITY, Number.NaN])("rejects %s", (invalid) => {
    expect(() => validateIntakeLimits({ ...DEFAULT_TEST_LIMITS, global: invalid })).toThrow(
      "global",
    );
  });

  it("returns an immutable snapshot instead of retaining caller-owned configuration", () => {
    const source = { ...DEFAULT_TEST_LIMITS };
    const validated = validateIntakeLimits(source);
    source.global = 1;

    expect(Object.isFrozen(validated)).toBe(true);
    expect(validated.global).toBe(DEFAULT_TEST_LIMITS.global);
  });

  it.each(Object.keys(DEFAULT_TEST_LIMITS) as (keyof typeof DEFAULT_TEST_LIMITS)[])(
    "rejects a non-finite %s cap",
    (name) => {
      expect(() =>
        validateIntakeLimits({ ...DEFAULT_TEST_LIMITS, [name]: Number.POSITIVE_INFINITY }),
      ).toThrow(name);
    },
  );

  it("reserves at least one submission slot in every bounded shared-pool configuration", () => {
    expect(
      validateIntakeLimits({
        ...DEFAULT_TEST_LIMITS,
        concurrency: 255,
        receiptConcurrency: 1,
      }),
    ).toMatchObject({ concurrency: 255, receiptConcurrency: 1 });
    expect(() =>
      validateIntakeLimits({
        ...DEFAULT_TEST_LIMITS,
        concurrency: 255,
        receiptConcurrency: 2,
      }),
    ).toThrow("pool capacity");
    expect(() =>
      validateIntakeLimits({
        ...DEFAULT_TEST_LIMITS,
        concurrency: 1,
        receiptConcurrency: 256,
      }),
    ).toThrow("receiptConcurrency");
  });
});
