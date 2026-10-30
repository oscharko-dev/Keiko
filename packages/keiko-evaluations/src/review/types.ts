// Types of the Keiko for Quality review evaluation family (Issue #4132, ADR-0182 D9): the
// body-free harvest dataset, the thread labels, the replay run record, the precision summary and
// the seed gate report. Review contract shapes (findings, settlements, seed cases) come from
// keiko-contracts; nothing here redeclares them.

import type {
  ReviewCodeLocation,
  ReviewFindingCategory,
  ReviewFindingSeverity,
  ReviewRunSettlement,
  ReviewSettlementKind,
  ReviewSeedScore,
  WilsonInterval,
} from "@oscharko-dev/keiko-contracts";

export const REVIEW_EVAL_SCHEMA_VERSION = 1 as const;

// ─── Harvest dataset (written by scripts/review-harvest.mjs) ─────────────────

export const REVIEW_PRODUCERS = [
  "keiko-for-quality",
  "coderabbit",
  "codex",
  "qodo",
  "human",
  "other",
] as const;
export type ReviewProducer = (typeof REVIEW_PRODUCERS)[number];

export const REVIEW_REPLY_CLASSIFICATIONS = ["refuted", "fixed", "unclassified"] as const;
export type ReviewReplyClassification = (typeof REVIEW_REPLY_CLASSIFICATIONS)[number];

export const REVIEW_REGION_CHANGES = [
  "changed",
  "unchanged",
  "no-later-commit",
  "unavailable",
] as const;
export type ReviewRegionChange = (typeof REVIEW_REGION_CHANGES)[number];

export interface ReviewHarvestReply {
  readonly classification: ReviewReplyClassification;
  readonly producer: ReviewProducer;
}

/** One review thread, body-free: who opened it, where, and what happened afterwards. */
export interface ReviewHarvestThread {
  readonly id: string;
  readonly producer: ReviewProducer;
  readonly path: string;
  /** 1-based inclusive range at the reviewed commit; both null for a file-level thread. */
  readonly startLine: number | null;
  readonly endLine: number | null;
  readonly fileLevel: boolean;
  readonly side: "left" | "right";
  readonly reviewedCommit: string | null;
  readonly resolved: boolean;
  readonly outdated: boolean;
  /** The first reply by someone other than the thread's author; null when nobody answered. */
  readonly reply: ReviewHarvestReply | null;
  readonly regionChange: ReviewRegionChange;
  /** `sha256:<hex>` of the root comment body, for duplicate detection only. */
  readonly bodyDigest: string;
}

export interface ReviewHarvestPullRequest {
  readonly number: number;
  readonly state: "merged" | "closed";
  readonly headCommit: string | null;
  readonly baseCommit: string | null;
  /** Every producer that submitted a review or opened a thread, in `REVIEW_PRODUCERS` order. */
  readonly reviewedBy: readonly ReviewProducer[];
  readonly threads: readonly ReviewHarvestThread[];
}

export interface ReviewHarvestDataset {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly rules: Readonly<Record<string, string | number>>;
  readonly population: {
    readonly states: readonly string[];
    readonly pullRequestCount: number;
    readonly firstPullRequest: number | null;
    readonly lastPullRequest: number | null;
  };
  readonly excludedNoticeThreads: Readonly<Record<ReviewProducer, number>>;
  readonly pullRequests: readonly ReviewHarvestPullRequest[];
  readonly digest: string;
}

// ─── Labels ──────────────────────────────────────────────────────────────────

/**
 * `hit`: the anchored region changed later in the same pull request (a refutation the code then
 * contradicted is a hit too). `false-alarm`: an evidenced refutation with the code unchanged.
 * `undecided`: unchanged and not refuted. `unmeasured`: git could not answer.
 */
export const REVIEW_THREAD_LABELS = ["hit", "false-alarm", "undecided", "unmeasured"] as const;
export type ReviewThreadLabel = (typeof REVIEW_THREAD_LABELS)[number];

export interface ReviewThreadLabelling {
  readonly label: ReviewThreadLabel;
  readonly refuted: boolean;
  /** A refutation that a later change to the same region contradicted. */
  readonly refutationContradicted: boolean;
}

/**
 * A replayed finding's outcome. `unmatched` means no historical thread overlaps it: it belongs to
 * the hand-graded sample and is never counted as a hit.
 */
export const REVIEW_FINDING_OUTCOMES = [...REVIEW_THREAD_LABELS, "unmatched"] as const;
export type ReviewFindingOutcome = (typeof REVIEW_FINDING_OUTCOMES)[number];

// ─── Holdout discipline and replay ───────────────────────────────────────────

export const REVIEW_EVALUATION_SPLITS = ["development", "holdout"] as const;
export type ReviewEvaluationSplit = (typeof REVIEW_EVALUATION_SPLITS)[number];

