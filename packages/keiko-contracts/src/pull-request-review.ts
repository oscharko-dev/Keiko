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
/** Maximum length of a pull request target's display branch name (Git's own ref bound). */
export const REVIEW_DISPLAY_REF_MAX_CHARS = 255;
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
  /**
   * The branch names GitHub reports, as display data only: Keiko fetches `refs/pull/<n>/head` and
   * reviews the SHAs, so these are never Git arguments. Bounded, without control, bidi or
   * zero-width characters (a fork may name its branch anything Git accepts).
   */
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

// ─── Review target resolution and pull request reads (Issue #4133) ──────────

/** What a caller asks to review; the resolver turns it into a `ReviewTarget` with exact SHAs. */
export type ReviewTargetRequest =
  | { readonly kind: "pull-request"; readonly number: number }
  | { readonly kind: "local-range"; readonly baseRef: string; readonly headRef: string };

/** Closed reasons a target resolution is refused (`review.target.refused`). */
export const REVIEW_TARGET_REFUSAL_REASONS = [
  "gh-unavailable",
  "gh-unauthenticated",
  "no-github-remote",
  "not-found",
  "target-changed",
  "ref-invalid",
  "fetch-failed",
  "rate-limited",
] as const;
export type ReviewTargetRefusalReason = (typeof REVIEW_TARGET_REFUSAL_REASONS)[number];

/** Closed details of a refused review worktree; child 6 settles each as `skipped/worktree-failed`. */
export const REVIEW_WORKTREE_REFUSAL_REASONS = [
  "tree-too-large",
  "cancelled",
  "case-collision",
  "normalization-collision",
  "checkout-failed",
  "disk-full",
  "timeout",
] as const;
export type ReviewWorktreeRefusalReason = (typeof REVIEW_WORKTREE_REFUSAL_REASONS)[number];

export const REVIEW_WORKTREE_STATES = [
  "created",
  "in-use",
  "removing",
  "removed",
  "orphaned",
] as const;
export type ReviewWorktreeState = (typeof REVIEW_WORKTREE_STATES)[number];

/** Files above this size are not materialized in a review worktree (reported as `too-large`). */
export const REVIEW_WORKTREE_DEFAULT_BLOB_LIMIT_BYTES = 2 * 1024 * 1024;
/**
 * A head whose tree lists more paths, or whose blobs within the per-file limit sum to more bytes,
 * is refused as `tree-too-large` before anything is written: a few kilobytes of reused subtrees
 * would otherwise check out gigabytes.
 */
export const REVIEW_WORKTREE_MAX_PATHS = 100_000;
export const REVIEW_WORKTREE_MAX_MATERIALIZED_BYTES = 512 * 1024 * 1024;
/** Private review refs older than this are swept regardless of run references. */
export const REVIEW_PRIVATE_REF_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const REVIEW_PULL_REQUESTS_ROUTE = "/api/git-review/pull-requests";
export const REVIEW_PULL_REQUEST_ROUTE = "/api/git-review/pull-requests/:number";
export const REVIEW_PULL_REQUEST_PAGE_SIZE = 50;
export const REVIEW_PULL_REQUEST_MAX_PAGES = 20;
export const REVIEW_PULL_REQUEST_TITLE_MAX_CHARS = 256;

/** Closed availability of the read-only pull request list and detail. */
export const REVIEW_PULL_REQUEST_AVAILABILITY = [
  "available",
  "gh-unavailable",
  "gh-unauthenticated",
  "no-github-remote",
  "rate-limited",
  "failed",
] as const;
export type ReviewPullRequestAvailability = (typeof REVIEW_PULL_REQUEST_AVAILABILITY)[number];

export const REVIEW_PULL_REQUEST_REVIEW_DECISIONS = [
  "approved",
  "changes-requested",
  "review-required",
  "none",
] as const;
export type ReviewPullRequestReviewDecision = (typeof REVIEW_PULL_REQUEST_REVIEW_DECISIONS)[number];

export const REVIEW_PULL_REQUEST_MERGEABLE_STATES = [
  "mergeable",
  "conflicting",
  "unknown",
] as const;
export type ReviewPullRequestMergeableState = (typeof REVIEW_PULL_REQUEST_MERGEABLE_STATES)[number];

export const REVIEW_PULL_REQUEST_CHECK_STATES = [
  "success",
  "failure",
  "pending",
  "error",
  "none",
] as const;
export type ReviewPullRequestCheckState = (typeof REVIEW_PULL_REQUEST_CHECK_STATES)[number];

/**
 * One open pull request as the Pull requests area lists it. `title` and `authorLogin` are
 * untrusted display data, bounded and stripped of control characters; the body is never fetched.
 */
