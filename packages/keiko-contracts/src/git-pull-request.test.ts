import { describe, expect, it } from "vitest";
import {
  GIT_PR_CHANGE_TYPES,
  GIT_PR_READINESS_BLOCKER_CODES,
  GIT_PR_RECOMMENDATIONS,
  GIT_PR_REJECTION_DISPOSITION,
  GIT_PR_REJECTION_ERROR_CODE,
  GIT_PR_REJECTION_REASONS,
  GIT_PULL_REQUEST_SCHEMA_VERSION,
  gitPrRejectionToDisposition,
  gitPrRejectionToErrorCode,
  gitPullRequestLabelSuggestionsFor,
  gitPullRequestLinkageSuggestionsFor,
  gitPullRequestReadinessFor,
  gitPullRequestRecommendationFor,
  gitPullRequestReviewerSuggestionsFor,
  isGitPullRequestReadinessSummary,
  parseGitPullRequestReadinessSummary,
  synthesizePullRequestMetadata,
  type GitPullRequestChangeNarrative,
  type GitPullRequestReadinessInput,
  type GitPullRequestRiskDigest,
} from "./git-pull-request.js";
import type {
  GitDeliveryChecksState,
  GitDeliveryMergeReadiness,
  GitDeliveryPullRequestState,
} from "./git-delivery-provider.js";

const NARRATIVE: GitPullRequestChangeNarrative = {
  commitCount: 3,
  fileCount: 12,
  areaCount: 1,
  areas: ["keiko-server"],
  touchesTests: true,
  changeType: "feat",
};

const RISK_DRAFT: GitPullRequestRiskDigest = {
  riskClass: "protected-or-merge",
  riskSeverity: 3,
  policyOutcome: "constrained",
  isDraft: true,
};

const RISK_READY: GitPullRequestRiskDigest = {
  riskClass: "protected-or-merge",
  riskSeverity: 3,
  policyOutcome: "allowed",
  isDraft: false,
};

function readinessInput(
  over: Partial<GitPullRequestReadinessInput> = {},
): GitPullRequestReadinessInput {
  return {
    headBranchName: "claude/issue-477-github-pr-command-center",
    baseBranchName: "feat/keiko-establish-governed-end-to-end-git-delivery",
    headPublished: true,
    baseExists: true,
    ...over,
  };
}

function prState(over: Partial<GitDeliveryPullRequestState> = {}): GitDeliveryPullRequestState {
  return {
    schemaVersion: "1",
    externalId: "1234",
    status: "open",
    isDraft: false,
    headBranchName: "claude/issue-477-github-pr-command-center",
    baseBranchName: "feat/keiko-establish-governed-end-to-end-git-delivery",
    mergeReadiness: { ready: true, requiredApprovalCount: 1, receivedApprovalCount: 1 },
    ...over,
  };
}

describe("metadata synthesis", () => {
  it("is deterministic for identical inputs", () => {
    const a = synthesizePullRequestMetadata(
      NARRATIVE,
      RISK_READY,
      "claude/issue-477-pr-center",
      "dev",
    );
    const b = synthesizePullRequestMetadata(
      NARRATIVE,
      RISK_READY,
      "claude/issue-477-pr-center",
      "dev",
    );
    expect(a).toEqual(b);
  });

  it("composes a content-free title scoped by the single dominant area and humanised branch slug", () => {
    const draft = synthesizePullRequestMetadata(
      NARRATIVE,
      RISK_READY,
      "claude/issue-477-github-pr-command-center",
      "dev",
    );
    expect(draft.composedTitle).toBe("feat(keiko-server): github pr command center");
    expect(draft.composedTitle.length).toBeLessThanOrEqual(72);
    expect(draft.schemaVersion).toBe(GIT_PULL_REQUEST_SCHEMA_VERSION);
  });

  it("drops the scope when the change spans multiple areas", () => {
    const multi: GitPullRequestChangeNarrative = {
      ...NARRATIVE,
      areaCount: 2,
      areas: ["keiko-server", "keiko-ui"],
      changeType: "mixed",
    };
    const draft = synthesizePullRequestMetadata(multi, RISK_READY, "fix/1234-thing", "dev");
    expect(draft.composedTitle).toBe("mixed: thing");
    expect(draft.summarySection.primaryArea).toBeUndefined();
  });

  it("marks requiresApproval only when the policy outcome is approval-gated", () => {
    const gated = synthesizePullRequestMetadata(
      NARRATIVE,
      { ...RISK_READY, policyOutcome: "approval-gated" },
      "x/y",
      "main",
    );
    expect(gated.riskSection.requiresApproval).toBe(true);
    const plain = synthesizePullRequestMetadata(NARRATIVE, RISK_READY, "x/y", "dev");
    expect(plain.riskSection.requiresApproval).toBe(false);
  });

  it("clamps a long title to 72 code units", () => {
    const draft = synthesizePullRequestMetadata(
      NARRATIVE,
      RISK_READY,
      "feat/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "dev",
    );
    expect(draft.composedTitle.length).toBeLessThanOrEqual(72);
  });
});

