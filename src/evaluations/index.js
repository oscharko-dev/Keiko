// Public barrel for the Wave 1 evaluation harness (ADR-0012 D11). Explicit named re-exports — no
// `export *` — so the SDK surface stays auditable. This replaces the prior placeholder barrel. The
// evaluation layer is the highest-level policy consumer: it composes the workflow/audit/verification
// layers UNCHANGED and nothing below it imports from here.
export { runEvaluationSuite } from "./runner.js";
export { createScriptedModelPort } from "./scripted-model.js";
export { createEvaluationModelProvider } from "./model-provider.js";
export { scoreFixture, aggregateScorecard, summarizeScorecard } from "./scorer.js";
export { checkSurfaceParity } from "./surface-parity.js";
export { renderEvalSummary } from "./render.js";
export { ALL_FIXTURES, SUITE_NAMES, fixturesForSuite, fixtureByName, isSuiteName, } from "./fixtures/index.js";
export { EVAL_SCORECARD_SCHEMA_VERSION, EVALUATION_DIMENSIONS, } from "./types.js";