export interface ReviewPullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly authorLogin: string | null;
  readonly isDraft: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly headRef: string;
  readonly headSha: string;
  /** `owner/name` of the head repository, or `null` when the fork was deleted. */
  readonly headRepository: string | null;
  readonly isCrossRepository: boolean;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly reviewDecision: ReviewPullRequestReviewDecision;
  readonly mergeable: ReviewPullRequestMergeableState;
  readonly checkState: ReviewPullRequestCheckState;
}

export interface ReviewPullRequestDetail extends ReviewPullRequestSummary {
  readonly checkCounts: {
    readonly passing: number;
    readonly failing: number;
    readonly pending: number;
  };
  readonly approvalCount: number;
}

export interface ReviewPullRequestListResponse {
  readonly schemaVersion: typeof REVIEW_CONTRACT_VERSION;
  readonly availability: ReviewPullRequestAvailability;
  readonly pullRequests: readonly ReviewPullRequestSummary[];
  /** More open pull requests exist than the 20-page bound returned. */
  readonly truncated: boolean;
}

export interface ReviewPullRequestDetailResponse {
  readonly schemaVersion: typeof REVIEW_CONTRACT_VERSION;
  readonly availability: ReviewPullRequestAvailability;
  /** `null` when unavailable or when the repository has no such open or closed pull request. */
  readonly pullRequest: ReviewPullRequestDetail | null;
}

// ─── Review diff package (Issue #4134) ───────────────────────────────────────

/**
 * PR-Agent v0.49.0 packaging defaults (`patch_extra_lines_before`, `patch_extra_lines_after`,
 * `max_extra_lines_before_dynamic_context`): every included hunk carries this many unchanged
 * lines before and after its changes, and is extended upward to its enclosing function or class
 * header when that header lies within the dynamic window. Child 8 measurement may change them.
 */
export const REVIEW_DIFF_CONTEXT_LINES_BEFORE = 5;
export const REVIEW_DIFF_CONTEXT_LINES_AFTER = 1;
export const REVIEW_DIFF_DYNAMIC_CONTEXT_MAX_LINES = 10;
/** PR-Agent's own cap on configured context lines (`MAX_EXTRA_LINES`). */
export const REVIEW_DIFF_CONTEXT_LINES_MAX = 10;
/** More changed paths than this fail the package closed as `diff-too-large`. */
export const REVIEW_DIFF_MAX_CHANGED_FILES = 20_000;
/** A file with more changed lines than this is never packaged (`unprocessed/too-large`). */
export const REVIEW_DIFF_FILE_MAX_CHANGED_LINES = 20_000;
/** A file whose context patch exceeds this many bytes is never packaged (`unprocessed/too-large`). */
export const REVIEW_DIFF_FILE_MAX_PATCH_BYTES = 4 * 1024 * 1024;
/** Patch bytes read for the whole package; exceeding them fails it closed as `diff-too-large`. */
export const REVIEW_DIFF_MAX_TOTAL_PATCH_BYTES = 64 * 1024 * 1024;
/** The whole packaging, every Git process included, ends by this deadline unless configured. */
export const REVIEW_DIFF_DEFAULT_DEADLINE_MS = 5 * 60 * 1000;

/** Languages the package recognizes by file name; `other` covers every unrecognized name. */
export const REVIEW_DIFF_LANGUAGES = [
  "typescript",
  "javascript",
  "python",
  "java",
  "go",
  "csharp",
  "kotlin",
  "rust",
  "c",
  "cpp",
  "ruby",
  "php",
  "swift",
  "scala",
  "shell",
  "css",
  "html",
  "markdown",
  "json",
  "yaml",
  "sql",
  "xml",
  "other",
] as const;
export type ReviewDiffLanguage = (typeof REVIEW_DIFF_LANGUAGES)[number];

/** How Git reports a changed path between the base and the head commit. */
export const REVIEW_DIFF_FILE_STATUSES = [
  "added",
  "modified",
  "deleted",
  "renamed",
  "type-changed",
] as const;
export type ReviewDiffFileStatus = (typeof REVIEW_DIFF_FILE_STATUSES)[number];

/** Why a reviewable changed file was not (completely) packaged. Each one makes a run incomplete. */
export const REVIEW_DIFF_UNPROCESSED_REASONS = ["budget", "too-large", "timeout"] as const;
export type ReviewDiffUnprocessedReason = (typeof REVIEW_DIFF_UNPROCESSED_REASONS)[number];

/** Why a changed file was deliberately left out of the review. */
export const REVIEW_DIFF_FILTER_REASONS = [
  "generated",
  "lockfile",
  "vendored",
  "minified",
  "review-config-excluded",
] as const;
export type ReviewDiffFilterReason = (typeof REVIEW_DIFF_FILTER_REASONS)[number];

