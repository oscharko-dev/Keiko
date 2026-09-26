// Governed GitHub pull request orchestration contracts (Issue #477, Epic #470; ADR-0064). Ownership:
// the provider-neutral, content-free PR-orchestration leaf — the readiness model, the deterministic
// metadata-synthesis heuristics, the reviewer/label/linkage suggestion shapes, and the provider-failure
// rejection taxonomy. It is the PR counterpart of git-commit-intent.ts (deterministic composition) and
// git-delivery-action-sheet.ts (content-free projection), and it sits on top of the existing PR input
// shapes, provider-state interfaces, execution-error codes, and recovery-disposition vocabulary.
//
// Disjoint from git-delivery.ts (the action/risk model), git-delivery-provider.ts (provider-neutral
// state), git-delivery-evidence.ts (the audit record), and git-delivery-action-sheet.ts (the approval
// surface). The GitHub-specific transport, the raw-error classifier, and the actual PR title/body
// strings are keiko-tools concerns; this leaf never imports a kernel type and never carries raw content.
//
// Leaf-package rules (ADR-0019, ADR-0058, ADR-0064): pure types, frozen const tables, and pure
// functions only. No IO, no clock, no crypto, no randomness, no provider field names. Relative imports
// end in ".js" and reference only sibling git-delivery*.ts leaves.
//
// Content-free by construction: the synthesizer's INPUTS are counts, coarse area tokens, typed enums,
// and branch names — never raw diff content, file paths, or commit message bodies. The composed
// title/body DRAFT it returns is user-editable and is NEVER persisted to evidence (evidence carries only
// the titleByteLength / bodyByteLength already defined on the GitDeliveryPr*Inputs).

import type {
  GitDeliveryExecutionErrorCode,
  GitDeliveryParseResult,
  GitDeliveryRiskClass,
} from "./git-delivery.js";
import type { GitDeliveryRecoveryDisposition } from "./git-delivery-evidence.js";
import type {
  GitDeliveryChecksState,
  GitDeliveryMergeReadiness,
  GitDeliveryPullRequestState,
} from "./git-delivery-provider.js";

// Pinned schema version. A breaking change adds a NEW literal member; this one is never mutated.
export const GIT_PULL_REQUEST_SCHEMA_VERSION = "1" as const;

export {
  isGitPullRequestIdentity,
  type GitPullRequestIdentity,
} from "./git-pull-request-identity.js";

// ─── Change type (input to metadata synthesis) ──────────────────────────────────────────────────────

export type GitPrChangeType = "feat" | "fix" | "refactor" | "docs" | "chore" | "test" | "mixed";

export const GIT_PR_CHANGE_TYPES: readonly GitPrChangeType[] = [
  "feat",
  "fix",
  "refactor",
  "docs",
  "chore",
  "test",
  "mixed",
] as const;

// ─── Content-free change narrative + risk digest (synthesizer inputs) ───────────────────────────────
// `areas` are distinct top-level path-segment tokens (low-sensitivity structural labels), bounded by the
// producer in keiko-tools. Never raw file paths, never diff content.

export interface GitPullRequestChangeNarrative {
  readonly commitCount: number;
  readonly fileCount: number;
  readonly areaCount: number;
  readonly areas: readonly string[];
  readonly touchesTests: boolean;
  readonly changeType: GitPrChangeType;
}

export type GitPrPolicyOutcome = "allowed" | "blocked" | "approval-gated" | "constrained";

export const GIT_PR_POLICY_OUTCOMES: readonly GitPrPolicyOutcome[] = [
  "allowed",
  "blocked",
  "approval-gated",
  "constrained",
] as const;

export interface GitPullRequestRiskDigest {
  readonly riskClass: GitDeliveryRiskClass;
  readonly riskSeverity: number;
  readonly policyOutcome: GitPrPolicyOutcome;
  readonly isDraft: boolean;
}

// ─── Metadata draft (deterministic, user-editable; never persisted to evidence) ─────────────────────
// Each body section is a typed record (not a free string). The composedTitle and riskNarrative are
// deterministic projections of enums + counts + branch names, NOT raw content.

export interface GitPrSummarySection {
  readonly changeType: GitPrChangeType;
  readonly commitCount: number;
  readonly fileCount: number;
  readonly areaCount: number;
  readonly primaryArea?: string | undefined;
}

