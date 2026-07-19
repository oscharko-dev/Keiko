import { describe, expect, it } from "vitest";

import { runGroundedEntailmentGate } from "../check-grounded-entailment.mjs";

describe("check-grounded-entailment gate wrapper", () => {
  it("passes on the real eval and logs the scorecard + floors without failing", async () => {
    const logs = [];
    let failed = false;
    const result = await runGroundedEntailmentGate({
      log: (line) => logs.push(line),
      fail: () => {
        failed = true;
      },
    });

    expect(result).toEqual({ ok: true, failures: [] });
    expect(failed).toBe(false);
    expect(logs.some((line) => line.includes("grounded-entailment: fixtures="))).toBe(true);
    expect(logs.some((line) => line.includes("non-tautology=proven"))).toBe(true);
    expect(logs.some((line) => line.includes("grounded-entailment floors:"))).toBe(true);
    expect(logs.some((line) => line.includes("grounded-entailment: PASS"))).toBe(true);
  });
});
