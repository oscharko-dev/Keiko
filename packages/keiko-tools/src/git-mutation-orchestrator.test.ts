import { describe, expect, it } from "vitest";
import {
  GIT_DELIVERY_POLICY_SCHEMA_VERSION,
  GIT_DELIVERY_SCHEMA_VERSION,
  type GitDeliveryApprovalRequirement,
  type GitDeliveryExecutionResult,
  type GitDeliveryRepoPolicyPack,
  type GitDeliveryRuleDecision,
  type GitDeliveryConstraint,
} from "@oscharko-dev/keiko-contracts";
import type { GitLocalMutationAdapter } from "./git-mutation-adapter.js";
import type { GitWorktreeSnapshot } from "./git-mutation-preflight.js";
import {
  createInMemoryGitMutationJournal,
  gitMutationOutcomeFailureCategory,
  runGitMutation,
  type GitMutationCommand,
  type GitMutationOrchestratorDeps,
  type GitMutationRequest,
} from "./git-mutation-orchestrator.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────────────────────

function snapshot(overrides: Partial<GitWorktreeSnapshot> = {}): GitWorktreeSnapshot {
  return {
    headDetached: false,
    currentBranchName: "main",
    stagedFileCount: 1,
    unstagedFileCount: 0,
    untrackedFileCount: 0,
    hasUpstream: true,
    aheadCount: 1,
    behindCount: 0,
    existingLocalBranchNames: ["main"],
    remoteAliases: ["origin"],
    remoteReachable: true,
    operationInProgress: undefined,
    ...overrides,
  };
}

function exec(
  outcome: GitDeliveryExecutionResult["outcome"],
  errorCode?: GitDeliveryExecutionResult["errorCode"],
  partialDetail?: GitDeliveryExecutionResult["partialDetail"],
): GitDeliveryExecutionResult {
  return {
    schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
    outcome,
    durationMs: 5,
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(partialDetail !== undefined ? { partialDetail } : {}),
  };
}

interface FakeAdapter {
  readonly adapter: GitLocalMutationAdapter;
  readonly callCount: () => number;
}

function fakeAdapter(behavior: GitDeliveryExecutionResult | (() => never)): FakeAdapter {
  let calls = 0;
  const run = (): Promise<GitDeliveryExecutionResult> => {
    calls += 1;
    if (typeof behavior === "function") {
      behavior();
    }
    return Promise.resolve(behavior as GitDeliveryExecutionResult);
  };
  return {
    adapter: {
      createBranch: run,
      stage: run,
      unstage: run,
      commit: run,
      abort: run,
      recover: run,
    },
    callCount: () => calls,
  };
}

function repoPack(
  rules: GitDeliveryRepoPolicyPack["rules"],
  defaultDecision?: GitDeliveryRuleDecision,
): GitDeliveryRepoPolicyPack {
  return {
    schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
    repoId: "repo",
    rules,
    ...(defaultDecision !== undefined ? { defaultRule: { decision: defaultDecision } } : {}),
  };
}

const ALLOW_ALL = repoPack([], "allowed");
const NO_APPROVAL: GitDeliveryApprovalRequirement = { required: false };

function deps(
  adapter: GitLocalMutationAdapter,
  overrides: Partial<GitMutationOrchestratorDeps> = {},
): GitMutationOrchestratorDeps {
  return {
    adapter,
    snapshot: snapshot(),
    repoPolicyPack: ALLOW_ALL,
    now: () => 1000,
    newActionId: () => "action-1",
    ...overrides,
  };
}

const COMMIT: GitMutationCommand = { kind: "commit", message: "feat: thing", allowEmpty: false };

function request(
  command: GitMutationCommand = COMMIT,
  approval: GitDeliveryApprovalRequirement = NO_APPROVAL,
  idempotencyKey?: string,
): GitMutationRequest {
  return { command, approval, ...(idempotencyKey !== undefined ? { idempotencyKey } : {}) };
}

// ─── AC5: successful execution ───────────────────────────────────────────────────────────────

