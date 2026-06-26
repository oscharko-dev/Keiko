// Behavioral tests for git-delivery.ts (Issue #471, Epic #470). Covers every exported guard
// (positive AND negative), every parser (ok path + each distinct error path), the risk-class
// classifiers (incl. fail-closed and force-push escalation), the typed branch matchers, the
// risk-class ceiling, and the envelope soundness invariant (kind === resolvedInputs.kind).

import { describe, expect, it } from "vitest";

import {
  GIT_DELIVERY_ACTION_KINDS,
  GIT_DELIVERY_ACTION_RISK_DEFAULTS,
  GIT_DELIVERY_RISK_CLASS_SEVERITY,
  GIT_DELIVERY_SCHEMA_VERSION,
  gitDeliveryBranchNameMatchesAny,
  gitDeliveryBranchNameMatchesPattern,
  gitDeliveryDefaultRiskClass,
  gitDeliveryRiskClassForInputs,
  gitDeliveryRiskClassWithinCeiling,
  isGitDeliveryAbortableOperation,
  isGitDeliveryActionKind,
  isGitDeliveryApprovalRequirement,
  isGitDeliveryBlockReason,
  isGitDeliveryBranchMatchKind,
  isGitDeliveryBranchPattern,
  isGitDeliveryConstraint,
  isGitDeliveryEvidenceRef,
  isGitDeliveryExecutionErrorCode,
  isGitDeliveryExecutionOutcome,
  isGitDeliveryExecutionResult,
  isGitDeliveryMergeBlockReason,
  isGitDeliveryMergeStrategyHint,
  isGitDeliveryPolicyDecision,
  isGitDeliveryProviderCapability,
  isGitDeliveryRecoveryStrategyHint,
  isGitDeliveryRiskClass,
  parseGitDeliveryActionEnvelope,
  parseGitDeliveryResolvedInputs,
} from "./git-delivery.js";
import type {
  GitDeliveryBranchPattern,
  GitDeliveryPushInputs,
  GitDeliveryResolvedInputs,
} from "./git-delivery.js";

// A 64-char lowercase hex string for the approval-token-shape check.
const TOKEN_HASH = "a".repeat(64);

describe("git-delivery action-kind / risk-class guards", () => {
  it("isGitDeliveryActionKind accepts known kinds and rejects unknowns", () => {
    expect(isGitDeliveryActionKind("commit")).toBe(true);
    expect(isGitDeliveryActionKind("recovery")).toBe(true);
    expect(isGitDeliveryActionKind("branch-switch")).toBe(true);
    expect(isGitDeliveryActionKind("rm")).toBe(false);
    expect(isGitDeliveryActionKind(42)).toBe(false);
    expect(isGitDeliveryActionKind(undefined)).toBe(false);
  });

  it("GIT_DELIVERY_ACTION_KINDS pins the cardinality and includes branch-switch", () => {
    expect(GIT_DELIVERY_ACTION_KINDS).toHaveLength(11);
    expect(GIT_DELIVERY_ACTION_KINDS).toContain("branch-switch");
    expect(new Set(GIT_DELIVERY_ACTION_KINDS).size).toBe(GIT_DELIVERY_ACTION_KINDS.length);
    // The risk-default table is exhaustive over the kinds (one entry per kind).
    expect(Object.keys(GIT_DELIVERY_ACTION_RISK_DEFAULTS)).toHaveLength(11);
    expect(GIT_DELIVERY_ACTION_RISK_DEFAULTS["branch-switch"]).toBe("local-mutation");
  });

  it("isGitDeliveryRiskClass discriminates the four classes", () => {
    expect(isGitDeliveryRiskClass("local-mutation")).toBe(true);
    expect(isGitDeliveryRiskClass("recovery-or-rewrite")).toBe(true);
    expect(isGitDeliveryRiskClass("nuclear")).toBe(false);
    expect(isGitDeliveryRiskClass(null)).toBe(false);
  });

  it("isGitDeliveryProviderCapability guards the five capabilities", () => {
    expect(isGitDeliveryProviderCapability("merge-queue")).toBe(true);
    expect(isGitDeliveryProviderCapability("warp-drive")).toBe(false);
  });

  it("isGitDeliveryBranchMatchKind guards exact/prefix only", () => {
    expect(isGitDeliveryBranchMatchKind("exact")).toBe(true);
    expect(isGitDeliveryBranchMatchKind("prefix")).toBe(true);
    expect(isGitDeliveryBranchMatchKind("glob")).toBe(false);
  });

  it("isGitDeliveryBlockReason includes the fail-closed no-applicable-rule", () => {
    expect(isGitDeliveryBlockReason("no-applicable-rule")).toBe(true);
    expect(isGitDeliveryBlockReason("policy-pack-blocked")).toBe(true);
    expect(isGitDeliveryBlockReason("vibes")).toBe(false);
  });

  it("isGitDeliveryMergeBlockReason guards the six merge block reasons", () => {
    expect(isGitDeliveryMergeBlockReason("checks-failing")).toBe(true);
    expect(isGitDeliveryMergeBlockReason("no-applicable-rule")).toBe(false);
  });

  it("isGitDeliveryMergeStrategyHint / AbortableOperation / RecoveryStrategyHint guards", () => {
    expect(isGitDeliveryMergeStrategyHint("squash")).toBe(true);
    expect(isGitDeliveryMergeStrategyHint("fast-forward")).toBe(false);
    expect(isGitDeliveryAbortableOperation("bisect")).toBe(true);
    expect(isGitDeliveryAbortableOperation("commit")).toBe(false);
    expect(isGitDeliveryRecoveryStrategyHint("stash-and-reset")).toBe(true);
    expect(isGitDeliveryRecoveryStrategyHint("hard-reset")).toBe(false);
  });

  it("isGitDeliveryExecutionOutcome / ExecutionErrorCode guards", () => {
    expect(isGitDeliveryExecutionOutcome("partial")).toBe(true);
    expect(isGitDeliveryExecutionOutcome("ok")).toBe(false);
    expect(isGitDeliveryExecutionErrorCode("timeout")).toBe(true);
    expect(isGitDeliveryExecutionErrorCode("boom")).toBe(false);
  });
});

