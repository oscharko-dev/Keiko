import { describe, expect, it } from "vitest";
import type { JourneyOutcome } from "@oscharko-dev/keiko-contracts";
import { CODE_TASK_QUALIFICATION_FLOW_TRANSITIONS } from "@oscharko-dev/keiko-contracts/runtime/code-task-acceptance";
import {
  assertQualificationSpendEnvelope,
  buildQualificationFlowArtifact,
  isUsefulRepositorySearchEvent,
  resolveFinalDeliveredPullRequest,
  selectedQualificationFlow,
  type QualificationFlowBinding,
} from "./coding-issue-journey-live-flow.js";

const HEAD_SHA = "1".repeat(40);
const MERGE_SHA = "2".repeat(40);
const SOURCE_SHA = "3".repeat(40);
const REPAIRED_HEAD_SHA = "5".repeat(40);

const FLOW: QualificationFlowBinding = {
  flowId: "issue-to-pr-flow-01",
  ordinal: 1,
  repository: "oscharko/Wegwerf-Repo",
  issueNumber: 1,
  mode: "governed-assist",
};

function completedOutcome(): JourneyOutcome {
  return {
    schemaVersion: "1",
    binding: {
      runId: "run-1",
      remoteDigest: "a".repeat(64),
      issueBindingDigest: "b".repeat(64),
      issueIdDigest: "c".repeat(64),
      issueNumber: 1,
      repository: "oscharko/Wegwerf-Repo",
      prNumber: 7,
      prExternalId: "7",
      baseRef: "master",
      headRef: "keiko/issue-1",
      headSha: HEAD_SHA,
    },
    state: "completed",
    reason: "merge-and-closure-observed",
    observedAt: "2026-09-06T06:00:00Z",
    expiresAt: "2026-09-06T06:01:00Z",
    evidenceRef: "journey-run-1",
    remote: {
      status: "observed",
      identity: {
        number: 7,
        externalId: "7",
        url: "https://github.com/oscharko/Wegwerf-Repo/pull/7",
        repository: "oscharko/Wegwerf-Repo",
        headRepository: "oscharko/Wegwerf-Repo",
        headRef: "keiko/issue-1",
        headSha: HEAD_SHA,
        baseRef: "master",
        baseSha: "4".repeat(40),
        state: "closed",
        isDraft: false,
      },
      repositoryId: 42,
      defaultBranchRef: "master",
      mergedAt: "2026-09-06T05:59:00Z",
      mergeCommitSha: MERGE_SHA,
      reviewDecision: "approved",
      issue: { number: 1, state: "closed", closedAt: "2026-09-06T05:59:30Z" },
      reviewConversations: { total: 0, unresolved: 0, resolved: 0 },
      factsDigest: "d".repeat(64),
    },
    observationFailure: null,
    readiness: {
      schemaVersion: "1",
      runId: "run-1",
      remoteDigest: "a".repeat(64),
      repository: "oscharko/Wegwerf-Repo",
      prNumber: 7,
      baseRef: "master",
      baseSha: "4".repeat(40),
      headRef: "keiko/issue-1",
      headSha: HEAD_SHA,
      requirementsVersion: "1",
      requirementsDigest: "e".repeat(64),
      strictBaseRequired: false,
      observedAt: "2026-09-06T05:58:00Z",
      expiresAt: "2026-09-06T06:00:30Z",
      evidenceRef: "ci-run-1",
      complete: true,
      state: "technical-ready",
      reason: "required-checks-passed",
      requiredChecks: { total: 1, passed: 1, failed: 0, pending: 0, blocked: 0, unknown: 0 },
      advisoryChecks: { total: 0, passed: 0, failed: 0, pending: 0, blocked: 0, unknown: 0 },
      pullRequest: {
        status: "open",
        isDraft: false,
        conflict: "clear",
        baseCurrency: "current",
      },
      humanReview: {
        visibility: "complete",
        requiredCount: 0,
        approvedCount: 0,
        changesRequestedCount: 0,
      },
    },
    description: null,
    keikoDescriptionApplied: true,
  };
}

