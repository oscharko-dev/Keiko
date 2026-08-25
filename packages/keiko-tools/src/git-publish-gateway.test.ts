// Unit coverage for the governed remote publish gateway (Issue #476, Epic #470) — AC1–AC4.
// Pure tests with a fake remote adapter and a fake worktree snapshot: argv building (force refused),
// the rejection taxonomy, the dedicated allowlist, and the runGitPublish lifecycle gates (preflight,
// policy/protected-target, approval, execution + rejection surfacing).

import { describe, expect, it, vi } from "vitest";
import {
  GIT_DELIVERY_POLICY_SCHEMA_VERSION,
  type GitDeliveryApprovalRequirement,
  type GitDeliveryOrgPolicyPack,
  type GitDeliveryRepoPolicyPack,
} from "@oscharko-dev/keiko-contracts";
import type { GitWorktreeSnapshot } from "./git-mutation-preflight.js";
import {
  buildPushArgv,
  classifyGitPublishRejection,
  evaluateGitPublishEffectivePolicy,
  GIT_PUBLISH_ALLOWED_SUBCOMMANDS,
  GIT_PUBLISH_COMMAND_RULES,
  GIT_PUBLISH_REJECTION_REASONS,
  gitPublishArgvIsGoverned,
  gitPublishRejectionFor,
  gitPublishRejectionToErrorCode,
  GitPublishArgvError,
  runGitPublish,
  type GitPublishExecResult,
  type GitPushCommand,
  type GitRemotePublishAdapter,
} from "./git-publish-gateway.js";
import { isCommandAllowed } from "./sandbox.js";

const NO_APPROVAL: GitDeliveryApprovalRequirement = { required: false };

function snapshot(overrides: Partial<GitWorktreeSnapshot> = {}): GitWorktreeSnapshot {
  return {
    headDetached: false,
    currentBranchName: "feat/x",
    stagedFileCount: 0,
    unstagedFileCount: 0,
    untrackedFileCount: 0,
    hasUpstream: true,
    aheadCount: 1,
    behindCount: 0,
    existingLocalBranchNames: ["feat/x"],
    remoteAliases: ["origin"],
    ...overrides,
  };
}

function command(overrides: Partial<GitPushCommand> = {}): GitPushCommand {
  return {
    kind: "push",
    sourceBranchName: "feat/x",
    remoteAlias: "origin",
    remoteBranchName: "feat/x",
    forcePush: false,
    setUpstreamTracking: false,
    ...overrides,
  };
}

// A pack that PERMITS push to the safe `feat/` namespace within the publish ceiling.
function safePack(): GitDeliveryRepoPolicyPack {
  return {
    schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
    repoId: "test",
    rules: [
      {
        actionKind: "push",
        decision: "constrained",
        constraints: [
          { kind: "risk-class-ceiling", maxRiskClass: "publish" },
          { kind: "branch-pattern", patterns: [{ matchKind: "prefix", value: "feat/" }] },
        ],
      },
    ],
    defaultRule: { decision: "blocked" },
  };
}

function protectedDevOrgPack(): GitDeliveryOrgPolicyPack {
  return {
    schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
    orgId: "org",
    rules: [
      {
        actionKind: "push",
        decision: "constrained",
        constraints: [
          {
            kind: "protected-branch",
            patterns: [{ matchKind: "exact", value: "dev" }],
          },
        ],
      },
    ],
  };
}

function approvalGateRepoPack(): GitDeliveryRepoPolicyPack {
  return {
    schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
    repoId: "repo",
    rules: [{ actionKind: "push", decision: "approval-gated", requiredApprovers: ["lead"] }],
  };
}

function approvalGateOrgPack(): GitDeliveryOrgPolicyPack {
  return {
    schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
    orgId: "org",
    rules: [{ actionKind: "push", decision: "approval-gated", requiredApprovers: ["org-lead"] }],
  };
}