export interface GitPrRiskSection {
  readonly riskClass: GitDeliveryRiskClass;
  readonly policyOutcome: GitPrPolicyOutcome;
  readonly requiresApproval: boolean;
}

export interface GitPrChangeNarrativeSection {
  readonly touchesTests: boolean;
  readonly areas: readonly string[];
  readonly changeType: GitPrChangeType;
}

export interface GitPullRequestMetadataDraft {
  readonly schemaVersion: typeof GIT_PULL_REQUEST_SCHEMA_VERSION;
  readonly composedTitle: string;
  readonly summarySection: GitPrSummarySection;
  readonly riskSection: GitPrRiskSection;
  readonly changeNarrativeSection: GitPrChangeNarrativeSection;
  readonly riskNarrative: string;
}

// ─── Readiness model (AC3 — object-exists vs review-ready, with severity-ranked blockers) ───────────

export type GitPullRequestReadinessBlockerCode =
  | "head-unpublished"
  | "base-missing"
  | "head-equals-base"
  | "draft-pr"
  | "required-checks-failing"
  | "checks-pending"
  | "approval-insufficient"
  | "merge-conflict"
  | "provider-error";

export const GIT_PR_READINESS_BLOCKER_CODES: readonly GitPullRequestReadinessBlockerCode[] = [
  "head-unpublished",
  "base-missing",
  "head-equals-base",
  "draft-pr",
  "required-checks-failing",
  "checks-pending",
  "approval-insufficient",
  "merge-conflict",
  "provider-error",
] as const;

export type GitPrBlockerSeverity = "blocking" | "advisory";
export type GitPrRemediationClass = "user-actionable" | "internal";

export interface GitPullRequestReadinessBlocker {
  readonly code: GitPullRequestReadinessBlockerCode;
  readonly severity: GitPrBlockerSeverity;
  readonly remediation: GitPrRemediationClass;
}

export interface GitPullRequestReadinessSummary {
  readonly schemaVersion: typeof GIT_PULL_REQUEST_SCHEMA_VERSION;
  // Whether the PR remote object has been confirmed to exist on the provider (NOT derived from the
  // local worktree). False at create-preview time, true once a provider PR state is supplied.
  readonly objectExists: boolean;
  // Whether the PR is in a non-draft, non-conflict, non-error state appropriate to request review on.
  readonly reviewReady: boolean;
  // Severity-ranked: every "blocking" entry precedes every "advisory" entry.
  readonly blockers: readonly GitPullRequestReadinessBlocker[];
}

// ─── Draft-vs-ready recommendation ──────────────────────────────────────────────────────────────────

// "keep-as-is" is the no-op outcome for a PR that already exists, is already ready for review, and
// has nothing outstanding. Without it the derivation had to reuse "update-to-ready" for that case,
// which is what made the recommendation meaningless for the PRs it was supposed to serve.
export type GitPullRequestRecommendation =
  | "create-as-draft"
  | "create-as-ready"
  | "update-to-ready"
  | "keep-as-draft"
  | "keep-as-is"
  | "blocked";

export const GIT_PR_RECOMMENDATIONS: readonly GitPullRequestRecommendation[] = [
  "create-as-draft",
  "create-as-ready",
  "update-to-ready",
  "keep-as-draft",
  "keep-as-is",
  "blocked",
] as const;

// ─── Reviewer / label / linkage suggestions ─────────────────────────────────────────────────────────

export type GitPrReviewerSuggestionBasis = "area-ownership" | "none";
export type GitPrLabelSuggestionBasis = "change-type" | "area" | "none";
export type GitPrLinkageSuggestionBasis = "branch-name" | "none";

export interface GitPullRequestReviewerSuggestion {
  readonly suggestedReviewerIds: readonly string[];
  readonly basis: GitPrReviewerSuggestionBasis;
}

export interface GitPullRequestLabelSuggestion {
  readonly suggestedLabelNames: readonly string[];
  readonly basis: GitPrLabelSuggestionBasis;
}

export interface GitPullRequestLinkageSuggestion {
  readonly suggestedIssueRefs: readonly string[];
  readonly basis: GitPrLinkageSuggestionBasis;
}

// ─── Provider-failure rejection taxonomy (AC4 — neutral enum; classifier lives in keiko-tools) ──────

