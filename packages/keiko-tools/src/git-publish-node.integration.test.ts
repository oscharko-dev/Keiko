// Integration coverage for the Node governed remote publish adapter (Issue #476) — AC3/AC4/AC5.
// Exercises the real spawn boundary against disposable, hermetic git repositories: a bare "remote" and
// a working clone, all on the local filesystem (no network, no credentials). It proves:
//   * a governed push actually runs through `git push` with the DEDICATED publish allowlist and reaches
//     the remote;
//   * the execution-time rejection classification turns a real non-fast-forward push failure into the
//     typed reason without any string parsing leaking out;
//   * a force push is blocked by policy and the remote is never touched (AC4);
//   * a content-free evidence record is produced for the allowed AND the blocked attempt (AC5).
// Uses local repo config only, so no global git state is read or written and runs are deterministic.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGitDeliveryEvidenceRecord } from "./git-mutation-evidence.js";
import { GIT_MUTATION_ALLOWED_SUBCOMMANDS } from "./git-mutation-adapter.js";
import { readGitWorktreeSnapshot } from "./git-worktree-snapshot-node.js";
import { createNodeGitPublishAdapter } from "./git-publish-node.js";
import {
  GIT_PUBLISH_ALLOWED_SUBCOMMANDS,
  runGitPublish,
  type GitPublishLifecycleResult,
  type GitPushCommand,
} from "./git-publish-gateway.js";
import {
  GIT_DELIVERY_POLICY_SCHEMA_VERSION,
  type GitDeliveryRepoPolicyPack,
} from "@oscharko-dev/keiko-contracts";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";

let remote: string;
let work: string;
let info: WorkspaceInfo;

const GIT_INTEGRATION_TIMEOUT_MS = 20_000;

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

