import { describe, expect, it } from "vitest";
import {
  deriveEligibleMergeStrategies,
  GIT_MERGE_READINESS_BLOCKER_CODES,
  GIT_MERGE_RECOMMENDATIONS,
  GIT_MERGE_REJECTION_DISPOSITION,
  GIT_MERGE_REJECTION_ERROR_CODE,
  GIT_MERGE_REJECTION_REASONS,
  GIT_MERGE_SCHEMA_VERSION,
  gitMergeBlockerActionHintFor,
  gitMergeBlockerRemediationFor,
  gitMergeReadinessBlockerIsPrerequisite,
  gitMergeReadinessFor,
  gitMergeRecommendationFor,
  gitMergeRejectionFor,
  gitMergeRejectionToDisposition,
  gitMergeRejectionToErrorCode,
  isGitMergeReadinessBlocker,
  isGitMergeReadinessBlockerCode,
  isGitMergeRecommendation,
  isGitMergeRejectionReason,
  isGitMergeReadinessSummary,
  parseGitMergeReadinessSummary,
  type GitMergeReadinessInput,
} from "./git-merge.js";
import { GIT_DELIVERY_MERGE_STRATEGY_HINTS } from "./git-delivery.js";
import type {
  GitDeliveryChecksState,
  GitDeliveryMergeReadiness,
  GitDeliveryPullRequestState,
} from "./git-delivery-provider.js";

function mergeReadiness(over: Partial<GitDeliveryMergeReadiness> = {}): GitDeliveryMergeReadiness {
  return {
    ready: true,
    requiredApprovalCount: 0,
    receivedApprovalCount: 0,
    ...over,
  };
}

function pullRequest(over: Partial<GitDeliveryPullRequestState> = {}): GitDeliveryPullRequestState {
  return {
    schemaVersion: "1",
    externalId: "42",
    status: "open",
    isDraft: false,
    headBranchName: "feat/x",
    baseBranchName: "main",
    mergeReadiness: mergeReadiness(),
    ...over,
  };
}

function checks(status: GitDeliveryChecksState["overallStatus"]): GitDeliveryChecksState {
  return { total: 3, passing: 3, failing: 0, pending: 0, overallStatus: status };
}

const codesOf = (input: GitMergeReadinessInput): readonly string[] =>
  gitMergeReadinessFor(input).blockers.map((b) => b.code);

describe("git-merge schema + tables", () => {
  it("pins the schema version", () => {
    expect(GIT_MERGE_SCHEMA_VERSION).toBe("1");
  });

  it("composes the readiness blocker codes from the merge-block reasons plus lifecycle states", () => {
    expect(GIT_MERGE_READINESS_BLOCKER_CODES).toContain("checks-failing");
    expect(GIT_MERGE_READINESS_BLOCKER_CODES).toContain("conflicts");
    expect(GIT_MERGE_READINESS_BLOCKER_CODES).toContain("merge-queue-position");
    expect(GIT_MERGE_READINESS_BLOCKER_CODES).toContain("pr-already-merged");
    expect(GIT_MERGE_READINESS_BLOCKER_CODES).toContain("readiness-unknown");
    // No duplicate codes.
    expect(new Set(GIT_MERGE_READINESS_BLOCKER_CODES).size).toBe(
      GIT_MERGE_READINESS_BLOCKER_CODES.length,
    );
  });

  it("classifies prerequisite vs lifecycle blocker codes", () => {
    expect(gitMergeReadinessBlockerIsPrerequisite("checks-failing")).toBe(true);
    expect(gitMergeReadinessBlockerIsPrerequisite("conflicts")).toBe(true);
    expect(gitMergeReadinessBlockerIsPrerequisite("pr-already-merged")).toBe(false);
    expect(gitMergeReadinessBlockerIsPrerequisite("readiness-unknown")).toBe(false);
  });

  it("provides a total remediation lookup for every blocker code", () => {
    for (const code of GIT_MERGE_READINESS_BLOCKER_CODES) {
      expect(["user-actionable", "internal"]).toContain(gitMergeBlockerRemediationFor(code));
    }
    expect(gitMergeBlockerRemediationFor("provider-error")).toBe("internal");
    expect(gitMergeBlockerRemediationFor("conflicts")).toBe("user-actionable");
  });

  it("provides an action-hint lookup for every blocker code", () => {
    for (const code of GIT_MERGE_READINESS_BLOCKER_CODES) {
      // Either undefined or a valid hint string — never throws.
      gitMergeBlockerActionHintFor(code);
    }
    expect(gitMergeBlockerActionHintFor("conflicts")).toBe("resolve-conflicts");
    expect(gitMergeBlockerActionHintFor("approvals-missing")).toBe("request-approval");
    expect(gitMergeBlockerActionHintFor("pr-already-merged")).toBeUndefined();
  });
});

