// Executable proofs of the review run's Activity Log operations (Issue #4136, AC7): every line
// passes the production formatter's registration validation, carries the run's correlation, and
// none carries a path, a model name, code or finding prose.

import { describe, expect, it } from "vitest";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../../tests/support/activity-log-proof.js";
import { captureActivityLog } from "../../activityLogCapture.test-support.js";
import {
  REVIEW_RUN_PHASES,
  REVIEW_RUN_REFUSAL_REASONS,
  REVIEW_SETTLEMENT_KINDS,
  REVIEW_SETTLEMENT_REASONS,
  REVIEW_TARGET_KINDS,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import {
  REVIEW_RUN_LOG_PHASES,
  REVIEW_RUN_LOG_REFUSAL_REASONS,
  REVIEW_RUN_LOG_SETTLEMENT_REASONS,
  REVIEW_RUN_LOG_SETTLEMENTS,
  REVIEW_RUN_LOG_TARGET_KINDS,
  logReviewRunPhase,
  logReviewRunRefused,
  logReviewRunSettled,
  logReviewRunStarted,
} from "./activity-log.js";

const CORRELATION = "review-run-proof";
const FORBIDDEN = ["gemma-secret-model", "qwen-secret-model", "src/", "prose"];

function onlyLine(emit: (sink: ReturnType<typeof captureActivityLog>["sink"]) => void): string {
  const capture = captureActivityLog();
  emit(capture.sink);
  const [event] = capture.events;
  if (event === undefined || capture.events.length !== 1) throw new TypeError("expected one event");
  const line = formatActivityLogProofLine(event);
  for (const forbidden of FORBIDDEN) expect(line).not.toContain(forbidden);
  expect(line).toContain(CORRELATION);
  return line;
}

const TOTALS = { promptTokens: 1200, completionTokens: 80, durationMs: 4_000 };

describe("review run Activity Log proofs", () => {
  it("logs exactly the contract vocabularies", () => {
    expect(REVIEW_RUN_LOG_TARGET_KINDS).toEqual(REVIEW_TARGET_KINDS);
    expect(REVIEW_RUN_LOG_PHASES).toEqual(REVIEW_RUN_PHASES);
    expect(REVIEW_RUN_LOG_SETTLEMENTS).toEqual(REVIEW_SETTLEMENT_KINDS);
    expect(REVIEW_RUN_LOG_REFUSAL_REASONS).toEqual(REVIEW_RUN_REFUSAL_REASONS);
    expect(REVIEW_RUN_LOG_SETTLEMENT_REASONS).toEqual([
      "none",
      ...REVIEW_SETTLEMENT_REASONS.incomplete,
      ...REVIEW_SETTLEMENT_REASONS.abandoned,
      ...REVIEW_SETTLEMENT_REASONS.skipped,
    ]);
  });

  it("proves review.run.started with model digests and budgets", () => {
    const line = onlyLine((sink) => {
      logReviewRunStarted(sink, CORRELATION, {
        runId: "review-run-1",
        targetKind: "pull-request",
        reviewerModelId: "gemma-secret-model",
        counterCheckerModelId: "qwen-secret-model",
        reviewerPromptBudget: 600_000,
        counterCheckRunPromptBudget: 1_200_000,
        counterCheckMaxToolCalls: 32,
        counterCheckWallTimeMs: 120_000,
        counterCheckEnabled: true,
      });
    });
    expect(expectActivityLogProof("review.run.started.line", line)).toMatchObject({
      targetKind: "pull-request",
      counterCheckMaxToolCalls: 32,
      counterCheckEnabled: true,
    });
  });

  it("proves review.run.phase with the package counts", () => {
    const line = onlyLine((sink) => {
      logReviewRunPhase(sink, CORRELATION, {
        runId: "review-run-1",
        phase: "reviewing",
        elapsedMs: 1500,
        packageCounts: {
          changedFiles: 4,
          includedFiles: 2,
          partialFiles: 0,
          unprocessedFiles: 1,
          filteredFiles: 1,
          binaryFiles: 0,
          budgetTokens: 13_000,
          usedTokens: 900,
        },
      });
    });
    expect(expectActivityLogProof("review.run.phase.line", line)).toMatchObject({
      phase: "reviewing",
      changedFiles: 4,
      unprocessedFiles: 1,
    });
  });

  it("proves review.run.settled with settlement, verdict counts and role totals", () => {
    const line = onlyLine((sink) => {
      logReviewRunSettled(sink, CORRELATION, {
        runId: "review-run-1",
        settlement: { kind: "incomplete", reason: "budget-exhausted" },
        coverage: null,
        verdicts: { candidates: 4, confirmed: 2, refuted: 1, undecided: 1, presented: 2 },
        reviewer: TOTALS,
        counterChecker: TOTALS,
        durationMs: 9_000,
        stale: true,
      });
    });
    expect(expectActivityLogProof("review.run.settled.line", line)).toMatchObject({
      settlement: "incomplete",
      reason: "budget-exhausted",
      presentedCount: 2,
      stale: true,
    });
  });

  it("proves review.run.refused with its closed reason", () => {
    const line = onlyLine((sink) => {
      logReviewRunRefused(sink, CORRELATION, "active-review-exists", false);
    });
    expect(expectActivityLogProof("review.run.refused.line", line)).toMatchObject({
      reason: "active-review-exists",
      dryRun: false,
    });
  });
});
