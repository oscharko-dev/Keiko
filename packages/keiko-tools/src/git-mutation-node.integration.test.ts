// Integration coverage for the Node governed Git mutation adapter (Issue #472) — AC3/AC5.
// Exercises the real spawn boundary against a disposable, hermetic git repository: governed local
// mutations actually run through `git` with the dedicated allowlist, and failures map to structured
// results without any string parsing. Uses local repo config only, so no global git state is read or
// written and the run is deterministic.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  GitDeliveryRepoPolicyPack,
  GitDeliveryApprovalRequirement,
} from "@oscharko-dev/keiko-contracts";
import { GIT_DELIVERY_POLICY_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { createNodeGitMutationAdapter } from "./git-mutation-node.js";
import type { GitLocalMutationAdapter } from "./git-mutation-adapter.js";
import type { GitWorktreeSnapshot } from "./git-mutation-preflight.js";
import { createInMemoryGitMutationJournal, runGitMutation } from "./git-mutation-orchestrator.js";

let root: string;
let info: WorkspaceInfo;

function git(args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: root, encoding: "utf8" });
}

function workspaceInfo(rootPath: string): WorkspaceInfo {
  return {
    root: rootPath,
    name: "demo",
    version: undefined,
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: ["tests"],
    languages: ["typescript"],
    ignoreLines: [],
  };
}

