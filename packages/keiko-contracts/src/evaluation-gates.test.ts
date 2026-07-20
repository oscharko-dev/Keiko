import { describe, expect, it } from "vitest";
import type { EvalBudget, EvalFloorResult, RegressionProbeResult } from "./evaluation-gates.js";

describe("evaluation-gate contract shapes", () => {
  it("carry metric-specific floors and fail-closed regression accounting", () => {
    const budget: EvalBudget<"precision" | "recall"> = { precision: 1, recall: 0.9 };
    const floorResult: EvalFloorResult<"precision" | "recall"> = {
      ok: false,
      failures: ["recall"],
    };
    const probe: RegressionProbeResult = {
      ok: false,
      tautological: [],
      probed: 1,
      unresolved: ["missing"],
    };

    expect(budget).toEqual({ precision: 1, recall: 0.9 });
    expect(floorResult).toEqual({ ok: false, failures: ["recall"] });
    expect(probe.ok).toBe(false);
  });
});
