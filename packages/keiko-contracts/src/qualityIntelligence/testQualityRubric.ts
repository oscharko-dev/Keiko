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

/**
 * Upper bound on every model-supplied rationale string. The schema is the enforcement point for a
 * MODEL's response, so an unbounded string here is an unbounded allocation driven by the model's
 * output — and these rationales are carried into evidence.
 */
export const TEST_QUALITY_RATIONALE_MAX_CHARS = 2_000;

export const TEST_QUALITY_SCORE_MIN = 0;
export const TEST_QUALITY_SCORE_MAX = 100;

// Every bound the surrounding types DOCUMENT is declared here too. The schema is what the provider
// enforces on the model's structured output, so a bound that lives only in a TypeScript comment
// ("Integer in [0, 100]") is not enforced anywhere at runtime: a score of -5 or 10_000, a
// dimensions array repeating one dimension a thousand times, and a megabyte rationale all satisfied
// the previous schema.
export const TEST_QUALITY_JUDGE_RESPONSE_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["dimensions", "overallRationale"],
  properties: {
    dimensions: {
      type: "array",
      minItems: TEST_QUALITY_RUBRIC_DIMENSIONS.length,
      maxItems: TEST_QUALITY_RUBRIC_DIMENSIONS.length,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "score", "rationale"],
        properties: {
          name: { type: "string", enum: [...TEST_QUALITY_RUBRIC_DIMENSIONS] },
          score: {
            type: "integer",
            minimum: TEST_QUALITY_SCORE_MIN,
            maximum: TEST_QUALITY_SCORE_MAX,
          },
          rationale: { type: "string", maxLength: TEST_QUALITY_RATIONALE_MAX_CHARS },
        },
      },
    },
    overallRationale: { type: "string", maxLength: TEST_QUALITY_RATIONALE_MAX_CHARS },
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
