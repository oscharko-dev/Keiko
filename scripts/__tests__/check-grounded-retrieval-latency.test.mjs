import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  evaluateGroundedLatency,
  evaluateLatencyBudget,
  evaluateRegressionProbe,
  percentile,
} from "../check-grounded-retrieval-latency.mjs";

// Audit KEIKO-0053. The gate itself measures the real grounded pipeline and takes tens of seconds;
// these tests own the pure decision logic — the part that decides whether a measurement passes —
// plus the non-tautology assertion the gate depends on.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const budget = JSON.parse(
  readFileSync(join(repoRoot, "scripts", "check-grounded-retrieval-latency.budget.json"), "utf8"),
);

describe("percentile", () => {
  it("uses nearest-rank and does not mutate the input", () => {
    const samples = [50, 10, 40, 20, 30];
    expect(percentile(samples, 50)).toBe(30);
    expect(percentile(samples, 95)).toBe(50);
    expect(percentile(samples, 0)).toBe(10);
    expect(samples).toEqual([50, 10, 40, 20, 30]);
  });

  it("returns 0 for an empty sample set rather than NaN", () => {
    expect(percentile([], 95)).toBe(0);
  });
});

describe("evaluateLatencyBudget", () => {
  it("treats the budget as an inclusive ceiling", () => {
    expect(evaluateLatencyBudget({ observedMs: 100, budgetMs: 100 }).ok).toBe(true);
    expect(evaluateLatencyBudget({ observedMs: 100.1, budgetMs: 100 }).ok).toBe(false);
  });
});

describe("evaluateGroundedLatency", () => {
  const budgets = { p50BudgetMs: 400, p95BudgetMs: 800 };

  it("passes when both percentiles are inside their ceilings", () => {
    const result = evaluateGroundedLatency({ samples: [30, 32, 35, 40], budget: budgets });

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  // A p95 ceiling generous enough to absorb machine variance would let a uniform slowdown through;
  // the p50 ceiling is what catches it. Both are checked, and both are reported.
  it("fails a uniform slowdown that leaves the p95 ceiling intact", () => {
    const result = evaluateGroundedLatency({
      samples: [500, 520, 540, 560],
      budget: budgets,
    });

    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toContain("p50");
  });

  it("fails a tail regression that leaves the median intact", () => {
    const result = evaluateGroundedLatency({
      samples: [30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 5000],
      budget: budgets,
    });

    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toContain("p95");
  });
});

// The self-proving half. The gate injects a per-judge-call delay into one extra sample; if that
// sample still fits inside the budget, the budget is loose enough to absorb a real regression and
// the gate is tautological — which must itself be a failure, not a silent pass.
describe("evaluateRegressionProbe", () => {
  it("reports detected when the injected regression breaches the p95 ceiling", () => {
    const probe = evaluateRegressionProbe({ regressedMs: 1641, budget });

    expect(probe.detected).toBe(true);
    expect(probe.failures).toEqual([]);
  });

  it("fails closed when an injected regression is absorbed by the budget", () => {
    const probe = evaluateRegressionProbe({ regressedMs: budget.p95BudgetMs, budget });

    expect(probe.detected).toBe(false);
    expect(probe.failures).toHaveLength(1);
    expect(probe.failures[0]).toContain("tautological gate");
  });
});

describe("committed budget document", () => {
  it("declares warmup, iterations and both percentile ceilings", () => {
    expect(budget.warmupIterations).toBeGreaterThan(0);
    expect(budget.iterations).toBeGreaterThan(0);
    expect(budget.p50BudgetMs).toBeGreaterThan(0);
    expect(budget.p95BudgetMs).toBeGreaterThanOrEqual(budget.p50BudgetMs);
  });

  // The probe's delay is multiplied by the fixture's 8 cited claims. If a future edit shrank it to
  // something the budget absorbs, the gate would keep reporting PASS while proving nothing.
  it("sets a probe delay whose 8-claim fan-out clears the p95 ceiling with margin", () => {
    expect(budget.regressionProbe.judgeDelayMs * 8).toBeGreaterThan(budget.p95BudgetMs * 1.5);
  });
});