function adapter(): GitLocalMutationAdapter {
  // Only PATH is forwarded; the spawn boundary supplies an empty HOME, so the commit identity comes
  // from the repository's LOCAL config set in beforeEach — never the developer's global git config.
  return createNodeGitMutationAdapter({
    workspace: info,
    processEnv: { PATH: process.env.PATH ?? "" },
    now: () => Date.now(),
  });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-git-mutation-")));
  git(["init", "-q"]);
  git(["config", "user.email", "test@keiko.example"]);
  git(["config", "user.name", "Keiko Test"]);
  git(["config", "commit.gpgsign", "false"]);
  info = workspaceInfo(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("node git mutation adapter — successful local mutations", () => {
  it("stages and commits a file through the governed boundary", async () => {
    writeFileSync(join(root, "a.txt"), "hello\n", "utf8");
    const ad = adapter();

    const staged = await ad.stage({ pathspecs: ["a.txt"] });
    expect(staged.outcome).toBe("succeeded");
    expect(git(["diff", "--cached", "--name-only"]).trim()).toBe("a.txt");

    const committed = await ad.commit({ message: "initial commit", allowEmpty: false });
    expect(committed.outcome).toBe("succeeded");
    expect(git(["log", "--oneline"])).toContain("initial commit");
  });

  it("creates a branch from an existing ref", async () => {
    writeFileSync(join(root, "a.txt"), "hello\n", "utf8");
    const ad = adapter();
    await ad.stage({ pathspecs: ["a.txt"] });
    await ad.commit({ message: "base", allowEmpty: false });

    const branched = await ad.createBranch({ branchName: "feature/x", startPointRefHash: "HEAD" });
    expect(branched.outcome).toBe("succeeded");
    expect(git(["branch", "--list", "feature/x"])).toContain("feature/x");
  });

  it("switches HEAD to an existing branch through the governed boundary (#475)", async () => {
    writeFileSync(join(root, "a.txt"), "hello\n", "utf8");
    const ad = adapter();
    await ad.stage({ pathspecs: ["a.txt"] });
    await ad.commit({ message: "base", allowEmpty: false });
    const startBranch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    await ad.createBranch({ branchName: "feature/x", startPointRefHash: "HEAD" });

    const switched = await ad.switchBranch({ branchName: "feature/x" });
    expect(switched.outcome).toBe("succeeded");
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("feature/x");
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"]).trim()).not.toBe(startBranch);
  });

  it("reports precondition-failed when switching to a non-existent branch (#475)", async () => {
    writeFileSync(join(root, "a.txt"), "hello\n", "utf8");
    const ad = adapter();
    await ad.stage({ pathspecs: ["a.txt"] });
    await ad.commit({ message: "base", allowEmpty: false });

    const failed = await ad.switchBranch({ branchName: "feature/does-not-exist" });
    expect(failed.outcome).toBe("failed");
    expect(failed.errorCode).toBe("precondition-failed");
  });

  it("unstages a staged file", async () => {
    writeFileSync(join(root, "a.txt"), "hello\n", "utf8");
    const ad = adapter();
    await ad.stage({ pathspecs: ["a.txt"] });
    await ad.commit({ message: "base", allowEmpty: false });

    writeFileSync(join(root, "b.txt"), "world\n", "utf8");
    await ad.stage({ pathspecs: ["b.txt"] });
    expect(git(["diff", "--cached", "--name-only"]).trim()).toBe("b.txt");

    const unstaged = await ad.unstage({ pathspecs: ["b.txt"] });
    expect(unstaged.outcome).toBe("succeeded");
    expect(git(["diff", "--cached", "--name-only"]).trim()).toBe("");
  });

  it("treats pathspec-magic-looking filenames as literal files (#1575)", async () => {
    writeFileSync(join(root, "base.txt"), "base\n", "utf8");
    git(["add", "base.txt"]);
    git(["commit", "-m", "base"]);
    writeFileSync(join(root, ":(top)*"), "magic-looking name\n", "utf8");
    writeFileSync(join(root, "another.txt"), "must stay unstaged\n", "utf8");

    const staged = await adapter().stage({ pathspecs: [":(top)*"] });

    expect(staged.outcome).toBe("succeeded");
    expect(git(["diff", "--cached", "--name-only"]).trim()).toBe(":(top)*");
    expect(git(["status", "--short"])).toContain("?? another.txt");
  });
});

describe("node git mutation adapter — structured failure classification", () => {
  it("maps a non-zero git exit to a precondition-failed result", async () => {
    writeFileSync(join(root, "a.txt"), "hello\n", "utf8");
    const ad = adapter();
    await ad.stage({ pathspecs: ["a.txt"] });
    await ad.commit({ message: "base", allowEmpty: false });

    // Index is clean now; committing with nothing staged makes git exit non-zero.
    const failed = await ad.commit({ message: "nothing to commit", allowEmpty: false });
    expect(failed.outcome).toBe("failed");
    expect(failed.errorCode).toBe("precondition-failed");
  });

  it("rejects an invalid operand before any spawn (internal-error, no git run)", async () => {
    const ad = adapter();
    const bad = await ad.commit({ message: "", allowEmpty: false });
    expect(bad.outcome).toBe("failed");
    expect(bad.errorCode).toBe("internal-error");
    // No commit happened: there is no HEAD in the fresh repo.
    expect(() => git(["rev-parse", "HEAD"])).toThrow();
  });
});

// Seeds a base commit and returns the current branch name and the base commit SHA.
function seedBaseCommit(): { branch: string; base: string } {
  writeFileSync(join(root, "f.txt"), "v1\n", "utf8");
  git(["add", "f.txt"]);
  git(["commit", "-m", "v1"]);
  return {
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
    base: git(["rev-parse", "HEAD"]).trim(),
  };
}

describe("node git mutation adapter — abort through the real boundary", () => {
  it("aborts an in-progress merge and clears the merge state", async () => {
    const { branch } = seedBaseCommit();
    git(["checkout", "-b", "feature"]);
    writeFileSync(join(root, "f.txt"), "feature\n", "utf8");
    git(["commit", "-am", "feature"]);
    git(["checkout", branch]);
    writeFileSync(join(root, "f.txt"), "mainline\n", "utf8");
    git(["commit", "-am", "mainline"]);
    // A conflicting merge leaves the repository in a merge-in-progress state (git exits non-zero).
    expect(() => git(["merge", "feature"])).toThrow();
    expect(git(["rev-parse", "-q", "--verify", "MERGE_HEAD"]).trim().length).toBeGreaterThan(0);

    const aborted = await adapter().abort({ operationToAbort: "merge" });
    expect(aborted.outcome).toBe("succeeded");
    // MERGE_HEAD is gone: the merge was aborted.
    expect(() => git(["rev-parse", "-q", "--verify", "MERGE_HEAD"])).toThrow();
  });
});

describe("node git mutation adapter — multi-step recovery through the real boundary", () => {
  it("stash-and-reset runs both steps: HEAD moves back and the work is preserved in a stash", async () => {
    const { base } = seedBaseCommit();
    writeFileSync(join(root, "f.txt"), "v2\n", "utf8");
    git(["commit", "-am", "v2"]);
    // Dirty the worktree (tracked edit + an untracked file) so the stash has work to preserve.
    writeFileSync(join(root, "f.txt"), "dirty\n", "utf8");
    writeFileSync(join(root, "untracked.txt"), "u\n", "utf8");

    const recovered = await adapter().recover({
      recoveryStrategyHint: "stash-and-reset",
      targetRefHash: base,
      pathspecs: [],
    });
    expect(recovered.outcome).toBe("succeeded");
    expect(git(["rev-parse", "HEAD"]).trim()).toBe(base); // reset to the target
    expect(git(["stash", "list"]).trim().length).toBeGreaterThan(0); // work preserved, not lost
  });

  it("reports a partial result when the second recovery step fails", async () => {
    seedBaseCommit();
    writeFileSync(join(root, "f.txt"), "dirty\n", "utf8");
    // Step 1 (stash) succeeds; step 2 (reset --hard <unknown ref>) fails.
    const partial = await adapter().recover({
      recoveryStrategyHint: "stash-and-reset",
      targetRefHash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      pathspecs: [],
    });
    expect(partial.outcome).toBe("partial");
    expect(partial.partialDetail).toEqual({ attemptedUnitCount: 2, succeededUnitCount: 1 });
  });
});

describe("governed lifecycle — idempotent commit through the orchestrator + real adapter", () => {
  const ALLOW_ALL: GitDeliveryRepoPolicyPack = {
    schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
    repoId: "repo",
    rules: [],
    defaultRule: { decision: "allowed" },
  };
  const NO_APPROVAL: GitDeliveryApprovalRequirement = { required: false };

  it("replays a recorded commit without creating a second commit", async () => {
    writeFileSync(join(root, "f.txt"), "x\n", "utf8");
    const ad = adapter();
    await ad.stage({ pathspecs: ["f.txt"] });

    const snapshot: GitWorktreeSnapshot = {
      headDetached: false,
      currentBranchName: "main",
      stagedFileCount: 1,
      unstagedFileCount: 0,
      untrackedFileCount: 0,
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      existingLocalBranchNames: ["main"],
      remoteAliases: [],
      remoteReachable: undefined,
      operationInProgress: undefined,
    };
    const journal = createInMemoryGitMutationJournal();
    const request = {
      command: { kind: "commit" as const, message: "once", allowEmpty: false },
      approval: NO_APPROVAL,
      idempotencyKey: "commit-once",
    };
    const orchestratorDeps = {
      adapter: ad,
      snapshot,
      repoPolicyPack: ALLOW_ALL,
      now: (): number => 1,
      newActionId: (): string => "action-1",
      journal,
    };

    const first = await runGitMutation(request, orchestratorDeps);
    expect(first.outcome.status).toBe("succeeded");
    const second = await runGitMutation(request, orchestratorDeps);
    expect(second).toBe(first); // replayed from the journal, not re-executed
    expect(git(["rev-list", "--count", "HEAD"]).trim()).toBe("1"); // exactly one commit exists
  });
});
