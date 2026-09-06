import { describe, expect, it } from "vitest";
import type {
  CodeTaskGitCommitSha,
  CodeTaskScenarioId,
  CodeTaskSha256Digest,
  JourneyOutcome,
} from "@oscharko-dev/keiko-contracts";
import {
  CODE_TASK_QUALIFICATION_FLOW_TRANSITIONS,
  isCodeTaskGitCommitSha,
  isCodeTaskScenarioId,
  isCodeTaskSha256Digest,
} from "@oscharko-dev/keiko-contracts/runtime/code-task-acceptance";
import { JourneyObservationController } from "../../../packages/keiko-server/src/gitDelivery/journeyObservationService.js";
import { journeyFixture } from "../../../packages/keiko-server/src/gitDelivery/journeyOutcomeTest/_support.js";
import { DescriptionFixture } from "../../../packages/keiko-server/src/gitDelivery/prDescriptionTestSupport.js";
import {
  assertQualificationSpendEnvelope,
  buildQualificationFlowArtifact,
  hasRedGreenVerificationSequence,
  hasUsefulRepositorySearchSequence,
  isUsefulRepositorySearchEvent,
  qualifiedCiRepairAssertions,
  resolveFinalDeliveredPullRequest,
  selectedQualificationFlow,
  type QualificationFlowBinding,
} from "./coding-issue-journey-live-flow.js";
import { isScenarioSelected } from "./coding-issue-journey-scenarios.js";

function gitCommit(value: string): CodeTaskGitCommitSha {
  if (!isCodeTaskGitCommitSha(value)) throw new TypeError("fixture Git commit is invalid");
  return value;
}

function scenarioId(value: string): CodeTaskScenarioId {
  if (!isCodeTaskScenarioId(value)) throw new TypeError("fixture scenario id is invalid");
  return value;
}

function digest(value: string): CodeTaskSha256Digest {
  if (!isCodeTaskSha256Digest(value)) throw new TypeError("fixture digest is invalid");
  return value;
}

const HEAD_SHA = gitCommit("1".repeat(40));
const MERGE_SHA = gitCommit("2".repeat(40));
const SOURCE_SHA = gitCommit("3".repeat(40));
const REPAIRED_HEAD_SHA = "5".repeat(40);

const FLOW: QualificationFlowBinding = {
  flowId: scenarioId("issue-to-pr-flow-01"),
  ordinal: 1,
  repository: "oscharko/Wegwerf-Repo",
  issueNumber: 1,
  mode: "governed-assist",
};

const QUALIFICATION_OBSERVATIONS = {
  authorityObservation: {
    requestedMode: "governed-assist",
    effectiveMode: "governed-assist",
    approvalRequestCount: 1,
    approvalRequests: [
      { actionClass: "workspace-write", actionKind: "file-edit", requestCount: 1 },
    ],
    approvedProposalActions: [],
    toolInvocationCount: 2,
    effectStartedCount: 1,
    effectStartedTools: [
      { canonicalId: "keiko.changeset.edit", contractVersion: 1, invocationCount: 1 },
    ],
    completedToolCount: 2,
    deniedToolCount: 0,
    failedToolCount: 0,
    otherToolCount: 0,
  },
  rubricReview: {
    reviewId: "review-1",
    reviewDigest: digest("6".repeat(64)),
    verdict: "approved",
    flowId: FLOW.flowId,
    taskRunId: "run-1",
    repository: FLOW.repository,
    issueNumber: FLOW.issueNumber,
    pullRequestNumber: 7,
    pullRequestHeadSha: HEAD_SHA,
    sourceCommitSha: SOURCE_SHA,
    rubricDigest: digest("7".repeat(64)),
    criteriaTotal: 5,
    criteriaPassed: 5,
  },
  stageEvidence: {
    issueToPr: {
      scenarioId: scenarioId("issue-to-pr-governed-assist"),
      receiptDigest: digest("8".repeat(64)),
    },
    ciRepair: {
      scenarioId: scenarioId("ci-repair-loop"),
      receiptDigest: digest("9".repeat(64)),
    },
    description: {
      scenarioId: scenarioId("description-auto-draft-and-apply"),
      receiptDigest: digest("a".repeat(64)),
    },
    markReady: {
      scenarioId: scenarioId("mark-ready-intent"),
      receiptDigest: digest("b".repeat(64)),
    },
    governedMerge: {
      scenarioId: scenarioId("human-merge-and-closure"),
      receiptDigest: digest("c".repeat(64)),
    },
  },
} as const;

