// Activity Log evidence of a Keiko for Quality review run (ADR-0184 `review.run.*`, Issue #4136).
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
/** How one diff package part's Reviewer session ended (Issue #4130). */
export const REVIEW_RUN_LOG_PART_OUTCOMES = [
  "completed",
  "failed",
  "cancelled",
  "refused",
] as const;
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
const OPTIONAL_DURATION = { type: "integer", dataClass: "duration", required: false } as const;
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
    // Keiko does not limit tokens (#4346): the line names the bounds a run has, and no token
    // allowance. The `counter-checking` line of `review.run.phase` records the phase limit once the
    // part count is known.
    counterCheckMaxToolCalls: COUNT,
    // #4130: the read, list and search calls one counter-check's tools answer.
    counterCheckMaxReadCalls: COUNT,
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
    // #4130: the diff package parts, one Reviewer session each; `budgetTokens` is one part's.
    partCount: OPTIONAL_COUNT,
    // #4130: the Git hunks larger than one part that the package shows as consecutive windows.
    windowedHunks: OPTIONAL_COUNT,
    candidateCount: OPTIONAL_COUNT,
    // #4130: the wall time after which the phase starts no further counter-check, the configured
    // limit once per diff package part; only on the `counter-checking` line.
    counterCheckPhaseWallTimeMs: OPTIONAL_DURATION,
  },
  lifecycle: "state",
  analyzerProjection: "timeline",
  proofIds: ["review.run.phase.line"],
});

// #4130: one line per diff package part, when its Reviewer session ended. `runtimeRunId` joins the
// part to its `coding-runtime.*` lines; `reason` is the incomplete reason of a failed session or
// the settlement reason of a refused one.
const REVIEW_RUN_PART = defineActivityLogOperation({
  ...RUN_OPERATION_BASE,
  op: "review.run.part",
  category: "process",
  emitter: "review/service/activity-log.logReviewRunPart",
  fields: {
    runDigest: DIGEST,
    partNumber: COUNT,
    partCount: COUNT,
    fileCount: COUNT,
    usedTokens: COUNT,
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: REVIEW_RUN_LOG_PART_OUTCOMES,
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: REVIEW_RUN_LOG_SETTLEMENT_REASONS,
    },
    runtimeRunId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 64 },
    candidateCount: COUNT,
    // #4130: the session's read, search and discover calls the read allowance let through to
    // admission, and the ones it refused once it was used up. Absent when no session started.
    readCallCount: OPTIONAL_COUNT,
    refusedReadCallCount: OPTIONAL_COUNT,
    // #4130: present (2) only on the line of a part's second session, which is started once when
    // the first ended on a model failure before any report was accepted.
    attempt: OPTIONAL_COUNT,
    promptTokens: COUNT,
    completionTokens: COUNT,
    durationMs: DURATION,
  },
  lifecycle: "state",
  analyzerProjection: "timeline",
  proofIds: ["review.run.part.line"],
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
    // #4130: candidates no counter-check ran for because the run already presented as many
    // findings as it may. They carry no verdict and do not make the run incomplete. Present only
    // when there are any.
    surplusCandidateCount: OPTIONAL_COUNT,
    // #4130: parts whose Reviewer session reached its read allowance, and those of them whose
    // session then reported nothing. Such a part counts as reviewed, and a run with a silent one
    // settles as a warning. Present once the Reviewer has run.
    readLimitedPartCount: OPTIONAL_COUNT,
    readLimitedSilentPartCount: OPTIONAL_COUNT,
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
  readonly counterCheckMaxToolCalls: number;
  readonly counterCheckMaxReadCalls: number;
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
        counterCheckMaxToolCalls: line.counterCheckMaxToolCalls,
        counterCheckMaxReadCalls: line.counterCheckMaxReadCalls,
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
  readonly partCount: number;
  /** The Git hunks shown as consecutive windows because no part could hold them (#4130). */
  readonly windowedHunks: number;
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
    readonly counterCheckPhaseWallTimeMs?: number | undefined;
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
        ...(line.counterCheckPhaseWallTimeMs === undefined
          ? {}
          : { counterCheckPhaseWallTimeMs: Math.round(line.counterCheckPhaseWallTimeMs) }),
      },
    ),
  );
}

