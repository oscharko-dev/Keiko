// The presentation rule (ADR-0182 D4/D5, Issue #4136): one pure, server-enforced function decides
// which candidate findings a person sees. A candidate is presented only when the Counter-checker
// confirmed it with its own evidence, that evidence lies in the reviewed head, and it overlaps or
// connects to the reported location. At most three are presented, by severity, then in the
// Reviewer's order. Refuted, undecided and evidence-mismatched candidates are kept for measurement
// and never presented. A further exclusion (a fingerprint already dismissed on the same pull
// request, Issue #4141) is injected; by default nothing is excluded.

import {
  REVIEW_FINDING_SEVERITIES,
  REVIEW_PRESENTED_FINDINGS_MAX,
  type CounterCheckVerdict,
  type ReviewCodeLocation,
  type ReviewFindingReport,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

export interface PresentationCandidate {
  readonly fingerprint: string;
  readonly report: ReviewFindingReport;
  /** 1-based order in which the Reviewer filed it. */
  readonly reviewerRank: number;
  readonly verdict?: CounterCheckVerdict | undefined;
  /** Every verdict evidence range names a readable head file and lies inside it. */
  readonly evidenceInHead: boolean;
}

export interface PresentationDecision {
  readonly fingerprint: string;
  readonly presented: boolean;
  readonly presentationRank?: number | undefined;
}

export interface PresentationOptions {
  /** Evaluation only (Issues #4137, #4138): `off` presents Reviewer candidates directly. */
  readonly counterCheck: "on" | "off";
  /** The injected exclusion of Issue #4141; default: nothing is excluded. */
  readonly excluded?: ((fingerprint: string) => boolean) | undefined;
}

function overlaps(left: ReviewCodeLocation, right: ReviewCodeLocation): boolean {
  return (
    left.file === right.file && left.startLine <= right.endLine && left.endLine >= right.startLine
  );
}

/** The verdict's evidence overlaps the reported location or one of the candidate's evidence ranges. */
export function verdictConnectsToReport(
  report: ReviewFindingReport,
  verdict: CounterCheckVerdict,
): boolean {
  const anchors: readonly ReviewCodeLocation[] = [report, ...report.evidence];
  return verdict.evidence.some((entry) => anchors.some((anchor) => overlaps(entry, anchor)));
}

function eligible(candidate: PresentationCandidate, options: PresentationOptions): boolean {
  if (options.excluded?.(candidate.fingerprint) === true) return false;
  if (options.counterCheck === "off") return true;
  const verdict = candidate.verdict;
  return (
    verdict?.verdict === "confirmed" &&
    verdict.findingFingerprint === candidate.fingerprint &&
    candidate.evidenceInHead &&
    verdictConnectsToReport(candidate.report, verdict)
  );
}

function severityOrder(candidate: PresentationCandidate): number {
  return REVIEW_FINDING_SEVERITIES.indexOf(candidate.report.severity);
}

/** Decides presentation for every candidate; returns one decision per candidate, input order. */
export function presentReviewFindings(
  candidates: readonly PresentationCandidate[],
  options: PresentationOptions,
): readonly PresentationDecision[] {
  const ranked = candidates
    .filter((candidate) => eligible(candidate, options))
    .sort(
      (left, right) =>
        severityOrder(left) - severityOrder(right) || left.reviewerRank - right.reviewerRank,
    )
    .slice(0, REVIEW_PRESENTED_FINDINGS_MAX);
  const ranks = new Map(ranked.map((candidate, index) => [candidate.fingerprint, index + 1]));
  return candidates.map((candidate) => {
    const rank = ranks.get(candidate.fingerprint);
    return rank === undefined
      ? { fingerprint: candidate.fingerprint, presented: false }
      : { fingerprint: candidate.fingerprint, presented: true, presentationRank: rank };
  });
}

/** Severity order, then the Reviewer's order: the order counter-checks spend their budget in. */
export function counterCheckOrder<T extends Pick<PresentationCandidate, "report" | "reviewerRank">>(
  candidates: readonly T[],
): readonly T[] {
  return [...candidates].sort(
    (left, right) =>
      REVIEW_FINDING_SEVERITIES.indexOf(left.report.severity) -
        REVIEW_FINDING_SEVERITIES.indexOf(right.report.severity) ||
      left.reviewerRank - right.reviewerRank,
  );
}
