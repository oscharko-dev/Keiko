// Deterministic unit coverage for the Node governed merge adapter (Issue #478) — AC1/AC4/AC5. Uses a
// scripted fake spawn so the readiness read (PR object + repo config + optional head status), the merge
// success / guarded branch deletion, and the GitHub-error-classification branches are exercised without a
// real `gh` process, and asserts that the EXACT governed `gh api` argv reaches the spawn boundary — there
// is no path to an arbitrary command.

import type { ChildProcess, SpawnOptions } from "node:child_process";
import { describe, expect, it } from "vitest";
import { makeFakeChild, makeWorkspace } from "./_support.js";
import { createNodeGitMergeAdapter } from "./git-merge-node.js";
import type { HomeProvider, SpawnFn } from "./exec.js";
import type { GitMergeAdapter, GitMergeExecRequest } from "./git-merge-gateway.js";

const FAKE_HOME: HomeProvider = { make: () => "/tmp/keiko-fake-home", cleanup: () => undefined };

interface SpawnStep {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exit?: number;
  readonly throwError?: boolean;
}

interface ScriptedSpawn {
  readonly fn: SpawnFn;
  readonly calls: () => readonly { command: string; args: readonly string[] }[];
}

function scriptedSpawn(steps: readonly SpawnStep[]): ScriptedSpawn {
  let i = 0;
  const calls: { command: string; args: readonly string[] }[] = [];
  const fn: SpawnFn = (command, args, _options: SpawnOptions): ChildProcess => {
    calls.push({ command, args: [...args] });
    const step = steps[i] ?? {};
    i += 1;
    const child = makeFakeChild();
    setImmediate(() => {
      if (step.throwError === true) {
        child.emit("error", new Error("spawn failed"));
        return;
      }
      if (step.stdout !== undefined) child.stdout.emit("data", Buffer.from(step.stdout));
      if (step.stderr !== undefined) child.stderr.emit("data", Buffer.from(step.stderr));
      child.emit("close", step.exit ?? 0, null);
    });
    return child as unknown as ChildProcess;
  };
  return { fn, calls: () => calls };
}

function makeAdapter(spawn: ScriptedSpawn): GitMergeAdapter {
  const { info } = makeWorkspace();
  return createNodeGitMergeAdapter({
    workspace: info,
    processEnv: { PATH: "/usr/bin" },
    now: () => 0,
    spawn: spawn.fn,
    home: FAKE_HOME,
    resolveExecutable: () => "gh",
  });
}

const READINESS_REQ = { ownerAndRepo: "oscharko-dev/Keiko", prExternalId: "42" };

function execReq(over: Partial<GitMergeExecRequest> = {}): GitMergeExecRequest {
  return {
    ownerAndRepo: "oscharko-dev/Keiko",
    prExternalId: "42",
    headBranchName: "feat/x",
    mergeStrategy: "squash",
    deleteBranchAfterMerge: false,
    ...over,
  };
}

const CLEAN_PR = JSON.stringify({
  state: "open",
  merged: false,
  draft: false,
  mergeable: true,
  mergeable_state: "clean",
  base: "main",
  head: "abcdef1234567",
  headRef: "feat/x",
});

const REPO_CFG = JSON.stringify({ squash: true, merge: false, rebase: true });

