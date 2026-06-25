import { describe, expect, it } from "vitest";

import type {
  GitDeliveryApprovalRequirement,
  GitDeliveryPolicyDecision,
  GitDeliveryResolvedInputs,
} from "./git-delivery.js";
import type {
  GitDeliveryActionSheetInput,
  GitDeliveryExpectedBlocker,
  GitDeliveryRecoveryHint,
} from "./git-delivery-action-sheet.js";
import {
  buildGitDeliveryActionSheet,
  buildGitDeliveryPreviewManifest,
  GIT_DELIVERY_ACTION_SHEET_SCHEMA_VERSION,
  GIT_DELIVERY_ACTION_SHEET_STATES,
  GIT_DELIVERY_APPROVAL_NECESSITIES,
  GIT_DELIVERY_BLOCKED_CAUSES,
  GIT_DELIVERY_RECOVERY_ACTION_HINTS,
  gitDeliveryActionSheetStateFor,
  gitDeliveryApprovalNecessityForDecision,
  gitDeliveryBlockedCauseFor,
  gitDeliverySuggestedRecoveryStrategy,
  isGitDeliveryActionSheet,
  isGitDeliveryActionSheetState,
  isGitDeliveryApprovalNecessity,
  isGitDeliveryApprovalSummary,
  isGitDeliveryBlockedCause,
  isGitDeliveryExpectedBlocker,
  isGitDeliveryPreviewManifest,
  isGitDeliveryRecoveryActionHint,
  isGitDeliveryRecoveryHint,
  parseGitDeliveryActionSheet,
} from "./git-delivery-action-sheet.js";

const TOKEN_HASH = "a".repeat(64);

const APPROVAL_NONE: GitDeliveryApprovalRequirement = { required: false };
const APPROVAL_GRANTED: GitDeliveryApprovalRequirement = {
  required: true,
  approvalTokenHash: TOKEN_HASH,
  approvedByUserId: "user-1",
  approvedAtMs: 10,
};

const COMMIT_INPUTS: GitDeliveryResolvedInputs = {
  kind: "commit",
  messageByteLength: 24,
  stagedPathCount: 3,
  allowEmptyCommit: false,
};

const PUSH_FORCE_INPUTS: GitDeliveryResolvedInputs = {
  kind: "push",
  sourceBranchName: "feature/x",
  remoteAlias: "origin",
  remoteBranchName: "feature/x",
  forcePush: true,
  setUpstreamTracking: true,
};

const PR_CREATE_INPUTS: GitDeliveryResolvedInputs = {
  kind: "pr-create",
  headBranchName: "feature/x",
  baseBranchName: "main",
  titleByteLength: 12,
  bodyByteLength: 40,
  isDraft: false,
};

const MERGE_INPUTS: GitDeliveryResolvedInputs = {
  kind: "merge",
  prExternalId: "PR-1",
  mergeStrategyHint: "squash",
  deleteBranchAfterMerge: true,
};

const PREFLIGHT_BLOCKING: GitDeliveryExpectedBlocker = {
  source: "preflight",
  severity: "blocking",
  remediation: "user-actionable",
  reasonCode: "nothing-staged-to-commit",
};

const PREFLIGHT_ADVISORY: GitDeliveryExpectedBlocker = {
  source: "preflight",
  severity: "advisory",
  remediation: "user-actionable",
  reasonCode: "untracked-files-impacted",
};

const RECOVERY_STAGE: GitDeliveryRecoveryHint = {
  actionHint: "stage-changes",
  remediation: "user-actionable",
};

function baseInput(
  overrides: Partial<GitDeliveryActionSheetInput> = {},
): GitDeliveryActionSheetInput {
  return {
    actionId: "act-1",
    resolvedInputs: COMMIT_INPUTS,
    policyDecision: { outcome: "allowed" },
    approvalRequirement: APPROVAL_NONE,
    providerReady: true,
    expectedBlockers: [],
    recovery: [],
    ...overrides,
  };
}

