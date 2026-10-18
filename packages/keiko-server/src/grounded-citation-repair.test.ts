import { describe, expect, it } from "vitest";
import {
  buildCitationRepairPrompt,
  citationRepairContent,
  validateCitationRepair,
} from "./grounded-citation-repair.js";
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

function annotationResponse(
  after = "Feature returns true.",
  marker = "[src/Feature.ts:3]",
): string {
  return JSON.stringify({ insertions: [{ after, marker }] });
}

describe.each(["literal", "annotation"] as const)("%s citation token boundaries", (protocol) => {
  it.each([
    ["Don't persist secrets.", "Don"],
    ["Don't persist secrets.", "Don'"],
    ["Don’t persist secrets.", "Don"],
    ["Don’t persist secrets.", "Don’"],
    ["The threshold is >=10.", "The threshold is >"],
    ["The threshold is <=10.", "The threshold is <"],
    ["The condition is value!=null.", "The condition is value!"],
    ["The condition is value===null.", "The condition is value=="],
    ["The condition is ready&&valid.", "The condition is ready&"],
    ["The fallback is value??defaultValue.", "The fallback is value?"],
    ["The expression is value?.name.", "The expression is value?"],
    ["The callback is value=>value.", "The callback is value="],
  ])("refuses splitting a contraction or operator in %s", (original, after) => {
    const offset = original.indexOf(after) + after.length;
    const response =
      protocol === "annotation"
        ? annotationResponse(after)
        : original.slice(0, offset) + " [src/Feature.ts:3]" + original.slice(offset);
    expect(citationRepairContent(original, response, index)).toBeUndefined();
  });

  it.each([
    "Don't persist secrets.",
    "Don’t persist secrets.",
    "The threshold is >=10.",
    "The condition is value!=null.",
    "The customers' data stays local.",
  ])("retains citation placement after the complete claim %s", (original) => {
    const expected = original + " [src/Feature.ts:3]";
    const response = protocol === "annotation" ? annotationResponse(original) : expected;
    expect(citationRepairContent(original, response, index)).toBe(expected);
  });
});

describe("locally constructed citation annotations", () => {
  it.each([false, true])("accepts a supported unique prose annotation (fenced=%s)", (fenced) => {
    const response = annotationResponse();
    expect(
      citationRepairContent(
        "Feature returns true.\n\n```ts\nreturn true;\n```",
        fenced ? `\`\`\`json\n${response}\n\`\`\`` : response,
        index,
      ),
    ).toBe("Feature returns true. [src/Feature.ts:3]\n\n```ts\nreturn true;\n```");
  });

  it("preserves literal marker-only responses for existing providers", () => {
    expect(
      citationRepairContent(
        "Feature returns true.",
        "Feature returns true [src/Feature.ts:3].",
        index,
      ),
    ).toBe("Feature returns true [src/Feature.ts:3].");
  });

  it("applies multiple original-coordinate annotations without offset drift", () => {
    const response = JSON.stringify({
      insertions: [
        { after: "First claim.", marker: "[src/Feature.ts:3]" },
        { after: "Second claim.", marker: "[src/Feature.ts:4-5]" },
      ],
    });
    expect(citationRepairContent("First claim. Second claim.", response, index)).toBe(
      "First claim. [src/Feature.ts:3] Second claim. [src/Feature.ts:4-5]",
    );
  });

  it.each([
    ["Feature returns true.", annotationResponse("Feature returns false.")],
    ["Feature returns true. Feature returns true.", annotationResponse()],
    ["Feature returns true.", annotationResponse("Feature returns true.", "[src/Feature.ts:9]")],
    ["Feature returns true.", annotationResponse("Feature returns true.", "[other/private.ts:3]")],
    ["`Feature returns true.`", annotationResponse()],
    ["```ts\nFeature returns true.\n```", annotationResponse()],
    ["Missing evidence: Feature returns true.", annotationResponse()],
    ["<assessment>Feature returns true.</assessment>", annotationResponse()],
    ["The limit is 10.25.", annotationResponse("The limit is 10", "[src/Feature.ts:3]")],
    [
      "Feature returns true.",
      annotationResponse("Feature returns true.", "changed [src/Feature.ts:3]"),
    ],
    ["Feature returns true.", "not JSON"],
    ["Feature returns true.", '{"insertions":[]}'],
    ["Feature returns true.", '{"insertions":{},"content":"replacement"}'],
    ["Feature returns true.", '{"insertions":[{"after":"","marker":"[src/Feature.ts:3]"}]}'],
    ["Feature returns true.", '{"insertions":[{"after":1,"marker":"[src/Feature.ts:3]"}]}'],
    ["Feature returns true.", '{"insertions":[null]}'],
    ["Feature returns true.", JSON.stringify({ insertions: [null], content: "replacement" })],
    [
      "Feature returns true.",
      JSON.stringify({
        insertions: [
          { after: "Feature returns true.", marker: "[src/Feature.ts:3]", content: "replacement" },
        ],
      }),
    ],
    ["Feature returns true.", annotationResponse("Feature returns true.", "")],
    ["x".repeat(513), annotationResponse("x".repeat(513))],
  ])(
    "refuses ambiguous, changed, unauthorized or ineligible annotation of %s",
    (original, response) => {
      expect(citationRepairContent(original, response, index)).toBeUndefined();
    },
  );

  it("rejects duplicate insertion coordinates and preserves the 32-marker bound", () => {
    const entries = Array.from({ length: 33 }, (_, i) => ({
      after: `Fact ${String(i)}.`,
      marker: "[src/Feature.ts:3]",
    }));
    const original = entries.map((entry) => entry.after).join("\n");
    expect(
      citationRepairContent(original, JSON.stringify({ insertions: entries }), index),
    ).toBeUndefined();
    expect(
      citationRepairContent(original, JSON.stringify({ insertions: entries.slice(0, 32) }), index),
    ).toBeDefined();
    expect(
      citationRepairContent(
        "Fact 0.",
        JSON.stringify({ insertions: [entries[0], entries[0]] }),
        index,
      ),
    ).toBeUndefined();
  });

  it("retains raw-response and constructed-answer size limits before trimming or insertion", () => {
    expect(
      citationRepairContent(
        "Feature returns true.",
        " ".repeat(131_072) + annotationResponse(),
        index,
      ),
    ).toBeUndefined();
    expect(
      citationRepairContent("x".repeat(131_073), annotationResponse("x"), index),
    ).toBeUndefined();
    const original = "x".repeat(131_051) + "Feature returns true.";
    expect(citationRepairContent(original, annotationResponse(), index)).toBeUndefined();
  });

  it("authorizes numeric annotations only against actually sent numeric markers", () => {
    const response = annotationResponse("Feature returns true.", "[2]");
    expect(citationRepairContent("Feature returns true.", response, index, new Set([2]))).toBe(
      "Feature returns true. [2]",
    );
    expect(
      citationRepairContent("Feature returns true.", response, index, new Set([1])),
    ).toBeUndefined();
    expect(citationRepairContent("Feature returns true.", response, index)).toBeUndefined();
  });
});