describe("readMergeReadiness", () => {
  it("maps a clean PR + repo config to neutral facts and capable strategies (no head-status read)", async () => {
    const spawn = scriptedSpawn([{ stdout: CLEAN_PR }, { stdout: REPO_CFG }]);
    const adapter = makeAdapter(spawn);
    const readiness = await adapter.readMergeReadiness(READINESS_REQ);
    expect(readiness.providerError).toBeUndefined();
    expect(readiness.pullRequest?.status).toBe("open");
    expect(readiness.pullRequest?.mergeReadiness.ready).toBe(true);
    expect(readiness.pullRequest?.headBranchName).toBe("feat/x");
    expect(readiness.providerCapableStrategies).toEqual(["squash", "rebase"]);
    // clean → no third (head-status) read.
    expect(spawn.calls()).toHaveLength(2);
    expect(spawn.calls()[0]?.args.slice(0, 2)).toEqual([
      "api",
      "/repos/oscharko-dev/Keiko/pulls/42",
    ]);
  });

  it("reads the head check status for a blocked PR and maps a failing combined status", async () => {
    const blockedPr = JSON.stringify({
      state: "open",
      merged: false,
      draft: false,
      mergeable: false,
      mergeable_state: "blocked",
      base: "main",
      head: "abcdef1234567",
      headRef: "feat/x",
    });
    const spawn = scriptedSpawn([
      { stdout: blockedPr },
      { stdout: REPO_CFG },
      { stdout: "failure" },
    ]);
    const adapter = makeAdapter(spawn);
    const readiness = await adapter.readMergeReadiness(READINESS_REQ);
    expect(readiness.pullRequest?.mergeReadiness.blockingReason).toBe("branch-protection");
    expect(readiness.checks?.overallStatus).toBe("failing");
    expect(spawn.calls()).toHaveLength(3);
    expect(spawn.calls()[2]?.args[1]).toBe(
      "/repos/oscharko-dev/Keiko/commits/abcdef1234567/status",
    );
  });

  it("reports providerError when the PR read fails", async () => {
    const spawn = scriptedSpawn([{ stderr: "HTTP 404", exit: 1 }]);
    const adapter = makeAdapter(spawn);
    const readiness = await adapter.readMergeReadiness(READINESS_REQ);
    expect(readiness.providerError).toBe(true);
    expect(readiness.pullRequest).toBeUndefined();
  });

  it("reports providerError when the PR JSON is unparseable", async () => {
    const spawn = scriptedSpawn([{ stdout: "not json" }, { stdout: REPO_CFG }]);
    const adapter = makeAdapter(spawn);
    const readiness = await adapter.readMergeReadiness(READINESS_REQ);
    expect(readiness.providerError).toBe(true);
  });
});

describe("mergePullRequest", () => {
  it("executes the governed merge PUT and reports merged on success", async () => {
    const spawn = scriptedSpawn([{ stdout: "true", exit: 0 }]);
    const adapter = makeAdapter(spawn);
    const result = await adapter.mergePullRequest(execReq());
    expect(result.outcome).toBe("succeeded");
    expect(result.merged).toBe(true);
    const argv = spawn.calls()[0]?.args ?? [];
    expect(spawn.calls()[0]?.command).toBe("gh");
    expect(argv.slice(0, 4)).toEqual([
      "api",
      "--method",
      "PUT",
      "/repos/oscharko-dev/Keiko/pulls/42/merge",
    ]);
    expect(argv).toContain("merge_method=squash");
  });

  it("performs the guarded branch deletion after a successful merge", async () => {
    const spawn = scriptedSpawn([
      { stdout: "true", exit: 0 },
      { stdout: "", exit: 0 },
    ]);
    const adapter = makeAdapter(spawn);
    const result = await adapter.mergePullRequest(execReq({ deleteBranchAfterMerge: true }));
    expect(result.merged).toBe(true);
    expect(result.branchDeleted).toBe(true);
    expect(spawn.calls()).toHaveLength(2);
    expect(spawn.calls()[1]?.args).toEqual([
      "api",
      "--method",
      "DELETE",
      "/repos/oscharko-dev/Keiko/git/refs/heads/feat/x",
    ]);
  });

  it("keeps the merge successful when the branch deletion fails (non-fatal)", async () => {
    const spawn = scriptedSpawn([
      { stdout: "true", exit: 0 },
      { stderr: "HTTP 403", exit: 1 },
    ]);
    const adapter = makeAdapter(spawn);
    const result = await adapter.mergePullRequest(execReq({ deleteBranchAfterMerge: true }));
    expect(result.outcome).toBe("succeeded");
    expect(result.merged).toBe(true);
    expect(result.branchDeleted).toBe(false);
  });

  it("classifies a non-OK merge status into a typed rejection reason", async () => {
    const spawn = scriptedSpawn([{ stderr: "HTTP 405: Pull Request is not mergeable", exit: 1 }]);
    const adapter = makeAdapter(spawn);
    const result = await adapter.mergePullRequest(execReq());
    expect(result.outcome).toBe("failed");
    expect(result.rejectionReason).toBe("not-mergeable");
    expect(result.errorCode).toBe("precondition-failed");
  });

  it("classifies a head-modified conflict as retryable head-modified", async () => {
    const spawn = scriptedSpawn([
      { stderr: "HTTP 409: Head branch was modified. Review and try the merge again.", exit: 1 },
    ]);
    const adapter = makeAdapter(spawn);
    const result = await adapter.mergePullRequest(execReq());
    expect(result.rejectionReason).toBe("head-modified");
  });

  it("returns an internal-error result when the merge argv cannot be built", async () => {
    const spawn = scriptedSpawn([{ stdout: "true", exit: 0 }]);
    const adapter = makeAdapter(spawn);
    const result = await adapter.mergePullRequest(execReq({ ownerAndRepo: "no-slash" }));
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe("internal-error");
    // The malformed command never reached the spawn boundary.
    expect(spawn.calls()).toHaveLength(0);
  });

  it("turns a spawn error into an internal-error failure", async () => {
    const spawn = scriptedSpawn([{ throwError: true }]);
    const adapter = makeAdapter(spawn);
    const result = await adapter.mergePullRequest(execReq());
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe("internal-error");
  });

  it("does not delete the branch when the merge reported merged=false", async () => {
    const spawn = scriptedSpawn([{ stdout: "false", exit: 0 }]);
    const adapter = makeAdapter(spawn);
    const result = await adapter.mergePullRequest(execReq({ deleteBranchAfterMerge: true }));
    expect(result.outcome).toBe("succeeded");
    expect(result.merged).toBe(false);
    expect(result.branchDeleted).toBeUndefined();
    expect(spawn.calls()).toHaveLength(1);
  });

  it("reports branchDeleted=false when the head branch is unsafe to delete", async () => {
    const spawn = scriptedSpawn([{ stdout: "true", exit: 0 }]);
    const adapter = makeAdapter(spawn);
    const result = await adapter.mergePullRequest(
      execReq({ deleteBranchAfterMerge: true, headBranchName: "-rf" }),
    );
    expect(result.merged).toBe(true);
    expect(result.branchDeleted).toBe(false);
    // Only the merge PUT reached the spawn boundary; the malformed delete never did.
    expect(spawn.calls()).toHaveLength(1);
  });
});

