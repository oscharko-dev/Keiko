// Integration coverage for the #447 controlled repair service (Issue #447, Epic #443). Exercises the
// real worktree adapter + provisioning re-materialization against disposable git repositories and
// proves: deterministic repair of recoverable states (AC3) — recreate a missing worktree, re-link a
// moved gitdir, release a stale lock, mark abandoned — the operator-approval gate (the #444 `repair`
// operation requires it), the "require manual intervention where needed" path (no mutation), and the
// negative gates (not applicable, lock contention, unknown workspace, invalid strategy).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createNodeGitWorktreeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { GitWorktreeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type {
  WorkspaceInfo,
  WorkspaceInstance,
  WorkspaceRecoveryStrategy,
} from "@oscharko-dev/keiko-contracts";
import { runMigrations } from "../store/schema.js";
import { buildWorkspaceInstanceStoreOverDatabase, type WorkspaceInstanceStore } from "./store.js";
import {
  buildActiveWorkspacePointerStoreOverDatabase,
  type ActiveWorkspacePointerStore,
} from "./active-store.js";
import { createWorkspaceProvisioningService } from "./provisioning.js";
import { createWorkspaceRepairService } from "./repair.js";
import { TaskWorkspaceError, type TaskWorkspaceErrorCode } from "./errors.js";
import type { WorkspaceProvisioningService, WorkspaceRepairService } from "./types.js";

let repoRoot: string;
let managedRoot: string;
let db: DatabaseSync;
let store: WorkspaceInstanceStore;
let pointerStore: ActiveWorkspacePointerStore;
let evidence: { id: string; json: string }[];
let idCounter: number;
let nowMs: number;
let provisioning: WorkspaceProvisioningService;

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

function realAdapter(workspace: WorkspaceInfo): GitWorktreeAdapter {
  return createNodeGitWorktreeAdapter({ workspace, processEnv: { PATH: process.env.PATH ?? "" } });
}

function repairService(): WorkspaceRepairService {
  return createWorkspaceRepairService({
    store,
    activePointerStore: pointerStore,
    evidenceStore: capturingEvidence(),
    provisioning,
    managedRoot,
    createAdapter: realAdapter,
    redactString: (s: string): string => s,
    now: (): number => nowMs,
    newId: (): string => `id-${String(idCounter++)}`,
  });
}

