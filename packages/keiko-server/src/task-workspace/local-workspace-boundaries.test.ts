import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { createNodeGitWorktreeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
import { createInMemoryUiStore } from "../store/index.js";
import { runMigrations } from "../store/schema.js";
import { createBufferedServerLogSink } from "../observability/index.js";
import { buildActiveWorkspacePointerStoreOverDatabase } from "./active-store.js";
import { buildWorkspaceInstanceStoreOverDatabase } from "./store.js";
import { createWorkspaceMutexRegistry } from "./mutex.js";
import { createWorkspaceProvisioningService } from "./provisioning.js";
import { createWorkspaceLifecycleService } from "./lifecycle.js";
import { createWorkspaceHealthService } from "./health.js";
import { createWorkspaceCleanupService } from "./cleanup.js";
import { createWorkspaceRepairService } from "./repair.js";
import { createWorkspaceReconciliationService, reconcileSingleInstance } from "./reconciliation.js";
import { withLocalCheckout } from "./local-checkout.js";
import type { WorkspaceReconciliationServiceDeps } from "./types.js";

let root: string;
let db: DatabaseSync;
let deps: WorkspaceReconciliationServiceDeps;
let local: WorkspaceInstance;
const actor = { requestedBy: "operator", correlationId: "local-boundary-regression" };

function evidenceStore(): EvidenceStore {
  return {
    put: (id): string => id,
    get: (): undefined => undefined,
    list: (): readonly string[] => [],
    delete: (): void => undefined,
  };
}

function git(...args: readonly string[]): void {
  execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
}

function managedServices(): ReturnType<typeof createWorkspaceLifecycleService> {
  return createWorkspaceLifecycleService({
    ...deps,
    provisioning: createWorkspaceProvisioningService(deps),
  });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-local-boundary-")));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Keiko Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(root, "README.md"), "local checkout\n");
  git("add", "README.md");
  git("commit", "-qm", "fixture");
  db = new DatabaseSync(":memory:");
  runMigrations(db);
  let id = 0;
  deps = {
    store: buildWorkspaceInstanceStoreOverDatabase(db),
    activePointerStore: buildActiveWorkspacePointerStoreOverDatabase(db),
    evidenceStore: evidenceStore(),
    managedRoot: join(root, ".keiko-test-worktrees"),
    createAdapter: (workspace, _correlation, fs): ReturnType<typeof createNodeGitWorktreeAdapter> =>
      createNodeGitWorktreeAdapter({
        workspace,
        processEnv: { PATH: process.env.PATH ?? "" },
        ...(fs === undefined ? {} : { fs }),
      }),
    redactString: (value): string => value,
    now: Date.now,
    newId: (): string => `boundary-${String(id++)}`,
    mutex: createWorkspaceMutexRegistry(),
    activityLog: createBufferedServerLogSink(),
  };
  const uiStore = createInMemoryUiStore();
  uiStore.createProject(root, "local fixture");
  const lifecycle = withLocalCheckout(
    managedServices(),
    deps.activePointerStore,
    uiStore,
    deps.store,
    deps,
  );
  const selected = lifecycle.selectLocal({ ...actor, root, branch: "main" });
  const persisted = deps.store.getById(selected.instance.workspaceId);
  if (persisted === undefined) throw new Error("Selected Local instance was not persisted");
  local = persisted;
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function expectLocalUnchanged(): void {
  expect(deps.store.getById(local.workspaceId)).toEqual(local);
  expect(deps.activePointerStore.get()?.workspaceId).toBe(local.workspaceId);
}

describe("Local checkout stays outside managed worktree maintenance", () => {
  it.each(["repository", "global"])("excludes Local from the %s health report", async (scope) => {
    const report = await createWorkspaceHealthService(deps).report(
      scope === "repository" ? root : undefined,
    );
    expect(report.entries).toEqual([]);
    expectLocalUnchanged();
  });

  it("keeps the Local pointer intact during global managed reconciliation", async () => {
    const report = await createWorkspaceReconciliationService(deps).reconcile();
    expect(report.entries).toEqual([]);
    expectLocalUnchanged();
  });

  it("refuses direct single-instance reconciliation before classifying Local as drifted", async () => {
    await expect(
      reconcileSingleInstance(deps, local, Date.now(), actor.requestedBy, actor.correlationId),
    ).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    expectLocalUnchanged();
  });

  it.each(["pause", "prepareHandoff", "resume", "setActive"] as const)(
    "refuses managed %s without changing Local state or pointer",
    async (operation) => {
      await expect(
        managedServices()[operation]({
          ...actor,
          workspaceId: local.workspaceId,
          acquireLock: false,
        }),
      ).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
      expectLocalUnchanged();
    },
  );

  it("does not damage the Local pointer when a caller reads through the managed service", () => {
    expect(managedServices().getActive()).toBeUndefined();
    expectLocalUnchanged();
  });

  it("keeps Local out of managed workspace lists", () => {
    const service = managedServices();
    expect(service.list(root)).toEqual([]);
    expect(service.listAll()).toEqual([]);
  });

  it("refuses a direct managed provisioning activation of Local", async () => {
    await expect(
      createWorkspaceProvisioningService(deps).activate({
        ...actor,
        workspaceId: local.workspaceId,
        taskId: local.taskId,
        acquireLock: false,
      }),
    ).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    expectLocalUnchanged();
  });

  it("refuses managed repair before reconciliation can degrade Local", async () => {
    const service = createWorkspaceRepairService({
      ...deps,
      provisioning: createWorkspaceProvisioningService(deps),
    });
    await expect(
      service.repair({
        ...actor,
        workspaceId: local.workspaceId,
        strategy: "abandon-and-cleanup",
        operatorApproved: true,
      }),
    ).rejects.toMatchObject({ code: "REPAIR_NOT_APPLICABLE" });
    expectLocalUnchanged();
  });

  it.each(["request", "complete"] as const)(
    "refuses managed cleanup %s for Local",
    async (mode) => {
      local = deps.store.upsert({
        ...local,
        lifecycleState: mode === "request" ? "archived" : "cleanup-pending",
      });
      await expect(
        createWorkspaceCleanupService(deps).cleanup({
          ...actor,
          workspaceId: local.workspaceId,
          mode,
          operatorApproved: true,
        }),
      ).rejects.toMatchObject({ code: "CLEANUP_NOT_ELIGIBLE" });
      expectLocalUnchanged();
    },
  );
});
