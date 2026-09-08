import { describe, expect, it } from "vitest";
import type { GitDeliveryResolvedInputs } from "@oscharko-dev/keiko-contracts";
import {
  evaluateGitPreflight,
  GIT_PREFLIGHT_FINDING_CODES,
  gitPreflightRemediationFor,
  isGitPreflightFindingCode,
  type GitPreflightFindingCode,
  type GitWorktreeSnapshot,
} from "./git-mutation-preflight.js";

// A clean repository on `main` with one staged file, an upstream, and an `origin` remote.
// #3394 review: `headSha` defaults to the SAME value the `push` fixture below pins as
// `verifiedCommitSha`, so the new `verified-commit-drifted` check does not spuriously fire for every
// existing preflight scenario that never intended to exercise drift. A test that DOES want drift
// overrides one side or the other explicitly.
function snapshot(overrides: Partial<GitWorktreeSnapshot> = {}): GitWorktreeSnapshot {
  return {
    headDetached: false,
    currentBranchName: "main",
    headSha: "a".repeat(40),
    stagedFileCount: 1,
    unstagedFileCount: 0,
    untrackedFileCount: 0,
    hasUpstream: true,
    aheadCount: 1,
    behindCount: 0,
    existingLocalBranchNames: ["main", "develop"],
    remoteAliases: ["origin"],
    remoteReachable: true,
    operationInProgress: undefined,
    ...overrides,
  };
}

function codes(
  inputs: GitDeliveryResolvedInputs,
  snap: GitWorktreeSnapshot,
): GitPreflightFindingCode[] {
  return evaluateGitPreflight(inputs, snap).findings.map((f) => f.code);
}

describe("preflight — branch-create", () => {
  const base: GitDeliveryResolvedInputs = {
    kind: "branch-create",
    branchName: "feature/new",
    baseBranchName: "main",
    startPointRefHash: "abc123",
  };

  it("passes when the name is fresh and the base exists", () => {
    expect(evaluateGitPreflight(base, snapshot()).ok).toBe(true);
  });

  it("blocks when the branch already exists", () => {
    const report = evaluateGitPreflight({ ...base, branchName: "develop" }, snapshot());
    expect(report.ok).toBe(false);
    expect(report.blocking.map((f) => f.code)).toContain("branch-already-exists");
  });

  it("blocks when the base branch is missing", () => {
    expect(codes({ ...base, baseBranchName: "ghost" }, snapshot())).toContain(
      "base-branch-missing",
    );
  });

  it("advises (not blocks) when HEAD is detached", () => {
    const report = evaluateGitPreflight(
      base,
      snapshot({ headDetached: true, currentBranchName: undefined }),
    );
    expect(report.ok).toBe(true);
    expect(report.advisory.map((f) => f.code)).toContain("detached-head");
  });
});

describe("preflight — branch-switch (#475)", () => {
  it("blocks when the switch target is not an existing local branch", () => {
    const report = evaluateGitPreflight(
      { kind: "branch-switch", branchName: "feature/missing" },
      snapshot({ existingLocalBranchNames: ["main", "develop"] }),
    );
    expect(report.ok).toBe(false);
    expect(report.blocking.map((f) => f.code)).toContain("switch-target-missing");
  });

  it("permits a switch to an existing branch (and to the current branch)", () => {
    expect(codes({ kind: "branch-switch", branchName: "develop" }, snapshot())).not.toContain(
      "switch-target-missing",
    );
    expect(codes({ kind: "branch-switch", branchName: "main" }, snapshot())).not.toContain(
      "switch-target-missing",
    );
  });

  it("surfaces an advisory when a sequencing operation is in progress", () => {
    const report = evaluateGitPreflight(
      { kind: "branch-switch", branchName: "develop" },
      snapshot({ operationInProgress: "rebase" }),
    );
    expect(report.ok).toBe(true);
    expect(report.advisory.map((f) => f.code)).toContain("operation-in-progress");
  });
});

