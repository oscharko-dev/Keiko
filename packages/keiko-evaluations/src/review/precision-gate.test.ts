import { describe, expect, it } from "vitest";

import { wilsonInterval } from "@oscharko-dev/keiko-contracts/runtime/eval-metrics";

import {
  countReviewOutcomes,
  evaluateReviewPrecisionGate,
  summarizeReviewPrecision,
} from "./precision-gate.js";
import { renderReviewPrecision } from "./render.js";
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

function run(pullRequests: ReviewReplayRun["pullRequests"]): ReviewReplayRun {
  return {
    schemaVersion: 1,
    datasetDigest: `sha256:${"0".repeat(64)}`,
    holdoutFromPullRequest: 3000,
    split: "holdout",
    purpose: "evaluation",
    tuningInputs: [],
    modelId: "scripted-reviewer",
    pullRequests,
  };
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
  it("rates only decided findings and keeps every other outcome as an absolute count", () => {
    const counts = countReviewOutcomes([
      replayed("hit"),
      replayed("false-alarm"),
      replayed("undecided"),
      replayed("unmeasured"),
      replayed("unmatched"),
    ]);
    expect(counts).toEqual({
      findings: 5,
      hit: 1,
      falseAlarm: 1,
      undecided: 1,
      unmeasured: 1,
      unmatched: 1,
      actionableRate: wilsonInterval(1, 2),
    });
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
    expect(summary.overall.actionableRate).toEqual(wilsonInterval(2, 3));
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
  it("passes at or above the minimum actionable rate within the finding limit", () => {
    expect(evaluateReviewPrecisionGate(summarizeReviewPrecision(sample))).toEqual({
      verdict: "pass",
      reasons: [],
    });
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

  it("renders the verdict, the counts and the intervals", () => {
    const summary = summarizeReviewPrecision(sample);
    const text = renderReviewPrecision(summary, evaluateReviewPrecisionGate(summary));
    expect(text).toContain("- Verdict: pass");
    expect(text).toContain("| All | 5 | 2 | 1 | 1 | 0 | 1 | 66.7 % (2/3; 95 % CI");
    expect(text).toContain("| category performance | 0 | 0 | 0 | 0 | 0 | 0 | — (0/0) |");
    expect(text).toContain("2000.00 input tokens");
  });
});
