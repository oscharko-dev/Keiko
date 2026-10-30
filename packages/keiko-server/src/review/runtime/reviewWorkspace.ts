// The review instance's own workspace view (ADR-0182 D1, Issue #4135).
//
// The coding runtime composition binds a run to "the active workspace". The review instance has
// its own lifecycle view that names exactly one workspace: the hardened, detached review worktree
// of the review in flight (Issue #4133), at its head commit. It is never the user's active task
// workspace pointer, never persisted, never listed by the task workspace routes, and it cannot be
// switched, paused or handed off: the user's Coding Workbench keeps its own active workspace and
// run slot throughout. Between reviews the view is unbound, so no run can start.

import { createHash } from "node:crypto";

import {
  TASK_WORKSPACE_SCHEMA_VERSION,
  type WorkspaceInstance,
} from "@oscharko-dev/keiko-contracts/runtime/task-workspace";
import type { ActiveWorkspaceView, WorkspaceLifecycleService } from "../../task-workspace/types.js";

/** The one review worktree a review run is bound to. */
interface ReviewWorkspaceBinding {
  /** The review run's own identity (Issue #4136 run id). */
  readonly reviewRunId: string;
  /** Canonical absolute path of the detached review worktree. */
  readonly worktreeRoot: string;
  /** The repository whose object store holds the reviewed commits. */
  readonly repositoryRoot: string;
  readonly headSha: string;
}

export interface ReviewWorkspaceLifecycle extends WorkspaceLifecycleService {
  /** Binds the view to one review worktree; refuses while another review is bound. */
  bind(binding: ReviewWorkspaceBinding): boolean;
  /** Unbinds the view; idempotent. */
  clear(): void;
  bound(): ReviewWorkspaceBinding | undefined;
}

class ReviewWorkspaceRefusedError extends Error {
  public constructor() {
    super("review workspace views are server-owned and immutable");
    this.name = "ReviewWorkspaceRefusedError";
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** The review run's synthetic workspace identity: stable per review run, never a task workspace. */
export function reviewWorkspaceId(reviewRunId: string): string {
  return `review-${digest(reviewRunId).slice(0, 24)}`;
}

function instanceFor(binding: ReviewWorkspaceBinding, nowIso: string): WorkspaceInstance {
  const short = digest(binding.reviewRunId).slice(0, 16);
  return {
    schemaVersion: TASK_WORKSPACE_SCHEMA_VERSION,
    workspaceId: reviewWorkspaceId(binding.reviewRunId),
    taskId: `review-${short}`,
    repositoryId: `review-${digest(binding.repositoryRoot).slice(0, 24)}`,
    repositoryRoot: binding.repositoryRoot,
    baseBranch: `keiko-review/${short}-base`,
    taskBranch: `keiko-review/${short}`,
    executionLocation: "worktree",
    managedWorktreePath: binding.worktreeRoot,
    gitdirIdentity: digest(`${binding.repositoryRoot}\u0000${binding.worktreeRoot}`),
    lifecycleState: "active",
    health: "healthy",
    lock: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    lastVerifiedAt: nowIso,
    lastVerifiedHead: binding.headSha,
    driftMarkers: [],
    recoveryHints: [],
    auditCorrelationId: short,
  };
}

function viewFor(binding: ReviewWorkspaceBinding, nowIso: string): ActiveWorkspaceView {
  const instance = instanceFor(binding, nowIso);
  return {
    instance,
    binding: {
      schemaVersion: TASK_WORKSPACE_SCHEMA_VERSION,
      workspaceId: instance.workspaceId,
      taskId: instance.taskId,
      activeRoot: binding.worktreeRoot,
      boundSurfaces: ["review"],
      gitDeliveryRoot: binding.worktreeRoot,
      editorProjectRoot: binding.worktreeRoot,
    },
    pointer: {
      workspaceId: instance.workspaceId,
      setBy: "keiko-review",
      setAt: nowIso,
      updatedAt: nowIso,
    },
  };
}

function refused(): never {
  throw new ReviewWorkspaceRefusedError();
}

/** Creates the review instance's workspace view; `now` is injectable for tests. */
export function createReviewWorkspaceLifecycle(
  now: () => Date = (): Date => new Date(),
): ReviewWorkspaceLifecycle {
  let current:
    { readonly binding: ReviewWorkspaceBinding; readonly view: ActiveWorkspaceView } | undefined;
  return {
    bind: (binding): boolean => {
      if (current !== undefined) return false;
      current = { binding, view: viewFor(binding, now().toISOString()) };
      return true;
    },
    clear: (): void => {
      current = undefined;
    },
    bound: () => current?.binding,
    getActive: () => current?.view,
    list: (repositoryRoot) =>
      current?.binding.repositoryRoot === repositoryRoot ? [current.view.instance] : [],
    listAll: () => (current === undefined ? [] : [current.view.instance]),
    setActive: () => Promise.reject(new ReviewWorkspaceRefusedError()),
    clearActive: refused,
    pause: () => Promise.reject(new ReviewWorkspaceRefusedError()),
    resume: () => Promise.reject(new ReviewWorkspaceRefusedError()),
    prepareHandoff: () => Promise.reject(new ReviewWorkspaceRefusedError()),
  };
}
