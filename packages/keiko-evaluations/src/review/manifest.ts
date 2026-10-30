// The review evaluation manifest (Issue #4132, ADR-0182 D9). The holdout boundary is a constant
// here, chosen once from the recorded baseline (docs/qa/review-agent-baseline-2026-10-30.md) and
// never an option of a run: changing it is a reviewed edit to this file, not a flag. The offline
// thresholds are ADR-0182 D9's and are never lowered to make a model pass.

import { REVIEW_PRESENTED_FINDINGS_MAX } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import type { ReviewEvaluationManifest } from "./types.js";

export const REVIEW_EVALUATION_MANIFEST: ReviewEvaluationManifest = Object.freeze({
  schemaVersion: 1,
  datasetPath: "packages/keiko-evaluations/src/review/fixtures/review-harvest-dataset.v1.json.gz",
  datasetDigest: "sha256:c6dfbede99249e9fda874649d4a938e4d3e69b4b8fb8e70be0d3c099b486f194",
  holdoutFromPullRequest: 3066,
  holdoutRule:
    "The smallest pull request number from which the most recent 30 % of merged pull requests " +
    "carrying at least one review thread are held out, fixed on 2026-10-30.",
  minimumActionableRate: 0.5,
  maximumFindingsPerPullRequest: REVIEW_PRESENTED_FINDINGS_MAX,
});
