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
  REVIEW_RUNTIME_CLEANUP_STATES,
  REVIEW_SETTLEMENT_KINDS,
  REVIEW_SETTLEMENT_REASONS,
  REVIEW_TARGET_KINDS,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import {
  REVIEW_RUN_LOG_PART_OUTCOMES,
  REVIEW_RUN_LOG_PHASES,
  REVIEW_RUN_LOG_REFUSAL_REASONS,
  REVIEW_RUN_LOG_RUNTIME_CLEANUP,
  REVIEW_RUN_LOG_SETTLEMENT_REASONS,
  REVIEW_RUN_LOG_SETTLEMENTS,
  REVIEW_RUN_LOG_TARGET_KINDS,
  logReviewRunPart,
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
    expect(REVIEW_RUN_LOG_RUNTIME_CLEANUP).toEqual(REVIEW_RUNTIME_CLEANUP_STATES);
    expect(REVIEW_RUN_LOG_SETTLEMENT_REASONS).toEqual([
      "none",
      ...REVIEW_SETTLEMENT_REASONS.incomplete,
      ...REVIEW_SETTLEMENT_REASONS.abandoned,
      ...REVIEW_SETTLEMENT_REASONS.skipped,
    ]);
  });

  it("proves review.run.started with model digests and limits", () => {
    const line = onlyLine((sink) => {
      logReviewRunStarted(sink, CORRELATION, {
        runId: "review-run-1",
        targetKind: "pull-request",
        reviewerModelId: "gemma-secret-model",
        counterCheckerModelId: "qwen-secret-model",
        counterCheckMaxToolCalls: 32,
        counterCheckMaxReadCalls: 8,
        counterCheckWallTimeMs: 120_000,
        counterCheckEnabled: true,
      });
    });
    expect(expectActivityLogProof("review.run.started.line", line)).toMatchObject({
      targetKind: "pull-request",
      counterCheckMaxToolCalls: 32,
      counterCheckMaxReadCalls: 8,
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
          partCount: 2,
          windowedHunks: 1,
        },
      });
    });
    expect(expectActivityLogProof("review.run.phase.line", line)).toMatchObject({
      phase: "reviewing",
      changedFiles: 4,
      unprocessedFiles: 1,
      partCount: 2,
      windowedHunks: 1,
    });
  });

  it("proves the counter-checking line with the phase limit (#4130)", () => {
    const line = onlyLine((sink) => {
      logReviewRunPhase(sink, CORRELATION, {
        runId: "review-run-1",
        phase: "counter-checking",
        elapsedMs: 90_000,
        candidateCount: 9,
        counterCheckPhaseWallTimeMs: 7_200_000,
      });
    });
    expect(expectActivityLogProof("review.run.phase.line", line)).toMatchObject({
      phase: "counter-checking",
      candidateCount: 9,
      counterCheckPhaseWallTimeMs: 7_200_000,
    });
  });

  it("proves review.run.part for each way a part's session ends (Issue #4130)", () => {
    expect(REVIEW_RUN_LOG_PART_OUTCOMES).toEqual(["completed", "failed", "cancelled", "refused"]);
    const part = {
      runId: "review-run-1",
      partNumber: 2,
      partCount: 3,
      fileCount: 5,
      usedTokens: 12_000,
      candidateCount: 1,
      totals: TOTALS,
    };
    const completed = onlyLine((sink) => {
      logReviewRunPart(sink, CORRELATION, {
        ...part,
        outcome: "completed",
        runtimeRunId: "run-7f3c",
        readCalls: { admitted: 24, refused: 2 },
      });
    });
    expect(expectActivityLogProof("review.run.part.line", completed)).toMatchObject({
      level: "info",
      partNumber: 2,
      partCount: 3,
      fileCount: 5,
      outcome: "completed",
      runtimeRunId: "run-7f3c",
      // #4130: the session's answered read calls, and the ones refused past its allowance.
      readCallCount: 24,
      refusedReadCallCount: 2,
      promptTokens: 1200,
      durationMs: 4_000,
    });
    const failed = onlyLine((sink) => {
      logReviewRunPart(sink, CORRELATION, {
        ...part,
        outcome: "failed",
        reason: "budget-exhausted",
      });
    });
    expect(expectActivityLogProof("review.run.part.line", failed)).toMatchObject({
      level: "warn",
      outcome: "failed",
      reason: "budget-exhausted",
    });
    expect(JSON.parse(failed)).not.toHaveProperty("runtimeRunId");
    // A part whose session never started carries no read counts.
    expect(JSON.parse(failed)).not.toHaveProperty("readCallCount");
    expect(JSON.parse(failed)).not.toHaveProperty("refusedReadCallCount");
    // #4130: only the line of a part's second session says which attempt it is.
    expect(JSON.parse(failed)).not.toHaveProperty("attempt");
    const second = onlyLine((sink) => {
      logReviewRunPart(sink, CORRELATION, { ...part, outcome: "completed", attempt: 2 });
    });
    expect(expectActivityLogProof("review.run.part.line", second)).toMatchObject({
      outcome: "completed",
      attempt: 2,
    });
    expect(JSON.parse(second)).not.toHaveProperty("repeatLimitReached");
    // #4130: a session Keiko ended at the report repeat limit completes its part, as a warning.
    const repeated = onlyLine((sink) => {
      logReviewRunPart(sink, CORRELATION, {
        ...part,
        outcome: "completed",
        repeatLimitReached: true,
      });
    });
    expect(expectActivityLogProof("review.run.part.line", repeated)).toMatchObject({
      level: "warn",
      outcome: "completed",
      repeatLimitReached: true,
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

  // #4130: candidates the counter-check phase skipped because the presentation was already full
  // are counted on the settled line, and only when there are any.
  it("proves review.run.settled with its surplus candidates", () => {
    const settled = (surplus: number | undefined): string =>
      onlyLine((sink) => {
        logReviewRunSettled(sink, CORRELATION, {
          runId: "review-run-1",
          settlement: { kind: "complete" },
          coverage: null,
          verdicts: {
            candidates: 7,
            confirmed: 3,
            refuted: 1,
            undecided: 0,
            presented: 3,
            surplus,
          },
          reviewer: TOTALS,
          counterChecker: TOTALS,
          durationMs: 9_000,
          stale: false,
        });
      });
    expect(expectActivityLogProof("review.run.settled.line", settled(3))).toMatchObject({
      settlement: "complete",
      candidateCount: 7,
      confirmedCount: 3,
      presentedCount: 3,
      surplusCandidateCount: 3,
    });
    expect(JSON.parse(settled(0))).not.toHaveProperty("surplusCandidateCount");
    expect(JSON.parse(settled(undefined))).not.toHaveProperty("surplusCandidateCount");
  });

  // #4130: a part whose Reviewer reached its read allowance counts as reviewed. The settled line
  // counts such parts, and a silent one makes the line a warning although the run is complete.
  // #4130: a part whose session Keiko ended at the report repeat limit counts as reviewed when it
  // filed a report; the run's line counts it and is a warning, as the part's own line is.
  it("proves review.run.settled with its repeat-limited parts as a warning", () => {
    const capture = captureActivityLog();
    logReviewRunSettled(capture.sink, CORRELATION, {
      runId: "review-run-1",
      settlement: { kind: "complete" },
      coverage: {
        changedFiles: 3,
        reviewedFiles: 3,
        partiallyReviewedFiles: 0,
        unprocessedFiles: 0,
        addedLines: 10,
        removedLines: 2,
        budgetTokens: 13_832,
        usedTokens: 900,
        readLimitedParts: 0,
        readLimitedPartsWithoutReport: 0,
        repeatLimitedParts: 1,
      },
      verdicts: { candidates: 1, confirmed: 1, refuted: 0, undecided: 0, presented: 1 },
      reviewer: TOTALS,
      counterChecker: TOTALS,
      durationMs: 9_000,
      stale: false,
    });
    const [event] = capture.events;
    if (event === undefined) throw new TypeError("expected one event");
    expect(event.level).toBe("warn");
    expect(
      expectActivityLogProof("review.run.settled.line", formatActivityLogProofLine(event)),
    ).toMatchObject({ settlement: "complete", repeatLimitedPartCount: 1 });
  });

  it("proves review.run.settled with its read-limited parts, a warning when one was silent", () => {
    const settledWith = (silent: number | undefined): ReturnType<typeof captureActivityLog> => {
      const capture = captureActivityLog();
      logReviewRunSettled(capture.sink, CORRELATION, {
        runId: "review-run-1",
        settlement: { kind: "complete" },
        coverage: {
          changedFiles: 3,
          reviewedFiles: 3,
          partiallyReviewedFiles: 0,
          unprocessedFiles: 0,
          addedLines: 10,
          removedLines: 2,
          budgetTokens: 13_832,
          usedTokens: 900,
          ...(silent === undefined
            ? {}
            : { readLimitedParts: 2, readLimitedPartsWithoutReport: silent }),
        },
        verdicts: { candidates: 0, confirmed: 0, refuted: 0, undecided: 0, presented: 0 },
        reviewer: TOTALS,
        counterChecker: TOTALS,
        durationMs: 9_000,
        stale: false,
      });
      return capture;
    };
    const [silent] = settledWith(1).events;
    if (silent === undefined) throw new TypeError("expected one event");
    expect(silent.level).toBe("warn");
    expect(
      expectActivityLogProof("review.run.settled.line", formatActivityLogProofLine(silent)),
    ).toMatchObject({
      settlement: "complete",
      readLimitedPartCount: 2,
      readLimitedSilentPartCount: 1,
    });
    const [reported] = settledWith(0).events;
    expect(reported?.level).toBe("info");
    expect(reported?.extra).toMatchObject({
      readLimitedPartCount: 2,
      readLimitedSilentPartCount: 0,
    });
    // A run whose Reviewer never ran carries neither count.
    const [absent] = settledWith(undefined).events;
    expect(absent?.extra).not.toHaveProperty("readLimitedPartCount");
    expect(absent?.extra).not.toHaveProperty("readLimitedSilentPartCount");
  });

  // #4136: a review that settled on its coverage while the Reviewer runtime's end stayed unproven
  // (a macOS gateway-profile run) records the cleanup beside the settlement, at warn.
  it("proves review.run.settled with an unproven runtime cleanup as a warning", () => {
    const capture = captureActivityLog();
    logReviewRunSettled(capture.sink, CORRELATION, {
      runId: "review-run-1",
      settlement: { kind: "complete" },
      coverage: null,
      verdicts: { candidates: 1, confirmed: 1, refuted: 0, undecided: 0, presented: 1 },
      reviewer: TOTALS,
      counterChecker: TOTALS,
      durationMs: 65_000,
      stale: false,
      runtimeCleanup: "unproven",
    });
    const [event] = capture.events;
    if (event === undefined) throw new TypeError("expected one event");
    expect(event.level).toBe("warn");
    const line = formatActivityLogProofLine(event);
    expect(line).toContain(CORRELATION);
    expect(expectActivityLogProof("review.run.settled.line", line)).toMatchObject({
      settlement: "complete",
      reason: "none",
      runtimeCleanup: "unproven",
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

  // R4130-079, R4130-082: a role model nobody activated in Settings > Models is the refusal's own
  // reason, and the cause on the settled line of a run whose model was deactivated after its start.
  it("proves the not-activated cause on review.run.refused and review.run.settled", () => {
    const refused = onlyLine((sink) => {
      logReviewRunRefused(sink, CORRELATION, "model-not-activated", false);
    });
    expect(expectActivityLogProof("review.run.refused.line", refused)).toMatchObject({
      reason: "model-not-activated",
      dryRun: false,
    });
    const settled = onlyLine((sink) => {
      logReviewRunSettled(sink, CORRELATION, {
        runId: "review-run-1",
        settlement: { kind: "skipped", reason: "model-unavailable" },
        coverage: null,
        verdicts: { candidates: 0, confirmed: 0, refuted: 0, undecided: 0, presented: 0 },
        reviewer: TOTALS,
        counterChecker: TOTALS,
        durationMs: 10,
        stale: false,
        modelCause: "not-activated",
      });
    });
    expect(expectActivityLogProof("review.run.settled.line", settled)).toMatchObject({
      settlement: "skipped",
      reason: "model-unavailable",
      modelCause: "not-activated",
    });
  });
});
