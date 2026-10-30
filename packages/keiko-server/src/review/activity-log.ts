// Activity Log evidence for review targets and review worktrees (ADR-0182, Issue #4133).
//
// Every field is a count, a closed outcome, a digest or an opaque id (ADR-0173 D4): never a path,
// a ref name, a pull request title, an author or a remote. Object ids are recorded as digests.

import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type {
  ReviewPullRequestAvailability,
  ReviewTargetRefusalReason,
  ReviewWorktreeRefusalReason,
} from "@oscharko-dev/keiko-contracts";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import type { ServerLogSink } from "../observability/index.js";
import { correlationIdOrUnknown } from "../correlation.js";

export type ReviewTargetKind = "pull-request" | "local-range";
export type ReviewWorktreeRemovalTrigger = "settled" | "abandoned" | "shutdown" | "startup";
export type ReviewRefSweepTrigger = "startup" | "daily";

// The registration every review operation shares; each operation adds its identity and fields.
const REVIEW_OPERATION = {
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  category: "process",
  owner: "keiko-server",
  causal: "correlation",
  releaseImpact: "patch",
} as const;
const REVIEW_TIMELINE_OPERATION = { ...REVIEW_OPERATION, analyzerProjection: "timeline" } as const;
const REVIEW_FAILURE_OPERATION = {
  ...REVIEW_OPERATION,
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
} as const;

const COUNT_FIELD = { type: "integer", dataClass: "count", required: true } as const;
const DIGEST_FIELD = {
  type: "string",
  dataClass: "digest",
  required: true,
  maxLength: 64,
} as const;
const TARGET_KIND_FIELD = {
  type: "string",
  dataClass: "closed-enum",
  required: true,
  values: ["pull-request", "local-range"],
} as const;

const REVIEW_TARGET_LISTED = defineActivityLogOperation({
  ...REVIEW_TIMELINE_OPERATION,
  op: "review.target.listed",
  emitter: "review/activity-log.logReviewTargetListed",
  fields: {
    read: { type: "string", dataClass: "closed-enum", required: true, values: ["list", "detail"] },
    availability: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "available",
        "gh-unavailable",
        "gh-unauthenticated",
        "no-github-remote",
        "rate-limited",
        "failed",
      ],
    },
    count: COUNT_FIELD,
    truncated: { type: "boolean", dataClass: "closed-enum", required: true },
    cacheHit: { type: "boolean", dataClass: "closed-enum", required: true },
    pages: { ...COUNT_FIELD, required: false },
    rejectedCount: { ...COUNT_FIELD, required: false },
  },
  lifecycle: "state",
  failureClasses: ["review-target-read"],
  proofIds: ["review.target.listed.line"],
});

const REVIEW_TARGET_RESOLVED = defineActivityLogOperation({
  ...REVIEW_TIMELINE_OPERATION,
  op: "review.target.resolved",
  emitter: "review/activity-log.logReviewTargetResolved",
  fields: {
    targetKind: TARGET_KIND_FIELD,
    baseShaDigest: DIGEST_FIELD,
    headShaDigest: DIGEST_FIELD,
    isCrossRepository: { type: "boolean", dataClass: "closed-enum", required: false },
    baseFetched: { type: "boolean", dataClass: "closed-enum", required: false },
    fetchDurationMs: { type: "integer", dataClass: "duration", required: false },
  },
  lifecycle: "end",
  failureClasses: ["review-target-resolution"],
  proofIds: ["review.target.resolved.line"],
});

const REVIEW_TARGET_REFUSED = defineActivityLogOperation({
  ...REVIEW_FAILURE_OPERATION,
  op: "review.target.refused",
  emitter: "review/activity-log.logReviewTargetRefused",
  fields: {
    targetKind: TARGET_KIND_FIELD,
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "gh-unavailable",
        "gh-unauthenticated",
        "no-github-remote",
        "not-found",
        "target-changed",
        "ref-invalid",
        "fetch-failed",
        "rate-limited",
      ],
    },
  },
  failureClasses: ["review-target-resolution"],
  proofIds: ["review.target.refused.line"],
});

