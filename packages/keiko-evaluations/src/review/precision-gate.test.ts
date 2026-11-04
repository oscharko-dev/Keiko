import { describe, expect, it } from "vitest";

import { wilsonInterval } from "@oscharko-dev/keiko-contracts/runtime/eval-metrics";

import {
  countReviewOutcomes,
  evaluateReviewPrecisionGate,
  summarizeReviewPrecision,
} from "./precision-gate.js";
import { REVIEW_EVALUATION_MANIFEST } from "./manifest.js";
import { formatWilson, renderReviewPrecision } from "./render.js";
import type {
  ReviewFindingOutcome,
  ReviewReplayFinding,
  ReviewReplayRun,
  ReviewRunCost,
} from "./types.js";

function replayed(
  outcome: ReviewFindingOutcome,
  category: ReviewReplayFinding["category"] = "correctness",
  severity: ReviewReplayFinding["severity"] = "high",
): ReviewReplayFinding {
  return {
    file: "src/a.ts",
    startLine: 1,
    endLine: 2,
    category,
    severity,
    outcome,
    matchedThreadIds: [],
  };
}

function run(
  pullRequests: ReviewReplayRun["pullRequests"],
  overrides: Partial<ReviewReplayRun> = {},
): ReviewReplayRun {
  return {
    schemaVersion: 1,
    datasetDigest: `sha256:${"0".repeat(64)}`,
    holdoutFromPullRequest: 3000,
    split: "holdout",
    purpose: "evaluation",
    selection: "default",
    tuningInputs: [],
    modelId: "scripted-reviewer",
    pullRequests,
    ...overrides,
  };
}

type PullRequestResult = ReviewReplayRun["pullRequests"][number];

function reviewed(
  number: number,
  findings: readonly ReviewReplayFinding[],
  settlement: PullRequestResult["settlement"] = { kind: "complete" },
): PullRequestResult {
  return { number, settlement, findings, cost: cost(1, 1, 1) };
}

const cost = (inputTokens: number, outputTokens: number, wallTimeMs: number): ReviewRunCost => ({
  modelCalls: 2,
  inputTokens,
  outputTokens,
  wallTimeMs,
});

const sample = run([
  {
    number: 3001,
    settlement: { kind: "complete" },
    findings: [
      replayed("hit"),
      replayed("hit", "security", "medium"),
      replayed("false-alarm", "security", "low"),
    ],
    cost: cost(1000, 200, 4000),
  },
  {
    number: 3002,
    settlement: { kind: "incomplete", reason: "budget-exhausted" },
    findings: [replayed("unmatched"), replayed("undecided", "reliability")],
    cost: cost(3000, 400, 6000),
  },
]);

describe("countReviewOutcomes", () => {
  // Owner decision 2026-11-04 (R4130-006): the gated actionable rate counts undecided findings
  // against the agent; hits over hits plus false alarms is reported apart as the acceptance rate.
  // Duplicates joining the denominator is the implementation's rule for R4130-014. This replaces
  // the earlier pin of hits over decided findings.
  it("rates hits over hits, false alarms, undecided and duplicate findings", () => {
    const counts = countReviewOutcomes([
      replayed("hit"),
      replayed("false-alarm"),
      replayed("undecided"),
      replayed("duplicate"),
      replayed("unmeasured"),
      replayed("unmatched"),
    ]);
    expect(counts).toEqual({
      findings: 6,
      hit: 1,
      falseAlarm: 1,
      undecided: 1,
      duplicate: 1,
      unmeasured: 1,
      unmatched: 1,
      actionableRate: wilsonInterval(1, 4),
      acceptanceRate: wilsonInterval(1, 2),
    });
  });

  it("counts an ignored finding against the actionable rate but not the acceptance rate", () => {
    const counts = countReviewOutcomes([replayed("hit"), replayed("undecided")]);
    expect(counts.actionableRate).toEqual(wilsonInterval(1, 2));
    expect(counts.acceptanceRate).toEqual(wilsonInterval(1, 1));
  });

  it("never counts an unmatched finding as actionable", () => {
    const counts = countReviewOutcomes([replayed("unmatched"), replayed("unmatched")]);
    expect(counts.hit).toBe(0);
    expect(counts.actionableRate.rate).toBeNull();
  });
});

