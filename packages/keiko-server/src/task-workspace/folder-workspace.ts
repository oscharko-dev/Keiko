// The folder workspace: an ordinary directory that is NOT a Git repository, bound in place so the
// Coding Workbench works in any folder (owner decision 2026-10-30, ADR-0124 D2). It is the Local
// checkout without its repository: no branch is switched, no worktree is created, and no HEAD is
// read, because a folder has none. Repository delivery stays an optional capability of a workspace
// that has a repository; here those tools refuse with the closed reason `repository-required`.
//
// It reuses the active-workspace pointer, the persisted instance store and the lifecycle evidence of
// the managed and Local workspaces, so every consumer that already understands `executionLocation:
// "local"` (list filters, reconciliation, health, cleanup, root access) treats a folder the same way.
// The identity is the directory's filesystem identity, so a folder replaced under the same path is a
// different workspace and the bound pointer fails closed.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TaskWorkspaceLifecycleState } from "@oscharko-dev/keiko-contracts";
import {
  FOLDER_WORKSPACE_BRANCH,
  TASK_WORKSPACE_SCHEMA_VERSION,
  folderWorkspaceHead,
  type WorkspaceInstance,
} from "@oscharko-dev/keiko-contracts/runtime/task-workspace";

import { correlationIdOrUnknown } from "../correlation.js";
import { readProductionWorkspaceHead } from "../coding-runtime/productionWorkspaceHeadReader.js";
import type { UiStore } from "../store/types.js";
import type { ActiveWorkspacePointerStore } from "./active-store.js";
import { recordWorkspaceLifecycle, type WorkspaceSelectionEvidenceDeps } from "./activity-log.js";
import { buildBinding } from "./binding.js";
import { isCanonicalLocalRoot } from "./canonical-root.js";
import { TaskWorkspaceError } from "./errors.js";
import { buildWorkspaceEvent, WORKSPACE_LIFECYCLE_EVIDENCE_KIND } from "./evidence.js";
import { deriveRepositoryId } from "./naming.js";
import type { WorkspaceInstanceStore } from "./store.js";
import type { ActiveWorkspaceView } from "./types.js";

export const FOLDER_PREFIX = "folder:";

type ActivePointer = NonNullable<ReturnType<ActiveWorkspacePointerStore["get"]>>;

