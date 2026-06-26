// Integration coverage for the managed task-workspace provisioning + activation service (Issue #445).
// Exercises the real worktree adapter against disposable git repositories and proves every Acceptance
// Criterion and the enumerated negative paths: success (AC1), reject unsafe/unmanaged/conflict (AC2),
// idempotent safe retry (AC3), durable bindable instance (AC4), and the visible classified failure
// states (SC4). The single governed spawn boundary is reused throughout; no generic git runner.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createNodeGitWorktreeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type {
  GitWorktreeAdapter,
  WorktreeOperationResult,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { WorkspaceInfo, WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
import { runMigrations } from "../store/schema.js";
import { buildWorkspaceInstanceStoreOverDatabase, type WorkspaceInstanceStore } from "./store.js";
import { createWorkspaceProvisioningService } from "./provisioning.js";
import type { WorkspaceProvisioningService } from "./types.js";
import { TaskWorkspaceError, type TaskWorkspaceErrorCode } from "./errors.js";
import {
  deriveManagedWorktreePath,
  deriveRepositoryId,
  deriveTaskBranchName,
  deriveWorkspaceId,
} from "./naming.js";

const FIXED_NOW = 1_700_000_000_000;

let repoRoot: string;
let managedRoot: string;
let db: DatabaseSync;
let store: WorkspaceInstanceStore;
let evidence: { id: string; json: string }[];
let idCounter: number;

function git(args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: repoRoot, encoding: "utf8" });
}

function capturingEvidence(): EvidenceStore {
  return {
    put: (id: string, json: string): string => {
      evidence.push({ id, json });
      return `/evidence/${id}.json`;
    },
    list: (): readonly string[] => [],
    get: (): string | undefined => undefined,
    delete: (): void => undefined,
  };
}

function makeService(
  adapterFactory?: (workspace: WorkspaceInfo) => GitWorktreeAdapter,
): WorkspaceProvisioningService {
  return createWorkspaceProvisioningService({
    store,
    evidenceStore: capturingEvidence(),
    managedRoot,
    createAdapter:
      adapterFactory ??
      ((workspace: WorkspaceInfo): GitWorktreeAdapter =>
        createNodeGitWorktreeAdapter({ workspace, processEnv: { PATH: process.env.PATH ?? "" } })),
    redactString: (s: string): string => s,
    now: (): number => FIXED_NOW,
    newId: (): string => `id-${String(idCounter++)}`,
  });
}

async function rejectsWithCode(
  thunk: () => Promise<unknown>,
  code: TaskWorkspaceErrorCode,
): Promise<void> {
  let caught: unknown;
  try {
    await thunk();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TaskWorkspaceError);
  expect((caught as TaskWorkspaceError).code).toBe(code);
}

function validInstance(taskId: string, overrides: Partial<WorkspaceInstance>): WorkspaceInstance {
  const repositoryId = deriveRepositoryId(repoRoot);
  const workspaceId = deriveWorkspaceId({ repositoryId, taskId });
  return {
    schemaVersion: "1",
    workspaceId,
    taskId,
    repositoryId,
    repositoryRoot: repoRoot,
    baseBranch: "main",
    taskBranch: deriveTaskBranchName({ taskId }),
    managedWorktreePath: deriveManagedWorktreePath({ managedRoot, repositoryId, workspaceId }),
    gitdirIdentity: "seed-identity",
    lifecycleState: "provisioning",
    health: "unknown",
    lock: null,
    createdAt: new Date(FIXED_NOW).toISOString(),
    updatedAt: new Date(FIXED_NOW).toISOString(),
    driftMarkers: [],
    recoveryHints: [],
    auditCorrelationId: workspaceId,
    ...overrides,
  };
}

beforeEach(() => {
  repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-prov-repo-")));
  managedRoot = join(
    realpathSync(mkdtempSync(join(tmpdir(), "keiko-prov-mr-"))),
    "task-workspaces",
  );
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@keiko.example"]);
  git(["config", "user.name", "Keiko Test"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repoRoot, "README.md"), "# demo\n");
  git(["add", "README.md"]);
  git(["commit", "-q", "-m", "initial"]);
  db = new DatabaseSync(":memory:");
  runMigrations(db);
  store = buildWorkspaceInstanceStoreOverDatabase(db);
  evidence = [];
  idCounter = 0;
});

afterEach(() => {
  db.close();
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(managedRoot, { recursive: true, force: true });
});

