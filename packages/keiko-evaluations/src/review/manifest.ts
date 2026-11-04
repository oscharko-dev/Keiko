// The review evaluation manifest (Issue #4132, ADR-0182 D9). The holdout boundary is a constant
// here, chosen once from the recorded baseline (docs/qa/review-agent-baseline-2026-10-30.md) and
// never an option of a run: changing it is a reviewed edit to this file, not a flag. The offline
// thresholds are ADR-0182 D9's and are never lowered to make a model pass.

import { REVIEW_PRESENTED_FINDINGS_MAX } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import type { ReviewEvaluationManifest } from "./types.js";

export const REVIEW_EVALUATION_MANIFEST: ReviewEvaluationManifest = Object.freeze({
  schemaVersion: 1,
  datasetPath: "packages/keiko-evaluations/src/review/fixtures/review-harvest-dataset.v2.json.gz",
  datasetDigest: "sha256:af7d9d730611ee07d21c458bfe698ec47bb9145b8981b408d95cd53b48773ebd",
  holdoutFromPullRequest: 3066,
  holdoutRule:
    "The smallest pull request number from which the most recent 30 % of merged pull requests " +
    "carrying at least one review thread are held out, fixed on 2026-10-30.",
  minimumActionableRate: 0.5,
  maximumFindingsPerPullRequest: REVIEW_PRESENTED_FINDINGS_MAX,
  maximumNotCompleteShare: 0.2,
});
