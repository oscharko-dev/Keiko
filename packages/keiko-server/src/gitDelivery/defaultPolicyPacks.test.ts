import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  GitDeliveryActionKind,
  GitDeliveryApprovalRequirement,
  GitDeliveryRepoPolicyPack,
} from "@oscharko-dev/keiko-contracts";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import type {
  GitLocalMutationAdapter,
  GitMergeAdapter,
  GitMergeCommand,
  GitMutationCommand,
  GitPullRequestAdapter,
  GitPullRequestCommand,
  GitPushCommand,
  GitRemotePublishAdapter,
  GitWorktreeSnapshot,
} from "@oscharko-dev/keiko-tools";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";

// Captures every call this test file's module graph makes into `defaultMintableRepoPack` (the
// `seams.policyPacks ?? defaultMintableRepoPack(KEIKO_DEFAULT_*_POLICY_PACK)` fallback guard added
// by KEIKO-0526). Declared before the mock factory purely for readability; the factory's inner
// closure is only INVOKED later, from inside an `it()` body, long after this module's own top-level
// code (including this declaration) has finished running -- see memory-handlers-securitylog-wiring
// .test.ts for the same pattern.
const defaultMintableRepoPackCalls: GitDeliveryRepoPolicyPack[] = [];

// Delegates to the REAL implementation (so every behavioral test below, including the ones that
// don't care about wiring, keeps exercising genuine guard logic) while also recording every call, so
// the "mutating route groups" suite can prove the fallback -- and only the fallback, never a
// seams.policyPacks override -- actually invokes the guard, without needing to mutate the shared
// KEIKO_DEFAULT_*_POLICY_PACK singletons (which would pollute every other test sharing them).
vi.mock("./policyPackMintability.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./policyPackMintability.js")>();
  return {
    ...actual,
    defaultMintableRepoPack: (repoPack: GitDeliveryRepoPolicyPack): unknown => {
      defaultMintableRepoPackCalls.push(repoPack);
      return actual.defaultMintableRepoPack(repoPack);
    },
  };
});

import { assertPolicyPackMintable } from "./defaultPolicyPacks.js";
import { executeGovernedMutation } from "./execution.js";
import { KEIKO_DEFAULT_LOCAL_GIT_POLICY_PACK } from "./execution.js";
import { executeGovernedMerge, KEIKO_DEFAULT_MERGE_POLICY_PACK } from "./mergeExecution.js";
import { defaultMintableRepoPack } from "./policyPackMintability.js";
import { executeGovernedPullRequest, KEIKO_DEFAULT_PR_POLICY_PACK } from "./prExecution.js";
import { executeGovernedPublish, KEIKO_DEFAULT_PUBLISH_POLICY_PACK } from "./pushExecution.js";

// KEIKO-0526: only merge exposes an /approve mint route today. A future policy pack that named
// approval-gated for another action kind would silently fail closed at execute time with no
// operator-actionable pointer to the misconfiguration. This test pins the load-time guard.
describe("assertPolicyPackMintable (KEIKO-0526)", () => {
  it("throws for approval-gated rule on a non-mintable action kind", () => {
    const pack: GitDeliveryRepoPolicyPack = {
      schemaVersion: "1",
      repoId: "test-repo",
      rules: [{ actionKind: "push", decision: "approval-gated", requiredApprovers: [] }],
    };
    expect(() => {
      assertPolicyPackMintable(pack);
    }).toThrow(/approval-gated/);
  });

  it("accepts approval-gated rule on the mintable action kind (merge)", () => {
    const pack: GitDeliveryRepoPolicyPack = {
      schemaVersion: "1",
      repoId: "test-repo",
      rules: [{ actionKind: "merge", decision: "approval-gated", requiredApprovers: [] }],
    };
    expect(() => {
      assertPolicyPackMintable(pack);
    }).not.toThrow();
  });

  it("accepts a pack whose rules are all constrained/blocked/allowed", () => {
    const pack: GitDeliveryRepoPolicyPack = {
      schemaVersion: "1",
      repoId: "test-repo",
      rules: [
        { actionKind: "push", decision: "blocked" },
        { actionKind: "commit", decision: "allowed" },
        { actionKind: "pr-create", decision: "blocked" },
      ],
    };
    expect(() => {
      assertPolicyPackMintable(pack);
    }).not.toThrow();
  });

  it("throws when default rule is approval-gated (applies to every action kind)", () => {
    const pack: GitDeliveryRepoPolicyPack = {
      schemaVersion: "1",
      repoId: "test-repo",
      rules: [],
      defaultRule: { decision: "approval-gated", requiredApprovers: [] },
    };
    expect(() => {
      assertPolicyPackMintable(pack);
    }).toThrow(/default rule/);
  });
});

function unmintablePack(actionKind: GitDeliveryActionKind): GitDeliveryRepoPolicyPack {
  return {
    schemaVersion: "1",
    repoId: "test-repo",
    rules: [{ actionKind, decision: "approval-gated", requiredApprovers: [] }],
  };
}