describe("orchestrator — successful execution", () => {
  it("runs the full lifecycle and emits a populated envelope", async () => {
    const fake = fakeAdapter(exec("succeeded"));
    const result = await runGitMutation(request(), deps(fake.adapter));
    expect(result.outcome.status).toBe("succeeded");
    expect(result.phaseReached).toBe("result");
    expect(fake.callCount()).toBe(1);
    // AC1: the envelope is descriptive-complete through policy + preview, and now carries execution.
    expect(result.envelope.policyDecision).toEqual({ outcome: "allowed" });
    expect(result.envelope.approvalRequirement).toEqual(NO_APPROVAL);
    expect(result.envelope.preview?.affectedBranchName).toBe("main");
    expect(result.envelope.preview?.estimatedFileCount).toBe(1);
    expect(result.envelope.executionResult?.outcome).toBe("succeeded");
    expect(gitMutationOutcomeFailureCategory(result.outcome)).toBeUndefined();
  });

  it("is deterministic: two identical requests with fixed deps yield identical results", async () => {
    // Determinism independent of the journal: with a fixed clock and id generator, the orchestrator
    // produces deeply-equal lifecycle results for identical inputs (AC1/AC2 at the orchestrator level).
    const fake = fakeAdapter(exec("succeeded"));
    const fixed = (): GitMutationOrchestratorDeps => deps(fake.adapter);
    const first = await runGitMutation(request(), fixed());
    const second = await runGitMutation(request(), fixed());
    expect(second).toEqual(first);
  });
});

// ─── AC5: preflight block ────────────────────────────────────────────────────────────────────

describe("orchestrator — preflight block", () => {
  it("halts at preflight and never calls the adapter", async () => {
    const fake = fakeAdapter(exec("succeeded"));
    const result = await runGitMutation(
      request(),
      deps(fake.adapter, { snapshot: snapshot({ stagedFileCount: 0 }) }),
    );
    expect(result.outcome.status).toBe("blocked");
    expect(result.phaseReached).toBe("preflight");
    expect(gitMutationOutcomeFailureCategory(result.outcome)).toBe("preflight-block");
    expect(fake.callCount()).toBe(0);
    if (result.outcome.status === "blocked" && result.outcome.category === "preflight-block") {
      expect(result.outcome.findings.map((f) => f.code)).toContain("nothing-staged-to-commit");
    }
  });
});

// ─── AC5: policy block ───────────────────────────────────────────────────────────────────────

describe("orchestrator — policy block", () => {
  it("halts at policy with a typed block reason and never calls the adapter", async () => {
    const fake = fakeAdapter(exec("succeeded"));
    const result = await runGitMutation(
      request(),
      deps(fake.adapter, {
        repoPolicyPack: repoPack([{ actionKind: "commit", decision: "blocked" }]),
      }),
    );
    expect(result.phaseReached).toBe("policy");
    expect(fake.callCount()).toBe(0);
    expect(result.outcome).toEqual({
      status: "blocked",
      category: "policy-block",
      blockReason: "policy-pack-blocked",
    });
  });

  it("fails closed when no policy rule applies", async () => {
    const fake = fakeAdapter(exec("succeeded"));
    const result = await runGitMutation(
      request(),
      deps(fake.adapter, { repoPolicyPack: repoPack([]) }),
    );
    expect(result.outcome).toEqual({
      status: "blocked",
      category: "policy-block",
      blockReason: "no-applicable-rule",
    });
    expect(fake.callCount()).toBe(0);
  });
});

// ─── AC5: adapter failure ────────────────────────────────────────────────────────────────────

describe("orchestrator — adapter failure", () => {
  it("classifies an internal adapter failure as execution-failure", async () => {
    const fake = fakeAdapter(exec("failed", "internal-error"));
    const result = await runGitMutation(request(), deps(fake.adapter));
    expect(result.outcome.status).toBe("failed");
    expect(gitMutationOutcomeFailureCategory(result.outcome)).toBe("execution-failure");
  });

  it("classifies a provider rejection as provider-failure", async () => {
    const fake = fakeAdapter(exec("failed", "provider-rejected"));
    const result = await runGitMutation(request(), deps(fake.adapter));
    expect(gitMutationOutcomeFailureCategory(result.outcome)).toBe("provider-failure");
  });

  it("classifies a network failure as provider-failure", async () => {
    const fake = fakeAdapter(exec("failed", "network-failure"));
    const result = await runGitMutation(request(), deps(fake.adapter));
    expect(gitMutationOutcomeFailureCategory(result.outcome)).toBe("provider-failure");
  });

  it("classifies a timeout as execution-failure", async () => {
    const fake = fakeAdapter(exec("failed", "timeout"));
    const result = await runGitMutation(request(), deps(fake.adapter));
    expect(gitMutationOutcomeFailureCategory(result.outcome)).toBe("execution-failure");
  });

  it("contains a thrown adapter as a structured internal-error result", async () => {
    const fake = fakeAdapter(() => {
      throw new Error("boom");
    });
    const result = await runGitMutation(request(), deps(fake.adapter));
    expect(result.outcome.status).toBe("failed");
    if (result.outcome.status === "failed") {
      expect(result.outcome.executionResult.errorCode).toBe("internal-error");
    }
  });
});

