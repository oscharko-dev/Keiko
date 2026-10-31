// Activity Log evidence of a Keiko for Quality review run (ADR-0182 `review.run.*`, Issue #4136).
//
// The run's correlation id threads every line of one run, from `review.run.started` through each
// `review.run.phase` to `review.run.settled`; counter-check sessions point at it through their
// `parentCorrelationId`. Every field is a closed value, a count, a duration, a flag or a digest
// (ADR-0173 D4): never finding prose, code, prompts, model output, model names or paths.

import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type {
  ReviewDiffCoverageSummary,
  ReviewRoleTotals,
  ReviewRunPhase,
  ReviewRunRefusalReason,
  ReviewRunSettlement,
  ReviewRuntimeCleanup,
  ReviewTargetRequest,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import type { ServerLogSink } from "../../observability/index.js";
import { reviewEvidenceDigest } from "../activity-log.js";

// Literal copies of the contract vocabularies (the op-catalog generator reads registrations as
// closed literals); `activity-log.test.ts` pins each one to its contract constant.
export const REVIEW_RUN_LOG_TARGET_KINDS = ["pull-request", "local-range"] as const;
export const REVIEW_RUN_LOG_PHASES = [
  "preparing",
  "reviewing",
  "counter-checking",
  "settling",
  "settled",
] as const;
export const REVIEW_RUN_LOG_SETTLEMENTS = [
  "complete",
  "incomplete",
  "abandoned",
  "skipped",
] as const;
export const REVIEW_RUN_LOG_SETTLEMENT_REASONS = [
  "none",
  "files-unprocessed",
  "budget-exhausted",
  "deadline-exceeded",
  "model-failed",
  "cancelled",
  "interrupted",
  "target-changed",
  "worktree-failed",
  "diff-too-large",
  "no-reviewable-changes",
  "rules-file-invalid",
  "policy-invalid",
  "model-unavailable",
] as const;
export const REVIEW_RUN_LOG_RUNTIME_CLEANUP = ["proven", "unproven"] as const;
export const REVIEW_RUN_LOG_REFUSAL_REASONS = [
  "active-review-exists",
  "policy-invalid",
  "model-unavailable",
  "request-invalid",
] as const;

const RUN_OPERATION_BASE = {
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  owner: "keiko-server",
  causal: "correlation",
  releaseImpact: "patch",
  failureClasses: ["review-run"],
} as const;

const COUNT = { type: "integer", dataClass: "count", required: true } as const;
const OPTIONAL_COUNT = { type: "integer", dataClass: "count", required: false } as const;
const DURATION = { type: "integer", dataClass: "duration", required: true } as const;
const DIGEST = { type: "string", dataClass: "digest", required: true, maxLength: 64 } as const;

const REVIEW_RUN_STARTED = defineActivityLogOperation({
  ...RUN_OPERATION_BASE,
  op: "review.run.started",
  category: "process",
  emitter: "review/service/activity-log.logReviewRunStarted",
  fields: {
    runDigest: DIGEST,
    targetKind: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: REVIEW_RUN_LOG_TARGET_KINDS,
    },
    reviewerModelDigest: DIGEST,
    counterCheckerModelDigest: DIGEST,
    reviewerPromptBudget: COUNT,
    counterCheckRunPromptBudget: COUNT,
    counterCheckMaxToolCalls: COUNT,
    counterCheckWallTimeMs: DURATION,
    counterCheckEnabled: { type: "boolean", dataClass: "closed-enum", required: true },
  },
  lifecycle: "start",
  analyzerProjection: "timeline",
  proofIds: ["review.run.started.line"],
});

const REVIEW_RUN_PHASE = defineActivityLogOperation({
  ...RUN_OPERATION_BASE,
  op: "review.run.phase",
  category: "process",
  emitter: "review/service/activity-log.logReviewRunPhase",
  fields: {
    runDigest: DIGEST,
    phase: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: REVIEW_RUN_LOG_PHASES,
    },
    elapsedMs: DURATION,
    changedFiles: OPTIONAL_COUNT,
    includedFiles: OPTIONAL_COUNT,
    partialFiles: OPTIONAL_COUNT,
    unprocessedFiles: OPTIONAL_COUNT,
    filteredFiles: OPTIONAL_COUNT,
    binaryFiles: OPTIONAL_COUNT,
    budgetTokens: OPTIONAL_COUNT,
    usedTokens: OPTIONAL_COUNT,
    candidateCount: OPTIONAL_COUNT,
  },
  lifecycle: "state",
  analyzerProjection: "timeline",
  proofIds: ["review.run.phase.line"],
});

