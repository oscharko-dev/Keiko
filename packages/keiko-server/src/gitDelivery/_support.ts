import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
import { inspectManagedGitdirIdentity } from "../task-workspace/gitdir-identity.js";
import type { WorkspaceProvisioningService } from "../task-workspace/types.js";

/**
 * A genuine `git worktree add` linkage rooted at `sourceRepo` at `worktreePath`, returning its real
 * gitdir identity. The managed-workspace resolver re-proves a real linked-worktree pointer
 * (gitdir-identity.ts) instead of trusting path shape, so a plain directory never admits (#3347).
 */
export function buildManagedGitWorktree(
  sourceRepo: string,
  worktreePath: string,
  taskBranch: string,
): string {
  execFileSync("git", ["init", "-q"], { cwd: sourceRepo });
  execFileSync("git", ["config", "--local", "commit.gpgsign", "false"], { cwd: sourceRepo });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: sourceRepo });
  execFileSync("git", ["config", "user.name", "Keiko Test"], { cwd: sourceRepo });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "fixture"], { cwd: sourceRepo });
  mkdirSync(dirname(worktreePath), { recursive: true });
  execFileSync("git", ["worktree", "add", "-q", "-b", taskBranch, worktreePath, "HEAD"], {
    cwd: sourceRepo,
  });
  const inspection = inspectManagedGitdirIdentity(worktreePath, sourceRepo);
  if (inspection === undefined) {
    throw new Error("fixture git worktree did not produce a resolvable gitdir identity");
  }
  return inspection.identity;
}

/** The identity fields of one active managed workspace record. */
type ActiveManagedWorkspaceFields = Pick<
  WorkspaceInstance,
  | "workspaceId"
  | "taskId"
  | "repositoryId"
  | "repositoryRoot"
  | "taskBranch"
  | "managedWorktreePath"
  | "gitdirIdentity"
  | "auditCorrelationId"
>;

/**
 * A provisioning service that holds one active, healthy managed workspace on `dev` and refuses to
 * provision or activate another.
 */
export function activeManagedWorkspaceProvisioning(
  fields: ActiveManagedWorkspaceFields,
): WorkspaceProvisioningService {
  const timestamp = new Date(0).toISOString();
  const instance: WorkspaceInstance = {
    schemaVersion: "1",
    ...fields,
    baseBranch: "dev",
    lifecycleState: "active",
    health: "healthy",
    lock: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    driftMarkers: [],
    recoveryHints: [],
  };
  return {
    provision: (): never => {
      throw new Error("not used in this test");
    },
    activate: (): never => {
      throw new Error("not used in this test");
    },
    getInstance: (id: string): WorkspaceInstance | undefined =>
      id === fields.workspaceId ? instance : undefined,
  };
}
