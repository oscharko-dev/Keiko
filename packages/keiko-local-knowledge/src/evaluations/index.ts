// Public surface of the retrieval evaluation harness (Epic #189, Issue #268). The harness
// is composed by the package barrel in ../index.ts; consumers outside this package never
// import from this subdirectory directly (ADR-0019 direction rule 3e + the trust-8
// test-support naming convention).

export {
  ALL_FIXTURES,
  EVAL_EMBEDDING_IDENTITY,
  EVAL_TOPIC_BOOST,
  ambiguousQueryFixture,
  broadQueryDiversityFixture,
  contextBudgetFixture,
  multiCapsuleFixture,
  multiPageFixture,
  noEvidenceFixture,
  singleTopicFixture,
  staleIndexFixture,
  structuredFileFixture,
  sourceIsolationFixture,
  wrongScopeFixture,
} from "./fixtures.js";

export {
  citationRequirementForUnit,
  scoreCitationQuality,
  scoreContextBudgetFit,
  scoreNoEvidenceAccuracy,
  scorePrecision,
  scoreRecall,
  scoreSourceIsolation,
  type CitationRequirementKey,
} from "./dimensions.js";

export {
  createScriptedEmbeddingAdapter,
  fnv1a32,
  withTopicMarker,
  type ScriptedEmbeddingAdapterOptions,
} from "./scripted-embedding-adapter.js";

export { renderRetrievalEvalQualityGateReport } from "./report.js";
export { runRetrievalEval, type RunRetrievalEvalDeps } from "./runner.js";

export {
  PASS_THRESHOLDS,
  type EvalCapsuleSpec,
  type EvalChunkSpec,
  type EvalDocumentSpec,
  type EvalParsedUnitSpec,
  type EvalParsedUnitWithoutDocId,
  type EvalRetrievalScope,
  type EvalSourceSpec,
  type ModelJudgedRetrievalEvalInput,
  type ModelJudgedRetrievalEvalJudge,
  type ModelJudgedRetrievalEvalScores,
  type RetrievalEvalDimensionScores,
  type RetrievalEvalFixture,
  type RetrievalEvalQuery,
  type RetrievalEvalScorecard,
  type RetrievalEvalThresholds,
} from "./types.js";