/** Every coverage list. Each changed path appears in exactly one of them. */
export const REVIEW_DIFF_COVERAGE_LISTS = [
  "included",
  "unprocessed",
  "deletedOnly",
  "filtered",
  "binary",
  "submodule",
  "symlink",
  "modeOnly",
] as const;
export type ReviewDiffCoverageList = (typeof REVIEW_DIFF_COVERAGE_LISTS)[number];

/**
 * One changed path, reported verbatim. `path` is the head path (the base path for a deletion) as
 * Git stores it when its bytes are valid UTF-8, without normalization: newlines, tabs, quotes,
 * leading dashes, `..` segments and decomposed Unicode stay exactly as they are. A name whose
 * bytes are not UTF-8 has a display `path` (invalid bytes become U+FFFD) and its exact bytes in
 * `pathBytesBase64`, so two such names never collapse into one entry. Paths are local product
 * data: they never enter the Activity Log.
 */
export interface ReviewDiffFileRef {
  readonly path: string;
  readonly pathBytesBase64?: string;
  /** The base path of a rename. */
  readonly previousPath?: string;
  readonly previousPathBytesBase64?: string;
  readonly status: ReviewDiffFileStatus;
  readonly language: ReviewDiffLanguage;
  /** Lines Git counts as added and removed; zero for binary, oversized and gitlink entries. */
  readonly addedLines: number;
  readonly removedLines: number;
}

/** A packaged file. `partial` files lost trailing hunks to the budget and make a run incomplete. */
export interface ReviewDiffIncludedFile extends ReviewDiffFileRef {
  readonly hunkCount: number;
  readonly includedHunkCount: number;
  readonly partial: boolean;
}

export interface ReviewDiffUnprocessedFile extends ReviewDiffFileRef {
  readonly reason: ReviewDiffUnprocessedReason;
}

export interface ReviewDiffFilteredFile extends ReviewDiffFileRef {
  readonly reason: ReviewDiffFilterReason;
}

export interface ReviewDiffCoverageSummary {
  readonly changedFiles: number;
  /** Included completely. */
  readonly reviewedFiles: number;
  /** Included with some hunks left out by the budget. */
  readonly partiallyReviewedFiles: number;
  readonly unprocessedFiles: number;
  readonly addedLines: number;
  readonly removedLines: number;
  readonly budgetTokens: number;
  /** The included content's token count as the gateway's estimator measures it. */
  readonly usedTokens: number;
}

/** What the package reviewed and what it did not, with closed reason codes (ADR-0182 D6). */
export interface ReviewDiffCoverage {
  readonly included: readonly ReviewDiffIncludedFile[];
  readonly unprocessed: readonly ReviewDiffUnprocessedFile[];
  readonly deletedOnly: readonly ReviewDiffFileRef[];
  readonly filtered: readonly ReviewDiffFilteredFile[];
  readonly binary: readonly ReviewDiffFileRef[];
  readonly submodule: readonly ReviewDiffFileRef[];
  readonly symlink: readonly ReviewDiffFileRef[];
  readonly modeOnly: readonly ReviewDiffFileRef[];
  readonly summary: ReviewDiffCoverageSummary;
}

/**
 * Why no package was returned. `diff-too-large` covers every exceeded time or byte bound, so an
 * oversized change set never returns a partial package presented as complete.
 */
export const REVIEW_DIFF_PACKAGE_FAILURE_REASONS = [
  "diff-too-large",
  "cancelled",
  "git-failed",
] as const;
export type ReviewDiffPackageFailureReason = (typeof REVIEW_DIFF_PACKAGE_FAILURE_REASONS)[number];

/** The bound a `diff-too-large` failure exceeded; closed and body-free. */
export const REVIEW_DIFF_TOO_LARGE_DETAILS = [
  "changed-files",
  "listing-bytes",
  "patch-bytes",
  "deadline",
] as const;
export type ReviewDiffTooLargeDetail = (typeof REVIEW_DIFF_TOO_LARGE_DETAILS)[number];

export type ReviewDiffPackageFailure =
  | { readonly reason: "diff-too-large"; readonly detail: ReviewDiffTooLargeDetail }
  | { readonly reason: "cancelled" }
  | { readonly reason: "git-failed" };

/**
 * What a diff package means for the run's settlement (child 6): `reviewable` lets the run proceed
 * and settle `complete` if nothing else fails; the others settle it on their own.
 */
export type ReviewDiffSettlementInput =
  | { readonly kind: "reviewable" }
  | Extract<ReviewRunSettlement, { readonly kind: "incomplete" | "skipped" | "abandoned" }>;
