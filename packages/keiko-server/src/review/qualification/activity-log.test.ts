// Executable proofs of the pair qualification operations (Issue #4137, AC6): counts, closed values
// and digests only — never a model name, model output, finding prose or a path.

import { describe, expect, it } from "vitest";

import {
  REVIEW_FINDING_CATEGORIES,
  REVIEW_SEED_CASE_RESULTS,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../../tests/support/activity-log-proof.js";
import { captureActivityLog } from "../../activityLogCapture.test-support.js";
import {
  PAIR_QUALIFICATION_LOG_CASE_RESULTS,
  PAIR_QUALIFICATION_LOG_SEED_CLASSES,
  PAIR_QUALIFICATION_LOG_SEED_KINDS,
  logPairQualificationCaseScored,
  logPairQualificationCompleted,
  logPairQualificationFailed,
  logPairQualificationStarted,
} from "./activity-log.js";
import { REVIEW_SEED_CORPUS, REVIEW_SEED_DEFECT_KINDS } from "./seed-corpus/index.js";

const CORRELATION = "review-pair-qualification-proof";
const FORBIDDEN = ["secret-reviewer-model", "secret-checker-model", "src/routes.ts", "synthetic-"];
const TOTALS = {
  reviewer: { promptTokens: 9_000, completionTokens: 0, durationMs: 40_000 },
  counterChecker: { promptTokens: 3_000, completionTokens: 120, durationMs: 9_000 },
};
const SCORE = {
  defectCaseCount: 9,
  cleanControlCount: 3,
  found: 8,
  missed: 1,
  stale: 0,
  falseAlarms: 1,
  requiredCount: 9,
  requiredFound: 8,
  unmatchedResults: 0,
};

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

describe("pair qualification Activity Log proofs", () => {
  it("logs exactly the corpus and contract vocabularies", () => {
    expect(PAIR_QUALIFICATION_LOG_SEED_KINDS).toEqual([
      ...REVIEW_SEED_DEFECT_KINDS,
      "clean-control",
    ]);
    expect(PAIR_QUALIFICATION_LOG_SEED_CLASSES).toEqual(REVIEW_FINDING_CATEGORIES);
    expect(PAIR_QUALIFICATION_LOG_CASE_RESULTS).toEqual(REVIEW_SEED_CASE_RESULTS);
  });

  it("proves started, case-scored and completed", () => {
    const started = onlyLine((sink) => {
      logPairQualificationStarted(sink, CORRELATION, {
        qualificationId: "pair-qualification-1",
        reviewerModelId: "secret-reviewer-model",
        counterCheckerModelId: "secret-checker-model",
        corpus: REVIEW_SEED_CORPUS,
        deadlineMs: 10_800_000,
      });
    });
    expect(expectActivityLogProof("review.pair-qualification.started.line", started)).toMatchObject(
      {
        caseCount: 12,
        defectCaseCount: 9,
        cleanControlCount: 3,
      },
    );
    const entry = REVIEW_SEED_CORPUS[0];
    if (entry === undefined) throw new TypeError("corpus is empty");
    const scored = onlyLine((sink) => {
      logPairQualificationCaseScored(sink, CORRELATION, {
        qualificationId: "pair-qualification-1",
        caseIndex: 0,
        entry,
        result: "found",
        presentedCount: 1,
        runId: "review-run-1",
      });
    });
    expect(
      expectActivityLogProof("review.pair-qualification.case-scored.line", scored),
    ).toMatchObject({
      seedKind: entry.kind,
      seedClass: entry.seed.seedClass,
      seedResult: "found",
    });
    const completed = onlyLine((sink) => {
      logPairQualificationCompleted(sink, CORRELATION, {
        qualificationId: "pair-qualification-1",
        outcome: "seed-failed",
        score: SCORE,
        missedSeedClasses: ["concurrency"],
        totals: TOTALS,
        durationMs: 52_000,
      });
    });
    expect(
      expectActivityLogProof("review.pair-qualification.completed.line", completed),
    ).toMatchObject({
      outcome: "seed-failed",
      missed: 1,
      missedSeedClassCount: 1,
      reviewerPromptTokens: 9_000,
      durationMs: 52_000,
    });
  });

  it("proves failed with frames and cause chain for an unexpected error", () => {
    const line = onlyLine((sink) => {
      logPairQualificationFailed(sink, CORRELATION, {
        qualificationId: "pair-qualification-1",
        reason: "failed",
        scoredCases: 2,
        unscoredCases: 10,
        totals: TOTALS,
        durationMs: 1_000,
        error: new TypeError("seed repository step failed"),
      });
    });
    const fields = expectActivityLogProof("review.pair-qualification.failed.line", line);
    expect(fields).toMatchObject({ reason: "failed", scoredCases: 2, unscoredCases: 10 });
    expect(fields).toHaveProperty("frames");
  });
});