const REVIEW_RUN_SETTLED = defineActivityLogOperation({
  ...RUN_OPERATION_BASE,
  op: "review.run.settled",
  category: "process",
  emitter: "review/service/activity-log.logReviewRunSettled",
  fields: {
    runDigest: DIGEST,
    settlement: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: REVIEW_RUN_LOG_SETTLEMENTS,
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: REVIEW_RUN_LOG_SETTLEMENT_REASONS,
    },
    changedFiles: COUNT,
    reviewedFiles: COUNT,
    partialFiles: COUNT,
    unprocessedFiles: COUNT,
    candidateCount: COUNT,
    confirmedCount: COUNT,
    refutedCount: COUNT,
    undecidedCount: COUNT,
    presentedCount: COUNT,
    reviewerPromptTokens: COUNT,
    reviewerCompletionTokens: COUNT,
    reviewerDurationMs: DURATION,
    counterCheckPromptTokens: COUNT,
    counterCheckCompletionTokens: COUNT,
    counterCheckDurationMs: DURATION,
    durationMs: DURATION,
    stale: { type: "boolean", dataClass: "closed-enum", required: true },
    // #4136: whether the Reviewer runtime's end was proven; absent when no Reviewer run started.
    // `unproven` is a warning beside the settlement (a macOS gateway-profile run, ADR-0140 D3).
    runtimeCleanup: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: REVIEW_RUN_LOG_RUNTIME_CLEANUP,
    },
  },
  lifecycle: "end",
  analyzerProjection: "timeline",
  proofIds: ["review.run.settled.line"],
});

const REVIEW_RUN_REFUSED = defineActivityLogOperation({
  ...RUN_OPERATION_BASE,
  op: "review.run.refused",
  category: "process",
  emitter: "review/service/activity-log.logReviewRunRefused",
  fields: {
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: REVIEW_RUN_LOG_REFUSAL_REASONS,
    },
    dryRun: { type: "boolean", dataClass: "closed-enum", required: true },
  },
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  proofIds: ["review.run.refused.line"],
});

export interface ReviewRunStartedLine {
  readonly runId: string;
  readonly targetKind: ReviewTargetRequest["kind"];
  readonly reviewerModelId: string;
  readonly counterCheckerModelId: string;
  readonly reviewerPromptBudget: number;
  readonly counterCheckRunPromptBudget: number;
  readonly counterCheckMaxToolCalls: number;
  readonly counterCheckWallTimeMs: number;
  readonly counterCheckEnabled: boolean;
}

export function logReviewRunStarted(
  log: ServerLogSink,
  correlationId: string,
  line: ReviewRunStartedLine,
): void {
  log.write(
    activityLogEvent(
      REVIEW_RUN_STARTED,
      { correlationId, level: "info" },
      {
        runDigest: reviewEvidenceDigest("run", line.runId),
        targetKind: line.targetKind,
        reviewerModelDigest: reviewEvidenceDigest("model", line.reviewerModelId),
        counterCheckerModelDigest: reviewEvidenceDigest("model", line.counterCheckerModelId),
        reviewerPromptBudget: line.reviewerPromptBudget,
        counterCheckRunPromptBudget: line.counterCheckRunPromptBudget,
        counterCheckMaxToolCalls: line.counterCheckMaxToolCalls,
        counterCheckWallTimeMs: line.counterCheckWallTimeMs,
        counterCheckEnabled: line.counterCheckEnabled,
      },
    ),
  );
}

/** Package counts of the `reviewing` phase line (child 4's coverage, never paths). */
export interface ReviewRunPackageCounts {
  readonly changedFiles: number;
  readonly includedFiles: number;
  readonly partialFiles: number;
  readonly unprocessedFiles: number;
  readonly filteredFiles: number;
  readonly binaryFiles: number;
  readonly budgetTokens: number;
  readonly usedTokens: number;
}