describe("preflight — stage / unstage", () => {
  it("blocks staging when no paths are provided", () => {
    const report = evaluateGitPreflight(
      { kind: "stage", pathCount: 0, includesUntracked: false },
      snapshot(),
    );
    expect(report.blocking.map((f) => f.code)).toEqual(["no-changes-to-stage"]);
  });

  it("advises when staging would add untracked files", () => {
    const report = evaluateGitPreflight(
      { kind: "stage", pathCount: 2, includesUntracked: true },
      snapshot({ untrackedFileCount: 3 }),
    );
    expect(report.ok).toBe(true);
    expect(report.advisory.map((f) => f.code)).toContain("untracked-files-impacted");
  });

  it("blocks unstaging when nothing is staged", () => {
    const report = evaluateGitPreflight(
      { kind: "unstage", pathCount: 1 },
      snapshot({ stagedFileCount: 0 }),
    );
    expect(report.blocking.map((f) => f.code)).toContain("nothing-staged-to-unstage");
  });
});

describe("preflight — commit", () => {
  const commit: GitDeliveryResolvedInputs = {
    kind: "commit",
    messageByteLength: 10,
    stagedPathCount: 1,
    allowEmptyCommit: false,
  };

  it("passes with staged changes on a branch", () => {
    expect(evaluateGitPreflight(commit, snapshot()).ok).toBe(true);
  });

  it("blocks an empty commit unless explicitly allowed", () => {
    const empty = snapshot({ stagedFileCount: 0 });
    expect(evaluateGitPreflight(commit, empty).blocking.map((f) => f.code)).toContain(
      "nothing-staged-to-commit",
    );
    expect(evaluateGitPreflight({ ...commit, allowEmptyCommit: true }, empty).ok).toBe(true);
  });

  it("blocks committing on a detached HEAD", () => {
    const report = evaluateGitPreflight(
      commit,
      snapshot({ headDetached: true, currentBranchName: undefined }),
    );
    expect(report.ok).toBe(false);
    expect(report.blocking.map((f) => f.code)).toContain("detached-head");
  });

  it("advises (not blocks) committing during a merge in progress", () => {
    const report = evaluateGitPreflight(commit, snapshot({ operationInProgress: "merge" }));
    expect(report.ok).toBe(true);
    expect(report.advisory.map((f) => f.code)).toContain("operation-in-progress");
  });
});

