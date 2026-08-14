// KEIKO-0405 — the judge response schema is the enforcement point for a MODEL's structured output,
// so every bound the surrounding TypeScript types document has to be declared in the schema too.
// It previously declared none: a score of -5 or 10_000, a dimensions array repeating one dimension
// a thousand times, and a megabyte rationale all satisfied it, and those rationales are carried
// into evidence.

import { describe, expect, it } from "vitest";
import {
  TEST_QUALITY_JUDGE_RESPONSE_SCHEMA,
  TEST_QUALITY_RATIONALE_MAX_CHARS,
  TEST_QUALITY_RUBRIC_DIMENSIONS,
  TEST_QUALITY_SCORE_MAX,
  TEST_QUALITY_SCORE_MIN,
} from "../testQualityRubric.js";

interface SchemaNode {
  readonly type?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly items?: SchemaNode;
  readonly properties?: Readonly<Record<string, SchemaNode>>;
}

const schema = TEST_QUALITY_JUDGE_RESPONSE_SCHEMA as unknown as SchemaNode;

describe("judge response schema bounds", () => {
  it("bounds the model-supplied score to the documented range", () => {
    const score = schema.properties?.dimensions?.items?.properties?.score;
    expect(score?.type).toBe("integer");
    expect(score?.minimum).toBe(TEST_QUALITY_SCORE_MIN);
    expect(score?.maximum).toBe(TEST_QUALITY_SCORE_MAX);
  });

  it("pins the dimensions array to exactly the declared rubric dimensions", () => {
    const dimensions = schema.properties?.dimensions;
    expect(dimensions?.minItems).toBe(TEST_QUALITY_RUBRIC_DIMENSIONS.length);
    expect(dimensions?.maxItems).toBe(TEST_QUALITY_RUBRIC_DIMENSIONS.length);
  });

  it("bounds every rationale string the model can return", () => {
    expect(schema.properties?.dimensions?.items?.properties?.rationale?.maxLength).toBe(
      TEST_QUALITY_RATIONALE_MAX_CHARS,
    );
    expect(schema.properties?.overallRationale?.maxLength).toBe(TEST_QUALITY_RATIONALE_MAX_CHARS);
  });
});
