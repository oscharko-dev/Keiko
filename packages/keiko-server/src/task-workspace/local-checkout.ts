import { createHash, randomUUID } from "node:crypto";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { TaskWorkspaceLifecycleState } from "@oscharko-dev/keiko-contracts";
import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, parse } from "node:path";

import { gitEnv, GIT_BASE_ARGS, resolveGitExecutable } from "@oscharko-dev/keiko-git";
import {
  TASK_WORKSPACE_SCHEMA_VERSION,
  type WorkspaceInstance,
} from "@oscharko-dev/keiko-contracts/runtime/task-workspace";

import { UNKNOWN_CORRELATION_ID, correlationIdOrUnknown } from "../correlation.js";
import type { UiStore } from "../store/types.js";
import {
  readProductionWorkspaceGitState,
  readProductionWorkspaceHead,
} from "../coding-runtime/productionWorkspaceHeadReader.js";
import type { ActiveWorkspacePointerStore } from "./active-store.js";
import { buildBinding } from "./binding.js";
import {
  logWorkspaceLifecycle,
  recordWorkspaceLifecycle,
  type WorkspaceActivityLogSeam,
} from "./activity-log.js";
import { buildWorkspaceEvent, WORKSPACE_LIFECYCLE_EVIDENCE_KIND } from "./evidence.js";

import { TaskWorkspaceError } from "./errors.js";
import { deriveRepositoryId } from "./naming.js";
import type { WorkspaceInstanceStore } from "./store.js";
import type {
  ActiveWorkspaceView,
  SetActiveWorkspaceRequest,
  WorkspaceLifecycleService,
} from "./types.js";

export interface LocalCheckoutEvidenceDeps extends WorkspaceActivityLogSeam {
  readonly evidenceStore: EvidenceStore;
  readonly redactString: (value: string) => string;
  readonly now: () => number;
}

const LOCAL_PREFIX = "local:";
const GIT_TIMEOUT_MS = 5_000;
const GIT_OBJECT_TIMEOUT_MS = 60_000;
const GIT_OBJECT_BUFFER_BYTES = 128 * 1024 * 1024;
const GIT_OBJECT_ID = /^[a-f0-9]{40,64}$/u;

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function trustedGitExecutable(root: string, env: NodeJS.ProcessEnv): string {
  const executable = resolveGitExecutable(env, root);
  if (!executable.ok) {
    throw new TaskWorkspaceError("REPOSITORY_UNREACHABLE", "Trusted Git executable unavailable.", [
      executable.reason,
    ]);
  }
  return executable.path;
}

function trustedGitArgs(root: string, args: readonly string[]): string[] {
  return [
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
  ];
}

function gitOutput(
  root: string,
  args: readonly string[],
  options: { readonly input?: string; readonly timeout?: number; readonly maxBuffer?: number } = {},
): string {
  const env = gitEnv();
  return execFileSync(trustedGitExecutable(root, env), trustedGitArgs(root, args), {
    encoding: "utf8",
    env,
    timeout: options.timeout ?? GIT_TIMEOUT_MS,
    maxBuffer: options.maxBuffer ?? 4_096,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
    ...(options.input === undefined ? {} : { input: options.input }),
  }).trim();
}

// Never terminate a mutating switch because it exceeded a read command's buffer or deadline:
// Git may have updated the index and worktree before moving HEAD. Suppress output entirely.
function gitSwitch(root: string, branch: string): void {
  const env = gitEnv();
  execFileSync(
    trustedGitExecutable(root, env),
    trustedGitArgs(root, ["switch", "--quiet", "--no-guess", branch]),
    { env, timeout: 0, stdio: "ignore" },
  );
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
    const reference = git(root, "symbolic-ref", "--quiet", "HEAD");
    return reference.startsWith("refs/heads/") ? reference.slice("refs/heads/".length) : undefined;
  } catch (error) {
    if (gitNoMatch(error)) return undefined;
    throw error;
  }
}

function localIdentity(root: string): string | undefined {
  // Windows can resolve one directory through either its long or 8.3 path spelling. Node may
  // return the short spelling for the registered root and Git the long spelling for the same
  // directory, so string equality after realpath is not a filesystem identity check. Preserve
  // canonical-root/reparse-point rejection, then compare the actual directory file IDs.
  if (!isCanonicalLocalRoot(root)) {
    return undefined;
  }
  const gitRoot = git(root, "rev-parse", "--show-toplevel");
  if (!sameDirectoryIdentity(root, gitRoot)) return undefined;
  const gitdir = realpathSync(git(root, "rev-parse", "--absolute-git-dir"));
  return gitDirectoryIdentity(root, gitdir);
}

