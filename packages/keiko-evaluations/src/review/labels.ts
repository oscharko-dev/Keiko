// The labeling rules of the review measurement (Issue #4132, docs/qa/review-agent-measurement.md),
// ported in meaning from the retired Keiko for Quality harvest (`gradeRecord`, `labelFor`). This is
// the one place they exist; the replay, the precision gate and the baseline all read them here.
//
// 1. Region changed later in the same pull request: hit.
// 2. Evidenced refutation with the code unchanged: false alarm.
// 3. A refutation the code later contradicted is not a refutation: hit.
// 4. No counterpart: a hand-graded sample, never counted automatically as a hit (`unmatched`).
// An unmeasurable region (git could not answer) is `unmeasured`, never read as unchanged: an absent
// measurement must not pass as a confirmed refutation.

import type { ReviewCodeLocation } from "@oscharko-dev/keiko-contracts";

import type {
  ReviewFindingOutcome,
  ReviewHarvestThread,
  ReviewThreadLabel,
  ReviewThreadLabelling,
} from "./types.js";

/** Labels one historical thread from its recorded facts. */
export function labelReviewThread(thread: ReviewHarvestThread): ReviewThreadLabelling {
  const refuted = thread.reply?.classification === "refuted";
  if (thread.regionChange === "changed") {
    return { label: "hit", refuted, refutationContradicted: refuted };
  }
  if (thread.regionChange === "unavailable") {
    return { label: "unmeasured", refuted, refutationContradicted: false };
  }
  return { label: refuted ? "false-alarm" : "undecided", refuted, refutationContradicted: false };
}

/**
 * Where a finding at the head commit lands relative to one thread (R4130-007). Only right-side
 * threads take part: a base-side anchor has no head coordinates. A file-level thread overlaps any
 * range in its file. A line anchor is compared in head line numbers; one whose carry to head failed
 * is `unknown`, which a match reports as unmeasured rather than as apart or overlapping.
 */
export function threadOverlap(
  finding: ReviewCodeLocation,
  thread: ReviewHarvestThread,
): "overlap" | "apart" | "unknown" {
  if (thread.side !== "right" || finding.file !== thread.path) return "apart";
  if (thread.fileLevel) return "overlap";
  if (thread.headStartLine === null || thread.headEndLine === null) return "unknown";
  const overlaps =
    finding.startLine <= thread.headEndLine && finding.endLine >= thread.headStartLine;
  return overlaps ? "overlap" : "apart";
}

/** Whether a finding at head lands on a thread's head anchor (file-level: anywhere in its file). */
export function findingOverlapsThread(
  finding: ReviewCodeLocation,
  thread: ReviewHarvestThread,
): boolean {
  return threadOverlap(finding, thread) === "overlap";
}

// When several threads overlap one finding, the strongest evidence decides: a changed region is the
// behaviour the rules count as a hit, then a confirmed refutation, then the undecided remainder.
const LABEL_PRECEDENCE: readonly ReviewThreadLabel[] = [
  "hit",
  "false-alarm",
  "undecided",
  "unmeasured",
];

export interface ReviewFindingMatch {
  readonly outcome: ReviewFindingOutcome;
  readonly matchedThreadIds: readonly string[];
}

function hitThreadIds(
  finding: ReviewCodeLocation,
  match: ReviewFindingMatch,
  threads: readonly ReviewHarvestThread[],
): readonly string[] {
  const matched = new Set(match.matchedThreadIds);
  return threads
    .filter((thread) => matched.has(thread.id) && labelReviewThread(thread).label === "hit")
    .filter((thread) => threadOverlap(finding, thread) === "overlap")
    .map((thread) => thread.id);
}

/**
 * Scores one pull request's presented findings in order. A matched thread credits one hit per pull
 * request (R4130-014): a later finding whose hit threads were all credited already is a
 * `duplicate`, which adds no hit and still counts against the actionable rate.
 */
export function scoreReviewFindings(
  findings: readonly ReviewCodeLocation[],
  threads: readonly ReviewHarvestThread[],
): readonly ReviewFindingMatch[] {
  const credited = new Set<string>();
  return findings.map((finding) => {
    const match = matchReviewFinding(finding, threads);
    if (match.outcome !== "hit") return match;
    const hits = hitThreadIds(finding, match, threads);
    if (hits.every((id) => credited.has(id))) return { ...match, outcome: "duplicate" };
    for (const id of hits) credited.add(id);
    return match;
  });
}

/**
 * Scores one replayed finding at head against one pull request's labeled threads. A right-side line
 * thread whose anchor could not be carried to head may lie under the finding, so it contributes
 * `unmeasured`; it is listed in `matchedThreadIds` but never credits a hit.
 */
export function matchReviewFinding(
  finding: ReviewCodeLocation,
  threads: readonly ReviewHarvestThread[],
): ReviewFindingMatch {
  const labels = new Set<ReviewThreadLabel>();
  const matchedThreadIds: string[] = [];
  for (const thread of threads) {
    const overlap = threadOverlap(finding, thread);
    if (overlap === "apart") continue;
    matchedThreadIds.push(thread.id);
    labels.add(overlap === "unknown" ? "unmeasured" : labelReviewThread(thread).label);
  }
  if (matchedThreadIds.length === 0) return { outcome: "unmatched", matchedThreadIds };
  const outcome = LABEL_PRECEDENCE.find((label) => labels.has(label)) ?? "unmeasured";
  return { outcome, matchedThreadIds };
}
