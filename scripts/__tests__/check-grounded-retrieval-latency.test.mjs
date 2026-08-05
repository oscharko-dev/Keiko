import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assertMeasurableBudget,
  evaluateGroundedLatency,
  evaluateLatencyBudget,
  evaluateRegressionProbe,
  percentile,
  runGroundedRetrievalLatencyGate,
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

describe("assertMeasurableBudget", () => {
  // A zero `iterations` leaves `samples` empty, and `percentile([])` is 0 — which clears every
  // ceiling. The gate would report PASS having measured nothing, which is the same false-green class
  // the gate exists to catch. It must refuse the budget instead of measuring nothing quietly.
  it.each([
    ["iterations", 0],
    ["iterations", -1],
    ["iterations", 1.5],
    ["iterations", "12"],
    ["warmupIterations", -1],
    ["warmupIterations", undefined],
  ])("rejects a budget whose %s is %p", (field, value) => {
    expect(() => assertMeasurableBudget({ ...budget, [field]: value })).toThrow(TypeError);
  });

  // A non-numeric ceiling makes `observed > budget` false for ANY observation, switching that
  // percentile's check off while the gate still reports PASS — the same false green as measuring
  // nothing, arriving through a different field.
  it.each([
    ["p50BudgetMs", "disabled"],
    ["p50BudgetMs", 0],
    ["p50BudgetMs", -1],
    ["p50BudgetMs", Number.NaN],
    ["p50BudgetMs", Number.POSITIVE_INFINITY],
    ["p95BudgetMs", null],
    ["p95BudgetMs", 0],
  ])("rejects a budget whose %s is %p", (field, value) => {
    expect(() => assertMeasurableBudget({ ...budget, [field]: value })).toThrow(TypeError);
  });

  it("rejects a p95 ceiling tighter than the p50 ceiling", () => {
    expect(() => assertMeasurableBudget({ ...budget, p50BudgetMs: 800, p95BudgetMs: 400 })).toThrow(
      /p95BudgetMs/u,
    );
  });

  // Without a real delay the probe injects no regression, so the non-tautology proof would pass
  // having proven nothing.
  it.each([undefined, 0, -5, "200", Number.NaN])(
    "rejects a regression probe whose judgeDelayMs is %p",
    (judgeDelayMs) => {
      expect(() =>
        assertMeasurableBudget({ ...budget, regressionProbe: { judgeDelayMs } }),
      ).toThrow(/judgeDelayMs/u);
    },
  );

  it("rejects a budget with no regressionProbe at all", () => {
    const withoutProbe = { ...budget };
    delete withoutProbe.regressionProbe;
    expect(() => assertMeasurableBudget(withoutProbe)).toThrow(/judgeDelayMs/u);
  });

  it("accepts zero warmup iterations but requires at least one measured iteration", () => {
    expect(assertMeasurableBudget({ ...budget, warmupIterations: 0, iterations: 1 })).toBeTruthy();
  });

  it("accepts the committed budget", () => {
    expect(assertMeasurableBudget(budget)).toBe(budget);
  });
});

// The runner, driven end to end over the REAL pipeline with a one-iteration budget so the suite pays
// for two evaluations rather than fifteen. This is what covers collectSamples, the reporting, and
// the failure branch — the pure helpers above cannot reach any of it.
describe("runGroundedRetrievalLatencyGate", () => {
  // A named no-op: an empty arrow is a lint error, and the point is that these runs discard their
  // log output rather than that nothing happens.
  const discard = () => undefined;

  // `await assert(...)`, not `return assert(...)`: without the await the `finally` runs the moment
  // the promise is returned, deleting the budget file underneath the run. It happens to survive
  // today only because the gate reads the file synchronously before its first await — an ordering
  // accident, not a guarantee.
  async function withBudgetFile(overrides, assert) {
    const root = mkdtempSync(join(tmpdir(), "keiko-grounded-latency-"));
    try {
      const budgetPath = join(root, "budget.json");
      writeFileSync(budgetPath, JSON.stringify({ ...budget, ...overrides }));
      return await assert(budgetPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const FAST = { warmupIterations: 0, iterations: 1, regressionProbe: { judgeDelayMs: 200 } };

  it("measures the real pipeline, reports both percentiles, and proves the probe fires", async () => {
    await withBudgetFile(FAST, async (budgetPath) => {
      const logs = [];
      const failures = [];
      const result = await runGroundedRetrievalLatencyGate({
        budgetPath,
        log: (m) => logs.push(m),
        fail: (m) => failures.push(m),
      });

      expect(failures).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.p50).toBeGreaterThan(0);
      expect(result.probe.detected).toBe(true);
      expect(logs[0]).toContain("grounded-retrieval-latency: p50=");
      expect(logs[1]).toContain("regression probe:");
    });
  }, 180_000);

  it("fails when the measured percentiles breach an impossible budget", async () => {
    // Positive but unreachable: a zero ceiling is now rejected up front as unmeasurable, so the
    // breach has to be forced with a budget that is valid and still cannot be met.
    await withBudgetFile(
      { ...FAST, p50BudgetMs: 0.001, p95BudgetMs: 0.001 },
      async (budgetPath) => {
        const failures = [];
        const result = await runGroundedRetrievalLatencyGate({
          budgetPath,
          log: () => discard(),
          fail: (m) => failures.push(m),
        });

        expect(result.ok).toBe(false);
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain("p50");
        expect(failures[0]).toContain("p95");
      },
    );
  }, 180_000);

  // The self-proving half, exercised for real: with a budget wide enough to absorb the injected
  // delay, the probe must report the gate as tautological rather than passing quietly.
  it("fails closed when the budget is loose enough to absorb the injected regression", async () => {
    await withBudgetFile(
      { ...FAST, p50BudgetMs: 600_000, p95BudgetMs: 600_000 },
      async (budgetPath) => {
        const failures = [];
        const result = await runGroundedRetrievalLatencyGate({
          budgetPath,
          log: () => discard(),
          fail: (m) => failures.push(m),
        });

        expect(result.probe.detected).toBe(false);
        expect(failures.join(" ")).toContain("tautological gate");
      },
    );
  }, 180_000);
});

describe("committed budget document", () => {
  it("declares warmup, iterations and both percentile ceilings", () => {
    expect(budget.warmupIterations).toBeGreaterThan(0);
    expect(budget.iterations).toBeGreaterThan(0);
    expect(budget.p50BudgetMs).toBeGreaterThan(0);
    expect(budget.p95BudgetMs).toBeGreaterThanOrEqual(budget.p50BudgetMs);
  });

  // The probe's delay lands once per cited claim. If a future edit shrank either the delay or the
  // fixture's claim count to something the budget absorbs, the gate would keep reporting PASS while
  // proving nothing — so the claim count is read from the module that owns it, not written here.
  it("sets a probe delay whose per-claim fan-out clears the p95 ceiling with margin", async () => {
    const { FIXTURE_ANSWER_CLAIMS } = await import("@oscharko-dev/keiko-server");

    expect(budget.regressionProbe.judgeDelayMs * FIXTURE_ANSWER_CLAIMS).toBeGreaterThan(
      budget.p95BudgetMs * 1.5,
    );
  });
});
