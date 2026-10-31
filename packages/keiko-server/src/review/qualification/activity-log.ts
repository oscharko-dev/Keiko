// Activity Log evidence of a local pair qualification (ADR-0182 `review.pair-qualification.*`,
// Issue #4137). One qualification is one correlation: `started`, one `case-scored` per seed case,
// then `completed` (a pair status was recorded) or `failed` (none was). Every seed case's review run
// is started under the same correlation, so its `review.run.*` lines join the same timeline. Fields
// are closed values, counts, flags, durations and digests only (ADR-0173 D4): never model output,
// finding prose, code, a path or a model name.

import { causeChain, keikoStackFrames } from "@oscharko-dev/keiko-activity-log";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type {
  ReviewFindingCategory,
  ReviewRoleTotals,
  ReviewSeedCaseResult,
  ReviewSeedScore,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import type { ServerLogSink } from "../../observability/index.js";
import {
  COUNT_FIELD,
  DIGEST_FIELD,
  REVIEW_OPERATION,
  reviewEvidenceDigest,
} from "../activity-log.js";
import type { ReviewSeedCorpusEntry } from "./seed-corpus/index.js";

// Literal copies of the contract and corpus vocabularies (the op-catalog generator reads closed
// literals); `activity-log.test.ts` pins each one to its source constant.
export const PAIR_QUALIFICATION_LOG_SEED_KINDS = [
  "removed-authorization-guard",
  "swallowed-error",
  "missing-await",
  "off-by-one-boundary",
  "nullish-dereference-after-optional",
  "path-traversal-in-file-read",
  "unchecked-input-to-sensitive-sink",
  "resource-not-released-on-error-path",
  "inverted-condition",
  "clean-control",
] as const;
export const PAIR_QUALIFICATION_LOG_SEED_CLASSES = [
  "correctness",
  "security",
  "reliability",
  "performance",
  "concurrency",
  "data-integrity",
  "test-gap",
  "maintainability",
] as const;
export const PAIR_QUALIFICATION_LOG_CASE_RESULTS = [
  "found",
  "missed",
  "stale",
  "clean",
  "false-alarm",
  "not-scored",
] as const;
const FAILURE_REASONS = [
  "cancelled",
  "incomplete",
  "deadline-exceeded",
  "active-qualification",
  "unavailable",
  "failed",
] as const;
type PairQualificationFailureReason = (typeof FAILURE_REASONS)[number];

const QUALIFICATION_OPERATION = {
  ...REVIEW_OPERATION,
  failureClasses: ["review-pair-qualification"],
} as const;
const DURATION = { type: "integer", dataClass: "duration", required: true } as const;
const OPTIONAL_COUNT = { ...COUNT_FIELD, required: false } as const;
const FLAG = { type: "boolean", dataClass: "closed-enum", required: true } as const;

// The seed score of `scoreReviewSeedRun`, field by field.
const SCORE_FIELDS = {
  defectCaseCount: COUNT_FIELD,
  cleanControlCount: COUNT_FIELD,
  found: COUNT_FIELD,
  missed: COUNT_FIELD,
  stale: COUNT_FIELD,
  falseAlarms: COUNT_FIELD,
  requiredCount: COUNT_FIELD,
  requiredFound: COUNT_FIELD,
  unmatchedResults: COUNT_FIELD,
} as const;

const TOTALS_FIELDS = {
  reviewerPromptTokens: COUNT_FIELD,
  reviewerCompletionTokens: COUNT_FIELD,
  counterCheckPromptTokens: COUNT_FIELD,
  counterCheckCompletionTokens: COUNT_FIELD,
} as const;

const REVIEW_PAIR_QUALIFICATION_STARTED = defineActivityLogOperation({
  ...QUALIFICATION_OPERATION,
  op: "review.pair-qualification.started",
  emitter: "review/qualification/activity-log.logPairQualificationStarted",
  fields: {
    qualificationDigest: DIGEST_FIELD,
    reviewerModelDigest: DIGEST_FIELD,
    counterCheckerModelDigest: DIGEST_FIELD,
    caseCount: COUNT_FIELD,
    defectCaseCount: COUNT_FIELD,
    cleanControlCount: COUNT_FIELD,
    deadlineMs: DURATION,
  },
  lifecycle: "start",
  analyzerProjection: "timeline",
  proofIds: ["review.pair-qualification.started.line"],
});

const REVIEW_PAIR_QUALIFICATION_CASE_SCORED = defineActivityLogOperation({
  ...QUALIFICATION_OPERATION,
  op: "review.pair-qualification.case-scored",
  emitter: "review/qualification/activity-log.logPairQualificationCaseScored",
  fields: {
    qualificationDigest: DIGEST_FIELD,
    caseIndex: COUNT_FIELD,
    seedKind: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: PAIR_QUALIFICATION_LOG_SEED_KINDS,
    },
    seedClass: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: PAIR_QUALIFICATION_LOG_SEED_CLASSES,
    },
    required: FLAG,
    seedResult: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: PAIR_QUALIFICATION_LOG_CASE_RESULTS,
    },
    presentedCount: COUNT_FIELD,
    runDigest: { ...DIGEST_FIELD, required: false },
  },
  lifecycle: "state",
  analyzerProjection: "timeline",
  proofIds: ["review.pair-qualification.case-scored.line"],
});