export type GitPullRequestRejectionReason =
  | "already-exists"
  | "base-missing"
  | "head-unpublished"
  | "validation-error"
  | "permission-denied"
  | "not-found"
  | "rate-limited"
  | "provider-unavailable"
  | "unknown";

export const GIT_PR_REJECTION_REASONS: readonly GitPullRequestRejectionReason[] = [
  "already-exists",
  "base-missing",
  "head-unpublished",
  "validation-error",
  "permission-denied",
  "not-found",
  "rate-limited",
  "provider-unavailable",
  "unknown",
] as const;

// Exhaustive reason → content-free execution error code (recorded in evidence). Total Record (not
// Partial): a new reason is a compile error here rather than a silent gap.
export const GIT_PR_REJECTION_ERROR_CODE: Readonly<
  Record<GitPullRequestRejectionReason, GitDeliveryExecutionErrorCode>
> = {
  "already-exists": "precondition-failed",
  "base-missing": "precondition-failed",
  "head-unpublished": "precondition-failed",
  "validation-error": "provider-rejected",
  "permission-denied": "provider-rejected",
  "not-found": "provider-rejected",
  "rate-limited": "network-failure",
  "provider-unavailable": "network-failure",
  unknown: "provider-rejected",
} as const;

// Exhaustive reason → three-way recovery disposition (reused #474 vocabulary).
export const GIT_PR_REJECTION_DISPOSITION: Readonly<
  Record<GitPullRequestRejectionReason, GitDeliveryRecoveryDisposition>
> = {
  "already-exists": "user-fixable",
  "base-missing": "user-fixable",
  "head-unpublished": "user-fixable",
  "validation-error": "user-fixable",
  "permission-denied": "user-fixable",
  "not-found": "user-fixable",
  "rate-limited": "retryable",
  "provider-unavailable": "retryable",
  unknown: "user-fixable",
} as const;

export function gitPrRejectionToErrorCode(
  reason: GitPullRequestRejectionReason,
): GitDeliveryExecutionErrorCode {
  return GIT_PR_REJECTION_ERROR_CODE[reason];
}

export function gitPrRejectionToDisposition(
  reason: GitPullRequestRejectionReason,
): GitDeliveryRecoveryDisposition {
  return GIT_PR_REJECTION_DISPOSITION[reason];
}

// ─── Private predicate helpers ──────────────────────────────────────────────────────────────────────

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInSet<T extends string>(set: readonly T[]): (v: unknown) => v is T {
  return (v: unknown): v is T => isString(v) && (set as readonly string[]).includes(v);
}

// ─── Exported enum guards ─────────────────────────────────────────────────────────────────────────

export const isGitPrChangeType = isInSet(GIT_PR_CHANGE_TYPES);
export const isGitPrPolicyOutcome = isInSet(GIT_PR_POLICY_OUTCOMES);
export const isGitPullRequestReadinessBlockerCode = isInSet(GIT_PR_READINESS_BLOCKER_CODES);
export const isGitPullRequestRecommendation = isInSet(GIT_PR_RECOMMENDATIONS);
export const isGitPullRequestRejectionReason = isInSet(GIT_PR_REJECTION_REASONS);

// ─── Metadata synthesis (PURE, deterministic) ───────────────────────────────────────────────────────
// Title = `type(scope): <humanised head-branch slug>`, clamped to ≤ 72 code units. The slug strips the
// branch namespace prefix and a leading `issue-<n>` token, then turns dashes into spaces. All inputs are
// counts, enums, area tokens, and branch names — no raw content.

const TITLE_MAX = 72;

function primaryAreaOf(narrative: GitPullRequestChangeNarrative): string | undefined {
  const first = narrative.areas[0];
  return narrative.areaCount === 1 && first !== undefined && first.length > 0 ? first : undefined;
}

function humaniseBranchSlug(headBranch: string): string {
  const segments = headBranch.split("/");
  const tail = segments.at(-1) ?? headBranch;
  const tokens = tail.split("-").filter((t) => t.length > 0);
  // Drop a leading run of `issue` markers and pure-numeric issue numbers (e.g. "issue-477-…",
  // "1234-…"), keeping only the descriptive remainder of the slug.
  let start = 0;
  while (start < tokens.length) {
    const token = (tokens[start] ?? "").toLowerCase();
    if (token === "issue" || /^\d+$/.test(token)) {
      start += 1;
    } else {
      break;
    }
  }
  return tokens.slice(start).join(" ").trim();
}