// KEIKO-0526 follow-up: `defaultMintableRepoPack` is the wrapper every mutating route group's own
// `seams.policyPacks ?? ...` fallback now calls instead of a bare `{ repoPack: KEIKO_DEFAULT_*
// _POLICY_PACK }` literal. It must validate exactly like `assertPolicyPackMintable` and hand back
// the pack unchanged, wrapped, when it IS mintable.
describe("defaultMintableRepoPack (KEIKO-0526)", () => {
  it("returns the pack wrapped, unchanged, when it is mintable", () => {
    const pack = unmintablePack("merge"); // "merge" IS mintable, despite the helper's name
    expect(defaultMintableRepoPack(pack)).toEqual({ repoPack: pack });
  });

  it("throws for an unmintable pack, naming the offending action kind", () => {
    // "commit" joined MINTABLE_ACTION_KINDS with #3386 (its own execute path now unconditionally
    // requires a consumed claim); "abort" has no mint route and none is planned, so it stays the
    // non-mintable example.
    expect(() => {
      defaultMintableRepoPack(unmintablePack("abort"));
    }).toThrow(/approval-gated for 'abort'/);
  });
});

// KEIKO-0526 follow-up: the guard was already unit-tested above in isolation, but until now nothing
// proved the shipped KEIKO_DEFAULT_*_POLICY_PACK constants -- the ones that actually reach
// production traffic -- stay mintable. If a future edit ever adds a non-'merge' approval-gated rule
// to any of these 4 constants, the corresponding assertion below fails immediately, at the exact
// layer the finding is about (before it can ever reach a real request).
describe("shipped KEIKO_DEFAULT_*_POLICY_PACK constants remain mintable (KEIKO-0526)", () => {
  it("KEIKO_DEFAULT_MERGE_POLICY_PACK (merge route group)", () => {
    expect(() => {
      defaultMintableRepoPack(KEIKO_DEFAULT_MERGE_POLICY_PACK);
    }).not.toThrow();
  });

  it("KEIKO_DEFAULT_LOCAL_GIT_POLICY_PACK (commit + local-mutation route groups)", () => {
    expect(() => {
      defaultMintableRepoPack(KEIKO_DEFAULT_LOCAL_GIT_POLICY_PACK);
    }).not.toThrow();
  });

  it("KEIKO_DEFAULT_PR_POLICY_PACK (pr route group)", () => {
    expect(() => {
      defaultMintableRepoPack(KEIKO_DEFAULT_PR_POLICY_PACK);
    }).not.toThrow();
  });

  it("KEIKO_DEFAULT_PUBLISH_POLICY_PACK (push route group)", () => {
    expect(() => {
      defaultMintableRepoPack(KEIKO_DEFAULT_PUBLISH_POLICY_PACK);
    }).not.toThrow();
  });
});

