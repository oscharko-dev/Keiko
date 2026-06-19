import { describe, expect, it } from "vitest";

import {
  createEditorModelTokenBudget,
  DEFAULT_EDITOR_MODEL_TOKEN_BUDGET,
  estimateEditorModelReservationTokens,
} from "./editorModelTokenBudget.js";

describe("createEditorModelTokenBudget", () => {
  it("is not exhausted for a root with no recorded usage", () => {
    const budget = createEditorModelTokenBudget();
    expect(budget.isExhausted("/repo", 1_000)).toBe(false);
  });

  it("becomes exhausted once the window token sum meets the ceiling", () => {
    const budget = createEditorModelTokenBudget({ maxTokensPerWindow: 100, windowMs: 10_000 });
    budget.record("/repo", 0, 60);
    expect(budget.isExhausted("/repo", 10)).toBe(false);
    budget.record("/repo", 10, 40);
    // 60 + 40 = 100, meeting the ceiling (inclusive).
    expect(budget.isExhausted("/repo", 20)).toBe(true);
  });

  it("recovers as old token entries age out of the sliding window", () => {
    const budget = createEditorModelTokenBudget({ maxTokensPerWindow: 100, windowMs: 1_000 });
    budget.record("/repo", 0, 100);
    expect(budget.isExhausted("/repo", 20)).toBe(true);
    // Past the window the entry has aged out and the budget recovers.
    expect(budget.isExhausted("/repo", 1_100)).toBe(false);
  });

  it("counts an entry at the exact window boundary against the ceiling (inclusive left bound)", () => {
    const budget = createEditorModelTokenBudget({ maxTokensPerWindow: 50, windowMs: 1_000 });
    budget.record("/repo", 0, 50);
    // At t=1000 the t=0 entry is aged EXACTLY windowMs; it must still count.
    expect(budget.isExhausted("/repo", 1_000)).toBe(true);
    // Just past the window the entry ages out.
    expect(budget.isExhausted("/repo", 1_001)).toBe(false);
  });

  it("scopes the token ceiling per root independently", () => {
    const budget = createEditorModelTokenBudget({ maxTokensPerWindow: 50, windowMs: 10_000 });
    budget.record("/repo-a", 0, 50);
    expect(budget.isExhausted("/repo-a", 10)).toBe(true);
    expect(budget.isExhausted("/repo-b", 10)).toBe(false);
  });

  it("ignores non-positive token records (never blocks on zero-cost calls)", () => {
    const budget = createEditorModelTokenBudget({ maxTokensPerWindow: 10, windowMs: 10_000 });
    budget.record("/repo", 0, 0);
    budget.record("/repo", 1, -5);
    expect(budget.isExhausted("/repo", 10)).toBe(false);
  });

  it("counts pending reservations immediately against the ceiling", () => {
    const budget = createEditorModelTokenBudget({ maxTokensPerWindow: 100, windowMs: 10_000 });
    const reservation = budget.tryReserve("/repo", 0, 60);
    expect(reservation).toBeDefined();
    expect(budget.tryReserve("/repo", 1, 50)).toBeUndefined();
  });

  it("settles a reservation to actual usage when metadata is available", () => {
    const budget = createEditorModelTokenBudget({ maxTokensPerWindow: 100, windowMs: 10_000 });
    const reservation = budget.tryReserve("/repo", 0, 80);
    expect(reservation).toBeDefined();
    reservation?.settle({
      requestId: "req-1",
      promptTokens: 20,
      completionTokens: 10,
      latencyMs: 1,
      costClass: "low",
    });
    expect(budget.tryReserve("/repo", 1, 70)).toBeDefined();
  });

  it("keeps the conservative reservation when usage metadata is absent", () => {
    const budget = createEditorModelTokenBudget({ maxTokensPerWindow: 100, windowMs: 10_000 });
    const reservation = budget.tryReserve("/repo", 0, 80);
    expect(reservation).toBeDefined();
    reservation?.settle(undefined);
    expect(budget.tryReserve("/repo", 1, 30)).toBeUndefined();
  });

  it("can cancel a reservation before the provider is invoked", () => {
    const budget = createEditorModelTokenBudget({ maxTokensPerWindow: 100, windowMs: 10_000 });
    const reservation = budget.tryReserve("/repo", 0, 80);
    expect(reservation).toBeDefined();
    reservation?.cancel();
    expect(budget.tryReserve("/repo", 1, 100)).toBeDefined();
  });

  it("estimates prompt and output tokens without storing prompt text", () => {
    expect(
      estimateEditorModelReservationTokens({ system: "abcd", user: "abcdefgh" }, 10),
    ).toBe(13);
  });

  it("ships a finite, generous default ceiling and window", () => {
    expect(DEFAULT_EDITOR_MODEL_TOKEN_BUDGET.maxTokensPerWindow).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_EDITOR_MODEL_TOKEN_BUDGET.maxTokensPerWindow)).toBe(true);
    expect(DEFAULT_EDITOR_MODEL_TOKEN_BUDGET.windowMs).toBeGreaterThan(0);
  });
});
