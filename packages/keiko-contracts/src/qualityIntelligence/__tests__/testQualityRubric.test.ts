import { describe, expect, it } from "vitest";
import {
  TEST_QUALITY_JUDGE_RESPONSE_SCHEMA,
  TEST_QUALITY_RUBRIC_DIMENSIONS,
} from "../testQualityRubric.js";

// Codex-sweep finding (same bug class as command-runner.ts's COMMAND_TASK_RULES, KEIKO-0139):
// Object.freeze on TEST_QUALITY_JUDGE_RESPONSE_SCHEMA only froze the OUTER object — every nested
// object it contains (properties, dimensions.items, dimensions.items.properties, ...) was a plain,
// unfrozen object literal. This schema constrains what a model provider's Structured Outputs mode
// may emit (see the module comment); a caller mutating a nested field in place — e.g. flipping
// `additionalProperties: false` to `true`, or deleting a `required` entry — would silently weaken
// that constraint for every subsequent judge call in the process.
describe("TEST_QUALITY_JUDGE_RESPONSE_SCHEMA", () => {
  it("declares the four rubric dimensions in its enum", () => {
    const topLevelProperties = TEST_QUALITY_JUDGE_RESPONSE_SCHEMA.properties as Record<
      string,
      unknown
    >;
    const dimensionsField = topLevelProperties.dimensions as Record<string, unknown>;
    const items = dimensionsField.items as Record<string, unknown>;
    const itemProperties = items.properties as Record<string, unknown>;
    const nameField = itemProperties.name as Record<string, unknown>;
    expect(nameField.enum).toEqual(TEST_QUALITY_RUBRIC_DIMENSIONS);
  });

  it("freezes every nested level, not just the outer schema object", () => {
    expect(Object.isFrozen(TEST_QUALITY_JUDGE_RESPONSE_SCHEMA)).toBe(true);
    const properties = TEST_QUALITY_JUDGE_RESPONSE_SCHEMA.properties as Record<string, unknown>;
    expect(() => {
      (properties as { additionalProperties: unknown }).additionalProperties = true;
    }).toThrow(TypeError);
    const dimensionsField = properties.dimensions as Record<string, unknown>;
    const items = dimensionsField.items as { additionalProperties: unknown };
    expect(() => {
      items.additionalProperties = true;
    }).toThrow(TypeError);
  });
});
