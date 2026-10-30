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

/** Whether a finding lands on a thread's anchor: same file and overlapping range (file-level: any). */
export function findingOverlapsThread(
  finding: ReviewCodeLocation,
  thread: ReviewHarvestThread,
): boolean {
  if (finding.file !== thread.path) return false;
  if (thread.fileLevel || thread.startLine === null || thread.endLine === null) return true;
  return finding.startLine <= thread.endLine && finding.endLine >= thread.startLine;
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

/** Scores one replayed finding against one pull request's labeled threads. */
export function matchReviewFinding(
  finding: ReviewCodeLocation,
  threads: readonly ReviewHarvestThread[],
): ReviewFindingMatch {
  const matched = threads.filter((thread) => findingOverlapsThread(finding, thread));
  if (matched.length === 0) return { outcome: "unmatched", matchedThreadIds: [] };
  const labels = new Set(matched.map((thread) => labelReviewThread(thread).label));
  const outcome = LABEL_PRECEDENCE.find((label) => labels.has(label)) ?? "unmeasured";
  return { outcome, matchedThreadIds: matched.map((thread) => thread.id) };
}