describe("provision success (AC1, AC4)", () => {
  it("creates a task branch + managed worktree, persists an active bindable instance", async () => {
    const service = makeService();
    const result = await service.provision({
      repositoryRequestPath: repoRoot,
      taskId: "t1",
      baseBranch: "main",
      requestedBy: "u",
    });
    expect(result.created).toBe(true);
    expect(result.instance.lifecycleState).toBe("active");
    expect(result.instance.health).toBe("healthy");
    expect(result.instance.repositoryRoot).toBe(repoRoot);
    expect(result.instance.taskBranch.startsWith("keiko/task/")).toBe(true);
    expect(result.instance.managedWorktreePath.startsWith(managedRoot)).toBe(true);
    expect(existsSync(result.instance.managedWorktreePath)).toBe(true);
    expect(git(["branch", "--list", result.instance.taskBranch])).toContain(
      result.instance.taskBranch,
    );

    // AC4: durable + bindable (gitDeliveryRoot === activeRoot === editorProjectRoot).
    expect(store.getById(result.instance.workspaceId)).toEqual(result.instance);
    expect(result.binding.activeRoot).toBe(result.instance.managedWorktreePath);
    expect(result.binding.gitDeliveryRoot).toBe(result.binding.activeRoot);
    expect(result.binding.editorProjectRoot).toBe(result.binding.activeRoot);
    expect(evidence.length).toBeGreaterThan(0);
  });
});

describe("idempotent safe retry (AC3)", () => {
  it("a second provision for the same task resumes without duplicating", async () => {
    const service = makeService();
    const first = await service.provision({
      repositoryRequestPath: repoRoot,
      taskId: "t1",
      baseBranch: "main",
      requestedBy: "u",
    });
    const second = await service.provision({
      repositoryRequestPath: repoRoot,
      taskId: "t1",
      baseBranch: "main",
      requestedBy: "u",
    });
    expect(second.created).toBe(false);
    expect(second.instance.workspaceId).toBe(first.instance.workspaceId);
    expect(store.listByRepository(first.instance.repositoryId)).toHaveLength(1);
  });
});

