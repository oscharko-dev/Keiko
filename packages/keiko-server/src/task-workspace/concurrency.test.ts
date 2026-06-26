// Concurrency / race coverage for the managed task-workspace services (Issue #449, ADR-0093 D1).
//
// AC1: "Concurrent or repeated workspace mutations cannot silently corrupt managed workspace state."
// Before #449 every mutating flow was optimistic check-then-write: two concurrent provision() calls for
// the same (repo, task) both passed the gates and both raced `git worktree add`. These tests drive the
// REAL worktree adapter against disposable git repositories and prove the in-process mutex serializes
// same-resource mutations: exactly one worktree/row results, disjoint resources still run in parallel,
// and concurrent activate/pause/cleanup never leave a torn or duplicated state.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createNodeGitWorktreeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-contracts";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { runMigrations } from "../store/schema.js";
import { buildWorkspaceInstanceStoreOverDatabase, type WorkspaceInstanceStore } from "./store.js";
import {
  buildActiveWorkspacePointerStoreOverDatabase,
  type ActiveWorkspacePointerStore,
} from "./active-store.js";
import { createWorkspaceMutexRegistry, type WorkspaceMutexRegistry } from "./mutex.js";
import { createWorkspaceProvisioningService } from "./provisioning.js";
import { createWorkspaceLifecycleService } from "./lifecycle.js";
import { createWorkspaceCleanupService } from "./cleanup.js";
import { deriveRepositoryId } from "./naming.js";
import { TaskWorkspaceError } from "./errors.js";
import type {
  WorkspaceCleanupService,
  WorkspaceLifecycleService,
  WorkspaceProvisioningService,
} from "./types.js";

let repoRoot: string;
let managedRoot: string;
let db: DatabaseSync;
let store: WorkspaceInstanceStore;
let pointerStore: ActiveWorkspacePointerStore;
let mutex: WorkspaceMutexRegistry;
let provisioning: WorkspaceProvisioningService;
let lifecycle: WorkspaceLifecycleService;
let cleanup: WorkspaceCleanupService;
let idCounter: number;

function git(args: readonly string[]): void {
  execFileSync("git", [...args], { cwd: repoRoot });
}

function noopEvidence(): EvidenceStore {
  return {
    put: (id: string): string => `/evidence/${id}.json`,
    list: (): readonly string[] => [],
    get: (): string | undefined => undefined,
    delete: (): void => undefined,
  };
}

function adapterFor(workspace: WorkspaceInfo): ReturnType<typeof createNodeGitWorktreeAdapter> {
  return createNodeGitWorktreeAdapter({ workspace, processEnv: { PATH: process.env.PATH ?? "" } });
}

function buildServices(): void {
  store = buildWorkspaceInstanceStoreOverDatabase(db);
  pointerStore = buildActiveWorkspacePointerStoreOverDatabase(db);
  mutex = createWorkspaceMutexRegistry();
  const common = {
    store,
    activePointerStore: pointerStore,
    evidenceStore: noopEvidence(),
    managedRoot,
    createAdapter: adapterFor,
    redactString: (s: string): string => s,
    now: (): number => Date.now(),
    newId: (): string => `id-${String(idCounter++)}`,
    mutex,
  };
  provisioning = createWorkspaceProvisioningService(common);
  lifecycle = createWorkspaceLifecycleService({ ...common, provisioning });
  cleanup = createWorkspaceCleanupService(common);
}

function provisionRequest(taskId: string): {
  repositoryRequestPath: string;
  taskId: string;
  baseBranch: string;
  requestedBy: string;
} {
  return { repositoryRequestPath: repoRoot, taskId, baseBranch: "main", requestedBy: "actor" };
}

