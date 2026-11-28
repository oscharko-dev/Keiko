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
import {
  governedIndexRecord,
  resetGovernedIndexPaths,
} from "../coding-runtime/governedIndexPaths.js";
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
let contextFault: Error | undefined;
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
  if (contextFault !== undefined) throw contextFault;
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
  contextFault = undefined;
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
  resetGovernedIndexPaths("run-branch");
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
    ["Main", "protected-name"],
    ["DEV", "protected-name"],
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
    ["Main", "protected-name"],
    ["DEV", "protected-name"],
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

  // #4491: from an unborn HEAD the branch is `git switch -c`: HEAD is re-pointed, no object is written.
  it("creates a task branch from an unborn HEAD by re-pointing HEAD at it", async () => {
    git(root, ["checkout", "-q", "--orphan", "fresh"]);
    runHead = "fresh";
    runBase = "fresh";
    await expect(branch(service(), "feature/x")).resolves.toMatchObject({
      status: "succeeded",
      reason: "none",
      branch: "feature/x",
    });
    expect(git(root, ["symbolic-ref", "HEAD"])).toBe("refs/heads/feature/x");
    expect(localBranches()).toBe("main");
    expect(adoptions).toEqual([
      expect.objectContaining({
        branch: "feature/x",
        baseBranch: "fresh",
        headSha: "0".repeat(40),
      }),
    ]);
    const lines = branchLines();
    expect(lines.at(-1)).toMatchObject({ extra: { state: "succeeded" } });
  });

  it.each(["main", "Main", "DEV"])(
    "refuses the protected name %s from an unborn HEAD",
    async (name) => {
      git(root, ["checkout", "-q", "--orphan", "main2"]);
      runHead = "main2";
      runBase = "main2";
      await expect(branch(service(), name)).resolves.toMatchObject({
        status: "blocked",
        reason: "protected-name",
      });
      expect(git(root, ["symbolic-ref", "HEAD"])).toBe("refs/heads/main2");
      expect(adoptions).toEqual([]);
    },
  );

  // The rollback re-points HEAD at the unborn base through branch-create; a protected rule on
  // branch-create must never make that rollback fail.
  it("puts an unborn base back when the run cannot adopt the branch", async () => {
    git(root, ["checkout", "-q", "--orphan", "fresh"]);
    runHead = "fresh";
    runBase = "fresh";
    adoptResult = false;
    await expect(branch(service(), "feature/x")).resolves.toMatchObject({
      status: "failed",
      reason: "rebind-failed",
    });
    expect(git(root, ["symbolic-ref", "HEAD"])).toBe("refs/heads/fresh");
  });

  it("still refuses a name that already exists from an unborn HEAD", async () => {
    git(root, ["checkout", "-q", "--orphan", "fresh"]);
    runHead = "fresh";
    runBase = "fresh";
    git(root, ["branch", "feature/taken", "main"]);
    await expect(branch(service(), "feature/taken")).resolves.toMatchObject({
      status: "blocked",
      reason: "branch-exists",
    });
    expect(git(root, ["symbolic-ref", "HEAD"])).toBe("refs/heads/fresh");
  });

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

