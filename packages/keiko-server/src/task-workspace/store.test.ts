// Coverage for the durable WorkspaceInstanceStore (Issue #445). Proves round-trip persistence, the
// content-free validation gate on write/read, and the (repository_id, task_id) idempotency invariant
// enforced at the DB layer (AC3, AC4).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
import { runMigrations } from "../store/schema.js";
import { buildWorkspaceInstanceStoreOverDatabase, type WorkspaceInstanceStore } from "./store.js";

let db: DatabaseSync;
let store: WorkspaceInstanceStore;

function instance(overrides: Partial<WorkspaceInstance> = {}): WorkspaceInstance {
  return {
    schemaVersion: "1",
    workspaceId: "ws_aaaaaaaaaaaaaaaaaaaaaaaa",
    taskId: "task-1",
    repositoryId: "repo_aaaaaaaaaaaaaaaa",
    repositoryRoot: "/repo",
    baseBranch: "main",
    taskBranch: "keiko/task/task-1-abcd1234",
    managedWorktreePath: "/m/repo_aaaaaaaaaaaaaaaa/ws_aaaaaaaaaaaaaaaaaaaaaaaa",
    gitdirIdentity: "gitdir-identity-hash",
    lifecycleState: "active",
    health: "healthy",
    lock: null,
    createdAt: "2026-06-26T00:00:00.000Z",
    updatedAt: "2026-06-26T00:00:00.000Z",
    driftMarkers: [],
    recoveryHints: [],
    auditCorrelationId: "corr-1",
    ...overrides,
  };
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  runMigrations(db);
  store = buildWorkspaceInstanceStoreOverDatabase(db);
});

afterEach(() => {
  db.close();
});

describe("round-trip", () => {
  it("upserts and reads an instance back by id, repo+task, and repository", () => {
    const created = store.upsert(instance());
    expect(created).toEqual(instance());
    expect(store.getById("ws_aaaaaaaaaaaaaaaaaaaaaaaa")).toEqual(instance());
    expect(store.findByRepositoryAndTask("repo_aaaaaaaaaaaaaaaa", "task-1")).toEqual(instance());
    expect(store.listByRepository("repo_aaaaaaaaaaaaaaaa")).toHaveLength(1);
  });

  it("round-trips a lock, drift markers, and recovery hints", () => {
    const withState = instance({
      lock: {
        lockId: "lock-1",
        owner: "u",
        reason: "provisioning",
        acquiredAt: "2026-06-26T00:00:00.000Z",
      },
      driftMarkers: ["worktree-missing", "pointer-stale"],
      recoveryHints: [
        {
          marker: "worktree-missing",
          strategy: "recreate-worktree",
          operatorActionRequired: false,
        },
      ],
    });
    store.upsert(withState);
    expect(store.getById(withState.workspaceId)).toEqual(withState);
  });

  it("updates in place on conflicting workspaceId and keeps a single row", () => {
    store.upsert(instance());
    store.upsert(instance({ lifecycleState: "paused", health: "degraded" }));
    expect(store.getById("ws_aaaaaaaaaaaaaaaaaaaaaaaa")?.lifecycleState).toBe("paused");
    expect(store.listByRepository("repo_aaaaaaaaaaaaaaaa")).toHaveLength(1);
  });

  it("deletes an instance", () => {
    store.upsert(instance());
    store.delete("ws_aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(store.getById("ws_aaaaaaaaaaaaaaaaaaaaaaaa")).toBeUndefined();
  });

  it("lists every instance across repositories for startup reconciliation (#447)", () => {
    store.upsert(instance());
    store.upsert(
      instance({
        workspaceId: "ws_bbbbbbbbbbbbbbbbbbbbbbbb",
        taskId: "task-2",
        repositoryId: "repo_bbbbbbbbbbbbbbbb",
        managedWorktreePath: "/m/repo_bbbbbbbbbbbbbbbb/ws_bbbbbbbbbbbbbbbbbbbbbbbb",
      }),
    );
    const all = store.listAll();
    expect(all).toHaveLength(2);
    expect(all.map((row) => row.workspaceId).sort()).toEqual([
      "ws_aaaaaaaaaaaaaaaaaaaaaaaa",
      "ws_bbbbbbbbbbbbbbbbbbbbbbbb",
    ]);
  });

  it("returns an empty list when there are no instances", () => {
    expect(store.listAll()).toEqual([]);
  });
});

describe("invariants", () => {
  it("rejects a second instance with the same (repositoryId, taskId) but a different workspaceId", () => {
    store.upsert(instance());
    expect(() => store.upsert(instance({ workspaceId: "ws_bbbbbbbbbbbbbbbbbbbbbbbb" }))).toThrow();
    expect(store.listByRepository("repo_aaaaaaaaaaaaaaaa")).toHaveLength(1);
  });

  it("refuses to persist an invalid instance (bad lifecycle state)", () => {
    expect(() =>
      store.upsert(instance({ lifecycleState: "bogus" as WorkspaceInstance["lifecycleState"] })),
    ).toThrow();
  });

  it("refuses to persist an instance carrying a smuggled extra key (content-free, SC3)", () => {
    const smuggled = {
      ...instance(),
      sourceDiff: "secret-content",
    } as unknown as WorkspaceInstance;
    expect(() => store.upsert(smuggled)).toThrow();
  });
});