describe("enum guards", () => {
  it("accept valid members and reject unknown values", () => {
    expect(GIT_DELIVERY_ACTION_SHEET_STATES.every(isGitDeliveryActionSheetState)).toBe(true);
    expect(GIT_DELIVERY_APPROVAL_NECESSITIES.every(isGitDeliveryApprovalNecessity)).toBe(true);
    expect(GIT_DELIVERY_BLOCKED_CAUSES.every(isGitDeliveryBlockedCause)).toBe(true);
    expect(GIT_DELIVERY_RECOVERY_ACTION_HINTS.every(isGitDeliveryRecoveryActionHint)).toBe(true);
    expect(isGitDeliveryActionSheetState("nope")).toBe(false);
    expect(isGitDeliveryApprovalNecessity("maybe")).toBe(false);
    expect(isGitDeliveryBlockedCause("missing-approval")).toBe(false);
    expect(isGitDeliveryRecoveryActionHint("delete-everything")).toBe(false);
  });
});

describe("isGitDeliveryExpectedBlocker", () => {
  it("validates structure and rejects empty reasonCode / bad enums", () => {
    expect(isGitDeliveryExpectedBlocker(PREFLIGHT_BLOCKING)).toBe(true);
    expect(isGitDeliveryExpectedBlocker({ ...PREFLIGHT_BLOCKING, reasonCode: "" })).toBe(false);
    expect(isGitDeliveryExpectedBlocker({ ...PREFLIGHT_BLOCKING, source: "shell" })).toBe(false);
    expect(isGitDeliveryExpectedBlocker({ ...PREFLIGHT_BLOCKING, severity: "fatal" })).toBe(false);
    expect(isGitDeliveryExpectedBlocker(null)).toBe(false);
  });
});

describe("isGitDeliveryRecoveryHint", () => {
  it("accepts a plain hint and a strategy-bearing hint", () => {
    expect(isGitDeliveryRecoveryHint(RECOVERY_STAGE)).toBe(true);
    expect(
      isGitDeliveryRecoveryHint({
        actionHint: "recover-via-strategy",
        remediation: "user-actionable",
        suggestedRecoveryStrategy: "mixed-reset",
      }),
    ).toBe(true);
  });

  it("rejects a strategy attached to a non-strategy hint", () => {
    expect(
      isGitDeliveryRecoveryHint({
        actionHint: "retry",
        remediation: "user-actionable",
        suggestedRecoveryStrategy: "mixed-reset",
      }),
    ).toBe(false);
  });

  it("rejects an invalid strategy value", () => {
    expect(
      isGitDeliveryRecoveryHint({
        actionHint: "recover-via-strategy",
        remediation: "user-actionable",
        suggestedRecoveryStrategy: "nuke",
      }),
    ).toBe(false);
  });
});

describe("buildGitDeliveryPreviewManifest", () => {
  it("derives branch targets and risk for branch-create", () => {
    const manifest = buildGitDeliveryPreviewManifest({
      resolvedInputs: {
        kind: "branch-create",
        branchName: "feature/y",
        baseBranchName: "main",
        startPointRefHash: "deadbeef",
      },
      expectedBlockers: [],
    });
    expect(manifest.affectedBranchName).toBe("feature/y");
    expect(manifest.baseBranchName).toBe("main");
    expect(manifest.touchesRemote).toBe(false);
    expect(manifest.riskClass).toBe("local-mutation");
    expect(isGitDeliveryPreviewManifest(manifest)).toBe(true);
  });

  it("flags force-publish and remote impact for a force push", () => {
    const manifest = buildGitDeliveryPreviewManifest({
      resolvedInputs: PUSH_FORCE_INPUTS,
      expectedBlockers: [],
    });
    expect(manifest.touchesRemote).toBe(true);
    expect(manifest.wouldForcePublish).toBe(true);
    expect(manifest.wouldCreateRemoteBranch).toBe(true);
    expect(manifest.wouldTriggerChecks).toBe(true);
    expect(manifest.remoteBranchName).toBe("feature/x");
    // force push escalates risk beyond the default publish class.
    expect(manifest.riskClass).toBe("recovery-or-rewrite");
  });

  it("carries kernel preview counts and provider state for merge", () => {
    const manifest = buildGitDeliveryPreviewManifest({
      resolvedInputs: MERGE_INPUTS,
      expectedBlockers: [PREFLIGHT_ADVISORY],
      kernelPreview: {
        schemaVersion: "1",
        wouldCreateRemoteBranch: false,
        wouldTriggerChecks: false,
        estimatedFileCount: 7,
      },
      mergeReadiness: {
        ready: false,
        blockingReason: "checks-failing",
        requiredApprovalCount: 2,
        receivedApprovalCount: 1,
      },
    });
    expect(manifest.estimatedFileCount).toBe(7);
    expect(manifest.mergeReadiness?.ready).toBe(false);
    expect(manifest.expectedBlockers).toHaveLength(1);
    expect(manifest.touchesRemote).toBe(true);
  });
});