describe("pre-write rejections (AC2)", () => {
  it("rejects an invalid base branch", async () => {
    const service = makeService();
    await rejectsWithCode(
      () =>
        service.provision({
          repositoryRequestPath: repoRoot,
          taskId: "t1",
          baseBranch: "nonexistent-base",
          requestedBy: "u",
        }),
      "INVALID_BASE_BRANCH",
    );
  });

  it("rejects a path that is not a git repository", async () => {
    const service = makeService();
    const notRepo = realpathSync(mkdtempSync(join(tmpdir(), "keiko-notrepo-")));
    try {
      await rejectsWithCode(
        () =>
          service.provision({
            repositoryRequestPath: notRepo,
            taskId: "t1",
            baseBranch: "main",
            requestedBy: "u",
          }),
        "MISSING_REPOSITORY",
      );
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });

  it("rejects a conflicting pre-existing unmanaged branch", async () => {
    const branch = deriveTaskBranchName({ taskId: "conflict" });
    git(["branch", branch, "main"]);
    const service = makeService();
    await rejectsWithCode(
      () =>
        service.provision({
          repositoryRequestPath: repoRoot,
          taskId: "conflict",
          baseBranch: "main",
          requestedBy: "u",
        }),
      "BRANCH_CONFLICT",
    );
  });

  it("rejects an existing unmanaged worktree directory", async () => {
    const repositoryId = deriveRepositoryId(repoRoot);
    const workspaceId = deriveWorkspaceId({ repositoryId, taskId: "unmanaged" });
    mkdirSync(deriveManagedWorktreePath({ managedRoot, repositoryId, workspaceId }), {
      recursive: true,
    });
    const service = makeService();
    await rejectsWithCode(
      () =>
        service.provision({
          repositoryRequestPath: repoRoot,
          taskId: "unmanaged",
          baseBranch: "main",
          requestedBy: "u",
        }),
      "EXISTING_UNMANAGED_PATH",
    );
  });

  it("rejects when another actor holds a live provisioning lock", async () => {
    store.upsert(
      validInstance("locked", {
        lifecycleState: "provisioning",
        lock: {
          lockId: "other-lock",
          owner: "other",
          reason: "provisioning",
          acquiredAt: new Date(FIXED_NOW).toISOString(),
          expiresAt: new Date(FIXED_NOW + 60_000).toISOString(),
        },
      }),
    );
    const service = makeService();
    await rejectsWithCode(
      () =>
        service.provision({
          repositoryRequestPath: repoRoot,
          taskId: "locked",
          baseBranch: "main",
          requestedBy: "u",
        }),
      "LOCK_CONTENTION",
    );
  });
});

describe("drift + partial failure leave a visible classified state (SC4)", () => {
  it("flags recovery-required when the managed worktree has vanished (stale pointer)", async () => {
    const service = makeService();
    const created = await service.provision({
      repositoryRequestPath: repoRoot,
      taskId: "drift",
      baseBranch: "main",
      requestedBy: "u",
    });
    rmSync(created.instance.managedWorktreePath, { recursive: true, force: true });
    await rejectsWithCode(
      () =>
        service.provision({
          repositoryRequestPath: repoRoot,
          taskId: "drift",
          baseBranch: "main",
          requestedBy: "u",
        }),
      "POINTER_DRIFT",
    );
    const after = store.getById(created.instance.workspaceId);
    expect(after?.lifecycleState).toBe("recovery-required");
    expect(after?.driftMarkers).toContain("worktree-missing");
  });

  it("persists a visible failed state when the worktree mutation fails", async () => {
    const failingAdapter = (workspace: WorkspaceInfo): GitWorktreeAdapter => {
      const ok: WorktreeOperationResult = {
        ok: true,
        exitCode: 0,
        durationMs: 0,
        timedOut: false,
        truncated: false,
      };
      const fail: WorktreeOperationResult = {
        ok: false,
        exitCode: 128,
        durationMs: 0,
        timedOut: false,
        truncated: false,
      };
      return {
        resolveRepositoryRoot: (): Promise<string | undefined> => Promise.resolve(workspace.root),
        refResolves: (): Promise<boolean> => Promise.resolve(true),
        localBranchExists: (): Promise<boolean> => Promise.resolve(false),
        listWorktrees: (): Promise<readonly never[]> => Promise.resolve([]),
        addWorktree: (): Promise<WorktreeOperationResult> => Promise.resolve(fail),
        addWorktreeForExistingBranch: (): Promise<WorktreeOperationResult> => Promise.resolve(fail),
        removeWorktree: (): Promise<WorktreeOperationResult> => Promise.resolve(ok),
        pruneWorktrees: (): Promise<WorktreeOperationResult> => Promise.resolve(ok),
      };
    };
    const service = makeService(failingAdapter);
    await rejectsWithCode(
      () =>
        service.provision({
          repositoryRequestPath: repoRoot,
          taskId: "fail",
          baseBranch: "main",
          requestedBy: "u",
        }),
      "PROVISIONING_FAILED",
    );
    const repositoryId = deriveRepositoryId(repoRoot);
    const failed = store.getById(deriveWorkspaceId({ repositoryId, taskId: "fail" }));
    expect(failed?.lifecycleState).toBe("failed");
    expect(failed?.lock).toBeNull();
  });
});

describe("activate", () => {
  it("activates an active workspace and yields its binding", async () => {
    const service = makeService();
    const provisioned = await service.provision({
      repositoryRequestPath: repoRoot,
      taskId: "act",
      baseBranch: "main",
      requestedBy: "u",
    });
    const activated = await service.activate({
      workspaceId: provisioned.instance.workspaceId,
      taskId: "act",
      requestedBy: "u",
      acquireLock: false,
    });
    expect(activated.instance.lifecycleState).toBe("active");
    expect(activated.binding.activeRoot).toBe(provisioned.instance.managedWorktreePath);
  });

  it("rejects activation of an unknown workspace", async () => {
    const service = makeService();
    await rejectsWithCode(
      () =>
        service.activate({
          workspaceId: "ws_unknown",
          taskId: "x",
          requestedBy: "u",
          acquireLock: false,
        }),
      "WORKSPACE_NOT_FOUND",
    );
  });

  it("rejects activation when the expected lifecycle state no longer matches", async () => {
    const service = makeService();
    const provisioned = await service.provision({
      repositoryRequestPath: repoRoot,
      taskId: "act2",
      baseBranch: "main",
      requestedBy: "u",
    });
    await rejectsWithCode(
      () =>
        service.activate({
          workspaceId: provisioned.instance.workspaceId,
          taskId: "act2",
          requestedBy: "u",
          acquireLock: false,
          expectedLifecycleState: "paused",
        }),
      "LOCK_CONTENTION",
    );
  });
});