// KEIKO-0829: keep the 72-UTF-16-unit contract (TITLE_MAX is a code-unit budget, matching
// GitHub's own PR-title length count). `String.prototype.slice(0, N)` cuts on UTF-16 code units
// and can split a surrogate pair, producing a lone surrogate — back off one unit when the cut
// falls between a high and low surrogate so a two-code-unit astral character is either kept
// whole or dropped whole, never bisected. Pinned by both a lone-surrogate regression and an
// astral-input regression asserting `.length <= TITLE_MAX`.
//
// `codePointAt` here is used strictly for the surrogate-half detection at the cut boundary — a
// high surrogate (0xD800–0xDBFF) as an ISOLATED unit reads back as itself even from
// `codePointAt`, which is exactly what we need. We only look at one code unit; there is no
// astral-value shift to consider.
function clampTitle(title: string): string {
  if (title.length <= TITLE_MAX) return title;
  let cut = TITLE_MAX;
  const boundary = title.codePointAt(cut - 1) ?? 0;
  if (boundary >= 0xd800 && boundary <= 0xdbff) cut -= 1;
  return title.slice(0, cut).trimEnd();
}

function composeTitle(narrative: GitPullRequestChangeNarrative, headBranch: string): string {
  const scope = primaryAreaOf(narrative);
  const prefix = scope !== undefined ? `${narrative.changeType}(${scope})` : narrative.changeType;
  const slug = humaniseBranchSlug(headBranch);
  const clause = slug.length > 0 ? slug : `update ${String(narrative.fileCount)} file(s)`;
  return clampTitle(`${prefix}: ${clause}`);
}

function composeRiskNarrative(
  narrative: GitPullRequestChangeNarrative,
  riskDigest: GitPullRequestRiskDigest,
): string {
  const testClause = narrative.touchesTests ? ", including test changes" : "";
  return (
    `This change is classified ${riskDigest.riskClass} (severity ${String(riskDigest.riskSeverity)}); ` +
    `policy outcome ${riskDigest.policyOutcome}. It spans ${String(narrative.fileCount)} file(s) across ` +
    `${String(narrative.areaCount)} area(s) over ${String(narrative.commitCount)} commit(s)${testClause}.`
  );
}

// KEIKO-0829: the trailing `_baseBranch` parameter was never read — every consumer already
// carries the base branch on GitPullRequestChangeNarrative when the narrative surface needs it.
// Dropped from the signature so callers do not pass a value that is discarded on the wire.
export function synthesizePullRequestMetadata(
  narrative: GitPullRequestChangeNarrative,
  riskDigest: GitPullRequestRiskDigest,
  headBranch: string,
): GitPullRequestMetadataDraft {
  const primaryArea = primaryAreaOf(narrative);
  const summarySection: GitPrSummarySection = {
    changeType: narrative.changeType,
    commitCount: narrative.commitCount,
    fileCount: narrative.fileCount,
    areaCount: narrative.areaCount,
    ...(primaryArea !== undefined ? { primaryArea } : {}),
  };
  return {
    schemaVersion: GIT_PULL_REQUEST_SCHEMA_VERSION,
    composedTitle: composeTitle(narrative, headBranch),
    summarySection,
    riskSection: {
      riskClass: riskDigest.riskClass,
      policyOutcome: riskDigest.policyOutcome,
      requiresApproval: riskDigest.policyOutcome === "approval-gated",
    },
    changeNarrativeSection: {
      touchesTests: narrative.touchesTests,
      areas: narrative.areas,
      changeType: narrative.changeType,
    },
    riskNarrative: composeRiskNarrative(narrative, riskDigest),
  };
}

// ─── Readiness derivation (PURE) ────────────────────────────────────────────────────────────────────
// Provider facts are gathered by the server (GitDeliveryPullRequestState / GitDeliveryChecksState /
// GitDeliveryMergeReadiness) and passed in; this leaf performs only the pure derivation. No network.

export interface GitPullRequestReadinessInput {
  readonly headBranchName: string;
  readonly baseBranchName: string;
  // Whether the head branch is published to the remote (a PR cannot be opened from an unpublished head).
  readonly headPublished: boolean;
  // Whether the base branch is known to exist on the remote.
  readonly baseExists: boolean;
  readonly pullRequest?: GitDeliveryPullRequestState | undefined;
  readonly checks?: GitDeliveryChecksState | undefined;
  readonly mergeReadiness?: GitDeliveryMergeReadiness | undefined;
  // Set by the server when a provider read/operation failed.
  readonly providerError?: boolean | undefined;
}

