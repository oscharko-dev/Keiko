// Keiko for Quality review contracts (ADR-0182, Issue #4131).
//
// One shared definition of the review target, run, finding, counter-check verdict, settlement,
// finding decision and model-role shapes. Runtime validation lives in
// `pull-request-review-validation.ts`; the fingerprint preimage, the role eligibility rule and seed
// scoring live in `pull-request-review-rules.ts`. Every text field is untrusted data written by a
// model or a person, never an instruction to Keiko.

/** Version of the `keiko_review_report` argument shape and the records derived from it. */
export const REVIEW_CONTRACT_VERSION = 1 as const;

export const REVIEW_REPOSITORY_ID_MAX_CHARS = 128;
export const REVIEW_RUN_ID_MAX_CHARS = 128;
export const REVIEW_MODEL_ID_MAX_CHARS = 256;
export const REVIEW_PULL_REQUEST_NUMBER_MAX = 2_147_483_647;
export const REVIEW_LINE_MAX = 10_000_000;
export const REVIEW_FINDING_TITLE_MAX_CHARS = 120;
export const REVIEW_FINDING_TEXT_MAX_CHARS = 1_200;
export const REVIEW_FAILURE_MODE_TEXT_MAX_CHARS = 600;
export const REVIEW_DECISION_NOTE_MAX_CHARS = 2_000;
export const REVIEW_EVIDENCE_MIN_ENTRIES = 1;
export const REVIEW_EVIDENCE_MAX_ENTRIES = 6;
/** Server presentation rule (ADR-0182 D4), not a schema limit on one report. */
export const REVIEW_PRESENTED_FINDINGS_MAX = 3;

// ─── Review target ───────────────────────────────────────────────────────────

/** A pull request on a hosting provider, resolved to an exact base and head commit. */
export interface PullRequestReviewTarget {
  readonly kind: "pull-request";
  readonly provider: "github";
  /** The content-free repository identity the task workspace derives. */
  readonly repositoryId: string;
  readonly number: number;
  /** Full 40- or 64-hex Git object ids, never abbreviations or revision expressions. */
  readonly baseSha: string;
  readonly headSha: string;
  /** Validated Git ref names without the `refs/` prefix. */
  readonly baseRef: string;
  readonly headRef: string;
  /** Whether the head lives in another repository (a fork). Protection does not depend on it. */
  readonly isCrossRepository: boolean;
}

/** A local branch reviewed against its base without a hosting provider. */
export interface LocalRangeReviewTarget {
  readonly kind: "local-range";
  readonly repositoryId: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly headRef: string;
}

export type ReviewTarget = PullRequestReviewTarget | LocalRangeReviewTarget;
export const REVIEW_TARGET_KINDS = ["pull-request", "local-range"] as const;
export const REVIEW_TARGET_PROVIDERS = ["github"] as const;

// ─── Run identity, phase and settlement ──────────────────────────────────────

export const REVIEW_RUN_PHASES = [
  "preparing",
  "reviewing",
  "counter-checking",
  "settling",
  "settled",
] as const;
export type ReviewRunPhase = (typeof REVIEW_RUN_PHASES)[number];

/** The reason-to-settlement table of ADR-0182 D6. Every child uses this one table. */
export const REVIEW_SETTLEMENT_REASONS = {
  complete: [],
  incomplete: ["files-unprocessed", "budget-exhausted", "deadline-exceeded", "model-failed"],
  abandoned: ["cancelled", "interrupted"],
  skipped: [
    "target-changed",
    "worktree-failed",
    "diff-too-large",
    "no-reviewable-changes",
    "rules-file-invalid",
    "policy-invalid",
    "model-unavailable",
  ],
} as const;

export type ReviewSettlementKind = keyof typeof REVIEW_SETTLEMENT_REASONS;
export const REVIEW_SETTLEMENT_KINDS = ["complete", "incomplete", "abandoned", "skipped"] as const;
export type ReviewIncompleteReason = (typeof REVIEW_SETTLEMENT_REASONS.incomplete)[number];
export type ReviewAbandonedReason = (typeof REVIEW_SETTLEMENT_REASONS.abandoned)[number];
export type ReviewSkippedReason = (typeof REVIEW_SETTLEMENT_REASONS.skipped)[number];

