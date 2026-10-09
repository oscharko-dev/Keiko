import { describe, expect, it } from "vitest";
import { buildCitationRepairPrompt, validateCitationRepair } from "./grounded-citation-repair.js";
import type { PackCitationIndex } from "./grounded-faithfulness.js";

const index: PackCitationIndex = {
  scopePaths: new Set(["src/Feature.ts"]),
  sourceIdsByPath: new Map([["src/Feature.ts", new Set(["1"])]]),
  lineWindowsBySourceId: new Map([
    ["1", new Map([["src/Feature.ts", [{ startLine: 3, endLine: 5 }]]])],
  ]),
};

describe("bounded marker-only citation repair", () => {
  it.each([
    ["Feature returns true.", "Feature returns true [src/Feature.ts:3]."],
    ["Feature returns true.\n", "Feature returns true. [src/Feature.ts:3]\n"],
    ["Feature [optional] returns true.", "Feature [optional] returns true [src/Feature.ts:3-5]."],
    ["Feature returns true.", "Feature [src/Feature.ts:3] returns true."],
  ])("accepts only supported insertion into %s", (original, repaired) => {
    expect(validateCitationRepair(original, repaired, index)).toBe(true);
  });

  it.each([
    ["Feature returns true.", "Feature returns false [src/Feature.ts:3]."],
    ["Feature [optional] returns true.", "Feature returns true [src/Feature.ts:3]."],
    ["Feature returns true.", "Feature returns true [src/Feature.ts:9]."],
    ["Feature returns true.", "Feature returns true [outside/private.ts:3]."],
    ["Feature returns true.", "Feature returns true [src/Feature.ts:3, outside/private.ts:3]."],
    ["Feature returns true.", "Feature returns true."],
    ["`Feature returns true.`", "`Feature returns true [src/Feature.ts:3].`"],
    ["Feature returns true.", "Feature returns true [src/Feature.ts:3](https://example.test)."],
    ["Feature returns true.", "Feature returns true.\nMissing evidence: [src/Feature.ts:3]"],
    ["Feature\nreturns true.", "Feature returns true [src/Feature.ts:3]."],
    ["```ts\nreturn true;\n```", "```ts\nreturn true; [src/Feature.ts:3]\n```"],
  ])("rejects changed or unsupported repair of %s", (original, repaired) => {
    expect(validateCitationRepair(original, repaired, index)).toBe(false);
  });

  it("accepts only inserted numeric markers authorized by the final fitted hybrid prompt", () => {
    const available = new Set([2, 4]);
    expect(
      validateCitationRepair("Feature is true.", "Feature is true [2, 4].", index, available),
    ).toBe(true);
    expect(
      validateCitationRepair("Feature is true.", "Feature is true [1].", index, available),
    ).toBe(false);
    expect(
      validateCitationRepair("Feature is true.", "Feature is false [2].", index, available),
    ).toBe(false);
    expect(
      validateCitationRepair(
        "Feature [optional] is true.",
        "Feature is true [2].",
        index,
        available,
      ),
    ).toBe(false);
    expect(validateCitationRepair("Feature is true.", "Feature is true [2].", index)).toBe(false);
    expect(buildCitationRepairPrompt("Feature is true.", "numeric")).toContain("[n]");
  });
  it.each([
    ["The threshold is 1000.", "The threshold is 10 [src/Feature.ts:3] 00."],
    ["The threshold is 1000.", "The threshold is 10 [2] 00."],
    ["FeatureName is true.", "Feature [src/Feature.ts:3] Name is true."],
    ["The threshold is 10.25.", "The threshold is 10 [src/Feature.ts:3] .25."],
  ])("rejects a marker that splits a substantive token in %s", (original, repaired) => {
    expect(validateCitationRepair(original, repaired, index, new Set([2]))).toBe(false);
  });
  it("requests marker insertion without granting tools or substantive rewriting", () => {
    const prompt = buildCitationRepairPrompt("Feature returns true.");
    expect(prompt).toContain("Feature returns true.");
    expect(prompt).toContain("only insert");
    expect(prompt).toContain("[path:line-range]");
  });
});
