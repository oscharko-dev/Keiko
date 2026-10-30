// Pure rules shared by every Keiko for Quality consumer (ADR-0182, Issue #4131): the finding
// fingerprint preimage, the review-role eligibility rule and seed scoring. Each rule exists exactly
// once, so the development seed gate (keiko-evaluations) and the shipped pair qualification
// (keiko-server) score identically without importing each other.

import { codingWorkbenchModelEligibility, type ModelCapability } from "./gateway.js";
import type {
  ReviewCodeLocation,
  ReviewFindingCategory,
  ReviewRoleBudget,
  ReviewRoleEligibility,
  ReviewSeedCase,
  ReviewSeedRunResult,
  ReviewSeedScore,
} from "./pull-request-review.js";

// ─── Fingerprint preimage ────────────────────────────────────────────────────

/** Domain separator of the version-1 finding fingerprint. */
export const REVIEW_FINDING_FINGERPRINT_DOMAIN = "keiko-review-finding-fingerprint-v1";

/**
 * Normalizes a defect excerpt so that the fingerprint survives re-indentation, line-ending changes
 * and blank-line churn: NFC, LF line endings, each line trimmed, empty lines dropped.
 */
export function normalizeReviewDefectExcerpt(excerpt: string): string {
  return excerpt
    .normalize("NFC")
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function frame(value: string): string {
  return `${String(value.length)}:${value}`;
}

/**
 * The framed preimage of a finding fingerprint: the normalized file path, the category and the
 * normalized `defect` excerpt. Line numbers and model-written prose (title, condition, ...) are
 * deliberately excluded, so an identical finding keeps its identity when the code moves or the
 * wording changes. This leaf package cannot hash; `computeReviewFindingFingerprint` in
 * keiko-security applies SHA-256 to this preimage.
 */
export function reviewFindingFingerprintPreimage(input: {
  readonly file: string;
  readonly category: ReviewFindingCategory;
  readonly defectExcerpt: string;
}): string {
  return [
    REVIEW_FINDING_FINGERPRINT_DOMAIN,
    input.file.normalize("NFC"),
    input.category,
    normalizeReviewDefectExcerpt(input.defectExcerpt),
  ]
    .map(frame)
    .join("");
}

// ─── Role eligibility ────────────────────────────────────────────────────────

/**
 * One rule for both review roles. It builds on the Coding Workbench rule
 * (`codingWorkbenchModelEligibility`) for tool calling, then adds the review budget's context
 * window. A model observed unready is temporarily unavailable; a busy model stays eligible with a
 * hint. `at` is an object for the reason `isToolCallingVerificationFresh` states (F76).
 */
export function evaluateReviewRoleEligibility(
  capability: ModelCapability | undefined,
  budget: ReviewRoleBudget,
  at?: { readonly nowMs?: number; readonly busy?: boolean },
): ReviewRoleEligibility {
  if (capability === undefined) return { status: "ineligible", reason: "not-configured" };
  const reason =
    toolIneligibility(capability, at?.nowMs) ?? contextWindowIneligibility(capability, budget);
  if (reason !== undefined) return { status: "ineligible", reason };
  if (capability.conversationReady === false) return { status: "temporarily-unavailable" };
  return at?.busy === true ? { status: "eligible", hint: "busy" } : { status: "eligible" };
}

function toolIneligibility(
  capability: ModelCapability,
  nowMs: number | undefined,
): "not-coding-safe" | "not-tool-capable" | "tool-verification-stale" | undefined {
  if (capability.kind !== "chat") return "not-coding-safe";
  const eligibility = codingWorkbenchModelEligibility(
    capability,
    nowMs === undefined ? undefined : { nowMs },
  );
  if (eligibility === "ineligible") return "not-tool-capable";
  return eligibility === "tool-calling-unverified" ? "tool-verification-stale" : undefined;
}

function contextWindowIneligibility(
  capability: ModelCapability,
  budget: ReviewRoleBudget,
): "window-unknown" | "window-too-small" | undefined {
  const window = capability.maxInputTokens ?? capability.contextWindow;
  if (capability.contextWindowAssumed === true || !Number.isFinite(window) || window <= 0) {
    return "window-unknown";
  }
  return window < budget.minContextWindowTokens ? "window-too-small" : undefined;
}

// ─── Seed scoring ────────────────────────────────────────────────────────────

function overlaps(expected: ReviewCodeLocation, finding: ReviewCodeLocation): boolean {
  return (
    expected.file === finding.file &&
    finding.startLine <= expected.endLine &&
    finding.endLine >= expected.startLine
  );
}

interface MutableSeedScore {
  defectCaseCount: number;
  cleanControlCount: number;
  found: number;
  missed: number;
  stale: number;
  falseAlarms: number;
  requiredCount: number;
  requiredFound: number;
  unmatchedResults: number;
}

function scoreCase(
  seed: ReviewSeedCase,
  result: ReviewSeedRunResult | undefined,
  score: MutableSeedScore,
): void {
  if (seed.cleanControl) {
    score.cleanControlCount += 1;
    if (result?.outcome === "settled") score.falseAlarms += result.findings.length;
    return;
  }
  score.defectCaseCount += 1;
  if (seed.required) score.requiredCount += 1;
  if (result?.outcome === "stale") {
    score.stale += 1;
    return;
  }
  const found = result?.findings.some((finding) => overlaps(seed.expected, finding)) === true;
  if (!found) {
    score.missed += 1;
    return;
  }
  score.found += 1;
  if (seed.required) score.requiredFound += 1;
}

/**
 * Scores the presented findings of a seed run: a defect case is found when a finding overlaps its
 * expected range in the expected file, missed otherwise, and stale when its run settled on a moved
 * head (stale never counts as found). Every finding on a settled clean control is a false alarm.
 * The pass rule belongs to the gate that uses the score, not to this function.
 */
export function scoreReviewSeedRun(
  cases: readonly ReviewSeedCase[],
  results: readonly ReviewSeedRunResult[],
): ReviewSeedScore {
  const known = new Set(cases.map((seed) => seed.id));
  const byCase = new Map<string, ReviewSeedRunResult>();
  const score: MutableSeedScore = {
    defectCaseCount: 0,
    cleanControlCount: 0,
    found: 0,
    missed: 0,
    stale: 0,
    falseAlarms: 0,
    requiredCount: 0,
    requiredFound: 0,
    unmatchedResults: 0,
  };
  for (const result of results) {
    if (!known.has(result.caseId) || byCase.has(result.caseId)) score.unmatchedResults += 1;
    else byCase.set(result.caseId, result);
  }
  for (const seed of cases) scoreCase(seed, byCase.get(seed.id), score);
  return { ...score };
}
