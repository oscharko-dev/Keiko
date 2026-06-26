// Integration coverage for the #447 startup reconciliation service (Issue #447, Epic #443). Exercises
// the real worktree adapter against disposable git repositories and the real provisioning service to
// materialize genuine managed worktrees, then proves every Acceptance Criterion and the enumerated
// negative paths: restart restoration when safe (AC1), explicit recoverable/degraded states for
// missing/externally-changed workspaces (AC2), partial-provisioning classification (AC3), content-free
// persistence (AC4), and the negative cases the Issue lists — external deletion, stale/moved pointer,
// branch/head drift, partial provisioning, stale lock, ambiguous active binding, unmanaged-path
// collision. The single governed spawn boundary is reused throughout; no generic git runner.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createNodeGitWorktreeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { GitWorktreeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { WorkspaceInfo, WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
import { runMigrations } from "../store/schema.js";
import { buildWorkspaceInstanceStoreOverDatabase, type WorkspaceInstanceStore } from "./store.js";
import {
  buildActiveWorkspacePointerStoreOverDatabase,
  type ActiveWorkspacePointer,
  type ActiveWorkspacePointerStore,
} from "./active-store.js";
import { createWorkspaceProvisioningService } from "./provisioning.js";
import { createWorkspaceReconciliationService } from "./reconciliation.js";
import type { WorkspaceProvisioningService, WorkspaceReconciliationService } from "./types.js";

let repoRoot: string;
let managedRoot: string;
let db: DatabaseSync;
let store: WorkspaceInstanceStore;
let pointerStore: ActiveWorkspacePointerStore;
let evidence: { id: string; json: string }[];
let idCounter: number;
let nowMs: number;

function git(args: readonly string[], cwd = repoRoot): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
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
  });
}