describe("summarizeReviewPrecision", () => {
  const summary = summarizeReviewPrecision(sample);

  it("reports absolute counts with a Wilson interval on the overall rate", () => {
    expect(summary.overall).toMatchObject({
      findings: 5,
      hit: 2,
      falseAlarm: 1,
      undecided: 1,
      unmatched: 1,
    });
    expect(summary.overall.actionableRate).toEqual(wilsonInterval(2, 4));
    expect(summary.overall.acceptanceRate).toEqual(wilsonInterval(2, 3));
  });

  it("breaks the counts down per category and per severity, each with its own interval", () => {
    expect(summary.byCategory.security).toMatchObject({ findings: 2, hit: 1, falseAlarm: 1 });
    expect(summary.byCategory.security.actionableRate).toEqual(wilsonInterval(1, 2));
    expect(summary.byCategory.performance.findings).toBe(0);
    expect(summary.byCategory.performance.actionableRate.rate).toBeNull();
    expect(summary.bySeverity.high).toMatchObject({ findings: 3, hit: 1 });
    expect(summary.bySeverity.low).toMatchObject({ findings: 1, falseAlarm: 1 });
  });

  it("reports findings per pull request, settlements and cost per pull request", () => {
    expect(summary.findingsPerPullRequest).toEqual({ mean: 2.5, max: 3 });
    expect(summary.settlements).toEqual({ complete: 1, incomplete: 1, abandoned: 0, skipped: 0 });
    expect(summary.cost.inputTokens).toEqual({ total: 4000, meanPerPullRequest: 2000 });
    expect(summary.cost.outputTokens).toEqual({ total: 600, meanPerPullRequest: 300 });
    expect(summary.cost.wallTimeMs).toEqual({ total: 10000, meanPerPullRequest: 5000 });
    expect(summary.cost.modelCalls.total).toBe(4);
    expect(summary).toMatchObject({
      split: "holdout",
      purpose: "evaluation",
      selection: "default",
      holdoutFromPullRequest: 3000,
    });
  });

  it("returns absent means for an empty run", () => {
    const empty = summarizeReviewPrecision(run([]));
    expect(empty.findingsPerPullRequest).toEqual({ mean: null, max: 0 });
    expect(empty.cost.inputTokens.meanPerPullRequest).toBeNull();
  });
});

