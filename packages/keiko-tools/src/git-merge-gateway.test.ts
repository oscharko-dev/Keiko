// Deterministic unit coverage for the governed merge gateway (Issue #478) — AC1–AC5. The orchestrator is
// driven against a FAKE GitMergeAdapter (no `gh`, no network), proving: the readiness gate blocks a
// not-mergeable PR before mergePullRequest is called; the policy + final-approval gate blocks without a
// token; the argv builders map strategies and reject malformed operands; the classifier's ordering
// invariant holds; the mergeable-state mapper translates GitHub states to neutral facts; and the gateway
// only ever reaches the narrow adapter (no generic-fallback / no-bypass).

import { describe, expect, it, vi } from "vitest";
import {
  buildDeleteMergedBranchArgv,
  buildHeadStatusArgv,
  buildMergeArgv,
  buildMergeReadinessArgv,
  buildRepoMergeConfigArgv,
  classifyGitMergeRejection,
  evaluateGitMergeEffectivePolicy,
  GIT_MERGE_ALLOWED_SUBCOMMANDS,
  GitMergeArgvError,
  gitMergeArgvIsGoverned,
  mapRawMergeReadiness,
  runGitMerge,
  type GitMergeAdapter,
  type GitMergeCommand,
  type GitMergeExecRequest,
  type GitMergeExecResult,
  type GitMergeOrchestratorDeps,
  type GitMergeProviderReadiness,
} from "./git-merge-gateway.js";
import type { GitWorktreeSnapshot } from "./git-mutation-preflight.js";
import type {
  GitDeliveryApprovalRequirement,
  GitDeliveryPolicyDecision,
  GitDeliveryRepoPolicyPack,
} from "@oscharko-dev/keiko-contracts";

const SNAPSHOT: GitWorktreeSnapshot = {
  headDetached: false,
  currentBranchName: "feat/x",
  stagedFileCount: 0,
  unstagedFileCount: 0,
  untrackedFileCount: 0,
  hasUpstream: true,
  aheadCount: 1,
  behindCount: 0,
  existingLocalBranchNames: ["feat/x", "main"],
  remoteAliases: ["origin"],
};

const COMMAND: GitMergeCommand = {
  kind: "merge",
  ownerAndRepo: "oscharko-dev/Keiko",
  prExternalId: "42",
  baseBranchName: "main",
  headBranchName: "feat/x",
  mergeStrategy: "squash",
  deleteBranchAfterMerge: false,
};

const NO_APPROVAL: GitDeliveryApprovalRequirement = { required: false };

// Approval-gated default pack mirroring KEIKO_DEFAULT_MERGE_POLICY_PACK.
const APPROVAL_GATED_PACK: GitDeliveryRepoPolicyPack = {
  schemaVersion: "1",
  repoId: "test-merge",
  rules: [{ actionKind: "merge", decision: "approval-gated", requiredApprovers: [] }],
  defaultRule: { decision: "blocked" },
};

const ALLOW_PACK: GitDeliveryRepoPolicyPack = {
  schemaVersion: "1",
  repoId: "test-merge-allow",
  rules: [{ actionKind: "merge", decision: "allowed" }],
  defaultRule: { decision: "blocked" },
};

function readyProvider(over: Partial<GitMergeProviderReadiness> = {}): GitMergeProviderReadiness {
  return {
    pullRequest: {
      schemaVersion: "1",
      externalId: "42",
      status: "open",
      isDraft: false,
      headBranchName: "feat/x",
      baseBranchName: "main",
      mergeReadiness: { ready: true, requiredApprovalCount: 0, receivedApprovalCount: 0 },
    },
    providerCapableStrategies: ["squash", "merge-commit"],
    ...over,
  };
}

interface FakeAdapter extends GitMergeAdapter {
  readonly mergeCalls: () => readonly GitMergeExecRequest[];
}