describe("git-delivery branch-pattern and constraint guards", () => {
  it("isGitDeliveryBranchPattern requires matchKind and a non-empty value", () => {
    expect(isGitDeliveryBranchPattern({ matchKind: "exact", value: "main" })).toBe(true);
    expect(isGitDeliveryBranchPattern({ matchKind: "prefix", value: "release/" })).toBe(true);
    expect(isGitDeliveryBranchPattern({ matchKind: "glob", value: "main" })).toBe(false);
    expect(isGitDeliveryBranchPattern({ matchKind: "exact", value: "" })).toBe(false);
    expect(isGitDeliveryBranchPattern(null)).toBe(false);
  });

  it("isGitDeliveryConstraint discriminates all three constraint kinds", () => {
    expect(
      isGitDeliveryConstraint({
        kind: "branch-pattern",
        patterns: [{ matchKind: "exact", value: "main" }],
      }),
    ).toBe(true);
    expect(
      isGitDeliveryConstraint({ kind: "provider-capability", capability: "required-checks" }),
    ).toBe(true);
    expect(isGitDeliveryConstraint({ kind: "risk-class-ceiling", maxRiskClass: "publish" })).toBe(
      true,
    );
  });

  it("isGitDeliveryConstraint rejects malformed and unknown-kind constraints", () => {
    expect(isGitDeliveryConstraint({ kind: "min-risk-class", riskClass: "publish" })).toBe(false);
    expect(isGitDeliveryConstraint({ kind: "branch-pattern", patterns: ["main"] })).toBe(false);
    expect(isGitDeliveryConstraint({ kind: "provider-capability", capability: "nope" })).toBe(
      false,
    );
    expect(isGitDeliveryConstraint({ kind: "risk-class-ceiling", maxRiskClass: "nope" })).toBe(
      false,
    );
    expect(isGitDeliveryConstraint(42)).toBe(false);
  });
});