export interface FolderSelectionRequest {
  readonly root: string;
  readonly requestedBy: string;
  readonly correlationId?: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// The directory's filesystem identity: the registered path plus its device and inode, so a folder
// deleted and recreated under the same path is a different workspace (ino is 0 where unsupported).
function folderIdentity(root: string): string {
  const stat = statSync(root);
  return digest(`folder\0${root}\0${String(stat.dev)}\0${String(stat.ino)}`);
}

function folderWorkspaceId(identity: string): string {
  return `${FOLDER_PREFIX}${identity}`;
}

function folderTaskId(identity: string): string {
  return `coding-workbench-folder-${identity.slice(0, 16)}`;
}

// A `.git` entry (a directory, or the file a linked worktree has) marks a repository even before
// its first commit, when HEAD names no object yet; a readable HEAD marks one too. Neither check can
// throw (`readProductionWorkspaceHead` answers undefined for anything it cannot read).
function isGitRepository(root: string): boolean {
  return existsSync(join(root, ".git")) || readProductionWorkspaceHead(root, root) !== undefined;
}

function folderInstance(
  root: string,
  identity: string,
  atIso: string,
  previous: WorkspaceInstance | undefined,
): WorkspaceInstance {
  const workspaceId = folderWorkspaceId(identity);
  return {
    schemaVersion: TASK_WORKSPACE_SCHEMA_VERSION,
    workspaceId,
    taskId: folderTaskId(identity),
    repositoryId: deriveRepositoryId(root),
    repositoryRoot: root,
    baseBranch: FOLDER_WORKSPACE_BRANCH,
    taskBranch: FOLDER_WORKSPACE_BRANCH,
    executionLocation: "local",
    workspaceKind: "folder",
    managedWorktreePath: root,
    gitdirIdentity: identity,
    lifecycleState: "active",
    health: "healthy",
    lock: null,
    createdAt: previous?.createdAt ?? atIso,
    updatedAt: atIso,
    lastVerifiedAt: atIso,
    lastVerifiedHead: folderWorkspaceHead(identity),
    driftMarkers: [],
    recoveryHints: [],
    auditCorrelationId: workspaceId,
  };
}

/** The persisted folder workspace a pointer names, re-proven against the live directory. */
export function folderView(
  store: UiStore,
  instances: WorkspaceInstanceStore,
  pointer: ActivePointer,
): ActiveWorkspaceView | undefined {
  const persisted = instances.getById(pointer.workspaceId);
  if (persisted?.workspaceKind !== "folder") return undefined;
  const root = persisted.repositoryRoot;
  if (!store.listProjects().some((project) => project.path === root)) return undefined;
  if (!isCanonicalLocalRoot(root)) return undefined;
  if (folderWorkspaceId(folderIdentity(root)) !== pointer.workspaceId) return undefined;
  const instance: WorkspaceInstance = { ...persisted, lastVerifiedAt: new Date().toISOString() };
  return { instance, binding: buildBinding(instance), pointer };
}

function isCanonicalFolder(root: string): boolean {
  try {
    return isCanonicalLocalRoot(root);
  } catch (cause) {
    throw new TaskWorkspaceError("UNSAFE_PATH", "The folder could not be inspected.", [], {
      cause,
    });
  }
}

function requireFolderRoot(store: UiStore, root: string): string {
  if (!store.listProjects().some((project) => project.path === root)) {
    throw new TaskWorkspaceError("MISSING_REPOSITORY", "Select a registered folder.");
  }
  if (!isCanonicalFolder(root)) {
    throw new TaskWorkspaceError("UNSAFE_PATH", "The folder is not a plain, canonical directory.");
  }
  if (isGitRepository(root)) {
    throw new TaskWorkspaceError(
      "INVALID_REQUEST",
      "This folder is a Git repository; select it as a repository instead.",
    );
  }
  return folderIdentity(root);
}

interface FolderSelectionEvidence {
  readonly request: FolderSelectionRequest;
  readonly identity: string;
  readonly startedAt: number;
  readonly fromState?: TaskWorkspaceLifecycleState | undefined;
  readonly error?: TaskWorkspaceError | undefined;
}

function recordFolderSelection(
  deps: WorkspaceSelectionEvidenceDeps,
  input: FolderSelectionEvidence,
): void {
  const { request, identity, startedAt, fromState, error } = input;
  const recordedAt = deps.now();
  recordWorkspaceLifecycle(deps, {
    evidenceStore: deps.evidenceStore,
    redactString: deps.redactString,
    record: {
      kind: WORKSPACE_LIFECYCLE_EVIDENCE_KIND,
      schemaVersion: TASK_WORKSPACE_SCHEMA_VERSION,
      recordedAt,
      operation: "activate",
      outcome: error?.outcome ?? "activated",
      attempt: 1,
      durationMs: Math.max(0, recordedAt - startedAt),
      worktreeCount: 0,
      event: buildWorkspaceEvent({
        eventId: randomUUID(),
        workspaceId: folderWorkspaceId(identity),
        taskId: folderTaskId(identity),
        type: error === undefined ? "activated" : "transition-rejected",
        at: new Date(recordedAt).toISOString(),
        correlationId: correlationIdOrUnknown(request.correlationId),
        fromState,
        toState: error === undefined ? "active" : undefined,
      }),
    },
    workspaceKind: "folder",
    errorCode: error?.code,
    error,
  });
}

function classifiedSelectionFailure(cause: unknown): TaskWorkspaceError {
  return cause instanceof TaskWorkspaceError
    ? cause
    : new TaskWorkspaceError("PROVISIONING_FAILED", "The folder could not be selected.", [], {
        cause,
      });
}

function activateFolder(
  request: FolderSelectionRequest,
  identity: string,
  instances: WorkspaceInstanceStore,
  pointerStore: ActiveWorkspacePointerStore,
  getActive: () => ActiveWorkspaceView | undefined,
): ActiveWorkspaceView {
  const atIso = new Date().toISOString();
  const workspaceId = folderWorkspaceId(identity);
  instances.upsert(folderInstance(request.root, identity, atIso, instances.getById(workspaceId)));
  pointerStore.set({ workspaceId, setBy: request.requestedBy, atIso });
  const active = getActive();
  if (active === undefined) {
    throw new TaskWorkspaceError("POINTER_DRIFT", "The folder could not be verified.");
  }
  return active;
}

/** Binds a registered ordinary folder as the active workspace, in place and without Git. */
export function selectFolderWorkspace(
  request: FolderSelectionRequest,
  store: UiStore,
  instances: WorkspaceInstanceStore,
  pointerStore: ActiveWorkspacePointerStore,
  getActive: () => ActiveWorkspaceView | undefined,
  deps: WorkspaceSelectionEvidenceDeps,
): ActiveWorkspaceView {
  const startedAt = deps.now();
  let identity = digest(request.root);
  let fromState: TaskWorkspaceLifecycleState | undefined;
  try {
    identity = requireFolderRoot(store, request.root);
    fromState = instances.getById(folderWorkspaceId(identity))?.lifecycleState;
    const active = activateFolder(request, identity, instances, pointerStore, getActive);
    recordFolderSelection(deps, { request, identity, startedAt, fromState });
    return active;
  } catch (cause) {
    const error = classifiedSelectionFailure(cause);
    recordFolderSelection(deps, { request, identity, startedAt, fromState, error });
    throw error;
  }
}
