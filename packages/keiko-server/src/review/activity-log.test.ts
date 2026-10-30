// Executable proofs for the review target and review worktree Activity Log operations (Issue
// #4133): every line passes the production formatter's identity and registration validation, and
// none carries a path, a ref name, a pull request title or a raw object id. The closed vocabularies
// are pinned to the contract constants they mirror.

import { describe, expect, it } from "vitest";
import {
  REVIEW_PULL_REQUEST_AVAILABILITY,
  REVIEW_TARGET_REFUSAL_REASONS,
  REVIEW_WORKTREE_REFUSAL_REASONS,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import { ACTIVITY_LOG_OPERATION_REGISTRY } from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { captureActivityLog } from "../activityLogCapture.test-support.js";
import {
  logReviewRefsSwept,
  logReviewTargetListed,
  logReviewTargetRefused,
  logReviewTargetResolved,
  logReviewWorktreeCreated,
  logReviewWorktreeOrphanSwept,
  logReviewWorktreeRefused,
  logReviewWorktreeRemoved,
} from "./activity-log.js";

const SHA = "d".repeat(40);
const CORRELATION = "review-proof";

function onlyLine(emit: (sink: ReturnType<typeof captureActivityLog>["sink"]) => void): string {
  const capture = captureActivityLog();
  emit(capture.sink);
  const [event] = capture.events;
  if (event === undefined || capture.events.length !== 1) throw new TypeError("expected one event");
  const line = formatActivityLogProofLine(event);
  expect(line).not.toContain(SHA);
  expect(line).not.toContain("/");
  return line;
}

describe("review Activity Log proofs", () => {
  it("proves review.target.listed", () => {
    const line = onlyLine((sink) => {
      logReviewTargetListed(sink, CORRELATION, {
        read: "list",
        availability: "available",
        count: 3,
        truncated: false,
        cacheHit: false,
        pages: 1,
        rejectedCount: 0,
      });
    });
    expect(expectActivityLogProof("review.target.listed.line", line)).toMatchObject({ count: 3 });
  });

  it("proves review.target.resolved with digests, never SHAs", () => {
    const line = onlyLine((sink) => {
      logReviewTargetResolved(sink, CORRELATION, {
        targetKind: "pull-request",
        baseSha: SHA,
        headSha: SHA,
        isCrossRepository: true,
        baseFetched: false,
        fetchDurationMs: 12,
        durationMs: 30,
      });
    });
    expect(expectActivityLogProof("review.target.resolved.line", line)).toMatchObject({
      targetKind: "pull-request",
      isCrossRepository: true,
    });
  });

  it("proves review.target.refused", () => {
    const line = onlyLine((sink) => {
      logReviewTargetRefused(sink, CORRELATION, "pull-request", "target-changed");
    });
    expect(expectActivityLogProof("review.target.refused.line", line)).toMatchObject({
      level: "warn",
      reason: "target-changed",
    });
  });

  it("proves review.worktree.created, refused and removed", () => {
    const created = onlyLine((sink) => {
      logReviewWorktreeCreated(sink, CORRELATION, {
        runId: "run-1",
        materializedCount: 4,
        skippedLargeCount: 1,
        skippedBinaryCount: 2,
        filterDriverCount: 1,
        durationMs: 40,
      });
    });
    expect(expectActivityLogProof("review.worktree.created.line", created)).toMatchObject({
      materializedCount: 4,
    });
    expect(created).not.toContain("run-1");
    const refused = onlyLine((sink) => {
      logReviewWorktreeRefused(sink, CORRELATION, "run-1", "case-collision", 5);
    });
    expect(expectActivityLogProof("review.worktree.refused.line", refused)).toMatchObject({
      reason: "case-collision",
    });
    const removed = onlyLine((sink) => {
      logReviewWorktreeRemoved(sink, CORRELATION, "run-1", "settled", "removed");
    });
    expect(expectActivityLogProof("review.worktree.removed.line", removed)).toMatchObject({
      trigger: "settled",
      outcome: "removed",
    });
  });

  it("proves review.worktree.orphan-swept and refs-swept", () => {
    const orphans = onlyLine((sink) => {
      logReviewWorktreeOrphanSwept(sink, CORRELATION, 2, 0);
    });
    expect(expectActivityLogProof("review.worktree.orphan-swept.line", orphans)).toMatchObject({
      removedCount: 2,
    });
    const refs = onlyLine((sink) => {
      logReviewRefsSwept(sink, CORRELATION, {
        trigger: "daily",
        deletedCount: 3,
        retainedCount: 1,
        failedCount: 0,
      });
    });
    expect(expectActivityLogProof("review.worktree.refs-swept.line", refs)).toMatchObject({
      deletedCount: 3,
    });
  });

  it("pins the closed vocabularies to the contract constants", () => {
    const values = (op: string, field: string): readonly unknown[] => {
      const registration = ACTIVITY_LOG_OPERATION_REGISTRY.find((entry) => entry.op === op);
      const fields = registration?.fields as Readonly<Record<string, unknown>> | undefined;
      const contract = fields?.[field] as { readonly values?: readonly unknown[] } | undefined;
      return contract?.values ?? [];
    };
    expect(values("review.target.listed", "availability")).toEqual([
      ...REVIEW_PULL_REQUEST_AVAILABILITY,
    ]);
    expect(values("review.target.refused", "reason")).toEqual([...REVIEW_TARGET_REFUSAL_REASONS]);
    expect(values("review.worktree.refused", "reason")).toEqual([
      ...REVIEW_WORKTREE_REFUSAL_REASONS,
    ]);
  });
});
