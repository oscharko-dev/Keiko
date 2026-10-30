// Chronological review replay (Issue #4132, ADR-0182 D9), ported in meaning from the retired
// reviewer's `historical-replay-lib.mjs`: replay historical pull requests at their head commits
// through an injected review port and score each presented finding against the labeled harvest by
// file and overlapping range.
//
// Holdout discipline is enforced here, at the production entry point, before any model is called:
// the boundary is the manifest constant (never an option), a run must say which split it reads and
// for what purpose, and a run that names a holdout pull request as a tuning input — or tunes on the
// holdout at all — is refused with `ReviewHoldoutViolationError`. Configuration, prompt and
// threshold changes are therefore made against the development set only, and every run record says
// which set produced it.

import type { ReviewFindingReport, ReviewRunSettlement } from "@oscharko-dev/keiko-contracts";
import type { ModelPort } from "@oscharko-dev/keiko-harness";

import { matchReviewFinding } from "./labels.js";
import { REVIEW_EVALUATION_MANIFEST } from "./manifest.js";
import { measureReviewCase, resolveReviewModel, type ReviewModelOptions } from "./model.js";
import {
  REVIEW_EVAL_SCHEMA_VERSION,
  type ReviewEvaluationSplit,
  type ReviewHarvestDataset,
  type ReviewHarvestPullRequest,
  type ReviewReplayFinding,
  type ReviewReplayPullRequestResult,
  type ReviewReplayPurpose,
  type ReviewReplayRun,
} from "./types.js";

export type ReviewHoldoutViolationCode =
  "holdout-tuning-input" | "holdout-tuning-run" | "split-mismatch" | "unknown-pull-request";

/** A replay request that would let holdout data shape the system it later judges. */
export class ReviewHoldoutViolationError extends Error {
  readonly code: ReviewHoldoutViolationCode;
  readonly pullRequests: readonly number[];

  constructor(code: ReviewHoldoutViolationCode, pullRequests: readonly number[]) {
    super(`review replay refused (${code}): pull requests ${pullRequests.join(", ") || "none"}`);
    this.name = "ReviewHoldoutViolationError";
    this.code = code;
    this.pullRequests = pullRequests;
  }
}

export interface ReviewReplayTarget {
  readonly number: number;
  readonly baseCommit: string | null;
  readonly headCommit: string | null;
}

/** What the review pipeline under test returns for one pull request: its presented findings. */
export interface ReviewReplayPortResult {
  readonly settlement: ReviewRunSettlement;
  readonly findings: readonly ReviewFindingReport[];
}

/** The injected review implementation. The real pipeline is composed in by a higher layer. */
export interface ReviewReplayPort {
  readonly reviewPullRequest: (input: {
    readonly pullRequest: ReviewReplayTarget;
    readonly model: ModelPort;
    readonly signal: AbortSignal;
  }) => Promise<ReviewReplayPortResult>;
}

export interface ReviewReplayOptions {
  readonly dataset: ReviewHarvestDataset;
  readonly split: ReviewEvaluationSplit;
  readonly purpose: ReviewReplayPurpose;
  /** Pull requests whose labels informed a configuration, prompt or threshold change. */
  readonly tuningInputs: readonly number[];
  /** A subset of the split to replay; defaults to every pull request of the split with threads. */
  readonly pullRequests?: readonly number[] | undefined;
  readonly port: ReviewReplayPort;
  readonly model: ReviewModelOptions;
  readonly now?: (() => number) | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** The split one pull request belongs to under the manifest boundary. */
export function reviewSplitOf(pullRequest: number): ReviewEvaluationSplit {
  return pullRequest >= REVIEW_EVALUATION_MANIFEST.holdoutFromPullRequest
    ? "holdout"
    : "development";
}

function assertHoldoutDiscipline(options: ReviewReplayOptions): void {
  const holdoutInputs = options.tuningInputs.filter((pr) => reviewSplitOf(pr) === "holdout");
  if (holdoutInputs.length > 0) {
    throw new ReviewHoldoutViolationError("holdout-tuning-input", holdoutInputs);
  }
  if (options.purpose === "tuning" && options.split === "holdout") {
    throw new ReviewHoldoutViolationError("holdout-tuning-run", []);
  }
}

function selectPullRequests(options: ReviewReplayOptions): readonly ReviewHarvestPullRequest[] {
  const inSplit = options.dataset.pullRequests.filter(
    (pullRequest) => reviewSplitOf(pullRequest.number) === options.split,
  );
  if (options.pullRequests === undefined) return inSplit.filter((pr) => pr.threads.length > 0);
  const foreign = options.pullRequests.filter((pr) => reviewSplitOf(pr) !== options.split);
  if (foreign.length > 0) throw new ReviewHoldoutViolationError("split-mismatch", foreign);
  const byNumber = new Map(inSplit.map((pullRequest) => [pullRequest.number, pullRequest]));
  const unknown = options.pullRequests.filter((pr) => !byNumber.has(pr));
  if (unknown.length > 0) throw new ReviewHoldoutViolationError("unknown-pull-request", unknown);
  return options.pullRequests.map((pr) => byNumber.get(pr)).filter((pr) => pr !== undefined);
}

function scoreFindings(
  findings: readonly ReviewFindingReport[],
  pullRequest: ReviewHarvestPullRequest,
): readonly ReviewReplayFinding[] {
  return findings.map((finding) => {
    const match = matchReviewFinding(finding, pullRequest.threads);
    return {
      file: finding.file,
      startLine: finding.startLine,
      endLine: finding.endLine,
      category: finding.category,
      severity: finding.severity,
      outcome: match.outcome,
      matchedThreadIds: match.matchedThreadIds,
    };
  });
}

async function replayOne(
  pullRequest: ReviewHarvestPullRequest,
  options: ReviewReplayOptions,
  signal: AbortSignal,
): Promise<ReviewReplayPullRequestResult> {
  const model = resolveReviewModel(String(pullRequest.number), options.model);
  const target = {
    number: pullRequest.number,
    baseCommit: pullRequest.baseCommit,
    headCommit: pullRequest.headCommit,
  };
  const { result, cost } = await measureReviewCase(model, options.now ?? Date.now, (port) =>
    options.port.reviewPullRequest({ pullRequest: target, model: port, signal }),
  );
  return {
    number: pullRequest.number,
    settlement: result.settlement,
    findings: scoreFindings(result.findings, pullRequest),
    cost,
  };
}

/**
 * Replays one split of the labeled history through the injected review port, one pull request at a
 * time in ascending order, and returns the run record. Refuses before any model call when the
 * request breaks holdout discipline.
 */
export async function runReviewReplay(options: ReviewReplayOptions): Promise<ReviewReplayRun> {
  assertHoldoutDiscipline(options);
  const selected = selectPullRequests(options);
  const signal = options.signal ?? new AbortController().signal;
  const results: ReviewReplayPullRequestResult[] = [];
  for (const pullRequest of selected) results.push(await replayOne(pullRequest, options, signal));
  return {
    schemaVersion: REVIEW_EVAL_SCHEMA_VERSION,
    datasetDigest: options.dataset.digest,
    holdoutFromPullRequest: REVIEW_EVALUATION_MANIFEST.holdoutFromPullRequest,
    split: options.split,
    purpose: options.purpose,
    tuningInputs: [...options.tuningInputs].sort((left, right) => left - right),
    modelId: options.model.modelId,
    pullRequests: results,
  };
}
