// Scale / performance-bound coverage for the task-workspace subsystem (Issue #449, ADR-0093 D4, SC4).
//
// AC5: "Startup reconciliation and workspace switching stay within documented performance bounds for
// many paused workspaces." ADR-0093 states the bounds at N = 200 persisted instances: O(N) startup
// reconciliation ≤ 2000 ms, O(N) health report ≤ 2000 ms, O(N) listAll ≤ 50 ms, and rapid switching
// O(1) per switch. These tests SEED 200 instances and assert the work completes within those generous
// bounds — a regression guard against an accidental O(N²) scan (e.g. a per-instance managed-root rescan),
// not a micro-benchmark. The bounds are ~10× expected, so they are stable across CI hardware.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { createWorkspaceReconciliationService } from "./reconciliation.js";
import { createWorkspaceHealthService } from "./health.js";
import {
  deriveManagedWorktreePath,
  deriveRepositoryId,
  deriveTaskBranchName,
  deriveWorkspaceId,
} from "./naming.js";
import type {
  WorkspaceHealthService,
  WorkspaceLifecycleService,
  WorkspaceProvisioningService,
  WorkspaceReconciliationService,
} from "./types.js";

const SCALE = 200;
const RECONCILE_BUDGET_MS = 2000;
const HEALTH_BUDGET_MS = 2000;
const LIST_ALL_BUDGET_MS = 50;
// ADR-0093 D4 rapid switching is O(1) per switch (design target ≤25 ms p95). The p95 assertion keeps CI
// headroom while staying tight enough to catch a 3× latency creep; the total bounds a gross regression.
const SWITCH_P95_BUDGET_MS = 50;
const SWITCH_TOTAL_BUDGET_MS = 1500;

let repoRoot: string;
let managedRoot: string;
let db: DatabaseSync;
let store: WorkspaceInstanceStore;
let pointerStore: ActiveWorkspacePointerStore;
let mutex: WorkspaceMutexRegistry;
let provisioning: WorkspaceProvisioningService;
let lifecycle: WorkspaceLifecycleService;
let reconciliation: WorkspaceReconciliationService;
let health: WorkspaceHealthService;
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
  reconciliation = createWorkspaceReconciliationService(common);
  health = createWorkspaceHealthService(common);
}

// Seeds a paused instance whose managed worktree does NOT exist on disk — the realistic shape of a
// "many paused workspaces" backlog. Reconciliation classifies it without a per-instance git spawn (a
// missing worktree dir short-circuits the branch/HEAD probes), so this measures the O(N) orchestration.
function seedPausedInstance(i: number): void {
  const taskId = `scale-${String(i)}`;
  const repositoryId = deriveRepositoryId(repoRoot);
  const workspaceId = deriveWorkspaceId({ repositoryId, taskId });
  const iso = new Date(1_700_000_000_000 + i).toISOString();
  store.upsert({
    schemaVersion: "1",
    workspaceId,
    taskId,
    repositoryId,
    repositoryRoot: repoRoot,
    baseBranch: "main",
    taskBranch: deriveTaskBranchName({ taskId }),
    managedWorktreePath: deriveManagedWorktreePath({ managedRoot, repositoryId, workspaceId }),
    gitdirIdentity: workspaceId,
    lifecycleState: "paused",
    health: "unknown",
    lock: null,
    createdAt: iso,
    updatedAt: iso,
    driftMarkers: [],
    recoveryHints: [],
    auditCorrelationId: workspaceId,
  });
}

async function elapsed(fn: () => Promise<void> | void): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

beforeEach(() => {
  repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-scale-repo-")));
  managedRoot = join(
    realpathSync(mkdtempSync(join(tmpdir(), "keiko-scale-mr-"))),
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

describe(`task-workspace performance bounds at N=${String(SCALE)} (ADR-0093 D4)`, () => {
  it("enumerates all persisted instances with listAll() within the documented bound", () => {
    for (let i = 0; i < SCALE; i += 1) seedPausedInstance(i);
    const start = performance.now();
    const all = store.listAll();
    const ms = performance.now() - start;
    expect(all).toHaveLength(SCALE);
    expect(ms).toBeLessThan(LIST_ALL_BUDGET_MS);
  });

  it("runs a full startup reconciliation pass over N instances within the documented bound", async () => {
    for (let i = 0; i < SCALE; i += 1) seedPausedInstance(i);
    let report: Awaited<ReturnType<typeof reconciliation.reconcile>> | undefined;
    const ms = await elapsed(async () => {
      report = await reconciliation.reconcile();
    });
    expect(report?.entries).toHaveLength(SCALE);
    // Every vanished worktree stays VISIBLE and classified, never silently dropped and never misread as
    // healthy (AC2 reused at scale) — a non-recoverable disk state must surface, not pass.
    expect(report?.entries.every((e) => e.status !== "healthy")).toBe(true);
    expect(ms).toBeLessThan(RECONCILE_BUDGET_MS);
  });

  it("derives the read-only reconciliation report over N instances without IO blow-up", () => {
    for (let i = 0; i < SCALE; i += 1) seedPausedInstance(i);
    const start = performance.now();
    const report = reconciliation.report();
    const ms = performance.now() - start;
    expect(report.entries).toHaveLength(SCALE);
    expect(ms).toBeLessThan(LIST_ALL_BUDGET_MS);
  });

  it("produces a full operational health report over N instances within the documented bound", async () => {
    for (let i = 0; i < SCALE; i += 1) seedPausedInstance(i);
    let entryCount = 0;
    const ms = await elapsed(async () => {
      const report = await health.report();
      entryCount = report.entries.length;
    });
    expect(entryCount).toBeGreaterThanOrEqual(SCALE);
    expect(ms).toBeLessThan(HEALTH_BUDGET_MS);
  });

  it("keeps rapid workspace switching O(1) per switch and the final pointer correct", async () => {
    // Two real worktrees; switch back and forth many times. Each setActive is a single instance load +
    // pointer write under the active: key — no git mutation on an already-materialized worktree.
    const a = await provisioning.provision({
      repositoryRequestPath: repoRoot,
      taskId: "switch-a",
      baseBranch: "main",
      requestedBy: "actor",
    });
    const b = await provisioning.provision({
      repositoryRequestPath: repoRoot,
      taskId: "switch-b",
      baseBranch: "main",
      requestedBy: "actor",
    });
    const ids = [a.instance.workspaceId, b.instance.workspaceId];
    const switches = 30;
    let lastId = "";
    const perSwitchMs: number[] = [];
    const total = await elapsed(async () => {
      for (let i = 0; i < switches; i += 1) {
        lastId = ids[i % 2] ?? "";
        const start = performance.now();
        await lifecycle.setActive({
          workspaceId: lastId,
          requestedBy: "actor",
          acquireLock: false,
        });
        perSwitchMs.push(performance.now() - start);
      }
    });
    expect(lifecycle.getActive()?.instance.workspaceId).toBe(lastId);
    // Per-switch p95 guards the ADR-0093 D4 O(1) bound (design target 25 ms; the assertion keeps CI
    // headroom but stays tight enough to catch a 3× latency creep — e.g. a stray listAll/`git status`
    // slipped into setActive would push each switch past 50 ms and fail here).
    const sorted = [...perSwitchMs].sort((x, y) => x - y);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
    expect(p95).toBeLessThan(SWITCH_P95_BUDGET_MS);
    expect(total).toBeLessThan(SWITCH_TOTAL_BUDGET_MS);
  });
});
