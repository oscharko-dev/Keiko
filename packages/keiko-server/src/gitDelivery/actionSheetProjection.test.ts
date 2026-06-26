// Unit tests for the pure kernel-fact → action-sheet projection (Issue #473, Epic #470).
//
// These assert the mapping itself: that the preflight findings and the server-side policy decision
// are projected into the action sheet's typed expected-blocker and recovery-hint vocabularies, and
// that the contract state equals what the kernel outcome status implies for representative cases.

import { describe, expect, it } from "vitest";
import type {
  GitDeliveryApprovalRequirement,
  GitDeliveryOrgPolicyPack,
  GitDeliveryRepoPolicyPack,
  GitDeliveryResolvedInputs,
} from "@oscharko-dev/keiko-contracts";
import type { GitWorktreeSnapshot } from "@oscharko-dev/keiko-tools";
import { buildActionSheetFromFacts, type BuildActionSheetFacts } from "./actionSheetProjection.js";

const CLEAN_SNAPSHOT: GitWorktreeSnapshot = {
  headDetached: false,
  currentBranchName: "feature/x",
  stagedFileCount: 3,
  unstagedFileCount: 0,
  untrackedFileCount: 0,
  hasUpstream: true,
  aheadCount: 1,
  behindCount: 0,
  existingLocalBranchNames: ["feature/x", "main"],
  remoteAliases: ["origin"],
};

const COMMIT_INPUTS: GitDeliveryResolvedInputs = {
  kind: "commit",
  messageByteLength: 42,
  stagedPathCount: 3,
  allowEmptyCommit: false,
};

const APPROVAL_NONE: GitDeliveryApprovalRequirement = { required: false };

// An org pack that allows commit explicitly, so a clean commit is ready-to-execute.
const ALLOW_COMMIT_ORG: GitDeliveryOrgPolicyPack = {
  schemaVersion: "1",
  orgId: "org-1",
  rules: [{ actionKind: "commit", decision: "allowed" }],
};

const APPROVAL_GATED_ORG: GitDeliveryOrgPolicyPack = {
  schemaVersion: "1",
  orgId: "org-1",
  rules: [
    { actionKind: "commit", decision: "approval-gated", requiredApprovers: ["lead@example.test"] },
  ],
};

const REPO_ALLOW_ALL: GitDeliveryRepoPolicyPack = {
  schemaVersion: "1",
  repoId: "repo-1",
  rules: [],
  defaultRule: { decision: "allowed" },
};

function facts(overrides: Partial<BuildActionSheetFacts> = {}): BuildActionSheetFacts {
  return {
    actionId: "git-delivery-action-test",
    resolvedInputs: COMMIT_INPUTS,
    worktreeSnapshot: CLEAN_SNAPSHOT,
    approvalRequirement: APPROVAL_NONE,
    policyPacks: { orgPack: ALLOW_COMMIT_ORG, repoPack: REPO_ALLOW_ALL },
    activeProviderCapabilities: [],
    providerState: {},
    providerReady: true,
    nowMs: 1_000,
    ...overrides,
  };
}