// U-32: a task branch Keiko is certain to refuse is refused while it is still an ask, with the
// reason the step itself gives after a decision; the step stays the authoritative backstop.
describe("a task-branch ask Keiko is certain to refuse (U-32)", () => {
  it("is admitted for a run on its base branch in a Local checkout", () => {
    expect(service().branchAskRefusal("feature/x")).toBeUndefined();
    expect(branchLines()).toEqual([]);
  });

  it("refuses a run already on a task branch with the reason the step gives, and logs it", async () => {
    runHead = "feature/already";
    git(root, ["checkout", "-qb", "feature/already"]);
    const asked = service().branchAskRefusal("feature/x");
    expect(asked).toBe("not-on-base");
    const [line] = branchLines();
    expect(line).toMatchObject({
      correlationId: "runtime-git-branch-test",
      level: "warn",
      extra: { phase: "branch", state: "refused", reason: "not-on-base", refusedBeforeAsk: true },
    });
    expect(JSON.stringify(line)).not.toContain("feature/x");
    // The step after an approval says exactly the same, so the two never drift apart.
    await expect(branch(service(), "feature/x")).resolves.toMatchObject({
      status: "blocked",
      reason: asked,
    });
  });

  it.each(["not-local-checkout", "not-on-base", "executable-filters"] as const)(
    "refuses when the workspace says %s",
    (reason) => {
      admission = reason;
      expect(service().branchAskRefusal("feature/x")).toBe(reason);
    },
  );

  it.each([
    ["main", "protected-name"],
    ["a b", "invalid-name"],
  ] as const)("refuses the name %j as %s", (name, reason) => {
    expect(service().branchAskRefusal(name)).toBe(reason);
  });

  it("refuses every ask when the run has no workspace port, as the step does", () => {
    expect(service("none").branchAskRefusal("feature/x")).toBe("not-local-checkout");
  });

  it("never refuses, and says why, when the workspace cannot be read", () => {
    const unreadable: RuntimeGitTaskBranchPort = {
      admit: (): never => {
        throw new TypeError("workspace record unreadable");
      },
      adopt: (): boolean => false,
    };
    expect(service(unreadable).branchAskRefusal("feature/x")).toBeUndefined();
    const [line] = branchLines();
    expect(line).toMatchObject({
      level: "warn",
      extra: { phase: "branch", state: "failed", errorClass: "TypeError", refusedBeforeAsk: false },
    });
    expect(JSON.stringify(line)).not.toContain("unreadable");
  });

  it("never refuses, and says why, when the run context itself cannot be read", () => {
    contextFault = new TypeError("context unreadable");
    expect(service().branchAskRefusal("feature/x")).toBeUndefined();
    const [line] = branchLines();
    expect(line).toMatchObject({
      level: "warn",
      extra: { phase: "branch", state: "failed", errorClass: "TypeError", refusedBeforeAsk: false },
    });
  });

  it("asks nothing of a run that is not live, leaving the decision to the step", () => {
    live = false;
    expect(service().branchAskRefusal("feature/x")).toBeUndefined();
    expect(branchLines()).toEqual([]);
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

// The first read of a stage or unstage redemption is its own (`indexCurrent` re-reads the verified
// facts and refuses drift), so the dispatcher reads no facts ahead of it. A second full read of every
// Git fact doubled the cost of the redemption inside the tool's fixed 30 s budget: on a loaded host
// it settled `timeout` / `deadline-exceeded` while the staging itself was healthy.
describe("redeeming a stage proposal reads the repository once, in the redemption", () => {
  it.each(["stage", "unstage"] as const)(
    "refuses an unknown %s proposal as such, before any repository fact is read",
    async (operation) => {
      // A repository the run no longer matches: any facts read ahead of the redemption throws drift.
      runHead = "not-the-checked-out-branch";
      const result = await service("none").execute(
        {
          action: "git",
          actionId: `${operation}-exec-1`,
          idempotencyKey: `${operation}-exec-1`,
          operation,
          phase: "execute",
          proposalId: `${operation}-1`,
        },
        { check: (): boolean => true },
      );
      expect(result).toEqual({ kind: "refused", reason: "proposal-unknown" });
    },
  );
});

// Positive control for the single read above: a KNOWN proposal redeemed after the worktree moved is
// still refused through `redeem` (`indexCurrent` reads the verified facts and the candidate itself).
describe("redeeming a known stage proposal after the worktree drifted", () => {
  it("is refused as candidate-drift and stages nothing", async () => {
    writeFileSync(join(root, "code.js"), "export const value = 2;\n");
    const gitService = service("none");
    const proposed = await gitService.execute(
      {
        action: "git",
        actionId: "stage-prop-1",
        idempotencyKey: "stage-prop-1",
        operation: "stage",
        phase: "propose",
        paths: ["code.js"],
      },
      { check: (): boolean => true },
    );
    if (proposed.kind !== "stage" || !("proposalId" in proposed))
      throw new Error(`unexpected proposal ${JSON.stringify(proposed)}`);
    // The bytes the proposal bound are not the bytes in the worktree any more.
    writeFileSync(join(root, "code.js"), "export const value = 3;\n");
    const redeemed = await gitService.execute(
      {
        action: "git",
        actionId: "stage-exec-1",
        idempotencyKey: "stage-exec-1",
        operation: "stage",
        phase: "execute",
        proposalId: proposed.proposalId,
      },
      { check: (): boolean => true },
    );
    expect(redeemed).toMatchObject({ kind: "stage", status: "drift", reason: "candidate-drift" });
    expect(git(root, ["diff", "--cached", "--name-only"])).toBe("");
  });
});

// U-34b: the undo restores only what governed staging changed, so the one place that records it is
// the successful index mutation, through the real service, repository and mutation adapter.
describe("the paths governed staging records for the turn's undo", () => {
  const request = (
    operation: "stage" | "unstage",
    phase: "propose" | "execute",
    extra: Record<string, unknown>,
  ): Parameters<RuntimeGitService["execute"]>[0] =>
    ({
      action: "git",
      actionId: `${operation}-${phase}-1`,
      idempotencyKey: `${operation}-${phase}-1`,
      operation,
      phase,
      ...extra,
    }) as Parameters<RuntimeGitService["execute"]>[0];

  async function proposeAndRedeem(
    gitService: RuntimeGitService,
    operation: "stage" | "unstage",
    between: () => void = (): void => undefined,
  ): Promise<Awaited<ReturnType<RuntimeGitService["execute"]>>> {
    const proposed = await gitService.execute(
      request(operation, "propose", { paths: ["code.js"] }),
      {
        check: (): boolean => true,
      },
    );
    if (proposed.kind !== operation || !("proposalId" in proposed))
      throw new Error(`unexpected proposal ${JSON.stringify(proposed)}`);
    between();
    return gitService.execute(request(operation, "execute", { proposalId: proposed.proposalId }), {
      check: (): boolean => true,
    });
  }

  it("records the staged paths of a successful stage and of a successful unstage", async () => {
    writeFileSync(join(root, "code.js"), "export const value = 2;\n");
    const gitService = service("none");

    await expect(proposeAndRedeem(gitService, "stage")).resolves.toMatchObject({
      kind: "stage",
      status: "succeeded",
    });
    expect(git(root, ["diff", "--cached", "--name-only"])).toBe("code.js");
    expect(governedIndexRecord("run-branch").paths).toEqual(["code.js"]);

    resetGovernedIndexPaths("run-branch");
    await expect(proposeAndRedeem(gitService, "unstage")).resolves.toMatchObject({
      kind: "unstage",
      status: "succeeded",
    });
    expect(git(root, ["diff", "--cached", "--name-only"])).toBe("");
    expect(governedIndexRecord("run-branch").paths).toEqual(["code.js"]);
  });

  it("records nothing for a stage that drifted, was refused or never ran", async () => {
    writeFileSync(join(root, "code.js"), "export const value = 2;\n");
    const gitService = service("none");

    await expect(
      proposeAndRedeem(gitService, "stage", () => {
        writeFileSync(join(root, "code.js"), "export const value = 3;\n");
      }),
    ).resolves.toMatchObject({ status: "drift" });
    expect(governedIndexRecord("run-branch").paths).toEqual([]);

    // A run whose authority ended after the proposal is refused before any index change.
    const proposed = await gitService.execute(request("stage", "propose", { paths: ["code.js"] }), {
      check: (): boolean => true,
    });
    if (proposed.kind !== "stage" || !("proposalId" in proposed))
      throw new Error(`unexpected proposal ${JSON.stringify(proposed)}`);
    live = false;
    await gitService.execute(request("stage", "execute", { proposalId: proposed.proposalId }), {
      check: (): boolean => true,
    });
    expect(governedIndexRecord("run-branch").paths).toEqual([]);
    expect(git(root, ["diff", "--cached", "--name-only"])).toBe("");
  });
});