function blocking(code: GitPullRequestReadinessBlockerCode): GitPullRequestReadinessBlocker {
  return { code, severity: "blocking", remediation: "user-actionable" };
}

function advisory(
  code: GitPullRequestReadinessBlockerCode,
  remediation: GitPrRemediationClass,
): GitPullRequestReadinessBlocker {
  return { code, severity: "advisory", remediation };
}

function collectBlockingBlockers(
  input: GitPullRequestReadinessInput,
): readonly GitPullRequestReadinessBlocker[] {
  const out: GitPullRequestReadinessBlocker[] = [];
  if (input.headBranchName === input.baseBranchName) {
    out.push(blocking("head-equals-base"));
  }
  if (!input.headPublished) {
    out.push(blocking("head-unpublished"));
  }
  if (!input.baseExists) {
    out.push(blocking("base-missing"));
  }
  if (input.checks?.overallStatus === "failing") {
    out.push(blocking("required-checks-failing"));
  }
  if (input.mergeReadiness?.blockingReason === "conflicts") {
    out.push(blocking("merge-conflict"));
  }
  if (input.providerError === true) {
    out.push({ code: "provider-error", severity: "blocking", remediation: "internal" });
  }
  return out;
}

function collectAdvisoryBlockers(
  input: GitPullRequestReadinessInput,
): readonly GitPullRequestReadinessBlocker[] {
  const out: GitPullRequestReadinessBlocker[] = [];
  if (input.pullRequest?.isDraft === true) {
    out.push(advisory("draft-pr", "user-actionable"));
  }
  if (input.checks?.overallStatus === "pending") {
    out.push(advisory("checks-pending", "internal"));
  }
  if (input.mergeReadiness?.blockingReason === "approvals-missing") {
    out.push(advisory("approval-insufficient", "user-actionable"));
  }
  return out;
}

export function gitPullRequestReadinessFor(
  input: GitPullRequestReadinessInput,
): GitPullRequestReadinessSummary {
  const blockingBlockers = collectBlockingBlockers(input);
  const advisoryBlockers = collectAdvisoryBlockers(input);
  const blockers = [...blockingBlockers, ...advisoryBlockers];
  const objectExists = input.pullRequest !== undefined;
  const isDraft = input.pullRequest?.isDraft === true;
  const reviewReady = objectExists && !isDraft && blockingBlockers.length === 0;
  return {
    schemaVersion: GIT_PULL_REQUEST_SCHEMA_VERSION,
    objectExists,
    reviewReady,
    blockers,
  };
}

// ─── Recommendation derivation (PURE) ───────────────────────────────────────────────────────────────

export function gitPullRequestRecommendationFor(
  readiness: GitPullRequestReadinessSummary,
  riskDigest: GitPullRequestRiskDigest,
): GitPullRequestRecommendation {
  const hasBlocking = readiness.blockers.some((b) => b.severity === "blocking");
  if (hasBlocking) {
    return "blocked";
  }
  if (!readiness.objectExists) {
    return riskDigest.isDraft ? "create-as-draft" : "create-as-ready";
  }
  // The PR exists and has no blocking blockers. Its OWN draftness is recorded as the `draft-pr`
  // advisory, so counting the raw blocker list inverted both draft-lifecycle recommendations:
  // every clean draft was told to stay a draft, and every already-ready PR got a no-op
  // `update-to-ready`. Draftness is read from `reviewReady` instead — on this branch (PR exists, no
  // blocking blockers) it is exactly `!isDraft` by its own definition above, so no re-derivation
  // from the blockers array and no wire-shape change is needed.
  if (readiness.reviewReady) {
    return "keep-as-is";
  }
  // Genuine advisories (pending checks, missing approvals) counsel keeping the draft; a draft with
  // nothing else outstanding is the one PR the promotion to ready-for-review can apply to.
  const otherAdvisories = readiness.blockers.filter((b) => b.code !== "draft-pr");
  return otherAdvisories.length > 0 ? "keep-as-draft" : "update-to-ready";
}

// ─── Suggestion derivations (PURE, deterministic) ───────────────────────────────────────────────────