describe("git-delivery approval / policy-decision / evidence / execution-result guards", () => {
  it("isGitDeliveryApprovalRequirement accepts both discriminants", () => {
    expect(isGitDeliveryApprovalRequirement({ required: false })).toBe(true);
    expect(
      isGitDeliveryApprovalRequirement({
        required: true,
        approvalTokenHash: TOKEN_HASH,
        approvedByUserId: "u-1",
        approvedAtMs: 1,
      }),
    ).toBe(true);
    expect(
      isGitDeliveryApprovalRequirement({
        required: true,
        approvalTokenHash: TOKEN_HASH,
        approvedByUserId: "u-1",
        approvedAtMs: 1,
        expiresAtMs: 99,
      }),
    ).toBe(true);
  });

  it("isGitDeliveryApprovalRequirement rejects a malformed token hash and missing fields", () => {
    expect(
      isGitDeliveryApprovalRequirement({
        required: true,
        approvalTokenHash: "short",
        approvedByUserId: "u-1",
        approvedAtMs: 1,
      }),
    ).toBe(false);
    expect(
      isGitDeliveryApprovalRequirement({
        required: true,
        approvalTokenHash: TOKEN_HASH,
        approvedByUserId: "",
        approvedAtMs: 1,
      }),
    ).toBe(false);
    expect(isGitDeliveryApprovalRequirement({ required: "yes" })).toBe(false);
    expect(isGitDeliveryApprovalRequirement(null)).toBe(false);
  });

  it("isGitDeliveryPolicyDecision validates every outcome and rejects unknowns", () => {
    expect(isGitDeliveryPolicyDecision({ outcome: "allowed" })).toBe(true);
    expect(isGitDeliveryPolicyDecision({ outcome: "blocked", reason: "protected-branch" })).toBe(
      true,
    );
    expect(
      isGitDeliveryPolicyDecision({ outcome: "approval-gated", requiredApprovers: ["lead"] }),
    ).toBe(true);
    expect(
      isGitDeliveryPolicyDecision({
        outcome: "constrained",
        constraints: [{ kind: "provider-capability", capability: "merge-queue" }],
      }),
    ).toBe(true);
    expect(isGitDeliveryPolicyDecision({ outcome: "blocked", reason: "made-up" })).toBe(false);
    expect(isGitDeliveryPolicyDecision({ outcome: "approval-gated", requiredApprovers: [1] })).toBe(
      false,
    );
    expect(
      isGitDeliveryPolicyDecision({ outcome: "constrained", constraints: [{ kind: "x" }] }),
    ).toBe(false);
    expect(isGitDeliveryPolicyDecision({ outcome: "frozen" })).toBe(false);
  });

  it("isGitDeliveryEvidenceRef requires both opaque references", () => {
    expect(
      isGitDeliveryEvidenceRef({
        sourceGroundedRunId: "run-1",
        evidenceManifestStableIdHash: "deadbeef",
      }),
    ).toBe(true);
    expect(isGitDeliveryEvidenceRef({ sourceGroundedRunId: "run-1" })).toBe(false);
    expect(
      isGitDeliveryEvidenceRef({ sourceGroundedRunId: "", evidenceManifestStableIdHash: "x" }),
    ).toBe(false);
  });

  it("isGitDeliveryExecutionResult validates outcome, errorCode, and partialDetail", () => {
    expect(
      isGitDeliveryExecutionResult({
        schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
        outcome: "succeeded",
        durationMs: 5,
      }),
    ).toBe(true);
    expect(
      isGitDeliveryExecutionResult({
        schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
        outcome: "partial",
        durationMs: 5,
        errorCode: "conflict",
        partialDetail: { attemptedUnitCount: 3, succeededUnitCount: 1 },
      }),
    ).toBe(true);
    expect(
      isGitDeliveryExecutionResult({
        schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
        outcome: "failed",
        durationMs: 5,
        errorCode: "free-form-string",
      }),
    ).toBe(false);
    expect(
      isGitDeliveryExecutionResult({
        schemaVersion: "2",
        outcome: "succeeded",
        durationMs: 5,
      }),
    ).toBe(false);
    expect(
      isGitDeliveryExecutionResult({
        schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
        outcome: "partial",
        durationMs: 5,
        partialDetail: { attemptedUnitCount: -1, succeededUnitCount: 1 },
      }),
    ).toBe(false);
  });
});

