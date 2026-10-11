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

function citationIndexForPath(scopePath: string): PackCitationIndex {
  return {
    scopePaths: new Set([scopePath]),
    sourceIdsByPath: new Map([[scopePath, new Set(["1"])]]),
    lineWindowsBySourceId: new Map([["1", new Map([[scopePath, [{ startLine: 1, endLine: 1 }]]])]]),
  };
}

describe("bounded marker-only citation repair", () => {
  it("never inserts a source citation inside the preserved own-assessment block", () => {
    const original = "Feature returns true.\n\n<assessment>General advice.</assessment>";
    expect(
      validateCitationRepair(
        original,
        "Feature returns true [src/Feature.ts:3].\n\n<assessment>General advice [src/Feature.ts:3].</assessment>",
        index,
      ),
    ).toBe(false);
    expect(
      validateCitationRepair(
        original,
        "Feature returns true [src/Feature.ts:3].\n\n<assessment>General advice.</assessment>",
        index,
      ),
    ).toBe(true);
  });
  it.each([
    ["Feature returns true.", "Feature returns true [src/Feature.ts:3]."],
    ["Feature returns true.\n", "Feature returns true. [src/Feature.ts:3]\n"],
    ["Feature [optional] returns true.", "Feature [optional] returns true [src/Feature.ts:3-5]."],
    ["Feature returns true.", "Feature [src/Feature.ts:3] returns true."],
  ])("accepts only supported insertion into %s", (original, repaired) => {
    expect(validateCitationRepair(original, repaired, index)).toBe(true);
  });

  it.each(["app/users/[id]/page.tsx", "app/users/42/page.tsx"])(
    "accepts supported marker-only insertion for route %s",
    (scopePath) => {
      const routeIndex = citationIndexForPath(scopePath);
      expect(
        validateCitationRepair(
          "The page renders users.",
          `The page renders users [${scopePath}:1].`,
          routeIndex,
        ),
      ).toBe(true);
      for (const repaired of [
        `The page renders admins [${scopePath}:1].`,
        `The page renders users [${scopePath}:2].`,
        `The page renders users [${scopePath}:1](https://example.test).`,
        `\`The page renders users [${scopePath}:1].\``,
      ]) {
        expect(validateCitationRepair("The page renders users.", repaired, routeIndex)).toBe(false);
      }
    },
  );

  it("preserves the original Unicode-codepoint marker bound for portable paths", () => {
    const unicodePath = Array<string>(5).fill("𐐀".repeat(60)).join("/") + ".ts";
    const boundaryPath = [168, 168, 169].map((count) => "a".repeat(count)).join("/") + ".ts";
    const oversizedPath = [168, 168, 170].map((count) => "a".repeat(count)).join("/") + ".ts";
    for (const scopePath of [unicodePath, boundaryPath]) {
      expect(
        validateCitationRepair(
          "The page renders users.",
          `The page renders users [${scopePath}:1].`,
          citationIndexForPath(scopePath),
        ),
      ).toBe(true);
    }
    expect(
      validateCitationRepair(
        "The page renders users.",
        `The page renders users [${oversizedPath}:1].`,
        citationIndexForPath(oversizedPath),
      ),
    ).toBe(false);
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