const REVIEW_PAIR_QUALIFICATION_COMPLETED = defineActivityLogOperation({
  ...QUALIFICATION_OPERATION,
  op: "review.pair-qualification.completed",
  emitter: "review/qualification/activity-log.logPairQualificationCompleted",
  fields: {
    qualificationDigest: DIGEST_FIELD,
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["seed-qualified", "seed-failed"],
    },
    ...SCORE_FIELDS,
    missedSeedClassCount: COUNT_FIELD,
    ...TOTALS_FIELDS,
    durationMs: DURATION,
  },
  lifecycle: "end",
  analyzerProjection: "timeline",
  proofIds: ["review.pair-qualification.completed.line"],
});

const REVIEW_PAIR_QUALIFICATION_FAILED = defineActivityLogOperation({
  ...QUALIFICATION_OPERATION,
  op: "review.pair-qualification.failed",
  emitter: "review/qualification/activity-log.logPairQualificationFailed",
  fields: {
    qualificationDigest: { ...DIGEST_FIELD, required: false },
    reason: { type: "string", dataClass: "closed-enum", required: true, values: FAILURE_REASONS },
    scoredCases: OPTIONAL_COUNT,
    unscoredCases: OPTIONAL_COUNT,
    reviewerPromptTokens: OPTIONAL_COUNT,
    counterCheckPromptTokens: OPTIONAL_COUNT,
    durationMs: { ...DURATION, required: false },
    frames: {
      type: "string-array",
      dataClass: "opaque-id",
      required: false,
      maxLength: 512,
      maxItems: 8,
    },
    causeChain: {
      type: "string-array",
      dataClass: "error-kind",
      required: false,
      maxLength: 128,
      maxItems: 5,
    },
  },
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  proofIds: ["review.pair-qualification.failed.line"],
});

function qualificationDigest(qualificationId: string): string {
  return reviewEvidenceDigest("qualification", qualificationId);
}

export interface PairQualificationStartedLine {
  readonly qualificationId: string;
  readonly reviewerModelId: string;
  readonly counterCheckerModelId: string;
  readonly corpus: readonly ReviewSeedCorpusEntry[];
  readonly deadlineMs: number;
}

export function logPairQualificationStarted(
  log: ServerLogSink,
  correlationId: string,
  line: PairQualificationStartedLine,
): void {
  const cleanControls = line.corpus.filter((entry) => entry.seed.cleanControl).length;
  log.write(
    activityLogEvent(
      REVIEW_PAIR_QUALIFICATION_STARTED,
      { correlationId, level: "info" },
      {
        qualificationDigest: qualificationDigest(line.qualificationId),
        reviewerModelDigest: reviewEvidenceDigest("model", line.reviewerModelId),
        counterCheckerModelDigest: reviewEvidenceDigest("model", line.counterCheckerModelId),
        caseCount: line.corpus.length,
        defectCaseCount: line.corpus.length - cleanControls,
        cleanControlCount: cleanControls,
        deadlineMs: line.deadlineMs,
      },
    ),
  );
}

export interface PairQualificationCaseLine {
  readonly qualificationId: string;
  readonly caseIndex: number;
  readonly entry: ReviewSeedCorpusEntry;
  readonly result: ReviewSeedCaseResult;
  readonly presentedCount: number;
  readonly runId: string | undefined;
}

