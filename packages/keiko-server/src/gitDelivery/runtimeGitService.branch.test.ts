import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { createCodingRuntimeSnapshotStore } from "../coding-runtime/codingRuntimeSnapshotStore.js";
import { runMigrations } from "../store/schema.js";
import { createInMemoryGitDeliveryApprovalStore } from "./approvalStore.js";
import {
  stoppedResult,
  taskBranchNameRefusal,
  type RuntimeGitTaskBranchAdoption,
  type RuntimeGitTaskBranchAdmission,
  type RuntimeGitTaskBranchPort,
} from "./runtimeGitBranch.js";
import { RuntimeGitService } from "./runtimeGitService.js";
import type { VerifiedCommitRunContext } from "./verifiedCommitTypes.js";

// #3907 (owner decision 2026-10-31): the coding runtime creates and switches to a task branch
// through Keiko's Git kernel, against a real fixture-owned repository. The model's shell keeps
// refusing `git checkout -b`; this is the governed way a Local checkout on `main` gets a branch.

const DIGEST = "a".repeat(64);
let base: string;
let root: string;
let live: boolean;
let db: DatabaseSync;
let events: ServerLogEvent[];
let evidence: Map<string, string>;
// What the run's workspace record says; the fixture's port moves it exactly as the real one does.
let runHead: string;
let runBase: string;
let admission: RuntimeGitTaskBranchAdmission;
let adoptions: RuntimeGitTaskBranchAdoption[];
let adoptResult: boolean | Error;
let verificationInvalidations: number;
let deliveryInvalidations: number;

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: base,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Keiko Test",
      GIT_AUTHOR_EMAIL: "keiko@example.test",
      GIT_COMMITTER_NAME: "Keiko Test",
      GIT_COMMITTER_EMAIL: "keiko@example.test",
    },
  }).trim();
}

function context(): VerifiedCommitRunContext {
  return {
    runId: "run-branch",
    envelopeDigest: "b".repeat(64),
    runtimeAuthorityDigest: DIGEST,
    workspaceDigest: DIGEST,
    // A repository without an `origin` carries the local identity: the workspace digest itself.
    repositoryDigest: DIGEST,
    workspace: {
      root,
      selectedRoot: root,
      name: "test",
      version: undefined,
      testFramework: "vitest",
      sourceDirs: [],
      testDirs: [],
      languages: [],
      ignoreLines: [],
    },
    baseRef: runBase,
    headRef: runHead,
    correlationId: "runtime-git-branch-test",
    buffersClean: () => true,
    stillAuthorized: () => live,
  };
}

function port(): RuntimeGitTaskBranchPort {
  return {
    admit: () => admission,
    adopt: (adoption): boolean => {
      adoptions.push(adoption);
      if (adoptResult instanceof Error) throw adoptResult;
      if (adoptResult) {
        runHead = adoption.branch;
        runBase = adoption.baseBranch;
      }
      return adoptResult;
    },
  };
}

function service(taskBranch: RuntimeGitTaskBranchPort | "none" = port()): RuntimeGitService {
  return new RuntimeGitService({
    context,
    snapshots: createCodingRuntimeSnapshotStore(db),
    mutationDeps: {
      redactor: (value): unknown => value,
      evidenceStore: {
        put: (id, body): string => {
          evidence.set(id, body);
          return id;
        },
        get: (id): string | undefined => evidence.get(id),
        list: (): readonly string[] => [...evidence.keys()],
        delete: (id): void => {
          evidence.delete(id);
        },
      },
    },
    messageAllowed: (): Promise<boolean> => Promise.resolve(true),
    execution: {
      processEnv: { PATH: process.env.PATH, HOME: base },
      approvalStore: createInMemoryGitDeliveryApprovalStore(),
      activityLog: {
        write: (event): void => {
          events.push(event);
        },
      },
    },
    mode: (): "autonomous-delivery" => "autonomous-delivery",
    invalidateVerification: (): void => {
      verificationInvalidations += 1;
    },
    invalidateDelivery: (): void => {
      deliveryInvalidations += 1;
    },
    ...(taskBranch === "none" ? {} : { taskBranch }),
  });
}

function branch(
  gitService: RuntimeGitService,
  branchName: string,
): ReturnType<RuntimeGitService["execute"]> {
  return gitService.execute(
    {
      action: "git",
      actionId: "branch-1",
      idempotencyKey: "branch-1",
      operation: "branch",
      branchName,
    },
    { check: (): boolean => true },
  );
}

function branchLines(): readonly ServerLogEvent[] {
  return events.filter(
    (event) => event.op === "git.runtime-action" && event.extra?.phase === "branch",
  );
}