describe("preflight — push (upstream readiness and remote reachability)", () => {
  const push: GitDeliveryResolvedInputs = {
    kind: "push",
    verifiedCommitSha: "a".repeat(40),
    sourceBranchName: "main",
    remoteAlias: "origin",
    remoteBranchName: "main",
    forcePush: false,
    setUpstreamTracking: false,
  };

  it("passes for a reachable remote with an upstream and commits ahead", () => {
    expect(evaluateGitPreflight(push, snapshot()).ok).toBe(true);
  });

  it("blocks a missing remote alias", () => {
    expect(codes({ ...push, remoteAlias: "upstream" }, snapshot())).toContain(
      "remote-alias-missing",
    );
  });

  // #3394 review: `no-upstream-configured` used to fire when there was no local tracking relation
  // AND no pinned commit (`pushNeedsUpstream`'s third condition). Now that `verifiedCommitSha` is
  // mandatory and always a valid Git object id by construction, that third condition can never be
  // false, so the whole finding is unreachable for push — deleted rather than left as dead code
  // (AGENTS.md §7). This proves the deletion: a missing upstream with no tracking requested no
  // longer blocks, because the immutable pinned source needs no local tracking relation.
  it("no longer blocks on a missing upstream now that every push carries a pinned commit", () => {
    expect(codes(push, snapshot({ hasUpstream: false }))).not.toContain("no-upstream-configured");
    expect(evaluateGitPreflight(push, snapshot({ hasUpstream: false })).ok).toBe(true);
  });

  // #3394 review, finding 1 — the actual anti-drift gate: the caller-supplied `verifiedCommitSha`
  // must equal the FRESHLY re-read local head. This is what turns "the branch moved since I
  // approved this" into a clear, typed, user-actionable block instead of silently publishing a
  // different commit than was reviewed.
  it("blocks when the pinned commit no longer matches the freshly-read local head (verified-commit-drifted)", () => {
    const drifted = snapshot({ headSha: "c".repeat(40) });
    const report = evaluateGitPreflight(push, drifted);
    expect(report.ok).toBe(false);
    expect(report.blocking.map((f) => f.code)).toContain("verified-commit-drifted");
  });

  it("does not block when the pinned commit matches the freshly-read local head", () => {
    const current = snapshot({ headSha: "a".repeat(40) });
    expect(codes(push, current)).not.toContain("verified-commit-drifted");
  });

  // #3394 review, follow-up on the drift check: `snapshot.headSha` is the head of the CHECKED-OUT
  // branch, so the pinned-commit comparison only speaks for `sourceBranchName` when that branch is
  // the checkout. The reviewer's case -- pinned commit equal to the checked-out head, but a different
  // branch named as the source -- used to pass preflight; it must be refused outright.
  it("blocks when the named source branch is not the checked-out branch (source-branch-not-checked-out)", () => {
    const report = evaluateGitPreflight(
      { ...push, sourceBranchName: "feature/other" },
      snapshot({ headSha: "a".repeat(40) }),
    );
    expect(report.ok).toBe(false);
    expect(report.blocking.map((f) => f.code)).toContain("source-branch-not-checked-out");
  });

  it("blocks a push from a detached head, where no checked-out branch vouches for the named source", () => {
    expect(codes(push, snapshot({ headDetached: true, currentBranchName: undefined }))).toContain(
      "source-branch-not-checked-out",
    );
  });

  it("does not block when the named source branch is the checked-out branch", () => {
    expect(codes(push, snapshot())).not.toContain("source-branch-not-checked-out");
  });

  it("permits setting an upstream on first push", () => {
    expect(
      evaluateGitPreflight({ ...push, setUpstreamTracking: true }, snapshot({ hasUpstream: false }))
        .ok,
    ).toBe(true);
  });

  it("blocks an unreachable remote", () => {
    expect(codes(push, snapshot({ remoteReachable: false }))).toContain("remote-unreachable");
  });

  it("advises a no-op push when nothing is ahead or behind", () => {
    const report = evaluateGitPreflight(push, snapshot({ aheadCount: 0, behindCount: 0 }));
    expect(report.advisory.map((f) => f.code)).toContain("nothing-to-push");
  });

  it("blocks a non-fast-forward push when the branch is behind its upstream", () => {
    const report = evaluateGitPreflight(push, snapshot({ aheadCount: 1, behindCount: 2 }));
    expect(report.ok).toBe(false);
    expect(report.blocking.map((f) => f.code)).toContain("non-fast-forward");
  });

  it("does not advise no-op when behind (the non-fast-forward block takes precedence)", () => {
    const report = evaluateGitPreflight(push, snapshot({ aheadCount: 0, behindCount: 3 }));
    expect(report.advisory.map((f) => f.code)).not.toContain("nothing-to-push");
    expect(report.blocking.map((f) => f.code)).toContain("non-fast-forward");
  });

  it("does not block a force push that is behind (force is governed by policy, not preflight)", () => {
    const report = evaluateGitPreflight({ ...push, forcePush: true }, snapshot({ behindCount: 2 }));
    expect(report.blocking.map((f) => f.code)).not.toContain("non-fast-forward");
  });
});