export function logPairQualificationCaseScored(
  log: ServerLogSink,
  correlationId: string,
  line: PairQualificationCaseLine,
): void {
  log.write(
    activityLogEvent(
      REVIEW_PAIR_QUALIFICATION_CASE_SCORED,
      { correlationId, level: line.result === "not-scored" ? "warn" : "info" },
      {
        qualificationDigest: qualificationDigest(line.qualificationId),
        caseIndex: line.caseIndex,
        seedKind: line.entry.kind,
        seedClass: line.entry.seed.seedClass,
        required: line.entry.seed.required,
        seedResult: line.result,
        presentedCount: line.presentedCount,
        ...(line.runId === undefined ? {} : { runDigest: reviewEvidenceDigest("run", line.runId) }),
      },
    ),
  );
}

export interface PairQualificationTotals {
  readonly reviewer: ReviewRoleTotals;
  readonly counterChecker: ReviewRoleTotals;
}

export interface PairQualificationCompletedLine {
  readonly qualificationId: string;
  readonly outcome: "seed-qualified" | "seed-failed";
  readonly score: ReviewSeedScore;
  readonly missedSeedClasses: readonly ReviewFindingCategory[];
  readonly totals: PairQualificationTotals;
  readonly durationMs: number;
}

export function logPairQualificationCompleted(
  log: ServerLogSink,
  correlationId: string,
  line: PairQualificationCompletedLine,
): void {
  log.write(
    activityLogEvent(
      REVIEW_PAIR_QUALIFICATION_COMPLETED,
      { correlationId, level: line.outcome === "seed-qualified" ? "info" : "warn" },
      {
        qualificationDigest: qualificationDigest(line.qualificationId),
        outcome: line.outcome,
        ...line.score,
        missedSeedClassCount: line.missedSeedClasses.length,
        reviewerPromptTokens: line.totals.reviewer.promptTokens,
        reviewerCompletionTokens: line.totals.reviewer.completionTokens,
        counterCheckPromptTokens: line.totals.counterChecker.promptTokens,
        counterCheckCompletionTokens: line.totals.counterChecker.completionTokens,
        durationMs: Math.max(0, Math.round(line.durationMs)),
      },
    ),
  );
}

export interface PairQualificationFailedLine {
  readonly qualificationId?: string | undefined;
  readonly reason: PairQualificationFailureReason;
  readonly scoredCases?: number | undefined;
  readonly unscoredCases?: number | undefined;
  readonly totals?: PairQualificationTotals | undefined;
  readonly durationMs?: number | undefined;
  readonly error?: unknown;
}

const FAILURE_ERROR_KINDS = {
  cancelled: "cancelled",
  incomplete: "unavailable",
  "deadline-exceeded": "timeout",
  "active-qualification": "conflict",
  unavailable: "unavailable",
  failed: "internal",
} as const satisfies Record<PairQualificationFailureReason, string>;

function failedCounts(line: PairQualificationFailedLine): Record<string, number> {
  return {
    ...(line.scoredCases === undefined ? {} : { scoredCases: line.scoredCases }),
    ...(line.unscoredCases === undefined ? {} : { unscoredCases: line.unscoredCases }),
    ...(line.totals === undefined
      ? {}
      : {
          reviewerPromptTokens: line.totals.reviewer.promptTokens,
          counterCheckPromptTokens: line.totals.counterChecker.promptTokens,
        }),
    ...(line.durationMs === undefined
      ? {}
      : { durationMs: Math.max(0, Math.round(line.durationMs)) }),
  };
}

export function logPairQualificationFailed(
  log: ServerLogSink,
  correlationId: string,
  line: PairQualificationFailedLine,
): void {
  log.write(
    activityLogEvent(
      REVIEW_PAIR_QUALIFICATION_FAILED,
      { correlationId, level: "warn", errorKind: FAILURE_ERROR_KINDS[line.reason] },
      {
        ...(line.qualificationId === undefined
          ? {}
          : { qualificationDigest: qualificationDigest(line.qualificationId) }),
        reason: line.reason,
        ...failedCounts(line),
        ...(line.error === undefined
          ? {}
          : { frames: keikoStackFrames(line.error), causeChain: causeChain(line.error) }),
      },
    ),
  );
}
