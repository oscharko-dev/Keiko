// Integration + security coverage for the #448 governed cleanup service (Issue #448, Epic #443).
// Exercises the real worktree adapter against disposable git repositories and the real provisioning
// service to materialize genuine managed worktrees, then proves: request → complete of an owned,
// archived, clean workspace removes the worktree + deletes the row + clears the pointer (AC4); the live
// safety gate REFUSES (never throws) a dirty / locked / unowned / path-escaping cleanup (SC2/SC4); the
// approval + eligibility gates; orphan detection + governed removal; the audit trail is content-free
// (SC3); and the safelyRemoveManagedPath choke point refuses every out-of-root / symlink-escape /
// unowned / non-leaf target (SC1). No generic git runner; the single governed spawn boundary throughout.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createNodeGitWorktreeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { GitWorktreeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type {
  TaskWorkspaceLifecycleState,
  WorkspaceInfo,
  WorkspaceInstance,
  WorkspaceLock,
} from "@oscharko-dev/keiko-contracts";
import { runMigrations } from "../store/schema.js";
import { buildWorkspaceInstanceStoreOverDatabase, type WorkspaceInstanceStore } from "./store.js";
import {
  buildActiveWorkspacePointerStoreOverDatabase,
  type ActiveWorkspacePointerStore,
} from "./active-store.js";
import { MANAGED_ROOT_MARKER_FILENAME } from "./naming.js";
import { createWorkspaceProvisioningService } from "./provisioning.js";
import { createWorkspaceCleanupService, safelyRemoveManagedPath } from "./cleanup.js";
import { TaskWorkspaceError } from "./errors.js";
import type { WorkspaceCleanupService, WorkspaceProvisioningService } from "./types.js";
import { createWorkspaceMutexRegistry } from "./mutex.js";

const __twMutex = createWorkspaceMutexRegistry();

let repoRoot: string;
let managedRoot: string;
let outsideDir: string;
let db: DatabaseSync;
let store: WorkspaceInstanceStore;
let pointerStore: ActiveWorkspacePointerStore;
let evidence: { id: string; json: string }[];
let idCounter: number;
let nowMs: number;

function git(args: readonly string[], cwd = repoRoot): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