describe("parseGitDeliveryResolvedInputs", () => {
  it("parses every action kind on the ok path", () => {
    const cases: readonly Record<string, unknown>[] = [
      { kind: "branch-create", branchName: "f", baseBranchName: "main", startPointRefHash: "h" },
      { kind: "branch-switch", branchName: "main" },
      { kind: "stage", pathCount: 2, includesUntracked: false },
      { kind: "unstage", pathCount: 1 },
      { kind: "commit", messageByteLength: 10, stagedPathCount: 1, allowEmptyCommit: false },
      {
        kind: "push",
        sourceBranchName: "f",
        remoteAlias: "origin",
        remoteBranchName: "f",
        forcePush: false,
        setUpstreamTracking: true,
      },
      {
        kind: "pr-create",
        headBranchName: "f",
        baseBranchName: "main",
        titleByteLength: 5,
        bodyByteLength: 9,
        isDraft: true,
      },
      {
        kind: "pr-update",
        prExternalId: "42",
        headBranchName: "f",
        baseBranchName: "main",
        titleByteLength: 5,
        bodyByteLength: 9,
        convertToDraft: false,
        convertFromDraft: true,
      },
      {
        kind: "merge",
        prExternalId: "42",
        mergeStrategyHint: "squash",
        deleteBranchAfterMerge: true,
      },
      { kind: "abort", operationToAbort: "rebase", preserveIndexChanges: false },
      {
        kind: "recovery",
        recoveryStrategyHint: "soft-reset",
        targetRefHash: "h",
        affectedPathCount: 3,
      },
    ];
    for (const value of cases) {
      const result = parseGitDeliveryResolvedInputs(value);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.kind).toBe(value.kind);
      }
    }
  });

  it("rejects a non-object", () => {
    const result = parseGitDeliveryResolvedInputs("nope");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain("must be an object");
    }
  });

  it("rejects an unknown kind", () => {
    const result = parseGitDeliveryResolvedInputs({ kind: "force-push" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain("known GitDeliveryActionKind");
    }
  });

  it("rejects a known kind with invalid fields", () => {
    const result = parseGitDeliveryResolvedInputs({ kind: "stage", pathCount: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain('kind "stage"');
    }
  });

  it("accepts a branch-switch with a non-empty branchName and rejects an empty one", () => {
    const ok = parseGitDeliveryResolvedInputs({ kind: "branch-switch", branchName: "main" });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.kind).toBe("branch-switch");
    }
    const empty = parseGitDeliveryResolvedInputs({ kind: "branch-switch", branchName: "" });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.errors[0]).toContain('kind "branch-switch"');
    }
    const missing = parseGitDeliveryResolvedInputs({ kind: "branch-switch" });
    expect(missing.ok).toBe(false);
  });
});

describe("parseGitDeliveryActionEnvelope (soundness: kind === resolvedInputs.kind)", () => {
  const validPushInputs: GitDeliveryPushInputs = {
    kind: "push",
    sourceBranchName: "f",
    remoteAlias: "origin",
    remoteBranchName: "f",
    forcePush: false,
    setUpstreamTracking: true,
  };

  function baseEnvelope(): Record<string, unknown> {
    return {
      schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
      actionId: "act-1",
      kind: "push",
      resolvedInputs: validPushInputs,
      policyDecision: { outcome: "allowed" },
      approvalRequirement: { required: false },
    };
  }

  it("parses a sound envelope on the ok path", () => {
    const result = parseGitDeliveryActionEnvelope(baseEnvelope());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("push");
    }
  });

  it("parses an envelope with optional preview / executionResult / evidenceRef", () => {
    const result = parseGitDeliveryActionEnvelope({
      ...baseEnvelope(),
      preview: {
        schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
        wouldCreateRemoteBranch: true,
        wouldTriggerChecks: false,
      },
      executionResult: {
        schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
        outcome: "succeeded",
        durationMs: 3,
      },
      evidenceRef: { sourceGroundedRunId: "run-1", evidenceManifestStableIdHash: "h" },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a non-object", () => {
    const result = parseGitDeliveryActionEnvelope(7);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain("envelope must be an object");
    }
  });

  it("propagates resolvedInputs parse errors", () => {
    const result = parseGitDeliveryActionEnvelope({
      ...baseEnvelope(),
      resolvedInputs: { kind: "push" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain('kind "push"');
    }
  });

  it("rejects a kind that disagrees with resolvedInputs.kind", () => {
    const result = parseGitDeliveryActionEnvelope({ ...baseEnvelope(), kind: "commit" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain("must equal envelope.resolvedInputs.kind");
    }
  });

  it("rejects a wrong schemaVersion", () => {
    const result = parseGitDeliveryActionEnvelope({ ...baseEnvelope(), schemaVersion: "2" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("schemaVersion"))).toBe(true);
    }
  });

  it("rejects an empty actionId", () => {
    const result = parseGitDeliveryActionEnvelope({ ...baseEnvelope(), actionId: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("actionId"))).toBe(true);
    }
  });

  it("rejects an invalid policyDecision", () => {
    const result = parseGitDeliveryActionEnvelope({
      ...baseEnvelope(),
      policyDecision: { outcome: "frozen" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("policyDecision"))).toBe(true);
    }
  });

  it("rejects an invalid approvalRequirement", () => {
    const result = parseGitDeliveryActionEnvelope({
      ...baseEnvelope(),
      approvalRequirement: { required: true },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("approvalRequirement"))).toBe(true);
    }
  });

  it("rejects an invalid optional preview", () => {
    const result = parseGitDeliveryActionEnvelope({
      ...baseEnvelope(),
      preview: { schemaVersion: GIT_DELIVERY_SCHEMA_VERSION, wouldCreateRemoteBranch: "yes" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("preview"))).toBe(true);
    }
  });
});