describe("readiness derivation", () => {
  it("objectExists is false and head-unpublished blocks when no provider state and head unpublished", () => {
    const summary = gitPullRequestReadinessFor(readinessInput({ headPublished: false }));
    expect(summary.objectExists).toBe(false);
    expect(summary.reviewReady).toBe(false);
    expect(
      summary.blockers.some((b) => b.code === "head-unpublished" && b.severity === "blocking"),
    ).toBe(true);
  });

  it("flags head-equals-base as a blocking blocker", () => {
    const summary = gitPullRequestReadinessFor(
      readinessInput({ headBranchName: "dev", baseBranchName: "dev" }),
    );
    expect(summary.blockers.some((b) => b.code === "head-equals-base")).toBe(true);
  });

  it("an open non-draft PR with clean checks is review-ready", () => {
    const summary = gitPullRequestReadinessFor(readinessInput({ pullRequest: prState() }));
    expect(summary.objectExists).toBe(true);
    expect(summary.reviewReady).toBe(true);
    expect(summary.blockers).toHaveLength(0);
  });

  it("a draft PR is not review-ready and surfaces an advisory draft-pr blocker", () => {
    const summary = gitPullRequestReadinessFor(
      readinessInput({ pullRequest: prState({ isDraft: true }) }),
    );
    expect(summary.objectExists).toBe(true);
    expect(summary.reviewReady).toBe(false);
    expect(summary.blockers.some((b) => b.code === "draft-pr" && b.severity === "advisory")).toBe(
      true,
    );
  });

  it("failing checks block review readiness and order before advisory blockers", () => {
    const checks: GitDeliveryChecksState = {
      total: 3,
      passing: 1,
      failing: 1,
      pending: 1,
      overallStatus: "failing",
    };
    const summary = gitPullRequestReadinessFor(
      readinessInput({ pullRequest: prState({ isDraft: true }), checks }),
    );
    expect(summary.reviewReady).toBe(false);
    expect(summary.blockers[0]?.severity).toBe("blocking");
    expect(summary.blockers.some((b) => b.code === "required-checks-failing")).toBe(true);
  });

  it("maps a merge conflict to a blocking blocker and missing approvals to an advisory one", () => {
    const conflict: GitDeliveryMergeReadiness = {
      ready: false,
      blockingReason: "conflicts",
      requiredApprovalCount: 1,
      receivedApprovalCount: 0,
    };
    const conflicted = gitPullRequestReadinessFor(
      readinessInput({ pullRequest: prState(), mergeReadiness: conflict }),
    );
    expect(
      conflicted.blockers.some((b) => b.code === "merge-conflict" && b.severity === "blocking"),
    ).toBe(true);

    const approvals: GitDeliveryMergeReadiness = {
      ready: false,
      blockingReason: "approvals-missing",
      requiredApprovalCount: 2,
      receivedApprovalCount: 0,
    };
    const needsApproval = gitPullRequestReadinessFor(
      readinessInput({ pullRequest: prState(), mergeReadiness: approvals }),
    );
    expect(
      needsApproval.blockers.some(
        (b) => b.code === "approval-insufficient" && b.severity === "advisory",
      ),
    ).toBe(true);
  });

  it("surfaces an internal provider-error blocker when the provider read failed", () => {
    const summary = gitPullRequestReadinessFor(readinessInput({ providerError: true }));
    expect(
      summary.blockers.some((b) => b.code === "provider-error" && b.remediation === "internal"),
    ).toBe(true);
  });
});

