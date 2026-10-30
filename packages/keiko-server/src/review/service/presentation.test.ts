// The presentation rule (ADR-0182 D4/D5, Issue #4136, AC2).

import { describe, expect, it } from "vitest";
import type {
  CounterCheckVerdict,
  ReviewFindingReport,
  ReviewFindingSeverity,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import {
  counterCheckOrder,
  presentReviewFindings,
  verdictConnectsToReport,
  type PresentationCandidate,
} from "./presentation.js";

function report(severity: ReviewFindingSeverity, file = "src/a.ts"): ReviewFindingReport {
  return {
    file,
    startLine: 10,
    endLine: 12,
    title: "t",
    condition: "c",
    mechanism: "m",
    consequence: "q",
    remedy: "r",
    category: "correctness",
    severity,
    evidence: [
      { file, startLine: 10, endLine: 12, role: "defect" },
      { file: "src/b.ts", startLine: 40, endLine: 41, role: "context" },
    ],
  };
}

function fingerprint(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function confirmed(
  fp: string,
  evidence = [{ file: "src/a.ts", startLine: 11, endLine: 11 }],
): CounterCheckVerdict {
  return {
    findingFingerprint: fp,
    verdict: "confirmed",
    reasonCode: "defect-reproduced-in-code",
    evidence: evidence.map((entry) => ({ ...entry, role: "defect" as const })),
  };
}

function candidate(
  index: number,
  severity: ReviewFindingSeverity,
  verdict: "confirmed" | "refuted" | "undecided" | "none" = "confirmed",
  evidenceInHead = true,
): PresentationCandidate {
  const fp = fingerprint(index);
  const verdicts: Record<string, CounterCheckVerdict | undefined> = {
    confirmed: confirmed(fp),
    refuted: {
      findingFingerprint: fp,
      verdict: "refuted",
      reasonCode: "guarded-elsewhere",
      evidence: [],
    },
    undecided: {
      findingFingerprint: fp,
      verdict: "undecided",
      reasonCode: "insufficient-context",
      evidence: [],
    },
    none: undefined,
  };
  return {
    fingerprint: fp,
    report: report(severity),
    reviewerRank: index,
    verdict: verdicts[verdict],
    evidenceInHead,
  };
}

function presented(decisions: ReturnType<typeof presentReviewFindings>): string[] {
  return decisions
    .filter((decision) => decision.presented)
    .sort((left, right) => (left.presentationRank ?? 0) - (right.presentationRank ?? 0))
    .map((decision) => decision.fingerprint);
}

describe("presentReviewFindings", () => {
  it("presents only confirmed, head-anchored, connected findings", () => {
    const candidates = [
      candidate(1, "high", "refuted"),
      candidate(2, "high", "undecided"),
      candidate(3, "high", "none"),
      candidate(4, "high", "confirmed", false),
      candidate(5, "low", "confirmed"),
    ];
    expect(presented(presentReviewFindings(candidates, { counterCheck: "on" }))).toEqual([
      fingerprint(5),
    ]);
  });

  it("refuses a confirmation whose evidence does not connect to the report", () => {
    const unrelated = candidate(1, "high");
    const moved = {
      ...unrelated,
      verdict: confirmed(unrelated.fingerprint, [{ file: "src/a.ts", startLine: 90, endLine: 95 }]),
    };
    expect(presented(presentReviewFindings([moved], { counterCheck: "on" }))).toEqual([]);
    expect(verdictConnectsToReport(moved.report, moved.verdict)).toBe(false);
    const viaContext = {
      ...unrelated,
      verdict: confirmed(unrelated.fingerprint, [{ file: "src/b.ts", startLine: 41, endLine: 44 }]),
    };
    expect(presented(presentReviewFindings([viaContext], { counterCheck: "on" }))).toHaveLength(1);
  });

  it("refuses a verdict bound to another fingerprint", () => {
    const own = candidate(1, "high");
    const foreign = { ...own, verdict: confirmed(fingerprint(9)) };
    expect(presented(presentReviewFindings([foreign], { counterCheck: "on" }))).toEqual([]);
  });

  it("presents at most three, by severity then Reviewer order", () => {
    const candidates = [
      candidate(1, "low"),
      candidate(2, "medium"),
      candidate(3, "high"),
      candidate(4, "medium"),
      candidate(5, "high"),
    ];
    const decisions = presentReviewFindings(candidates, { counterCheck: "on" });
    expect(presented(decisions)).toEqual([fingerprint(3), fingerprint(5), fingerprint(2)]);
    expect(decisions.map((decision) => decision.fingerprint)).toEqual(
      candidates.map((entry) => entry.fingerprint),
    );
  });

  it("applies the injected exclusion and the evaluation-only counter-check switch", () => {
    const candidates = [
      candidate(1, "high", "refuted"),
      candidate(2, "high"),
      candidate(3, "low", "none"),
    ];
    expect(
      presented(
        presentReviewFindings(candidates, {
          counterCheck: "on",
          excluded: (fp) => fp === fingerprint(2),
        }),
      ),
    ).toEqual([]);
    expect(presented(presentReviewFindings(candidates, { counterCheck: "off" }))).toEqual([
      fingerprint(1),
      fingerprint(2),
      fingerprint(3),
    ]);
  });

  it("orders counter-checks by severity, then Reviewer order", () => {
    const ordered = counterCheckOrder([
      candidate(1, "low"),
      candidate(2, "high"),
      candidate(3, "high"),
    ]);
    expect(ordered.map((entry) => entry.reviewerRank)).toEqual([2, 3, 1]);
  });
});
