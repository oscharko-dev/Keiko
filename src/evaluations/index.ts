// Re-export shim: the evaluation harness lives in @oscharko-dev/keiko-evaluations
// (issue #425, ADR-0019). All existing import sites (`from "../evaluations/index.js"`) keep
// resolving unchanged via this barrel. Mirrors the tools/workspace/verification shim conventions:
// explicit named re-exports, `type` keyword for type-only, double quotes, `.js` suffix.

export { runEvaluationSuite } from "@oscharko-dev/keiko-evaluations";
export type { EvalRunnerDeps, EvalRunOptions } from "@oscharko-dev/keiko-evaluations";
export { createScriptedModelPort } from "@oscharko-dev/keiko-evaluations";
export type { ScriptedModelPort } from "@oscharko-dev/keiko-evaluations";
export { createEvaluationModelProvider } from "@oscharko-dev/keiko-evaluations";
export type { EvaluationModelProviderDeps } from "@oscharko-dev/keiko-evaluations";
export {
  scoreFixture,
  aggregateScorecard,
  summarizeScorecard,
} from "@oscharko-dev/keiko-evaluations";
export type { ScoringInput } from "@oscharko-dev/keiko-evaluations";
export { checkSurfaceParity } from "@oscharko-dev/keiko-evaluations";
export { renderEvalSummary } from "@oscharko-dev/keiko-evaluations";
export {
  ALL_FIXTURES,
  SUITE_NAMES,
  fixturesForSuite,
  fixtureByName,
  isSuiteName,
  type SuiteName,
} from "@oscharko-dev/keiko-evaluations";
export {
  EVAL_SCORECARD_SCHEMA_VERSION,
  EVALUATION_DIMENSIONS,
  type DimensionOutcome,
  type DimensionResult,
  type EvalScorecard,
  type EvaluationDimension,
  type EvaluationFixture,
  type EvaluationMode,
  type FixtureOracle,
  type FixtureRunResult,
  type LiveRunContext,
  type ScorecardEntry,
  type ScorecardSummary,
  type SurfaceParityCheckResult,
  type SurfaceParityResult,
  type WorkflowKind,
} from "@oscharko-dev/keiko-evaluations";