function fakeAdapter(
  provider: GitMergeProviderReadiness,
  mergeResult: GitMergeExecResult,
): FakeAdapter {
  const mergeCalls: GitMergeExecRequest[] = [];
  return {
    mergeCalls: () => mergeCalls,
    readMergeReadiness: () => Promise.resolve(provider),
    mergePullRequest: (req: GitMergeExecRequest): Promise<GitMergeExecResult> => {
      mergeCalls.push(req);
      return Promise.resolve(mergeResult);
    },
  };
}

const SUCCEEDED: GitMergeExecResult = {
  schemaVersion: "1",
  outcome: "succeeded",
  durationMs: 5,
  merged: true,
};

function deps(
  adapter: GitMergeAdapter,
  repoPolicyPack: GitDeliveryRepoPolicyPack,
): GitMergeOrchestratorDeps {
  return {
    adapter,
    snapshot: SNAPSHOT,
    repoPolicyPack,
    now: (): number => 1_000,
    newActionId: (): string => "act-merge-1",
  };
}

describe("merge argv builders", () => {
  it("maps each strategy to the GitHub merge_method (provider-default omits it)", () => {
    expect(buildMergeArgv({ ...execReq(), mergeStrategy: "squash" })).toContain(
      "merge_method=squash",
    );
    expect(buildMergeArgv({ ...execReq(), mergeStrategy: "rebase" })).toContain(
      "merge_method=rebase",
    );
    expect(buildMergeArgv({ ...execReq(), mergeStrategy: "merge-commit" })).toContain(
      "merge_method=merge",
    );
    const def = buildMergeArgv({ ...execReq(), mergeStrategy: "provider-default" });
    expect(def.some((a) => a.startsWith("merge_method="))).toBe(false);
  });

  it("emits the merge PUT against the pull merge endpoint", () => {
    const argv = buildMergeArgv(execReq());
    expect(argv.slice(0, 4)).toEqual([
      "api",
      "--method",
      "PUT",
      "/repos/oscharko-dev/Keiko/pulls/42/merge",
    ]);
    expect(argv).toContain("--jq");
  });

  it("forwards the expected head sha as the merge guard", () => {
    const argv = buildMergeArgv({ ...execReq(), expectedHeadRefHash: "abcdef1234567890" });
    expect(argv).toContain("sha=abcdef1234567890");
  });

  it("rejects malformed operands", () => {
    expect(() => buildMergeArgv({ ...execReq(), ownerAndRepo: "no-slash" })).toThrow(
      GitMergeArgvError,
    );
    expect(() => buildMergeArgv({ ...execReq(), prExternalId: "0" })).toThrow(GitMergeArgvError);
    expect(() => buildMergeArgv({ ...execReq(), expectedHeadRefHash: "zzz" })).toThrow(
      GitMergeArgvError,
    );
  });

  it("builds the readiness, repo-config, head-status, and branch-delete argvs", () => {
    expect(buildMergeReadinessArgv({ ownerAndRepo: "o/r", prExternalId: "7" })).toEqual([
      "api",
      "/repos/o/r/pulls/7",
      "--jq",
      expect.stringContaining("mergeable_state"),
    ]);
    expect(buildRepoMergeConfigArgv({ ownerAndRepo: "o/r", prExternalId: "7" })[1]).toBe(
      "/repos/o/r",
    );
    expect(buildHeadStatusArgv("o/r", "abcdef1")).toEqual([
      "api",
      "/repos/o/r/commits/abcdef1/status",
      "--jq",
      ".state",
    ]);
    expect(buildDeleteMergedBranchArgv("o/r", "feat/x")).toEqual([
      "api",
      "--method",
      "DELETE",
      "/repos/o/r/git/refs/heads/feat/x",
    ]);
  });

  it("rejects a head branch with a flag-injection prefix in the delete builder", () => {
    expect(() => buildDeleteMergedBranchArgv("o/r", "-rf")).toThrow(GitMergeArgvError);
  });

  it("proves the no-generic-fallback property: every builder begins with the api subcommand", () => {
    expect(GIT_MERGE_ALLOWED_SUBCOMMANDS).toEqual(["api"]);
    expect(gitMergeArgvIsGoverned(buildMergeArgv(execReq()))).toBe(true);
    expect(gitMergeArgvIsGoverned(["push"])).toBe(false);
  });
});

