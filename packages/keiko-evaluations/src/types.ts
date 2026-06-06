// Re-export shim: evaluation contract types and the EVAL_SCORECARD_SCHEMA_VERSION constant live in
// @oscharko-dev/keiko-contracts (issue #158). `verbatimModuleSyntax` is on, so type-only names use
// `export type` and value-emitting frozen constants use `export`.

export type {
  EvaluationDimension,
  FixtureOracle,
  WorkflowKind,
  EvaluationFixture,
  DimensionOutcome,
  DimensionResult,
  FixtureRunResult,
  ScorecardEntry,
  SurfaceParityCheckResult,
  SurfaceParityResult,
  LiveRunContext,
  ScorecardSummary,
  EvalScorecard,
  EvaluationMode,
} from "@oscharko-dev/keiko-contracts";
export {
  EVALUATION_DIMENSIONS,
  EVAL_SCORECARD_SCHEMA_VERSION,
} from "@oscharko-dev/keiko-contracts";