function isCanonicalLocalRoot(root: string): boolean {
  if (!isAbsolute(root) || normalize(root) !== root) return false;
  let current = parse(root).root;
  for (const segment of root
    .slice(current.length)
    .split(/[\\/]+/u)
    .filter(Boolean)) {
    current = join(current, segment);
    if (lstatSync(current).isSymbolicLink()) return false;
  }
  return statSync(root).isDirectory();
}

function sameDirectoryIdentity(left: string, right: string): boolean {
  try {
    const leftStats = statSync(left);
    const rightStats = statSync(right);
    return (
      leftStats.isDirectory() &&
      rightStats.isDirectory() &&
      leftStats.ino !== 0 &&
      leftStats.ino === rightStats.ino
    );
  } catch {
    return false;
  }
}

function gitDirectoryIdentity(root: string, gitdir: string): string {
  const stat = statSync(gitdir);
  return digest(`${root}\0${gitdir}\0${String(stat.dev)}\0${String(stat.ino)}`);
}

function localHead(root: string): string | undefined {
  return readProductionWorkspaceHead(root, root);
}

function localView(
  store: UiStore,
  instances: WorkspaceInstanceStore,
  pointer: NonNullable<ReturnType<ActiveWorkspacePointerStore["get"]>>,
): ActiveWorkspaceView | undefined {
  const persisted = instances.getById(pointer.workspaceId);
  if (persisted?.executionLocation !== "local") return undefined;
  const root = persisted.repositoryRoot;
  if (!store.listProjects().some((project) => project.path === root)) return undefined;
  if (!isCanonicalLocalRoot(root)) return undefined;
  const state = readProductionWorkspaceGitState(root, root);
  if (state?.branch !== persisted.taskBranch) return undefined;
  const identity = gitDirectoryIdentity(root, state.gitDir);
  if (`${LOCAL_PREFIX}${identity}` !== pointer.workspaceId) return undefined;
  const instance: WorkspaceInstance = {
    ...persisted,
    lastVerifiedAt: new Date().toISOString(),
    lastVerifiedHead: state.head,
  };
  return { instance, binding: buildBinding(instance), pointer };
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

function validatedLocalIdentity(store: UiStore, root: string): string {
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
  if (identity === undefined)
    throw new TaskWorkspaceError("REPOSITORY_UNREACHABLE", "The local checkout is unavailable.");
  return identity;
}

function requireLocalBranch(root: string, branch: string): void {
  if (branch.length === 0 || branch.startsWith("-"))
    throw new TaskWorkspaceError("INVALID_BASE_BRANCH", "The local branch is unavailable.");
  try {
    git(root, "check-ref-format", "--branch", branch);
    git(root, "show-ref", "--verify", `refs/heads/${branch}`);
  } catch (error) {
    throw new TaskWorkspaceError("INVALID_BASE_BRANCH", "Select an existing local branch.", [], {
      cause: error,
    });
  }
}

function requireAvailableBranchObjects(root: string, branch: string): void {
  let available: boolean;
  try {
    available = targetTreeObjectsAvailable(root, branch);
  } catch (cause) {
    throw new TaskWorkspaceError(
      "REPOSITORY_UNREACHABLE",
      "The selected branch could not be inspected; retry when Git is available.",
      [],
      { cause },
    );
  }
  if (!available)
    throw new TaskWorkspaceError(
      "BRANCH_CONFLICT",
      "The selected branch has unavailable Git objects; hydrate it outside the Workbench.",
    );
}

function switchLocalBranch(root: string, branch: string): void {
  if (currentBranch(root) === branch) return;
  if (hasExecutableFilters(root))
    throw new TaskWorkspaceError(
      "BRANCH_CONFLICT",
      "The checkout has executable Git filters; switch branches outside the Workbench.",
    );
  try {
    gitSwitch(root, branch);
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

interface LocalSelectionEvidence {
  readonly request: LocalSelectionRequest;
  readonly identity: string;
  readonly startedAt: number;
  readonly fromState?: TaskWorkspaceLifecycleState | undefined;
  readonly error?: TaskWorkspaceError | undefined;
}

function recordLocalSelection(
  deps: LocalCheckoutEvidenceDeps,
  input: LocalSelectionEvidence,
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
        workspaceId: `${LOCAL_PREFIX}${identity}`,
        taskId: `coding-workbench-local-${identity.slice(0, 16)}`,
        type: error === undefined ? "activated" : "transition-rejected",
        at: new Date(recordedAt).toISOString(),
        correlationId: correlationIdOrUnknown(request.correlationId),
        fromState,
        toState: error === undefined ? "active" : undefined,
      }),
    },
    baseBranch: request.branch,
    errorCode: error?.code,
    error,
  });
}