describe("classifyGitMergeRejection (ordering invariant)", () => {
  it("classifies the distinct GitHub merge errors", () => {
    expect(classifyGitMergeRejection("HTTP 405: Pull Request is not mergeable")).toBe(
      "not-mergeable",
    );
    expect(
      classifyGitMergeRejection("Head branch was modified. Review and try the merge again."),
    ).toBe("head-modified");
    expect(classifyGitMergeRejection("At least 1 approving review is required")).toBe(
      "approvals-missing",
    );
    expect(classifyGitMergeRejection("Required status check 'ci' is expected")).toBe(
      "checks-failing",
    );
    expect(classifyGitMergeRejection("HTTP 403: Forbidden")).toBe("permission-denied");
    expect(classifyGitMergeRejection("HTTP 404: Not Found")).toBe("not-found");
    expect(classifyGitMergeRejection("HTTP 503: Service Unavailable")).toBe("provider-unavailable");
    expect(classifyGitMergeRejection("something unexpected")).toBe("unknown");
  });

  it("prefers rate-limited over the generic 403 permission classification", () => {
    expect(classifyGitMergeRejection("HTTP 403: API rate limit exceeded")).toBe("rate-limited");
  });

  it("prefers already-merged and head-modified over the generic not-mergeable classification", () => {
    expect(classifyGitMergeRejection("HTTP 405: Pull Request is already merged")).toBe(
      "already-merged",
    );
    expect(
      classifyGitMergeRejection(
        "HTTP 405: Base branch was modified; Pull Request is not mergeable",
      ),
    ).toBe("head-modified");
  });
});

describe("mapRawMergeReadiness", () => {
  it("maps mergeable_state to neutral merge readiness", () => {
    const clean = mapRawMergeReadiness({
      prNumber: "1",
      headBranchName: "f",
      mergeableState: "clean",
    });
    expect(clean.mergeReadiness.ready).toBe(true);
    const dirty = mapRawMergeReadiness({
      prNumber: "1",
      headBranchName: "f",
      mergeableState: "dirty",
    });
    expect(dirty.mergeReadiness).toMatchObject({ ready: false, blockingReason: "conflicts" });
    const blocked = mapRawMergeReadiness({
      prNumber: "1",
      headBranchName: "f",
      mergeableState: "blocked",
    });
    expect(blocked.mergeReadiness).toMatchObject({
      ready: false,
      blockingReason: "branch-protection",
    });
    const unknown = mapRawMergeReadiness({
      prNumber: "1",
      headBranchName: "f",
      mergeableState: "unknown",
    });
    expect(unknown.mergeReadiness.ready).toBe(false);
    expect(unknown.mergeReadiness.blockingReason).toBeUndefined();
  });

  it("derives status from merged/closed/open and reflects draft", () => {
    expect(mapRawMergeReadiness({ prNumber: "1", headBranchName: "f", merged: true }).status).toBe(
      "merged",
    );
    expect(
      mapRawMergeReadiness({ prNumber: "1", headBranchName: "f", state: "closed" }).status,
    ).toBe("closed");
    expect(mapRawMergeReadiness({ prNumber: "1", headBranchName: "f", draft: true }).isDraft).toBe(
      true,
    );
    expect(
      mapRawMergeReadiness({ prNumber: "1", headBranchName: "f", mergeableState: "draft" }).isDraft,
    ).toBe(true);
  });
});