/**
 * How a run ended. Only `complete` describes a clean review; incomplete work never presents as
 * clean. A head that moved after preparation is a display state (`stale`), never a settlement.
 */
export type ReviewRunSettlement =
  | { readonly kind: "complete" }
  | { readonly kind: "incomplete"; readonly reason: ReviewIncompleteReason }
  | { readonly kind: "abandoned"; readonly reason: ReviewAbandonedReason }
  | { readonly kind: "skipped"; readonly reason: ReviewSkippedReason };

// ─── Findings ────────────────────────────────────────────────────────────────

export const REVIEW_FINDING_CATEGORIES = [
  "correctness",
  "security",
  "reliability",
  "performance",
  "concurrency",
  "data-integrity",
  "test-gap",
  "maintainability",
] as const;
export type ReviewFindingCategory = (typeof REVIEW_FINDING_CATEGORIES)[number];

export const REVIEW_FINDING_SEVERITIES = ["high", "medium", "low"] as const;
export type ReviewFindingSeverity = (typeof REVIEW_FINDING_SEVERITIES)[number];

export const REVIEW_EVIDENCE_ROLES = ["defect", "cause-in-change", "context"] as const;
export type ReviewEvidenceRole = (typeof REVIEW_EVIDENCE_ROLES)[number];