export const REVIEW_REPLAY_PURPOSES = ["tuning", "evaluation"] as const;
export type ReviewReplayPurpose = (typeof REVIEW_REPLAY_PURPOSES)[number];

export interface ReviewEvaluationManifest {
  readonly schemaVersion: 1;
  /** Path of the committed dataset, relative to the repository root. */
  readonly datasetPath: string;
  readonly datasetDigest: string;
  /** Pull requests below this number form the development set; it and later ones the holdout. */
  readonly holdoutFromPullRequest: number;
  readonly holdoutRule: string;
  /** ADR-0182 D9 offline thresholds. */
  readonly minimumActionableRate: number;
  readonly maximumFindingsPerPullRequest: number;
}

export interface ReviewRunCost {
  readonly modelCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly wallTimeMs: number;
}

export interface ReviewReplayFinding extends ReviewCodeLocation {
  readonly category: ReviewFindingCategory;
  readonly severity: ReviewFindingSeverity;
  readonly outcome: ReviewFindingOutcome;
  readonly matchedThreadIds: readonly string[];
}

export interface ReviewReplayPullRequestResult {
  readonly number: number;
  readonly settlement: ReviewRunSettlement;
  readonly findings: readonly ReviewReplayFinding[];
  readonly cost: ReviewRunCost;
}

/** The record of one replay run: which split produced it, for what purpose, and its results. */
export interface ReviewReplayRun {
  readonly schemaVersion: typeof REVIEW_EVAL_SCHEMA_VERSION;
  readonly datasetDigest: string;
  readonly holdoutFromPullRequest: number;
  readonly split: ReviewEvaluationSplit;
  readonly purpose: ReviewReplayPurpose;
  readonly tuningInputs: readonly number[];
  readonly modelId: string;
  readonly pullRequests: readonly ReviewReplayPullRequestResult[];
}

// ─── Precision gate ──────────────────────────────────────────────────────────

export interface ReviewOutcomeCounts {
  readonly findings: number;
  readonly hit: number;
  readonly falseAlarm: number;
  readonly undecided: number;
  readonly unmeasured: number;
  readonly unmatched: number;
  /** Hits over decided findings (hits plus false alarms), with its Wilson interval. */
  readonly actionableRate: WilsonInterval;
}

export interface ReviewCostSummary {
  readonly total: number;
  readonly meanPerPullRequest: number | null;
}

export interface ReviewPrecisionSummary {
  readonly split: ReviewEvaluationSplit;
  readonly purpose: ReviewReplayPurpose;
  readonly holdoutFromPullRequest: number;
  readonly modelId: string;
  readonly pullRequests: number;
  readonly overall: ReviewOutcomeCounts;
  readonly byCategory: Readonly<Record<ReviewFindingCategory, ReviewOutcomeCounts>>;
  readonly bySeverity: Readonly<Record<ReviewFindingSeverity, ReviewOutcomeCounts>>;
  readonly findingsPerPullRequest: { readonly mean: number | null; readonly max: number };
  readonly settlements: Readonly<Record<ReviewSettlementKind, number>>;
  readonly cost: {
    readonly modelCalls: ReviewCostSummary;
    readonly inputTokens: ReviewCostSummary;
    readonly outputTokens: ReviewCostSummary;
    readonly wallTimeMs: ReviewCostSummary;
  };
}

export type ReviewGateVerdict = "pass" | "fail" | "unmeasured";

export interface ReviewPrecisionGateResult {
  readonly verdict: ReviewGateVerdict;
  readonly reasons: readonly string[];
}

// ─── Seed gate ───────────────────────────────────────────────────────────────

export const REVIEW_SEED_OUTCOMES = [
  "found",
  "missed",
  "incomplete",
  "stale-run",
  "stale-seed",
  "clean",
  "false-alarm",
] as const;
export type ReviewSeedOutcome = (typeof REVIEW_SEED_OUTCOMES)[number];

export interface ReviewSeedCaseReport {
  readonly id: string;
  readonly required: boolean;
  readonly cleanControl: boolean;
  readonly outcome: ReviewSeedOutcome;
  readonly findings: number;
  readonly falseAlarms: number;
  /** Why a consumer seed could not be planted; present only for `stale-seed`. */
  readonly staleReason?: string;
  readonly cost: ReviewRunCost;
}

export interface ReviewSeedGateReport {
  readonly verdict: ReviewGateVerdict;
  readonly reasons: readonly string[];
  readonly modelId: string;
  readonly score: ReviewSeedScore;
  readonly staleSeeds: readonly string[];
  readonly requiredFailures: readonly string[];
  /** False alarms on clean controls, counted apart from the recall verdict. */
  readonly cleanControlFalseAlarms: number;
  readonly cases: readonly ReviewSeedCaseReport[];
}