describe("evaluateGitMergeEffectivePolicy", () => {
  it("resolves a constrained branch-pattern decision against the base target", () => {
    const decision: GitDeliveryPolicyDecision = {
      outcome: "constrained",
      constraints: [{ kind: "branch-pattern", patterns: [{ matchKind: "exact", value: "main" }] }],
    };
    expect(evaluateGitMergeEffectivePolicy(decision, "main", []).outcome).toBe("allowed");
    expect(evaluateGitMergeEffectivePolicy(decision, "rogue", []).outcome).toBe("blocked");
  });

  it("passes through allowed / blocked / approval-gated", () => {
    expect(evaluateGitMergeEffectivePolicy({ outcome: "allowed" }, "main", []).outcome).toBe(
      "allowed",
    );
    expect(
      evaluateGitMergeEffectivePolicy(
        { outcome: "blocked", reason: "protected-branch" },
        "main",
        [],
      ).outcome,
    ).toBe("blocked");
    expect(
      evaluateGitMergeEffectivePolicy(
        { outcome: "approval-gated", requiredApprovers: [] },
        "main",
        [],
      ).outcome,
    ).toBe("approval-gated");
  });
});

describe("runGitMerge gates (AC1/AC4/AC5)", () => {
  it("blocks at the policy/approval gate WITHOUT reading readiness or calling merge", async () => {
    const adapter = fakeAdapter(readyProvider(), SUCCEEDED);
    const readSpy = vi.spyOn(adapter, "readMergeReadiness");
    const result = await runGitMerge(
      { command: COMMAND, approval: NO_APPROVAL },
      deps(adapter, APPROVAL_GATED_PACK),
    );
    expect(result.lifecycle.outcome.status).toBe("approval-required");
    expect(adapter.mergeCalls()).toHaveLength(0);
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("blocks at the readiness gate when not mergeable, NEVER calling merge (AC1)", async () => {
    const provider = readyProvider({
      pullRequest: {
        schemaVersion: "1",
        externalId: "42",
        status: "open",
        isDraft: false,
        headBranchName: "feat/x",
        baseBranchName: "main",
        mergeReadiness: {
          ready: false,
          blockingReason: "conflicts",
          requiredApprovalCount: 0,
          receivedApprovalCount: 0,
        },
      },
    });
    const adapter = fakeAdapter(provider, SUCCEEDED);
    const result = await runGitMerge(
      { command: COMMAND, approval: NO_APPROVAL },
      deps(adapter, ALLOW_PACK),
    );
    expect(result.lifecycle.outcome.status).toBe("blocked");
    expect(result.readiness?.mergeable).toBe(false);
    expect(result.readiness?.blockers.some((b) => b.code === "conflicts")).toBe(true);
    expect(adapter.mergeCalls()).toHaveLength(0);
  });

  it("blocks at the readiness gate when the requested strategy is not provider-eligible", async () => {
    const adapter = fakeAdapter(
      readyProvider({ providerCapableStrategies: ["merge-commit"] }),
      SUCCEEDED,
    );
    const result = await runGitMerge(
      { command: { ...COMMAND, mergeStrategy: "squash" }, approval: NO_APPROVAL },
      deps(adapter, ALLOW_PACK),
    );
    expect(result.lifecycle.outcome.status).toBe("blocked");
    expect(result.readiness?.blockers.some((b) => b.code === "strategy-unavailable")).toBe(true);
    expect(adapter.mergeCalls()).toHaveLength(0);
  });

  it("treats a provider read failure as an internal failure (fail-closed, no merge)", async () => {
    const adapter = fakeAdapter({ providerCapableStrategies: [], providerError: true }, SUCCEEDED);
    const result = await runGitMerge(
      { command: COMMAND, approval: NO_APPROVAL },
      deps(adapter, ALLOW_PACK),
    );
    expect(result.lifecycle.outcome.status).toBe("failed");
    expect(adapter.mergeCalls()).toHaveLength(0);
  });

  it("executes the merge only when policy, approval, and readiness all pass", async () => {
    const adapter = fakeAdapter(readyProvider(), SUCCEEDED);
    const result = await runGitMerge(
      { command: COMMAND, approval: NO_APPROVAL },
      deps(adapter, ALLOW_PACK),
    );
    expect(result.lifecycle.outcome.status).toBe("succeeded");
    expect(result.merged).toBe(true);
    expect(adapter.mergeCalls()).toHaveLength(1);
    expect(adapter.mergeCalls()[0]?.mergeStrategy).toBe("squash");
  });

  it("surfaces the provider rejection descriptor on a rejected merge", async () => {
    const rejected: GitMergeExecResult = {
      schemaVersion: "1",
      outcome: "failed",
      durationMs: 3,
      errorCode: "conflict",
      rejectionReason: "conflict",
    };
    const adapter = fakeAdapter(readyProvider(), rejected);
    const result = await runGitMerge(
      { command: COMMAND, approval: NO_APPROVAL },
      deps(adapter, ALLOW_PACK),
    );
    expect(result.lifecycle.outcome.status).toBe("recovery-required");
    expect(result.rejection?.reason).toBe("conflict");
    expect(result.rejection?.actionHint).toBe("resolve-conflicts");
  });

  it("records a kernel-shaped merge lifecycle (so the #474 evidence builder consumes it unchanged)", async () => {
    const adapter = fakeAdapter(readyProvider(), SUCCEEDED);
    const result = await runGitMerge(
      { command: COMMAND, approval: NO_APPROVAL },
      deps(adapter, ALLOW_PACK),
    );
    expect(result.lifecycle.envelope.kind).toBe("merge");
    expect(result.lifecycle.envelope.resolvedInputs).toMatchObject({
      kind: "merge",
      prExternalId: "42",
      mergeStrategyHint: "squash",
      deleteBranchAfterMerge: false,
    });
    expect(result.lifecycle.phaseReached).toBe("result");
  });
});

describe("mapRawMergeReadiness — all mergeable states", () => {
  const cases: readonly (readonly [string, boolean, string | undefined])[] = [
    ["clean", true, undefined],
    ["has_hooks", true, undefined],
    ["unstable", true, undefined],
    ["dirty", false, "conflicts"],
    ["blocked", false, "branch-protection"],
    ["behind", false, "branch-protection"],
    ["unknown", false, undefined],
  ];
  for (const [state, ready, reason] of cases) {
    it(`maps mergeable_state="${state}"`, () => {
      const pr = mapRawMergeReadiness({
        prNumber: "1",
        headBranchName: "feat/x",
        mergeableState: state,
      });
      expect(pr.mergeReadiness.ready).toBe(ready);
      expect(pr.mergeReadiness.blockingReason).toBe(reason);
    });
  }

  it("defaults the base branch to a sentinel when the provider omits it", () => {
    const pr = mapRawMergeReadiness({ prNumber: "9", headBranchName: "feat/x" });
    expect(pr.baseBranchName).toBe("unknown");
    expect(pr.status).toBe("open");
  });
});

describe("evaluateGitMergeEffectivePolicy — capability + ceiling constraints", () => {
  it("blocks when a required provider capability is absent and allows when present", () => {
    const decision: GitDeliveryPolicyDecision = {
      outcome: "constrained",
      constraints: [{ kind: "provider-capability", capability: "merge-queue" }],
    };
    expect(evaluateGitMergeEffectivePolicy(decision, "main", []).blockReason).toBe(
      "provider-capability-absent",
    );
    expect(evaluateGitMergeEffectivePolicy(decision, "main", ["merge-queue"]).outcome).toBe(
      "allowed",
    );
  });

  it("blocks when the merge risk class exceeds the ceiling and allows at the merge ceiling", () => {
    const tooLow: GitDeliveryPolicyDecision = {
      outcome: "constrained",
      constraints: [{ kind: "risk-class-ceiling", maxRiskClass: "local-mutation" }],
    };
    expect(evaluateGitMergeEffectivePolicy(tooLow, "main", []).blockReason).toBe(
      "risk-class-ceiling",
    );
    const atCeiling: GitDeliveryPolicyDecision = {
      outcome: "constrained",
      constraints: [{ kind: "risk-class-ceiling", maxRiskClass: "protected-or-merge" }],
    };
    expect(evaluateGitMergeEffectivePolicy(atCeiling, "main", []).outcome).toBe("allowed");
  });
});

describe("runGitMerge — remaining gate + execution branches", () => {
  it("blocks with approval-expired when the granted approval has lapsed", async () => {
    const adapter = fakeAdapter(readyProvider(), SUCCEEDED);
    const expired: GitDeliveryApprovalRequirement = {
      required: true,
      approvalTokenHash: "a".repeat(64),
      approvedByUserId: "u-1",
      approvedAtMs: 1,
      expiresAtMs: 500,
    };
    const result = await runGitMerge(
      { command: COMMAND, approval: expired },
      deps(adapter, APPROVAL_GATED_PACK),
    );
    expect(result.lifecycle.outcome).toMatchObject({
      status: "blocked",
      blockReason: "approval-expired",
    });
    expect(adapter.mergeCalls()).toHaveLength(0);
  });

  it("blocks at a constrained branch-pattern that the base does not match", async () => {
    const adapter = fakeAdapter(readyProvider(), SUCCEEDED);
    const pack: GitDeliveryRepoPolicyPack = {
      schemaVersion: "1",
      repoId: "constrained",
      rules: [
        {
          actionKind: "merge",
          decision: "constrained",
          constraints: [
            { kind: "branch-pattern", patterns: [{ matchKind: "exact", value: "release/1" }] },
          ],
        },
      ],
      defaultRule: { decision: "blocked" },
    };
    const result = await runGitMerge(
      { command: COMMAND, approval: NO_APPROVAL },
      deps(adapter, pack),
    );
    expect(result.lifecycle.outcome).toMatchObject({
      status: "blocked",
      blockReason: "policy-pack-blocked",
    });
    expect(adapter.mergeCalls()).toHaveLength(0);
  });

  it("fails closed (no merge) when the readiness read throws", async () => {
    const throwingAdapter: GitMergeAdapter = {
      readMergeReadiness: () => Promise.reject(new Error("gh exploded")),
      mergePullRequest: () => Promise.resolve(SUCCEEDED),
    };
    const result = await runGitMerge(
      { command: COMMAND, approval: NO_APPROVAL },
      deps(throwingAdapter, ALLOW_PACK),
    );
    expect(result.lifecycle.outcome.status).toBe("failed");
    expect(result.readiness?.blockers.some((b) => b.code === "provider-error")).toBe(true);
  });

  it("turns a thrown merge adapter into an internal-error failure", async () => {
    const adapter: GitMergeAdapter = {
      readMergeReadiness: () => Promise.resolve(readyProvider()),
      mergePullRequest: () => Promise.reject(new Error("merge exploded")),
    };
    const result = await runGitMerge(
      { command: COMMAND, approval: NO_APPROVAL },
      deps(adapter, ALLOW_PACK),
    );
    expect(result.lifecycle.outcome.status).toBe("failed");
  });

  it("classifies a network-failure rejection as a provider-failure (not recovery-required)", async () => {
    const rejected: GitMergeExecResult = {
      schemaVersion: "1",
      outcome: "failed",
      durationMs: 1,
      errorCode: "network-failure",
      rejectionReason: "provider-unavailable",
    };
    const adapter = fakeAdapter(readyProvider(), rejected);
    const result = await runGitMerge(
      { command: COMMAND, approval: NO_APPROVAL },
      deps(adapter, ALLOW_PACK),
    );
    expect(result.lifecycle.outcome.status).toBe("failed");
    expect(result.rejection?.reason).toBe("provider-unavailable");
  });

  it("carries merged + branchDeleted through a successful delete-after-merge", async () => {
    const merged: GitMergeExecResult = {
      schemaVersion: "1",
      outcome: "succeeded",
      durationMs: 2,
      merged: true,
      branchDeleted: true,
    };
    const adapter = fakeAdapter(readyProvider(), merged);
    const result = await runGitMerge(
      { command: { ...COMMAND, deleteBranchAfterMerge: true }, approval: NO_APPROVAL },
      deps(adapter, ALLOW_PACK),
    );
    expect(result.merged).toBe(true);
    expect(result.branchDeleted).toBe(true);
  });
});

function execReq(): GitMergeExecRequest {
  return {
    ownerAndRepo: "oscharko-dev/Keiko",
    prExternalId: "42",
    headBranchName: "feat/x",
    mergeStrategy: "squash",
    deleteBranchAfterMerge: false,
  };
}
