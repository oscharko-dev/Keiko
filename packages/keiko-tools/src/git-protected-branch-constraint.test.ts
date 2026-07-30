// The `protected-branch` DENY constraint, evaluated at EVERY gateway that resolves a `constrained`
// policy decision (Epic #470: publish #476, pull request #477, merge #478, local mutation kernel
// #472). Each gateway owns its own constraint evaluator, so a whole-class guarantee needs a
// whole-class test: the same pack shape must block a protected target and permit an ordinary one at
// all four, with the same precise `protected-branch` reason and the same fail-closed treatment of an
// unknown target.

import { describe, expect, it } from "vitest";
import type {
  GitDeliveryPolicyDecision,
  GitDeliveryPushInputs,
} from "@oscharko-dev/keiko-contracts";
import { evaluateGitPublishEffectivePolicy } from "./git-publish-gateway.js";
import { evaluateGitPullRequestEffectivePolicy } from "./git-pr-gateway.js";
import { evaluateGitMergeEffectivePolicy } from "./git-merge-gateway.js";
import { runGitMutation, type GitMutationOrchestratorDeps } from "./git-mutation-orchestrator.js";
import type { GitWorktreeSnapshot } from "./git-mutation-preflight.js";

const CONSTRAINED: GitDeliveryPolicyDecision = {
  outcome: "constrained",
  constraints: [
    {
      kind: "protected-branch",
      patterns: [
        { matchKind: "exact", value: "dev" },
        { matchKind: "exact", value: "main" },
        { matchKind: "prefix", value: "release/" },
      ],
    },
  ],
};

const PUSH_INPUTS: GitDeliveryPushInputs = {
  kind: "push",
  sourceBranchName: "my-work",
  remoteAlias: "origin",
  remoteBranchName: "my-work",
  forcePush: false,
  setUpstreamTracking: false,
};

const PROTECTED = ["dev", "main", "release/0.3.0"] as const;
const ORDINARY = ["my-work", "bugfix-123", "development", "release-notes"] as const;

const EVALUATORS: readonly (readonly [
  string,
  (target: string | undefined) => {
    readonly outcome: string;
    readonly blockReason?: string | undefined;
  },
])[] = [
  [
    "publish",
    (target): { readonly outcome: string; readonly blockReason?: string | undefined } =>
      evaluateGitPublishEffectivePolicy(CONSTRAINED, target, [], PUSH_INPUTS),
  ],
  [
    "pull-request",
    (target): { readonly outcome: string; readonly blockReason?: string | undefined } =>
      evaluateGitPullRequestEffectivePolicy(CONSTRAINED, target, [], "pr-create"),
  ],
  [
    "merge",
    (target): { readonly outcome: string; readonly blockReason?: string | undefined } =>
      evaluateGitMergeEffectivePolicy(CONSTRAINED, target, []),
  ],
];

describe("protected-branch constraint across every gateway", () => {
  for (const [name, evaluate] of EVALUATORS) {
    it.each(PROTECTED)(`${name}: blocks the protected target %s`, (target) => {
      expect(evaluate(target)).toEqual({ outcome: "blocked", blockReason: "protected-branch" });
    });

    it.each(ORDINARY)(`${name}: permits the ordinary target %s`, (target) => {
      expect(evaluate(target)).toEqual({ outcome: "allowed" });
    });

    it(`${name}: fails closed when the target is unknown`, () => {
      expect(evaluate(undefined)).toEqual({
        outcome: "blocked",
        blockReason: "protected-branch",
      });
    });
  }
});

// The local mutation kernel resolves the same constraint union. `branch-create` carries a branch
// name, so a pack can protect the branch a local mutation targets exactly as it protects a push.
describe("protected-branch constraint in the local mutation kernel", () => {
  const snapshot: GitWorktreeSnapshot = {
    headDetached: false,
    currentBranchName: "my-work",
    stagedFileCount: 0,
    unstagedFileCount: 0,
    untrackedFileCount: 0,
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    existingLocalBranchNames: ["my-work", "dev"],
    remoteAliases: ["origin"],
  };

  // Every adapter method throws: reaching any of them means the policy gate let a protected target
  // through, which is the failure this suite exists to catch.
  function refuse(): never {
    throw new Error("the adapter must not run for a policy-blocked mutation");
  }

  function deps(): GitMutationOrchestratorDeps {
    return {
      adapter: {
        createBranch: refuse,
        switchBranch: refuse,
        stage: refuse,
        unstage: refuse,
        commit: refuse,
        abort: refuse,
        recover: refuse,
      },
      snapshot,
      repoPolicyPack: {
        schemaVersion: "1",
        repoId: "test",
        rules: [
          {
            actionKind: "branch-switch",
            decision: "constrained",
            constraints: CONSTRAINED.outcome === "constrained" ? CONSTRAINED.constraints : [],
          },
        ],
        defaultRule: { decision: "blocked" },
      },
      now: () => 1,
      newActionId: () => "action-1",
    };
  }

  it("blocks a switch to a protected branch with the precise reason", async () => {
    const result = await runGitMutation(
      { command: { kind: "branch-switch", branchName: "dev" }, approval: { required: false } },
      deps(),
    );
    expect(result.outcome).toMatchObject({
      status: "blocked",
      category: "policy-block",
      blockReason: "protected-branch",
    });
  });
});