const REVIEW_WORKTREE_CREATED = defineActivityLogOperation({
  ...REVIEW_TIMELINE_OPERATION,
  op: "review.worktree.created",
  emitter: "review/activity-log.logReviewWorktreeCreated",
  fields: {
    runDigest: DIGEST_FIELD,
    materializedCount: COUNT_FIELD,
    skippedLargeCount: COUNT_FIELD,
    skippedBinaryCount: COUNT_FIELD,
    filterDriverCount: COUNT_FIELD,
  },
  lifecycle: "start",
  failureClasses: ["review-worktree-lifecycle"],
  proofIds: ["review.worktree.created.line"],
});

const REVIEW_WORKTREE_REFUSED = defineActivityLogOperation({
  ...REVIEW_FAILURE_OPERATION,
  op: "review.worktree.refused",
  emitter: "review/activity-log.logReviewWorktreeRefused",
  fields: {
    runDigest: DIGEST_FIELD,
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "tree-too-large",
        "cancelled",
        "case-collision",
        "normalization-collision",
        "checkout-failed",
        "disk-full",
        "timeout",
      ],
    },
  },
  failureClasses: ["review-worktree-lifecycle"],
  proofIds: ["review.worktree.refused.line"],
});

const REVIEW_WORKTREE_REMOVED = defineActivityLogOperation({
  ...REVIEW_TIMELINE_OPERATION,
  op: "review.worktree.removed",
  emitter: "review/activity-log.logReviewWorktreeRemoved",
  fields: {
    runDigest: DIGEST_FIELD,
    trigger: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["settled", "abandoned", "shutdown", "startup"],
    },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["removed", "failed"],
    },
  },
  lifecycle: "end",
  failureClasses: ["review-worktree-lifecycle"],
  proofIds: ["review.worktree.removed.line"],
});

const REVIEW_WORKTREE_ORPHAN_SWEPT = defineActivityLogOperation({
  ...REVIEW_TIMELINE_OPERATION,
  op: "review.worktree.orphan-swept",
  emitter: "review/activity-log.logReviewWorktreeOrphanSwept",
  fields: { removedCount: COUNT_FIELD, failedCount: COUNT_FIELD },
  lifecycle: "state",
  failureClasses: ["review-worktree-lifecycle"],
  proofIds: ["review.worktree.orphan-swept.line"],
});

const REVIEW_WORKTREE_REFS_SWEPT = defineActivityLogOperation({
  ...REVIEW_TIMELINE_OPERATION,
  op: "review.worktree.refs-swept",
  emitter: "review/activity-log.logReviewRefsSwept",
  fields: {
    trigger: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["startup", "daily"],
    },
    deletedCount: COUNT_FIELD,
    retainedCount: COUNT_FIELD,
    failedCount: COUNT_FIELD,
  },
  lifecycle: "state",
  failureClasses: ["review-private-ref-retention"],
  proofIds: ["review.worktree.refs-swept.line"],
});

/** A domain-separated digest of an object id or run id: joinable, never the raw value. */
export function reviewEvidenceDigest(kind: "sha" | "run", value: string): string {
  return sha256Hex(`keiko-review/${kind}\u0000${value}`);
}

export interface ReviewTargetListedLine {
  readonly read: "list" | "detail";
  readonly availability: ReviewPullRequestAvailability;
  readonly count: number;
  readonly truncated: boolean;
  readonly cacheHit: boolean;
  readonly pages?: number | undefined;
  readonly rejectedCount?: number | undefined;
}

export function logReviewTargetListed(
  log: ServerLogSink,
  correlationId: string | undefined,
  line: ReviewTargetListedLine,
): void {
  const level = line.availability === "available" ? "info" : "warn";
  log.write(
    activityLogEvent(
      REVIEW_TARGET_LISTED,
      { level, correlationId: correlationIdOrUnknown(correlationId) },
      {
        read: line.read,
        availability: line.availability,
        count: line.count,
        truncated: line.truncated,
        cacheHit: line.cacheHit,
        ...(line.pages === undefined ? {} : { pages: line.pages }),
        ...(line.rejectedCount === undefined ? {} : { rejectedCount: line.rejectedCount }),
      },
    ),
  );
}

export interface ReviewTargetResolvedLine {
  readonly targetKind: ReviewTargetKind;
  readonly baseSha: string;
  readonly headSha: string;
  readonly isCrossRepository?: boolean | undefined;
  readonly baseFetched?: boolean | undefined;
  readonly fetchDurationMs?: number | undefined;
  readonly durationMs: number;
}