describe("bounded marker-only citation repair", () => {
  it.each([false, true])("retains the repaired UTF-16 size boundary (astral=%s)", (astral) => {
    const marker = " [src/Feature.ts:3]";
    const padding = astral ? "𐐀".repeat(65_500) : "x".repeat(131_000);
    const original = padding + "x".repeat(131_072 - marker.length - padding.length);
    const repaired = original + marker;
    expect(repaired).toHaveLength(131_072);
    expect(validateCitationRepair(original, repaired, index)).toBe(true);
    expect(validateCitationRepair(original + "x", original + "x" + marker, index)).toBe(false);
    expect(validateCitationRepair(repaired + "x", repaired + "x" + marker, index)).toBe(false);
  });

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

it.each([
  ["𝒜uthorizedValue is preserved.", "𝒜"],
  ["Q𝒜Value is preserved.", "Q"],
  ["𝒜Value is preserved.", "\ud835"],
  ["The 😀 icon is preserved.", "The \ud83d"],
])("rejects annotation splitting a Unicode token or scalar: %s", (original, after) => {
  expect(citationRepairContent(original, annotationResponse(after), index)).toBeUndefined();
});

it.each(["𝒜uthorizedValue", "😀"])(
  "preserves complete Unicode text at a prose boundary: %s",
  (value) => {
    const original = `${value} is preserved.`;
    expect(citationRepairContent(original, annotationResponse(original), index)).toBe(
      original + " [src/Feature.ts:3]",
    );
  },
);

it.each([
  ["𝒜uthorizedValue is preserved.", "𝒜"],
  ["Q𝒜Value is preserved.", "Q"],
  ["𝒜Value is preserved.", "\ud835"],
  ["The 😀 icon is preserved.", "The \ud83d"],
])("legacy marker-only repair rejects the same Unicode split: %s", (original, after) => {
  const offset = original.indexOf(after) + after.length;
  const candidate = original.slice(0, offset) + " [src/Feature.ts:3]" + original.slice(offset);
  expect(validateCitationRepair(original, candidate, index)).toBe(false);
});

it.each([
  ["The 👩🏽‍💻 icon is preserved.", "The 👩"],
  ["The 👩🏽‍💻 icon is preserved.", "The 👩🏽‍"],
  ["The 🇩🇪 flag is preserved.", "The 🇩"],
  ["The e\u0301 mark is preserved.", "The e"],
])("rejects both protocols inside a complete grapheme in %s", (original, after) => {
  expect(citationRepairContent(original, annotationResponse(after), index)).toBeUndefined();
  const offset = after.length;
  const legacy = original.slice(0, offset) + " [src/Feature.ts:3]" + original.slice(offset);
  expect(validateCitationRepair(original, legacy, index)).toBe(false);
});
