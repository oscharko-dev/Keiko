// Public barrel for the Keiko for Quality review evaluation family (Issue #4132, ADR-0182 D9): the
// harvest dataset loader, the labeling rules, the chronological replay with its holdout guard, the
// precision gate, the seed gate with the Keiko consumer seeds, the baseline summary and the
// renderers. Re-exported from the package barrel as one auditable namespace (`ReviewEval`).

export {
  loadReviewHarvestDataset,
  parseReviewHarvestDataset,
  ReviewDatasetError,
} from "./dataset.js";
export { findingOverlapsThread, labelReviewThread, matchReviewFinding } from "./labels.js";
export type { ReviewFindingMatch } from "./labels.js";
export { REVIEW_EVALUATION_MANIFEST } from "./manifest.js";
export { meterModelPort, resolveReviewModel } from "./model.js";
export type { MeteredModelPort, ReviewModelOptions } from "./model.js";
export { ReviewHoldoutViolationError, reviewSplitOf, runReviewReplay } from "./replay.js";
export type {
  ReviewHoldoutViolationCode,
  ReviewReplayOptions,
  ReviewReplayPort,
  ReviewReplayPortResult,
  ReviewReplayTarget,
} from "./replay.js";
export {
  countReviewOutcomes,
  evaluateReviewPrecisionGate,
  summarizeReviewPrecision,
} from "./precision-gate.js";
export { KEIKO_CONSUMER_SEEDS } from "./consumer-seeds.js";
export type { ReviewConsumerSeed, ReviewConsumerSeedDemotion } from "./consumer-seeds.js";
export {
  assertConsumerSeeds,
  plantConsumerSeed,
  ReviewSeedDefinitionError,
  runReviewSeedGate,
} from "./seed-gate.js";
export type {
  PlantedConsumerSeed,
  ReviewSeedGateOptions,
  ReviewSeedPort,
  ReviewSeedPortResult,
} from "./seed-gate.js";
export { summarizeReviewBaseline } from "./baseline.js";
export type { ReviewBaseline, ReviewProducerBaseline, ReviewSplitCounts } from "./baseline.js";
export {
  formatWilson,
  renderReviewBaseline,
  renderReviewPrecision,
  renderReviewSeedGate,
} from "./render.js";
export {
  REVIEW_EVAL_SCHEMA_VERSION,
  REVIEW_EVALUATION_SPLITS,
  REVIEW_FINDING_OUTCOMES,
  REVIEW_PRODUCERS,
  REVIEW_REGION_CHANGES,
  REVIEW_REPLAY_PURPOSES,
  REVIEW_REPLY_CLASSIFICATIONS,
  REVIEW_SEED_OUTCOMES,
  REVIEW_THREAD_LABELS,
  type ReviewCostSummary,
  type ReviewEvaluationManifest,
  type ReviewEvaluationSplit,
  type ReviewFindingOutcome,
  type ReviewGateVerdict,
  type ReviewHarvestDataset,
  type ReviewHarvestPullRequest,
  type ReviewHarvestReply,
  type ReviewHarvestThread,
  type ReviewOutcomeCounts,
  type ReviewPrecisionGateResult,
  type ReviewPrecisionSummary,
  type ReviewProducer,
  type ReviewRegionChange,
  type ReviewReplayFinding,
  type ReviewReplayPullRequestResult,
  type ReviewReplayPurpose,
  type ReviewReplayRun,
  type ReviewReplyClassification,
  type ReviewRunCost,
  type ReviewSeedCaseReport,
  type ReviewSeedGateReport,
  type ReviewSeedOutcome,
  type ReviewThreadLabel,
  type ReviewThreadLabelling,
} from "./types.js";