function fakeAdapter(result: GitPublishExecResult): {
  adapter: GitRemotePublishAdapter;
  publish: ReturnType<typeof vi.fn>;
} {
  const publish = vi.fn((): Promise<GitPublishExecResult> => Promise.resolve(result));
  return { adapter: { publish }, publish };
}

const SUCCESS: GitPublishExecResult = {
  schemaVersion: "1",
  outcome: "succeeded",
  durationMs: 5,
};

describe("evaluateGitPublishEffectivePolicy", () => {
  const decision = {
    outcome: "approval-gated" as const,
    requiredApprovers: ["lead"],
    constraints: [
      {
        kind: "protected-branch" as const,
        patterns: [{ matchKind: "exact" as const, value: "dev" }],
      },
    ],
  } as const;

  it("blocks a protected target and keeps an ordinary target approval-gated", () => {
    expect(evaluateGitPublishEffectivePolicy(decision, "dev", [], command())).toMatchObject({
      outcome: "blocked",
      blockReason: "protected-branch",
    });
    expect(evaluateGitPublishEffectivePolicy(decision, "feat/x", [], command()).outcome).toBe(
      "approval-gated",
    );
  });
});

describe("buildPushArgv", () => {
  it("builds an explicit refspec push", () => {
    expect(buildPushArgv(command())).toEqual(["push", "origin", "feat/x:feat/x"]);
  });

  it("adds --set-upstream when requested", () => {
    expect(buildPushArgv(command({ setUpstreamTracking: true }))).toEqual([
      "push",
      "--set-upstream",
      "origin",
      "feat/x:feat/x",
    ]);
  });

  it("refuses to build a force push (AC4)", () => {
    expect(() => buildPushArgv(command({ forcePush: true }))).toThrow(GitPublishArgvError);
  });

  it("rejects refspec-injection, flag-injection, whitespace, and control chars in refs", () => {
    expect(() => buildPushArgv(command({ remoteBranchName: "a:b" }))).toThrow(GitPublishArgvError);
    expect(() => buildPushArgv(command({ sourceBranchName: "-x" }))).toThrow(GitPublishArgvError);
    expect(() => buildPushArgv(command({ remoteAlias: "" }))).toThrow(GitPublishArgvError);
    expect(() => buildPushArgv(command({ remoteBranchName: "a b" }))).toThrow(GitPublishArgvError);
    expect(() => buildPushArgv(command({ sourceBranchName: "a\tb" }))).toThrow(GitPublishArgvError);
    expect(() => buildPushArgv(command({ remoteAlias: "a\u0000b" }))).toThrow(GitPublishArgvError);
  });

  it("only ever emits the `push` subcommand", () => {
    expect(GIT_PUBLISH_ALLOWED_SUBCOMMANDS).toEqual(["push"]);
    expect(gitPublishArgvIsGoverned(buildPushArgv(command()))).toBe(true);
    expect(gitPublishArgvIsGoverned(["fetch", "origin"])).toBe(false);
  });
});

describe("GIT_PUBLISH_COMMAND_RULES — boundary force/rewrite denial (AC4 layer 3)", () => {
  const FORCE_FLAGS = [
    "--force",
    "-f",
    "--force-with-lease",
    "--force-if-includes",
    "--mirror",
    "--delete",
    "-d",
  ];

  it.each(FORCE_FLAGS)("denies `git push %s ...` at the spawn boundary", (flag) => {
    const decision = isCommandAllowed(GIT_PUBLISH_COMMAND_RULES, "git", [
      "push",
      flag,
      "origin",
      "feat/x:feat/x",
    ]);
    expect(decision.allowed).toBe(false);
  });

  it("allows a plain governed push (positive control)", () => {
    expect(
      isCommandAllowed(GIT_PUBLISH_COMMAND_RULES, "git", ["push", "origin", "feat/x:feat/x"])
        .allowed,
    ).toBe(true);
  });

  it("denies any non-push subcommand on the publish allowlist", () => {
    expect(isCommandAllowed(GIT_PUBLISH_COMMAND_RULES, "git", ["fetch", "origin"]).allowed).toBe(
      false,
    );
    expect(isCommandAllowed(GIT_PUBLISH_COMMAND_RULES, "git", ["commit"]).allowed).toBe(false);
  });
});

