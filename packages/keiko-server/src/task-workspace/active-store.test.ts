// Coverage for the singleton active-workspace pointer store (Issue #446). Proves the single-row
// invariant, round-trip of the pointer fields, set-as-upsert, and idempotent clear.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
import { runMigrations } from "../store/schema.js";
import { buildWorkspaceInstanceStoreOverDatabase } from "./store.js";
import {
  buildActiveWorkspacePointerStoreOverDatabase,
  type ActiveWorkspacePointerStore,
} from "./active-store.js";

let db: DatabaseSync;
let store: ActiveWorkspacePointerStore;

// node:sqlite enforces foreign_keys by default, so the pointer must reference a real instance row.
function seedInstance(workspaceId: string, taskId: string): void {
  const instance: WorkspaceInstance = {
    schemaVersion: "1",
    workspaceId,
    taskId,
    repositoryId: "repo_aaaaaaaaaaaaaaaa",
    repositoryRoot: "/repo",
    baseBranch: "main",
    taskBranch: `keiko/task/${taskId}`,
    managedWorktreePath: `/managed/${workspaceId}`,
    gitdirIdentity: "gitdir-hash",
    lifecycleState: "active",
    health: "healthy",
    lock: null,
    createdAt: "2026-06-26T00:00:00.000Z",
    updatedAt: "2026-06-26T00:00:00.000Z",
    driftMarkers: [],
    recoveryHints: [],
    auditCorrelationId: workspaceId,
  };
  buildWorkspaceInstanceStoreOverDatabase(db).upsert(instance);
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  runMigrations(db);
  store = buildActiveWorkspacePointerStoreOverDatabase(db);
  seedInstance("ws-1", "task-1");
  seedInstance("ws-2", "task-2");
});

afterEach(() => {
  db.close();
});

describe("active-workspace pointer store", () => {
  it("starts empty (unbound mode)", () => {
    expect(store.get()).toBeUndefined();
  });

  it("sets and reads the pointer back", () => {
    const pointer = store.set({
      workspaceId: "ws-1",
      setBy: "op",
      atIso: "2026-06-26T00:00:00.000Z",
    });
    expect(pointer).toEqual({
      workspaceId: "ws-1",
      setBy: "op",
      setAt: "2026-06-26T00:00:00.000Z",
      updatedAt: "2026-06-26T00:00:00.000Z",
    });
    expect(store.get()).toEqual(pointer);
  });

  it("keeps a single row across re-sets (the latest workspace wins)", () => {
    store.set({ workspaceId: "ws-1", setBy: "op", atIso: "2026-06-26T00:00:00.000Z" });
    store.set({ workspaceId: "ws-2", setBy: "op", atIso: "2026-06-26T00:01:00.000Z" });
    const row = db.prepare("SELECT COUNT(*) AS n FROM task_workspace_active_pointer").get() as {
      n: number;
    };
    expect(row.n).toBe(1);
    expect(store.get()?.workspaceId).toBe("ws-2");
  });

  it("clears the pointer → unbound mode, and clear is idempotent", () => {
    store.set({ workspaceId: "ws-1", setBy: "op", atIso: "2026-06-26T00:00:00.000Z" });
    store.clear();
    expect(store.get()).toBeUndefined();
    expect(() => store.clear()).not.toThrow();
    expect(store.get()).toBeUndefined();
  });

  it("enforces the singleton id via the CHECK constraint", () => {
    // ws-1 satisfies the foreign key, so the throw is the singleton CHECK (id must be 'active').
    expect(() =>
      db
        .prepare(
          "INSERT INTO task_workspace_active_pointer (id, workspace_id, set_by, set_at, updated_at) VALUES ('other', 'ws-1', 'op', 'x', 'x')",
        )
        .run(),
    ).toThrow();
  });
});