describe("gitDeliveryApprovalNecessityForDecision", () => {
  it("maps each policy outcome to a necessity", () => {
    expect(gitDeliveryApprovalNecessityForDecision({ outcome: "allowed" })).toBe("not-required");
    expect(
      gitDeliveryApprovalNecessityForDecision({ outcome: "constrained", constraints: [] }),
    ).toBe("not-required");
    expect(
      gitDeliveryApprovalNecessityForDecision({
        outcome: "approval-gated",
        requiredApprovers: ["u"],
      }),
    ).toBe("required");
    expect(
      gitDeliveryApprovalNecessityForDecision({
        outcome: "blocked",
        reason: "policy-pack-blocked",
      }),
    ).toBe("impossible");
    expect(
      gitDeliveryApprovalNecessityForDecision({ outcome: "blocked", reason: "approval-expired" }),
    ).toBe("required");
  });
});

describe("gitDeliveryActionSheetStateFor", () => {
  const allowed: GitDeliveryPolicyDecision = { outcome: "allowed" };
  const gated: GitDeliveryPolicyDecision = { outcome: "approval-gated", requiredApprovers: ["u"] };

  it("blocks when provider is not ready (highest precedence)", () => {
    expect(
      gitDeliveryActionSheetStateFor({
        policyDecision: allowed,
        approvalRequirement: APPROVAL_NONE,
        providerReady: false,
        hasBlockingPreflight: false,
      }),
    ).toBe("blocked");
  });

  it("blocks on a blocking preflight finding", () => {
    expect(
      gitDeliveryActionSheetStateFor({
        policyDecision: allowed,
        approvalRequirement: APPROVAL_NONE,
        providerReady: true,
        hasBlockingPreflight: true,
      }),
    ).toBe("blocked");
  });

  it("blocks on a hard policy denial but waits on approval-expired", () => {
    expect(
      gitDeliveryActionSheetStateFor({
        policyDecision: { outcome: "blocked", reason: "protected-branch" },
        approvalRequirement: APPROVAL_NONE,
        providerReady: true,
        hasBlockingPreflight: false,
      }),
    ).toBe("blocked");
    expect(
      gitDeliveryActionSheetStateFor({
        policyDecision: { outcome: "blocked", reason: "approval-expired" },
        approvalRequirement: APPROVAL_NONE,
        providerReady: true,
        hasBlockingPreflight: false,
      }),
    ).toBe("waiting-for-approval");
  });

  it("waits for approval when gated and unsatisfied, ready when satisfied", () => {
    expect(
      gitDeliveryActionSheetStateFor({
        policyDecision: gated,
        approvalRequirement: APPROVAL_NONE,
        providerReady: true,
        hasBlockingPreflight: false,
      }),
    ).toBe("waiting-for-approval");
    expect(
      gitDeliveryActionSheetStateFor({
        policyDecision: gated,
        approvalRequirement: APPROVAL_GRANTED,
        providerReady: true,
        hasBlockingPreflight: false,
      }),
    ).toBe("ready-to-execute");
  });

  it("is ready when allowed", () => {
    expect(
      gitDeliveryActionSheetStateFor({
        policyDecision: allowed,
        approvalRequirement: APPROVAL_NONE,
        providerReady: true,
        hasBlockingPreflight: false,
      }),
    ).toBe("ready-to-execute");
  });
});

describe("gitDeliveryBlockedCauseFor", () => {
  it("classifies provider, preflight, and policy in precedence order", () => {
    const allowed: GitDeliveryPolicyDecision = { outcome: "allowed" };
    expect(
      gitDeliveryBlockedCauseFor({
        policyDecision: allowed,
        approvalRequirement: APPROVAL_NONE,
        providerReady: false,
        hasBlockingPreflight: true,
      }),
    ).toBe("provider-not-ready");
    expect(
      gitDeliveryBlockedCauseFor({
        policyDecision: { outcome: "blocked", reason: "protected-branch" },
        approvalRequirement: APPROVAL_NONE,
        providerReady: true,
        hasBlockingPreflight: true,
      }),
    ).toBe("preflight");
    expect(
      gitDeliveryBlockedCauseFor({
        policyDecision: { outcome: "blocked", reason: "protected-branch" },
        approvalRequirement: APPROVAL_NONE,
        providerReady: true,
        hasBlockingPreflight: false,
      }),
    ).toBe("policy");
    expect(
      gitDeliveryBlockedCauseFor({
        policyDecision: allowed,
        approvalRequirement: APPROVAL_NONE,
        providerReady: true,
        hasBlockingPreflight: false,
      }),
    ).toBeUndefined();
  });
});

