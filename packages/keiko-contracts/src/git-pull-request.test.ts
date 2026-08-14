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

  // KEIKO-0479. The derivation counted the PR's own `draft-pr` advisory as a reason to keep it a
  // draft, so the two draft-lifecycle recommendations were exactly swapped: `update-to-ready` was
  // unreachable for a draft (the only PR it can apply to) and was emitted for PRs already ready.
  // The expectations below are the corrected behaviour, not the previously pinned inversion.
  it("recommends update-to-ready for a clean DRAFT PR — the only PR the promotion can apply to", () => {
    const draft = gitPullRequestReadinessFor(
      readinessInput({ pullRequest: prState({ isDraft: true }) }),
    );
    expect(draft.blockers.some((b) => b.code === "draft-pr")).toBe(true);
    expect(gitPullRequestRecommendationFor(draft, RISK_DRAFT)).toBe("update-to-ready");
  });

  it("recommends keep-as-draft for a draft PR that still has a non-draft advisory blocker", () => {
    const draft = gitPullRequestReadinessFor(
      readinessInput({
        pullRequest: prState({ isDraft: true }),
        checks: { total: 3, passing: 2, failing: 0, pending: 1, overallStatus: "pending" },
      }),
    );
    expect(draft.blockers.some((b) => b.code !== "draft-pr" && b.severity === "advisory")).toBe(
      true,
    );
    expect(gitPullRequestRecommendationFor(draft, RISK_DRAFT)).toBe("keep-as-draft");
  });

  it("recommends keep-as-is for an already-ready clean PR instead of a no-op promotion", () => {
    const ready = gitPullRequestReadinessFor(readinessInput({ pullRequest: prState() }));
    expect(ready.blockers).toHaveLength(0);
    expect(gitPullRequestRecommendationFor(ready, RISK_READY)).toBe("keep-as-is");
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

  // KEIKO-0475: the marker was optional and the scan global, so EVERY digit run in a branch name
  // became an issue ref — version numbers, encoding names, dates. Worse, the 7-digit cap is greedy
  // but bounded, so "12345678" produced a TRUNCATED ref plus a stray one ("#1234567" + "#8"). These
  // refs reach the PR preview, and a consumer rendering them as closing keywords would close
  // unrelated issues on merge.
  it.each([
    ["feat/v2-api"],
    ["fix/utf8-bug"],
    ["chore/bump-base64-dep"],
    ["feat/oauth2-flow"],
    ["fix/h264-decode"],
  ])("does not invent an issue ref from a mid-token digit run in %s", (branch) => {
    expect(gitPullRequestLinkageSuggestionsFor(branch)).toEqual({
      suggestedIssueRefs: [],
      basis: "none",
    });
  });

  it("never truncates a digit run longer than the cap into a different issue plus a stray ref", () => {
    const suggestion = gitPullRequestLinkageSuggestionsFor("fix/12345678-thing");
    expect(suggestion.suggestedIssueRefs).not.toContain("#1234567");
    expect(suggestion.suggestedIssueRefs).not.toContain("#8");
  });

  it("keeps both documented forms working", () => {
    expect(
      gitPullRequestLinkageSuggestionsFor("claude/issue-477-thing").suggestedIssueRefs,
    ).toEqual(["#477"]);
    expect(gitPullRequestLinkageSuggestionsFor("fix/1234-thing").suggestedIssueRefs).toEqual([
      "#1234",
    ]);
    expect(gitPullRequestLinkageSuggestionsFor("issue/88-thing").suggestedIssueRefs).toEqual([
      "#88",
    ]);
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

  // KEIKO-0329 (PR mirror): reviewReady implies the object exists and carries no blocking blocker,
  // and blocking entries precede advisory ones. Neither was checked.
  it("rejects a summary claiming reviewReady while carrying a blocking blocker", () => {
    const parsed = parseGitPullRequestReadinessSummary({
      schemaVersion: "1",
      objectExists: true,
      reviewReady: true,
      blockers: [{ code: "merge-conflict", severity: "blocking", remediation: "user-actionable" }],
    });
    expect(parsed.ok).toBe(false);
  });

  it("rejects a summary claiming reviewReady for a PR that does not exist", () => {
    expect(
      isGitPullRequestReadinessSummary({
        schemaVersion: "1",
        objectExists: false,
        reviewReady: true,
        blockers: [],
      }),
    ).toBe(false);
  });

  it("rejects blockers that are not severity-ranked", () => {
    expect(
      isGitPullRequestReadinessSummary({
        schemaVersion: "1",
        objectExists: true,
        reviewReady: false,
        blockers: [
          { code: "draft-pr", severity: "advisory", remediation: "user-actionable" },
          { code: "merge-conflict", severity: "blocking", remediation: "user-actionable" },
        ],
      }),
    ).toBe(false);
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
