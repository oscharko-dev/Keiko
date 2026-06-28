// Coverage for the #446 active-binding lifecycle service. Proves the atomic switch (setActive sets the
// derived-binding pointer), pause (clears the pointer + walks active→paused), resume (paused→active +
// re-binds), handoff (clean-only, pointer untouched), the legal-transition gate, lock contention, the
// dangling-pointer self-heal, and list-by-repository — all over the real stores + a fake #445
// provisioning service so the lifecycle walk delegation is exercised without real git worktrees.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
import { runMigrations } from "../store/schema.js";
import { buildWorkspaceInstanceStoreOverDatabase, type WorkspaceInstanceStore } from "./store.js";
import {
  buildActiveWorkspacePointerStoreOverDatabase,
  type ActiveWorkspacePointerStore,
} from "./active-store.js";
import { buildBinding } from "./binding.js";
import { deriveRepositoryId } from "./naming.js";
import { createWorkspaceLifecycleService } from "./lifecycle.js";
import { TaskWorkspaceError, type TaskWorkspaceErrorCode } from "./errors.js";
import type {
  WorkspaceActivateResult,
  WorkspaceLifecycleService,
  WorkspaceProvisioningService,
} from "./types.js";
import { createWorkspaceMutexRegistry } from "./mutex.js";

const __twMutex = createWorkspaceMutexRegistry();

const REPO_ROOT = "/repo";
const REPO_ID = deriveRepositoryId(REPO_ROOT);

let db: DatabaseSync;
let managedRoot: string;
let store: WorkspaceInstanceStore;
let pointerStore: ActiveWorkspacePointerStore;
let evidence: { id: string; json: string }[];
let service: WorkspaceLifecycleService;
let idCounter: number;

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

function instance(taskId: string, overrides: Partial<WorkspaceInstance> = {}): WorkspaceInstance {
  const workspaceId = `ws_${taskId.padEnd(24, "x").slice(0, 24)}`;
  const managedWorktreePath = join(managedRoot, REPO_ID, workspaceId);
  mkdirSync(managedWorktreePath, { recursive: true });
  return {
    schemaVersion: "1",
    workspaceId,
    taskId,
    repositoryId: REPO_ID,
    repositoryRoot: REPO_ROOT,
    baseBranch: "main",
    taskBranch: `keiko/task/${taskId}`,
    managedWorktreePath,
    gitdirIdentity: "gitdir-hash",
    lifecycleState: "active",
    health: "healthy",
    lock: null,
    createdAt: "2026-06-26T00:00:00.000Z",
    updatedAt: "2026-06-26T00:00:00.000Z",
    driftMarkers: [],
    recoveryHints: [],
    auditCorrelationId: workspaceId,
    ...overrides,
  };
}