beforeEach(() => {
  repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-conc-repo-")));
  managedRoot = join(
    realpathSync(mkdtempSync(join(tmpdir(), "keiko-conc-mr-"))),
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
  idCounter = 0;
  buildServices();
});

afterEach(() => {
  db.close();
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(managedRoot, { recursive: true, force: true });
});

describe("concurrent provision of the same (repo, task)", () => {
  it("serializes the race: exactly one worktree and one durable row result (AC1)", async () => {
    const results = await Promise.all([
      provisioning.provision(provisionRequest("t1")),
      provisioning.provision(provisionRequest("t1")),
    ]);
    // Both resolve to the SAME workspace — no duplicate row, no second worktree, no PROVISIONING_FAILED.
    const ids = new Set(results.map((r) => r.instance.workspaceId));
    expect(ids.size).toBe(1);
    // Exactly one call created the worktree; the serialized second call resumed it idempotently.
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const repositoryId = deriveRepositoryId(repoRoot);
    expect(store.listByRepository(repositoryId)).toHaveLength(1);
    const [instance] = store.listByRepository(repositoryId);
    expect(instance?.lifecycleState).toBe("active");
    expect(existsSync(instance?.managedWorktreePath ?? "")).toBe(true);
  });

  it("stays correct under a burst of repeated concurrent provisions (AC3)", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => provisioning.provision(provisionRequest("burst"))),
    );
    expect(new Set(results.map((r) => r.instance.workspaceId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(store.listByRepository(deriveRepositoryId(repoRoot))).toHaveLength(1);
  });
});

describe("concurrent provision of different tasks in the same repository", () => {
  it("does NOT over-serialize disjoint resources — both succeed with distinct worktrees", async () => {
    const [a, b] = await Promise.all([
      provisioning.provision(provisionRequest("alpha")),
      provisioning.provision(provisionRequest("beta")),
    ]);
    expect(a.instance.workspaceId).not.toBe(b.instance.workspaceId);
    expect(a.instance.managedWorktreePath).not.toBe(b.instance.managedWorktreePath);
    expect(existsSync(a.instance.managedWorktreePath)).toBe(true);
    expect(existsSync(b.instance.managedWorktreePath)).toBe(true);
    expect(store.listByRepository(deriveRepositoryId(repoRoot))).toHaveLength(2);
  });
});

describe("concurrent lifecycle mutations of one workspace", () => {
  it("serializes activate + pause without leaving a torn state", async () => {
    const provisioned = await provisioning.provision(provisionRequest("life"));
    const workspaceId = provisioned.instance.workspaceId;
    // Race a switch (activate + set pointer) against a pause. Each runs under the ws: key, so they
    // serialize; the outcome is a single legal terminal state, never a half-written row.
    const outcomes = await Promise.allSettled([
      lifecycle.setActive({ workspaceId, requestedBy: "actor", acquireLock: false }),
      lifecycle.pause({ workspaceId, requestedBy: "actor" }),
    ]);
    // At least one must succeed; any rejection is a CLASSIFIED TaskWorkspaceError, never a raw crash.
    expect(outcomes.some((o) => o.status === "fulfilled")).toBe(true);
    for (const o of outcomes) {
      if (o.status === "rejected") expect(o.reason).toBeInstanceOf(TaskWorkspaceError);
    }
    const final = store.getById(workspaceId);
    expect(final).toBeDefined();
    expect(["active", "paused"]).toContain(final?.lifecycleState);
  });
});

describe("concurrent complete-cleanup of one cleanup-pending workspace", () => {
  it("removes exactly once — the serialized second attempt is a classified no-op, not a double delete", async () => {
    const provisioned = await provisioning.provision(provisionRequest("gone"));
    const workspaceId = provisioned.instance.workspaceId;
    // Move the just-provisioned (clean) worktree to a settled, cleanup-eligible state, then request
    // cleanup so it is cleanup-pending before the concurrent complete-cleanup race.
    store.upsert({ ...provisioned.instance, lifecycleState: "archived" });
    await cleanup.cleanup({
      workspaceId,
      requestedBy: "actor",
      operatorApproved: true,
      mode: "request",
    });

    const attempts = await Promise.allSettled([
      cleanup.cleanup({
        workspaceId,
        requestedBy: "actor",
        operatorApproved: true,
        mode: "complete",
      }),
      cleanup.cleanup({
        workspaceId,
        requestedBy: "actor",
        operatorApproved: true,
        mode: "complete",
      }),
    ]);
    // The serialized pair: one completes the removal; the other finds the row gone and rejects with a
    // classified WORKSPACE_NOT_FOUND (never a crash, never a second physical delete of a live tree).
    const completed = attempts.filter(
      (a) => a.status === "fulfilled" && a.value.outcome === "completed",
    );
    expect(completed).toHaveLength(1);
    for (const a of attempts) {
      if (a.status === "rejected") expect(a.reason).toBeInstanceOf(TaskWorkspaceError);
    }
    expect(store.getById(workspaceId)).toBeUndefined();
  });
});
