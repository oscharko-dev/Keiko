// Deterministic unit coverage for the Node governed merge adapter (Issue #478) — AC1/AC4/AC5. Uses a
// scripted fake spawn so the readiness read (PR object + repo config + optional head status), the merge
// success / guarded branch deletion, and the GitHub-error-classification branches are exercised without a
// real `gh` process, and asserts that the EXACT governed `gh api` argv reaches the spawn boundary — there
// is no path to an arbitrary command.

import type { ChildProcess, SpawnOptions } from "node:child_process";
import { describe, expect, it } from "vitest";
import { makeFakeChild, makeWorkspace, recordingSpawn } from "./_support.js";
import {
  createNodeGitMergeAdapter,
  readNodeGitBranchProtection,
  type GitBranchProtectionReadResult,
} from "./git-merge-node.js";
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

function readProtection(spawn: ScriptedSpawn): Promise<GitBranchProtectionReadResult> {
  const { info } = makeWorkspace();
  return readNodeGitBranchProtection(
    {
      workspace: info,
      processEnv: { PATH: "/usr/bin" },
      now: () => 0,
      spawn: spawn.fn,
      home: FAKE_HOME,
      resolveExecutable: () => "gh",
    },
    { ownerAndRepo: "oscharko-dev/Keiko", baseBranchName: "main" },
  );
}

const READINESS_REQ = {
  ownerAndRepo: "oscharko-dev/Keiko",
  prExternalId: "42",
  baseBranchName: "main",
};

// The reviews + branch-protection reads run unconditionally after the PR + repo-config reads (in that
// argv order — see readMergeReadiness in git-merge-node.ts), regardless of mergeable_state. Every
// scripted spawn below supplies these two steps; the "no reviews" / "no required reviews" defaults
// mirror what an unreviewed PR on an unprotected branch actually returns.
const NO_REVIEWS = "[]";
const NO_REQUIRED_REVIEWS = JSON.stringify({
  deletionAllowed: false,
  forcePushAllowed: false,
  linearHistoryRequired: false,
  signaturesRequired: false,
  requiredReviewCount: 0,
  requiredChecks: [],
});

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

describe("readNodeGitBranchProtection", () => {
  it("projects the signed-commit requirement through the governed gh read", async () => {
    const spawn = scriptedSpawn([{ stdout: NO_REQUIRED_REVIEWS }]);
    const result = await readProtection(spawn);
    expect(result).toMatchObject({
      outcome: "protected",
      protection: { signaturesRequired: false },
    });
    expect(spawn.calls()[0]?.args).toContain("/repos/oscharko-dev/Keiko/branches/main/protection");
  });

  it("distinguishes an unprotected branch from an unavailable provider read", async () => {
    await expect(
      readProtection(scriptedSpawn([{ exit: 1, stderr: "HTTP 404: Not Found" }])),
    ).resolves.toEqual({ outcome: "unprotected" });
    await expect(
      readProtection(scriptedSpawn([{ exit: 1, stderr: "provider unavailable" }])),
    ).resolves.toEqual({ outcome: "unavailable" });
  });
});