function technicalReadiness(): NonNullable<JourneyOutcome["readiness"]> {
  return {
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
  };
}

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
    // Production deliberately omits readiness once the remote PR is merged. The separately
    // captured exact-head pre-merge snapshot is supplied to the artifact builder.
    readiness: null,
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
      readiness: technicalReadiness(),
      sourceCommitSha: SOURCE_SHA,
      budgetNanoUsd: 50_000_000_000,
      previousCumulativeChargedNanoUsd: 0,
      cumulativeChargedNanoUsd: 3_240_000,
      ...QUALIFICATION_OBSERVATIONS,
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
        readiness: technicalReadiness(),
        sourceCommitSha: SOURCE_SHA,
        budgetNanoUsd: 50_000_000_000,
        previousCumulativeChargedNanoUsd: 0,
        cumulativeChargedNanoUsd: 3_240_000,
        ...QUALIFICATION_OBSERVATIONS,
      }),
    ).toThrow("completed merge and issue closure");
  });

  it("refuses non-monotonic durable spend and readiness from a different head", () => {
    expect(() =>
      buildQualificationFlowArtifact({
        flow: FLOW,
        outcome: completedOutcome(),
        readiness: technicalReadiness(),
        sourceCommitSha: SOURCE_SHA,
        budgetNanoUsd: 50_000_000_000,
        previousCumulativeChargedNanoUsd: 4_000_000,
        cumulativeChargedNanoUsd: 3_240_000,
        ...QUALIFICATION_OBSERVATIONS,
      }),
    ).toThrow("durable spend cumulative regressed");

    const outcome = completedOutcome();
    const mismatched = {
      ...outcome,
    };
    expect(() =>
      buildQualificationFlowArtifact({
        flow: FLOW,
        outcome: mismatched,
        readiness: { ...technicalReadiness(), headSha: "5".repeat(40) },
        sourceCommitSha: SOURCE_SHA,
        budgetNanoUsd: 50_000_000_000,
        previousCumulativeChargedNanoUsd: 0,
        cumulativeChargedNanoUsd: 3_240_000,
        ...QUALIFICATION_OBSERVATIONS,
      }),
    ).toThrow("exact merged head");
  });

  it("refuses a zero-check completion for the protected controlled repository", () => {
    const noChecks = {
      ...technicalReadiness(),
      requiredChecks: {
        total: 0,
        passed: 0,
        failed: 0,
        pending: 0,
        blocked: 0,
        unknown: 0,
      },
    };
    expect(() =>
      buildQualificationFlowArtifact({
        flow: FLOW,
        outcome: completedOutcome(),
        readiness: noChecks,
        sourceCommitSha: SOURCE_SHA,
        budgetNanoUsd: 50_000_000_000,
        previousCumulativeChargedNanoUsd: 0,
        cumulativeChargedNanoUsd: 3_240_000,
        ...QUALIFICATION_OBSERVATIONS,
      }),
    ).toThrow("passing checks on the exact merged head");
  });

  it("binds pre-merge readiness to the production observer's completed outcome", async () => {
    const source = journeyFixture();
    const sourceReadiness = source.readiness;
    if (sourceReadiness === null) {
      throw new Error("journey fixture must expose open-PR evidence");
    }
    const descriptionFixture = new DescriptionFixture();
    try {
      const artifact = await descriptionFixture.generateArtifact();
      const preview = await descriptionFixture.service.previewArtifact(artifact);
      if (preview.outcome !== "preview") throw new Error("description preview was unavailable");
      const approval = descriptionFixture.service.issueApproval(preview.preview.proposalId);
      const lease = descriptionFixture.service.consumeApproval(preview.preview.proposalId);
      if (approval === undefined || lease === undefined) {
        throw new Error("description approval was unavailable");
      }
      const applied = await descriptionFixture.service.executeApproved(
        preview.preview.proposalId,
        lease,
      );
      if (applied.outcome !== "observed") throw new Error("description apply was unavailable");
      descriptionFixture.remote = {
        ...descriptionFixture.remote,
        identity: { ...descriptionFixture.remote.identity, isDraft: false },
      };
      const reconciled = await descriptionFixture.service.reconcile();
      if (reconciled.outcome !== "observed") {
        throw new Error("description reconciliation was unavailable");
      }
      expect(reconciled.status.binding.isDraft).toBe(false);
      const identity = descriptionFixture.remote.identity;
      const draft = {
        ...source.draft,
        binding: {
          ...source.draft.binding,
          remoteDigest: reconciled.status.binding.remoteDigest,
          repository: identity.repository,
          baseRef: identity.baseRef,
          baseSha: identity.baseSha,
          headRef: identity.headRef,
          headSha: identity.headSha,
        },
        pullRequest: { ...identity, isDraft: true },
      };
      const context = {
        draft,
        accessScope: {},
        correlationId: "run-1",
        stillAuthorized: (): boolean => true,
      };
      let facts = {
        ...structuredClone(source.facts),
        identity,
        defaultBranchRef: identity.baseRef,
      };
      const description = reconciled.status;
      const readiness = {
        ...sourceReadiness,
        remoteDigest: draft.binding.remoteDigest,
        repository: draft.binding.repository,
        prNumber: identity.number,
        baseRef: identity.baseRef,
        baseSha: identity.baseSha,
        headRef: identity.headRef,
        headSha: identity.headSha,
        pullRequest: { ...sourceReadiness.pullRequest, isDraft: false },
        requiredChecks: {
          total: 1,
          passed: 1,
          failed: 0,
          pending: 0,
          blocked: 0,
          unknown: 0,
        },
      };
      const observe = async (): Promise<JourneyOutcome> => {
        const result = await new JourneyObservationController({
          context: (): typeof context => context,
          reader: (): { readonly readJourney: () => Promise<typeof facts> } => ({
            readJourney: (): Promise<typeof facts> => Promise.resolve(facts),
          }),
          readiness: (): Promise<typeof readiness> => Promise.resolve(readiness),
          description: (): Promise<typeof description> => Promise.resolve(description),
          recordOutcome: (): boolean => true,
          now: (): number => source.observedAtMs,
          activityLog: { write: (): void => undefined },
        }).observe();
        if (result.status !== "observed") {
          throw new Error(`fixture observation was unavailable: ${result.reason}`);
        }
        return result.outcome;
      };
      const beforeMerge = await observe();
      const mergedAt = new Date(source.observedAtMs - 2_000).toISOString();
      const closedAt = new Date(source.observedAtMs - 1_000).toISOString();
      facts = {
        ...facts,
        identity: { ...facts.identity, state: "closed", isDraft: false },
        mergedAt,
        mergeCommitSha: MERGE_SHA,
        issue: { ...facts.issue, state: "closed", closedAt },
      };
      const afterMerge = await observe();
      const afterMergeHeadSha = gitCommit(afterMerge.binding.headSha);

      expect(afterMerge.readiness).toBeNull();
      if (beforeMerge.readiness === null) throw new Error("pre-merge readiness was unavailable");
      expect(
        buildQualificationFlowArtifact({
          flow: {
            ...FLOW,
            repository: afterMerge.binding.repository,
            issueNumber: afterMerge.binding.issueNumber,
          },
          outcome: afterMerge,
          readiness: beforeMerge.readiness,
          sourceCommitSha: SOURCE_SHA,
          budgetNanoUsd: 50_000_000_000,
          previousCumulativeChargedNanoUsd: 0,
          cumulativeChargedNanoUsd: 3_240_000,
          ...QUALIFICATION_OBSERVATIONS,
          rubricReview: {
            ...QUALIFICATION_OBSERVATIONS.rubricReview,
            repository: afterMerge.binding.repository,
            issueNumber: afterMerge.binding.issueNumber,
            pullRequestNumber: afterMerge.binding.prNumber,
            pullRequestHeadSha: afterMergeHeadSha,
          },
        }),
      ).toMatchObject({ pullRequestHeadSha: afterMerge.binding.headSha });
    } finally {
      descriptionFixture.close();
    }
  });

  it("makes an ordinal-only invocation exclusive from legacy paid scenarios", () => {
    expect(
      isScenarioSelected("issue-to-pr-governed-assist", {
        KEIKO_QUALIFICATION_FLOW_ORDINAL: "1",
      }),
    ).toBe(false);
    expect(
      isScenarioSelected("issue-to-pr-governed-assist", {
        KEIKO_QUALIFICATION_FLOW_ORDINAL: "1",
        KEIKO_QUALIFICATION_SCENARIOS: "issue-to-pr-governed-assist",
      }),
    ).toBe(true);
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

  it("requires an observed failed verifier result before a later passing result", () => {
    const targetDigest = "d".repeat(64);
    const failed = {
      op: "coding-runtime.verification-summarized",
      verificationStatus: "failed",
      passedCount: 0,
      failedCount: 1,
      verificationTargetDigest: targetDigest,
    } as const;
    const passed = {
      op: "coding-runtime.verification-summarized",
      verificationStatus: "passed",
      passedCount: 4,
      failedCount: 0,
      verificationTargetDigest: targetDigest,
    } as const;
    const edit = {
      op: "coding-runtime.editor-mutation.settled",
      state: "succeeded",
    } as const;

    expect(hasRedGreenVerificationSequence([failed, edit, passed])).toBe(true);
    expect(hasRedGreenVerificationSequence([failed, passed])).toBe(false);
    expect(
      hasRedGreenVerificationSequence([
        failed,
        edit,
        { ...passed, verificationTargetDigest: "e".repeat(64) },
      ]),
    ).toBe(false);
    expect(hasRedGreenVerificationSequence([passed, failed])).toBe(false);
    expect(hasRedGreenVerificationSequence([passed])).toBe(false);
  });

  it("requires repository search first and a later bounded read of one returned path digest", () => {
    const hit = "a".repeat(64);
    const other = "b".repeat(64);
    const searchStart = {
      op: "tool-catalog.invocation-started",
      toolRef: { canonicalId: "keiko.repo.search", contractVersion: 1 },
    } as const;
    const searchSettled = {
      op: "coding-repository-handler.settled",
      state: "completed",
      resultCount: 1,
      resultPathSha256: [hit],
    } as const;
    const read = {
      op: "coding-runtime.workspace-read",
      state: "completed",
      targetPathSha256: hit,
    } as const;
    expect(hasUsefulRepositorySearchSequence([searchStart, searchSettled, read])).toBe(true);
    expect(
      hasUsefulRepositorySearchSequence([
        { ...searchStart, toolRef: { canonicalId: "keiko.workspace.read", contractVersion: 1 } },
        searchStart,
        searchSettled,
        read,
      ]),
    ).toBe(false);
    expect(
      hasUsefulRepositorySearchSequence([
        searchStart,
        searchSettled,
        { ...read, targetPathSha256: other },
      ]),
    ).toBe(false);
  });

  it("completes a green-first flow without fabricating CI-repair evidence", () => {
    const requiredChecks = technicalReadiness().requiredChecks;
    expect(
      qualifiedCiRepairAssertions({
        finalState: "technical-ready",
        observedFailureBeforeReady: false,
        requiredChecks,
        failureHeadSha: undefined,
        finalHeadSha: HEAD_SHA,
      }),
    ).toBeUndefined();
    expect(
      qualifiedCiRepairAssertions({
        finalState: "technical-ready",
        observedFailureBeforeReady: true,
        requiredChecks,
        failureHeadSha: HEAD_SHA,
        finalHeadSha: REPAIRED_HEAD_SHA,
      }),
    ).toContain("ci-repair-evidence:observed-failure-repaired-fresh-head-ready");
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
