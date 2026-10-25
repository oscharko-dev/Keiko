import { resolve } from "node:path";
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
 * workspace binding: the new workspace opens as its own task, and a session move into it stays
 * refused until a governed rebinding exists.
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

export interface NativeWorktreeProvisionPort {
  readonly provision: (
    request: NativeWorktreeProvisionRequest,
  ) => Promise<NativeWorktreeProvisionResult>;
}

/** Who the managed owner records as the requester: the human approved it for this run. */
const NATIVE_WORKTREE_REQUESTER = "coding-runtime-native-worktree";

export interface NativeWorktreeProvisionPortInput {
  readonly lifecycle: Pick<WorkspaceLifecycleService, "getActive"> | undefined;
  readonly provisioning: Pick<WorkspaceProvisioningService, "provision"> | undefined;
}

/** The production port over the existing task-workspace lifecycle and provisioning owners. */
export function createNativeWorktreeProvisionPort(
  input: NativeWorktreeProvisionPortInput,
): NativeWorktreeProvisionPort {
  return { provision: (request) => provisionNativeWorktree(input, request) };
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
        "its own task in Task Workspaces, and this session does not move there; keep working " +
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