function reconciliation(): WorkspaceReconciliationService {
  return createWorkspaceReconciliationService({
    store,
    activePointerStore: pointerStore,
    evidenceStore: capturingEvidence(),
    managedRoot,
    createAdapter: realAdapter,
    redactString: (s: string): string => s,
    now: (): number => nowMs,
    newId: (): string => `id-${String(idCounter++)}`,
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

beforeEach(() => {
  repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-recon-repo-")));
  managedRoot = join(
    realpathSync(mkdtempSync(join(tmpdir(), "keiko-recon-mr-"))),
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
});

afterEach(() => {
  db.close();
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(managedRoot, { recursive: true, force: true });
});

describe("healthy reconciliation (AC4)", () => {
  it("classifies a provisioned workspace as healthy and records its verified HEAD", async () => {
    const instance = await provisionTask("t1");
    const report = await reconciliation().reconcile();
    const reportEntry = report.entries.find((e) => e.workspaceId === instance.workspaceId);
    expect(reportEntry?.status).toBe("healthy");
    expect(reportEntry?.driftMarkers).toEqual([]);
    const persisted = store.getById(instance.workspaceId);
    expect(persisted?.health).toBe("healthy");
    expect(persisted?.lifecycleState).toBe("active");
    expect(persisted?.lastVerifiedHead).toBeDefined();
    // content-free report: no path/branch leaks into entries
    expect(JSON.stringify(report)).not.toContain(managedRoot);
  });
});

describe("restart restoration (AC1)", () => {
  it("restores the last active workspace when its pointer target is healthy", async () => {
    const instance = await provisionTask("t1");
    pointerStore.set({
      workspaceId: instance.workspaceId,
      setBy: "u",
      atIso: "2026-01-01T00:00:00Z",
    });
    // simulate a restart: a fresh reconciliation service over the same persisted store/pointer
    const report = await reconciliation().reconcile();
    expect(report.activeRestoration).toEqual({
      kind: "restored",
      workspaceId: instance.workspaceId,
    });
  });

  it("never silently chooses among ambiguous active workspaces (stop condition)", async () => {
    const a = await provisionTask("task-a");
    const b = await provisionTask("task-b");
    pointerStore.clear();
    const report = await reconciliation().reconcile();
    expect(report.activeRestoration.kind).toBe("ambiguous");
    expect(report.activeRestoration.ambiguousWorkspaceIds).toEqual(
      [a.workspaceId, b.workspaceId].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)),
    );
  });
});

describe("external change surfaced as explicit recoverable state (AC2)", () => {
  it("flags a deleted worktree as missing + recovery-required, not silently gone", async () => {
    const instance = await provisionTask("t1");
    rmSync(instance.managedWorktreePath, { recursive: true, force: true });
    const report = await reconciliation().reconcile();
    const reportEntry = report.entries.find((e) => e.workspaceId === instance.workspaceId);
    expect(reportEntry?.status).toBe("missing");
    expect(reportEntry?.repairable).toBe(true);
    const persisted = store.getById(instance.workspaceId);
    expect(persisted).toBeDefined(); // still present, not silently dropped
    expect(persisted?.lifecycleState).toBe("recovery-required");
    expect(persisted?.health).toBe("missing");
    expect(persisted?.driftMarkers).toContain("worktree-missing");
    expect(evidence.some((e) => e.json.includes('"operation": "reconcile"'))).toBe(true);
  });

  it("flags an out-of-root (unmanaged) persisted path as unmanaged-path + recovery-required", async () => {
    const instance = await provisionTask("t1");
    const escaped = realpathSync(mkdtempSync(join(tmpdir(), "keiko-escape-")));
    try {
      store.upsert({ ...instance, managedWorktreePath: escaped });
      const report = await reconciliation().reconcile();
      const reportEntry = report.entries.find((e) => e.workspaceId === instance.workspaceId);
      expect(reportEntry?.status).toBe("unmanaged-path");
      expect(reportEntry?.operatorActionRequired).toBe(true);
      expect(store.getById(instance.workspaceId)?.lifecycleState).toBe("recovery-required");
    } finally {
      rmSync(escaped, { recursive: true, force: true });
    }
  });
});

describe("pointer drift (negative: corrupted / moved gitdir)", () => {
  it("classifies a corrupted .git pointer as stale-pointer + recovery-required", async () => {
    const instance = await provisionTask("t1");
    writeFileSync(join(instance.managedWorktreePath, ".git"), "garbage not a gitdir pointer\n");
    const report = await reconciliation().reconcile();
    const reportEntry = report.entries.find((e) => e.workspaceId === instance.workspaceId);
    expect(reportEntry?.status).toBe("stale-pointer");
    expect(reportEntry?.driftMarkers).toContain("pointer-stale");
    expect(store.getById(instance.workspaceId)?.lifecycleState).toBe("recovery-required");
  });

  it("classifies a mismatched gitdir identity as stale-pointer (gitdir-mismatch)", async () => {
    const instance = await provisionTask("t1");
    store.upsert({ ...instance, gitdirIdentity: "0000000000000000deadbeefdeadbeef" });
    const report = await reconciliation().reconcile();
    const reportEntry = report.entries.find((e) => e.workspaceId === instance.workspaceId);
    expect(reportEntry?.status).toBe("stale-pointer");
    expect(reportEntry?.driftMarkers).toContain("gitdir-mismatch");
  });
});

describe("branch / HEAD drift (negative: branch mismatch, moved HEAD)", () => {
  it("classifies a missing task branch as drifted (branch-deleted), keeping a usable worktree active", async () => {
    const instance = await provisionTask("t1");
    store.upsert({ ...instance, taskBranch: "keiko/task/ghost-00000000" });
    const report = await reconciliation().reconcile();
    const reportEntry = report.entries.find((e) => e.workspaceId === instance.workspaceId);
    expect(reportEntry?.status).toBe("drifted");
    expect(reportEntry?.driftMarkers).toContain("branch-deleted");
    // a usable-but-diverged worktree stays in its lifecycle, surfaced via health/markers
    expect(store.getById(instance.workspaceId)?.lifecycleState).toBe("active");
    expect(store.getById(instance.workspaceId)?.health).toBe("drifted");
  });

  it("classifies a moved HEAD as drifted (head-moved)", async () => {
    const instance = await provisionTask("t1");
    store.upsert({ ...instance, lastVerifiedHead: "0000000000000000000000000000000000000000" });
    const report = await reconciliation().reconcile();
    const reportEntry = report.entries.find((e) => e.workspaceId === instance.workspaceId);
    expect(reportEntry?.status).toBe("drifted");
    expect(reportEntry?.driftMarkers).toContain("head-moved");
  });
});

describe("partial provisioning + stale lock", () => {
  it("classifies a never-completed provisioning instance as partially-created", async () => {
    const instance = await provisionTask("t1");
    // simulate a crash mid-provision: lifecycle stuck at provisioning, worktree gone
    rmSync(instance.managedWorktreePath, { recursive: true, force: true });
    store.upsert({ ...instance, lifecycleState: "provisioning", health: "unknown" });
    const report = await reconciliation().reconcile();
    const reportEntry = report.entries.find((e) => e.workspaceId === instance.workspaceId);
    expect(reportEntry?.status).toBe("partially-created");
    expect(reportEntry?.repairable).toBe(true);
    // partial creation is left for the provisioning retry path, not force-flagged
    expect(store.getById(instance.workspaceId)?.lifecycleState).toBe("provisioning");
  });

  it("surfaces a stale lock as drifted with a release-stale-lock hint, staying active", async () => {
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
    const report = await reconciliation().reconcile();
    const reportEntry = report.entries.find((e) => e.workspaceId === instance.workspaceId);
    expect(reportEntry?.status).toBe("drifted");
    expect(reportEntry?.driftMarkers).toContain("lock-stale");
    expect(reportEntry?.recoveryHints.some((h) => h.strategy === "release-stale-lock")).toBe(true);
    expect(store.getById(instance.workspaceId)?.lifecycleState).toBe("active");
  });

  it("defers to a live foreign lock (locked), without flagging recovery", async () => {
    const instance = await provisionTask("t1");
    store.upsert({
      ...instance,
      lock: {
        lockId: "live",
        owner: "someone-else",
        reason: "mutation",
        acquiredAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + 600_000).toISOString(),
      },
    });
    const report = await reconciliation().reconcile();
    const reportEntry = report.entries.find((e) => e.workspaceId === instance.workspaceId);
    expect(reportEntry?.status).toBe("locked");
    expect(store.getById(instance.workspaceId)?.lifecycleState).toBe("active");
  });
});

describe("stored-derived report (read-only) matches a live reconcile", () => {
  it("report() reconstructs the same status from persisted fields without IO", async () => {
    const instance = await provisionTask("t1");
    rmSync(instance.managedWorktreePath, { recursive: true, force: true });
    await reconciliation().reconcile();
    const stored = reconciliation().report();
    const reportEntry = stored.entries.find((e) => e.workspaceId === instance.workspaceId);
    expect(reportEntry?.status).toBe("missing");
  });

  it("scopes the report to a single repository root when given", async () => {
    await provisionTask("t1");
    const stored = reconciliation().report(repoRoot);
    expect(stored.entries.length).toBe(1);
  });
});

describe("dangling active pointer", () => {
  it("clears the pointer when its instance no longer exists", async () => {
    const instance = await provisionTask("t1");
    pointerStore.set({
      workspaceId: instance.workspaceId,
      setBy: "u",
      atIso: "2026-01-01T00:00:00Z",
    });
    store.delete(instance.workspaceId);
    const report = await reconciliation().reconcile();
    expect(["cleared-dangling", "none"]).toContain(report.activeRestoration.kind);
    expect(pointerStore.get()).toBeUndefined();
  });

  it("report() is read-only: it reports a dangling pointer but never calls clear(); reconcile() does", async () => {
    await provisionTask("t1");
    // a pointer that references a workspace id absent from the store (a dangling pointer the FK
    // cascade would normally prevent) lets us prove the read vs. write behavior directly.
    let clearCount = 0;
    const dangling: ActiveWorkspacePointer = {
      workspaceId: "ws_ghost",
      setBy: "u",
      setAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const stubPointer: ActiveWorkspacePointerStore = {
      get: () => dangling,
      set: () => dangling,
      clear: () => {
        clearCount += 1;
      },
    };
    const svc = createWorkspaceReconciliationService({
      store,
      activePointerStore: stubPointer,
      evidenceStore: capturingEvidence(),
      managedRoot,
      createAdapter: realAdapter,
      redactString: (s: string): string => s,
      now: (): number => nowMs,
      newId: (): string => `id-${String(idCounter++)}`,
    });
    const read = svc.report();
    expect(read.activeRestoration.kind).toBe("cleared-dangling");
    expect(clearCount).toBe(0); // read-only GET path never mutates the pointer store
    await svc.reconcile();
    expect(clearCount).toBe(1); // the live reconcile self-heals the dangling pointer
  });
});