// ─── AC5: recovery-required ──────────────────────────────────────────────────────────────────

describe("orchestrator — recovery-required", () => {
  it("routes a conflict execution result into the recovery workflow", async () => {
    const fake = fakeAdapter(exec("failed", "conflict"));
    const result = await runGitMutation(request(), deps(fake.adapter));
    expect(result.outcome.status).toBe("recovery-required");
    expect(gitMutationOutcomeFailureCategory(result.outcome)).toBe("recovery-required");
  });

  it("routes a partially-applied recovery into the recovery workflow", async () => {
    const recovery: GitMutationCommand = {
      kind: "recovery",
      recoveryStrategyHint: "stash-and-reset",
      targetRefHash: "abc",
      affectedPathspecs: [],
    };
    const fake = fakeAdapter(
      exec("partial", "precondition-failed", { attemptedUnitCount: 2, succeededUnitCount: 1 }),
    );
    const result = await runGitMutation(
      request(recovery),
      deps(fake.adapter, {
        repoPolicyPack: repoPack([{ actionKind: "recovery", decision: "allowed" }]),
      }),
    );
    expect(result.outcome.status).toBe("recovery-required");
    // The structured partial detail is preserved end-to-end onto the execution result.
    if (result.outcome.status === "recovery-required") {
      expect(result.outcome.executionResult.partialDetail).toEqual({
        attemptedUnitCount: 2,
        succeededUnitCount: 1,
      });
    }
  });
});

// ─── Approval semantics ──────────────────────────────────────────────────────────────────────

describe("orchestrator — approval-gated policy", () => {
  const APPROVAL_GATED = repoPack([
    { actionKind: "commit", decision: "approval-gated", requiredApprovers: ["alice"] },
  ]);

  it("holds for approval when none is supplied", async () => {
    const fake = fakeAdapter(exec("succeeded"));
    const result = await runGitMutation(
      request(),
      deps(fake.adapter, { repoPolicyPack: APPROVAL_GATED }),
    );
    expect(result.outcome).toEqual({ status: "approval-required", requiredApprovers: ["alice"] });
    expect(result.phaseReached).toBe("policy");
    expect(fake.callCount()).toBe(0);
  });

  it("proceeds when a valid approval is supplied", async () => {
    const approval: GitDeliveryApprovalRequirement = {
      required: true,
      approvalTokenHash: "a".repeat(64),
      approvedByUserId: "alice",
      approvedAtMs: 900,
      expiresAtMs: 5000,
    };
    const fake = fakeAdapter(exec("succeeded"));
    const result = await runGitMutation(
      request(COMMIT, approval),
      deps(fake.adapter, { repoPolicyPack: APPROVAL_GATED }),
    );
    expect(result.outcome.status).toBe("succeeded");
    expect(fake.callCount()).toBe(1);
  });

  it("blocks with approval-expired when the approval has lapsed", async () => {
    const approval: GitDeliveryApprovalRequirement = {
      required: true,
      approvalTokenHash: "a".repeat(64),
      approvedByUserId: "alice",
      approvedAtMs: 100,
      expiresAtMs: 500,
    };
    const fake = fakeAdapter(exec("succeeded"));
    const result = await runGitMutation(
      request(COMMIT, approval),
      deps(fake.adapter, { repoPolicyPack: APPROVAL_GATED }),
    );
    expect(result.outcome).toEqual({
      status: "blocked",
      category: "policy-block",
      blockReason: "approval-expired",
    });
    expect(fake.callCount()).toBe(0);
  });
});

// ─── Constraint gates ──────────────────────────────────────────────────────────────────────

