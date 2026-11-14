import { describe, expect, it } from "vitest";
import type { CatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { schemaMismatchGuidance, toolSchemaCorrectionMessage } from "./toolSchemaCorrection.js";

const NONE = {
  missingRequired: [],
  invalidPaths: [],
  unexpectedPropertyCount: 0,
  droppedPathCount: 0,
};
function repair(
  shape: Partial<CatalogSchemaMismatch>,
): Parameters<typeof schemaMismatchGuidance>[0] {
  return { toolCallId: "call-1", offeredAlias: "jira_x", shape: { ...NONE, ...shape } };
}

describe("schema correction guidance", () => {
  it("keeps the managed-runtime rule that every declared property is required", () => {
    expect(
      schemaMismatchGuidance(repair({ missingRequired: ["caseSensitive", "includeGlobs"] })),
    ).toBe(
      " Missing required properties: caseSensitive, includeGlobs. Every property the schema declares is required; pass an explicit value such as false or [] when a property does not apply.",
    );
  });

  // #4357: an external JSON Schema declares optional properties. Telling a model that every
  // property is required and to pass `false` made it send `expectAbsent: false`, which a guarded
  // Jira write refuses.
  it("never claims every property is required for an external schema", () => {
    const text = schemaMismatchGuidance(
      repair({ missingRequired: ["issueIdOrKey"], optionalProperties: true }),
    );
    expect(text).toBe(" Missing required properties: issueIdOrKey.");
  });

  it("states the exclusive choice instead of one alternative as missing", () => {
    const text = schemaMismatchGuidance(
      repair({
        missingRequired: ["expectedValueNodes"],
        optionalProperties: true,
        choice: { kind: "exactly-one", alternatives: [["expectedValueNodes"], ["expectAbsent"]] },
      }),
    );
    expect(text).toBe(" Supply exactly one of: expectedValueNodes, expectAbsent; omit the others.");
    const either = schemaMismatchGuidance(
      repair({
        optionalProperties: true,
        choice: { kind: "at-least-one", alternatives: [["a", "b"], ["c"]] },
      }),
    );
    expect(either).toBe(" Supply at least one of: a and b, c.");
  });

  it("names the declared properties beside the count of undeclared ones", () => {
    const text = schemaMismatchGuidance(
      repair({
        unexpectedPropertyCount: 2,
        optionalProperties: true,
        declaredProperties: ["issueIdOrKey", "startAt", "maxResults"],
      }),
    );
    expect(text).toBe(
      " 2 properties are not declared by the schema and must be removed; it declares only: issueIdOrKey, startAt, maxResults.",
    );
    expect(schemaMismatchGuidance(repair({ unexpectedPropertyCount: 1 }))).toBe(
      " 1 property is not declared by the schema and must be removed.",
    );
  });

  it("states the values a constant or enumerated property accepts", () => {
    const text = schemaMismatchGuidance(
      repair({
        invalidPaths: ["expectAbsent"],
        optionalProperties: true,
        allowed: { path: "expectAbsent", values: [true] },
      }),
    );
    expect(text).toBe(
      " Properties whose value does not match the schema: expectAbsent. The value of expectAbsent must be one of: true.",
    );
    expect(toolSchemaCorrectionMessage(repair({ invalidPaths: ["x"] }))).toContain(
      "Retry tool call call-1 for offered tool jira_x",
    );
  });
});

describe("the rule of each rejected property", () => {
  it("states each property's rule in one sentence of one form, from the schema only", () => {
    expect(
      schemaMismatchGuidance(
        repair({
          optionalProperties: true,
          invalidPaths: ["value.iconUrl"],
          expected: [
            { path: "value.iconTitle", rule: "a string, 1 to 255 characters or null" },
            { path: "value.iconUrl", rule: "a string, 1 to 2048 characters or null" },
          ],
        }),
      ),
    ).toBe(
      " Properties whose value does not match the schema: value.iconUrl. Expected: value.iconTitle must be a string, 1 to 255 characters or null; value.iconUrl must be a string, 1 to 2048 characters or null.",
    );
  });
  it("does not repeat the allowed values the sentence above already names", () => {
    const text = schemaMismatchGuidance(
      repair({
        optionalProperties: true,
        invalidPaths: ["mode"],
        allowed: { path: "mode", values: ["a", "b"] },
        expected: [
          { path: "limit", rule: "an integer, 1 to 5 as its value" },
          { path: "mode", rule: 'one of "a", "b"' },
        ],
      }),
    );
    expect(text).toContain('The value of mode must be one of: "a", "b".');
    expect(text).toContain(" Expected: limit must be an integer, 1 to 5 as its value.");
    expect(text).not.toContain('mode must be one of "a", "b";');
  });
  it("stays inside one bounded sentence however many properties the schema explains", () => {
    const expected = Array.from({ length: 8 }, (_, index) => ({
      path: `property${String(index)}`,
      rule: "x".repeat(160),
    }));
    const text = schemaMismatchGuidance(repair({ optionalProperties: true, expected }));
    expect(text.length).toBeLessThanOrEqual(1280 + 64);
    expect(text.startsWith(" Expected: property0 must be ")).toBe(true);
  });
  it("adds nothing for a schema with nothing to state", () => {
    expect(
      schemaMismatchGuidance(repair({ optionalProperties: true, invalidPaths: ["x"] })),
    ).not.toContain("Expected:");
  });
});
