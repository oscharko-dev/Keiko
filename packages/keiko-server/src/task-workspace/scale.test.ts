// Scale / performance-bound coverage for the task-workspace subsystem (Issue #449, ADR-0093 D4, SC4).
//
// AC5: "Startup reconciliation and workspace switching stay within documented performance bounds for
// many paused workspaces." ADR-0093 states the bounds at N = 200 persisted instances: O(N) startup
// reconciliation ≤ 2000 ms, O(N) health report ≤ 2000 ms, O(N) listAll ≤ 50 ms, and rapid switching
// O(1) per switch. These tests SEED 200 instances and assert the work completes within those generous
// bounds — a regression guard against an accidental O(N²) scan (e.g. a per-instance managed-root rescan),
// not a micro-benchmark. The bounds are ~10× expected, so they are stable across CI hardware.
//
// DETERMINISTIC BACKSTOP (GEN-TEST-FLAKE-005): wall-clock budgets can false-RED the required coverage
// gate under CPU contention (vitest retries are 0). So EVERY wall-clock assertion below is AUGMENTED
// with an OPERATION-COUNT assertion that catches the actual regression CLASS deterministically,
// regardless of machine speed. The store and the git worktree adapter are wrapped in transparent
// counting proxies (no production change) so we can prove the algorithmic shape directly:
//   - reconcile / health over N instances in ONE repository must fetch the git worktree list ONCE
//     (not N times — the N+1 / O(N²) per-instance `git worktree list` spawn is the exact regression the
//     grouping-by-repository code prevents), enumerate the store ONCE (one listAll, not per-instance),
//     and perform O(N) — not O(N²) — persist writes.
//   - a workspace switch must touch NEITHER a full-store enumeration NOR a git worktree list — a stray
//     listAll / `git status` slipped into setActive is O(N) in the backlog size and would fail the
//     count assertion even on an infinitely fast machine.
// These counts are the load-bearing regression proof; the wall-clock bounds still guard gross
// regressions but are no longer the sole gate.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createNodeGitWorktreeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type {
  GitWorktreeAdapter,
  WorktreeListEntry,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { WorkspaceInfo, WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
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

// Deterministic operation counters (reset per test). These count the algorithmically load-bearing
// accesses the wall-clock budgets are a proxy for: full-store enumeration (listAll), per-instance persist
// writes (upsert), single-instance reads (getById), and the per-repository `git worktree list` spawn
// (listWorktrees). A regression to O(N²) / N+1 moves these counts, so they RED on the defect class
// independent of machine speed.
interface OpCounts {
  listAll: number;
  upsert: number;
  getById: number;
  listWorktrees: number;
}
let ops: OpCounts;

function resetOps(): void {
  ops = { listAll: 0, upsert: 0, getById: 0, listWorktrees: 0 };
}

// Transparent counting proxy around the real store: every method delegates to the underlying store
// (so behavior is byte-identical) while incrementing the counters the op-count assertions read.
function countingStore(inner: WorkspaceInstanceStore): WorkspaceInstanceStore {
  return {
    getById: (workspaceId: string): WorkspaceInstance | undefined => {
      ops.getById += 1;
      return inner.getById(workspaceId);
    },
    findByRepositoryAndTask: (
      repositoryId: string,
      taskId: string,
    ): WorkspaceInstance | undefined => inner.findByRepositoryAndTask(repositoryId, taskId),
    listByRepository: (repositoryId: string): readonly WorkspaceInstance[] =>
      inner.listByRepository(repositoryId),
    listAll: (): readonly WorkspaceInstance[] => {
      ops.listAll += 1;
      return inner.listAll();
    },
    upsert: (instance: WorkspaceInstance): WorkspaceInstance => {
      ops.upsert += 1;
      return inner.upsert(instance);
    },
    delete: (workspaceId: string): void => {
      inner.delete(workspaceId);
    },
  };
}

// Transparent counting proxy around the real git worktree adapter: delegates every verb but counts the
// expensive `listWorktrees` spawn — the one that must run ONCE per repository, never once per instance.
function countingAdapter(inner: GitWorktreeAdapter): GitWorktreeAdapter {
  return {
    ...inner,
    listWorktrees: (): Promise<readonly WorktreeListEntry[]> => {
      ops.listWorktrees += 1;
      return inner.listWorktrees();
    },
  };
}

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
  // The store the SERVICES see is the counting proxy; the raw store stays accessible for direct-store
  // assertions (e.g. seeding and the listAll() test) so those are counted too.
  store = countingStore(buildWorkspaceInstanceStoreOverDatabase(db));
  pointerStore = buildActiveWorkspacePointerStoreOverDatabase(db);
  mutex = createWorkspaceMutexRegistry();
  const common = {
    store,
    activePointerStore: pointerStore,
    evidenceStore: noopEvidence(),
    managedRoot,
    createAdapter: (workspace: WorkspaceInfo): GitWorktreeAdapter =>
      countingAdapter(adapterFor(workspace)),
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
  resetOps();
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
    resetOps();
    const start = performance.now();
    const all = store.listAll();
    const ms = performance.now() - start;
    expect(all).toHaveLength(SCALE);
    expect(ms).toBeLessThan(LIST_ALL_BUDGET_MS);
    // Deterministic backstop: enumerating N instances is ONE store enumeration, never a per-instance
    // fan-out — the whole point of listAll being a single indexed query. RED if a caller ever regresses
    // to walking ids and re-reading each row.
    expect(ops.listAll).toBe(1);
    expect(ops.getById).toBe(0);
  });

  it("runs a full startup reconciliation pass over N instances within the documented bound", async () => {
    for (let i = 0; i < SCALE; i += 1) seedPausedInstance(i);
    resetOps();
    let report: Awaited<ReturnType<typeof reconciliation.reconcile>> | undefined;
    const ms = await elapsed(async () => {
      report = await reconciliation.reconcile();
    });
    expect(report?.entries).toHaveLength(SCALE);
    // Every vanished worktree stays VISIBLE and classified, never silently dropped and never misread as
    // healthy (AC2 reused at scale) — a non-recoverable disk state must surface, not pass.
    expect(report?.entries.every((e) => e.status !== "healthy")).toBe(true);
    expect(ms).toBeLessThan(RECONCILE_BUDGET_MS);
    // Deterministic backstop for the exact O(N²) / N+1 regression the wall-clock budget proxies:
    //  - The N instances live in ONE repository, so the `git worktree list` spawn must run EXACTLY once.
    //    A per-instance spawn (the classic N+1 that re-fetches the worktree list inside the loop) would
    //    make this SCALE, and it would RED here on any machine, fast or slow.
    expect(ops.listWorktrees).toBe(1);
    //  - The instance set is enumerated ONCE (a single listAll), never re-scanned per instance.
    expect(ops.listAll).toBe(1);
    //  - Persistence is O(N): exactly one upsert per instance (the classification write), not O(N²).
    expect(ops.upsert).toBe(SCALE);
  });

  it("derives the read-only reconciliation report over N instances without IO blow-up", () => {
    for (let i = 0; i < SCALE; i += 1) seedPausedInstance(i);
    resetOps();
    const start = performance.now();
    const report = reconciliation.report();
    const ms = performance.now() - start;
    expect(report.entries).toHaveLength(SCALE);
    expect(ms).toBeLessThan(LIST_ALL_BUDGET_MS);
    // Deterministic backstop: the read-only report is a PURE in-memory derivation from a single store
    // enumeration — it must never touch git (no worktree list) and never write (no upsert). A regression
    // that reintroduced live IO into report() would trip these counts regardless of machine speed.
    expect(ops.listAll).toBe(1);
    expect(ops.listWorktrees).toBe(0);
    expect(ops.upsert).toBe(0);
  });

  it("produces a full operational health report over N instances within the documented bound", async () => {
    for (let i = 0; i < SCALE; i += 1) seedPausedInstance(i);
    resetOps();
    let entryCount = 0;
    const ms = await elapsed(async () => {
      const report = await health.report();
      entryCount = report.entries.length;
    });
    expect(entryCount).toBeGreaterThanOrEqual(SCALE);
    expect(ms).toBeLessThan(HEALTH_BUDGET_MS);
    // Deterministic backstop, same shape as reconcile: N instances in ONE repository ⇒ the repository
    // `git worktree list` is fetched EXACTLY once (the grouping guard), and the instance set is
    // enumerated ONCE. The seeded worktrees do not exist on disk, so the per-instance live dirty probe
    // short-circuits and spawns no extra worktree list — a regression that dropped the grouping (a
    // per-instance list) would make this SCALE and RED here deterministically.
    expect(ops.listWorktrees).toBe(1);
    expect(ops.listAll).toBe(1);
    // Health is pure observation: it performs NO store writes (reconciliation owns the persisted health
    // columns). A regression that made health persist per instance would show O(N) upserts here.
    expect(ops.upsert).toBe(0);
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
    // Count only the switch loop, not the two provisions above.
    resetOps();
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
    // Deterministic backstop for the O(1)-per-switch bound — the machine-independent proof the p95/total
    // budgets proxy. Switching an already-materialized workspace must NEVER enumerate the whole backlog
    // and must NEVER re-list git worktrees; either would make each switch O(backlog) and is exactly the
    // "a stray listAll / `git status` slipped into setActive" regression the wall-clock comment describes.
    expect(ops.listAll).toBe(0);
    expect(ops.listWorktrees).toBe(0);
    // Per-switch store access is bounded and CONSTANT (O(1) per switch), so the totals scale with the
    // number of switches only — never with the backlog size N. activate does one getById + one upsert
    // and the pointer re-verification does one more getById, so reads sit at ~2 per switch and writes at
    // exactly 1 per switch (the very first switch resumes the just-provisioned target, costing one extra
    // read). We assert a tight constant-per-switch band rather than an off-by-one-brittle exact value:
    // a per-switch fan-out over the backlog (the real regression) would blow far past this ceiling.
    expect(ops.upsert).toBe(switches);
    expect(ops.getById).toBeGreaterThanOrEqual(switches * 2);
    expect(ops.getById).toBeLessThanOrEqual(switches * 2 + 2);
  });
});
