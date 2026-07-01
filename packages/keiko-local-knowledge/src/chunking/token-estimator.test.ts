import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_OVERLAP_TOKENS,
  CHUNKING_STRATEGY_VERSION,
} from "./types.js";
import { charsForTokenBudget, defaultTokenEstimator } from "./token-estimator.js";

describe("defaultTokenEstimator", () => {
  it("uses the WP4 chunking defaults and boundary strategy version", () => {
    expect(CHUNKING_STRATEGY_VERSION).toBe("boundary-v2");
    expect(DEFAULT_MAX_TOKENS).toBe(512);
    expect(DEFAULT_OVERLAP_TOKENS).toBe(50);
  });

  it("is more conservative than a 4-char heuristic for CJK and token-dense identifiers", () => {
    const cjk = "客户数据同步策略".repeat(40);
    const code = "BillingService.processPayment_v2(TS_999, customer_id, retry_count);".repeat(20);

    expect(defaultTokenEstimator(cjk)).toBeGreaterThan(Math.ceil(cjk.length / 4));
    expect(defaultTokenEstimator(code)).toBeGreaterThan(Math.ceil(code.length / 4));
  });

  it("keeps small English prose in the same order of magnitude", () => {
    const prose = "The quick brown fox jumps over the lazy dog.";
    expect(defaultTokenEstimator(prose)).toBeGreaterThan(0);
    expect(defaultTokenEstimator(prose)).toBeLessThan(20);
  });

  it("keeps charsForTokenBudget as an initial cap, not the authoritative token count", () => {
    const budgetChars = charsForTokenBudget(512);
    expect(budgetChars).toBe(2048);
    expect(defaultTokenEstimator("漢".repeat(budgetChars))).toBeGreaterThan(512);
  });
});
