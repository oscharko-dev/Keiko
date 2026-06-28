// Integration coverage for the #448 read-only health service (Issue #448, Epic #443). Materializes
// genuine managed worktrees via the real provisioning service + adapter, then proves the operational
// health classification over live signals (healthy, dirty, missing, archived, cleanup-ready), orphan
// detection by cross-referencing the managed root with the store, and the content-free report (SC3).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createNodeGitWorktreeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { GitWorktreeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import {
  validateWorkspaceHealthReport,
  type TaskWorkspaceLifecycleState,
  type WorkspaceHealthEntry,
  type WorkspaceHealthReport,
  type WorkspaceInfo,
  type WorkspaceInstance,
} from "@oscharko-dev/keiko-contracts";
import { runMigrations } from "../store/schema.js";
import { buildWorkspaceInstanceStoreOverDatabase, type WorkspaceInstanceStore } from "./store.js";
import {
  buildActiveWorkspacePointerStoreOverDatabase,
  type ActiveWorkspacePointerStore,
} from "./active-store.js";
import { createWorkspaceProvisioningService } from "./provisioning.js";
import { createWorkspaceHealthService } from "./health.js";
import type { WorkspaceHealthService, WorkspaceProvisioningService } from "./types.js";
import { createWorkspaceMutexRegistry } from "./mutex.js";

const __twMutex = createWorkspaceMutexRegistry();

let repoRoot: string;
let managedRoot: string;
let db: DatabaseSync;
let store: WorkspaceInstanceStore;
let pointerStore: ActiveWorkspacePointerStore;
let idCounter: number;
let nowMs: number;

function git(args: readonly string[], cwd = repoRoot): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

function noopEvidence(): EvidenceStore {
  return {
    put: (id: string): string => `/evidence/${id}.json`,
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
    evidenceStore: noopEvidence(),
    managedRoot,
    createAdapter: realAdapter,
    redactString: (s: string): string => s,
    now: (): number => nowMs,
    newId: (): string => `id-${String(idCounter++)}`,
    mutex: __twMutex,
  });
}

function health(): WorkspaceHealthService {
  return createWorkspaceHealthService({
    store,
    activePointerStore: pointerStore,
    evidenceStore: noopEvidence(),
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

function setState(instance: WorkspaceInstance, lifecycleState: TaskWorkspaceLifecycleState): void {
  store.upsert({ ...instance, lifecycleState });
}

beforeEach(() => {
  repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-health-repo-")));
  managedRoot = join(
    realpathSync(mkdtempSync(join(tmpdir(), "keiko-health-mr-"))),
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
  idCounter = 0;
  nowMs = 1_700_000_000_000;
});

afterEach(() => {
  db.close();
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(managedRoot, { recursive: true, force: true });
});

function entryFor(
  report: WorkspaceHealthReport,
  workspaceId: string,
): WorkspaceHealthEntry | undefined {
  return report.entries.find((e) => e.kind === "instance" && e.workspaceId === workspaceId);
}

describe("operational health classification (AC1)", () => {
  it("classifies a clean active workspace healthy and not cleanup-eligible", async () => {
    const instance = await provisionTask("t-healthy");
    const report = await health().report(repoRoot);
    const entry = entryFor(report, instance.workspaceId);
    expect(entry?.classification).toBe("healthy");
    expect(entry?.cleanupEligible).toBe(false);
    expect(validateWorkspaceHealthReport(report).ok).toBe(true);
    // content-free: no path / repo root leaks
    expect(JSON.stringify(report)).not.toContain(managedRoot);
    expect(JSON.stringify(report)).not.toContain(repoRoot);
  });

  it("classifies a worktree with uncommitted/untracked changes as dirty (live probe)", async () => {
    const instance = await provisionTask("t-dirty");
    writeFileSync(join(instance.managedWorktreePath, "scratch.txt"), "wip\n");
    const report = await health().report(repoRoot);
    expect(entryFor(report, instance.workspaceId)?.classification).toBe("dirty");
  });

  it("classifies an externally-deleted worktree as missing", async () => {
    const instance = await provisionTask("t-missing");
    rmSync(instance.managedWorktreePath, { recursive: true, force: true });
    const report = await health().report(repoRoot);
    expect(entryFor(report, instance.workspaceId)?.classification).toBe("missing");
  });

  it("classifies a settled archived workspace as archived and cleanup-eligible", async () => {
    const instance = await provisionTask("t-archived");
    setState(instance, "archived");
    const report = await health().report(repoRoot);
    const entry = entryFor(report, instance.workspaceId);
    expect(entry?.classification).toBe("archived");
    expect(entry?.cleanupEligible).toBe(true);
  });

  it("classifies a clean cleanup-pending workspace as cleanup-ready", async () => {
    const instance = await provisionTask("t-ready");
    setState(instance, "cleanup-pending");
    const report = await health().report(repoRoot);
    const entry = entryFor(report, instance.workspaceId);
    expect(entry?.classification).toBe("cleanup-ready");
    expect(entry?.cleanupEligible).toBe(true);
  });
});

describe("orphan detection", () => {
  it("surfaces an orphaned managed worktree (directory with no persisted record)", async () => {
    const instance = await provisionTask("t-orphan");
    store.delete(instance.workspaceId);
    const report = await health().report(repoRoot);
    const orphans = report.entries.filter((e) => e.kind === "orphan-worktree");
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.classification).toBe("orphaned");
    expect(orphans[0]?.cleanupEligible).toBe(true);
    expect(orphans[0]?.orphanId).toBeDefined();
  });

  it("does not report a recorded worktree as an orphan", async () => {
    await provisionTask("t-recorded");
    const report = await health().report(repoRoot);
    expect(report.entries.some((e) => e.kind === "orphan-worktree")).toBe(false);
  });

  it("a global report (no root) covers every repository's instances", async () => {
    const a = await provisionTask("t-a");
    const b = await provisionTask("t-b");
    const report = await health().report();
    expect(entryFor(report, a.workspaceId)).toBeDefined();
    expect(entryFor(report, b.workspaceId)).toBeDefined();
  });
});