describe("readMergeReadiness — additional branches", () => {
  function prJson(over: Record<string, unknown>): string {
    return JSON.stringify({
      state: "open",
      merged: false,
      draft: false,
      mergeable: true,
      mergeable_state: "clean",
      base: "main",
      head: "abcdef1234567",
      headRef: "feat/x",
      ...over,
    });
  }

  it("reads the head check status for an unstable PR and maps a passing combined status", async () => {
    const spawn = scriptedSpawn([
      { stdout: prJson({ mergeable_state: "unstable" }) },
      { stdout: JSON.stringify({ squash: true, merge: true, rebase: true }) },
      { stdout: "success" },
    ]);
    const adapter = makeAdapter(spawn);
    const readiness = await adapter.readMergeReadiness(READINESS_REQ);
    expect(readiness.pullRequest?.mergeReadiness.ready).toBe(true);
    expect(readiness.checks?.overallStatus).toBe("passing");
    expect(readiness.providerCapableStrategies).toEqual(["squash", "rebase", "merge-commit"]);
  });

  it("does not read the head status for a behind PR (no required-check ambiguity)", async () => {
    const spawn = scriptedSpawn([
      { stdout: prJson({ mergeable: false, mergeable_state: "behind" }) },
      { stdout: JSON.stringify({ squash: true, merge: false, rebase: false }) },
    ]);
    const adapter = makeAdapter(spawn);
    const readiness = await adapter.readMergeReadiness(READINESS_REQ);
    expect(readiness.pullRequest?.mergeReadiness.blockingReason).toBe("branch-protection");
    expect(readiness.checks).toBeUndefined();
    expect(spawn.calls()).toHaveLength(2);
  });

  it("yields no capable strategies when the repo merge-config read fails", async () => {
    const spawn = scriptedSpawn([{ stdout: prJson({}) }, { stderr: "HTTP 500", exit: 1 }]);
    const adapter = makeAdapter(spawn);
    const readiness = await adapter.readMergeReadiness(READINESS_REQ);
    expect(readiness.providerError).toBeUndefined();
    expect(readiness.providerCapableStrategies).toEqual([]);
  });

  it("omits checks when the head-status read returns an empty state", async () => {
    const spawn = scriptedSpawn([
      { stdout: prJson({ mergeable: false, mergeable_state: "blocked" }) },
      { stdout: JSON.stringify({ squash: true, merge: false, rebase: false }) },
      { stdout: "" },
    ]);
    const adapter = makeAdapter(spawn);
    const readiness = await adapter.readMergeReadiness(READINESS_REQ);
    expect(readiness.checks).toBeUndefined();
  });

  it("maps a merged PR to merged status", async () => {
    const spawn = scriptedSpawn([
      { stdout: prJson({ merged: true, state: "closed", mergeable_state: "clean" }) },
      { stdout: JSON.stringify({ squash: true, merge: false, rebase: false }) },
    ]);
    const adapter = makeAdapter(spawn);
    const readiness = await adapter.readMergeReadiness(READINESS_REQ);
    expect(readiness.pullRequest?.status).toBe("merged");
  });
});
