// Integration coverage for the governed local Git execution core (Issue #475, Epic #470). Exercises
// executeGovernedMutation with its DEFAULT seams (the real node adapter + the real read-only snapshot
// reader) against a disposable hermetic git repository, plus the pure response projection across every
// outcome status. This proves the whole local-execution stack end-to-end and covers the default-seam
// branches the route tests inject around.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type {
  GitDeliveryExecutionResult,
  GitDeliveryRepoPolicyPack,
  WorkspaceInstance,
} from "@oscharko-dev/keiko-contracts";
import { GIT_DELIVERY_POLICY_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-policy";
import { GIT_DELIVERY_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/git-delivery";
import type {
  GitLocalMutationAdapter,
  GitMutationLifecycleResult,
  GitWorktreeSnapshot,
} from "@oscharko-dev/keiko-tools";
import type { NodeGitWorktreeReaderDeps } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import { buildRedactor } from "../index.js";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { ServerLogEvent } from "../observability/server-log.js";
import { createInMemoryUiStore } from "../store/index.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";

// Spies on the two staged-content readers the F1 audit fix wires into a runCommand
// termination-evidence callback (readStagedPathsFor / readStagedConflictMarkerFileCountFor,
// exercised below) while delegating to the REAL implementation for every export — including
// readGitWorktreeSnapshot and createNodeGitMutationAdapter, which the "real git through the
// default seams" suite below depends on staying genuine. Declared before the mock factory purely
// for readability; the factory's inner closure is only invoked later, from inside an `it()` body,
// long after this module's own top-level code (including this declaration) has finished running
// — mirrors the same importOriginal-plus-delegating-wrapper pattern
// defaultPolicyPacks.test.ts already uses for this exact module graph.
const readStagedPathsCalls: NodeGitWorktreeReaderDeps[] = [];
const readStagedConflictMarkerFileCountCalls: NodeGitWorktreeReaderDeps[] = [];
vi.mock("@oscharko-dev/keiko-tools/internal/git-mutation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@oscharko-dev/keiko-tools/internal/git-mutation")>();
  return {
    ...actual,
    readStagedPaths: (deps: NodeGitWorktreeReaderDeps): Promise<readonly string[]> => {
      readStagedPathsCalls.push(deps);
      return actual.readStagedPaths(deps);
    },
    readStagedConflictMarkerFileCount: (deps: NodeGitWorktreeReaderDeps): Promise<number> => {
      readStagedConflictMarkerFileCountCalls.push(deps);
      return actual.readStagedConflictMarkerFileCount(deps);
    },
  };
});

import {
  executeGovernedMutation,
  gitDeliveryMutationResponse,
  gitDeliveryTerminationHandler,
  GitDeliveryRootAuthorityRevokedError,
  KEIKO_DEFAULT_LOCAL_GIT_POLICY_PACK,
  readStagedConflictMarkerFileCountFor,
  readStagedPathsFor,
  resolveProjectWorkspace,
  type GitDeliveryExecutionSeams,
} from "./execution.js";
import {
  deriveManagedWorktreePath,
  deriveRepositoryId,
  deriveTaskBranchName,
  deriveWorkspaceId,
} from "../task-workspace/naming.js";
import { assertManagedRootOwned } from "../task-workspace/managed-root.js";
import { inspectManagedGitdirIdentity } from "../task-workspace/gitdir-identity.js";

let root: string;

function git(args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: root, encoding: "utf8" });
}