export function logReviewRunPhase(
  log: ServerLogSink,
  correlationId: string,
  line: {
    readonly runId: string;
    readonly phase: ReviewRunPhase;
    readonly elapsedMs: number;
    readonly packageCounts?: ReviewRunPackageCounts | undefined;
    readonly candidateCount?: number | undefined;
  },
): void {
  log.write(
    activityLogEvent(
      REVIEW_RUN_PHASE,
      { correlationId, level: "info" },
      {
        runDigest: reviewEvidenceDigest("run", line.runId),
        phase: line.phase,
        elapsedMs: Math.max(0, Math.round(line.elapsedMs)),
        ...line.packageCounts,
        ...(line.candidateCount === undefined ? {} : { candidateCount: line.candidateCount }),
      },
    ),
  );
}

export interface ReviewRunSettledLine {
  readonly runId: string;
  readonly settlement: ReviewRunSettlement;
  readonly coverage: ReviewDiffCoverageSummary | null;
  readonly verdicts: {
    readonly candidates: number;
    readonly confirmed: number;
    readonly refuted: number;
    readonly undecided: number;
    readonly presented: number;
  };
  readonly reviewer: ReviewRoleTotals;
  readonly counterChecker: ReviewRoleTotals;
  readonly durationMs: number;
  readonly stale: boolean;
  readonly runtimeCleanup?: ReviewRuntimeCleanup | undefined;
}

/** A clean settlement is info; an unclean one, or an unproven runtime cleanup, is a warning. */
function settledLevel(line: ReviewRunSettledLine): "info" | "warn" {
  return line.settlement.kind === "complete" && line.runtimeCleanup !== "unproven"
    ? "info"
    : "warn";
}

function coverageCounts(coverage: ReviewDiffCoverageSummary | null): {
  readonly changedFiles: number;
  readonly reviewedFiles: number;
  readonly partialFiles: number;
  readonly unprocessedFiles: number;
} {
  return {
    changedFiles: coverage?.changedFiles ?? 0,
    reviewedFiles: coverage?.reviewedFiles ?? 0,
    partialFiles: coverage?.partiallyReviewedFiles ?? 0,
    unprocessedFiles: coverage?.unprocessedFiles ?? 0,
  };
}

export function logReviewRunSettled(
  log: ServerLogSink,
  correlationId: string,
  line: ReviewRunSettledLine,
): void {
  const settlement = line.settlement;
  log.write(
    activityLogEvent(
      REVIEW_RUN_SETTLED,
      { correlationId, level: settledLevel(line) },
      {
        runDigest: reviewEvidenceDigest("run", line.runId),
        settlement: settlement.kind,
        reason: settlement.kind === "complete" ? "none" : settlement.reason,
        ...coverageCounts(line.coverage),
        candidateCount: line.verdicts.candidates,
        confirmedCount: line.verdicts.confirmed,
        refutedCount: line.verdicts.refuted,
        undecidedCount: line.verdicts.undecided,
        presentedCount: line.verdicts.presented,
        reviewerPromptTokens: line.reviewer.promptTokens,
        reviewerCompletionTokens: line.reviewer.completionTokens,
        reviewerDurationMs: Math.round(line.reviewer.durationMs),
        counterCheckPromptTokens: line.counterChecker.promptTokens,
        counterCheckCompletionTokens: line.counterChecker.completionTokens,
        counterCheckDurationMs: Math.round(line.counterChecker.durationMs),
        durationMs: Math.max(0, Math.round(line.durationMs)),
        stale: line.stale,
        ...(line.runtimeCleanup === undefined ? {} : { runtimeCleanup: line.runtimeCleanup }),
      },
    ),
  );
}

export function logReviewRunRefused(
  log: ServerLogSink,
  correlationId: string,
  reason: ReviewRunRefusalReason,
  dryRun: boolean,
): void {
  log.write(
    activityLogEvent(
      REVIEW_RUN_REFUSED,
      {
        correlationId,
        level: "warn",
        errorKind: reason === "active-review-exists" ? "conflict" : "invalid-request",
      },
      { reason, dryRun },
    ),
  );
}