async function provisionTask(taskId: string): Promise<WorkspaceInstance> {
  const result = await provisioning.provision({
    repositoryRequestPath: repoRoot,
    taskId,
    baseBranch: "main",
    requestedBy: "u",
  });
  return result.instance;
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

function repair(
  workspaceId: string,
  strategy: WorkspaceRecoveryStrategy,
  operatorApproved: boolean,
  requestedBy = "u",
): Promise<ReturnType<WorkspaceRepairService["repair"]> extends Promise<infer R> ? R : never> {
  return repairService().repair({ workspaceId, requestedBy, strategy, operatorApproved });
}

beforeEach(() => {
  repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-repair-repo-")));
  managedRoot = join(
    realpathSync(mkdtempSync(join(tmpdir(), "keiko-repair-mr-"))),
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
  pointerStore = buildActiveWorkspacePointerStoreOverDatabase(db);
  evidence = [];
  idCounter = 0;
  nowMs = 1_700_000_000_000;
  provisioning = createWorkspaceProvisioningService({
    store,
    evidenceStore: capturingEvidence(),
    managedRoot,
    createAdapter: realAdapter,
    redactString: (s: string): string => s,
    now: (): number => nowMs,
    newId: (): string => `id-${String(idCounter++)}`,
  });
});

afterEach(() => {
  db.close();
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(managedRoot, { recursive: true, force: true });
});

describe("recreate-worktree (AC3: retry provisioning)", () => {
  it("rebuilds a missing managed worktree from the existing branch", async () => {
    const instance = await provisionTask("t1");
    rmSync(instance.managedWorktreePath, { recursive: true, force: true });
    const result = await repair(instance.workspaceId, "recreate-worktree", true);
    expect(result.applied).toBe(true);
    expect(result.outcome).toBe("repaired");
    expect(result.status).toBe("healthy");
    expect(existsSync(instance.managedWorktreePath)).toBe(true);
    expect(store.getById(instance.workspaceId)?.lifecycleState).toBe("active");
    expect(evidence.some((e) => e.json.includes('"operation": "repair"'))).toBe(true);
  });
});

describe("reconcile-pointer (relink known managed worktree)", () => {
  it("refreshes a mismatched gitdir identity back to healthy", async () => {
    const instance = await provisionTask("t1");
    store.upsert({ ...instance, gitdirIdentity: "0000000000000000deadbeefdeadbeef" });
    const result = await repair(instance.workspaceId, "reconcile-pointer", true);
    expect(result.applied).toBe(true);
    expect(result.status).toBe("healthy");
    const persisted = store.getById(instance.workspaceId);
    expect(persisted?.gitdirIdentity).not.toBe("0000000000000000deadbeefdeadbeef");
    expect(persisted?.health).toBe("healthy");
  });
});

describe("release-stale-lock (clear stale lock)", () => {
  it("clears an expired lock and returns to healthy", async () => {
    const instance = await provisionTask("t1");
    store.upsert({
      ...instance,
      lock: {
        lockId: "stale",
        owner: "u",
        reason: "mutation",
        acquiredAt: new Date(nowMs - 3_600_000).toISOString(),
        expiresAt: new Date(nowMs - 1_800_000).toISOString(),
      },
    });
    const result = await repair(instance.workspaceId, "release-stale-lock", true);
    expect(result.applied).toBe(true);
    expect(result.status).toBe("healthy");
    expect(store.getById(instance.workspaceId)?.lock).toBeNull();
    expect(store.getById(instance.workspaceId)?.driftMarkers).not.toContain("lock-stale");
  });
});

describe("abandon-and-cleanup (mark abandoned)", () => {
  it("transitions a recovery-required workspace to abandoned and clears the active pointer", async () => {
    const instance = await provisionTask("t1");
    rmSync(instance.managedWorktreePath, { recursive: true, force: true });
    pointerStore.set({
      workspaceId: instance.workspaceId,
      setBy: "u",
      atIso: "2026-01-01T00:00:00Z",
    });
    const result = await repair(instance.workspaceId, "abandon-and-cleanup", true);
    expect(result.applied).toBe(true);
    expect(store.getById(instance.workspaceId)?.lifecycleState).toBe("abandoned");
    expect(pointerStore.get()).toBeUndefined();
  });
});

describe("operator-approval gate (#444 repair operation)", () => {
  it("refuses an automatic repair without operator approval", async () => {
    const instance = await provisionTask("t1");
    rmSync(instance.managedWorktreePath, { recursive: true, force: true });
    await rejectsWithCode(
      () => repair(instance.workspaceId, "recreate-worktree", false),
      "OPERATOR_APPROVAL_REQUIRED",
    );
    // no mutation happened: still recovery-required, worktree still absent
    expect(store.getById(instance.workspaceId)?.lifecycleState).toBe("recovery-required");
    expect(existsSync(instance.managedWorktreePath)).toBe(false);
  });
});

describe("require manual intervention where needed", () => {
  it("returns operator-required (no mutation) for an operator-guided strategy", async () => {
    const instance = await provisionTask("t1");
    // branch mismatch -> drifted (branch-deleted) -> reattach-branch is operator-guided
    store.upsert({ ...instance, taskBranch: "keiko/task/ghost-00000000" });
    const result = await repair(instance.workspaceId, "reattach-branch", true);
    expect(result.applied).toBe(false);
    expect(result.outcome).toBe("operator-required");
    expect(result.operatorActionRequired).toBe(true);
  });

  it("returns operator-required for a corrupt git pointer (no safe auto-repair)", async () => {
    const instance = await provisionTask("t1");
    writeFileSync(join(instance.managedWorktreePath, ".git"), "garbage\n");
    const result = await repair(instance.workspaceId, "operator-repair", true);
    expect(result.applied).toBe(false);
    expect(result.outcome).toBe("operator-required");
  });
});

describe("negative gates", () => {
  it("rejects a strategy not applicable to a healthy workspace", async () => {
    const instance = await provisionTask("t1");
    await rejectsWithCode(
      () => repair(instance.workspaceId, "recreate-worktree", true),
      "REPAIR_NOT_APPLICABLE",
    );
  });

  it("rejects when another actor holds a live lock", async () => {
    const instance = await provisionTask("t1");
    rmSync(instance.managedWorktreePath, { recursive: true, force: true });
    store.upsert({
      ...instance,
      lock: {
        lockId: "live",
        owner: "someone-else",
        reason: "repair",
        acquiredAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + 600_000).toISOString(),
      },
    });
    await rejectsWithCode(
      () => repair(instance.workspaceId, "recreate-worktree", true, "u"),
      "LOCK_CONTENTION",
    );
  });

  it("rejects an unknown workspace", async () => {
    await rejectsWithCode(
      () => repair("ws_unknown", "recreate-worktree", true),
      "WORKSPACE_NOT_FOUND",
    );
  });

  it("rejects an invalid recovery strategy", async () => {
    const instance = await provisionTask("t1");
    await rejectsWithCode(
      () =>
        repairService().repair({
          workspaceId: instance.workspaceId,
          requestedBy: "u",
          strategy: "not-a-strategy" as WorkspaceRecoveryStrategy,
          operatorApproved: true,
        }),
      "INVALID_REQUEST",
    );
  });
});