function activateLocalCheckout(
  request: LocalSelectionRequest,
  identity: string,
  instances: WorkspaceInstanceStore,
  pointerStore: ActiveWorkspacePointerStore,
  getActive: () => ActiveWorkspaceView | undefined,
): ActiveWorkspaceView {
  requireAvailableBranchObjects(request.root, request.branch);
  switchLocalBranch(request.root, request.branch);
  const head = verifiedLocalHead(request.root, identity);
  const atIso = new Date().toISOString();
  const workspaceId = `${LOCAL_PREFIX}${identity}`;
  instances.upsert(localInstance(request, identity, head, atIso, instances.getById(workspaceId)));
  pointerStore.set({ workspaceId, setBy: request.requestedBy, atIso });
  const active = getActive();
  if (active === undefined)
    throw new TaskWorkspaceError("POINTER_DRIFT", "The local checkout could not be verified.");
  return active;
}

function selectLocalCheckout(
  request: LocalSelectionRequest,
  store: UiStore,
  instances: WorkspaceInstanceStore,
  pointerStore: ActiveWorkspacePointerStore,
  getActive: () => ActiveWorkspaceView | undefined,
  deps: LocalCheckoutEvidenceDeps,
): ActiveWorkspaceView {
  const startedAt = deps.now();
  let identity = digest(request.root);
  let fromState: TaskWorkspaceLifecycleState | undefined;
  try {
    identity = validatedLocalIdentity(store, request.root);
    fromState = instances.getById(`${LOCAL_PREFIX}${identity}`)?.lifecycleState;
    requireLocalBranch(request.root, request.branch);
    const active = activateLocalCheckout(request, identity, instances, pointerStore, getActive);
    recordLocalSelection(deps, { request, identity, startedAt, fromState });
    return active;
  } catch (cause) {
    const error =
      cause instanceof TaskWorkspaceError
        ? cause
        : new TaskWorkspaceError(
            "PROVISIONING_FAILED",
            "The local checkout could not be selected.",
            [],
            { cause },
          );
    recordLocalSelection(deps, { request, identity, startedAt, fromState, error });
    throw error;
  }
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
  activityLog: LocalCheckoutEvidenceDeps,
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

interface LocalInvalidationLogger {
  readonly record: (
    pointer: NonNullable<ReturnType<ActiveWorkspacePointerStore["get"]>>,
    correlationId: string | undefined,
    startedAt: number,
    cause?: unknown,
  ) => void;
  readonly clear: () => void;
}

function createLocalInvalidationLogger(
  activityLog: WorkspaceActivityLogSeam,
): LocalInvalidationLogger {
  let lastInvalidatedPointer: string | null = null;
  let lastInvalidationCorrelated = false;
  const record = (
    pointer: NonNullable<ReturnType<ActiveWorkspacePointerStore["get"]>>,
    correlationId: string | undefined,
    startedAt: number,
    cause?: unknown,
  ): void => {
    const key = `${pointer.workspaceId}\0${pointer.updatedAt}`;
    const correlated = correlationId !== undefined && correlationId !== UNKNOWN_CORRELATION_ID;
    if (lastInvalidatedPointer === key && (!correlated || lastInvalidationCorrelated)) return;
    lastInvalidatedPointer = key;
    lastInvalidationCorrelated = correlated;
    logInvalidatedLocalPointer(activityLog, pointer, correlationId, startedAt, cause);
  };
  return {
    record,
    clear: (): void => {
      lastInvalidatedPointer = null;
    },
  };
}

export function withLocalCheckout(
  managed: WorkspaceLifecycleService,
  pointerStore: ActiveWorkspacePointerStore,
  store: UiStore,
  instances: WorkspaceInstanceStore,
  activityLog: LocalCheckoutEvidenceDeps,
): LocalCheckoutLifecycle {
  const invalidationLogger = createLocalInvalidationLogger(activityLog);
  const getActive = (correlationId?: string): ActiveWorkspaceView | undefined => {
    const pointer = pointerStore.get();
    if (pointer?.workspaceId.startsWith(LOCAL_PREFIX)) {
      const startedAt = Date.now();
      let active: ActiveWorkspaceView | undefined;
      try {
        active = localView(store, instances, pointer);
      } catch (cause) {
        invalidationLogger.record(pointer, correlationId, startedAt, cause);
        return undefined;
      }
      if (active === undefined) invalidationLogger.record(pointer, correlationId, startedAt);
      else invalidationLogger.clear();
      return active;
    }
    invalidationLogger.clear();
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
