// Public barrel for the Wave 1 evaluation harness (ADR-0012 D11). Explicit named re-exports — no
// `export *` — so the SDK surface stays auditable. This replaces the prior placeholder barrel. The
// evaluation layer is the highest-level policy consumer: it composes the workflow/audit/verification
// layers UNCHANGED and nothing below it imports from here.

export { runEvaluationSuite } from "./runner.js";
export type { EvalRunnerDeps, EvalRunOptions } from "./runner.js";
export { createScriptedModelPort } from "./scripted-model.js";
export type { ScriptedModelPort } from "./scripted-model.js";
export { createEvaluationModelProvider } from "./model-provider.js";
export type { EvaluationConfigLoader, EvaluationModelProviderDeps } from "./model-provider.js";
export { scoreFixture, aggregateScorecard, summarizeScorecard } from "./scorer.js";
export type { ScoringInput } from "./scorer.js";
export { checkSurfaceParity } from "./surface-parity.js";
export { renderEvalSummary } from "./render.js";
// Prompt Enhancer evaluation suite (Epic #1307, Issue #1315). Exposed as a single auditable namespace,
// mirroring the gateway's `PromptEnhancer` and evidence's `PromptEnhancement` namespace convention.
export * as PromptEnhancerEval from "./promptEnhancer/index.js";
// Discussion Intelligence evaluation suite (Epic #491, Issue #502; ADR-0107). Exposed as a single
// auditable namespace, mirroring the `PromptEnhancerEval` convention above.
export * as DiscussionEval from "./discussion/index.js";
// Voice Digital Twin evaluation suite (Epic #491, Issue #505 — the capstone; ADR-0110). Exposed as a
// single auditable namespace, mirroring the `DiscussionEval` convention above.
export * as VoiceTwinEval from "./voice-twin/index.js";
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