function parseEvent(json: string): { operation?: string; outcome?: string } {
  return JSON.parse(json) as { operation?: string; outcome?: string };
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

function provisioning(): WorkspaceProvisioningService {
  return createWorkspaceProvisioningService({
    store,
    evidenceStore: capturingEvidence(),
    managedRoot,
    createAdapter: realAdapter,
    redactString: (s: string): string => s,
    now: (): number => nowMs,
    newId: (): string => `id-${String(idCounter++)}`,
    mutex: __twMutex,
  });
}

function cleanup(): WorkspaceCleanupService {
  return createWorkspaceCleanupService({
    store,
    activePointerStore: pointerStore,
    evidenceStore: capturingEvidence(),
    managedRoot,
    createAdapter: realAdapter,
    redactString: (s: string): string => s,
    now: (): number => nowMs,
    newId: (): string => `id-${String(idCounter++)}`,
    mutex: __twMutex,
  });
}

async function provisionTask(taskId: string): Promise<WorkspaceInstance> {
  const result = await provisioning().provision({
    repositoryRequestPath: repoRoot,
    taskId,
    baseBranch: "main",
    requestedBy: "u",
  });
  return result.instance;
}

function setState(
  instance: WorkspaceInstance,
  lifecycleState: TaskWorkspaceLifecycleState,
  extra: Partial<WorkspaceInstance> = {},
): WorkspaceInstance {
  return store.upsert({ ...instance, lifecycleState, ...extra });
}

beforeEach(() => {
  repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-clean-repo-")));
  managedRoot = join(
    realpathSync(mkdtempSync(join(tmpdir(), "keiko-clean-mr-"))),
    "task-workspaces",
  );
  outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-clean-outside-")));
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
});

afterEach(() => {
  db.close();
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(managedRoot, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

describe("governed cleanup happy path (AC4)", () => {
  it("request → complete removes the worktree, deletes the row, and clears the active pointer", async () => {
    const instance = await provisionTask("t-archive");
    expect(existsSync(instance.managedWorktreePath)).toBe(true);
    pointerStore.set({
      workspaceId: instance.workspaceId,
      setBy: "u",
      atIso: "2026-06-26T00:00:00Z",
    });
    setState(instance, "archived");

    const requested = await cleanup().cleanup({
      workspaceId: instance.workspaceId,
      requestedBy: "u",
      operatorApproved: true,
      mode: "request",
    });
    expect(requested.outcome).toBe("requested");
    expect(store.getById(instance.workspaceId)?.lifecycleState).toBe("cleanup-pending");

    const completed = await cleanup().cleanup({
      workspaceId: instance.workspaceId,
      requestedBy: "u",
      operatorApproved: true,
      mode: "complete",
    });
    expect(completed.outcome).toBe("completed");
    expect(existsSync(instance.managedWorktreePath)).toBe(false);
    expect(store.getById(instance.workspaceId)).toBeUndefined();
    expect(pointerStore.get()).toBeUndefined();

    // Audit trail is content-free: cleanup events carry no path / repo root (SC3).
    const cleanupEvents = evidence.filter((e) => parseEvent(e.json).operation === "cleanup");
    const outcomes = cleanupEvents.map((e) => parseEvent(e.json).outcome);
    expect(outcomes).toContain("cleanup-requested");
    expect(outcomes).toContain("cleanup-completed");
    for (const e of cleanupEvents) {
      expect(e.json).not.toContain(managedRoot);
      expect(e.json).not.toContain(repoRoot);
    }
  });

  it("is idempotent on a second request (already cleanup-pending)", async () => {
    const instance = await provisionTask("t-idem");
    setState(instance, "cleanup-pending");
    const result = await cleanup().cleanup({
      workspaceId: instance.workspaceId,
      requestedBy: "u",
      operatorApproved: true,
      mode: "request",
    });
    expect(result.outcome).toBe("requested");
    expect(store.getById(instance.workspaceId)?.lifecycleState).toBe("cleanup-pending");
  });
});

describe("cleanup safety refusals (SC4 — refusal is a successful outcome, never an error)", () => {
  it("refuses a dirty worktree and leaves it on disk", async () => {
    const instance = await provisionTask("t-dirty");
    writeFileSync(join(instance.managedWorktreePath, "wip.txt"), "uncommitted\n");
    setState(instance, "cleanup-pending");
    const result = await cleanup().cleanup({
      workspaceId: instance.workspaceId,
      requestedBy: "u",
      operatorApproved: true,
      mode: "complete",
    });
    expect(result.outcome).toBe("refused");
    expect(result.refusalReason).toBe("worktree-dirty");
    expect(existsSync(instance.managedWorktreePath)).toBe(true);
    expect(store.getById(instance.workspaceId)).toBeDefined();
    const refusals = evidence.filter((e) => parseEvent(e.json).outcome === "cleanup-refused");
    expect(refusals.length).toBeGreaterThan(0);
    // The refusal audit event is content-free too (SC3).
    for (const e of refusals) {
      expect(e.json).not.toContain(managedRoot);
      expect(e.json).not.toContain(repoRoot);
    }
  });

  it("fails closed: a corrupt .git pointer over uncommitted work is treated as dirty, not force-deleted", async () => {
    const instance = await provisionTask("t-corrupt");
    writeFileSync(join(instance.managedWorktreePath, "wip.txt"), "uncommitted work\n");
    // Corrupt the worktree's `.git` pointer so `git status` exits non-zero (inconclusive probe). The
    // directory + the WIP file remain on disk; the destructive path must NOT treat this as clean.
    writeFileSync(join(instance.managedWorktreePath, ".git"), "not a valid gitdir pointer\n");
    setState(instance, "cleanup-pending");
    const result = await cleanup().cleanup({
      workspaceId: instance.workspaceId,
      requestedBy: "u",
      operatorApproved: true,
      mode: "complete",
    });
    expect(result.outcome).toBe("refused");
    expect(result.refusalReason).toBe("worktree-dirty");
    expect(existsSync(join(instance.managedWorktreePath, "wip.txt"))).toBe(true);
    expect(store.getById(instance.workspaceId)).toBeDefined();
  });

  it("proceeds when only a STALE (expired) lock is present (stale lock does not block cleanup)", async () => {
    const instance = await provisionTask("t-stale-lock");
    const expiredLock: WorkspaceLock = {
      lockId: "L0",
      owner: "u",
      reason: "mutation",
      acquiredAt: new Date(nowMs - 600_000).toISOString(),
      expiresAt: new Date(nowMs - 60_000).toISOString(),
    };
    setState(instance, "cleanup-pending", { lock: expiredLock });
    const result = await cleanup().cleanup({
      workspaceId: instance.workspaceId,
      requestedBy: "u",
      operatorApproved: true,
      mode: "complete",
    });
    expect(result.outcome).toBe("completed");
    expect(existsSync(instance.managedWorktreePath)).toBe(false);
    expect(store.getById(instance.workspaceId)).toBeUndefined();
  });

  it("refuses when a live lock is held (even by the requesting actor)", async () => {
    const instance = await provisionTask("t-locked");
    const lock: WorkspaceLock = {
      lockId: "L1",
      owner: "u",
      reason: "mutation",
      acquiredAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + 60_000).toISOString(),
    };
    setState(instance, "cleanup-pending", { lock });
    const result = await cleanup().cleanup({
      workspaceId: instance.workspaceId,
      requestedBy: "u",
      operatorApproved: true,
      mode: "complete",
    });
    expect(result.outcome).toBe("refused");
    expect(result.refusalReason).toBe("lock-live");
    expect(existsSync(instance.managedWorktreePath)).toBe(true);
  });

  it("refuses when the managed-root ownership marker is absent (ownership-unproven)", async () => {
    const instance = await provisionTask("t-unowned");
    setState(instance, "cleanup-pending");
    rmSync(join(managedRoot, MANAGED_ROOT_MARKER_FILENAME));
    const result = await cleanup().cleanup({
      workspaceId: instance.workspaceId,
      requestedBy: "u",
      operatorApproved: true,
      mode: "complete",
    });
    expect(result.outcome).toBe("refused");
    expect(result.refusalReason).toBe("ownership-unproven");
    expect(existsSync(instance.managedWorktreePath)).toBe(true);
  });

  it("refuses a persisted path that escapes the managed root and never deletes it (SC1/SC2)", async () => {
    const instance = await provisionTask("t-escape");
    const escapeTarget = join(outsideDir, "precious");
    mkdirSync(escapeTarget, { recursive: true });
    writeFileSync(join(escapeTarget, "keep.txt"), "do not delete\n");
    // Manipulate the persisted path to point OUTSIDE the managed root; the live containment check must
    // catch it rather than trusting the stored value.
    setState(instance, "cleanup-pending", { managedWorktreePath: escapeTarget });
    const result = await cleanup().cleanup({
      workspaceId: instance.workspaceId,
      requestedBy: "u",
      operatorApproved: true,
      mode: "complete",
    });
    expect(result.outcome).toBe("refused");
    expect(result.refusalReason).toBe("path-escape");
    expect(existsSync(join(escapeTarget, "keep.txt"))).toBe(true);
  });
});

describe("cleanup approval + eligibility gates", () => {
  it("rejects request-cleanup of a non-eligible (active) workspace", async () => {
    const instance = await provisionTask("t-active");
    await expect(
      cleanup().cleanup({
        workspaceId: instance.workspaceId,
        requestedBy: "u",
        operatorApproved: true,
        mode: "request",
      }),
    ).rejects.toMatchObject({ code: "CLEANUP_NOT_ELIGIBLE" });
  });

  it("rejects request without operator approval", async () => {
    const instance = await provisionTask("t-noapprove");
    setState(instance, "archived");
    await expect(
      cleanup().cleanup({
        workspaceId: instance.workspaceId,
        requestedBy: "u",
        operatorApproved: false,
        mode: "request",
      }),
    ).rejects.toBeInstanceOf(TaskWorkspaceError);
  });

  it("rejects complete without operator approval", async () => {
    const instance = await provisionTask("t-noapprove2");
    setState(instance, "cleanup-pending");
    await expect(
      cleanup().cleanup({
        workspaceId: instance.workspaceId,
        requestedBy: "u",
        operatorApproved: false,
        mode: "complete",
      }),
    ).rejects.toMatchObject({ code: "OPERATOR_APPROVAL_REQUIRED" });
  });

  it("rejects complete on a workspace that was never requested for cleanup", async () => {
    const instance = await provisionTask("t-notpending");
    setState(instance, "archived");
    await expect(
      cleanup().cleanup({
        workspaceId: instance.workspaceId,
        requestedBy: "u",
        operatorApproved: true,
        mode: "complete",
      }),
    ).rejects.toMatchObject({ code: "CLEANUP_NOT_ELIGIBLE" });
  });

  it("rejects complete under a foreign live lock with LOCK_CONTENTION", async () => {
    const instance = await provisionTask("t-foreign");
    const lock: WorkspaceLock = {
      lockId: "L2",
      owner: "other",
      reason: "mutation",
      acquiredAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + 60_000).toISOString(),
    };
    setState(instance, "cleanup-pending", { lock });
    await expect(
      cleanup().cleanup({
        workspaceId: instance.workspaceId,
        requestedBy: "u",
        operatorApproved: true,
        mode: "complete",
      }),
    ).rejects.toMatchObject({ code: "LOCK_CONTENTION" });
  });
});

describe("orphan cleanup", () => {
  it("removes an orphaned managed worktree (directory with no persisted record)", async () => {
    const instance = await provisionTask("t-orphan");
    const orphanPath = instance.managedWorktreePath;
    store.delete(instance.workspaceId); // leave the directory behind → orphan
    expect(existsSync(orphanPath)).toBe(true);
    const result = await cleanup().cleanupOrphans({ requestedBy: "u", operatorApproved: true });
    expect(result.removed).toBe(1);
    expect(result.refused).toEqual([]);
    expect(existsSync(orphanPath)).toBe(false);
    // Orphan cleanup events are content-free too (SC3): a hash orphan id, no path / repo root.
    const orphanEvents = evidence.filter((e) => parseEvent(e.json).outcome === "cleanup-completed");
    expect(orphanEvents.length).toBeGreaterThan(0);
    for (const e of orphanEvents) {
      expect(e.json).not.toContain(managedRoot);
      expect(e.json).not.toContain(orphanPath);
    }
  });

  it("refuses a dirty orphan and leaves it on disk", async () => {
    const instance = await provisionTask("t-orphan-dirty");
    const orphanPath = instance.managedWorktreePath;
    writeFileSync(join(orphanPath, "wip.txt"), "uncommitted\n");
    store.delete(instance.workspaceId);
    const result = await cleanup().cleanupOrphans({
      repositoryRoot: repoRoot,
      requestedBy: "u",
      operatorApproved: true,
    });
    expect(result.removed).toBe(0);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]?.refusalReason).toBe("worktree-dirty");
    expect(existsSync(orphanPath)).toBe(true);
  });

  it("does not treat a persisted instance's worktree as an orphan", async () => {
    const instance = await provisionTask("t-keep");
    const result = await cleanup().cleanupOrphans({
      repositoryRoot: repoRoot,
      requestedBy: "u",
      operatorApproved: true,
    });
    expect(result.removed).toBe(0);
    expect(existsSync(instance.managedWorktreePath)).toBe(true);
  });

  it("rejects orphan cleanup without operator approval", async () => {
    await expect(
      cleanup().cleanupOrphans({ requestedBy: "u", operatorApproved: false }),
    ).rejects.toMatchObject({ code: "OPERATOR_APPROVAL_REQUIRED" });
  });
});