describe("deriveEligibleMergeStrategies (AC2)", () => {
  it("returns the intersection of policy-permitted and provider-capable concrete strategies", () => {
    const result = deriveEligibleMergeStrategies(
      "squash",
      { allowedStrategies: ["squash", "rebase"] },
      ["squash", "merge-commit"],
    );
    expect(result.eligible).toEqual(["squash"]);
    expect(result.requestedEligible).toBe(true);
    expect(result.selectedDefault).toBe("squash");
  });

  it("falls back to the first eligible strategy when the requested one is not eligible", () => {
    const result = deriveEligibleMergeStrategies(
      "merge-commit",
      { allowedStrategies: ["squash", "rebase", "merge-commit"] },
      ["squash", "rebase"],
    );
    expect(result.eligible).toEqual(["squash", "rebase"]);
    expect(result.requestedEligible).toBe(false);
    expect(result.selectedDefault).toBe("squash");
  });

  it("treats provider-default as eligible only when policy permits it and a concrete strategy exists", () => {
    const withConcrete = deriveEligibleMergeStrategies(
      "provider-default",
      { allowedStrategies: ["squash", "provider-default"] },
      ["squash"],
    );
    expect(withConcrete.eligible).toEqual(["squash", "provider-default"]);
    expect(withConcrete.requestedEligible).toBe(true);

    const noConcrete = deriveEligibleMergeStrategies(
      "provider-default",
      { allowedStrategies: ["provider-default"] },
      ["squash"],
    );
    expect(noConcrete.eligible).toEqual([]);
    expect(noConcrete.requestedEligible).toBe(false);
    expect(noConcrete.selectedDefault).toBeUndefined();
  });

  it("returns the empty eligible set when policy and provider do not overlap", () => {
    const result = deriveEligibleMergeStrategies("squash", { allowedStrategies: ["squash"] }, [
      "rebase",
    ]);
    expect(result.eligible).toEqual([]);
    expect(result.requestedEligible).toBe(false);
    expect(result.selectedDefault).toBeUndefined();
  });

  it("preserves the canonical strategy order in the eligible set", () => {
    const result = deriveEligibleMergeStrategies(
      "rebase",
      { allowedStrategies: [...GIT_DELIVERY_MERGE_STRATEGY_HINTS] },
      ["merge-commit", "rebase", "squash"],
    );
    expect(result.eligible).toEqual(["squash", "rebase", "merge-commit", "provider-default"]);
  });
});