describe("recommendation derivation", () => {
  it("recommends blocked when a blocking blocker is present", () => {
    const summary = gitPullRequestReadinessFor(readinessInput({ headPublished: false }));
    expect(gitPullRequestRecommendationFor(summary, RISK_READY)).toBe("blocked");
  });

  it("recommends create-as-draft vs create-as-ready by draft intent when no PR exists", () => {
    const clean = gitPullRequestReadinessFor(readinessInput());
    expect(gitPullRequestRecommendationFor(clean, RISK_DRAFT)).toBe("create-as-draft");
    expect(gitPullRequestRecommendationFor(clean, RISK_READY)).toBe("create-as-ready");
  });

  it("recommends update-to-ready for a clean existing PR and keep-as-draft when advisory blockers remain", () => {
    const ready = gitPullRequestReadinessFor(readinessInput({ pullRequest: prState() }));
    expect(gitPullRequestRecommendationFor(ready, RISK_READY)).toBe("update-to-ready");

    const draft = gitPullRequestReadinessFor(
      readinessInput({ pullRequest: prState({ isDraft: true }) }),
    );
    expect(gitPullRequestRecommendationFor(draft, RISK_DRAFT)).toBe("keep-as-draft");
  });
});

describe("suggestion derivations", () => {
  it("derives labels from the change type and area tokens deterministically", () => {
    const s = gitPullRequestLabelSuggestionsFor(NARRATIVE);
    expect(s.basis).toBe("change-type");
    expect(s.suggestedLabelNames).toContain("enhancement");
    expect(s.suggestedLabelNames).toContain("area:keiko-server");
  });

  it("extracts issue refs from the head branch name", () => {
    expect(gitPullRequestLinkageSuggestionsFor("claude/issue-477-x").suggestedIssueRefs).toEqual([
      "#477",
    ]);
    expect(gitPullRequestLinkageSuggestionsFor("fix/1234-thing").suggestedIssueRefs).toEqual([
      "#1234",
    ]);
    expect(gitPullRequestLinkageSuggestionsFor("chore/no-number").basis).toBe("none");
  });

  it("returns no reviewer suggestion without an area→owners map and maps owners when provided", () => {
    expect(gitPullRequestReviewerSuggestionsFor(NARRATIVE).basis).toBe("none");
    const mapped = gitPullRequestReviewerSuggestionsFor(NARRATIVE, {
      "keiko-server": ["alice", "bob"],
    });
    expect(mapped.basis).toBe("area-ownership");
    expect(mapped.suggestedReviewerIds).toEqual(["alice", "bob"]);
  });
});

describe("rejection taxonomy", () => {
  it("maps every rejection reason exhaustively to an error code and disposition", () => {
    for (const reason of GIT_PR_REJECTION_REASONS) {
      expect(GIT_PR_REJECTION_ERROR_CODE[reason]).toBeDefined();
      expect(GIT_PR_REJECTION_DISPOSITION[reason]).toBeDefined();
      expect(gitPrRejectionToErrorCode(reason)).toBe(GIT_PR_REJECTION_ERROR_CODE[reason]);
      expect(gitPrRejectionToDisposition(reason)).toBe(GIT_PR_REJECTION_DISPOSITION[reason]);
    }
  });

  it("treats rate-limited and provider-unavailable as retryable", () => {
    expect(gitPrRejectionToDisposition("rate-limited")).toBe("retryable");
    expect(gitPrRejectionToDisposition("provider-unavailable")).toBe("retryable");
    expect(gitPrRejectionToDisposition("validation-error")).toBe("user-fixable");
  });
});

describe("guards and parse", () => {
  it("round-trips a valid readiness summary", () => {
    const summary = gitPullRequestReadinessFor(readinessInput({ pullRequest: prState() }));
    expect(isGitPullRequestReadinessSummary(summary)).toBe(true);
    const parsed = parseGitPullRequestReadinessSummary(summary);
    expect(parsed.ok).toBe(true);
  });

  it("rejects a malformed readiness summary", () => {
    expect(isGitPullRequestReadinessSummary({ objectExists: true })).toBe(false);
    const parsed = parseGitPullRequestReadinessSummary({ nope: 1 });
    expect(parsed.ok).toBe(false);
  });

  it("pins the public enum arrays", () => {
    expect(GIT_PR_CHANGE_TYPES).toContain("feat");
    expect(GIT_PR_READINESS_BLOCKER_CODES).toContain("head-unpublished");
    expect(GIT_PR_RECOMMENDATIONS).toContain("create-as-draft");
  });
});