const LABEL_BY_CHANGE_TYPE: Readonly<Record<GitPrChangeType, string>> = {
  feat: "enhancement",
  fix: "bug",
  refactor: "refactor",
  docs: "documentation",
  chore: "chore",
  test: "test",
  mixed: "enhancement",
} as const;

// Optional area→owners map (e.g. derived server-side from CODEOWNERS). Absent ⇒ no reviewer derivation.
export function gitPullRequestReviewerSuggestionsFor(
  narrative: GitPullRequestChangeNarrative,
  areaOwners?: Readonly<Record<string, readonly string[]>>,
): GitPullRequestReviewerSuggestion {
  if (areaOwners === undefined) {
    return { suggestedReviewerIds: [], basis: "none" };
  }
  const ids = new Set<string>();
  for (const area of narrative.areas) {
    for (const owner of areaOwners[area] ?? []) {
      ids.add(owner);
    }
  }
  return ids.size > 0
    ? { suggestedReviewerIds: [...ids], basis: "area-ownership" }
    : { suggestedReviewerIds: [], basis: "none" };
}

export function gitPullRequestLabelSuggestionsFor(
  narrative: GitPullRequestChangeNarrative,
): GitPullRequestLabelSuggestion {
  const areaLabels = narrative.areas
    .filter((area) => area.length > 0)
    .map((area) => `area:${area}`);
  const changeTypeLabel = LABEL_BY_CHANGE_TYPE[narrative.changeType];
  const includeChangeType = typeof changeTypeLabel === "string" && changeTypeLabel.length > 0;
  const suggestedLabelNames = [
    ...new Set([...(includeChangeType ? [changeTypeLabel] : []), ...areaLabels]),
  ];
  // KEIKO-0829: the previous implementation hard-coded "change-type" regardless of what was
  // actually produced, so the "area" and "none" basis members were unreachable. Derive from
  // what LABEL_BY_CHANGE_TYPE actually returned: unknown-future changeType → "" (unmapped) so
  // basis falls to "area" (if any) or "none" (if the narrative also had no area).
  const basis: GitPrLabelSuggestionBasis = deriveLabelBasis(includeChangeType, areaLabels.length);
  return { suggestedLabelNames, basis };
}

function deriveLabelBasis(
  includeChangeType: boolean,
  areaLabelCount: number,
): GitPrLabelSuggestionBasis {
  if (includeChangeType) return "change-type";
  if (areaLabelCount > 0) return "area";
  return "none";
}

// Extracts issue-ref tokens from the head branch name only (e.g. "claude/issue-477-..." → "#477",
// "fix/1234-..." → "#1234"). Deterministic; never scans commit bodies in this leaf.
//
// A digit run only counts when it is a token in its own right: either behind an explicit
// `issue-`/`issue/` marker, or starting a segment (string start, `/`, `_`, `-`) and ending at one
// (string end, `/`, `_`, `-`). Without those boundaries every digit run in a branch name became an
// issue ref — "feat/v2-api" suggested #2, "fix/utf8-bug" suggested #8 — and a run longer than the
// cap was truncated into a DIFFERENT issue plus a stray ref ("12345678" → #1234567 and #8). These
// refs reach the PR preview, where a consumer rendering them as closing keywords would close
// unrelated issues on merge. A run longer than the cap now matches nothing rather than truncating.
// Only server-owned creation from a frozen issue binding may add a closing directive (#3387);
// these branch-inferred suggestions remain advisory Refs under ADR-0086 D9.
const BRANCH_ISSUE_RE = /(?:^|[/_-])(?:issue[-/])?(\d{1,7})(?=$|[/_-])/gi;

export function gitPullRequestLinkageSuggestionsFor(
  headBranch: string,
): GitPullRequestLinkageSuggestion {
  const refs = new Set<string>();
  for (const match of headBranch.matchAll(BRANCH_ISSUE_RE)) {
    const digits = match[1];
    if (digits !== undefined) {
      refs.add(`#${digits}`);
    }
  }
  return refs.size > 0
    ? { suggestedIssueRefs: [...refs], basis: "branch-name" }
    : { suggestedIssueRefs: [], basis: "none" };
}

// ─── Structural guards ──────────────────────────────────────────────────────────────────────────────