describe("orchestrator — constrained policy", () => {
  function constrained(constraints: readonly GitDeliveryConstraint[]): GitDeliveryRepoPolicyPack {
    return repoPack([{ actionKind: "commit", decision: "constrained", constraints }]);
  }

  it("proceeds when the target branch matches a branch-pattern constraint", async () => {
    const fake = fakeAdapter(exec("succeeded"));
    const result = await runGitMutation(
      request(),
      deps(fake.adapter, {
        repoPolicyPack: constrained([
          { kind: "branch-pattern", patterns: [{ matchKind: "exact", value: "main" }] },
        ]),
      }),
    );
    expect(result.outcome.status).toBe("succeeded");
  });

  it("blocks when the target branch fails the branch-pattern constraint", async () => {
    const fake = fakeAdapter(exec("succeeded"));
    const result = await runGitMutation(
      request(),
      deps(fake.adapter, {
        snapshot: snapshot({ currentBranchName: "feature/x" }),
        repoPolicyPack: constrained([
          { kind: "branch-pattern", patterns: [{ matchKind: "exact", value: "main" }] },
        ]),
      }),
    );
    expect(result.outcome).toMatchObject({ status: "blocked", blockReason: "policy-pack-blocked" });
    expect(fake.callCount()).toBe(0);
  });

  it("blocks when a required provider capability is absent", async () => {
    const fake = fakeAdapter(exec("succeeded"));
    const result = await runGitMutation(
      request(),
      deps(fake.adapter, {
        repoPolicyPack: constrained([{ kind: "provider-capability", capability: "draft-pr" }]),
      }),
    );
    expect(result.outcome).toMatchObject({
      status: "blocked",
      blockReason: "provider-capability-absent",
    });
  });

  it("proceeds when the required provider capability is active", async () => {
    const fake = fakeAdapter(exec("succeeded"));
    const result = await runGitMutation(
      request(),
      deps(fake.adapter, {
        activeProviderCapabilities: ["draft-pr"],
        repoPolicyPack: constrained([{ kind: "provider-capability", capability: "draft-pr" }]),
      }),
    );
    expect(result.outcome.status).toBe("succeeded");
  });

  it("blocks a recovery action that exceeds a risk-class ceiling", async () => {
    const recovery: GitMutationCommand = {
      kind: "recovery",
      recoveryStrategyHint: "soft-reset",
      targetRefHash: "abc",
      affectedPathspecs: [],
    };
    const fake = fakeAdapter(exec("succeeded"));
    const result = await runGitMutation(
      request(recovery),
      deps(fake.adapter, {
        repoPolicyPack: repoPack([
          {
            actionKind: "recovery",
            decision: "constrained",
            constraints: [{ kind: "risk-class-ceiling", maxRiskClass: "publish" }],
          },
        ]),
      }),
    );
    expect(result.outcome).toMatchObject({ status: "blocked", blockReason: "risk-class-ceiling" });
    expect(fake.callCount()).toBe(0);
  });
});

// ─── Idempotency ──────────────────────────────────────────────────────────────────────────────

describe("orchestrator — idempotency journal", () => {
  it("replays a recorded success without re-executing the mutation", async () => {
    const fake = fakeAdapter(exec("succeeded"));
    const journal = createInMemoryGitMutationJournal();
    const req = request(COMMIT, NO_APPROVAL, "key-1");
    const first = await runGitMutation(req, deps(fake.adapter, { journal }));
    const second = await runGitMutation(req, deps(fake.adapter, { journal }));
    expect(first.outcome.status).toBe("succeeded");
    expect(second).toBe(first); // identical recorded result
    expect(fake.callCount()).toBe(1); // executed exactly once
  });

  it("does not record a blocked result, so a retry can still execute", async () => {
    const fake = fakeAdapter(exec("succeeded"));
    const journal = createInMemoryGitMutationJournal();
    const req = request(COMMIT, NO_APPROVAL, "key-2");
    // First call blocks at preflight (nothing staged) and must NOT be journaled.
    await runGitMutation(
      req,
      deps(fake.adapter, { journal, snapshot: snapshot({ stagedFileCount: 0 }) }),
    );
    // Retry with a clean snapshot executes normally.
    const retry = await runGitMutation(req, deps(fake.adapter, { journal }));
    expect(retry.outcome.status).toBe("succeeded");
    expect(fake.callCount()).toBe(1);
  });
});
