import { resolve } from "node:path";
import type { WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
import { taskWorkspaceProvisioningSource } from "@oscharko-dev/keiko-contracts/runtime/task-workspace";
import { TaskWorkspaceError } from "../task-workspace/errors.js";
import type {
  WorkspaceLifecycleService,
  WorkspaceProvisioningService,
} from "../task-workspace/types.js";

/**
 * Code Mode's `worktree_create` (#3903 AC4). The producer's own implementation would add an
 * unmanaged git worktree outside the task workspace, so it never runs: the policy asks the human
 * in every mode, and an approved request is provisioned by Keiko's managed task-workspace owner as
 * a new task workspace, branched from the run's current task branch. The run keeps its own
 * workspace binding: the new workspace opens as its own task. A task of the run's workspace then
 * continues there only as a fork started in the new workspace (`source`), never by moving the run.
 */
export interface NativeWorktreeProvisionRequest {
  readonly runId: string;
  /** The run's task workspace, which must still be the active one. */
  readonly workspaceRoot: string;
  /** The name the producer's call carried, checked by the policy. */
  readonly name: string;
  readonly correlationId: string;
}

export type NativeWorktreeProvisionResult =
  | {
      readonly ok: true;
      readonly taskId: string;
      readonly branch: string;
      readonly created: boolean;
    }
  | { readonly ok: false; readonly reason: NativeWorktreeRefusal };

export type NativeWorktreeRefusal = "unavailable" | "workspace-changed" | "provision-failed";

/** How the run's `worktree_create` ended, for the policy decision line. */
export type NativeWorktreeDisposition = "provisioned" | "resumed" | NativeWorktreeRefusal;

/** A managed workspace another one was provisioned from: its identity and its root. */
export interface NativeWorkspaceSource {
  readonly workspaceId: string;
  readonly root: string;
}

export interface NativeWorktreeProvisionPort {
  readonly provision: (
    request: NativeWorktreeProvisionRequest,
  ) => Promise<NativeWorktreeProvisionResult>;
  /**
   * The workspace `workspaceId` was provisioned from (#3903 AC4, #3902 AC3): the one other managed
   * workspace of the same repository whose task branch is its base branch. Absent when there is
   * none, more than one, or it is not a settled workspace.
   */
  readonly source?: ((workspaceId: string) => NativeWorkspaceSource | undefined) | undefined;
}

/** Who the managed owner records as the requester: the human approved it for this run. */
const NATIVE_WORKTREE_REQUESTER = "coding-runtime-native-worktree";

export interface NativeWorktreeProvisionPortInput {
  readonly lifecycle:
    | (Pick<WorkspaceLifecycleService, "getActive"> &
        Partial<Pick<WorkspaceLifecycleService, "listAll">>)
    | undefined;
  readonly provisioning: Pick<WorkspaceProvisioningService, "provision"> | undefined;
}

/** The production port over the existing task-workspace lifecycle and provisioning owners. */
export function createNativeWorktreeProvisionPort(
  input: NativeWorktreeProvisionPortInput,
): NativeWorktreeProvisionPort {
  const lifecycle = input.lifecycle;
  return {
    provision: (request) => provisionNativeWorktree(input, request),
    ...(lifecycle?.listAll === undefined
      ? {}
      : {
          source: (workspaceId: string): NativeWorkspaceSource | undefined =>
            provisioningSource(lifecycle.listAll?.() ?? [], workspaceId),
        }),
  };
}

/** The workspace `workspaceId` was branched from, among the persisted instances. */
export function provisioningSource(
  instances: readonly WorkspaceInstance[],
  workspaceId: string,
): NativeWorkspaceSource | undefined {
  const source = taskWorkspaceProvisioningSource(instances, workspaceId);
  return source === undefined
    ? undefined
    : { workspaceId: source.workspaceId, root: source.managedWorktreePath };
}

async function provisionNativeWorktree(
  input: NativeWorktreeProvisionPortInput,
  request: NativeWorktreeProvisionRequest,
): Promise<NativeWorktreeProvisionResult> {
  const { lifecycle, provisioning } = input;
  if (lifecycle === undefined || provisioning === undefined)
    return { ok: false, reason: "unavailable" };
  const active = lifecycle.getActive(request.correlationId);
  if (active === undefined || resolve(active.binding.activeRoot) !== resolve(request.workspaceRoot))
    return { ok: false, reason: "workspace-changed" };
  try {
    const provisioned = await provisioning.provision({
      repositoryRequestPath: active.instance.repositoryRoot,
      taskId: request.name,
      baseBranch: active.instance.taskBranch,
      requestedBy: NATIVE_WORKTREE_REQUESTER,
      correlationId: request.correlationId,
    });
    return {
      ok: true,
      taskId: provisioned.instance.taskId,
      branch: provisioned.instance.taskBranch,
      created: provisioned.created,
    };
  } catch (error) {
    // The owner already recorded the classified failure with its frames under this correlation.
    if (error instanceof TaskWorkspaceError) return { ok: false, reason: "provision-failed" };
    throw error;
  }
}

/** What the model reads as the result of its blocked call, and how the call ended. */
export function nativeWorktreeAnswer(result: NativeWorktreeProvisionResult): {
  readonly message: string;
  readonly disposition: NativeWorktreeDisposition;
} {
  if (result.ok)
    return {
      disposition: result.created ? "provisioned" : "resumed",
      message:
        `Keiko ${result.created ? "created" : "found"} the managed task workspace ` +
        `"${result.taskId}" on branch ${result.branch}. This is creation only: it opens as ` +
        "its own task in Task Workspaces, and this session does not move there; the person can " +
        "continue this task there by switching to it and forking the task. Keep working " +
        "in the current workspace.",
    };
  return { disposition: result.reason, message: NATIVE_WORKTREE_REFUSALS[result.reason] };
}

const NATIVE_WORKTREE_REFUSALS: Readonly<Record<NativeWorktreeRefusal, string>> = {
  unavailable:
    "Keiko refused this action: managed task workspaces are not available here. Keep working in the current workspace.",
  "workspace-changed":
    "Keiko refused this action: the run's task workspace is no longer the active one. Keep working in the current workspace.",
  "provision-failed":
    "Keiko refused this action: the managed task workspace could not be created. Keep working in the current workspace.",
};
