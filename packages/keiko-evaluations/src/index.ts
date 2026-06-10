// Public barrel for the Wave 1 evaluation harness (ADR-0012 D11). Explicit named re-exports — no
// `export *` — so the SDK surface stays auditable. This replaces the prior placeholder barrel. The
// evaluation layer is the highest-level policy consumer: it composes the workflow/audit/verification
// layers UNCHANGED and nothing below it imports from here.

export { runEvaluationSuite } from "./runner.js";
export type { EvalRunnerDeps, EvalRunOptions } from "./runner.js";
export { createScriptedModelPort } from "./scripted-model.js";
export type { ScriptedModelPort } from "./scripted-model.js";
export { createEvaluationModelProvider } from "./model-provider.js";
export type { EvaluationModelProviderDeps } from "./model-provider.js";
export { scoreFixture, aggregateScorecard, summarizeScorecard } from "./scorer.js";
export type { ScoringInput } from "./scorer.js";
export { checkSurfaceParity } from "./surface-parity.js";
export { renderEvalSummary } from "./render.js";
export {
  ALL_FIXTURES,
  SUITE_NAMES,
  fixturesForSuite,
  fixtureByName,
  isSuiteName,
  type SuiteName,
} from "./fixtures/index.js";
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
} from "./types.js";
