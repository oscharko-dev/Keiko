// Quality Intelligence test-quality rubric contract (Epic #736, Issue #746).
//
// Defines the four dimensions that a model-judge evaluates for every generated test-case
// candidate, the per-dimension score shape, the aggregated judge verdict, and the JSON schema
// that constrains gateway structured output. Pure data contracts — no logic, no IO, no model calls.

export const TEST_QUALITY_RUBRIC_DIMENSIONS = [
  "verifiability",
  "atomicity",
  "determinism",
  "ac-fidelity",
] as const;

export type TestQualityDimensionName = (typeof TEST_QUALITY_RUBRIC_DIMENSIONS)[number];

export const TEST_QUALITY_JUDGE_RESPONSE_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["dimensions", "overallRationale"],
  properties: {
    dimensions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "score", "rationale"],
        properties: {
          name: { type: "string", enum: [...TEST_QUALITY_RUBRIC_DIMENSIONS] },
          score: { type: "integer", minimum: 0, maximum: 100 },
          rationale: { type: "string" },
        },
      },
    },
    overallRationale: { type: "string" },
  },
});

export interface TestQualityRubricDimension {
  readonly name: TestQualityDimensionName;
  /** Integer in [0, 100]. 0 = worst; 100 = best. */
  readonly score: number;
  /** Human-readable rationale for the score; redact before persistence or browser projection. */
  readonly rationale: string;
}

export interface TestQualityJudgeVerdict {
  readonly verdict: "weak" | "strong";
  readonly dimensions: readonly TestQualityRubricDimension[];
  /** Aggregated explanation; redact before persistence or browser projection. */
  readonly overallRationale: string;
}