function localBranches(): string {
  return git(root, ["branch", "--format=%(refname:short)"]);
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "keiko-runtime-git-branch-")));
  root = join(base, "work");
  mkdirSync(root);
  git(root, ["init", "-qb", "main"]);
  writeFileSync(join(root, "code.js"), "export const value = 1;\n");
  git(root, ["add", "code.js"]);
  git(root, ["commit", "-qm", "base"]);
  live = true;
  runHead = "main";
  runBase = "main";
  admission = "admitted";
  adoptions = [];
  adoptResult = true;
  verificationInvalidations = 0;
  deliveryInvalidations = 0;
  events = [];
  evidence = new Map();
  db = new DatabaseSync(":memory:");
  runMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(base, { recursive: true, force: true });
});

describe("the name checks of a governed task branch", () => {
  it.each([
    ["feature/x", undefined],
    ["fix-123", undefined],
    ["-D", "invalid-name"],
    ["--force", "invalid-name"],
    ["a b", "invalid-name"],
    ["x..y", "invalid-name"],
    ["a:b", "invalid-name"],
    ["feature/", "invalid-name"],
    ["", "invalid-name"],
    ["main", "protected-name"],
    ["dev", "protected-name"],
  ] as const)("judges %j as %s", (name, refusal) => {
    expect(taskBranchNameRefusal(name)).toBe(refusal);
  });
});

