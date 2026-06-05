import { describe, expect, it } from "vitest";
import {
  createBudget,
  isExhausted,
  releaseBudget,
  remainingBudget,
  reserveBudget,
} from "../budget.js";

describe("Quality Intelligence budget", () => {
  it("createBudget clamps non-positive totals to zero and returns a frozen state", () => {
    expect(createBudget(-5).totalBudget).toBe(0);
    expect(createBudget(Number.NaN).totalBudget).toBe(0);
    expect(Object.isFrozen(createBudget(10))).toBe(true);
  });

  it("reserveBudget returns a new state and never mutates the input", () => {
    const initial = createBudget(100);
    const next = reserveBudget(initial, 25);
    expect(initial.consumed).toBe(0);
    expect(next.consumed).toBe(25);
    expect(next).not.toBe(initial);
    expect(Object.isFrozen(next)).toBe(true);
  });

  it("releaseBudget refunds without going below zero and never mutates input", () => {
    const after = reserveBudget(createBudget(50), 30);
    const refunded = releaseBudget(after, 100);
    expect(refunded.consumed).toBe(0);
    expect(after.consumed).toBe(30);
  });

  it("clamps negative/NaN cost and refund to zero", () => {
    const initial = createBudget(10);
    expect(reserveBudget(initial, -5).consumed).toBe(0);
    expect(reserveBudget(initial, Number.NaN).consumed).toBe(0);
    expect(releaseBudget(initial, -5).consumed).toBe(0);
  });

  it("detects exhaustion at and after the total budget", () => {
    const initial = createBudget(10);
    expect(isExhausted(initial)).toBe(false);
    expect(isExhausted(reserveBudget(initial, 9))).toBe(false);
    expect(isExhausted(reserveBudget(initial, 10))).toBe(true);
    expect(isExhausted(reserveBudget(initial, 100))).toBe(true);
  });

  it("remainingBudget reports the non-negative remainder", () => {
    const initial = createBudget(10);
    expect(remainingBudget(initial)).toBe(10);
    expect(remainingBudget(reserveBudget(initial, 7))).toBe(3);
    expect(remainingBudget(reserveBudget(initial, 100))).toBe(0);
  });
});