describe("gitMergeReadinessFor (AC1/AC3)", () => {
  it("is mergeable for an open, non-draft, ready PR with satisfied approvals", () => {
    const summary = gitMergeReadinessFor({
      pullRequest: pullRequest({
        mergeReadiness: mergeReadiness({
          ready: true,
          requiredApprovalCount: 1,
          receivedApprovalCount: 1,
        }),
      }),
      checks: checks("passing"),
      strategyEligible: true,
    });
    expect(summary.mergeable).toBe(true);
    expect(summary.blockers).toEqual([]);
  });

  it("blocks with provider-error when a provider read failed", () => {
    const summary = gitMergeReadinessFor({ providerError: true });
    expect(summary.mergeable).toBe(false);
    expect(codesOf({ providerError: true })).toEqual(["provider-error"]);
    expect(summary.blockers[0]?.remediation).toBe("internal");
  });

  it("blocks with readiness-unknown when no provider PR state is supplied", () => {
    expect(codesOf({})).toEqual(["readiness-unknown"]);
  });

  it("blocks with pr-already-merged for a merged PR", () => {
    expect(codesOf({ pullRequest: pullRequest({ status: "merged" }) })).toEqual([
      "pr-already-merged",
    ]);
  });

  it("blocks with pr-not-open for a closed PR", () => {
    expect(codesOf({ pullRequest: pullRequest({ status: "closed" }) })).toEqual(["pr-not-open"]);
  });

  it("blocks a draft PR", () => {
    expect(
      codesOf({ pullRequest: pullRequest({ isDraft: true }), strategyEligible: true }),
    ).toContain("draft-pr");
  });

  it("blocks with approvals-missing when received < required", () => {
    const summary = gitMergeReadinessFor({
      pullRequest: pullRequest({
        mergeReadiness: mergeReadiness({
          ready: false,
          blockingReason: "approvals-missing",
          requiredApprovalCount: 2,
          receivedApprovalCount: 1,
        }),
      }),
      strategyEligible: true,
    });
    expect(summary.blockers.map((b) => b.code)).toEqual(["approvals-missing"]);
    expect(summary.mergeable).toBe(false);
  });

  it("surfaces the provider blockingReason (conflicts) as a blocking blocker", () => {
    expect(
      codesOf({
        pullRequest: pullRequest({
          mergeReadiness: mergeReadiness({ ready: false, blockingReason: "conflicts" }),
        }),
        strategyEligible: true,
      }),
    ).toEqual(["conflicts"]);
  });

  it("adds checks-failing when not ready and the combined check status is failing", () => {
    const codes = codesOf({
      pullRequest: pullRequest({
        mergeReadiness: mergeReadiness({ ready: false, blockingReason: "branch-protection" }),
      }),
      checks: checks("failing"),
      strategyEligible: true,
    });
    expect(codes).toContain("branch-protection");
    expect(codes).toContain("checks-failing");
  });

  it("blocks with strategy-unavailable when the requested strategy is not eligible", () => {
    expect(codesOf({ pullRequest: pullRequest(), strategyEligible: false })).toContain(
      "strategy-unavailable",
    );
  });

  it("falls back to readiness-unknown when not ready and nothing concrete was surfaced", () => {
    expect(
      codesOf({
        pullRequest: pullRequest({ mergeReadiness: mergeReadiness({ ready: false }) }),
        strategyEligible: true,
      }),
    ).toEqual(["readiness-unknown"]);
  });

  it("emits an ADVISORY checks-failing when the PR is mergeable but checks are unstable", () => {
    const summary = gitMergeReadinessFor({
      pullRequest: pullRequest({ mergeReadiness: mergeReadiness({ ready: true }) }),
      checks: checks("failing"),
      strategyEligible: true,
    });
    expect(summary.mergeable).toBe(true);
    expect(summary.blockers).toEqual([
      { code: "checks-failing", severity: "advisory", remediation: "user-actionable" },
    ]);
  });

  it("orders blocking blockers before advisory blockers", () => {
    const summary = gitMergeReadinessFor({
      pullRequest: pullRequest({
        isDraft: true,
        mergeReadiness: mergeReadiness({ ready: true }),
      }),
      checks: checks("failing"),
      strategyEligible: true,
    });
    const severities = summary.blockers.map((b) => b.severity);
    const firstAdvisory = severities.indexOf("advisory");
    const lastBlocking = severities.lastIndexOf("blocking");
    expect(firstAdvisory === -1 || lastBlocking < firstAdvisory).toBe(true);
  });

  it("deduplicates a blockingReason that coincides with the approvals/checks derivation", () => {
    const summary = gitMergeReadinessFor({
      pullRequest: pullRequest({
        mergeReadiness: mergeReadiness({
          ready: false,
          blockingReason: "approvals-missing",
          requiredApprovalCount: 1,
          receivedApprovalCount: 0,
        }),
      }),
      strategyEligible: true,
    });
    expect(summary.blockers.filter((b) => b.code === "approvals-missing")).toHaveLength(1);
  });
});

describe("gitMergeRecommendationFor", () => {
  it("returns already-merged for a merged PR", () => {
    const readiness = gitMergeReadinessFor({ pullRequest: pullRequest({ status: "merged" }) });
    expect(
      gitMergeRecommendationFor(readiness, { requiresApproval: false, approvalSatisfied: false }),
    ).toBe("already-merged");
  });

  it("returns blocked when a blocking blocker is present", () => {
    const readiness = gitMergeReadinessFor({
      pullRequest: pullRequest({
        mergeReadiness: mergeReadiness({ ready: false, blockingReason: "conflicts" }),
      }),
      strategyEligible: true,
    });
    expect(
      gitMergeRecommendationFor(readiness, { requiresApproval: true, approvalSatisfied: true }),
    ).toBe("blocked");
  });

  it("returns needs-approval when mergeable but approval is required and not satisfied", () => {
    const readiness = gitMergeReadinessFor({
      pullRequest: pullRequest(),
      checks: checks("passing"),
      strategyEligible: true,
    });
    expect(
      gitMergeRecommendationFor(readiness, { requiresApproval: true, approvalSatisfied: false }),
    ).toBe("needs-approval");
  });

  it("returns merge-allowed when mergeable and approval is satisfied", () => {
    const readiness = gitMergeReadinessFor({
      pullRequest: pullRequest(),
      checks: checks("passing"),
      strategyEligible: true,
    });
    expect(
      gitMergeRecommendationFor(readiness, { requiresApproval: true, approvalSatisfied: true }),
    ).toBe("merge-allowed");
  });
});