describe("readMergeReadiness", () => {
  it("maps a clean PR + repo config to neutral facts and capable strategies (no checks read)", async () => {
    const spawn = scriptedSpawn([
      { stdout: CLEAN_PR },
      { stdout: REPO_CFG },
      { stdout: NO_REVIEWS },
      { stdout: NO_REQUIRED_REVIEWS },
    ]);
    const adapter = makeAdapter(spawn);
    const readiness = await adapter.readMergeReadiness(READINESS_REQ);
    expect(readiness.providerError).toBeUndefined();
    expect(readiness.pullRequest?.status).toBe("open");
    expect(readiness.pullRequest?.mergeReadiness.ready).toBe(true);
    expect(readiness.pullRequest?.headBranchName).toBe("feat/x");
    expect(readiness.providerCapableStrategies).toEqual(["squash", "rebase"]);
    // Surfaced for the execute-time `sha` pin (fixes the previously unpinned merge).
    expect(readiness.headRefHash).toBe("abcdef1234567");
    // clean → no fifth (checks) read.
    expect(spawn.calls()).toHaveLength(4);
    expect(spawn.calls()[0]?.args.slice(0, 2)).toEqual([
      "api",
      "/repos/oscharko-dev/Keiko/pulls/42",
    ]);
  });

  it("reads the head checks for a blocked PR via the modern Checks API and maps a failing state", async () => {
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
    const checkRuns = JSON.stringify([
      { id: 1, name: "ci", providerId: 15368, status: "completed", conclusion: "success" },
      { id: 2, name: "nightly", providerId: 15368, status: "completed", conclusion: "failure" },
    ]);
    const spawn = scriptedSpawn([
      { stdout: blockedPr },
      { stdout: REPO_CFG },
      { stdout: NO_REVIEWS },
      { stdout: NO_REQUIRED_REVIEWS },
      { stdout: checkRuns },
    ]);
    const adapter = makeAdapter(spawn);
    const readiness = await adapter.readMergeReadiness(READINESS_REQ);
    expect(readiness.pullRequest?.mergeReadiness.blockingReason).toBe("branch-protection");
    expect(readiness.checks).toEqual({
      total: 0,
      passing: 0,
      failing: 0,
      pending: 0,
      overallStatus: "skipped",
      informational: {
        total: 2,
        passing: 1,
        failing: 1,
        pending: 0,
        overallStatus: "failing",
      },
    });
    expect(spawn.calls()).toHaveLength(5);
    // Reads the modern per-run Checks API, NOT the legacy combined-status endpoint this replaces
    // (the legacy read reported one lossy aggregate "state" string with no pass/fail breakdown).
    expect(spawn.calls()[4]?.args[1]).toBe(
      "/repos/oscharko-dev/Keiko/commits/abcdef1234567/check-runs?per_page=100",
    );
  });

  it("counts a REAL received-approval total from the reviews read (fixes the hardcoded 0)", async () => {
    // alice approved, then requested changes again (her LATEST review governs); bob approved once.
    const reviews = JSON.stringify([
      { user: "alice", state: "APPROVED" },
      { user: "bob", state: "APPROVED" },
      { user: "alice", state: "CHANGES_REQUESTED" },
    ]);
    const spawn = scriptedSpawn([
      { stdout: CLEAN_PR },
      { stdout: REPO_CFG },
      { stdout: reviews },
      {
        stdout: JSON.stringify({
          deletionAllowed: false,
          forcePushAllowed: false,
          linearHistoryRequired: true,
          signaturesRequired: true,
          requiredReviewCount: 2,
          requiredChecks: [],
        }),
      },
    ]);
    const adapter = makeAdapter(spawn);
    const readiness = await adapter.readMergeReadiness(READINESS_REQ);
    // Only bob's approval still stands; alice's is superseded by her own later review.
    expect(readiness.pullRequest?.mergeReadiness.receivedApprovalCount).toBe(1);
    expect(readiness.pullRequest?.mergeReadiness.requiredApprovalCount).toBe(2);
    expect(spawn.calls()[2]?.args[1]).toBe(
      "/repos/oscharko-dev/Keiko/pulls/42/reviews?per_page=100",
    );
    expect(spawn.calls()[3]?.args[1]).toBe("/repos/oscharko-dev/Keiko/branches/main/protection");
  });

  it("falls back to 0/0 (not a hard failure) when the reviews and branch-protection reads fail", async () => {
    const spawn = scriptedSpawn([
      { stdout: CLEAN_PR },
      { stdout: REPO_CFG },
      { stderr: "HTTP 500", exit: 1 },
      { stderr: "HTTP 404", exit: 1 },
    ]);
    const adapter = makeAdapter(spawn);
    const readiness = await adapter.readMergeReadiness(READINESS_REQ);
    expect(readiness.providerError).toBeUndefined();
    expect(readiness.pullRequest?.mergeReadiness.receivedApprovalCount).toBe(0);
    expect(readiness.pullRequest?.mergeReadiness.requiredApprovalCount).toBe(0);
    expect(readiness.branchProtection).toBeUndefined();
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

  it("reads the head checks for an unstable PR via the Checks API and maps an all-passing state", async () => {
    const spawn = scriptedSpawn([
      { stdout: prJson({ mergeable_state: "unstable" }) },
      { stdout: JSON.stringify({ squash: true, merge: true, rebase: true }) },
      { stdout: NO_REVIEWS },
      {
        stdout: JSON.stringify({
          deletionAllowed: false,
          forcePushAllowed: false,
          linearHistoryRequired: true,
          signaturesRequired: false,
          requiredReviewCount: 0,
          requiredChecks: [{ name: "ci", providerId: 15368 }],
        }),
      },
      {
        stdout: JSON.stringify([
          {
            id: 1,
            name: "ci",
            providerId: 15368,
            status: "completed",
            conclusion: "success",
          },
        ]),
      },
    ]);
    const adapter = makeAdapter(spawn);
    const readiness = await adapter.readMergeReadiness(READINESS_REQ);
    expect(readiness.pullRequest?.mergeReadiness.ready).toBe(true);
    expect(readiness.checks?.overallStatus).toBe("passing");
    expect(readiness.providerCapableStrategies).toEqual(["squash", "rebase", "merge-commit"]);
  });

  it("does not read the head checks for a behind PR (no required-check ambiguity)", async () => {
    const spawn = scriptedSpawn([
      { stdout: prJson({ mergeable: false, mergeable_state: "behind" }) },
      { stdout: JSON.stringify({ squash: true, merge: false, rebase: false }) },
      { stdout: NO_REVIEWS },
      { stdout: NO_REQUIRED_REVIEWS },
    ]);
    const adapter = makeAdapter(spawn);
    const readiness = await adapter.readMergeReadiness(READINESS_REQ);
    expect(readiness.pullRequest?.mergeReadiness.blockingReason).toBe("branch-protection");
    expect(readiness.checks).toBeUndefined();
    expect(spawn.calls()).toHaveLength(4);
  });

  it("yields no capable strategies when the repo merge-config read fails", async () => {
    const spawn = scriptedSpawn([
      { stdout: prJson({}) },
      { stderr: "HTTP 500", exit: 1 },
      { stdout: NO_REVIEWS },
      { stdout: NO_REQUIRED_REVIEWS },
    ]);
    const adapter = makeAdapter(spawn);
    const readiness = await adapter.readMergeReadiness(READINESS_REQ);
    expect(readiness.providerError).toBeUndefined();
    expect(readiness.providerCapableStrategies).toEqual([]);
  });

  it("fails closed when the checks read fails", async () => {
    const spawn = scriptedSpawn([
      { stdout: prJson({ mergeable: false, mergeable_state: "blocked" }) },
      { stdout: JSON.stringify({ squash: true, merge: false, rebase: false }) },
      { stdout: NO_REVIEWS },
      { stdout: NO_REQUIRED_REVIEWS },
      { stderr: "HTTP 404", exit: 1 },
    ]);
    const adapter = makeAdapter(spawn);
    const readiness = await adapter.readMergeReadiness(READINESS_REQ);
    expect(readiness.checks).toBeUndefined();
    expect(readiness.providerError).toBe(true);
  });

  it("maps a merged PR to merged status", async () => {
    const spawn = scriptedSpawn([
      { stdout: prJson({ merged: true, state: "closed", mergeable_state: "clean" }) },
      { stdout: JSON.stringify({ squash: true, merge: false, rebase: false }) },
      { stdout: NO_REVIEWS },
      { stdout: NO_REQUIRED_REVIEWS },
    ]);
    const adapter = makeAdapter(spawn);
    const readiness = await adapter.readMergeReadiness(READINESS_REQ);
    expect(readiness.pullRequest?.status).toBe("merged");
  });
});

describe("readMergeReadiness — required and informational checks", () => {
  function prJson(): string {
    return JSON.stringify({
      state: "open",
      merged: false,
      draft: false,
      mergeable: true,
      mergeable_state: "unstable",
      base: "main",
      head: "abcdef1234567",
      headRef: "feat/x",
    });
  }

  function protection(requiredChecks: readonly Record<string, unknown>[]): string {
    return JSON.stringify({
      deletionAllowed: false,
      forcePushAllowed: false,
      linearHistoryRequired: true,
      signaturesRequired: true,
      requiredReviewCount: 0,
      requiredChecks,
    });
  }

  function requiredCheck(
    name: string,
    over: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return { name, providerId: 15368, ...over };
  }

  function run(
    name: string,
    status: string,
    conclusion: string | null,
    over: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return { id: 1, name, providerId: 15368, status, conclusion, ...over };
  }

  async function readinessFor(
    requiredChecks: readonly Record<string, unknown>[],
    runs: readonly Record<string, unknown>[],
    protectionStep: SpawnStep = { stdout: protection(requiredChecks) },
  ): Promise<Awaited<ReturnType<GitMergeAdapter["readMergeReadiness"]>>> {
    const spawn = scriptedSpawn([
      { stdout: prJson() },
      { stdout: REPO_CFG },
      { stdout: NO_REVIEWS },
      protectionStep,
      { stdout: JSON.stringify(runs) },
    ]);
    return makeAdapter(spawn).readMergeReadiness(READINESS_REQ);
  }

  it("represents a missing required check as pending and reports its required count", async () => {
    const readiness = await readinessFor(
      [requiredCheck("ci"), requiredCheck("ui")],
      [run("ci", "completed", "success")],
    );

    expect(readiness.branchProtection?.requiredStatusCheckCount).toBe(2);
    expect(readiness.branchProtection?.signaturesRequired).toBe(true);
    expect(readiness.checks).toMatchObject({
      total: 2,
      passing: 1,
      failing: 0,
      pending: 1,
      overallStatus: "pending",
    });
  });

  it("projects both signed-commit requirement states and rejects a missing state", async () => {
    const unsignedAllowed = await readinessFor([], [], {
      stdout: JSON.stringify({
        deletionAllowed: false,
        forcePushAllowed: false,
        linearHistoryRequired: true,
        signaturesRequired: false,
        requiredReviewCount: 0,
        requiredChecks: [],
      }),
    });
    expect(unsignedAllowed.branchProtection?.signaturesRequired).toBe(false);

    const missing = await readinessFor([], [], {
      stdout: JSON.stringify({
        deletionAllowed: false,
        forcePushAllowed: false,
        linearHistoryRequired: true,
        requiredReviewCount: 0,
        requiredChecks: [],
      }),
    });
    expect(missing.providerError).toBe(true);
    expect(missing.branchProtection).toBeUndefined();
  });

  it("keeps an in-progress required check pending", async () => {
    const readiness = await readinessFor([requiredCheck("ci")], [run("ci", "in_progress", null)]);

    expect(readiness.checks?.overallStatus).toBe("pending");
    expect(readiness.checks?.pending).toBe(1);
  });

  it("keeps a failed required check blocking", async () => {
    const readiness = await readinessFor(
      [requiredCheck("ci")],
      [run("ci", "completed", "failure")],
    );

    expect(readiness.checks?.overallStatus).toBe("failing");
    expect(readiness.checks?.failing).toBe(1);
  });

  it("keeps an informational failure visible without failing required checks", async () => {
    const readiness = await readinessFor(
      [requiredCheck("ci")],
      [run("ci", "completed", "success"), run("nightly", "completed", "failure", { id: 2 })],
    );

    expect(readiness.checks?.overallStatus).toBe("passing");
    expect(readiness.checks?.informational).toEqual({
      total: 1,
      passing: 0,
      failing: 1,
      pending: 0,
      overallStatus: "failing",
    });
  });

  it("deduplicates check names by provider and uses the newest run", async () => {
    const readiness = await readinessFor(
      [requiredCheck("ci")],
      [run("ci", "completed", "failure", { id: 1 }), run("ci", "completed", "success", { id: 2 })],
    );

    expect(readiness.checks).toMatchObject({
      total: 1,
      passing: 1,
      failing: 0,
      pending: 0,
      overallStatus: "passing",
      informational: { total: 0 },
    });
  });

  it("does not satisfy an app-bound requirement with a same-name run from another provider", async () => {
    const readiness = await readinessFor(
      [requiredCheck("ci")],
      [run("ci", "completed", "success", { providerId: 99 })],
    );

    expect(readiness.checks).toMatchObject({
      total: 1,
      passing: 0,
      failing: 0,
      pending: 1,
      overallStatus: "pending",
      informational: { total: 1, passing: 1 },
    });
  });

  it("fails closed when branch-protection requirements cannot be read", async () => {
    const spawn = scriptedSpawn([
      { stdout: prJson() },
      { stdout: REPO_CFG },
      { stdout: NO_REVIEWS },
      { stderr: "HTTP 403", exit: 1 },
    ]);

    const readiness = await makeAdapter(spawn).readMergeReadiness(READINESS_REQ);

    expect(readiness.providerError).toBe(true);
    expect(readiness.checks).toBeUndefined();
  });
});

// ─── Governed remote lane ──────────────────────────────────────────────────────────────────────
// The merge `gh api` call must run under the GOVERNED REMOTE env profile. Under the fully isolated
// default profile `gh` has no token and an empty HOME, so every governed merge (and every merge
// readiness read) fails to authenticate.

const REMOTE_PARENT_ENV: NodeJS.ProcessEnv = {
  PATH: "/usr/bin",
  HOME: "/Users/dev",
  GITHUB_TOKEN: "ghs_merge_lane_token_value",
  AWS_SECRET_ACCESS_KEY: "aws-merge-lane-must-not-see-this",
};

async function mergeLaneEnv(): Promise<Record<string, string>> {
  const rec = recordingSpawn();
  const { info } = makeWorkspace();
  const adapter = createNodeGitMergeAdapter({
    workspace: info,
    processEnv: REMOTE_PARENT_ENV,
    now: () => 0,
    spawn: rec.fn,
    resolveExecutable: () => "gh",
  });
  const pending = adapter.mergePullRequest(execReq());
  rec.child.stdout.emit("data", Buffer.from("true\n"));
  rec.child.emit("close", 0, null);
  await pending;
  return rec.calls()[0]?.options.env ?? {};
}

describe("node git merge adapter — `gh` can authenticate", () => {
  it("forwards the GitHub token and the real HOME so gh resolves its own credentials", async () => {
    const env = await mergeLaneEnv();
    expect(env.GITHUB_TOKEN).toBe("ghs_merge_lane_token_value");
    expect(env.HOME).toBe("/Users/dev");
  });

  it("still copies by name only — an unrelated ambient secret never reaches gh", async () => {
    const env = await mergeLaneEnv();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });
});