describe("safelyRemoveManagedPath choke point (SC1 — the only filesystem deletion)", () => {
  beforeEach(() => {
    // Establish ownership of the managed root for the positive case.
    mkdirSync(managedRoot, { recursive: true });
    writeFileSync(join(managedRoot, MANAGED_ROOT_MARKER_FILENAME), "{}");
  });

  it("removes a contained <repoId>/<leaf> directory", () => {
    const leaf = join(managedRoot, "repo_aaaa", "ws_bbbb");
    mkdirSync(leaf, { recursive: true });
    safelyRemoveManagedPath(managedRoot, leaf);
    expect(existsSync(leaf)).toBe(false);
  });

  it("refuses and never deletes a target outside the managed root", () => {
    const target = join(outsideDir, "victim");
    mkdirSync(target, { recursive: true });
    expect(() => {
      safelyRemoveManagedPath(managedRoot, target);
    }).toThrow(TaskWorkspaceError);
    expect(existsSync(target)).toBe(true);
  });

  it("refuses a symlink that escapes the managed root and never deletes the real target", () => {
    const realTarget = join(outsideDir, "real-secret");
    mkdirSync(realTarget, { recursive: true });
    const link = join(managedRoot, "repo_cccc", "escape");
    mkdirSync(join(managedRoot, "repo_cccc"), { recursive: true });
    symlinkSync(realTarget, link);
    expect(() => {
      safelyRemoveManagedPath(managedRoot, link);
    }).toThrow(TaskWorkspaceError);
    expect(existsSync(realTarget)).toBe(true);
  });

  it("refuses to remove the managed root itself or a bare repository-id directory (non-leaf)", () => {
    expect(() => {
      safelyRemoveManagedPath(managedRoot, managedRoot);
    }).toThrow(TaskWorkspaceError);
    const repoDir = join(managedRoot, "repo_dddd");
    mkdirSync(repoDir, { recursive: true });
    expect(() => {
      safelyRemoveManagedPath(managedRoot, repoDir);
    }).toThrow(TaskWorkspaceError);
    expect(existsSync(repoDir)).toBe(true);
  });

  it("refuses when ownership cannot be proven (marker absent)", () => {
    rmSync(join(managedRoot, MANAGED_ROOT_MARKER_FILENAME));
    const leaf = join(managedRoot, "repo_eeee", "ws_ffff");
    mkdirSync(leaf, { recursive: true });
    expect(() => {
      safelyRemoveManagedPath(managedRoot, leaf);
    }).toThrow(TaskWorkspaceError);
    expect(existsSync(leaf)).toBe(true);
  });
});