describe("classifyGitPublishRejection", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["! [rejected] feat -> feat (non-fast-forward)", "non-fast-forward"],
    ["Updates were rejected because the remote contains work that you do", "fetch-first"],
    ["remote: error: GH006: Protected branch update failed; protected branch", "protected-ref"],
    ["remote: Permission to o/r.git denied to user", "permission-denied"],
    ["git@github.com: Permission denied (publickey).", "auth-failed"],
    // Smart-HTTP 403/401 with NO remote: line — must not fall through to retryable remote-unavailable.
    [
      "fatal: unable to access 'https://h/r.git/': The requested URL returned error: 403",
      "permission-denied",
    ],
    [
      "fatal: unable to access 'https://h/r.git/': The requested URL returned error: 401",
      "auth-failed",
    ],
    ["fatal: The current branch feat has no upstream branch", "no-upstream"],
    ["fatal: Could not read from remote repository", "remote-unavailable"],
    ["something entirely unexpected happened", "unknown"],
  ];
  it.each(cases)("classifies %s", (text, reason) => {
    expect(classifyGitPublishRejection(text)).toBe(reason);
  });

  it("prefers a specific auth cause over the generic remote phrase", () => {
    const both =
      "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote";
    expect(classifyGitPublishRejection(both)).toBe("auth-failed");
  });

  it("classifies a repo authorization denial (no publickey) as permission-denied", () => {
    expect(classifyGitPublishRejection("remote: Permission to o/r.git denied to user")).toBe(
      "permission-denied",
    );
  });

  // KEIKO-0215: the publish gateway used to carry its own drift-prone remote-unavailable phrase
  // set (5 phrases) that had fallen behind keiko-git's authoritative set (10 phrases). These
  // three phrases were absent from the local copy, so an unreachable host classified as
  // "unknown" and the operator got a "provider-rejected" verdict for a network outage. The
  // publish gateway now delegates to classifyGitRemoteFailure for the remote/auth/permission
  // vocabulary so ONE table governs both clone/fetch/pull and push.
  it("recognises the full remote-unavailable phrase set inherited from keiko-git", () => {
    for (const stderr of [
      "ssh: connect to host github.com port 22: Network is unreachable",
      "ssh: connect to host github.com port 22: No route to host",
      "ssh: Could not resolve hostname github.com: Temporary failure in name resolution",
    ]) {
      expect(classifyGitPublishRejection(stderr)).toBe("remote-unavailable");
    }
  });

  it("covers every rejection reason in the error-code + recovery maps", () => {
    for (const reason of GIT_PUBLISH_REJECTION_REASONS) {
      expect(typeof gitPublishRejectionToErrorCode(reason)).toBe("string");
      expect(gitPublishRejectionFor(reason).reason).toBe(reason);
    }
    expect(gitPublishRejectionToErrorCode("non-fast-forward")).toBe("precondition-failed");
    expect(gitPublishRejectionToErrorCode("auth-failed")).toBe("provider-rejected");
    expect(gitPublishRejectionToErrorCode("remote-unavailable")).toBe("network-failure");
    expect(gitPublishRejectionFor("remote-unavailable").disposition).toBe("retryable");
    expect(gitPublishRejectionFor("non-fast-forward").actionHint).toBe("resolve-conflicts");
    expect(gitPublishRejectionFor("auth-failed").actionHint).toBeUndefined();
  });
});