// A fake #445 provisioning service: activate reads the instance, walks it to `active`, and persists —
// the same contract the lifecycle service delegates the switch/resume walk to.
function fakeProvisioning(): WorkspaceProvisioningService {
  return {
    provision: () => Promise.reject(new Error("provision not used in lifecycle tests")),
    activate: ({ workspaceId }): Promise<WorkspaceActivateResult> => {
      const inst = store.getById(workspaceId);
      if (inst === undefined) {
        return Promise.reject(new TaskWorkspaceError("WORKSPACE_NOT_FOUND", "not found"));
      }
      const next = store.upsert({
        ...inst,
        lifecycleState: "active",
        updatedAt: "2026-06-26T01:00:00.000Z",
      });
      return Promise.resolve({ instance: next, binding: buildBinding(next) });
    },
    getInstance: (id) => store.getById(id),
  };
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

beforeEach(() => {
  managedRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-lifecycle-managed-")));
  db = new DatabaseSync(":memory:");
  runMigrations(db);
  store = buildWorkspaceInstanceStoreOverDatabase(db);
  pointerStore = buildActiveWorkspacePointerStoreOverDatabase(db);
  evidence = [];
  idCounter = 0;
  service = createWorkspaceLifecycleService({
    store,
    activePointerStore: pointerStore,
    managedRoot,
    provisioning: fakeProvisioning(),
    evidenceStore: capturingEvidence(),
    redactString: (s: string): string => s,
    now: (): number => 1_700_000_000_000,
    newId: (): string => `id-${String(idCounter++)}`,
    mutex: __twMutex,
  });
});

afterEach(() => {
  db.close();
  rmSync(managedRoot, { recursive: true, force: true });
});

describe("getActive / list", () => {
  it("returns undefined in unbound mode", () => {
    expect(service.getActive()).toBeUndefined();
  });

  it("lists the persisted instances for a repository root", () => {
    store.upsert(instance("a"));
    store.upsert(instance("b"));
    expect(service.list(REPO_ROOT)).toHaveLength(2);
    expect(service.list("/other")).toHaveLength(0);
  });

  it("rejects an empty repository root", () => {
    expect(() => service.list("")).toThrow(TaskWorkspaceError);
  });

  it("self-heals a dangling pointer (instance gone) to unbound mode", () => {
    const inst = store.upsert(instance("a"));
    pointerStore.set({
      workspaceId: inst.workspaceId,
      setBy: "op",
      atIso: "2026-06-26T00:00:00.000Z",
    });
    store.delete(inst.workspaceId);
    expect(service.getActive()).toBeUndefined();
    expect(pointerStore.get()).toBeUndefined();
  });

  it("self-heals an active pointer whose persisted path no longer contains to the managed root", () => {
    const inst = store.upsert(instance("a"));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "keiko-lifecycle-escape-")));
    try {
      store.upsert({ ...inst, managedWorktreePath: outside });
      pointerStore.set({
        workspaceId: inst.workspaceId,
        setBy: "op",
        atIso: "2026-06-26T00:00:00.000Z",
      });
      expect(service.getActive()).toBeUndefined();
      expect(pointerStore.get()).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("setActive (atomic switch)", () => {
  it("activates the target and records it as the active pointer", async () => {
    const inst = store.upsert(instance("a", { lifecycleState: "paused" }));
    const view = await service.setActive({
      workspaceId: inst.workspaceId,
      requestedBy: "op",
      acquireLock: false,
    });
    expect(view.instance.lifecycleState).toBe("active");
    expect(view.binding.activeRoot).toBe(inst.managedWorktreePath);
    expect(pointerStore.get()?.workspaceId).toBe(inst.workspaceId);
    expect(service.getActive()?.binding.activeRoot).toBe(inst.managedWorktreePath);
  });

  it("switching to a different workspace re-points atomically", async () => {
    const a = store.upsert(instance("a"));
    const b = store.upsert(instance("b"));
    await service.setActive({ workspaceId: a.workspaceId, requestedBy: "op", acquireLock: false });
    await service.setActive({ workspaceId: b.workspaceId, requestedBy: "op", acquireLock: false });
    expect(service.getActive()?.instance.workspaceId).toBe(b.workspaceId);
  });

  it("rejects an unknown workspace via the delegated activation", async () => {
    await rejectsWithCode(
      () => service.setActive({ workspaceId: "ws-missing", requestedBy: "op", acquireLock: false }),
      "WORKSPACE_NOT_FOUND",
    );
  });

  // #449/#1587 follow-up: requestedBy is persisted as the active-pointer setBy, so a control/bidi
  // code point is rejected before the pointer is ever bound.
  it("rejects a bidi-override requestedBy and leaves the pointer unbound", async () => {
    const inst = store.upsert(instance("a", { lifecycleState: "paused" }));
    await rejectsWithCode(
      () =>
        service.setActive({
          workspaceId: inst.workspaceId,
          requestedBy: `op${String.fromCodePoint(0x202e)}`,
          acquireLock: false,
        }),
      "INVALID_REQUEST",
    );
    expect(pointerStore.get()).toBeUndefined();
  });
});

describe("pause", () => {
  it("walks active→paused and clears the pointer when it was active", async () => {
    const inst = store.upsert(instance("a"));
    await service.setActive({
      workspaceId: inst.workspaceId,
      requestedBy: "op",
      acquireLock: false,
    });
    const result = await service.pause({ workspaceId: inst.workspaceId, requestedBy: "op" });
    expect(result.instance.lifecycleState).toBe("paused");
    expect(pointerStore.get()).toBeUndefined();
    expect(evidence.some((e) => e.json.includes('"paused"'))).toBe(true);
  });

  it("leaves the active pointer untouched when pausing a DIFFERENT (non-active) workspace", async () => {
    const a = store.upsert(instance("a"));
    const b = store.upsert(instance("b"));
    await service.setActive({ workspaceId: a.workspaceId, requestedBy: "op", acquireLock: false });
    const result = await service.pause({ workspaceId: b.workspaceId, requestedBy: "op" });
    expect(result.instance.lifecycleState).toBe("paused");
    // A stays the active workspace — pausing B must not clear A's pointer.
    expect(pointerStore.get()?.workspaceId).toBe(a.workspaceId);
  });

  it("rejects an illegal transition (cannot pause an archived workspace)", async () => {
    const inst = store.upsert(instance("a", { lifecycleState: "archived" }));
    await rejectsWithCode(
      () => service.pause({ workspaceId: inst.workspaceId, requestedBy: "op" }),
      "ILLEGAL_TRANSITION",
    );
  });

  it("rejects when another actor holds a live lock", async () => {
    const inst = store.upsert(
      instance("a", {
        lock: {
          lockId: "l1",
          owner: "someone-else",
          reason: "mutation",
          acquiredAt: new Date(1_700_000_000_000).toISOString(),
          expiresAt: new Date(1_700_000_000_000 + 600_000).toISOString(),
        },
      }),
    );
    await rejectsWithCode(
      () => service.pause({ workspaceId: inst.workspaceId, requestedBy: "op" }),
      "LOCK_CONTENTION",
    );
  });

  it("rejects an unknown workspace", async () => {
    await rejectsWithCode(
      () => service.pause({ workspaceId: "ws-missing", requestedBy: "op" }),
      "WORKSPACE_NOT_FOUND",
    );
  });
});

describe("resume", () => {
  it("walks paused→active and re-binds the pointer", async () => {
    const inst = store.upsert(instance("a", { lifecycleState: "paused" }));
    const result = await service.resume({ workspaceId: inst.workspaceId, requestedBy: "op" });
    expect(result.instance.lifecycleState).toBe("active");
    expect(pointerStore.get()?.workspaceId).toBe(inst.workspaceId);
  });

  it("walks handoff-ready→active and re-binds the pointer", async () => {
    const inst = store.upsert(instance("a", { lifecycleState: "handoff-ready" }));
    const result = await service.resume({ workspaceId: inst.workspaceId, requestedBy: "op" });
    expect(result.instance.lifecycleState).toBe("active");
    expect(pointerStore.get()?.workspaceId).toBe(inst.workspaceId);
  });
});

describe("prepareHandoff", () => {
  it("walks active→handoff-ready on a clean worktree and leaves the pointer untouched", async () => {
    const inst = store.upsert(instance("a"));
    await service.setActive({
      workspaceId: inst.workspaceId,
      requestedBy: "op",
      acquireLock: false,
    });
    const result = await service.prepareHandoff({
      workspaceId: inst.workspaceId,
      requestedBy: "op",
    });
    expect(result.instance.lifecycleState).toBe("handoff-ready");
    // handoff does not clear the active pointer (the workspace stays the active context).
    expect(pointerStore.get()?.workspaceId).toBe(inst.workspaceId);
  });

  it("rejects handoff when the worktree is dirty (uncommitted changes)", async () => {
    const inst = store.upsert(instance("a", { driftMarkers: ["uncommitted-changes"] }));
    await rejectsWithCode(
      () => service.prepareHandoff({ workspaceId: inst.workspaceId, requestedBy: "op" }),
      "ILLEGAL_TRANSITION",
    );
  });
});

describe("clearActive", () => {
  it("clears the pointer → unbound mode", async () => {
    const inst = store.upsert(instance("a"));
    await service.setActive({
      workspaceId: inst.workspaceId,
      requestedBy: "op",
      acquireLock: false,
    });
    service.clearActive();
    expect(service.getActive()).toBeUndefined();
  });
});
