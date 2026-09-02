// Integration coverage for the #448 read-only health service (Issue #448, Epic #443). Materializes
// genuine managed worktrees via the real provisioning service + adapter, then proves the operational
// health classification over live signals (healthy, dirty, missing, archived, cleanup-ready), orphan
// detection by cross-referencing the managed root with the store, and the content-free report (SC3).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createNodeGitWorktreeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { GitWorktreeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type {
  TaskWorkspaceLifecycleState,
  WorkspaceHealthEntry,
  WorkspaceHealthReport,
  WorkspaceInfo,
  WorkspaceInstance,
} from "@oscharko-dev/keiko-contracts";
import { validateWorkspaceHealthReport } from "@oscharko-dev/keiko-contracts/runtime/task-workspace";
import { runMigrations } from "../store/schema.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { buildWorkspaceInstanceStoreOverDatabase, type WorkspaceInstanceStore } from "./store.js";
import {
  buildActiveWorkspacePointerStoreOverDatabase,
  type ActiveWorkspacePointerStore,
} from "./active-store.js";
import { createWorkspaceProvisioningService } from "./provisioning.js";
import { createWorkspaceHealthService } from "./health.js";
import type { WorkspaceHealthService, WorkspaceProvisioningService } from "./types.js";
import { createWorkspaceMutexRegistry } from "./mutex.js";
import { MANAGED_ROOT_MARKER_FILENAME } from "./naming.js";
import { inspectManagedGitdirIdentity } from "./gitdir-identity.js";
import { createBufferedServerLogSink, type ServerLogSink } from "../observability/server-log.js";

const __twMutex = createWorkspaceMutexRegistry();

let repoRoot: string;
let managedRoot: string;
let db: DatabaseSync;
let store: WorkspaceInstanceStore;
let pointerStore: ActiveWorkspacePointerStore;
let idCounter: number;
let nowMs: number;

type AdapterFactory = (
  workspace: WorkspaceInfo,
  correlationId: string,
  fs?: WorkspaceFs,
) => GitWorktreeAdapter;

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

function realAdapter(
  workspace: WorkspaceInfo,
  _correlationId?: string,
  fs?: WorkspaceFs,
): GitWorktreeAdapter {
  return createNodeGitWorktreeAdapter({
    workspace,
    processEnv: { PATH: process.env.PATH ?? "" },
    ...(fs === undefined ? {} : { fs }),
  });
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

function health(
  adapterFactory: AdapterFactory = realAdapter,
  activityLog?: ServerLogSink,
): WorkspaceHealthService {
  return createWorkspaceHealthService({
    store,
    activePointerStore: pointerStore,
    evidenceStore: noopEvidence(),
    managedRoot,
    createAdapter: adapterFactory,
    redactString: (s: string): string => s,
    now: (): number => nowMs,
    newId: (): string => `id-${String(idCounter++)}`,
    mutex: __twMutex,
    ...(activityLog === undefined ? {} : { activityLog }),
  });
}

function retireIdentity(instance: WorkspaceInstance): void {
  const inspection = inspectManagedGitdirIdentity(instance.managedWorktreePath, repoRoot);
  if (inspection === undefined) throw new Error("real linked-worktree identity was not resolved");
  store.upsert({ ...instance, gitdirIdentity: inspection.legacyIdentity });
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
  it("normalizes a malformed correlationId before every health adapter call", async () => {
    await provisionTask("t-correlation-boundary");
    const received: string[] = [];
    const adapterFactory: AdapterFactory = (workspace, correlationId, fs) => {
      received.push(correlationId);
      return realAdapter(workspace, correlationId, fs);
    };
    await health(adapterFactory).report(repoRoot, "req corr\ncontrol");
    expect(received.length).toBeGreaterThan(0);
    expect(new Set(received)).toEqual(new Set([UNKNOWN_CORRELATION_ID]));
  });

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

  it("probes an exact registered workspace below the default denied state directory", async () => {
    managedRoot = join(dirname(managedRoot), ".keiko", "task-workspaces");
    const instance = await provisionTask("t-owned-denied-root");

    const report = await health().report(repoRoot);

    expect(entryFor(report, instance.workspaceId)?.classification).toBe("healthy");
  });

  it("does not report healthy when registered managed-root access cannot be re-proved", async () => {
    const instance = await provisionTask("t-access-revoked");
    rmSync(join(managedRoot, MANAGED_ROOT_MARKER_FILENAME));

    const report = await health().report(repoRoot);

    expect(entryFor(report, instance.workspaceId)?.classification).toBe("recovery-required");
    expect(entryFor(report, instance.workspaceId)?.cleanupEligible).toBe(false);
  });

  // A managed-access denial is an ownership/identity finding, never a containment one. Health used
  // to rewrite the reconciliation facts to `pathContained: false` on every denial, so a workspace
  // registered under the retired identity schema was reported as a PATH ESCAPE and sent an operator
  // into containment incident response for a migration (#3376 review P2).
  it("reports a retired-schema active workspace as identity drift, never as a path escape", async () => {
    const instance = await provisionTask("t-retired-active");
    retireIdentity(instance);
    const activityLog = createBufferedServerLogSink();

    const report = await health(realAdapter, activityLog).report(repoRoot, "health-retired-0001");

    const entry = entryFor(report, instance.workspaceId);
    expect(entry?.driftMarkers).toContain("identity-schema-retired");
    expect(entry?.driftMarkers).not.toContain("path-escape");
    expect(entry?.classification).toBe("stale-pointer");
    expect(entry?.cleanupEligible).toBe(false);
    // The denial itself is evidence on the activity log, joined to this report's correlation.
    const denials = activityLog.events.filter((event) => event.op === "workspace.root.denied");
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({
      correlationId: "health-retired-0001",
      extra: { decision: "denied", reason: "managed-root-identity-schema-retired" },
    });
  });

  // The report has to predict what governed cleanup will decide: a clean terminal row whose identity
  // can no longer be re-proven is still removable (cleanup probes it on the orphan-style contained
  // path), so health must not mark it ineligible on the denial alone (#3376 review P1).
  it("keeps a clean retired-schema terminal workspace cleanup-eligible", async () => {
    const instance = await provisionTask("t-retired-terminal");
    retireIdentity(instance);
    setState(store.getById(instance.workspaceId) ?? instance, "cleanup-pending");

    const report = await health().report(repoRoot);

    const entry = entryFor(report, instance.workspaceId);
    expect(entry?.cleanupEligible).toBe(true);
    expect(entry?.driftMarkers).not.toContain("path-escape");
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
  it("probes a contained orphan below the denied state directory without persisted authority", async () => {
    managedRoot = join(dirname(managedRoot), ".keiko", "task-workspaces");
    const instance = await provisionTask("t-owned-denied-orphan");
    store.delete(instance.workspaceId);

    const report = await health().report(repoRoot);
    const orphan = report.entries.find((entry) => entry.kind === "orphan-worktree");

    expect(orphan?.classification).toBe("orphaned");
    expect(orphan?.cleanupEligible).toBe(false);
  });

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
