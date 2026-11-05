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
  /**
   * The right-side line anchor carried to the pull request's head commit (R4130-007): the line
   * numbers a replayed finding at head is compared with. Both null for a file-level or base-side
   * thread and for a line anchor whose carry failed; a replay treats the latter as unmeasured.
   */
  readonly headStartLine: number | null;
  readonly headEndLine: number | null;
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

export const REVIEW_HARVEST_SCHEMA_VERSION = 2 as const;

export interface ReviewHarvestDataset {
  readonly schemaVersion: typeof REVIEW_HARVEST_SCHEMA_VERSION;
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
 * the hand-graded sample and is never counted as a hit. `duplicate` is a finding that would be a hit
 * on threads an earlier finding of the same pull request was already credited for (R4130-014): it
 * adds no hit and counts against the actionable rate.
 */
export const REVIEW_FINDING_OUTCOMES = [...REVIEW_THREAD_LABELS, "unmatched", "duplicate"] as const;
export type ReviewFindingOutcome = (typeof REVIEW_FINDING_OUTCOMES)[number];

// ─── Holdout discipline and replay ───────────────────────────────────────────

export const REVIEW_EVALUATION_SPLITS = ["development", "holdout"] as const;
export type ReviewEvaluationSplit = (typeof REVIEW_EVALUATION_SPLITS)[number];

export const REVIEW_REPLAY_PURPOSES = ["tuning", "evaluation"] as const;
export type ReviewReplayPurpose = (typeof REVIEW_REPLAY_PURPOSES)[number];

/**
 * Which pull requests a run reviewed (R4130-011). `default`: exactly every pull request of the
 * split that carries a thread, the replay's default. `subset`: any other choice. Only a default
 * holdout evaluation is evidence for the offline gate.
 */
export const REVIEW_REPLAY_SELECTIONS = ["default", "subset"] as const;
export type ReviewReplaySelection = (typeof REVIEW_REPLAY_SELECTIONS)[number];

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
  /**
   * The largest share of a run's reviews that may settle other than `complete` (R4130-011). Above
   * it the gate fails: the rate would describe only the reviews that finished.
   */
  readonly maximumNotCompleteShare: number;
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

/**
 * What a replay measured and for which model: the split, the purpose, how its pull requests were
 * selected and the holdout boundary. A run and the summary scored from it share this scope.
 */
export interface ReviewReplayScope {
  readonly split: ReviewEvaluationSplit;
  readonly purpose: ReviewReplayPurpose;
  readonly selection: ReviewReplaySelection;
  readonly holdoutFromPullRequest: number;
  readonly modelId: string;
}

/** The record of one replay run: its scope, the dataset it read and its results. */
export interface ReviewReplayRun extends ReviewReplayScope {
  readonly schemaVersion: typeof REVIEW_EVAL_SCHEMA_VERSION;
  readonly datasetDigest: string;
  readonly tuningInputs: readonly number[];
  readonly pullRequests: readonly ReviewReplayPullRequestResult[];
}

// ─── Precision gate ──────────────────────────────────────────────────────────

export interface ReviewOutcomeCounts {
  readonly findings: number;
  readonly hit: number;
  readonly falseAlarm: number;
  readonly undecided: number;
  readonly duplicate: number;
  readonly unmeasured: number;
  readonly unmatched: number;
  /**
   * The gated rate: hits over hits, false alarms and undecided findings (owner decision 2026-11-04,
   * R4130-006), plus duplicate findings in the denominator (the implementation's rule for
   * R4130-014), with its Wilson interval. A finding nobody answered or acted on counts against the
   * agent.
   */
  readonly actionableRate: WilsonInterval;
  /** Reported, never gated: hits over hits plus false alarms, with its Wilson interval. */
  readonly acceptanceRate: WilsonInterval;
}

export interface ReviewCostSummary {
  readonly total: number;
  readonly meanPerPullRequest: number | null;
}

export interface ReviewPrecisionSummary extends ReviewReplayScope {
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