describe("buildActionSheetFromFacts", () => {
  it("ready-to-execute for an allowed policy over a clean snapshot", () => {
    const sheet = buildActionSheetFromFacts(facts());
    expect(sheet.state).toBe("ready-to-execute");
    expect(sheet.actionKind).toBe("commit");
    expect(sheet.policyExplanation.decision).toBe("allowed");
    expect(sheet.approval.necessity).toBe("not-required");
    expect(sheet.approval.riskClass).toBe("local-mutation");
    expect(sheet.approval.riskSeverity).toBe(1);
    expect(sheet.preview.expectedBlockers).toHaveLength(0);
    expect(sheet.blocked).toBeUndefined();
  });

  it("waiting-for-approval when policy is approval-gated and no approval is attached", () => {
    const sheet = buildActionSheetFromFacts(
      facts({ policyPacks: { orgPack: APPROVAL_GATED_ORG } }),
    );
    expect(sheet.state).toBe("waiting-for-approval");
    expect(sheet.approval.necessity).toBe("required");
    expect(sheet.approval.satisfied).toBe(false);
    expect(sheet.approval.requiredApprovers).toEqual(["lead@example.test"]);
    expect(sheet.policyExplanation.requiredApprovers).toEqual(["lead@example.test"]);
    // A request-approval recovery hint is offered in the same surface.
    expect(sheet.recovery.some((hint) => hint.actionHint === "request-approval")).toBe(true);
  });

  it("ready-to-execute when approval-gated AND a granted approval is attached", () => {
    const sheet = buildActionSheetFromFacts(
      facts({
        policyPacks: { orgPack: APPROVAL_GATED_ORG },
        approvalRequirement: {
          required: true,
          approvalTokenHash: "a".repeat(64),
          approvedByUserId: "lead@example.test",
          approvedAtMs: 1,
          expiresAtMs: 5_000,
        },
        nowMs: 1_000,
      }),
    );
    expect(sheet.state).toBe("ready-to-execute");
    expect(sheet.approval.satisfied).toBe(true);
  });

  it("demotes an EXPIRED granted approval to waiting-for-approval (clock parity with the kernel)", () => {
    const sheet = buildActionSheetFromFacts(
      facts({
        policyPacks: { orgPack: APPROVAL_GATED_ORG },
        approvalRequirement: {
          required: true,
          approvalTokenHash: "a".repeat(64),
          approvedByUserId: "lead@example.test",
          approvedAtMs: 1,
          expiresAtMs: 500,
        },
        nowMs: 1_000, // now > expiresAtMs → the grant is expired
      }),
    );
    expect(sheet.state).toBe("waiting-for-approval");
    expect(sheet.approval.satisfied).toBe(false);
    expect(sheet.approval.necessity).toBe("required");
  });

  it("blocked with cause preflight and a blocking expected-blocker for a commit with nothing staged", () => {
    const sheet = buildActionSheetFromFacts(
      facts({ worktreeSnapshot: { ...CLEAN_SNAPSHOT, stagedFileCount: 0 } }),
    );
    expect(sheet.state).toBe("blocked");
    expect(sheet.blocked?.cause).toBe("preflight");
    const preflightBlockers = sheet.preview.expectedBlockers.filter(
      (b) => b.source === "preflight",
    );
    expect(preflightBlockers).toContainEqual({
      source: "preflight",
      severity: "blocking",
      remediation: "user-actionable",
      reasonCode: "nothing-staged-to-commit",
    });
    // The blocking finding is mirrored into a recovery hint (stage-changes).
    expect(sheet.recovery.some((hint) => hint.actionHint === "stage-changes")).toBe(true);
  });

  it("blocked with cause policy and the reason visible when no packs are configured", () => {
    const sheet = buildActionSheetFromFacts(facts({ policyPacks: {} }));
    expect(sheet.state).toBe("blocked");
    expect(sheet.blocked?.cause).toBe("policy");
    expect(sheet.policyExplanation.decision).toBe("blocked");
    expect(sheet.policyExplanation.blockReason).toBe("no-applicable-rule");
    expect(sheet.blocked?.expectedBlockers).toContainEqual({
      source: "policy",
      severity: "blocking",
      remediation: "user-actionable",
      reasonCode: "no-applicable-rule",
    });
    expect(sheet.approval.necessity).toBe("impossible");
  });

  it("blocked with cause provider-not-ready when the deployment capability is off", () => {
    const sheet = buildActionSheetFromFacts(facts({ providerReady: false }));
    expect(sheet.state).toBe("blocked");
    expect(sheet.blocked?.cause).toBe("provider-not-ready");
    expect(sheet.recovery.some((hint) => hint.actionHint === "wait-for-provider")).toBe(true);
  });

  it("emits a recover-via-strategy hint with a concrete strategy for a dirty recovery", () => {
    const recoveryInputs: GitDeliveryResolvedInputs = {
      kind: "recovery",
      recoveryStrategyHint: "mixed-reset",
      targetRefHash: "deadbeef",
      affectedPathCount: 2,
    };
    const sheet = buildActionSheetFromFacts(
      facts({
        resolvedInputs: recoveryInputs,
        worktreeSnapshot: { ...CLEAN_SNAPSHOT, unstagedFileCount: 4 },
        policyPacks: {
          orgPack: {
            schemaVersion: "1",
            orgId: "org-1",
            rules: [{ actionKind: "recovery", decision: "allowed" }],
          },
        },
      }),
    );
    const strategyHint = sheet.recovery.find((hint) => hint.actionHint === "recover-via-strategy");
    expect(strategyHint).toBeDefined();
    // Dirty worktree → stash-and-reset (preserve local changes), per the contract's default table.
    expect(strategyHint?.suggestedRecoveryStrategy).toBe("stash-and-reset");
  });

  it("projects a provider advisory blocker for a merge that is not ready", () => {
    const mergeInputs: GitDeliveryResolvedInputs = {
      kind: "merge",
      prExternalId: "pr-7",
      mergeStrategyHint: "squash",
      deleteBranchAfterMerge: false,
    };
    const sheet = buildActionSheetFromFacts(
      facts({
        resolvedInputs: mergeInputs,
        policyPacks: {
          orgPack: {
            schemaVersion: "1",
            orgId: "org-1",
            rules: [{ actionKind: "merge", decision: "allowed" }],
          },
        },
        providerState: {
          mergeReadiness: {
            ready: false,
            blockingReason: "checks-failing",
            requiredApprovalCount: 2,
            receivedApprovalCount: 1,
          },
        },
      }),
    );
    expect(sheet.preview.expectedBlockers).toContainEqual({
      source: "provider",
      severity: "advisory",
      remediation: "user-actionable",
      reasonCode: "checks-failing",
    });
    // An advisory provider blocker does not hard-block; policy allowed → ready-to-execute.
    expect(sheet.state).toBe("ready-to-execute");
  });

  it("is deterministic — identical facts yield an identical sheet", () => {
    expect(buildActionSheetFromFacts(facts())).toEqual(buildActionSheetFromFacts(facts()));
  });
});
