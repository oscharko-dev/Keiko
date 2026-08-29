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
export { binaryNdcgAtK, mean } from "./metrics.js";
export { evaluateFloors, runRegressionProbes } from "./quality-helpers.js";
export type {
  MinimumFloorResult,
  RegressionProbeObservation,
  RegressionProbeRunResult,
  RunRegressionProbesOptions,
} from "./quality-helpers.js";
// Local Knowledge retrieval evaluation suite (Issue #2568; ADR-0152 D5). A namespace avoids
// colliding with the ADR-0012 suite's canonical ALL_FIXTURES registry.
export * as LocalKnowledgeEval from "./local-knowledge/index.js";
// Prompt Enhancer evaluation suite (Epic #1307, Issue #1315). Exposed as a single auditable namespace,
// mirroring the gateway's `PromptEnhancer` and evidence's `PromptEnhancement` namespace convention.
export * as PromptEnhancerEval from "./promptEnhancer/index.js";
// Discussion Intelligence evaluation suite (Epic #491, Issue #502; ADR-0107). Exposed as a single
// auditable namespace, mirroring the `PromptEnhancerEval` convention above.
export * as DiscussionEval from "./discussion/index.js";
// Voice Digital Twin evaluation suite (Epic #491, Issue #505 — the capstone; ADR-0110). Exposed as a
// single auditable namespace, mirroring the `DiscussionEval` convention above.
export * as VoiceTwinEval from "./voice-twin/index.js";
// Offline acoustic-quality companion gate for voice (P10). Exposed as a single auditable namespace
// beside VoiceTwinEval; fixtures are deterministic transcript/trace data with no raw audio.
export * as VoiceAcousticEval from "./voice-acoustic/index.js";
// KEIKO-0313: Voice Action Governance evaluation suite (Epic #491, Issue #503; ADR-0108). Was
// previously self-contained (proven by its own suite.test.ts), but the SDK barrel omission left the
// suite's ~1000 lines of security-gating scorer/runner/fixtures unreachable from the public surface
// so no CLI or embedding consumer could invoke it. Exposed as a single auditable namespace matching
// the VoiceTwinEval / VoiceAcousticEval convention.
export * as VoiceActionEval from "./voice-action/index.js";
export {
  ALL_FIXTURES,
  SUITE_NAMES,
  fixturesForSuite,
  fixtureByName,
  isSuiteName,
  type SuiteName,
  type FixtureLookupResult,
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
  type EvalBudget,
  type EvalFloorResult,
  type RegressionProbeResult,
  type FixtureOracle,
  type FixtureRunResult,
  type LiveRunContext,
  type ScorecardEntry,
  type ScorecardSummary,
  type SurfaceParityCheckResult,
  type SurfaceParityResult,
  type WorkflowKind,
} from "./types.js";
