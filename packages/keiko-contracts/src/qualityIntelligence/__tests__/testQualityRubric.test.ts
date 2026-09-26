import { describe, expect, it } from "vitest";
import {
  TEST_QUALITY_JUDGE_RESPONSE_SCHEMA,
  TEST_QUALITY_RUBRIC_DIMENSIONS,
} from "../testQualityRubric.js";
import type { TestQualityDimensionName } from "../testQualityRubric.js";

// Behavioural contract for TEST_QUALITY_JUDGE_RESPONSE_SCHEMA (same bug class as
// command-runner.ts's COMMAND_TASK_RULES, KEIKO-0139):
//
// KEIKO-0745 pins the schema's `name` enum to stay in lockstep — in both directions, not just
// "the enum is a subset" — with TEST_QUALITY_RUBRIC_DIMENSIONS, the array the rest of the system
// (e.g. keiko-server's judgePort.parseDimensions) actually iterates over, plus the handful of
// other shape invariants a model provider's Structured Outputs mode is told to honour.
// KEIKO-0760 deep-freezes the schema so every nested object and array — not only the outer
// literal — is immutable at runtime; a caller mutating a nested field in place (e.g. flipping
// `additionalProperties: false` to `true`, or splicing the enum) would otherwise silently weaken
// the constraint for every subsequent judge call in the process.
//
// This schema is a HINT to the provider, not the enforcement point (see the module header in
// ../testQualityRubric.ts) — the bounds are enforced where the model's output is consumed. This
// suite only pins the schema's own shape and immutability, never the model's runtime behaviour.

interface TestQualityJudgeResponseSchemaShape {
  readonly type: string;
  readonly additionalProperties: boolean;
  readonly required: readonly string[];
  readonly properties: {
    readonly dimensions: {
      readonly type: string;
      readonly items: {
        readonly type: string;
        readonly additionalProperties: boolean;
        readonly required: readonly string[];
        readonly properties: {
          readonly name: {
            readonly type: string;
            readonly enum: readonly TestQualityDimensionName[];
          };
          readonly score: { readonly type: string };
          readonly rationale: { readonly type: string };
        };
      };
    };
    readonly overallRationale: { readonly type: string };
  };
}

const schema = TEST_QUALITY_JUDGE_RESPONSE_SCHEMA as unknown as TestQualityJudgeResponseSchemaShape;
const dimensionItemProperties = schema.properties.dimensions.items.properties;

describe("TEST_QUALITY_JUDGE_RESPONSE_SCHEMA", () => {
  it("declares exactly the live TEST_QUALITY_RUBRIC_DIMENSIONS set in its name enum, both directions", () => {
    // Spread the real export — never restate the dimension list — so this test tracks the source
    // of truth instead of a second copy of it.
    const dimensionNames: readonly TestQualityDimensionName[] = [...TEST_QUALITY_RUBRIC_DIMENSIONS];
    const enumNames = dimensionItemProperties.name.enum;

    // Length parity first: a subset/superset in either direction must fail here rather than being
    // masked by an order-insensitive per-element check below.
    expect(enumNames).toHaveLength(dimensionNames.length);

    // Direction 1: every declared rubric dimension appears in the schema's enum.
    for (const dimension of dimensionNames) {
      expect(enumNames).toContain(dimension);
    }
    // Direction 2: every enum value is a declared rubric dimension — no stray or stale entry.
    for (const enumName of enumNames) {
      expect(dimensionNames).toContain(enumName);
    }
    // Full structural (order-sensitive) equality: the schema is built by spreading the live
    // export, so this pins the stronger property the two arrays are expected to hold.
    expect(enumNames).toEqual(dimensionNames);
  });

  it("requires the dimensions field", () => {
    expect(schema.required).toContain("dimensions");
  });

  it("forbids additional properties on both the outer object and each dimension item", () => {
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.dimensions.items.additionalProperties).toBe(false);
  });

  it("types each dimension's score as an integer", () => {
    expect(dimensionItemProperties.score.type).toBe("integer");
  });

  it("deep-freezes every nested level, including the per-dimension score object and the enum array (KEIKO-0760)", () => {
    expect(Object.isFrozen(TEST_QUALITY_JUDGE_RESPONSE_SCHEMA)).toBe(true);
    expect(Object.isFrozen(TEST_QUALITY_JUDGE_RESPONSE_SCHEMA.properties)).toBe(true);
    expect(
      Object.isFrozen(
        (
          TEST_QUALITY_JUDGE_RESPONSE_SCHEMA.properties as {
            dimensions: { items: { properties: { score: unknown } } };
          }
        ).dimensions.items.properties.score,
      ),
    ).toBe(true);
    expect(Object.isFrozen(dimensionItemProperties.name.enum)).toBe(true);
  });
});