describe("risk-class classifiers", () => {
  it("gitDeliveryDefaultRiskClass returns the per-kind default for every known kind", () => {
    for (const kind of Object.keys(GIT_DELIVERY_ACTION_RISK_DEFAULTS)) {
      expect(gitDeliveryDefaultRiskClass(kind)).toBe(
        GIT_DELIVERY_ACTION_RISK_DEFAULTS[kind as keyof typeof GIT_DELIVERY_ACTION_RISK_DEFAULTS],
      );
    }
  });

  it("gitDeliveryDefaultRiskClass fails closed to recovery-or-rewrite for unknown kinds", () => {
    expect(gitDeliveryDefaultRiskClass("teleport")).toBe("recovery-or-rewrite");
    expect(gitDeliveryDefaultRiskClass("")).toBe("recovery-or-rewrite");
  });

  it("gitDeliveryRiskClassForInputs escalates a force-push above its default publish class", () => {
    const force: GitDeliveryResolvedInputs = {
      kind: "push",
      sourceBranchName: "f",
      remoteAlias: "origin",
      remoteBranchName: "f",
      forcePush: true,
      setUpstreamTracking: false,
    };
    const normal: GitDeliveryResolvedInputs = { ...force, forcePush: false };
    expect(gitDeliveryRiskClassForInputs(force)).toBe("recovery-or-rewrite");
    expect(gitDeliveryRiskClassForInputs(normal)).toBe("publish");
  });

  it("gitDeliveryRiskClassForInputs defers to the default for non-push kinds", () => {
    const commit: GitDeliveryResolvedInputs = {
      kind: "commit",
      messageByteLength: 1,
      stagedPathCount: 1,
      allowEmptyCommit: false,
    };
    expect(gitDeliveryRiskClassForInputs(commit)).toBe("local-mutation");
  });

  it("gitDeliveryRiskClassWithinCeiling compares severities via the frozen table", () => {
    // commit (local-mutation, 1) within a publish ceiling (2).
    expect(gitDeliveryRiskClassWithinCeiling("commit", "publish")).toBe(true);
    // commit within its own class (equal severity).
    expect(gitDeliveryRiskClassWithinCeiling("commit", "local-mutation")).toBe(true);
    // merge (protected-or-merge, 3) exceeds a publish ceiling (2).
    expect(gitDeliveryRiskClassWithinCeiling("merge", "publish")).toBe(false);
    // recovery (4) exceeds protected-or-merge (3).
    expect(gitDeliveryRiskClassWithinCeiling("recovery", "protected-or-merge")).toBe(false);
    // The comparison reads ordinals, not action-name strings.
    expect(GIT_DELIVERY_RISK_CLASS_SEVERITY["recovery-or-rewrite"]).toBeGreaterThan(
      GIT_DELIVERY_RISK_CLASS_SEVERITY.publish,
    );
  });
});

describe("typed branch matchers", () => {
  it("matches exact patterns only on full equality", () => {
    const exact: GitDeliveryBranchPattern = { matchKind: "exact", value: "main" };
    expect(gitDeliveryBranchNameMatchesPattern("main", exact)).toBe(true);
    expect(gitDeliveryBranchNameMatchesPattern("main-2", exact)).toBe(false);
    expect(gitDeliveryBranchNameMatchesPattern("release/main", exact)).toBe(false);
  });

  it("matches prefix patterns on startsWith", () => {
    const prefix: GitDeliveryBranchPattern = { matchKind: "prefix", value: "release/" };
    expect(gitDeliveryBranchNameMatchesPattern("release/1.0", prefix)).toBe(true);
    expect(gitDeliveryBranchNameMatchesPattern("release/", prefix)).toBe(true);
    expect(gitDeliveryBranchNameMatchesPattern("hotfix/1", prefix)).toBe(false);
  });

  it("gitDeliveryBranchNameMatchesAny returns true when any pattern matches", () => {
    const patterns: readonly GitDeliveryBranchPattern[] = [
      { matchKind: "exact", value: "main" },
      { matchKind: "prefix", value: "release/" },
    ];
    expect(gitDeliveryBranchNameMatchesAny("main", patterns)).toBe(true);
    expect(gitDeliveryBranchNameMatchesAny("release/9", patterns)).toBe(true);
    expect(gitDeliveryBranchNameMatchesAny("feature/x", patterns)).toBe(false);
    expect(gitDeliveryBranchNameMatchesAny("main", [])).toBe(false);
  });
});