/** A workspace-relative, 1-based, inclusive line range in the reviewed commit. */
export interface ReviewCodeLocation {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface ReviewEvidence extends ReviewCodeLocation {
  readonly role: ReviewEvidenceRole;
}

export interface ReviewFailureMode {
  readonly trigger: string;
  readonly detection: string;
  readonly coveredByChange: boolean;
}

/** The `keiko_review_report` argument shape: one candidate finding from the Reviewer. */
export interface ReviewFindingReport extends ReviewCodeLocation {
  readonly title: string;
  readonly condition: string;
  readonly mechanism: string;
  readonly consequence: string;
  readonly remedy: string;
  readonly category: ReviewFindingCategory;
  readonly severity: ReviewFindingSeverity;
  readonly evidence: readonly ReviewEvidence[];
  readonly failureMode?: ReviewFailureMode;
}

// ─── Counter-check ───────────────────────────────────────────────────────────

export const COUNTER_CHECK_VERDICTS = ["confirmed", "refuted", "undecided"] as const;
export type CounterCheckVerdictValue = (typeof COUNTER_CHECK_VERDICTS)[number];

export const COUNTER_CHECK_REASON_CODES = [
  "defect-reproduced-in-code",
  "cause-not-in-change",
  "guarded-elsewhere",
  "evidence-mismatch",
  "insufficient-context",
  "out-of-budget",
] as const;
export type CounterCheckReasonCode = (typeof COUNTER_CHECK_REASON_CODES)[number];

/** The Counter-checker's structured verdict on one candidate finding (ADR-0182 D5). */
export interface CounterCheckVerdict {
  /** Content-derived, line-independent SHA-256 hex digest (ADR-0182 D7). */
  readonly findingFingerprint: string;
  readonly verdict: CounterCheckVerdictValue;
  /** The Counter-checker's own code evidence; a confirmation requires at least one entry. */
  readonly evidence: readonly ReviewEvidence[];
  readonly reasonCode: CounterCheckReasonCode;
}

/** The server's record of one candidate finding. */
export interface ReviewFindingRecord {
  /** Content-derived, line-independent SHA-256 hex digest (ADR-0182 D7). */
  readonly fingerprint: string;
  readonly report: ReviewFindingReport;
  /** Absent until the counter-check settled. */
  readonly verdict?: CounterCheckVerdict;
  /** Only confirmed findings are presented, at most `REVIEW_PRESENTED_FINDINGS_MAX` per run. */
  readonly presented: boolean;
  /** 1-based rank among presented findings; absent when not presented. */
  readonly presentationRank?: number;
}

// ─── Human finding decisions ─────────────────────────────────────────────────

export const FINDING_DECISIONS = ["accepted", "dismissed", "fixed"] as const;
export type FindingDecisionValue = (typeof FINDING_DECISIONS)[number];

export const FINDING_DISMISSAL_REASONS = [
  "not-a-defect",
  "not-caused-by-change",
  "already-handled",
  "wont-fix",
  "duplicate",
  "other",
] as const;
export type FindingDismissalReason = (typeof FINDING_DISMISSAL_REASONS)[number];

/**
 * A person's decision on one presented finding. The note is private content: it is never logged
 * and is exported only with an explicit content opt-in (ADR-0182 D7).
 */
export type FindingDecision =
  | { readonly decision: "accepted"; readonly note?: string }
  | {
      readonly decision: "dismissed";
      readonly reason: FindingDismissalReason;
      readonly note?: string;
    }
  | { readonly decision: "fixed"; readonly note?: string };

// ─── Model roles ─────────────────────────────────────────────────────────────

export const REVIEW_MODEL_ROLES = ["reviewer", "counter-checker"] as const;
export type ReviewModelRole = (typeof REVIEW_MODEL_ROLES)[number];

/** Gateway model ids bound to the two review roles (ADR-0182 D8). */
export interface ReviewModelPolicy {
  readonly reviewerModelId: string;
  readonly counterCheckerModelId: string;
}

/**
 * Measured state of a model pair. `collecting` while the live sample has fewer than 100 decided
 * findings, then `measured-passed` or `measured-failed` against the 50 % threshold.
 */
export const REVIEW_PAIR_STATUSES = [
  "unmeasured",
  "seed-qualified",
  "seed-failed",
  "collecting",
  "measured-passed",
  "measured-failed",
] as const;
export type ReviewPairStatus = (typeof REVIEW_PAIR_STATUSES)[number];

export const REVIEW_ROLE_INELIGIBILITY_REASONS = [
  "not-configured",
  "not-tool-capable",
  "tool-verification-stale",
  "window-unknown",
  "window-too-small",
  "not-coding-safe",
] as const;
export type ReviewRoleIneligibilityReason = (typeof REVIEW_ROLE_INELIGIBILITY_REASONS)[number];

/** Result of `evaluateReviewRoleEligibility`. A busy model stays eligible with a hint. */
export type ReviewRoleEligibility =
  | { readonly status: "eligible"; readonly hint?: "busy" }
  | { readonly status: "temporarily-unavailable" }
  | { readonly status: "ineligible"; readonly reason: ReviewRoleIneligibilityReason };

/** The context a review run needs from each role's model. */
export interface ReviewRoleBudget {
  readonly minContextWindowTokens: number;
}

// ─── Seed qualification ──────────────────────────────────────────────────────

/**
 * One synthetic seed case. A defect case expects a finding at `expected`; a clean control expects
 * none, and any finding on it is a false alarm.
 */
export type ReviewSeedCase =
  | {
      readonly id: string;
      readonly seedClass: ReviewFindingCategory;
      readonly required: boolean;
      readonly cleanControl: false;
      readonly expected: ReviewCodeLocation;
    }
  | {
      readonly id: string;
      readonly seedClass: ReviewFindingCategory;
      readonly required: false;
      readonly cleanControl: true;
    };

/**
 * One seed case with the change its review runs on: a case of the shipped synthetic corpus or a
 * Keiko consumer seed planted into a real file. The defect (or, for a clean control, the harmless
 * change) is the difference between `baseFiles` and `headFiles`. A `repository` fixture is the
 * whole tree; an `overlay` fixture holds only the planted files and applies over a checkout of the
 * consumer repository. Paths are repository-relative and use `/`.
 */
export interface ReviewSeedFixture {
  readonly seed: ReviewSeedCase;
  readonly scope: "repository" | "overlay";
  readonly baseFiles: Readonly<Record<string, string>>;
  readonly headFiles: Readonly<Record<string, string>>;
}

/** The presented findings of one seed case's review run. `stale` runs cannot count as found. */
export interface ReviewSeedRunResult {
  readonly caseId: string;
  readonly outcome: "settled" | "stale";
  readonly findings: readonly ReviewCodeLocation[];
}

export interface ReviewSeedScore {
  readonly defectCaseCount: number;
  readonly cleanControlCount: number;
  readonly found: number;
  readonly missed: number;
  readonly stale: number;
  readonly falseAlarms: number;
  readonly requiredCount: number;
  readonly requiredFound: number;
  /** Results whose case id matched no seed case, or repeated an earlier result. */
  readonly unmatchedResults: number;
}
