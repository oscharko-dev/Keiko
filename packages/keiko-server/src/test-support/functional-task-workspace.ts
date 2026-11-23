// The production task-workspace owners a functional pipeline provisions its managed worktree
// through (#4492): an in-memory database, the real Git adapter and the real provisioning,
// lifecycle and reconciliation services, exactly as the server composes them.

import { DatabaseSync } from "node:sqlite";

import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { createNodeGitWorktreeAdapter } from "@oscharko-dev/keiko-tools/internal/git-mutation";

import { runMigrations } from "../store/schema.js";
import { buildActiveWorkspacePointerStoreOverDatabase } from "../task-workspace/active-store.js";
import { createWorkspaceLifecycleService } from "../task-workspace/lifecycle.js";
import { createWorkspaceMutexRegistry } from "../task-workspace/mutex.js";
import { createWorkspaceProvisioningService } from "../task-workspace/provisioning.js";
import { reconcileSingleInstance } from "../task-workspace/reconciliation.js";
import { buildWorkspaceInstanceStoreOverDatabase } from "../task-workspace/store.js";

/** A fixed clock for the task-workspace owners, so provisioning evidence is deterministic. */
const FUNCTIONAL_WORKSPACE_NOW = 1_700_000_000_000;

type FunctionalReconciliationDeps = Parameters<typeof reconcileSingleInstance>[0];

/** The task-workspace owners a functional pipeline provisions its managed worktree through. */
export interface FunctionalTaskWorkspaceOwners {
  readonly db: DatabaseSync;
  readonly instances: ReturnType<typeof buildWorkspaceInstanceStoreOverDatabase>;
  readonly activePointerStore: ReturnType<typeof buildActiveWorkspacePointerStoreOverDatabase>;
  readonly provisioning: ReturnType<typeof createWorkspaceProvisioningService>;
  readonly lifecycle: ReturnType<typeof createWorkspaceLifecycleService>;
  readonly reconciliation: FunctionalReconciliationDeps;
}

/** The production task-workspace owners over an in-memory database and the real Git adapter. */
export function createFunctionalTaskWorkspaceOwners(
  managedRoot: string,
  evidenceStore: EvidenceStore,
): FunctionalTaskWorkspaceOwners {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  const instances = buildWorkspaceInstanceStoreOverDatabase(db);
  const activePointerStore = buildActiveWorkspacePointerStoreOverDatabase(db);
  const mutex = createWorkspaceMutexRegistry();
  const shared = {
    store: instances,
    evidenceStore,
    managedRoot,
    redactString: (value: string): string => value,
    now: (): number => FUNCTIONAL_WORKSPACE_NOW,
    mutex,
  };
  const createAdapter: FunctionalReconciliationDeps["createAdapter"] = (workspace) =>
    createNodeGitWorktreeAdapter({ workspace, processEnv: { PATH: process.env.PATH ?? "" } });
  const provisioning = createWorkspaceProvisioningService({
    ...shared,
    createAdapter,
    newId: (): string => "functional-id",
  });
  const lifecycle = createWorkspaceLifecycleService({
    ...shared,
    activePointerStore,
    provisioning,
    newId: (): string => "functional-lifecycle-id",
  });
  const reconciliation: FunctionalReconciliationDeps = {
    ...shared,
    activePointerStore,
    createAdapter,
    newId: (): string => "functional-reconcile-id",
  };
  return { db, instances, activePointerStore, provisioning, lifecycle, reconciliation };
}

/**
 * Provisions the managed task worktree of `repository` (branch `main`), makes it the active
 * workspace and reconciles its verified head, as the Workbench does when a person picks a
 * repository. Answers the worktree's path.
 */
export async function provisionFunctionalTaskWorkspace(
  owners: FunctionalTaskWorkspaceOwners,
  repository: string,
  taskId: string,
): Promise<string> {
  const provisioned = await owners.provisioning.provision({
    repositoryRequestPath: repository,
    taskId,
    baseBranch: "main",
    requestedBy: "functional",
  });
  await owners.lifecycle.setActive({
    workspaceId: provisioned.instance.workspaceId,
    requestedBy: "functional",
    acquireLock: false,
  });
  await reconcileSingleInstance(
    owners.reconciliation,
    provisioned.instance,
    FUNCTIONAL_WORKSPACE_NOW,
  );
  return provisioned.instance.managedWorktreePath;
}
