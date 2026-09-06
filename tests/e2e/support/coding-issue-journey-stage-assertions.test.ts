import { describe, expect, it } from "vitest";
import type { JourneyOutcome } from "@oscharko-dev/keiko-contracts";
import {
  ciRepairAssertions,
  governedMergeAndClosureEvidence,
} from "./coding-issue-journey-stage-assertions.js";

describe("coding issue journey stage assertions", () => {
  it("requires an actual failed check followed by readiness on a repaired head", () => {
    expect(() =>
      ciRepairAssertions({
        finalState: "technical-ready",
        observedFailureBeforeReady: false,
        requiredChecks: { total: 1, passed: 1, failed: 0, pending: 0, blocked: 0, unknown: 0 },
        failureHeadSha: undefined,
        finalHeadSha: "b".repeat(40),
      }),
    ).toThrow("ci-never-failed");

    expect(
      ciRepairAssertions({
        finalState: "technical-ready",
        observedFailureBeforeReady: true,
        requiredChecks: { total: 1, passed: 1, failed: 0, pending: 0, blocked: 0, unknown: 0 },
        failureHeadSha: "a".repeat(40),
        finalHeadSha: "b".repeat(40),
      }),
    ).toContain("ci-repair-evidence:observed-failure-repaired-fresh-head-ready");
  });

  it("requires provider-observed merge and bound issue closure", () => {
    expect(() =>
      governedMergeAndClosureEvidence({
        state: "blocked",
        reason: "readiness-blocked",
        remote: null,
      } as never),
    ).toThrow("merge and closure evidence is incomplete");

    const outcome = {
      state: "completed",
      reason: "merge-and-closure-observed",
      binding: {
        runId: "run-5",
        repository: "oscharko/Wegwerf-Repo",
        issueNumber: 6,
        prNumber: 11,
      },
      remote: {
        identity: { repository: "oscharko/Wegwerf-Repo", number: 11 },
        issue: {
          number: 6,
          state: "closed",
          closedAt: "2026-09-06T11:00:00.000Z",
        },
        mergedAt: "2026-09-06T10:59:00.000Z",
        mergeCommitSha: "a".repeat(40),
      },
    } as unknown as JourneyOutcome;
    expect(governedMergeAndClosureEvidence(outcome)).toMatchObject({
      mergeCommitSha: "a".repeat(40),
      assertions: [
        "governed-merge-confirmed:true",
        "provider-merge-observed:true",
        "bound-issue-closure-observed:true",
      ],
    });
  });
});