function workspaceInfo(rootPath: string): WorkspaceInfo {
  return {
    root: rootPath,
    selectedRoot: rootPath,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

const ALLOW_LOCAL: GitDeliveryRepoPolicyPack = {
  schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
  repoId: "repo",
  rules: [],
  defaultRule: {
    decision: "constrained",
    constraints: [{ kind: "risk-class-ceiling", maxRiskClass: "local-mutation" }],
  },
};

function captureStore(): { store: EvidenceStore; count: () => number } {
  const docs = new Map<string, string>();
  return {
    store: {
      put: (id, json): string => {
        docs.set(id, json);
        return id;
      },
      list: () => [...docs.keys()],
      get: (id) => docs.get(id),
      delete: (id) => docs.delete(id),
    },
    count: (): number => {
      let n = 0;
      for (const json of docs.values()) {
        const doc = JSON.parse(json) as { records?: unknown[] };
        n += Array.isArray(doc.records) ? doc.records.length : 0;
      }
      return n;
    },
  };
}

function captureActivityLog(): {
  readonly events: ServerLogEvent[];
  readonly sink: { readonly write: (event: ServerLogEvent) => void };
} {
  const events: ServerLogEvent[] = [];
  return {
    events,
    sink: {
      write: (event): void => {
        events.push(event);
      },
    },
  };
}

function expectCompletedMutationEvent(event: ServerLogEvent | undefined): void {
  expect(event).toBeDefined();
  if (event === undefined) throw new Error("mutation activity event missing");
  const extra = event.extra ?? {};
  expect(event.category).toBe("diagnostic");
  expect(event.op).toBe("git.delivery.mutation.completed");
  expect(event.correlationId).toBe("request-correlation-1");
  expect(extra.actionId).toMatch(/^gde-action-[a-f0-9]{24}$/u);
  expect(extra.actionKind).toBe("branch-create");
  expect(extra.status).toBe("succeeded");
  expect(extra.phaseReached).toBe("result");
  expect(extra.policyOutcome).toBe("constrained");
  expect(extra.preflightFindingCount).toBe(0);
  expect(extra.preflightBlockingCount).toBe(0);
  expect(extra.requiredApproverCount).toBe(0);
}

// Real adapter + real snapshot reader: only the trusted policy pack is supplied (no adapter/reader/now
// seam), exercising the default-seam branches and the live read-only inspection + mutation boundary.
const REAL_SEAMS: GitDeliveryExecutionSeams = { policyPacks: { repoPack: ALLOW_LOCAL } };

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-gd-exec-")));
  // The real adapter intentionally reads the invoking human's global signing policy. This suite
  // exercises the default adapter but must not inherit a developer-machine ~/.gitconfig: a global
  // `commit.gpgSign=true` would correctly block its deliberately unsigned disposable commits.
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@keiko.example"]);
  git(["config", "user.name", "Keiko Test"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(root, "a.txt"), "v1\n", "utf8");
  git(["add", "a.txt"]);
  git(["commit", "-q", "-m", "base"]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("executeGovernedMutation — real git through the default seams", () => {
  it("creates a branch and records evidence", async () => {
    const cap = captureStore();
    const activity = captureActivityLog();
    const deps = { evidenceStore: cap.store, redactor: buildRedactor({}) };
    const result = await executeGovernedMutation(
      {
        kind: "branch-create",
        branchName: "feature/x",
        baseBranchName: "main",
        startPointRefHash: "HEAD",
      },
      { required: false },
      workspaceInfo(root),
      deps,
      { ...REAL_SEAMS, activityLog: activity.sink },
      "request-correlation-1",
    );
    expect(result.outcome.status).toBe("succeeded");
    expect(git(["branch", "--list", "feature/x"])).toContain("feature/x");
    expect(cap.count()).toBe(1);
    expectCompletedMutationEvent(activity.events[0]);
    expect(JSON.stringify(activity.events)).not.toContain("feature/x");
  });

  it("switches branch, stages a file, and commits — all through the kernel", async () => {
    const cap = captureStore();
    const deps = { evidenceStore: cap.store, redactor: buildRedactor({}) };
    git(["branch", "feature/y"]);
    const ws = workspaceInfo(root);

    const switched = await executeGovernedMutation(
      { kind: "branch-switch", branchName: "feature/y" },
      { required: false },
      ws,
      deps,
      REAL_SEAMS,
      undefined,
    );
    expect(switched.outcome.status).toBe("succeeded");
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("feature/y");

    writeFileSync(join(root, "b.txt"), "x\n", "utf8");
    const staged = await executeGovernedMutation(
      { kind: "stage", pathspecs: ["b.txt"], includeUntracked: true },
      { required: false },
      ws,
      deps,
      REAL_SEAMS,
      undefined,
    );
    expect(staged.outcome.status).toBe("succeeded");

    const committed = await executeGovernedMutation(
      { kind: "commit", message: "feat: add b", allowEmpty: false },
      { required: false },
      ws,
      deps,
      REAL_SEAMS,
      undefined,
    );
    expect(committed.outcome.status).toBe("succeeded");
    expect(git(["log", "--oneline"])).toContain("feat: add b");
    expect(cap.count()).toBe(3);
  });

  it("blocks a commit at preflight when nothing is staged (no mutation)", async () => {
    const cap = captureStore();
    const deps = { evidenceStore: cap.store, redactor: buildRedactor({}) };
    const result = await executeGovernedMutation(
      { kind: "commit", message: "feat: nothing", allowEmpty: false },
      { required: false },
      workspaceInfo(root),
      deps,
      REAL_SEAMS,
      undefined,
    );
    expect(result.outcome.status).toBe("blocked");
    expect(gitDeliveryMutationResponse(result).preflightFindingCodes).toContain(
      "nothing-staged-to-commit",
    );
  });

  it("uses the default policy pack (local-mutation permitted) when no packs are injected", async () => {
    const cap = captureStore();
    const deps = { evidenceStore: cap.store, redactor: buildRedactor({}) };
    // No seams at all → default node adapter, default reader, default clock/id, default local pack.
    const result = await executeGovernedMutation(
      {
        kind: "branch-create",
        branchName: "feature/z",
        baseBranchName: "main",
        startPointRefHash: "HEAD",
      },
      { required: false },
      workspaceInfo(root),
      deps,
      {},
      undefined,
    );
    expect(result.outcome.status).toBe("succeeded");
    expect(KEIKO_DEFAULT_LOCAL_GIT_POLICY_PACK.defaultRule?.decision).toBe("constrained");
  });

  it("surfaces a worktree read failure as a thrown error outside a git repository", async () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), "keiko-gd-nonrepo-")));
    const deps = { evidenceStore: captureStore().store, redactor: buildRedactor({}) };
    const activity = captureActivityLog();
    try {
      await expect(
        executeGovernedMutation(
          { kind: "branch-switch", branchName: "main" },
          { required: false },
          workspaceInfo(bare),
          deps,
          { ...REAL_SEAMS, activityLog: activity.sink },
          "request-correlation-2",
        ),
      ).rejects.toBeTruthy();
      const event = activity.events[0];
      expect(event?.level).toBe("error");
      expect(event?.category).toBe("diagnostic");
      expect(event?.op).toBe("git.delivery.mutation.failed");
      expect(event?.correlationId).toBe("request-correlation-2");
      expect(typeof event?.errorKind).toBe("string");
      expect(event?.extra?.actionKind).toBe("branch-switch");
      expect(event?.extra?.phaseReached).toBe("snapshot");
      expect(JSON.stringify(activity.events)).not.toContain(bare);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

// ─── runCommand termination-evidence correlation (audit finding: readWorktreeSnapshotFor/adapterFor
// dropped an already-in-scope correlationId in favour of UNKNOWN_CORRELATION_ID) ──────────────────

describe("gitDeliveryTerminationHandler — correlation-id wiring for the runCommand evidence seam", () => {
  it("carries the caller's own correlationId onto command.terminated instead of downgrading it", () => {
    const activity = captureActivityLog();
    const handler = gitDeliveryTerminationHandler(
      { activityLog: activity.sink },
      "request-correlation-7",
    );
    handler({ reason: "timeout", childPid: 4242, windowsTreeKill: "not-attempted" });
    expect(activity.events).toHaveLength(1);
    expect(activity.events[0]?.op).toBe("command.terminated");
    expect(activity.events[0]?.correlationId).toBe("request-correlation-7");
    expect(activity.events[0]?.extra?.childPid).toBe(4242);
  });

  it("falls back to UNKNOWN_CORRELATION_ID only when the caller genuinely has none in scope", () => {
    const activity = captureActivityLog();
    const handler = gitDeliveryTerminationHandler({ activityLog: activity.sink }, undefined);
    handler({ reason: "abort", childPid: 4242, windowsTreeKill: "not-attempted" });
    expect(activity.events[0]?.correlationId).toBe(UNKNOWN_CORRELATION_ID);
  });
});

// ─── F1: the sibling default readers (readStagedPathsFor / readStagedConflictMarkerFileCountFor)
// — audit finding: unlike readWorktreeSnapshotFor/adapterFor above, these two receive NO
// termination callback at all in their DEFAULT (no-seam) branch, so a request-scoped local
// mutation whose staged-path or conflict-marker read times out or hits the output cap leaves NO
// evidence line joinable to its git-delivery operation. ────────────────────────────────────────

describe("readStagedPathsFor / readStagedConflictMarkerFileCountFor — default-reader termination wiring", () => {
  beforeEach(() => {
    readStagedPathsCalls.length = 0;
    readStagedConflictMarkerFileCountCalls.length = 0;
  });

  it("wires the caller's activityLog + correlationId into the default readStagedPaths call", async () => {
    const activity = captureActivityLog();
    const paths = await readStagedPathsFor(
      workspaceInfo(root),
      { activityLog: activity.sink },
      () => 1_700_000_000_000,
      "request-correlation-staged-paths",
    );
    expect(paths).toEqual([]); // beforeEach leaves a clean worktree — nothing staged
    expect(readStagedPathsCalls).toHaveLength(1);
    const onTerminated = readStagedPathsCalls[0]?.onTerminated;
    expect(onTerminated).toBeTypeOf("function");
    onTerminated?.({ reason: "timeout", childPid: 777, windowsTreeKill: "not-attempted" });
    expect(activity.events).toHaveLength(1);
    expect(activity.events[0]?.op).toBe("command.terminated");
    expect(activity.events[0]?.correlationId).toBe("request-correlation-staged-paths");
    expect(activity.events[0]?.extra?.childPid).toBe(777);
  });

  it("wires the caller's activityLog + correlationId into the default readStagedConflictMarkerFileCount call", async () => {
    const activity = captureActivityLog();
    const count = await readStagedConflictMarkerFileCountFor(
      workspaceInfo(root),
      { activityLog: activity.sink },
      () => 1_700_000_000_000,
      "request-correlation-conflict-count",
    );
    expect(count).toBe(0); // beforeEach leaves a clean worktree — nothing staged
    expect(readStagedConflictMarkerFileCountCalls).toHaveLength(1);
    const onTerminated = readStagedConflictMarkerFileCountCalls[0]?.onTerminated;
    expect(onTerminated).toBeTypeOf("function");
    onTerminated?.({ reason: "output-cap", childPid: 888, windowsTreeKill: "not-attempted" });
    expect(activity.events).toHaveLength(1);
    expect(activity.events[0]?.op).toBe("command.terminated");
    expect(activity.events[0]?.correlationId).toBe("request-correlation-conflict-count");
    expect(activity.events[0]?.extra?.childPid).toBe(888);
  });

  it("falls back to UNKNOWN_CORRELATION_ID for both readers when the caller has none in scope", async () => {
    const activity = captureActivityLog();
    const workspace = workspaceInfo(root);
    await readStagedPathsFor(workspace, { activityLog: activity.sink }, () => 1);
    await readStagedConflictMarkerFileCountFor(workspace, { activityLog: activity.sink }, () => 1);
    readStagedPathsCalls[0]?.onTerminated?.({
      reason: "abort",
      childPid: 1,
      windowsTreeKill: "not-attempted",
    });
    readStagedConflictMarkerFileCountCalls[0]?.onTerminated?.({
      reason: "abort",
      childPid: 2,
      windowsTreeKill: "not-attempted",
    });
    expect(activity.events).toHaveLength(2);
    expect(activity.events[0]?.correlationId).toBe(UNKNOWN_CORRELATION_ID);
    expect(activity.events[1]?.correlationId).toBe(UNKNOWN_CORRELATION_ID);
  });

  it("still defers to an injected stagedPathsReader/conflictMarkerReader seam untouched", async () => {
    const seams: GitDeliveryExecutionSeams = {
      stagedPathsReader: () => Promise.resolve(["a.txt"]),
      conflictMarkerReader: () => Promise.resolve(3),
    };
    const workspace = workspaceInfo(root);
    await expect(
      readStagedPathsFor(workspace, seams, () => 1, "unused-correlation"),
    ).resolves.toEqual(["a.txt"]);
    await expect(
      readStagedConflictMarkerFileCountFor(workspace, seams, () => 1, "unused-correlation"),
    ).resolves.toBe(3);
    // The seam path never reaches the default reader at all.
    expect(readStagedPathsCalls).toHaveLength(0);
    expect(readStagedConflictMarkerFileCountCalls).toHaveLength(0);
  });
});

// ─── Pure response projection across every outcome status ────────────────────────────────────────

function lifecycle(outcome: GitMutationLifecycleResult["outcome"]): GitMutationLifecycleResult {
  return {
    envelope: {
      schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
      actionId: "a1",
      kind: "commit",
      resolvedInputs: {
        kind: "commit",
        messageByteLength: 4,
        stagedPathCount: 1,
        allowEmptyCommit: false,
      },
      policyDecision: { outcome: "allowed" },
      approvalRequirement: { required: false },
      preview: {
        schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
        wouldCreateRemoteBranch: false,
        wouldTriggerChecks: false,
      },
    },
    outcome,
    phaseReached: "result",
    preflight: { ok: true, findings: [], blocking: [], advisory: [] },
  };
}

const exec = {
  schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
  outcome: "failed" as const,
  durationMs: 1,
  errorCode: "internal-error" as const,
};

describe("gitDeliveryMutationResponse — content-free projection of every outcome", () => {
  it("succeeded", () => {
    expect(
      gitDeliveryMutationResponse(
        lifecycle({
          status: "succeeded",
          executionResult: { ...exec, outcome: "succeeded", errorCode: undefined },
        }),
      ).status,
    ).toBe("succeeded");
  });
  it("approval-required carries the required approvers", () => {
    const body = gitDeliveryMutationResponse(
      lifecycle({ status: "approval-required", requiredApprovers: ["lead"] }),
    );
    expect(body.status).toBe("approval-required");
    expect(body.requiredApprovers).toEqual(["lead"]);
  });
  it("policy-block carries the typed block reason", () => {
    const body = gitDeliveryMutationResponse(
      lifecycle({
        status: "blocked",
        category: "policy-block",
        blockReason: "policy-pack-blocked",
      }),
    );
    expect(body.blockReason).toBe("policy-pack-blocked");
  });
  it("failed and recovery-required carry the execution error code", () => {
    expect(
      gitDeliveryMutationResponse(
        lifecycle({ status: "failed", category: "execution-failure", executionResult: exec }),
      ).executionErrorCode,
    ).toBe("internal-error");
    expect(
      gitDeliveryMutationResponse(
        lifecycle({
          status: "recovery-required",
          category: "recovery-required",
          executionResult: exec,
        }),
      ).executionErrorCode,
    ).toBe("internal-error");
  });
});

describe("resolveProjectWorkspace", () => {
  it("resolves a registered project path and rejects an unknown one", () => {
    const store = createInMemoryUiStore();
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-gd-rp-")));
    try {
      const proj = store.createProject(dir);
      expect(resolveProjectWorkspace({ store }, proj.path)?.root).toBe(proj.path);
      expect(resolveProjectWorkspace({ store }, "/repo/missing")).toBeUndefined();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves a persisted managed task workspace root without legacy project registration", () => {
    const store = createInMemoryUiStore();
    const fixture = createManagedWorktreeFixture("task-443");
    try {
      expect(
        resolveProjectWorkspace(
          { store, ...managedAccessDeps(fixture, () => fixture.instance) },
          fixture.managedWorktreePath,
        )?.root,
      ).toBe(fixture.managedWorktreePath);
    } finally {
      store.close();
      fixture.dispose();
    }
  });
});

// ─── #3347 owner P1: the managed-root proof must survive to the Git EFFECT ─────────────────────
//
// resolveProjectWorkspace admits a managed worktree through the strong prover and collapses it to a
// path-only WorkspaceInfo. executeGovernedMutation then awaits a multi-command snapshot before it
// builds the mutation adapter, so an archive or identity replacement during that await used to make
// the mutation commands run against whatever now sits at the admitted path.

interface ManagedWorktreeFixture {
  readonly managedRoot: string;
  readonly repoRoot: string;
  readonly managedWorktreePath: string;
  readonly workspaceId: string;
  readonly instance: WorkspaceInstance;
  readonly dispose: () => void;
}

// A GENUINE managed task worktree: an owned managed root, a real repository, and a real `git
// worktree add` linkage whose gitdir identity matches the persisted instance. The #3347 prover
// re-checks ownership, lifecycle state and gitdir identity on every call, so a plain mkdir cannot
// stand in for this fixture.
function createManagedWorktreeFixture(taskId: string): ManagedWorktreeFixture {
  const managedRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-gd-managed-root-")));
  const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-gd-managed-repo-")));
  assertManagedRootOwned(managedRoot);
  execFileSync("git", ["init", "-q"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "Keiko Test"], { cwd: repoRoot });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "fixture"], { cwd: repoRoot });
  const repositoryId = deriveRepositoryId(repoRoot);
  const workspaceId = deriveWorkspaceId({ repositoryId, taskId });
  const managedWorktreePath = deriveManagedWorktreePath({ managedRoot, repositoryId, workspaceId });
  const taskBranch = deriveTaskBranchName({ taskId });
  mkdirSync(dirname(managedWorktreePath), { recursive: true });
  execFileSync("git", ["worktree", "add", "-q", "-b", taskBranch, managedWorktreePath, "HEAD"], {
    cwd: repoRoot,
  });
  const gitdirInspection = inspectManagedGitdirIdentity(managedWorktreePath, repoRoot);
  if (gitdirInspection === undefined) {
    throw new Error("fixture git worktree did not produce a resolvable gitdir identity");
  }
  return {
    managedRoot,
    repoRoot,
    managedWorktreePath,
    workspaceId,
    instance: {
      schemaVersion: "1",
      workspaceId,
      taskId,
      repositoryId,
      repositoryRoot: repoRoot,
      baseBranch: "main",
      taskBranch,
      managedWorktreePath,
      gitdirIdentity: gitdirInspection.identity,
      lifecycleState: "active",
      health: "healthy",
      lock: null,
      createdAt: "2026-06-26T00:00:00.000Z",
      updatedAt: "2026-06-26T00:00:00.000Z",
      driftMarkers: [],
      recoveryHints: [],
      auditCorrelationId: workspaceId,
    },
    dispose: (): void => {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(managedRoot, { recursive: true, force: true });
    },
  };
}

// The provisioning lookup reads `current()` on EVERY call, so a test can revoke the workspace
// (archive it) between two re-proofs exactly as production lifecycle transitions do.
function managedAccessDeps(
  fixture: ManagedWorktreeFixture,
  current: () => WorkspaceInstance | undefined,
): {
  readonly managedTaskWorkspaceRoot: string;
  readonly workspaceProvisioning: {
    readonly getInstance: (id: string) => WorkspaceInstance | undefined;
    readonly provision: () => Promise<never>;
    readonly activate: () => Promise<never>;
  };
} {
  return {
    managedTaskWorkspaceRoot: fixture.managedRoot,
    workspaceProvisioning: {
      getInstance: (id: string): WorkspaceInstance | undefined =>
        id === fixture.workspaceId ? current() : undefined,
      provision: (): Promise<never> => Promise.reject(new Error("not used")),
      activate: (): Promise<never> => Promise.reject(new Error("not used")),
    },
  };
}

function recordingMutationAdapter(calls: string[]): GitLocalMutationAdapter {
  const succeeded = (kind: string): Promise<GitDeliveryExecutionResult> => {
    calls.push(kind);
    return Promise.resolve({
      schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
      outcome: "succeeded",
      durationMs: 1,
    });
  };
  return {
    createBranch: () => succeeded("createBranch"),
    switchBranch: () => succeeded("switchBranch"),
    stage: () => succeeded("stage"),
    unstage: () => succeeded("unstage"),
    commit: () => succeeded("commit"),
    abort: () => succeeded("abort"),
    recover: () => succeeded("recover"),
  };
}

const MANAGED_SNAPSHOT: GitWorktreeSnapshot = {
  headDetached: false,
  currentBranchName: "keiko/task-3347",
  stagedFileCount: 0,
  unstagedFileCount: 0,
  untrackedFileCount: 0,
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  existingLocalBranchNames: ["keiko/task-3347"],
  remoteAliases: [],
};

const BRANCH_CREATE = {
  kind: "branch-create",
  branchName: "feature/after-revocation",
  baseBranchName: "keiko/task-3347",
  startPointRefHash: "HEAD",
} as const;

describe("executeGovernedMutation — managed-root re-proof at the spawn boundaries", () => {
  it("starts no mutation when the root is archived while the snapshot read is in flight", async () => {
    const fixture = createManagedWorktreeFixture("task-3347-deferred");
    const cap = captureStore();
    const activity = captureActivityLog();
    const calls: string[] = [];
    let instance: WorkspaceInstance | undefined = fixture.instance;
    try {
      const result = await executeGovernedMutation(
        BRANCH_CREATE,
        { required: false },
        workspaceInfo(fixture.managedWorktreePath),
        {
          evidenceStore: cap.store,
          redactor: buildRedactor({}),
          ...managedAccessDeps(fixture, () => instance),
        },
        {
          policyPacks: { repoPack: ALLOW_LOCAL },
          activityLog: activity.sink,
          adapterFactory: () => recordingMutationAdapter(calls),
          snapshotReader: (): Promise<GitWorktreeSnapshot> => {
            // The revocation lands during the await the finding names: admission proved the root,
            // the multi-command snapshot read is in flight, and the adapter has not been built yet.
            instance = { ...fixture.instance, lifecycleState: "archived" };
            return Promise.resolve(MANAGED_SNAPSHOT);
          },
        },
        "request-correlation-revoked",
      );

      expect(calls).toEqual([]);
      expect(result.outcome).toMatchObject({
        status: "blocked",
        category: "policy-block",
        blockReason: "authority-denied",
      });
      const noSpawn = activity.events.find((e) => e.op === "git.delivery.dispatch.no-spawn");
      expect(noSpawn?.correlationId).toBe("request-correlation-revoked");
      expect(noSpawn?.extra?.operation).toBe("branch-create");
      expect(
        activity.events.some(
          (e) => e.op === "workspace.root.denied" && e.extra?.reason === "managed-root-lifecycle",
        ),
      ).toBe(true);
      expect(JSON.stringify(activity.events)).not.toContain(fixture.managedWorktreePath);
    } finally {
      fixture.dispose();
    }
  });

  it("dispatches the same mutation while the managed root still re-proves (negative control)", async () => {
    const fixture = createManagedWorktreeFixture("task-3347-live");
    const cap = captureStore();
    const calls: string[] = [];
    try {
      const result = await executeGovernedMutation(
        BRANCH_CREATE,
        { required: false },
        workspaceInfo(fixture.managedWorktreePath),
        {
          evidenceStore: cap.store,
          redactor: buildRedactor({}),
          ...managedAccessDeps(fixture, () => fixture.instance),
        },
        {
          policyPacks: { repoPack: ALLOW_LOCAL },
          adapterFactory: () => recordingMutationAdapter(calls),
          snapshotReader: (): Promise<GitWorktreeSnapshot> => Promise.resolve(MANAGED_SNAPSHOT),
        },
        "request-correlation-live",
      );

      expect(calls).toEqual(["createBranch"]);
      expect(result.outcome.status).toBe("succeeded");
    } finally {
      fixture.dispose();
    }
  });

  it("refuses before the snapshot read when the root was already revoked at entry", async () => {
    const fixture = createManagedWorktreeFixture("task-3347-preflight");
    const cap = captureStore();
    const activity = captureActivityLog();
    const calls: string[] = [];
    let snapshotReads = 0;
    try {
      await expect(
        executeGovernedMutation(
          BRANCH_CREATE,
          { required: false },
          workspaceInfo(fixture.managedWorktreePath),
          {
            evidenceStore: cap.store,
            redactor: buildRedactor({}),
            ...managedAccessDeps(fixture, () => undefined),
          },
          {
            policyPacks: { repoPack: ALLOW_LOCAL },
            activityLog: activity.sink,
            adapterFactory: () => recordingMutationAdapter(calls),
            snapshotReader: (): Promise<GitWorktreeSnapshot> => {
              snapshotReads += 1;
              return Promise.resolve(MANAGED_SNAPSHOT);
            },
          },
          "request-correlation-entry",
        ),
      ).rejects.toBeInstanceOf(GitDeliveryRootAuthorityRevokedError);

      // Not one process: the snapshot read is itself a multi-command git spawn.
      expect(snapshotReads).toBe(0);
      expect(calls).toEqual([]);
      expect(cap.count()).toBe(0);
      expect(activity.events.some((e) => e.op === "git.delivery.dispatch.no-spawn")).toBe(true);
    } finally {
      fixture.dispose();
    }
  });
});

// ── #3382: a governed COMMIT restamps the managed workspace's verified head ─────────────────────
//
// `lastVerifiedHead` is the baseline `classifyWorkspaceReconciliation` measures `head-moved`
// against, and until this restamp existed nothing wrote it outside a healthy reconciliation pass.
// Every governed commit inside a managed task worktree therefore moved HEAD away from that
// baseline, the next pass persisted `head-moved` — whose recovery was a strategy `repair.ts`
// executes for no marker — and `productionRuntimeWorkspaceAuthority` refused the workspace for
// every further run. The restamp is scoped to exactly what Keiko KNOWS it did: a commit, that
// succeeded, inside a root the managed prover still admits.

const COMMIT = { kind: "commit", message: "governed commit", allowEmpty: true } as const;

interface RestampCall {
  readonly managedWorktreePath: string;
  readonly correlationId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

function managedDepsWithRestamp(
  fixture: ManagedWorktreeFixture,
  calls: RestampCall[],
): ReturnType<typeof managedAccessDeps> & {
  readonly workspaceProvisioning: {
    readonly recordVerifiedHead: (input: RestampCall) => Promise<boolean>;
  };
} {
  const base = managedAccessDeps(fixture, () => fixture.instance);
  return {
    ...base,
    workspaceProvisioning: {
      ...base.workspaceProvisioning,
      recordVerifiedHead: (input: RestampCall): Promise<boolean> => {
        calls.push(input);
        return Promise.resolve(true);
      },
    },
  };
}

describe("executeGovernedMutation — verified-head restamp (#3382)", () => {
  it("records the managed workspace's verified head after a successful commit", async () => {
    const fixture = createManagedWorktreeFixture("task-3382-commit");
    const cap = captureStore();
    const calls: RestampCall[] = [];
    try {
      const result = await executeGovernedMutation(
        COMMIT,
        { required: false },
        workspaceInfo(fixture.managedWorktreePath),
        {
          evidenceStore: cap.store,
          redactor: buildRedactor({}),
          ...managedDepsWithRestamp(fixture, calls),
        },
        {
          policyPacks: { repoPack: ALLOW_LOCAL },
          adapterFactory: () => recordingMutationAdapter([]),
          snapshotReader: (): Promise<GitWorktreeSnapshot> => Promise.resolve(MANAGED_SNAPSHOT),
        },
        "request-correlation-restamp",
      );

      expect(result.outcome.status).toBe("succeeded");
      // Exactly one call, carrying the canonical worktree root and the request's own correlation id
      // — matched field-by-field rather than by whole-object equality, so the deadline signal the
      // input now also carries does not make this pin about the input's shape.
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        managedWorktreePath: fixture.managedWorktreePath,
        correlationId: "request-correlation-restamp",
      });
      // The port is handed a LIVE deadline signal: the restamp completed inside its bound, so
      // nothing abandoned it and the write it made was legitimate.
      expect(calls[0]?.signal?.aborted).toBe(false);
    } finally {
      fixture.dispose();
    }
  });

  it("records nothing for a mutation that does not move HEAD", async () => {
    const fixture = createManagedWorktreeFixture("task-3382-branch");
    const cap = captureStore();
    const calls: RestampCall[] = [];
    try {
      const result = await executeGovernedMutation(
        BRANCH_CREATE,
        { required: false },
        workspaceInfo(fixture.managedWorktreePath),
        {
          evidenceStore: cap.store,
          redactor: buildRedactor({}),
          ...managedDepsWithRestamp(fixture, calls),
        },
        {
          policyPacks: { repoPack: ALLOW_LOCAL },
          adapterFactory: () => recordingMutationAdapter([]),
          snapshotReader: (): Promise<GitWorktreeSnapshot> => Promise.resolve(MANAGED_SNAPSHOT),
        },
        "request-correlation-branch",
      );

      expect(result.outcome.status).toBe("succeeded");
      expect(calls).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it("records nothing when the commit did not succeed", async () => {
    const fixture = createManagedWorktreeFixture("task-3382-failed");
    const cap = captureStore();
    const calls: RestampCall[] = [];
    try {
      const result = await executeGovernedMutation(
        COMMIT,
        { required: false },
        workspaceInfo(fixture.managedWorktreePath),
        {
          evidenceStore: cap.store,
          redactor: buildRedactor({}),
          ...managedDepsWithRestamp(fixture, calls),
        },
        {
          policyPacks: { repoPack: ALLOW_LOCAL },
          adapterFactory: (): GitLocalMutationAdapter => ({
            ...recordingMutationAdapter([]),
            commit: (): Promise<GitDeliveryExecutionResult> =>
              Promise.resolve({
                schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
                outcome: "failed",
                durationMs: 1,
                errorCode: "precondition-failed",
              }),
          }),
          snapshotReader: (): Promise<GitWorktreeSnapshot> => Promise.resolve(MANAGED_SNAPSHOT),
        },
        "request-correlation-failed-commit",
      );

      expect(result.outcome.status).not.toBe("succeeded");
      expect(calls).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  // An ordinary registered project is not a managed task worktree, so it has no row to restamp and
  // the prover is never even consulted for it.
  // CodeRabbit, PR #3381: the restamp is documented best-effort, but the `await` was unguarded, so a
  // port that rejects turned a COMMITTED, already-evidenced mutation into a rejected call — the
  // caller's route then answered 409 GIT_DELIVERY_COMMIT_WORKTREE_UNAVAILABLE for a commit that is in
  // the operator's history. The rejection is contained at this seam and reported instead.
  it("keeps a rejecting restamp port from failing a commit that already succeeded", async () => {
    const fixture = createManagedWorktreeFixture("task-3382-restamp-rejects");
    const cap = captureStore();
    const activity = captureActivityLog();
    try {
      const base = managedAccessDeps(fixture, () => fixture.instance);
      const result = await executeGovernedMutation(
        COMMIT,
        { required: false },
        workspaceInfo(fixture.managedWorktreePath),
        {
          evidenceStore: cap.store,
          redactor: buildRedactor({}),
          ...base,
          workspaceProvisioning: {
            ...base.workspaceProvisioning,
            recordVerifiedHead: (): Promise<boolean> =>
              Promise.reject(new Error("restamp port exploded")),
          },
        },
        {
          policyPacks: { repoPack: ALLOW_LOCAL },
          activityLog: activity.sink,
          adapterFactory: () => recordingMutationAdapter([]),
          snapshotReader: (): Promise<GitWorktreeSnapshot> => Promise.resolve(MANAGED_SNAPSHOT),
        },
        "request-correlation-restamp-rejects",
      );

      // The commit's own result is untouched, and its evidence line still says `succeeded`.
      expect(result.outcome.status).toBe("succeeded");
      expect(
        activity.events.find((e) => e.op === "git.delivery.mutation.completed")?.extra?.status,
      ).toBe("succeeded");

      // Exactly one classified line for the failed restamp — not silent, and body-free.
      const failures = activity.events.filter((e) => e.op === "task-workspace.lifecycle");
      expect(failures).toHaveLength(1);
      expect(failures[0]?.errorKind).toBe("REPOSITORY_UNREACHABLE");
      expect(failures[0]?.correlationId).toBe("request-correlation-restamp-rejects");
      expect(failures[0]?.extra?.operation).toBe("verify-head");
      expect(failures[0]?.extra?.workspaceIdentity).toMatch(/^wsref_[0-9a-f]{24}$/u);
      expect(JSON.stringify(activity.events)).not.toContain(fixture.managedWorktreePath);
    } finally {
      fixture.dispose();
    }
  });

  // CodeRabbit, PR #3381: the previous guard caught a REJECTION but not a promise that never
  // settles. The port serializes on the workspace's `ws:` key and that wait cannot be cancelled, so
  // a wedged holder left this `await` pending forever — and it runs AFTER the commit and its
  // lifecycle evidence are durable, so the client hung on a commit that had already succeeded. The
  // deadline is injected in milliseconds here; in production it is
  // VERIFIED_HEAD_RESTAMP_DEADLINE_MS.
  it("completes a successful commit when the restamp port never settles", async () => {
    const fixture = createManagedWorktreeFixture("task-3382-restamp-hangs");
    const cap = captureStore();
    const activity = captureActivityLog();
    let observedSignal: AbortSignal | undefined;
    try {
      const base = managedAccessDeps(fixture, () => fixture.instance);
      const result = await executeGovernedMutation(
        COMMIT,
        { required: false },
        workspaceInfo(fixture.managedWorktreePath),
        {
          evidenceStore: cap.store,
          redactor: buildRedactor({}),
          ...base,
          workspaceProvisioning: {
            ...base.workspaceProvisioning,
            // Never settles — exactly what a wedged `ws:` holder produces.
            recordVerifiedHead: (input): Promise<boolean> => {
              observedSignal = input.signal;
              return new Promise<boolean>(() => undefined);
            },
          },
        },
        {
          policyPacks: { repoPack: ALLOW_LOCAL },
          activityLog: activity.sink,
          adapterFactory: () => recordingMutationAdapter([]),
          snapshotReader: (): Promise<GitWorktreeSnapshot> => Promise.resolve(MANAGED_SNAPSHOT),
          verifiedHeadRestampDeadlineMs: 5,
        },
        "request-correlation-restamp-hangs",
      );

      // The commit's own result is untouched and the call RETURNED — that is the whole finding.
      expect(result.outcome.status).toBe("succeeded");
      expect(
        activity.events.find((e) => e.op === "git.delivery.mutation.completed")?.extra?.status,
      ).toBe("succeeded");

      // Exactly one classified line for the expiry, body-free, under this request's correlation id.
      const failures = activity.events.filter((e) => e.op === "task-workspace.lifecycle");
      expect(failures).toHaveLength(1);
      expect(failures[0]?.errorKind).toBe("LOCK_CONTENTION");
      expect(failures[0]?.correlationId).toBe("request-correlation-restamp-hangs");
      expect(failures[0]?.extra?.operation).toBe("verify-head");
      expect(JSON.stringify(activity.events)).not.toContain(fixture.managedWorktreePath);

      // The port was handed the deadline's signal and it is aborted, so the abandoned attempt can
      // never persist a head after the request it belonged to has been answered.
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it("records nothing for an ordinary registered project", async () => {
    const cap = captureStore();
    const calls: RestampCall[] = [];
    const result = await executeGovernedMutation(
      COMMIT,
      { required: false },
      workspaceInfo(root),
      {
        evidenceStore: cap.store,
        redactor: buildRedactor({}),
        workspaceProvisioning: {
          getInstance: (): undefined => undefined,
          provision: (): Promise<never> => Promise.reject(new Error("not used")),
          activate: (): Promise<never> => Promise.reject(new Error("not used")),
          recordVerifiedHead: (input: RestampCall): Promise<boolean> => {
            calls.push(input);
            return Promise.resolve(true);
          },
        },
      },
      {
        policyPacks: { repoPack: ALLOW_LOCAL },
        adapterFactory: () => recordingMutationAdapter([]),
        snapshotReader: (): Promise<GitWorktreeSnapshot> => Promise.resolve(MANAGED_SNAPSHOT),
      },
      "request-correlation-ordinary",
    );

    expect(result.outcome.status).toBe("succeeded");
    expect(calls).toEqual([]);
  });
});
