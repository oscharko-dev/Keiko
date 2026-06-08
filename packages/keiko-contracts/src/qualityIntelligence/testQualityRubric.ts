// Quality Intelligence test-quality rubric contract (Epic #736, Issue #746).
//
// Defines the four dimensions that a model-judge evaluates for every generated test-case
// candidate, the per-dimension score shape, and the aggregated judge verdict. These types
// are pure data contracts — no logic, no IO, no model calls.

export type TestQualityDimensionName =
  | "verifiability"
  | "atomicity"
  | "determinism"
  | "ac-fidelity";

export interface TestQualityRubricDimension {
  readonly name: TestQualityDimensionName;
  /** Integer in [0, 100]. 0 = worst; 100 = best. */
  readonly score: number;
  /** Human-readable rationale for the score; already redacted by the producer. */
  readonly rationale: string;
}

export interface TestQualityJudgeVerdict {
  readonly verdict: "weak" | "strong";
  readonly dimensions: readonly TestQualityRubricDimension[];
  /** Aggregated explanation; already redacted by the producer. */
  readonly overallRationale: string;
}
