import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  evaluateLatencyBudget,
  percentile,
  runRetrievalLatencyCheck,
} from "../check-retrieval-latency.mjs";

describe("percentile", () => {
  it("returns 0 for an empty sample set", () => {
    expect(percentile([], 95)).toBe(0);
  });

  it("computes the nearest-rank percentile (order-independent)", () => {
    const samples = [50, 10, 40, 20, 30];
    expect(percentile(samples, 100)).toBe(50);
    expect(percentile(samples, 95)).toBe(50);
    expect(percentile(samples, 50)).toBe(30);
    expect(percentile(samples, 1)).toBe(10);
  });

  it("clamps the rank into range", () => {
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([1, 2], 0)).toBe(1);
  });
});

describe("evaluateLatencyBudget", () => {
  it("passes when observed is at or under the budget", () => {
    expect(evaluateLatencyBudget({ observedMs: 600, budgetMs: 3000 })).toEqual({
      ok: true,
      observedMs: 600,
      budgetMs: 3000,
    });
    expect(evaluateLatencyBudget({ observedMs: 3000, budgetMs: 3000 }).ok).toBe(true);
  });

  it("fails when observed exceeds the budget", () => {
    expect(evaluateLatencyBudget({ observedMs: 3001, budgetMs: 3000 }).ok).toBe(false);
  });
});

describe("runRetrievalLatencyCheck", () => {
  it("measures real lexical search over the complete streaming fixture", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-lexical-latency-"));
    try {
      const budget = JSON.parse(
        readFileSync(new URL("../check-retrieval-latency.budget.json", import.meta.url), "utf8"),
      );
      const budgetPath = join(root, "budget.json");
      writeFileSync(budgetPath, JSON.stringify({ ...budget, warmupIterations: 0, iterations: 1 }));
      const logs = [];
      const failures = [];
      const result = await runRetrievalLatencyCheck({
        budgetPath,
        log: (message) => logs.push(message),
        fail: (message) => failures.push(message),
      });
      expect(result.observedMs).toBeGreaterThan(0);
      expect(result.budgetMs).toBe(budget.budgetMs);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain(`on a ${String(budget.fixtureFileCount)}-file fixture`);
      expect(failures).toHaveLength(result.ok ? 0 : 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