function configure(repo: string): void {
  git(repo, ["config", "user.email", "dev@example.com"]);
  git(repo, ["config", "user.name", "Dev"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
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

function publishAdapter(): ReturnType<typeof createNodeGitPublishAdapter> {
  return createNodeGitPublishAdapter({
    workspace: info,
    processEnv: { PATH: process.env.PATH ?? "" },
    now: () => Date.now(),
  });
}

// A pack permitting push to the `feat/` namespace within the publish ceiling (blocks force).
const SAFE_PACK: GitDeliveryRepoPolicyPack = {
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

function pushCommand(overrides: Partial<GitPushCommand> = {}): GitPushCommand {
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

async function governedPush(
  command: GitPushCommand,
  pack: GitDeliveryRepoPolicyPack = SAFE_PACK,
): Promise<GitPublishLifecycleResult> {
  const snapshot = await readGitWorktreeSnapshot({
    workspace: info,
    processEnv: { PATH: process.env.PATH ?? "" },
    now: () => Date.now(),
  });
  return runGitPublish(
    { command, approval: { required: false } },
    {
      adapter: publishAdapter(),
      snapshot,
      repoPolicyPack: pack,
      now: () => 1_000,
      newActionId: () => "action-int",
    },
  );
}

beforeEach(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "keiko-git-publish-")));
  remote = join(base, "remote.git");
  work = join(base, "work");
  git(base, ["init", "--bare", "-q", "remote.git"]);
  git(base, ["init", "-q", "-b", "feat/x", "work"]);
  configure(work);
  writeFileSync(join(work, "a.txt"), "one\n");
  git(work, ["add", "--", "a.txt"]);
  git(work, ["commit", "-q", "-m", "feat(x): one"]);
  git(work, ["remote", "add", "origin", remote]);
  info = workspaceInfo(work);
});

afterEach(() => {
  rmSync(join(work, ".."), { recursive: true, force: true });
});

describe("governed remote publish (Node) — AC5", () => {
  it("publishes the branch to the remote through the dedicated push allowlist", async () => {
    const result = await governedPush(pushCommand({ setUpstreamTracking: true }));
    expect(result.lifecycle.outcome.status).toBe("succeeded");
    // The remote actually received the ref.
    expect(git(remote, ["rev-parse", "feat/x"]).trim()).toMatch(/^[0-9a-f]{40}$/);
    // The evidence record for the allowed attempt is content-free and classifies the outcome.
    const record = buildGitDeliveryEvidenceRecord(
      {
        result: result.lifecycle,
        snapshot: contentFreeSnapshot(),
        workflowRunId: "wf",
        repoId: work,
      },
      { now: () => 2_000 },
    );
    expect(record.actionKind).toBe("push");
    expect(record.outcomeClass).toBe("succeeded");
    expect(JSON.stringify(record)).not.toContain(work);
  }, GIT_INTEGRATION_TIMEOUT_MS);

  it("classifies a real non-fast-forward rejection at execution time", async () => {
    // Establish the upstream, then advance the remote from a second clone so the work repo's push is
    // non-fast-forward — but DON'T fetch, so preflight's tracking-ref distance is stale (behind 0) and
    // the rejection is surfaced by the execution-time classifier, not preflight.
    await governedPush(pushCommand({ setUpstreamTracking: true }));
    const other = join(work, "..", "other");
    // Clone the published feat/x branch so the second worktree builds ON c1 and its push fast-forwards
    // the remote to c2.
    git(join(work, ".."), ["clone", "-q", "-b", "feat/x", remote, "other"]);
    configure(other);
    writeFileSync(join(other, "b.txt"), "two\n");
    git(other, ["add", "--", "b.txt"]);
    git(other, ["commit", "-q", "-m", "feat(x): two"]);
    git(other, ["push", "-q", "origin", "feat/x:feat/x"]);
    // The work repo makes its own divergent commit; its stale tracking ref still points at c1.
    writeFileSync(join(work, "a.txt"), "one-prime\n");
    git(work, ["commit", "-q", "-am", "feat(x): one-prime"]);

    const result = await governedPush(pushCommand());
    expect(result.lifecycle.outcome.status).not.toBe("succeeded");
    expect(result.rejection?.reason).toMatch(/non-fast-forward|fetch-first/);
    expect(result.rejection?.disposition).toBe("user-fixable");
    // The remote was NOT advanced to the work repo's commit.
    expect(git(remote, ["log", "--oneline", "feat/x"])).toContain("two");
    expect(git(remote, ["log", "--oneline", "feat/x"])).not.toContain("one-prime");
  }, GIT_INTEGRATION_TIMEOUT_MS);

  it("classifies a real protected-ref rejection (pre-receive hook declined) at execution time", async () => {
    // A SECOND real execution-time category (not non-fast-forward), guarding the phrase table against
    // git-version drift: a declining pre-receive hook on the remote makes a real `git push` print
    // "pre-receive hook declined", which the classifier maps to protected-ref via the genuine
    // execution-time path (the push PASSES preflight + policy first).
    await governedPush(pushCommand({ setUpstreamTracking: true }));
    const hook = join(remote, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    writeFileSync(join(work, "a.txt"), "declined\n");
    git(work, ["commit", "-q", "-am", "feat(x): declined"]);

    const result = await governedPush(pushCommand());
    expect(result.lifecycle.outcome.status).not.toBe("succeeded");
    expect(result.rejection?.reason).toBe("protected-ref");
    expect(result.rejection?.actionHint).toBe("adjust-policy-target");
    expect(result.rejection?.disposition).toBe("user-fixable");
  }, GIT_INTEGRATION_TIMEOUT_MS);

  it("blocks a force push by policy and never touches the remote (AC4)", async () => {
    await governedPush(pushCommand({ setUpstreamTracking: true }));
    const before = git(remote, ["rev-parse", "feat/x"]).trim();
    // A divergent local history that a force push WOULD overwrite.
    writeFileSync(join(work, "a.txt"), "forced\n");
    git(work, ["commit", "-q", "-am", "feat(x): forced"]);

    const result = await governedPush(pushCommand({ forcePush: true }));
    expect(result.lifecycle.outcome).toMatchObject({ status: "blocked", category: "policy-block" });
    // Evidence for the BLOCKED attempt is still recorded (AC5).
    const record = buildGitDeliveryEvidenceRecord(
      {
        result: result.lifecycle,
        snapshot: contentFreeSnapshot(),
        workflowRunId: "wf",
        repoId: work,
      },
      { now: () => 2_000 },
    );
    expect(record.outcomeClass).toBe("blocked");
    expect(git(remote, ["rev-parse", "feat/x"]).trim()).toBe(before);
  }, GIT_INTEGRATION_TIMEOUT_MS);

  it("blocks a push to a protected/shared target the safe pack does not permit (AC2)", async () => {
    await governedPush(pushCommand({ setUpstreamTracking: true }));
    const result = await governedPush(pushCommand({ remoteBranchName: "dev" }));
    expect(result.lifecycle.outcome).toMatchObject({ status: "blocked", category: "policy-block" });
    // No `dev` ref was created on the remote.
    expect(() => git(remote, ["rev-parse", "dev"])).toThrow();
  }, GIT_INTEGRATION_TIMEOUT_MS);

  it("keeps push out of the LOCAL mutation allowlist and inside the publish allowlist", () => {
    expect(GIT_PUBLISH_ALLOWED_SUBCOMMANDS).toEqual(["push"]);
    expect(GIT_MUTATION_ALLOWED_SUBCOMMANDS).not.toContain("push");
  });
});

function contentFreeSnapshot(): {
  headDetached: boolean;
  currentBranchName: string;
  stagedFileCount: number;
  unstagedFileCount: number;
  untrackedFileCount: number;
} {
  return {
    headDetached: false,
    currentBranchName: "feat/x",
    stagedFileCount: 0,
    unstagedFileCount: 0,
    untrackedFileCount: 0,
  };
}