export function logReviewTargetResolved(
  log: ServerLogSink,
  correlationId: string | undefined,
  line: ReviewTargetResolvedLine,
): void {
  log.write(
    activityLogEvent(
      REVIEW_TARGET_RESOLVED,
      { correlationId: correlationIdOrUnknown(correlationId), durationMs: line.durationMs },
      {
        targetKind: line.targetKind,
        baseShaDigest: reviewEvidenceDigest("sha", line.baseSha),
        headShaDigest: reviewEvidenceDigest("sha", line.headSha),
        ...(line.isCrossRepository === undefined
          ? {}
          : { isCrossRepository: line.isCrossRepository }),
        ...(line.baseFetched === undefined ? {} : { baseFetched: line.baseFetched }),
        ...(line.fetchDurationMs === undefined ? {} : { fetchDurationMs: line.fetchDurationMs }),
      },
    ),
  );
}

export function logReviewTargetRefused(
  log: ServerLogSink,
  correlationId: string | undefined,
  targetKind: ReviewTargetKind,
  reason: ReviewTargetRefusalReason,
): void {
  log.write(
    activityLogEvent(
      REVIEW_TARGET_REFUSED,
      { level: "warn", correlationId: correlationIdOrUnknown(correlationId) },
      { targetKind, reason },
    ),
  );
}

export interface ReviewWorktreeCreatedLine {
  readonly runId: string;
  readonly materializedCount: number;
  readonly skippedLargeCount: number;
  readonly skippedBinaryCount: number;
  readonly filterDriverCount: number;
  readonly durationMs: number;
}

export function logReviewWorktreeCreated(
  log: ServerLogSink,
  correlationId: string | undefined,
  line: ReviewWorktreeCreatedLine,
): void {
  log.write(
    activityLogEvent(
      REVIEW_WORKTREE_CREATED,
      { correlationId: correlationIdOrUnknown(correlationId), durationMs: line.durationMs },
      {
        runDigest: reviewEvidenceDigest("run", line.runId),
        materializedCount: line.materializedCount,
        skippedLargeCount: line.skippedLargeCount,
        skippedBinaryCount: line.skippedBinaryCount,
        filterDriverCount: line.filterDriverCount,
      },
    ),
  );
}

export function logReviewWorktreeRefused(
  log: ServerLogSink,
  correlationId: string | undefined,
  runId: string,
  reason: ReviewWorktreeRefusalReason,
  durationMs: number,
): void {
  log.write(
    activityLogEvent(
      REVIEW_WORKTREE_REFUSED,
      { level: "warn", correlationId: correlationIdOrUnknown(correlationId), durationMs },
      { runDigest: reviewEvidenceDigest("run", runId), reason },
    ),
  );
}

export function logReviewWorktreeRemoved(
  log: ServerLogSink,
  correlationId: string | undefined,
  runId: string,
  trigger: ReviewWorktreeRemovalTrigger,
  outcome: "removed" | "failed",
): void {
  log.write(
    activityLogEvent(
      REVIEW_WORKTREE_REMOVED,
      {
        level: outcome === "removed" ? "info" : "warn",
        correlationId: correlationIdOrUnknown(correlationId),
      },
      { runDigest: reviewEvidenceDigest("run", runId), trigger, outcome },
    ),
  );
}

export function logReviewWorktreeOrphanSwept(
  log: ServerLogSink,
  correlationId: string | undefined,
  removedCount: number,
  failedCount: number,
): void {
  log.write(
    activityLogEvent(
      REVIEW_WORKTREE_ORPHAN_SWEPT,
      {
        level: failedCount > 0 ? "warn" : "info",
        correlationId: correlationIdOrUnknown(correlationId),
      },
      { removedCount, failedCount },
    ),
  );
}

export interface ReviewRefsSweptLine {
  readonly trigger: ReviewRefSweepTrigger;
  readonly deletedCount: number;
  readonly retainedCount: number;
  readonly failedCount: number;
}

export function logReviewRefsSwept(
  log: ServerLogSink,
  correlationId: string | undefined,
  line: ReviewRefsSweptLine,
): void {
  log.write(
    activityLogEvent(
      REVIEW_WORKTREE_REFS_SWEPT,
      {
        level: line.failedCount > 0 ? "warn" : "info",
        correlationId: correlationIdOrUnknown(correlationId),
      },
      { ...line },
    ),
  );
}