describe("a governed task branch through the Git kernel (#3907)", () => {
  it("creates the branch at the current commit, switches to it, carries the changes and adopts it", async () => {
    writeFileSync(join(root, "code.js"), "export const value = 2;\n");
    const head = git(root, ["rev-parse", "HEAD"]);
    const gitService = service();
    await expect(branch(gitService, "feature/x")).resolves.toEqual({
      kind: "branch",
      status: "succeeded",
      reason: "none",
      branch: "feature/x",
    });
    expect(git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/x");
    expect(git(root, ["rev-parse", "feature/x"])).toBe(head);
    expect(git(root, ["rev-parse", "main"])).toBe(head);
    // The uncommitted edit is the run's work and travels with it.
    expect(git(root, ["status", "--porcelain"])).toBe("M code.js");
    expect(adoptions).toEqual([
      {
        runId: "run-branch",
        workspaceDigest: DIGEST,
        branch: "feature/x",
        baseBranch: "main",
        headSha: head,
      },
    ]);
    // Whatever rested on the old branch, commit proposals and verification, is invalidated.
    expect(verificationInvalidations).toBe(1);
    expect(deliveryInvalidations).toBe(1);
    // Both Git effects went through the kernel and left its ordinary mutation lines.
    expect(
      events
        .filter((event) => event.op === "git.delivery.mutation.completed")
        .map((event) => event.correlationId),
    ).toEqual(["runtime-git-branch-test", "runtime-git-branch-test"]);
    expect(
      branchLines().map((event) => [event.level, event.extra?.state, event.extra?.reason]),
    ).toEqual([[undefined, "succeeded", "none"]]);
    const persisted = expectActivityLogProof(
      "git.runtime-action.emitted-line",
      formatActivityLogProofLine(branchLines()[0] ?? {}),
    );
    expect(persisted).toMatchObject({ phase: "branch", state: "succeeded", runId: "run-branch" });
    expect(JSON.stringify(persisted)).not.toContain("feature/x");
    expect(JSON.stringify(persisted)).not.toContain(root);
  });

  it("then lets the run, now standing on its branch, create no further one", async () => {
    const gitService = service();
    await branch(gitService, "feature/x");
    await expect(branch(gitService, "feature/y")).resolves.toMatchObject({
      status: "blocked",
      reason: "not-on-base",
    });
    expect(localBranches()).not.toContain("feature/y");
  });

  it.each([
    ["-D", "invalid-name"],
    ["a b", "invalid-name"],
    ["main", "protected-name"],
    ["dev", "protected-name"],
  ] as const)("refuses %j as %s and creates nothing", async (name, reason) => {
    await expect(branch(service(), name)).resolves.toMatchObject({
      kind: "branch",
      status: "blocked",
      reason,
    });
    expect(git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(localBranches()).toBe("main");
    expect(adoptions).toEqual([]);
    expect(
      branchLines().map((event) => [event.level, event.extra?.state, event.extra?.reason]),
    ).toEqual([["warn", "blocked", reason]]);
  });

  it("does not echo an unsafe name back to the model", async () => {
    const result = await branch(service(), "-D");
    expect(result).toEqual({ kind: "branch", status: "blocked", reason: "invalid-name" });
  });

  it("refuses a branch that exists at another commit, and the branch the run stands on", async () => {
    git(root, ["branch", "feature/old"]);
    writeFileSync(join(root, "next.js"), "x\n");
    git(root, ["add", "next.js"]);
    git(root, ["commit", "-qm", "next"]);
    await expect(branch(service(), "feature/old")).resolves.toMatchObject({
      status: "blocked",
      reason: "branch-exists",
    });
    // The base branch itself is never "created", whatever protects its name.
    runBase = "trunk";
    runHead = "trunk";
    git(root, ["branch", "-m", "main", "trunk"]);
    await expect(branch(service(), "trunk")).resolves.toMatchObject({
      status: "blocked",
      reason: "branch-exists",
    });
    expect(adoptions).toEqual([]);
    expect(git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("trunk");
  });

  it("only switches to a branch that already stands at the current commit (a retried step)", async () => {
    git(root, ["branch", "feature/retry"]);
    const head = git(root, ["rev-parse", "HEAD"]);
    await expect(branch(service(), "feature/retry")).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/retry");
    expect(git(root, ["rev-parse", "feature/retry"])).toBe(head);
    expect(events.filter((event) => event.op === "git.delivery.mutation.completed")).toHaveLength(
      1,
    );
    expect(adoptions).toHaveLength(1);
  });

  it("refuses a run that is not on its base branch", async () => {
    runHead = "feature/already";
    git(root, ["checkout", "-qb", "feature/already"]);
    await expect(branch(service(), "feature/x")).resolves.toMatchObject({
      status: "blocked",
      reason: "not-on-base",
    });
    expect(localBranches()).not.toContain("feature/x");
  });

  it.each(["not-local-checkout", "not-on-base", "executable-filters"] as const)(
    "refuses when the workspace says %s",
    async (reason) => {
      admission = reason;
      await expect(branch(service(), "feature/x")).resolves.toMatchObject({
        status: "blocked",
        reason,
      });
      expect(localBranches()).toBe("main");
      expect(adoptions).toEqual([]);
    },
  );

  it("refuses every task branch when the run has no workspace port at all", async () => {
    await expect(branch(service("none"), "feature/x")).resolves.toMatchObject({
      status: "blocked",
      reason: "not-local-checkout",
    });
    expect(localBranches()).toBe("main");
  });

  it("puts the checkout back on the base branch when the run cannot adopt the branch", async () => {
    adoptResult = false;
    const gitService = service();
    await expect(branch(gitService, "feature/x")).resolves.toEqual({
      kind: "branch",
      status: "failed",
      reason: "rebind-failed",
      branch: "feature/x",
    });
    expect(git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(verificationInvalidations).toBe(0);
    expect(deliveryInvalidations).toBe(0);
    expect(
      branchLines().map((event) => [event.level, event.extra?.state, event.extra?.reason]),
    ).toEqual([["warn", "failed", "rebind-failed"]]);
  });

  // #4170 review: a checkout the kernel could not put back on its base is not reported as restored.
  it("reports an uncertain execution when the checkout cannot be put back on its base", async () => {
    const gitService = service({
      admit: () => "admitted",
      adopt: (adoption): boolean => {
        adoptions.push(adoption);
        git(root, ["branch", "-D", "main"]);
        return false;
      },
    });
    await expect(branch(gitService, "feature/x")).resolves.toEqual({
      kind: "branch",
      status: "recovery-required",
      reason: "execution-uncertain",
      branch: "feature/x",
    });
    expect(git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/x");
    expect(verificationInvalidations).toBe(0);
    expect(
      branchLines().map((event) => [event.level, event.extra?.state, event.extra?.reason]),
    ).toEqual([["warn", "recovery-required", "execution-uncertain"]]);
  });

  // #4170 review: a refused adoption whose switch back throws (here the snapshot read before it
  // fails on a corrupt index) leaves the checkout on the task branch; that is the same uncertain
  // execution, not a generic refusal.
  it("reports an uncertain execution when the switch back after a refused adoption throws", async () => {
    const gitService = service({
      admit: () => "admitted",
      adopt: (adoption): boolean => {
        adoptions.push(adoption);
        writeFileSync(join(root, ".git", "index"), "not an index");
        return false;
      },
    });
    await expect(branch(gitService, "feature/x")).resolves.toEqual({
      kind: "branch",
      status: "recovery-required",
      reason: "execution-uncertain",
      branch: "feature/x",
    });
    expect(git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/x");
    expect(branchLines().at(-1)?.extra).toMatchObject({
      state: "recovery-required",
      reason: "execution-uncertain",
    });
  });

  it("keeps a thrown adoption the primary failure when the switch back fails as well", async () => {
    const gitService = service({
      admit: () => "admitted",
      adopt: (adoption): boolean => {
        adoptions.push(adoption);
        git(root, ["branch", "-D", "main"]);
        throw new TypeError("workspace record refused");
      },
    });
    await expect(branch(gitService, "feature/x")).resolves.toMatchObject({
      status: "recovery-required",
      reason: "execution-uncertain",
    });
    const lines = branchLines();
    expect(lines[0]?.extra).toMatchObject({
      state: "failed",
      reason: "rebind-failed",
      errorClass: "TypeError",
    });
    expect(lines[1]?.extra).toMatchObject({
      state: "recovery-required",
      reason: "execution-uncertain",
    });
    expect(JSON.stringify(lines)).not.toContain("workspace record refused");
  });

  // #4170 review: the facade admits concurrent tool calls; two task branches must not both pass
  // the base-branch check and switch the checkout twice.
  it("runs concurrent task-branch calls one after the other", async () => {
    const gitService = service();
    const [first, second] = await Promise.all([
      branch(gitService, "feature/a"),
      branch(gitService, "feature/b"),
    ]);
    expect(first).toMatchObject({ status: "succeeded", branch: "feature/a" });
    expect(second).toMatchObject({ status: "blocked", reason: "not-on-base" });
    expect(git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/a");
    expect(localBranches()).not.toContain("feature/b");
    expect(adoptions.map((adoption) => adoption.branch)).toEqual(["feature/a"]);
  });

  it("logs the cause of an adoption that threw, structured and body-free, and restores the checkout", async () => {
    adoptResult = new TypeError("workspace record refused");
    await expect(branch(service(), "feature/x")).resolves.toMatchObject({
      status: "failed",
      reason: "rebind-failed",
    });
    expect(git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    const lines = branchLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]?.extra).toMatchObject({
      state: "failed",
      reason: "rebind-failed",
      errorClass: "TypeError",
    });
    expect(lines[0]?.correlationId).toBe("runtime-git-branch-test");
    expect(JSON.stringify(lines)).not.toContain("workspace record refused");
  });

  // Git refusing the ref leaves the repository in a state the kernel cannot vouch for, which it
  // reports as recovery-required; the tool answers that in its own closed words, not by throwing.
  it("answers a Git fault in closed words, not as a thrown error", async () => {
    // `feature` is a file in the ref store, so `feature/x` cannot be created beneath it.
    git(root, ["branch", "feature"]);
    await expect(branch(service(), "feature/x")).resolves.toMatchObject({
      kind: "branch",
      status: "recovery-required",
      reason: "execution-uncertain",
    });
    expect(git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(adoptions).toEqual([]);
    expect(
      branchLines().map((event) => [event.level, event.extra?.state, event.extra?.reason]),
    ).toEqual([["warn", "recovery-required", "execution-uncertain"]]);
  });

  it("creates nothing once the run's authority has closed", async () => {
    live = false;
    await expect(branch(service(), "feature/x")).resolves.toEqual({
      kind: "refused",
      reason: "authority-revoked",
    });
    expect(localBranches()).toBe("main");
    expect(adoptions).toEqual([]);
  });

  it("withholds the result when the authority closes while the branch is being made", async () => {
    adoptResult = true;
    const gitService = service({
      admit: () => "admitted",
      adopt: (adoption): boolean => {
        live = false;
        adoptions.push(adoption);
        return true;
      },
    });
    await expect(branch(gitService, "feature/x")).resolves.toEqual({
      kind: "refused",
      reason: "authority-revoked",
    });
    expect(branchLines().map((event) => event.extra?.state)).toEqual(["succeeded", "withheld"]);
  });
});

// Every way the kernel can stop a branch step, in the tool's closed words (#3907).
describe("the closed result of a stopped kernel outcome", () => {
  const executionResult = { schemaVersion: "1", outcome: "failed", durationMs: 0 } as never;
  it.each([
    [{ status: "succeeded", executionResult }, undefined],
    [
      { status: "failed", category: "execution-failure", executionResult },
      { status: "failed", reason: "execution-failed" },
    ],
    [
      { status: "recovery-required", category: "recovery-required", executionResult },
      { status: "recovery-required", reason: "execution-uncertain" },
    ],
    [
      { status: "approval-required", requiredApprovers: ["owner"] },
      { status: "blocked", reason: "policy-block" },
    ],
    [
      { status: "blocked", category: "preflight-block", findings: [] },
      { status: "blocked", reason: "preflight-block" },
    ],
    [
      { status: "blocked", category: "policy-block", blockReason: "authority-denied" },
      { status: "blocked", reason: "authority-denied" },
    ],
    [
      { status: "blocked", category: "policy-block", blockReason: "policy-pack-blocked" },
      { status: "blocked", reason: "policy-block" },
    ],
  ] as const)("maps %j", (outcome, expected) => {
    const result = stoppedResult(outcome, "feature/x");
    if (expected === undefined) expect(result).toBeUndefined();
    else expect(result).toEqual({ kind: "branch", ...expected, branch: "feature/x" });
  });
});