export function isGitPullRequestReadinessBlocker(
  value: unknown,
): value is GitPullRequestReadinessBlocker {
  return (
    isRecord(value) &&
    isGitPullRequestReadinessBlockerCode(value.code) &&
    (value.severity === "blocking" || value.severity === "advisory") &&
    (value.remediation === "user-actionable" || value.remediation === "internal")
  );
}

function isBlockerArray(value: unknown): value is readonly GitPullRequestReadinessBlocker[] {
  return Array.isArray(value) && value.every(isGitPullRequestReadinessBlocker);
}

function hasBlockingBlocker(blockers: readonly GitPullRequestReadinessBlocker[]): boolean {
  return blockers.some((blocker) => blocker.severity === "blocking");
}

// Every code collectAdvisoryBlockers ever constructs via advisory(...) — kept immediately beside
// that function so the two cannot silently drift. Every other blocker code is only ever
// constructed via blocking(...), and (unlike git-merge.ts's dual-purpose "checks-failing") the two
// producers' code sets are fully disjoint here. hasBlockingBlocker above trusts the SUPPLIED
// severity, so a payload could relabel a code that is always blocking in practice (e.g.
// "merge-conflict") as "advisory", clear hasBlockingBlocker's check, and pass reviewReady:true for
// a genuinely conflicted PR.
const CODES_COLLECT_ADVISORY_BLOCKERS_CAN_EMIT: ReadonlySet<GitPullRequestReadinessBlockerCode> =
  new Set(["draft-pr", "checks-pending", "approval-insufficient"]);

function hasIllegitimateAdvisoryBlocker(
  blockers: readonly GitPullRequestReadinessBlocker[],
): boolean {
  return blockers.some(
    (blocker) =>
      blocker.severity === "advisory" &&
      !CODES_COLLECT_ADVISORY_BLOCKERS_CAN_EMIT.has(blocker.code),
  );
}

// "Severity-ranked" means every blocking entry precedes every advisory one: once an advisory has
// been seen, no blocking entry may follow.
function isSeverityRanked(blockers: readonly GitPullRequestReadinessBlocker[]): boolean {
  let sawAdvisory = false;
  for (const blocker of blockers) {
    if (blocker.severity === "advisory") {
      sawAdvisory = true;
    } else if (sawAdvisory) {
      return false;
    }
  }
  return true;
}

// Same gap as isGitMergeReadinessSummary: the documented invariants (reviewReady implies the object
// exists and carries no blocking blocker; blocking entries precede advisory ones) were unchecked, so
// a summary could assert reviewReady while carrying a blocking blocker.
export function isGitPullRequestReadinessSummary(
  value: unknown,
): value is GitPullRequestReadinessSummary {
  return (
    isRecord(value) &&
    value.schemaVersion === GIT_PULL_REQUEST_SCHEMA_VERSION &&
    isBoolean(value.objectExists) &&
    isBoolean(value.reviewReady) &&
    isBlockerArray(value.blockers) &&
    (!value.reviewReady || (value.objectExists && !hasBlockingBlocker(value.blockers))) &&
    !hasIllegitimateAdvisoryBlocker(value.blockers) &&
    isSeverityRanked(value.blockers)
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isString);
}

export function isGitPullRequestChangeNarrative(
  value: unknown,
): value is GitPullRequestChangeNarrative {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.commitCount) &&
    isNonNegativeInteger(value.fileCount) &&
    isNonNegativeInteger(value.areaCount) &&
    isStringArray(value.areas) &&
    isBoolean(value.touchesTests) &&
    isGitPrChangeType(value.changeType)
  );
}

export function isGitPullRequestMetadataDraft(
  value: unknown,
): value is GitPullRequestMetadataDraft {
  return (
    isRecord(value) &&
    value.schemaVersion === GIT_PULL_REQUEST_SCHEMA_VERSION &&
    isString(value.composedTitle) &&
    isRecord(value.summarySection) &&
    isRecord(value.riskSection) &&
    isRecord(value.changeNarrativeSection) &&
    isString(value.riskNarrative)
  );
}

// ─── Parse ──────────────────────────────────────────────────────────────────────────────────────────

export function parseGitPullRequestReadinessSummary(
  value: unknown,
): GitDeliveryParseResult<GitPullRequestReadinessSummary> {
  if (!isGitPullRequestReadinessSummary(value)) {
    return { ok: false, errors: ["value is not a valid GitPullRequestReadinessSummary"] };
  }
  return { ok: true, value };
}