describe("preflight — abort / recovery", () => {
  it("blocks aborting when the requested operation is not in progress", () => {
    const report = evaluateGitPreflight(
      { kind: "abort", operationToAbort: "rebase", preserveIndexChanges: false },
      snapshot({ operationInProgress: "merge" }),
    );
    expect(report.blocking.map((f) => f.code)).toContain("no-operation-to-abort");
  });

  it("passes aborting the operation actually in progress", () => {
    expect(
      evaluateGitPreflight(
        { kind: "abort", operationToAbort: "merge", preserveIndexChanges: false },
        snapshot({ operationInProgress: "merge" }),
      ).ok,
    ).toBe(true);
  });

  it("flags an internal-remediation finding for a missing recovery target", () => {
    const report = evaluateGitPreflight(
      {
        kind: "recovery",
        recoveryStrategyHint: "soft-reset",
        targetRefHash: "",
        affectedPathCount: 0,
      },
      snapshot(),
    );
    const finding = report.blocking.find((f) => f.code === "recovery-target-unset");
    expect(finding).toBeDefined();
    expect(finding?.remediation).toBe("internal");
  });

  it("advises that a dirty worktree interacts with a non-stashing reset", () => {
    const report = evaluateGitPreflight(
      {
        kind: "recovery",
        recoveryStrategyHint: "mixed-reset",
        targetRefHash: "abc",
        affectedPathCount: 0,
      },
      snapshot({ unstagedFileCount: 2 }),
    );
    expect(report.advisory.map((f) => f.code)).toContain("dirty-worktree-impacts-recovery");
  });

  it("does not flag a dirty worktree for stash-and-reset", () => {
    expect(
      evaluateGitPreflight(
        {
          kind: "recovery",
          recoveryStrategyHint: "stash-and-reset",
          targetRefHash: "abc",
          affectedPathCount: 0,
        },
        snapshot({ unstagedFileCount: 2 }),
      ).ok,
    ).toBe(true);
  });
});

describe("preflight — provider actions have no local precondition", () => {
  it("returns an ok empty report for pr-create / pr-update / merge", () => {
    const prCreate: GitDeliveryResolvedInputs = {
      kind: "pr-create",
      verifiedCommitSha: "a".repeat(40),
      headBranchName: "feature",
      baseBranchName: "main",
      titleByteLength: 5,
      bodyByteLength: 5,
      isDraft: false,
    };
    const merge: GitDeliveryResolvedInputs = {
      kind: "merge",
      prExternalId: "42",
      mergeStrategyHint: "squash",
      deleteBranchAfterMerge: false,
    };
    expect(evaluateGitPreflight(prCreate, snapshot()).findings).toEqual([]);
    expect(evaluateGitPreflight(merge, snapshot()).findings).toEqual([]);
  });
});

describe("preflight — determinism and metadata", () => {
  it("is idempotent: identical inputs yield byte-identical reports", () => {
    const inputs: GitDeliveryResolvedInputs = {
      kind: "stage",
      pathCount: 0,
      includesUntracked: false,
    };
    const snap = snapshot();
    const first = evaluateGitPreflight(inputs, snap);
    const second = evaluateGitPreflight(inputs, snap);
    expect(first).toEqual(second);
    // Byte-identical serialization, not just deep equality: stable order and no construction drift.
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("derives a remediation class for every finding code", () => {
    for (const code of GIT_PREFLIGHT_FINDING_CODES) {
      expect(["user-actionable", "internal"]).toContain(gitPreflightRemediationFor(code));
      expect(isGitPreflightFindingCode(code)).toBe(true);
    }
    expect(isGitPreflightFindingCode("not-a-code")).toBe(false);
  });

  it("tags every finding with the preflight phase", () => {
    const report = evaluateGitPreflight(
      { kind: "unstage", pathCount: 0 },
      snapshot({ stagedFileCount: 0 }),
    );
    expect(report.findings.length).toBeGreaterThan(0);
    expect([...new Set(report.findings.map((f) => f.phase))]).toEqual(["preflight"]);
  });
});
