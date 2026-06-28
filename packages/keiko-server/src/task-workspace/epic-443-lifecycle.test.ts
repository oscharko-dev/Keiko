// End-to-end lifecycle regression for Epic #443 (Issue #450, verification + closure capstone).
//
// The per-slice suites (#445 provisioning, #446 binding, #447 reconciliation + repair, #448 health +
// cleanup, #449 concurrency + adversarial) each prove one stage in isolation. This fixture is the
// single CONSOLIDATED regression the closure matrix cites: it wires the SIX real services
// (provisioning, lifecycle, reconciliation, health, repair, cleanup) over ONE persisted store, ONE
// active pointer, and ONE shared in-process mutex against disposable real git repositories, then walks a
// complete workspace life: provision → activate → switch → pause → resume → restart reconciliation →
// drift detection → repair → governed cleanup. It additionally proves the load-bearing reuse invariants
// Epic #443 must preserve at runtime:
//
//   1. Git Delivery (#470) root retargeting only — every WorkspaceBinding exposes the SAME managed
//      worktree path for activeRoot, gitDeliveryRoot, and editorProjectRoot, and that path is NEVER the
//      project root. Activation only swaps the governed target root; it adds no second branch/commit/
//      publish/PR/merge authority.
//   2. Editor/runtime (#1491) binding stays deterministic — the same single derivation feeds the editor
//      project root, so a switch re-targets every surface atomically with no stale project-root leak.
//   3. Blocked mutation is a first-class refusal, never a destructive fallback — a dirty cleanup refuses
//      and leaves the worktree on disk (SC4), and an illegal transition rejects with a typed code.
//   4. Lifecycle evidence stays content-free — no managed root or repository root leaks into the audit
//      trail (SC3).
//
// No generic git runner: every git mutation flows through the single governed worktree adapter spawn
// boundary, exactly as the per-slice suites do.

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
  TaskWorkspaceLifecycleState,
  WorkspaceBinding,
  WorkspaceInfo,
  WorkspaceInstance,
} from "@oscharko-dev/keiko-contracts";
import { runMigrations } from "../store/schema.js";
import { buildWorkspaceInstanceStoreOverDatabase, type WorkspaceInstanceStore } from "./store.js";
import {
  buildActiveWorkspacePointerStoreOverDatabase,
  type ActiveWorkspacePointerStore,
} from "./active-store.js";
import { createWorkspaceProvisioningService } from "./provisioning.js";
import { createWorkspaceLifecycleService } from "./lifecycle.js";
import { createWorkspaceReconciliationService } from "./reconciliation.js";
import { createWorkspaceHealthService } from "./health.js";
import { createWorkspaceRepairService } from "./repair.js";
import { createWorkspaceCleanupService } from "./cleanup.js";
import { TaskWorkspaceError, type TaskWorkspaceErrorCode } from "./errors.js";
import type {
  WorkspaceCleanupService,
  WorkspaceHealthService,
  WorkspaceLifecycleService,
  WorkspaceProvisioningService,
  WorkspaceReconciliationService,
  WorkspaceRepairService,
} from "./types.js";
import { createWorkspaceMutexRegistry } from "./mutex.js";

// ONE shared in-process mutex across every service — the #449 serialization invariant. A per-service
// registry would let same-key mutations interleave; sharing it is the production wiring.
const __twMutex = createWorkspaceMutexRegistry();

const FIXED_NOW = 1_700_000_000_000;

let repoRoot: string;
let managedRoot: string;
let db: DatabaseSync;
let store: WorkspaceInstanceStore;
let pointerStore: ActiveWorkspacePointerStore;
let evidence: { id: string; json: string }[];
let idCounter: number;

interface Services {
  readonly provisioning: WorkspaceProvisioningService;
  readonly lifecycle: WorkspaceLifecycleService;
  readonly reconciliation: WorkspaceReconciliationService;
  readonly health: WorkspaceHealthService;
  readonly repair: WorkspaceRepairService;
  readonly cleanup: WorkspaceCleanupService;
}

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

// Build all six services over the shared store/pointer/mutex — the production composition. lifecycle and
// repair both receive the SAME provisioning instance, so the switch/resume/recreate walks delegate to
// one provisioning authority (never a second one).
function buildServices(): Services {
  const common = {
    store,
    activePointerStore: pointerStore,
    evidenceStore: capturingEvidence(),
    managedRoot,
    createAdapter: realAdapter,
    redactString: (s: string): string => s,
    now: (): number => FIXED_NOW,
    newId: (): string => `id-${String(idCounter++)}`,
    mutex: __twMutex,
  };
  const provisioning = createWorkspaceProvisioningService(common);
  const lifecycle = createWorkspaceLifecycleService({ ...common, provisioning });
  const reconciliation = createWorkspaceReconciliationService(common);
  const health = createWorkspaceHealthService(common);
  const repair = createWorkspaceRepairService({ ...common, provisioning });
  const cleanup = createWorkspaceCleanupService(common);
  return { provisioning, lifecycle, reconciliation, health, repair, cleanup };
}