describe("evaluateReviewPrecisionGate", () => {
  const passing = run([
    reviewed(3001, [replayed("hit"), replayed("hit"), replayed("false-alarm")]),
    reviewed(3002, [replayed("unmatched"), replayed("undecided")]),
  ]);

  it("passes at or above the minimum actionable rate within the finding limit", () => {
    expect(evaluateReviewPrecisionGate(summarizeReviewPrecision(passing))).toEqual({
      verdict: "pass",
      reasons: [],
    });
  });

  it("fails when ignored findings pull the actionable rate below the minimum", () => {
    // R4130-006: 2 hits, no false alarm and 3 undecided findings is 2/5, although the
    // acceptance rate is 2/2.
    const ignored = run([
      reviewed(3001, [replayed("hit"), replayed("undecided"), replayed("undecided")]),
      reviewed(3002, [replayed("hit"), replayed("undecided")]),
    ]);
    const summary = summarizeReviewPrecision(ignored);
    expect(summary.overall.acceptanceRate.rate).toBe(1);
    const result = evaluateReviewPrecisionGate(summary);
    expect(result.verdict).toBe("fail");
    expect(result.reasons).toEqual([expect.stringMatching(/actionable rate 2\/5/u)]);
  });

  it("counts duplicates against the rate, so one restated hit cannot carry a run", () => {
    // R4130-014: one credited hit and two duplicates on the same thread is 1/3.
    const restated = run([
      reviewed(3001, [replayed("hit"), replayed("duplicate"), replayed("duplicate")]),
    ]);
    const summary = summarizeReviewPrecision(restated);
    expect(summary.overall).toMatchObject({ hit: 1, duplicate: 2 });
    expect(evaluateReviewPrecisionGate(summary).verdict).toBe("fail");
  });

  it.each([
    ["a development run", { split: "development", purpose: "evaluation" }],
    ["a tuning run", { split: "development", purpose: "tuning" }],
    ["a holdout subset", { selection: "subset" }],
  ] as const)("is unmeasured for %s, whatever its rate", (_name, overrides) => {
    // R4130-011: only a holdout evaluation over the default selection is gate evidence.
    const result = evaluateReviewPrecisionGate(
      summarizeReviewPrecision(run(passing.pullRequests, overrides)),
    );
    expect(result.verdict).toBe("unmeasured");
    expect(result.reasons).toContain("not a holdout evaluation over the default selection");
  });

  it("fails when too many reviews did not settle complete", () => {
    // R4130-011's scenario: 150 of 153 reviews end incomplete before they report anything, and
    // the rest give 2 hits and 1 false alarm.
    const incomplete = Array.from({ length: 150 }, (_, index) =>
      reviewed(3100 + index, [], { kind: "incomplete", reason: "budget-exhausted" }),
    );
    const summary = summarizeReviewPrecision(
      run([
        reviewed(3001, [replayed("hit"), replayed("false-alarm")]),
        reviewed(3002, [replayed("hit")]),
        reviewed(3003, []),
        ...incomplete,
      ]),
    );
    const result = evaluateReviewPrecisionGate(summary);
    expect(result.verdict).toBe("fail");
    expect(result.reasons).toEqual([
      expect.stringMatching(/150 of 153 reviews \(98\.0 %\) did not settle complete/u),
    ]);
  });

  it("allows a not-complete share up to the manifest ceiling", () => {
    const ceiling = REVIEW_EVALUATION_MANIFEST.maximumNotCompleteShare;
    expect(ceiling).toBe(0.2);
    const atCeiling = run([
      reviewed(3001, [replayed("hit")]),
      ...[3002, 3003, 3004].map((number) => reviewed(number, [])),
      reviewed(3005, [], { kind: "skipped", reason: "no-reviewable-changes" }),
    ]);
    expect(evaluateReviewPrecisionGate(summarizeReviewPrecision(atCeiling)).verdict).toBe("pass");
  });

  it("is unmeasured when the run reviewed no pull request", () => {
    expect(evaluateReviewPrecisionGate(summarizeReviewPrecision(run([]))).verdict).toBe(
      "unmeasured",
    );
  });

  it("fails below the minimum actionable rate", () => {
    const low = run([
      {
        number: 3001,
        settlement: { kind: "complete" },
        findings: [replayed("hit"), replayed("false-alarm"), replayed("false-alarm")],
        cost: cost(1, 1, 1),
      },
    ]);
    const result = evaluateReviewPrecisionGate(summarizeReviewPrecision(low));
    expect(result.verdict).toBe("fail");
    expect(result.reasons[0]).toMatch(/actionable rate 1\/3/u);
  });

  it("fails when a pull request presents more findings than the limit", () => {
    const many = run([
      {
        number: 3001,
        settlement: { kind: "complete" },
        findings: [replayed("hit"), replayed("hit"), replayed("hit"), replayed("hit")],
        cost: cost(1, 1, 1),
      },
    ]);
    expect(evaluateReviewPrecisionGate(summarizeReviewPrecision(many))).toMatchObject({
      verdict: "fail",
      reasons: [expect.stringMatching(/presented 4 findings \(limit 3\)/u)],
    });
  });

  it("is unmeasured, never a pass, when nothing could be decided", () => {
    const undecided = run([
      {
        number: 3001,
        settlement: { kind: "complete" },
        findings: [replayed("unmatched")],
        cost: cost(1, 1, 1),
      },
    ]);
    expect(evaluateReviewPrecisionGate(summarizeReviewPrecision(undecided)).verdict).toBe(
      "unmeasured",
    );
  });

  it("renders the verdict, the counts, both rates and the not-complete share", () => {
    const summary = summarizeReviewPrecision(sample);
    const text = renderReviewPrecision(summary, evaluateReviewPrecisionGate(summary));
    expect(text).toContain("- Verdict: fail (1 of 2 reviews (50.0 %) did not settle complete");
    expect(text).toContain("- Split: holdout (evaluation, default selection)");
    expect(text).toContain("- Reviews not settled complete: 1 of 2 (50.0 %; ceiling 20.0 %)");
    expect(text).toContain(
      `| All | 5 | 2 | 1 | 1 | 0 | 0 | 1 | ${formatWilson(wilsonInterval(2, 4))} | ${formatWilson(wilsonInterval(2, 3))} |`,
    );
    expect(text).toContain(
      "| category performance | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — (0/0) | — (0/0) |",
    );
    expect(text).toContain("2000.00 input tokens");
  });
});