describe("rejection taxonomy (AC4)", () => {
  it("maps every rejection reason to an error code and a disposition (total Records)", () => {
    for (const reason of GIT_MERGE_REJECTION_REASONS) {
      expect(GIT_MERGE_REJECTION_ERROR_CODE[reason]).toBeDefined();
      expect(GIT_MERGE_REJECTION_DISPOSITION[reason]).toBeDefined();
      expect(gitMergeRejectionToErrorCode(reason)).toBe(GIT_MERGE_REJECTION_ERROR_CODE[reason]);
      expect(gitMergeRejectionToDisposition(reason)).toBe(GIT_MERGE_REJECTION_DISPOSITION[reason]);
    }
  });

  it("classifies branch-protection and permission-denied as policy-forbidden", () => {
    expect(gitMergeRejectionToDisposition("branch-protection")).toBe("policy-forbidden");
    expect(gitMergeRejectionToDisposition("permission-denied")).toBe("policy-forbidden");
  });

  it("classifies transient failures as retryable", () => {
    expect(gitMergeRejectionToDisposition("rate-limited")).toBe("retryable");
    expect(gitMergeRejectionToDisposition("provider-unavailable")).toBe("retryable");
    expect(gitMergeRejectionToDisposition("head-modified")).toBe("retryable");
  });

  it("classifies an already-merged rejection as none", () => {
    expect(gitMergeRejectionToDisposition("already-merged")).toBe("none");
  });

  it("maps a conflict rejection to the conflict error code and resolve-conflicts hint", () => {
    const rejection = gitMergeRejectionFor("conflict");
    expect(rejection.reason).toBe("conflict");
    expect(rejection.disposition).toBe("user-fixable");
    expect(rejection.actionHint).toBe("resolve-conflicts");
    expect(gitMergeRejectionToErrorCode("conflict")).toBe("conflict");
  });

  it("omits the action hint where none fits cleanly", () => {
    expect(gitMergeRejectionFor("not-mergeable").actionHint).toBeUndefined();
    expect(gitMergeRejectionFor("already-merged").actionHint).toBeUndefined();
  });
});

describe("guards + parse", () => {
  it("validates blocker codes, recommendations, and rejection reasons", () => {
    expect(isGitMergeReadinessBlockerCode("conflicts")).toBe(true);
    expect(isGitMergeReadinessBlockerCode("nope")).toBe(false);
    expect(GIT_MERGE_RECOMMENDATIONS.every(isGitMergeRecommendation)).toBe(true);
    expect(isGitMergeRecommendation("merge")).toBe(false);
    expect(GIT_MERGE_REJECTION_REASONS.every(isGitMergeRejectionReason)).toBe(true);
    expect(isGitMergeRejectionReason("boom")).toBe(false);
  });

  it("validates a readiness blocker structurally", () => {
    expect(
      isGitMergeReadinessBlocker({
        code: "conflicts",
        severity: "blocking",
        remediation: "user-actionable",
      }),
    ).toBe(true);
    expect(
      isGitMergeReadinessBlocker({ code: "conflicts", severity: "loud", remediation: "x" }),
    ).toBe(false);
    expect(isGitMergeReadinessBlocker(null)).toBe(false);
  });

  it("round-trips a readiness summary through the structural guard and parser", () => {
    const summary = gitMergeReadinessFor({
      pullRequest: pullRequest(),
      checks: checks("passing"),
      strategyEligible: true,
    });
    expect(isGitMergeReadinessSummary(summary)).toBe(true);
    const parsed = parseGitMergeReadinessSummary(summary);
    expect(parsed.ok).toBe(true);
  });

  it("rejects an invalid readiness summary", () => {
    expect(isGitMergeReadinessSummary({ schemaVersion: "1", mergeable: "yes", blockers: [] })).toBe(
      false,
    );
    const parsed = parseGitMergeReadinessSummary({
      schemaVersion: "2",
      mergeable: true,
      blockers: [],
    });
    expect(parsed.ok).toBe(false);
  });
});