describe("completed live qualification flow evidence", () => {
  it("derives a selected flow from the checked-in acceptance descriptor", () => {
    expect(selectedQualificationFlow({ KEIKO_QUALIFICATION_FLOW_ORDINAL: "2" })).toEqual({
      flowId: "issue-to-pr-flow-02",
      ordinal: 2,
      repository: "oscharko/Wegwerf-Repo",
      issueNumber: 3,
      mode: "supervised-coding",
    });
    expect(selectedQualificationFlow({})).toBeUndefined();
    expect(() => selectedQualificationFlow({ KEIKO_QUALIFICATION_FLOW_ORDINAL: "6" })).toThrow(
      "select one flow from 1 through 5",
    );
  });

  it("binds the exact completed outcome and bridges all durable spend since the prior flow", () => {
    const artifact = buildQualificationFlowArtifact({
      flow: FLOW,
      outcome: completedOutcome(),
      sourceCommitSha: SOURCE_SHA,
      budgetNanoUsd: 50_000_000_000,
      previousCumulativeChargedNanoUsd: 0,
      cumulativeChargedNanoUsd: 3_240_000,
    });

    expect(artifact).toMatchObject({
      flowId: "issue-to-pr-flow-01",
      issueState: "closed",
      issueClosedAt: "2026-09-06T05:59:30Z",
      pullRequestState: "merged",
      pullRequestHeadSha: HEAD_SHA,
      pullRequestMergedAt: "2026-09-06T05:59:00Z",
      mergeCommitSha: MERGE_SHA,
      observedAt: "2026-09-06T06:00:00Z",
      requiredChecks: {
        observation: "observed",
        headSha: HEAD_SHA,
        total: 1,
        passed: 1,
        failed: 0,
        pending: 0,
      },
      transitions: CODE_TASK_QUALIFICATION_FLOW_TRANSITIONS,
      spend: {
        chargedDeltaNanoUsd: 3_240_000,
        cumulativeChargedNanoUsd: 3_240_000,
        remainingNanoUsd: 49_996_760_000,
      },
    });
  });

  it("refuses to mint completion evidence before merge and issue closure are observed", () => {
    const incomplete = {
      ...completedOutcome(),
      state: "ready-for-human-review",
      reason: "human-review-ready",
    } as const;

    expect(() =>
      buildQualificationFlowArtifact({
        flow: FLOW,
        outcome: incomplete,
        sourceCommitSha: SOURCE_SHA,
        budgetNanoUsd: 50_000_000_000,
        previousCumulativeChargedNanoUsd: 0,
        cumulativeChargedNanoUsd: 3_240_000,
      }),
    ).toThrow("completed merge and issue closure");
  });

  it("refuses non-monotonic durable spend and readiness from a different head", () => {
    expect(() =>
      buildQualificationFlowArtifact({
        flow: FLOW,
        outcome: completedOutcome(),
        sourceCommitSha: SOURCE_SHA,
        budgetNanoUsd: 50_000_000_000,
        previousCumulativeChargedNanoUsd: 4_000_000,
        cumulativeChargedNanoUsd: 3_240_000,
      }),
    ).toThrow("durable spend cumulative regressed");

    const outcome = completedOutcome();
    const mismatched = {
      ...outcome,
      readiness:
        outcome.readiness === null ? null : { ...outcome.readiness, headSha: "5".repeat(40) },
    };
    expect(() =>
      buildQualificationFlowArtifact({
        flow: FLOW,
        outcome: mismatched,
        sourceCommitSha: SOURCE_SHA,
        budgetNanoUsd: 50_000_000_000,
        previousCumulativeChargedNanoUsd: 0,
        cumulativeChargedNanoUsd: 3_240_000,
      }),
    ).toThrow("exact merged head");
  });

  it("refuses a zero-check completion for the protected controlled repository", () => {
    const outcome = completedOutcome();
    const noChecks = {
      ...outcome,
      readiness:
        outcome.readiness === null
          ? null
          : {
              ...outcome.readiness,
              requiredChecks: {
                total: 0,
                passed: 0,
                failed: 0,
                pending: 0,
                blocked: 0,
                unknown: 0,
              },
            },
    };
    expect(() =>
      buildQualificationFlowArtifact({
        flow: FLOW,
        outcome: noChecks,
        sourceCommitSha: SOURCE_SHA,
        budgetNanoUsd: 50_000_000_000,
        previousCumulativeChargedNanoUsd: 0,
        cumulativeChargedNanoUsd: 3_240_000,
      }),
    ).toThrow("passing checks on the exact merged head");
  });

  it("uses the product's final delivery binding after a legitimate CI repair", () => {
    const initial = {
      runId: "run-1",
      repository: FLOW.repository,
      number: 7,
      baseRef: "master",
      headRef: "keiko/issue-1",
      headSha: HEAD_SHA,
    } as const;
    const repaired = {
      runId: initial.runId,
      phase: "draft-created",
      reason: "completed",
      bindingHeadSha: REPAIRED_HEAD_SHA,
      pullRequest: { ...initial, headSha: REPAIRED_HEAD_SHA },
    } as const;

    expect(resolveFinalDeliveredPullRequest(initial, repaired, REPAIRED_HEAD_SHA)).toEqual({
      ...initial,
      headSha: REPAIRED_HEAD_SHA,
    });
    expect(() => resolveFinalDeliveredPullRequest(initial, repaired, HEAD_SHA)).toThrow(
      "exact CI-ready pull request head",
    );
  });

  it("reads flattened production activity facts for actual repository-search consumption", () => {
    expect(
      isUsefulRepositorySearchEvent({
        op: "coding-repository-handler.settled",
        state: "completed",
        resultCount: 2,
      }),
    ).toBe(true);
    expect(
      isUsefulRepositorySearchEvent({
        op: "coding-repository-handler.settled",
        extra: { state: "completed", resultCount: 2 },
      }),
    ).toBe(false);
  });

  it("fails before work when the durable ceiling exceeds authorization or changes mid-flow", () => {
    const authorized = { KEIKO_QUALIFICATION_SPEND_BUDGET_USD: "50" };
    const before = { ceiling: 50_000_000_000, charged: 3_240_000 };
    expect(assertQualificationSpendEnvelope(before, undefined, authorized)).toBe(50_000_000_000);
    expect(() =>
      assertQualificationSpendEnvelope(
        { ...before, ceiling: 50_000_000_001 },
        undefined,
        authorized,
      ),
    ).toThrow("authorized aggregate ceiling");
    expect(() =>
      assertQualificationSpendEnvelope(
        before,
        { ceiling: 49_000_000_000, charged: before.charged },
        authorized,
      ),
    ).toThrow("authorized monotonic envelope");
  });
});