async function provision(svc: Services, taskId: string): Promise<WorkspaceInstance> {
  const result = await svc.provisioning.provision({
    repositoryRequestPath: repoRoot,
    taskId,
    baseBranch: "main",
    requestedBy: "operator",
  });
  return result.instance;
}

// Force a settled lifecycle state directly (the cleanup suite's pattern) — driving the full archive
// transition chain is out of scope here; the point is the governed removal gate, not the walk to it.
function setState(
  instance: WorkspaceInstance,
  lifecycleState: TaskWorkspaceLifecycleState,
  extra: Partial<WorkspaceInstance> = {},
): WorkspaceInstance {
  return store.upsert({ ...instance, lifecycleState, ...extra });
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

// The reuse invariant: every binding targets the managed worktree for all three coordinates, never the
// project root. Asserted at every stage that returns a binding.
function expectBoundToManagedWorktree(
  binding: WorkspaceBinding,
  instance: WorkspaceInstance,
): void {
  expect(binding.activeRoot).toBe(instance.managedWorktreePath);
  expect(binding.gitDeliveryRoot).toBe(instance.managedWorktreePath);
  expect(binding.editorProjectRoot).toBe(instance.managedWorktreePath);
  expect(binding.activeRoot.startsWith(managedRoot)).toBe(true);
  expect(binding.activeRoot).not.toBe(repoRoot);
}

beforeEach(() => {
  repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-e2e443-repo-")));
  managedRoot = join(
    realpathSync(mkdtempSync(join(tmpdir(), "keiko-e2e443-mr-"))),
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
});

afterEach(() => {
  db.close();
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(managedRoot, { recursive: true, force: true });
});

// The consolidated walk is decomposed into named phases so each stays a small, readable unit (and below
// the cyclomatic-complexity limit). The walk test threads the two instances through them in order.
async function phaseProvisionTwo(
  svc: Services,
): Promise<{ alpha: WorkspaceInstance; beta: WorkspaceInstance }> {
  // PROVISION two managed workspaces from the same repository. Each provision creates a real task branch
  // + worktree and persists a bindable active instance (#445).
  const alpha = await provision(svc, "alpha");
  const beta = await provision(svc, "beta");
  expect(alpha.lifecycleState).toBe("active");
  expect(beta.lifecycleState).toBe("active");
  expect(existsSync(alpha.managedWorktreePath)).toBe(true);
  expect(existsSync(beta.managedWorktreePath)).toBe(true);
  expect(alpha.managedWorktreePath).not.toBe(beta.managedWorktreePath);
  return { alpha, beta };
}

async function phaseActivateThenSwitch(
  svc: Services,
  alpha: WorkspaceInstance,
  beta: WorkspaceInstance,
): Promise<void> {
  // ACTIVATE alpha, then SWITCH to beta — the active pointer retargets atomically (#446). Every binding
  // stays scoped to the managed worktree (Git Delivery + editor reuse, #470/#1491).
  const activatedAlpha = await svc.lifecycle.setActive({
    workspaceId: alpha.workspaceId,
    requestedBy: "operator",
    acquireLock: false,
  });
  expectBoundToManagedWorktree(activatedAlpha.binding, alpha);
  expect(pointerStore.get()?.workspaceId).toBe(alpha.workspaceId);

  const switchedBeta = await svc.lifecycle.setActive({
    workspaceId: beta.workspaceId,
    requestedBy: "operator",
    acquireLock: false,
  });
  expectBoundToManagedWorktree(switchedBeta.binding, beta);
  expect(svc.lifecycle.getActive()?.instance.workspaceId).toBe(beta.workspaceId);
}

async function phasePauseThenResume(
  svc: Services,
  alpha: WorkspaceInstance,
  beta: WorkspaceInstance,
): Promise<void> {
  // PAUSE the non-active alpha — beta stays the active context (no mixed-context leak).
  const pausedAlpha = await svc.lifecycle.pause({
    workspaceId: alpha.workspaceId,
    requestedBy: "operator",
  });
  expect(pausedAlpha.instance.lifecycleState).toBe("paused");
  expect(pointerStore.get()?.workspaceId).toBe(beta.workspaceId);

  // RESUME alpha — paused → active, the pointer re-binds to alpha.
  const resumedAlpha = await svc.lifecycle.resume({
    workspaceId: alpha.workspaceId,
    requestedBy: "operator",
  });
  expect(resumedAlpha.instance.lifecycleState).toBe("active");
  expectBoundToManagedWorktree(resumedAlpha.binding, alpha);
  expect(pointerStore.get()?.workspaceId).toBe(alpha.workspaceId);
}

async function phaseRestartReconcile(
  alpha: WorkspaceInstance,
  beta: WorkspaceInstance,
): Promise<Services> {
  // RESTART RECONCILIATION — a FRESH service composition over the same persisted store/pointer
  // (simulating a process restart) restores the last active workspace and verifies both worktrees are
  // healthy (#447 AC1). No silent choice: the pointer target is unambiguous.
  const afterRestart = buildServices();
  const restartReport = await afterRestart.reconciliation.reconcile();
  expect(restartReport.activeRestoration).toEqual({
    kind: "restored",
    workspaceId: alpha.workspaceId,
  });
  for (const id of [alpha.workspaceId, beta.workspaceId]) {
    expect(restartReport.entries.find((e) => e.workspaceId === id)?.status).toBe("healthy");
  }
  // Content-free report (SC3): no managed/repo root leaks into the reconciliation evidence.
  expect(JSON.stringify(restartReport)).not.toContain(managedRoot);
  return afterRestart;
}

async function phaseDriftDetection(
  svc: Services,
  alpha: WorkspaceInstance,
  beta: WorkspaceInstance,
): Promise<void> {
  // DRIFT DETECTION — an external deletion of alpha's worktree surfaces as an explicit recoverable
  // state, never silently dropped (#447 AC2 / #448 drift).
  rmSync(alpha.managedWorktreePath, { recursive: true, force: true });
  const driftReport = await svc.reconciliation.reconcile();
  const alphaDrift = driftReport.entries.find((e) => e.workspaceId === alpha.workspaceId);
  expect(alphaDrift?.status).toBe("missing");
  expect(alphaDrift?.repairable).toBe(true);
  const driftedAlpha = store.getById(alpha.workspaceId);
  expect(driftedAlpha?.lifecycleState).toBe("recovery-required");
  expect(driftedAlpha?.health).toBe("missing");
  expect(driftedAlpha?.driftMarkers).toContain("worktree-missing");
  // beta is untouched — drift is scoped, not fleet-wide.
  expect(driftReport.entries.find((e) => e.workspaceId === beta.workspaceId)?.status).toBe(
    "healthy",
  );
}

async function phaseRepair(svc: Services, alpha: WorkspaceInstance): Promise<void> {
  // REPAIR — operator-approved recreate-worktree deterministically rebuilds alpha from its branch and
  // returns it to a healthy active state (#447 AC3), reusing the one provisioning authority.
  const repaired = await svc.repair.repair({
    workspaceId: alpha.workspaceId,
    requestedBy: "operator",
    strategy: "recreate-worktree",
    operatorApproved: true,
  });
  expect(repaired.applied).toBe(true);
  expect(repaired.outcome).toBe("repaired");
  expect(repaired.status).toBe("healthy");
  expect(existsSync(alpha.managedWorktreePath)).toBe(true);
  expect(store.getById(alpha.workspaceId)?.lifecycleState).toBe("active");
}

async function phaseGovernedCleanup(svc: Services, beta: WorkspaceInstance): Promise<void> {
  // GOVERNED CLEANUP — archive beta, then request → complete removes the worktree, deletes the row, and
  // (had it been active) clears the pointer (#448 AC4). The audit trail stays content-free.
  setState(beta, "archived");
  const cleanupRequested = await svc.cleanup.cleanup({
    workspaceId: beta.workspaceId,
    requestedBy: "operator",
    operatorApproved: true,
    mode: "request",
  });
  expect(cleanupRequested.outcome).toBe("requested");
  expect(store.getById(beta.workspaceId)?.lifecycleState).toBe("cleanup-pending");

  const cleanupCompleted = await svc.cleanup.cleanup({
    workspaceId: beta.workspaceId,
    requestedBy: "operator",
    operatorApproved: true,
    mode: "complete",
  });
  expect(cleanupCompleted.outcome).toBe("completed");
  expect(existsSync(beta.managedWorktreePath)).toBe(false);
  expect(store.getById(beta.workspaceId)).toBeUndefined();

  // Cleanup audit events carry no path / repo root (SC3).
  for (const e of evidence.filter((ev) => ev.json.includes('"operation": "cleanup"'))) {
    expect(e.json).not.toContain(managedRoot);
    expect(e.json).not.toContain(repoRoot);
  }
}

describe("Epic #443 end-to-end task-workspace lifecycle (Issue #450)", () => {
  it("walks provision → activate → switch → pause → resume → restart-reconcile → drift → repair → cleanup", async () => {
    const svc = buildServices();
    const { alpha, beta } = await phaseProvisionTwo(svc);
    await phaseActivateThenSwitch(svc, alpha, beta);
    await phasePauseThenResume(svc, alpha, beta);
    // The fresh composition returned here is the post-restart services; the drift/repair/cleanup phases
    // run against it to prove recovery survives a restart boundary.
    const afterRestart = await phaseRestartReconcile(alpha, beta);
    await phaseDriftDetection(afterRestart, alpha, beta);
    await phaseRepair(afterRestart, alpha);
    await phaseGovernedCleanup(afterRestart, beta);
  });

  it("treats a blocked mutation as a first-class refusal and a typed rejection, never a destructive fallback", async () => {
    const svc = buildServices();
    const ws = await provision(svc, "blocked");

    // Blocked cleanup: a dirty worktree refuses (a successful, non-throwing outcome) and the worktree
    // survives on disk — there is no force-delete fallback (#448 SC4).
    writeFileSync(join(ws.managedWorktreePath, "wip.txt"), "uncommitted work\n");
    setState(ws, "cleanup-pending");
    const refused = await svc.cleanup.cleanup({
      workspaceId: ws.workspaceId,
      requestedBy: "operator",
      operatorApproved: true,
      mode: "complete",
    });
    expect(refused.outcome).toBe("refused");
    expect(refused.refusalReason).toBe("worktree-dirty");
    expect(existsSync(ws.managedWorktreePath)).toBe(true);
    expect(store.getById(ws.workspaceId)).toBeDefined();

    // Blocked transition: an illegal lifecycle transition rejects with a typed code, not a silent no-op.
    setState(ws, "archived");
    await rejectsWithCode(
      () => svc.lifecycle.pause({ workspaceId: ws.workspaceId, requestedBy: "operator" }),
      "ILLEGAL_TRANSITION",
    );
  });

  it("keeps Git Delivery and editor/runtime bound to the active workspace root across a switch (#470/#1491 reuse)", async () => {
    const svc = buildServices();
    const alpha = await provision(svc, "alpha");
    const beta = await provision(svc, "beta");

    // Activation only retargets the governed root: the binding's Git Delivery + editor roots equal the
    // active managed worktree and follow the switch, never falling back to the project root.
    const a = await svc.lifecycle.setActive({
      workspaceId: alpha.workspaceId,
      requestedBy: "operator",
      acquireLock: false,
    });
    expectBoundToManagedWorktree(a.binding, alpha);

    const b = await svc.lifecycle.setActive({
      workspaceId: beta.workspaceId,
      requestedBy: "operator",
      acquireLock: false,
    });
    expectBoundToManagedWorktree(b.binding, beta);

    // The single derivation means there is exactly one active context at a time — no surface remains
    // pointed at alpha after the switch to beta.
    const active = svc.lifecycle.getActive();
    expect(active?.instance.workspaceId).toBe(beta.workspaceId);
    expect(active?.binding.gitDeliveryRoot).toBe(beta.managedWorktreePath);
    expect(active?.binding.gitDeliveryRoot).not.toBe(alpha.managedWorktreePath);
    expect(active?.binding.gitDeliveryRoot).not.toBe(repoRoot);
  });

  it("classifies the live fleet health across active, dirty, and archived workspaces (#448)", async () => {
    const svc = buildServices();
    const healthy = await provision(svc, "healthy");
    const dirty = await provision(svc, "dirty");
    const archived = await provision(svc, "archived");

    // A dirty worktree and an archived instance are explicit, distinct classifications operators rely on.
    writeFileSync(join(dirty.managedWorktreePath, "scratch.txt"), "uncommitted\n");
    setState(archived, "archived");

    const report = await svc.health.report(repoRoot);
    const classify = (id: string): string | undefined =>
      report.entries.find((e) => e.kind === "instance" && e.workspaceId === id)?.classification;
    expect(classify(healthy.workspaceId)).toBe("healthy");
    expect(classify(dirty.workspaceId)).toBe("dirty");
    expect(classify(archived.workspaceId)).toBe("archived");

    // The health report is content-free (SC3): no managed/repo root leaks.
    expect(JSON.stringify(report)).not.toContain(managedRoot);
    expect(JSON.stringify(report)).not.toContain(repoRoot);
  });
});