// KEIKO-0526 follow-up: neither of the two suites above proves the fallback at each of the 5 mutating
// route groups' own pack-resolution site actually CALLS defaultMintableRepoPack -- that is a wiring
// fact about mergeExecution.ts/execution.ts/prExecution.ts/pushExecution.ts (and their *Routes.ts
// preview siblings), not about the guard function itself. This suite drives the real execute-side
// entry point of every route group (commit and local-mutation share executeGovernedMutation, so one
// call proves both) and asserts, via the module mock above, that:
//   (a) omitting seams.policyPacks (the real production shape at all 8 sites today) calls
//       defaultMintableRepoPack with exactly that route group's shipped default -- the wiring this
//       finding was about; and
//   (b) supplying seams.policyPacks (as commitRoutes.test.ts's and prRoutes.test.ts's existing
//       approval-gated-override kernel tests legitimately do, to test the kernel's generic policy
//       evaluation independent of HTTP-mint-route reachability) never calls it at all -- proving this
//       fix does not regress that unrelated, already-passing coverage.
// Deleting the `defaultMintableRepoPack(...)` call from any one of the 4 execution modules (reverting
// it to a bare `{ repoPack: KEIKO_DEFAULT_*_POLICY_PACK }` literal) makes that route group's (a) test
// below fail: the calls array stays empty.
describe("mutating route groups wire their fallback default through defaultMintableRepoPack (KEIKO-0526)", () => {
  const WORKSPACE: WorkspaceInfo = {
    root: "/tmp/keiko-policy-pack-mintability-test",
    selectedRoot: "/tmp/keiko-policy-pack-mintability-test",
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
  const NOT_REQUIRED: GitDeliveryApprovalRequirement = { required: false };
  const SNAPSHOT: GitWorktreeSnapshot = {
    headDetached: false,
    currentBranchName: "feat/x",
    stagedFileCount: 0,
    unstagedFileCount: 0,
    untrackedFileCount: 0,
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    existingLocalBranchNames: ["feat/x", "main"],
    remoteAliases: ["origin"],
  };
  const DEPS = {
    evidenceStore: createInMemoryEvidenceStore(),
    redactor: (value: unknown): unknown => value,
  };

  beforeEach(() => {
    defaultMintableRepoPackCalls.length = 0;
  });

  it("merge route group (executeGovernedMerge)", async () => {
    const command: GitMergeCommand = {
      kind: "merge",
      ownerAndRepo: "oscharko-dev/Keiko",
      prExternalId: "1",
      baseBranchName: "main",
      headBranchName: "feat/x",
      mergeStrategy: "squash",
      deleteBranchAfterMerge: false,
    };
    const seams = {
      snapshotReader: (): Promise<GitWorktreeSnapshot> => Promise.resolve(SNAPSHOT),
      mergeAdapterFactory: (): GitMergeAdapter => ({}) as unknown as GitMergeAdapter,
    };
    await executeGovernedMerge(command, NOT_REQUIRED, WORKSPACE, DEPS, seams).catch(
      () => undefined,
    );
    expect(defaultMintableRepoPackCalls).toEqual([KEIKO_DEFAULT_MERGE_POLICY_PACK]);

    defaultMintableRepoPackCalls.length = 0;
    await executeGovernedMerge(command, NOT_REQUIRED, WORKSPACE, DEPS, {
      ...seams,
      policyPacks: { repoPack: unmintablePack("push") },
    }).catch(() => undefined);
    expect(defaultMintableRepoPackCalls).toEqual([]);
  });

  it("commit + local-mutation route groups (executeGovernedMutation)", async () => {
    const command: GitMutationCommand = { kind: "commit", message: "feat: x", allowEmpty: false };
    const seams = {
      snapshotReader: (): Promise<GitWorktreeSnapshot> => Promise.resolve(SNAPSHOT),
      adapterFactory: (): GitLocalMutationAdapter => ({}) as unknown as GitLocalMutationAdapter,
    };
    await executeGovernedMutation(command, NOT_REQUIRED, WORKSPACE, DEPS, seams, undefined).catch(
      () => undefined,
    );
    expect(defaultMintableRepoPackCalls).toEqual([KEIKO_DEFAULT_LOCAL_GIT_POLICY_PACK]);

    defaultMintableRepoPackCalls.length = 0;
    await executeGovernedMutation(
      command,
      NOT_REQUIRED,
      WORKSPACE,
      DEPS,
      { ...seams, policyPacks: { repoPack: unmintablePack("commit") } },
      undefined,
    ).catch(() => undefined);
    expect(defaultMintableRepoPackCalls).toEqual([]);
  });

  it("pr route group (executeGovernedPullRequest)", async () => {
    const command: GitPullRequestCommand = {
      kind: "pr-update",
      ownerAndRepo: "oscharko-dev/Keiko",
      prExternalId: "1",
      headBranchName: "feat/x",
      baseBranchName: "main",
      title: "t",
      body: "b",
      convertToDraft: false,
      convertFromDraft: false,
    };
    const seams = {
      snapshotReader: (): Promise<GitWorktreeSnapshot> => Promise.resolve(SNAPSHOT),
      prAdapterFactory: (): GitPullRequestAdapter => ({}) as unknown as GitPullRequestAdapter,
    };
    await executeGovernedPullRequest(command, NOT_REQUIRED, WORKSPACE, DEPS, seams).catch(
      () => undefined,
    );
    expect(defaultMintableRepoPackCalls).toEqual([KEIKO_DEFAULT_PR_POLICY_PACK]);

    defaultMintableRepoPackCalls.length = 0;
    await executeGovernedPullRequest(command, NOT_REQUIRED, WORKSPACE, DEPS, {
      ...seams,
      policyPacks: { repoPack: unmintablePack("pr-create") },
    }).catch(() => undefined);
    expect(defaultMintableRepoPackCalls).toEqual([]);
  });

  it("push route group (executeGovernedPublish)", async () => {
    const command: GitPushCommand = {
      kind: "push",
      sourceBranchName: "feat/x",
      remoteAlias: "origin",
      remoteBranchName: "feat/x",
      forcePush: false,
      setUpstreamTracking: false,
    };
    const seams = {
      snapshotReader: (): Promise<GitWorktreeSnapshot> => Promise.resolve(SNAPSHOT),
      publishAdapterFactory: (): GitRemotePublishAdapter =>
        ({}) as unknown as GitRemotePublishAdapter,
    };
    await executeGovernedPublish(command, NOT_REQUIRED, WORKSPACE, DEPS, seams, undefined).catch(
      () => undefined,
    );
    expect(defaultMintableRepoPackCalls).toEqual([KEIKO_DEFAULT_PUBLISH_POLICY_PACK]);

    defaultMintableRepoPackCalls.length = 0;
    await executeGovernedPublish(
      command,
      NOT_REQUIRED,
      WORKSPACE,
      DEPS,
      { ...seams, policyPacks: { repoPack: unmintablePack("push") } },
      undefined,
    ).catch(() => undefined);
    expect(defaultMintableRepoPackCalls).toEqual([]);
  });
});