describe("gitDeliverySuggestedRecoveryStrategy", () => {
  it("prefers preserving a dirty worktree, soft-resets a commit, mixed otherwise", () => {
    expect(gitDeliverySuggestedRecoveryStrategy("commit", true)).toBe("stash-and-reset");
    expect(gitDeliverySuggestedRecoveryStrategy("commit", false)).toBe("soft-reset");
    expect(gitDeliverySuggestedRecoveryStrategy("merge", false)).toBe("mixed-reset");
  });
});

describe("buildGitDeliveryActionSheet", () => {
  it("produces a ready sheet without a blocked detail", () => {
    const sheet = buildGitDeliveryActionSheet(baseInput());
    expect(sheet.state).toBe("ready-to-execute");
    expect(sheet.blocked).toBeUndefined();
    expect(sheet.approval.necessity).toBe("not-required");
    expect(sheet.schemaVersion).toBe(GIT_DELIVERY_ACTION_SHEET_SCHEMA_VERSION);
    expect(isGitDeliveryActionSheet(sheet)).toBe(true);
    expect(isGitDeliveryApprovalSummary(sheet.approval)).toBe(true);
  });

  it("produces a waiting-for-approval sheet for an unsatisfied gate", () => {
    const sheet = buildGitDeliveryActionSheet(
      baseInput({
        resolvedInputs: PR_CREATE_INPUTS,
        policyDecision: { outcome: "approval-gated", requiredApprovers: ["lead"] },
        recovery: [{ actionHint: "request-approval", remediation: "user-actionable" }],
      }),
    );
    expect(sheet.state).toBe("waiting-for-approval");
    expect(sheet.approval.necessity).toBe("required");
    expect(sheet.approval.satisfied).toBe(false);
    expect(sheet.approval.requiredApprovers).toEqual(["lead"]);
    expect(sheet.blocked).toBeUndefined();
    expect(sheet.recovery[0]?.actionHint).toBe("request-approval");
  });

  it("produces a blocked sheet with a preflight cause and the blockers attached", () => {
    const sheet = buildGitDeliveryActionSheet(
      baseInput({
        expectedBlockers: [PREFLIGHT_BLOCKING, PREFLIGHT_ADVISORY],
        recovery: [RECOVERY_STAGE],
      }),
    );
    expect(sheet.state).toBe("blocked");
    expect(sheet.blocked?.cause).toBe("preflight");
    expect(sheet.blocked?.expectedBlockers).toHaveLength(2);
    expect(isGitDeliveryActionSheet(sheet)).toBe(true);
  });

  it("produces a blocked sheet for provider-not-ready", () => {
    const sheet = buildGitDeliveryActionSheet(
      baseInput({ resolvedInputs: MERGE_INPUTS, providerReady: false }),
    );
    expect(sheet.state).toBe("blocked");
    expect(sheet.blocked?.cause).toBe("provider-not-ready");
  });

  it("produces a blocked sheet for a hard policy denial with the reason visible", () => {
    const sheet = buildGitDeliveryActionSheet(
      baseInput({ policyDecision: { outcome: "blocked", reason: "risk-class-ceiling" } }),
    );
    expect(sheet.state).toBe("blocked");
    expect(sheet.blocked?.cause).toBe("policy");
    expect(sheet.policyExplanation.blockReason).toBe("risk-class-ceiling");
    expect(sheet.approval.necessity).toBe("impossible");
  });

  it("round-trips through the parser", () => {
    const sheet = buildGitDeliveryActionSheet(baseInput());
    const parsed = parseGitDeliveryActionSheet(sheet);
    expect(parsed.ok).toBe(true);
    const rejected = parseGitDeliveryActionSheet({ ...sheet, state: "blocked" });
    // state=blocked without a blocked detail violates the invariant.
    expect(rejected.ok).toBe(false);
  });

  it("rejects a sheet whose policy decision outcome is not a known outcome", () => {
    const sheet = buildGitDeliveryActionSheet(baseInput());
    const corrupted = {
      ...sheet,
      policyExplanation: { ...sheet.policyExplanation, decision: "totally-made-up" },
    };
    expect(isGitDeliveryActionSheet(corrupted)).toBe(false);
  });
});