export interface ReviewRunPartLine {
  readonly runId: string;
  /** One-based. */
  readonly partNumber: number;
  readonly partCount: number;
  readonly fileCount: number;
  readonly usedTokens: number;
  readonly outcome: (typeof REVIEW_RUN_LOG_PART_OUTCOMES)[number];
  readonly reason?:
    Exclude<ReviewRunSettlement, { readonly kind: "complete" }>["reason"] | undefined;
  readonly runtimeRunId?: string | undefined;
  readonly candidateCount: number;
  /** The session's admitted and refused read calls (#4130); absent when no session started. */
  readonly readCalls?: { readonly admitted: number; readonly refused: number } | undefined;
  /** Only on a part's second session (#4130). */
  readonly attempt?: number | undefined;
  readonly totals: ReviewRoleTotals;
}

/** A completed part is info; a failed, cancelled or refused one is a warning. */
export function logReviewRunPart(
  log: ServerLogSink,
  correlationId: string,
  line: ReviewRunPartLine,
): void {
  log.write(
    activityLogEvent(
      REVIEW_RUN_PART,
      { correlationId, level: line.outcome === "completed" ? "info" : "warn" },
      {
        runDigest: reviewEvidenceDigest("run", line.runId),
        partNumber: line.partNumber,
        partCount: line.partCount,
        fileCount: line.fileCount,
        usedTokens: line.usedTokens,
        outcome: line.outcome,
        ...(line.reason === undefined ? {} : { reason: line.reason }),
        ...(line.runtimeRunId === undefined ? {} : { runtimeRunId: line.runtimeRunId }),
        candidateCount: line.candidateCount,
        ...(line.readCalls === undefined
          ? {}
          : {
              readCallCount: line.readCalls.admitted,
              refusedReadCallCount: line.readCalls.refused,
            }),
        ...(line.attempt === undefined ? {} : { attempt: line.attempt }),
        promptTokens: line.totals.promptTokens,
        completionTokens: line.totals.completionTokens,
        durationMs: Math.max(0, Math.round(line.totals.durationMs)),
      },
    ),
  );
}

/** The surplus count as a field, only when there is a surplus. */
function surplusCandidateCount(surplus: number | undefined): {
  readonly surplusCandidateCount?: number;
} {
  return surplus !== undefined && surplus > 0 ? { surplusCandidateCount: surplus } : {};
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
    /** Candidates left unchecked because the presentation was already full (#4130). */
    readonly surplus?: number | undefined;
  };
  readonly reviewer: ReviewRoleTotals;
  readonly counterChecker: ReviewRoleTotals;
  readonly durationMs: number;
  readonly stale: boolean;
  readonly runtimeCleanup?: ReviewRuntimeCleanup | undefined;
}

/**
 * A clean settlement is info. An unclean one, an unproven runtime cleanup, and a part whose Reviewer
 * reached its read allowance and then reported nothing (#4130) are warnings: such a run settles
 * `complete`, and it must not look like a clean one.
 */
function settledLevel(line: ReviewRunSettledLine): "info" | "warn" {
  const silentParts = line.coverage?.readLimitedPartsWithoutReport ?? 0;
  const clean = line.settlement.kind === "complete" && line.runtimeCleanup !== "unproven";
  return clean && silentParts === 0 ? "info" : "warn";
}

/** The read-limit counts as fields, once the Reviewer has run. */
function readLimitCounts(coverage: ReviewDiffCoverageSummary | null): {
  readonly readLimitedPartCount?: number;
  readonly readLimitedSilentPartCount?: number;
} {
  if (coverage?.readLimitedParts === undefined) return {};
  return {
    readLimitedPartCount: coverage.readLimitedParts,
    readLimitedSilentPartCount: coverage.readLimitedPartsWithoutReport ?? 0,
  };
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
        ...surplusCandidateCount(line.verdicts.surplus),
        ...readLimitCounts(line.coverage),
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
