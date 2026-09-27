import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { gitEnv, GIT_BASE_ARGS, resolveGitExecutable } from "@oscharko-dev/keiko-git";
import {
  TASK_WORKSPACE_SCHEMA_VERSION,
  type WorkspaceInstance,
} from "@oscharko-dev/keiko-contracts/runtime/task-workspace";

import type { UiStore } from "../store/types.js";
import { readProductionWorkspaceHead } from "../coding-runtime/productionWorkspaceHeadReader.js";
import type { ActiveWorkspacePointerStore } from "./active-store.js";
import { buildBinding } from "./binding.js";
import { logWorkspaceLifecycle, type WorkspaceActivityLogSeam } from "./activity-log.js";
import { TaskWorkspaceError } from "./errors.js";
import { deriveRepositoryId } from "./naming.js";
import type { WorkspaceInstanceStore } from "./store.js";
import type {
  ActiveWorkspaceView,
  SetActiveWorkspaceRequest,
  WorkspaceLifecycleService,
} from "./types.js";

const LOCAL_PREFIX = "local:";
const GIT_TIMEOUT_MS = 5_000;
const GIT_OBJECT_TIMEOUT_MS = 60_000;
const GIT_OBJECT_BUFFER_BYTES = 128 * 1024 * 1024;
const GIT_OBJECT_ID = /^[a-f0-9]{40,64}$/u;

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function gitOutput(
  root: string,
  args: readonly string[],
  options: { readonly input?: string; readonly timeout?: number; readonly maxBuffer?: number } = {},
): string {
  const env = gitEnv();
  const executable = resolveGitExecutable(env, root);
  if (!executable.ok) {
    throw new TaskWorkspaceError("REPOSITORY_UNREACHABLE", "Trusted Git executable unavailable.", [
      executable.reason,
    ]);
  }
  return execFileSync(
    executable.path,
    [
      ...GIT_BASE_ARGS,
      "-C",
      root,
      "-c",
      "core.fsmonitor=false",
      "-c",
      `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
      "-c",
      "submodule.recurse=false",
      ...args,
    ],
    {
      encoding: "utf8",
      env,
      timeout: options.timeout ?? GIT_TIMEOUT_MS,
      maxBuffer: options.maxBuffer ?? 4_096,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
      ...(options.input === undefined ? {} : { input: options.input }),
    },
  ).trim();
}

function git(root: string, ...args: readonly string[]): string {
  return gitOutput(root, args);
}

function targetTreeObjectsAvailable(root: string, branch: string): boolean {
  const options = { timeout: GIT_OBJECT_TIMEOUT_MS, maxBuffer: GIT_OBJECT_BUFFER_BYTES };
  const tree = gitOutput(root, ["ls-tree", "-r", "-t", "-z", `refs/heads/${branch}`], options);
  const objects = targetTreeObjectMap(tree);
  if (objects === undefined) return false;
  if (objects.size === 0) return true;
  const ids = [...objects.keys()];
  const checked = gitOutput(root, ["cat-file", "--batch-check"], {
    ...options,
    input: `${ids.join("\n")}\n`,
  }).split("\n");
  return (
    checked.length === ids.length &&
    checked.every((line, index) => batchObjectMatches(line, ids[index], objects))
  );
}

function targetTreeObjectMap(tree: string): Map<string, string> | undefined {
  const objects = new Map<string, string>();
  for (const entry of tree.split("\0")) {
    if (entry.length === 0) continue;
    const header = entry.slice(0, entry.indexOf("\t")).split(" ");
    const type = header[1];
    const oid = header[2];
    if ((type !== "blob" && type !== "tree" && type !== "commit") || !GIT_OBJECT_ID.test(oid ?? ""))
      return undefined;
    if (type !== "commit" && oid !== undefined) objects.set(oid, type);
  }
  return objects;
}

function batchObjectMatches(
  line: string,
  oid: string | undefined,
  objects: Map<string, string>,
): boolean {
  const [actualOid, actualType, size] = line.split(" ");
  return (
    oid !== undefined &&
    actualOid === oid &&
    actualType === objects.get(oid) &&
    /^\d+$/u.test(size ?? "")
  );
}

function gitNoMatch(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 1;
}

function hasExecutableFilters(root: string): boolean {
  try {
    return (
      git(
        root,
        "config",
        "--includes",
        "--name-only",
        "--get-regexp",
        String.raw`^filter\..*\.(process|smudge|clean)$`,
      ).length > 0
    );
  } catch (error) {
    if (gitNoMatch(error)) return false;
    throw error;
  }
}

function currentBranch(root: string): string | undefined {
  try {
    return git(root, "symbolic-ref", "--quiet", "--short", "HEAD");
  } catch (error) {
    if (gitNoMatch(error)) return undefined;
    throw error;
  }
}

function localIdentity(root: string): string | undefined {
  if (realpathSync(root) !== root || git(root, "rev-parse", "--show-toplevel") !== root) {
    return undefined;
  }
  const gitdir = realpathSync(git(root, "rev-parse", "--absolute-git-dir"));
  const stat = statSync(gitdir);
  return digest(`${root}\0${gitdir}\0${String(stat.dev)}\0${String(stat.ino)}`);
}

function localHead(root: string): string | undefined {
  const commonDir = realpathSync(
    git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"),
  );
  if (basename(commonDir) !== ".git") return undefined;
  const owner = dirname(commonDir);
  if (realpathSync(owner) !== owner || realpathSync(join(owner, ".git")) !== commonDir)
    return undefined;
  return readProductionWorkspaceHead(root, owner);
}

function localView(
  store: UiStore,
  instances: WorkspaceInstanceStore,
  pointer: NonNullable<ReturnType<ActiveWorkspacePointerStore["get"]>>,
): ActiveWorkspaceView | undefined {
  const persisted = instances.getById(pointer.workspaceId);
  if (persisted?.executionLocation !== "local") return undefined;
  for (const project of store.listProjects()) {
    const root = project.path;
    if (persisted.repositoryRoot !== root) continue;
    const identity = localIdentity(root);
    if (identity === undefined || `${LOCAL_PREFIX}${identity}` !== pointer.workspaceId) continue;
    const branch = currentBranch(root);
    const head = localHead(root);
    if (branch !== persisted.taskBranch || head === undefined) return undefined;
    const instance: WorkspaceInstance = {
      ...persisted,
      baseBranch: branch,
      taskBranch: branch,
      updatedAt: pointer.updatedAt,
      lastVerifiedAt: pointer.updatedAt,
      lastVerifiedHead: head,
    };
    return { instance, binding: buildBinding(instance), pointer };
  }
  return undefined;
}

export interface LocalCheckoutLifecycle extends WorkspaceLifecycleService {
  readonly selectLocal: (request: {
    readonly root: string;
    readonly branch: string;
    readonly requestedBy: string;
    readonly correlationId?: string;
  }) => ActiveWorkspaceView;
}

interface LocalSelectionRequest {
  readonly root: string;
  readonly branch: string;
  readonly requestedBy: string;
  readonly correlationId?: string;
}

function validatedLocalIdentity(store: UiStore, root: string, branch: string): string {
  if (!store.listProjects().some((project) => project.path === root))
    throw new TaskWorkspaceError("MISSING_REPOSITORY", "Select a registered repository.");
  let identity: string | undefined;
  try {
    identity = localIdentity(root);
  } catch (cause) {
    throw new TaskWorkspaceError(
      "REPOSITORY_UNREACHABLE",
      "The local checkout could not be inspected; retry when Git is available.",
      [],
      { cause },
    );
  }
  if (identity === undefined || branch.length === 0 || branch.startsWith("-"))
    throw new TaskWorkspaceError("INVALID_BASE_BRANCH", "The local branch is unavailable.");
  try {
    git(root, "check-ref-format", "--branch", branch);
    git(root, "show-ref", "--verify", `refs/heads/${branch}`);
  } catch (error) {
    throw new TaskWorkspaceError("INVALID_BASE_BRANCH", "Select an existing local branch.", [], {
      cause: error,
    });
  }
  return identity;
}

function requireAvailableBranchObjects(
  request: LocalSelectionRequest,
  identity: string,
  activityLog: WorkspaceActivityLogSeam,
): void {
  const { root, branch } = request;
  const startedAt = Date.now();
  let available: boolean;
  try {
    available = targetTreeObjectsAvailable(root, branch);
  } catch (cause) {
    const error = new TaskWorkspaceError(
      "REPOSITORY_UNREACHABLE",
      "The selected branch could not be inspected; retry when Git is available.",
      [],
      { cause },
    );
    logBranchInventoryFailure(request, identity, activityLog, startedAt, error);
    throw error;
  }
  if (available) return;
  const error = new TaskWorkspaceError(
    "BRANCH_CONFLICT",
    "The selected branch has unavailable Git objects; hydrate it outside the Workbench.",
  );
  logBranchInventoryFailure(request, identity, activityLog, startedAt, error);
  throw error;
}

function logBranchInventoryFailure(
  request: LocalSelectionRequest,
  identity: string,
  activityLog: WorkspaceActivityLogSeam,
  startedAt: number,
  error: TaskWorkspaceError,
): void {
  logWorkspaceLifecycle(activityLog, {
    operation: "activate",
    outcome: error.outcome,
    workspaceId: `${LOCAL_PREFIX}${identity}`,
    taskId: `coding-workbench-local-${identity.slice(0, 16)}`,
    correlationId: request.correlationId,
    attempt: 1,
    durationMs: Math.max(0, Date.now() - startedAt),
    worktreeCount: 0,
    baseBranch: request.branch,
    errorCode: error.code,
    error,
  });
}

function switchLocalBranch(root: string, branch: string): void {
  if (currentBranch(root) === branch) return;
  if (hasExecutableFilters(root))
    throw new TaskWorkspaceError(
      "BRANCH_CONFLICT",
      "The checkout has executable Git filters; switch branches outside the Workbench.",
    );
  try {
    git(root, "switch", "--no-guess", branch);
  } catch (error) {
    throw new TaskWorkspaceError(
      "BRANCH_CONFLICT",
      "Git could not switch this checkout to the selected branch.",
      [],
      { cause: error },
    );
  }
}

function verifiedLocalHead(root: string, identity: string): string {
  const head = localHead(root);
  if (head === undefined)
    throw new TaskWorkspaceError("REPOSITORY_UNREACHABLE", "Git HEAD is unavailable.");
  if (localIdentity(root) !== identity)
    throw new TaskWorkspaceError("POINTER_DRIFT", "The local checkout changed during selection.");
  return head;
}

function localInstance(
  request: LocalSelectionRequest,
  identity: string,
  head: string,
  atIso: string,
  previous: WorkspaceInstance | undefined,
): WorkspaceInstance {
  const { root, branch } = request;
  const workspaceId = `${LOCAL_PREFIX}${identity}`;
  return {
    schemaVersion: TASK_WORKSPACE_SCHEMA_VERSION,
    workspaceId,
    taskId: `coding-workbench-local-${identity.slice(0, 16)}`,
    repositoryId: deriveRepositoryId(root),
    repositoryRoot: root,
    baseBranch: branch,
    taskBranch: branch,
    executionLocation: "local",
    managedWorktreePath: root,
    gitdirIdentity: identity,
    lifecycleState: "active",
    health: "healthy",
    lock: null,
    createdAt: previous?.createdAt ?? atIso,
    updatedAt: atIso,
    lastVerifiedAt: atIso,
    lastVerifiedHead: head,
    driftMarkers: [],
    recoveryHints: [],
    auditCorrelationId: workspaceId,
  };
}

function selectLocalCheckout(
  request: LocalSelectionRequest,
  store: UiStore,
  instances: WorkspaceInstanceStore,
  pointerStore: ActiveWorkspacePointerStore,
  getActive: () => ActiveWorkspaceView | undefined,
  activityLog: WorkspaceActivityLogSeam,
): ActiveWorkspaceView {
  const identity = validatedLocalIdentity(store, request.root, request.branch);
  requireAvailableBranchObjects(request, identity, activityLog);
  switchLocalBranch(request.root, request.branch);
  const head = verifiedLocalHead(request.root, identity);
  const atIso = new Date().toISOString();
  const workspaceId = `${LOCAL_PREFIX}${identity}`;
  instances.upsert(localInstance(request, identity, head, atIso, instances.getById(workspaceId)));
  pointerStore.set({ workspaceId, setBy: request.requestedBy, atIso });
  const active = getActive();
  if (active === undefined)
    throw new TaskWorkspaceError("POINTER_DRIFT", "The local checkout could not be verified.");
  logWorkspaceLifecycle(activityLog, {
    operation: "activate",
    outcome: "activated",
    workspaceId,
    taskId: active.instance.taskId,
    correlationId: request.correlationId,
    attempt: 1,
    durationMs: 0,
    worktreeCount: 0,
    baseBranch: request.branch,
  });
  return active;
}

function logInvalidatedLocalPointer(
  activityLog: WorkspaceActivityLogSeam,
  pointer: NonNullable<ReturnType<ActiveWorkspacePointerStore["get"]>>,
  correlationId: string | undefined,
  startedAt: number,
  cause?: unknown,
): void {
  const error =
    cause === undefined
      ? new TaskWorkspaceError("POINTER_DRIFT", "The local checkout binding changed.")
      : new TaskWorkspaceError("REPOSITORY_UNREACHABLE", "The local checkout is unavailable.", [], {
          cause,
        });
  logWorkspaceLifecycle(activityLog, {
    operation: "activate",
    outcome: error.outcome,
    workspaceId: pointer.workspaceId,
    taskId: `coding-workbench-local-${pointer.workspaceId.slice(LOCAL_PREFIX.length, LOCAL_PREFIX.length + 16)}`,
    correlationId,
    attempt: 1,
    durationMs: Math.max(0, Date.now() - startedAt),
    worktreeCount: 0,
    errorCode: error.code,
    error,
  });
}

function setActiveWithLocal(
  request: SetActiveWorkspaceRequest,
  managed: WorkspaceLifecycleService,
  store: UiStore,
  instances: WorkspaceInstanceStore,
  pointerStore: ActiveWorkspacePointerStore,
  getActive: () => ActiveWorkspaceView | undefined,
  activityLog: WorkspaceActivityLogSeam,
): Promise<ActiveWorkspaceView> {
  const instance = instances.getById(request.workspaceId);
  if (instance?.executionLocation !== "local") return managed.setActive(request);
  if (request.acquireLock)
    throw new TaskWorkspaceError(
      "LOCK_CONTENTION",
      "Local checkouts do not acquire managed locks.",
    );
  return Promise.resolve(
    selectLocalCheckout(
      {
        root: instance.repositoryRoot,
        branch: instance.taskBranch,
        requestedBy: request.requestedBy,
        ...(request.correlationId === undefined ? {} : { correlationId: request.correlationId }),
      },
      store,
      instances,
      pointerStore,
      getActive,
      activityLog,
    ),
  );
}

export function withLocalCheckout(
  managed: WorkspaceLifecycleService,
  pointerStore: ActiveWorkspacePointerStore,
  store: UiStore,
  instances: WorkspaceInstanceStore,
  activityLog: WorkspaceActivityLogSeam = {},
): LocalCheckoutLifecycle {
  let lastInvalidatedPointer: string | null = null;
  const logInvalidation = (
    pointer: NonNullable<ReturnType<ActiveWorkspacePointerStore["get"]>>,
    correlationId: string | undefined,
    startedAt: number,
    cause?: unknown,
  ): void => {
    const key = `${pointer.workspaceId}\0${pointer.updatedAt}`;
    if (lastInvalidatedPointer === key) return;
    lastInvalidatedPointer = key;
    logInvalidatedLocalPointer(activityLog, pointer, correlationId, startedAt, cause);
  };
  const getActive = (correlationId?: string): ActiveWorkspaceView | undefined => {
    const pointer = pointerStore.get();
    if (pointer?.workspaceId.startsWith(LOCAL_PREFIX)) {
      const startedAt = Date.now();
      let active: ActiveWorkspaceView | undefined;
      try {
        active = localView(store, instances, pointer);
      } catch (cause) {
        logInvalidation(pointer, correlationId, startedAt, cause);
        return undefined;
      }
      if (active === undefined) logInvalidation(pointer, correlationId, startedAt);
      else lastInvalidatedPointer = null;
      return active;
    }
    lastInvalidatedPointer = null;
    return managed.getActive(correlationId);
  };
  return {
    ...managed,
    list: (repositoryRoot): readonly WorkspaceInstance[] =>
      managed.list(repositoryRoot).filter((instance) => instance.executionLocation !== "local"),
    listAll: (): readonly WorkspaceInstance[] =>
      managed.listAll().filter((instance) => instance.executionLocation !== "local"),
    getActive,
    setActive: (request): Promise<ActiveWorkspaceView> =>
      setActiveWithLocal(request, managed, store, instances, pointerStore, getActive, activityLog),
    selectLocal: (request): ActiveWorkspaceView =>
      selectLocalCheckout(request, store, instances, pointerStore, getActive, activityLog),
  };
}