describe("runGitPublish — preflight gate", () => {
  it("blocks a missing remote alias before policy or execution", async () => {
    const { adapter, publish } = fakeAdapter(SUCCESS);
    const result = await runGitPublish(
      { command: command(), approval: NO_APPROVAL },
      {
        adapter,
        snapshot: snapshot({ remoteAliases: [] }),
        repoPolicyPack: safePack(),
        now: () => 0,
        newActionId: () => "a1",
      },
    );
    expect(result.lifecycle.outcome.status).toBe("blocked");
    expect(result.lifecycle.phaseReached).toBe("preflight");
    expect(publish).not.toHaveBeenCalled();
  });

  it("blocks a non-fast-forward (behind) push before execution", async () => {
    const { adapter, publish } = fakeAdapter(SUCCESS);
    const result = await runGitPublish(
      { command: command(), approval: NO_APPROVAL },
      {
        adapter,
        snapshot: snapshot({ behindCount: 2 }),
        repoPolicyPack: safePack(),
        now: () => 0,
        newActionId: () => "a1",
      },
    );
    expect(result.lifecycle.outcome.status).toBe("blocked");
    expect(result.lifecycle.preflight.blocking.map((f) => f.code)).toContain("non-fast-forward");
    expect(publish).not.toHaveBeenCalled();
  });

  it("blocks a missing upstream when not setting upstream", async () => {
    const { adapter, publish } = fakeAdapter(SUCCESS);
    const result = await runGitPublish(
      { command: command(), approval: NO_APPROVAL },
      {
        adapter,
        snapshot: snapshot({ hasUpstream: false }),
        repoPolicyPack: safePack(),
        now: () => 0,
        newActionId: () => "a1",
      },
    );
    expect(result.lifecycle.outcome.status).toBe("blocked");
    expect(result.lifecycle.preflight.blocking.map((f) => f.code)).toContain(
      "no-upstream-configured",
    );
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("runGitPublish — policy gate (AC2/AC4)", () => {
  it("blocks a protected/shared remote target the safe pack does not permit", async () => {
    const { adapter, publish } = fakeAdapter(SUCCESS);
    const result = await runGitPublish(
      { command: command({ remoteBranchName: "dev" }), approval: NO_APPROVAL },
      {
        adapter,
        snapshot: snapshot(),
        repoPolicyPack: safePack(),
        now: () => 0,
        newActionId: () => "a1",
      },
    );
    expect(result.lifecycle.outcome).toMatchObject({ status: "blocked", category: "policy-block" });
    expect(result.lifecycle.phaseReached).toBe("policy");
    expect(publish).not.toHaveBeenCalled();
  });

  it("blocks a force push by the publish risk ceiling (AC4)", async () => {
    const { adapter, publish } = fakeAdapter(SUCCESS);
    const result = await runGitPublish(
      { command: command({ forcePush: true }), approval: NO_APPROVAL },
      {
        adapter,
        snapshot: snapshot(),
        repoPolicyPack: safePack(),
        now: () => 0,
        newActionId: () => "a1",
      },
    );
    expect(result.lifecycle.outcome).toMatchObject({
      status: "blocked",
      category: "policy-block",
      blockReason: "risk-class-ceiling",
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it("never executes a force push even under a permissive pack (argv refusal → internal-error)", async () => {
    const permissive: GitDeliveryRepoPolicyPack = {
      schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
      repoId: "permissive",
      rules: [{ actionKind: "push", decision: "allowed" }],
    };
    const { adapter, publish } = fakeAdapter(SUCCESS);
    const result = await runGitPublish(
      { command: command({ forcePush: true }), approval: NO_APPROVAL },
      {
        adapter,
        snapshot: snapshot(),
        repoPolicyPack: permissive,
        now: () => 0,
        newActionId: () => "a1",
      },
    );
    // The argv builder refuses the force push, so the adapter is never asked to force anything.
    expect(publish).not.toHaveBeenCalled();
    expect(result.lifecycle.outcome.status).toBe("failed");
  });

  it("holds for approval when the pack is approval-gated and no approval is supplied", async () => {
    const gated: GitDeliveryRepoPolicyPack = {
      schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
      repoId: "gated",
      rules: [{ actionKind: "push", decision: "approval-gated", requiredApprovers: ["release"] }],
    };
    const { adapter, publish } = fakeAdapter(SUCCESS);
    const result = await runGitPublish(
      { command: command(), approval: NO_APPROVAL },
      {
        adapter,
        snapshot: snapshot(),
        repoPolicyPack: gated,
        now: () => 0,
        newActionId: () => "a1",
      },
    );
    expect(result.lifecycle.outcome).toMatchObject({
      status: "approval-required",
      requiredApprovers: ["release"],
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it("keeps org approval metadata and accepts one fresh grant when both scopes gate", async () => {
    const approval: GitDeliveryApprovalRequirement = {
      required: true,
      approvalTokenHash: "a".repeat(64),
      approvedByUserId: "org-lead",
      approvedAtMs: 0,
    };
    const { adapter, publish } = fakeAdapter(SUCCESS);
    const result = await runGitPublish(
      { command: command(), approval },
      {
        adapter,
        snapshot: snapshot(),
        orgPolicyPack: approvalGateOrgPack(),
        repoPolicyPack: approvalGateRepoPack(),
        now: () => 1,
        newActionId: () => "a1",
      },
    );

    expect(result.lifecycle.envelope.policyDecision).toEqual({
      outcome: "approval-gated",
      requiredApprovers: ["org-lead"],
    });
    expect(result.lifecycle.outcome.status).toBe("succeeded");
    expect(publish).toHaveBeenCalledOnce();
  });

  // KEIKO-0147 (round 2): the fix originally landed ONLY in git-merge-gateway. resolvePublishGate
  // is Gate 2 of runGitPublish — it guards the actual push — and still returned proceed=true for
  // ANY unexpired token. The test above passes only by coincidence: its approver happens to equal
  // the single required approver. This pin uses a MISMATCHED identity, so it fails against the
  // unguarded resolver and can never be satisfied by coincidence.
  it("blocks the push when the granting user is not in the decision's requiredApprovers set", async () => {
    const wrongApprover: GitDeliveryApprovalRequirement = {
      required: true,
      approvalTokenHash: "a".repeat(64),
      approvedByUserId: "someone-else",
      approvedAtMs: 0,
    };
    const { adapter, publish } = fakeAdapter(SUCCESS);
    const result = await runGitPublish(
      { command: command(), approval: wrongApprover },
      {
        adapter,
        snapshot: snapshot(),
        orgPolicyPack: approvalGateOrgPack(),
        repoPolicyPack: approvalGateRepoPack(),
        now: () => 1,
        newActionId: () => "a1",
      },
    );

    expect(result.lifecycle.outcome).toMatchObject({
      status: "blocked",
      blockReason: "approver-not-authorized",
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it("keeps an org protected-branch denial when the repo adds an approval gate", async () => {
    const approval: GitDeliveryApprovalRequirement = {
      required: true,
      approvalTokenHash: "a".repeat(64),
      approvedByUserId: "lead",
      approvedAtMs: 0,
    };
    const { adapter, publish } = fakeAdapter(SUCCESS);
    const result = await runGitPublish(
      { command: command({ remoteBranchName: "dev" }), approval },
      {
        adapter,
        snapshot: snapshot(),
        orgPolicyPack: protectedDevOrgPack(),
        repoPolicyPack: approvalGateRepoPack(),
        now: () => 1,
        newActionId: () => "a1",
      },
    );

    expect(result.lifecycle.outcome).toMatchObject({
      status: "blocked",
      category: "policy-block",
      blockReason: "protected-branch",
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it("requires a fresh approval after composite constraints pass", async () => {
    const first = fakeAdapter(SUCCESS);
    const missing = await runGitPublish(
      { command: command(), approval: NO_APPROVAL },
      {
        adapter: first.adapter,
        snapshot: snapshot(),
        orgPolicyPack: protectedDevOrgPack(),
        repoPolicyPack: approvalGateRepoPack(),
        now: () => 1_000,
        newActionId: () => "a1",
      },
    );
    const expiredApproval: GitDeliveryApprovalRequirement = {
      required: true,
      approvalTokenHash: "a".repeat(64),
      approvedByUserId: "lead",
      approvedAtMs: 1,
      expiresAtMs: 500,
    };
    const second = fakeAdapter(SUCCESS);
    const expired = await runGitPublish(
      { command: command(), approval: expiredApproval },
      {
        adapter: second.adapter,
        snapshot: snapshot(),
        orgPolicyPack: protectedDevOrgPack(),
        repoPolicyPack: approvalGateRepoPack(),
        now: () => 1_000,
        newActionId: () => "a2",
      },
    );

    expect(missing.lifecycle.outcome).toMatchObject({ status: "approval-required" });
    expect(expired.lifecycle.outcome).toMatchObject({
      status: "blocked",
      blockReason: "approval-expired",
    });
    expect(first.publish).not.toHaveBeenCalled();
    expect(second.publish).not.toHaveBeenCalled();
  });
});

describe("runGitPublish — execution + rejection surfacing", () => {
  it("executes a permitted push and reports success", async () => {
    const { adapter, publish } = fakeAdapter(SUCCESS);
    const result = await runGitPublish(
      { command: command({ setUpstreamTracking: true }), approval: NO_APPROVAL },
      {
        adapter,
        snapshot: snapshot({ hasUpstream: false }),
        repoPolicyPack: safePack(),
        now: () => 0,
        newActionId: () => "a1",
      },
    );
    expect(result.lifecycle.outcome.status).toBe("succeeded");
    expect(result.rejection).toBeUndefined();
    expect(publish).toHaveBeenCalledWith({
      sourceBranchName: "feat/x",
      remoteAlias: "origin",
      remoteBranchName: "feat/x",
      setUpstreamTracking: true,
    });
  });

  it("surfaces a remote rejection with its typed reason and recovery", async () => {
    const rejected: GitPublishExecResult = {
      schemaVersion: "1",
      outcome: "failed",
      durationMs: 9,
      errorCode: "precondition-failed",
      rejectionReason: "non-fast-forward",
    };
    const { adapter } = fakeAdapter(rejected);
    const result = await runGitPublish(
      { command: command(), approval: NO_APPROVAL },
      {
        adapter,
        snapshot: snapshot(),
        repoPolicyPack: safePack(),
        now: () => 0,
        newActionId: () => "a1",
      },
    );
    expect(result.lifecycle.outcome.status).toBe("recovery-required");
    expect(result.rejection).toEqual({
      reason: "non-fast-forward",
      disposition: "user-fixable",
      actionHint: "resolve-conflicts",
    });
  });

  it("classifies a provider rejection as a failed/provider-failure outcome", async () => {
    const rejected: GitPublishExecResult = {
      schemaVersion: "1",
      outcome: "failed",
      durationMs: 9,
      errorCode: "provider-rejected",
      rejectionReason: "permission-denied",
    };
    const { adapter } = fakeAdapter(rejected);
    const result = await runGitPublish(
      { command: command(), approval: NO_APPROVAL },
      {
        adapter,
        snapshot: snapshot(),
        repoPolicyPack: safePack(),
        now: () => 0,
        newActionId: () => "a1",
      },
    );
    expect(result.lifecycle.outcome).toMatchObject({
      status: "failed",
      category: "provider-failure",
    });
    expect(result.rejection?.reason).toBe("permission-denied");
  });

  it("does NOT surface a user-fixable rejection for an aborted (cancelled) push", async () => {
    const aborted: GitPublishExecResult = { schemaVersion: "1", outcome: "aborted", durationMs: 3 };
    const { adapter } = fakeAdapter(aborted);
    const result = await runGitPublish(
      { command: command(), approval: NO_APPROVAL },
      {
        adapter,
        snapshot: snapshot(),
        repoPolicyPack: safePack(),
        now: () => 0,
        newActionId: () => "a1",
      },
    );
    // The outcome is a non-success failure, but a cancellation is not a remote rejection: no descriptor.
    expect(result.rejection).toBeUndefined();
  });
});
