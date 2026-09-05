// Pure tests for the governed GitHub pull request gateway (Issue #477): argv building (safe endpoints
// only), GitHub-error classification, effective policy resolution, and the runGitPullRequest lifecycle
// gates with a fake adapter — no `gh` subprocess, no network.

import { describe, expect, it, vi } from "vitest";
import type {
  GitDeliveryApprovalRequirement,
  GitDeliveryOrgPolicyPack,
  GitDeliveryPolicyDecision,
  GitDeliveryRepoPolicyPack,
} from "@oscharko-dev/keiko-contracts";
import { GIT_DELIVERY_POLICY_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-policy";
import type { GitWorktreeSnapshot } from "./git-mutation-preflight.js";
import {
  buildPrConvertDraftGraphqlArgv,
  buildPrCreateArgv,
  buildPrMarkReadyGraphqlArgv,
  buildPrUpdateArgv,
  classifyGitPullRequestRejection,
  evaluateGitPullRequestEffectivePolicy,
  GIT_PULL_REQUEST_ALLOWED_SUBCOMMANDS,
  gitPrArgvIsGoverned,
  GitPrArgvError,
  gitPullRequestRejectionFor,
  isGithubNodeId,
  runGitPullRequest,
  type GitPrCreateCommand,
  type GitPrExecResult,
  type GitPullRequestAdapter,
  type GitPullRequestCommand,
} from "./git-pr-gateway.js";

const NO_APPROVAL: GitDeliveryApprovalRequirement = { required: false };

function snapshot(overrides: Partial<GitWorktreeSnapshot> = {}): GitWorktreeSnapshot {
  return {
    headDetached: false,
    currentBranchName: "claude/issue-477-x",
    stagedFileCount: 0,
    unstagedFileCount: 0,
    untrackedFileCount: 0,
    hasUpstream: true,
    aheadCount: 1,
    behindCount: 0,
    existingLocalBranchNames: ["claude/issue-477-x"],
    remoteAliases: ["origin"],
    ...overrides,
  };
}

function createCommand(overrides: Partial<GitPrCreateCommand> = {}): GitPrCreateCommand {
  return {
    kind: "pr-create",
    ownerAndRepo: "oscharko-dev/Keiko",
    headBranchName: "claude/issue-477-x",
    baseBranchName: "dev",
    title: "feat: governed pr command center",
    body: "Implements the governed PR command center.",
    isDraft: false,
    ...overrides,
  };
}

// Permits pr-create/pr-update to the safe `dev` base within the protected-or-merge ceiling.
function safePack(): GitDeliveryRepoPolicyPack {
  return {
    schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
    repoId: "test",
    rules: [
      {
        actionKind: "pr-create",
        decision: "constrained",
        constraints: [
          { kind: "risk-class-ceiling", maxRiskClass: "protected-or-merge" },
          { kind: "branch-pattern", patterns: [{ matchKind: "exact", value: "dev" }] },
        ],
      },
    ],
    defaultRule: { decision: "blocked" },
  };
}

function fakeAdapter(result: GitPrExecResult): {
  adapter: GitPullRequestAdapter;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn((): Promise<GitPrExecResult> => Promise.resolve(result));
  const update = vi.fn((): Promise<GitPrExecResult> => Promise.resolve(result));
  return { adapter: { createPullRequest: create, updatePullRequest: update }, create, update };
}

const SUCCESS: GitPrExecResult = {
  schemaVersion: "1",
  outcome: "succeeded",
  durationMs: 5,
  createdPrExternalId: "1499",
};

function deps(over: {
  adapter: GitPullRequestAdapter;
  pack?: GitDeliveryRepoPolicyPack;
  orgPack?: GitDeliveryOrgPolicyPack;
}): Parameters<typeof runGitPullRequest>[1] {
  return {
    adapter: over.adapter,
    snapshot: snapshot(),
    ...(over.pack !== undefined ? { repoPolicyPack: over.pack } : {}),
    ...(over.orgPack !== undefined ? { orgPolicyPack: over.orgPack } : {}),
    now: () => 1_000,
    newActionId: () => "act-pr-1",
  };
}

describe("buildPrCreateArgv", () => {
  it("builds a governed POST /pulls argv with literal raw fields and a typed draft flag", () => {
    expect(buildPrCreateArgv(createCommand())).toEqual([
      "api",
      "--method",
      "POST",
      "/repos/oscharko-dev/Keiko/pulls",
      "-f",
      "title=feat: governed pr command center",
      "-f",
      "body=Implements the governed PR command center.",
      "-f",
      "head=claude/issue-477-x",
      "-f",
      "base=dev",
      "-F",
      "draft=false",
    ]);
  });

  it("emits draft=true when isDraft", () => {
    expect(buildPrCreateArgv({ ...createCommand(), isDraft: true })).toContain("draft=true");
  });

  it("rejects a malformed owner/repo, a flag-injecting ref, and an empty title", () => {
    expect(() => buildPrCreateArgv({ ...createCommand(), ownerAndRepo: "no-slash" })).toThrow(
      GitPrArgvError,
    );
    expect(() => buildPrCreateArgv({ ...createCommand(), headBranchName: "-x" })).toThrow(
      GitPrArgvError,
    );
    expect(() => buildPrCreateArgv({ ...createCommand(), title: "" })).toThrow(GitPrArgvError);
  });

  it("rejects a control character in the title", () => {
    expect(() =>
      buildPrCreateArgv({ ...createCommand(), title: `a${String.fromCharCode(1)}b` }),
    ).toThrow(GitPrArgvError);
  });

  it("permits newlines in the body but rejects a NUL", () => {
    expect(() => buildPrCreateArgv({ ...createCommand(), body: "line1\nline2" })).not.toThrow();
    expect(() =>
      buildPrCreateArgv({ ...createCommand(), body: `a${String.fromCharCode(0)}b` }),
    ).toThrow(GitPrArgvError);
  });

  // F16 (#3384 audit): the write path's ownerAndRepo validator must be exactly as strict as the read
  // path's isGitHubOwnerAndRepo — a dot-segment repository turns `/repos/${repo}/pulls` into a path
  // that escapes the intended resource. The pre-fix local OWNER_REPO_RE (`[A-Za-z0-9._-]+/[A-Za-z0-9._-]+`)
  // admitted all three of these; this pin fails on that regex and passes once buildPrCreateArgv routes
  // through isGitHubOwnerAndRepo.
  it("rejects a dot-segment repository and a leading-hyphen owner", () => {
    expect(() => buildPrCreateArgv({ ...createCommand(), ownerAndRepo: "owner/.." })).toThrow(
      GitPrArgvError,
    );
    expect(() => buildPrCreateArgv({ ...createCommand(), ownerAndRepo: "owner/." })).toThrow(
      GitPrArgvError,
    );
    expect(() => buildPrCreateArgv({ ...createCommand(), ownerAndRepo: "-owner/repo" })).toThrow(
      GitPrArgvError,
    );
  });

  // F26 (#3384 audit): assertBody must delegate to the one owner of body validation
  // (validGitPrBodyText, git-pr-body.ts) instead of a second, weaker control-char-only regex — closing
  // the byte-size cap and U+FFFD/round-trip gaps on the create path.
  it("rejects a body over the byte-size cap and a body containing U+FFFD", () => {
    expect(() => buildPrCreateArgv({ ...createCommand(), body: "x".repeat(65_537) })).toThrow(
      GitPrArgvError,
    );
    expect(() =>
      buildPrCreateArgv({ ...createCommand(), body: "has a \uFFFD replacement char" }),
    ).toThrow(GitPrArgvError);
  });
});

describe("buildPrUpdateArgv", () => {
  it("builds a governed PATCH /pulls/{n} argv", () => {
    expect(
      buildPrUpdateArgv({
        ownerAndRepo: "oscharko-dev/Keiko",
        prExternalId: "1499",
        baseBranchName: "dev",
        title: "feat: updated",
        body: "Updated body",
        convertToDraft: false,
        convertFromDraft: false,
      }),
    ).toEqual([
      "api",
      "--method",
      "PATCH",
      "/repos/oscharko-dev/Keiko/pulls/1499",
      "-f",
      "title=feat: updated",
      "-f",
      "body=Updated body",
      "-f",
      "base=dev",
    ]);
  });

  it("rejects a non-numeric PR id", () => {
    expect(() =>
      buildPrUpdateArgv({
        ownerAndRepo: "o/r",
        prExternalId: "12a",
        baseBranchName: "dev",
        title: "t",
        body: "b",
        convertToDraft: false,
        convertFromDraft: false,
      }),
    ).toThrow(GitPrArgvError);
  });

  // F16/F26 (#3384 audit): the update path shares the same ownerAndRepo/body validation gaps as
  // create — both must close identically.
  it("rejects a dot-segment repository, a leading-hyphen owner, an oversize body and a U+FFFD body", () => {
    const base = {
      prExternalId: "1499",
      baseBranchName: "dev",
      title: "feat: updated",
      body: "Updated body",
      convertToDraft: false,
      convertFromDraft: false,
    };
    expect(() => buildPrUpdateArgv({ ...base, ownerAndRepo: "owner/.." })).toThrow(GitPrArgvError);
    expect(() => buildPrUpdateArgv({ ...base, ownerAndRepo: "owner/." })).toThrow(GitPrArgvError);
    expect(() => buildPrUpdateArgv({ ...base, ownerAndRepo: "-owner/repo" })).toThrow(
      GitPrArgvError,
    );
    expect(() =>
      buildPrUpdateArgv({ ...base, ownerAndRepo: "o/r", body: "x".repeat(65_537) }),
    ).toThrow(GitPrArgvError);
    expect(() =>
      buildPrUpdateArgv({ ...base, ownerAndRepo: "o/r", body: "has a \uFFFD replacement char" }),
    ).toThrow(GitPrArgvError);
  });
});

describe("draft-toggle graphql builders", () => {
  it("builds mark-ready and convert-to-draft mutations and rejects a malformed node id", () => {
    expect(buildPrMarkReadyGraphqlArgv("PR_kwDO123")).toEqual([
      "api",
      "graphql",
      "-f",
      expect.stringContaining("markPullRequestReadyForReview"),
      "-f",
      "pullRequestId=PR_kwDO123",
    ]);
    expect(buildPrConvertDraftGraphqlArgv("PR_kwDO123")[3]).toContain("convertPullRequestToDraft");
    expect(() => buildPrMarkReadyGraphqlArgv("bad id!")).toThrow(GitPrArgvError);
  });
});

// F27 (#3384 audit): isGithubNodeId is the one owner of the node-id format; git-pr-node.ts's
// parseNodeId must reuse it rather than re-declaring the regex.
describe("isGithubNodeId — the one owner of the GitHub node-id format", () => {
  it("accepts the same shapes assertNodeId (via buildPrMarkReadyGraphqlArgv) accepts", () => {
    expect(isGithubNodeId("PR_kwDO123")).toBe(true);
    expect(() => buildPrMarkReadyGraphqlArgv("PR_kwDO123")).not.toThrow();
  });
  it("rejects the same shapes assertNodeId rejects: empty and disallowed characters", () => {
    expect(isGithubNodeId("")).toBe(false);
    expect(isGithubNodeId("bad id!")).toBe(false);
    expect(() => buildPrMarkReadyGraphqlArgv("")).toThrow(GitPrArgvError);
    expect(() => buildPrMarkReadyGraphqlArgv("bad id!")).toThrow(GitPrArgvError);
  });
});

describe("gitPrArgvIsGoverned", () => {
  it("is true only for an argv that begins with the api subcommand", () => {
    expect(gitPrArgvIsGoverned(buildPrCreateArgv(createCommand()))).toBe(true);
    expect(gitPrArgvIsGoverned(["push"])).toBe(false);
    expect(GIT_PULL_REQUEST_ALLOWED_SUBCOMMANDS).toEqual(["api"]);
  });
});

describe("classifyGitPullRequestRejection", () => {
  it("classifies the common GitHub failures with rate-limit before generic 403", () => {
    expect(classifyGitPullRequestRejection("A pull request already exists for o:b")).toBe(
      "already-exists",
    );
    expect(classifyGitPullRequestRejection("You have exceeded a secondary rate limit")).toBe(
      "rate-limited",
    );
    expect(classifyGitPullRequestRejection("gh: HTTP 403: Resource not accessible")).toBe(
      "permission-denied",
    );
    expect(classifyGitPullRequestRejection("gh: Not Found (HTTP 404)")).toBe("not-found");
    expect(
      classifyGitPullRequestRejection("Validation Failed (HTTP 422): no commits between"),
    ).toBe("validation-error");
    expect(classifyGitPullRequestRejection("HTTP 503: Service Unavailable")).toBe(
      "provider-unavailable",
    );
    expect(classifyGitPullRequestRejection("some other text")).toBe("unknown");
  });

  it("resolves ambiguous messages by the load-bearing row order (rate-limit > 403, already-exists > 422)", () => {
    expect(classifyGitPullRequestRejection("HTTP 403 and secondary rate limit exceeded")).toBe(
      "rate-limited",
    );
    expect(classifyGitPullRequestRejection("HTTP 422: a pull request already exists for o:b")).toBe(
      "already-exists",
    );
  });
});

describe("gitPullRequestRejectionFor", () => {
  it("composes the reused disposition + an action hint where one fits", () => {
    expect(gitPullRequestRejectionFor("rate-limited")).toEqual({
      reason: "rate-limited",
      disposition: "retryable",
      actionHint: "wait-for-provider",
    });
    expect(gitPullRequestRejectionFor("validation-error")).toEqual({
      reason: "validation-error",
      disposition: "user-fixable",
    });
  });
});

describe("evaluateGitPullRequestEffectivePolicy", () => {
  it("resolves a constrained decision against the base branch target", () => {
    const constrained: GitDeliveryPolicyDecision = {
      outcome: "constrained",
      constraints: [
        {
          kind: "branch-pattern",
          patterns: [{ matchKind: "exact", value: "dev" }],
        },
      ],
    };
    expect(evaluateGitPullRequestEffectivePolicy(constrained, "dev", [], "pr-create").outcome).toBe(
      "allowed",
    );
    const blocked = evaluateGitPullRequestEffectivePolicy(constrained, "main", [], "pr-create");
    expect(blocked.outcome).toBe("blocked");
    expect(blocked.blockReason).toBe("policy-pack-blocked");
  });

  it("retains approval only after every composite constraint passes", () => {
    const composite = {
      outcome: "approval-gated" as const,
      requiredApprovers: ["lead"],
      constraints: [
        {
          kind: "protected-branch" as const,
          patterns: [{ matchKind: "exact" as const, value: "main" }],
        },
      ],
    } as const;

    expect(evaluateGitPullRequestEffectivePolicy(composite, "main", [], "pr-create")).toMatchObject(
      { outcome: "blocked", blockReason: "protected-branch" },
    );
    expect(evaluateGitPullRequestEffectivePolicy(composite, "dev", [], "pr-create").outcome).toBe(
      "approval-gated",
    );
  });
});

describe("runGitPullRequest lifecycle gates", () => {
  it("blocks a base outside the allowed namespace before the adapter is called", async () => {
    const { adapter, create } = fakeAdapter(SUCCESS);
    const result = await runGitPullRequest(
      { command: createCommand({ baseBranchName: "main" }), approval: NO_APPROVAL },
      deps({ adapter, pack: safePack() }),
    );
    expect(result.lifecycle.outcome.status).toBe("blocked");
    expect(create).not.toHaveBeenCalled();
  });

  it("requires approval before the adapter is called when policy is approval-gated", async () => {
    const { adapter, create } = fakeAdapter(SUCCESS);
    const pack: GitDeliveryRepoPolicyPack = {
      schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
      repoId: "test",
      rules: [{ actionKind: "pr-create", decision: "approval-gated", requiredApprovers: ["lead"] }],
      defaultRule: { decision: "blocked" },
    };
    const result = await runGitPullRequest(
      { command: createCommand(), approval: NO_APPROVAL },
      deps({ adapter, pack }),
    );
    expect(result.lifecycle.outcome.status).toBe("approval-required");
    expect(create).not.toHaveBeenCalled();
  });

  it("does not let repo approval override an org protected-base constraint", async () => {
    const { adapter, create } = fakeAdapter(SUCCESS);
    const orgPack: GitDeliveryOrgPolicyPack = {
      schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
      orgId: "org",
      rules: [
        {
          actionKind: "pr-create",
          decision: "constrained",
          constraints: [
            {
              kind: "protected-branch",
              patterns: [{ matchKind: "exact", value: "main" }],
            },
          ],
        },
      ],
    };
    const repoPack: GitDeliveryRepoPolicyPack = {
      schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
      repoId: "repo",
      rules: [{ actionKind: "pr-create", decision: "approval-gated", requiredApprovers: ["lead"] }],
    };
    const approval: GitDeliveryApprovalRequirement = {
      required: true,
      approvalTokenHash: "a".repeat(64),
      approvedByUserId: "lead",
      approvedAtMs: 1,
    };
    const result = await runGitPullRequest(
      { command: createCommand({ baseBranchName: "main" }), approval },
      deps({ adapter, orgPack, pack: repoPack }),
    );

    expect(result.lifecycle.outcome).toMatchObject({
      status: "blocked",
      blockReason: "protected-branch",
    });
    expect(create).not.toHaveBeenCalled();
  });

  // KEIKO-0147 (round 2): the required-approver membership check originally landed only in
  // git-merge-gateway. This gate resolved a valid token straight to proceed=true, so a deployment
  // naming specific reviewers silently accepted ANY authenticated approval. The approver here is
  // deliberately NOT the required one, so this can never pass by coincidence.
  it("blocks the PR when the granting user is not in the decision's requiredApprovers set", async () => {
    const { adapter, create } = fakeAdapter(SUCCESS);
    const repoPack: GitDeliveryRepoPolicyPack = {
      schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
      repoId: "repo",
      rules: [{ actionKind: "pr-create", decision: "approval-gated", requiredApprovers: ["lead"] }],
    };
    const wrongApprover: GitDeliveryApprovalRequirement = {
      required: true,
      approvalTokenHash: "a".repeat(64),
      approvedByUserId: "someone-else",
      approvedAtMs: 1,
    };
    const result = await runGitPullRequest(
      { command: createCommand(), approval: wrongApprover },
      deps({ adapter, pack: repoPack }),
    );

    expect(result.lifecycle.outcome).toMatchObject({
      status: "blocked",
      blockReason: "approver-not-authorized",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("executes a permitted create and returns the provider-assigned PR number", async () => {
    const { adapter, create } = fakeAdapter(SUCCESS);
    const result = await runGitPullRequest(
      { command: createCommand(), approval: NO_APPROVAL },
      deps({ adapter, pack: safePack() }),
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.lifecycle.outcome.status).toBe("succeeded");
    expect(result.createdPrExternalId).toBe("1499");
    expect(result.rejection).toBeUndefined();
    // The envelope is content-free: byte lengths, not the title/body strings.
    const inputs = result.lifecycle.envelope.resolvedInputs;
    expect(JSON.stringify(inputs)).not.toContain("governed pr command center");
    expect(inputs.kind).toBe("pr-create");
  });

  it("retains canonical identity for reconciliation outside the evidence envelope", async () => {
    const identity = {
      number: 1499,
      externalId: "PR_kwDO123",
      url: "https://github.com/oscharko-dev/Keiko/pull/1499",
      repository: "oscharko-dev/Keiko",
      headRepository: "oscharko-dev/Keiko",
      headRef: "claude/issue-477-x",
      headSha: "a".repeat(40),
      baseRef: "dev",
      baseSha: "b".repeat(40),
      state: "open" as const,
      isDraft: true,
    };
    const { adapter, create } = fakeAdapter({ ...SUCCESS, createdPrIdentity: identity });
    const result = await runGitPullRequest(
      {
        command: createCommand({ isDraft: true, canonicalGitHubIdentity: true }),
        approval: NO_APPROVAL,
      },
      deps({ adapter, pack: safePack() }),
    );
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ canonicalGitHubIdentity: true }));
    expect(result.createdPrIdentity).toEqual(identity);
    expect(JSON.stringify(result.lifecycle.envelope)).not.toContain(identity.url);
    expect(JSON.stringify(result.lifecycle.envelope)).not.toContain(identity.externalId);
  });

  it("attaches a rejection descriptor when the provider rejects an executed create", async () => {
    const rejected: GitPrExecResult = {
      schemaVersion: "1",
      outcome: "failed",
      durationMs: 3,
      errorCode: "provider-rejected",
      rejectionReason: "validation-error",
    };
    const { adapter } = fakeAdapter(rejected);
    const result = await runGitPullRequest(
      { command: createCommand(), approval: NO_APPROVAL },
      deps({ adapter, pack: safePack() }),
    );
    expect(result.lifecycle.outcome.status).toBe("failed");
    expect(result.rejection?.reason).toBe("validation-error");
    expect(result.rejection?.disposition).toBe("user-fixable");
  });

  it("does not attach a rejection descriptor when the run was aborted", async () => {
    const aborted: GitPrExecResult = { schemaVersion: "1", outcome: "aborted", durationMs: 1 };
    const { adapter } = fakeAdapter(aborted);
    const result = await runGitPullRequest(
      { command: createCommand(), approval: NO_APPROVAL },
      deps({ adapter, pack: safePack() }),
    );
    expect(result.rejection).toBeUndefined();
  });

  it("routes pr-update through the update adapter method", async () => {
    const { adapter, create, update } = fakeAdapter(SUCCESS);
    const command: GitPullRequestCommand = {
      kind: "pr-update",
      ownerAndRepo: "oscharko-dev/Keiko",
      prExternalId: "1499",
      headBranchName: "claude/issue-477-x",
      baseBranchName: "dev",
      title: "feat: updated",
      body: "Updated",
      convertToDraft: false,
      convertFromDraft: true,
    };
    const pack: GitDeliveryRepoPolicyPack = {
      schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
      repoId: "test",
      rules: [
        {
          actionKind: "pr-update",
          decision: "constrained",
          constraints: [
            { kind: "branch-pattern", patterns: [{ matchKind: "exact", value: "dev" }] },
          ],
        },
      ],
      defaultRule: { decision: "blocked" },
    };
    const result = await runGitPullRequest(
      { command, approval: NO_APPROVAL },
      deps({ adapter, pack }),
    );
    expect(update).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(result.lifecycle.envelope.kind).toBe("pr-update");
  });
});
