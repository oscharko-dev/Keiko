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

const REVIEW_TARGET_LISTED = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "review.target.listed",
  category: "process",
  owner: "keiko-server",
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
    count: { type: "integer", dataClass: "count", required: true },
    truncated: { type: "boolean", dataClass: "closed-enum", required: true },
    cacheHit: { type: "boolean", dataClass: "closed-enum", required: true },
    pages: { type: "integer", dataClass: "count", required: false },
    rejectedCount: { type: "integer", dataClass: "count", required: false },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["review-target-read"],
  proofIds: ["review.target.listed.line"],
  releaseImpact: "patch",
});

const REVIEW_TARGET_RESOLVED = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "review.target.resolved",
  category: "process",
  owner: "keiko-server",
  emitter: "review/activity-log.logReviewTargetResolved",
  fields: {
    targetKind: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["pull-request", "local-range"],
    },
    baseShaDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    headShaDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    isCrossRepository: { type: "boolean", dataClass: "closed-enum", required: false },
    baseFetched: { type: "boolean", dataClass: "closed-enum", required: false },
    fetchDurationMs: { type: "integer", dataClass: "duration", required: false },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["review-target-resolution"],
  proofIds: ["review.target.resolved.line"],
  releaseImpact: "patch",
});

const REVIEW_TARGET_REFUSED = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "review.target.refused",
  category: "process",
  owner: "keiko-server",
  emitter: "review/activity-log.logReviewTargetRefused",
  fields: {
    targetKind: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["pull-request", "local-range"],
    },
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
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["review-target-resolution"],
  proofIds: ["review.target.refused.line"],
  releaseImpact: "patch",
});

const REVIEW_WORKTREE_CREATED = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "review.worktree.created",
  category: "process",
  owner: "keiko-server",
  emitter: "review/activity-log.logReviewWorktreeCreated",
  fields: {
    runDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    materializedCount: { type: "integer", dataClass: "count", required: true },
    skippedLargeCount: { type: "integer", dataClass: "count", required: true },
    skippedBinaryCount: { type: "integer", dataClass: "count", required: true },
    filterDriverCount: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "start",
  analyzerProjection: "timeline",
  failureClasses: ["review-worktree-lifecycle"],
  proofIds: ["review.worktree.created.line"],
  releaseImpact: "patch",
});

const REVIEW_WORKTREE_REFUSED = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "review.worktree.refused",
  category: "process",
  owner: "keiko-server",
  emitter: "review/activity-log.logReviewWorktreeRefused",
  fields: {
    runDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
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
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["review-worktree-lifecycle"],
  proofIds: ["review.worktree.refused.line"],
  releaseImpact: "patch",
});

const REVIEW_WORKTREE_REMOVED = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "review.worktree.removed",
  category: "process",
  owner: "keiko-server",
  emitter: "review/activity-log.logReviewWorktreeRemoved",
  fields: {
    runDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
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
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["review-worktree-lifecycle"],
  proofIds: ["review.worktree.removed.line"],
  releaseImpact: "patch",
});

const REVIEW_WORKTREE_ORPHAN_SWEPT = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "review.worktree.orphan-swept",
  category: "process",
  owner: "keiko-server",
  emitter: "review/activity-log.logReviewWorktreeOrphanSwept",
  fields: {
    removedCount: { type: "integer", dataClass: "count", required: true },
    failedCount: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["review-worktree-lifecycle"],
  proofIds: ["review.worktree.orphan-swept.line"],
  releaseImpact: "patch",
});

const REVIEW_WORKTREE_REFS_SWEPT = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "review.worktree.refs-swept",
  category: "process",
  owner: "keiko-server",
  emitter: "review/activity-log.logReviewRefsSwept",
  fields: {
    trigger: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["startup", "daily"],
    },
    deletedCount: { type: "integer", dataClass: "count", required: true },
    retainedCount: { type: "integer", dataClass: "count", required: true },
    failedCount: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["review-private-ref-retention"],
  proofIds: ["review.worktree.refs-swept.line"],
  releaseImpact: "patch",
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
