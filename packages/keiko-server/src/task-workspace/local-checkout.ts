import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";

import { gitEnv, GIT_BASE_ARGS } from "@oscharko-dev/keiko-git";
import {
  TASK_WORKSPACE_SCHEMA_VERSION,
  type WorkspaceInstance,
} from "@oscharko-dev/keiko-contracts/runtime/task-workspace";

import type { UiStore } from "../store/types.js";
import { readProductionWorkspaceHead } from "../coding-runtime/productionWorkspaceHeadReader.js";
import type { ActiveWorkspacePointerStore } from "./active-store.js";
import { buildBinding } from "./binding.js";
import { logWorkspaceLifecycle } from "./activity-log.js";
import { TaskWorkspaceError } from "./errors.js";
import { deriveRepositoryId } from "./naming.js";
import type { WorkspaceInstanceStore } from "./store.js";
import type { ActiveWorkspaceView, WorkspaceLifecycleService } from "./types.js";

const LOCAL_PREFIX = "local:";
const GIT_TIMEOUT_MS = 5_000;

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function git(root: string, ...args: readonly string[]): string {
  return execFileSync(
    "git",
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
      env: gitEnv(),
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 4_096,
      stdio: ["ignore", "pipe", "ignore"],
    },
  ).trim();
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
        "^filter\\..*\\.(process|smudge|clean)$",
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
  try {
    if (realpathSync(root) !== root || git(root, "rev-parse", "--show-toplevel") !== root) {
      return undefined;
    }
    const gitdir = realpathSync(git(root, "rev-parse", "--absolute-git-dir"));
    const stat = statSync(gitdir);
    return digest(`${root}\0${gitdir}\0${String(stat.dev)}\0${String(stat.ino)}`);
  } catch {
    return undefined;
  }
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
    const identity = localIdentity(root);
    if (
      identity === undefined ||
      `${LOCAL_PREFIX}${identity}` !== pointer.workspaceId ||
      persisted.repositoryRoot !== root
    )
      continue;
    let branch: string;
    try {
      branch = git(root, "symbolic-ref", "--quiet", "--short", "HEAD");
    } catch {
      return undefined;
    }
    const head = readProductionWorkspaceHead(root, root);
    if (branch.length === 0 || head === undefined) return undefined;
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

export function withLocalCheckout(
  managed: WorkspaceLifecycleService,
  pointerStore: ActiveWorkspacePointerStore,
  store: UiStore,
  instances: WorkspaceInstanceStore,
): LocalCheckoutLifecycle {
  const getActive = (correlationId?: string): ActiveWorkspaceView | undefined => {
    const pointer = pointerStore.get();
    if (pointer?.workspaceId.startsWith(LOCAL_PREFIX)) return localView(store, instances, pointer);
    return managed.getActive(correlationId);
  };
  return {
    ...managed,
    list: (repositoryRoot): readonly WorkspaceInstance[] =>
      managed.list(repositoryRoot).filter((instance) => instance.executionLocation !== "local"),
    listAll: (): readonly WorkspaceInstance[] =>
      managed.listAll().filter((instance) => instance.executionLocation !== "local"),
    getActive,
    selectLocal: ({ root, branch, requestedBy, correlationId }): ActiveWorkspaceView => {
      if (!store.listProjects().some((project) => project.path === root)) {
        throw new TaskWorkspaceError("MISSING_REPOSITORY", "Select a registered repository.");
      }
      const identity = localIdentity(root);
      if (identity === undefined || branch.length === 0 || branch.startsWith("-")) {
        throw new TaskWorkspaceError("INVALID_BASE_BRANCH", "The local branch is unavailable.");
      }
      try {
        git(root, "check-ref-format", "--branch", branch);
        git(root, "show-ref", "--verify", `refs/heads/${branch}`);
      } catch (error) {
        throw new TaskWorkspaceError(
          "INVALID_BASE_BRANCH",
          "Select an existing local branch.",
          [],
          {
            cause: error,
          },
        );
      }
      if (currentBranch(root) !== branch) {
        if (hasExecutableFilters(root)) {
          throw new TaskWorkspaceError(
            "BRANCH_CONFLICT",
            "The checkout has executable Git filters; switch branches outside the Workbench.",
          );
        }
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
      const head = readProductionWorkspaceHead(root, root);
      if (head === undefined) {
        throw new TaskWorkspaceError("REPOSITORY_UNREACHABLE", "Git HEAD is unavailable.");
      }
      if (localIdentity(root) !== identity) {
        throw new TaskWorkspaceError(
          "POINTER_DRIFT",
          "The local checkout changed during selection.",
        );
      }
      const atIso = new Date().toISOString();
      const workspaceId = `${LOCAL_PREFIX}${identity}`;
      const previous = instances.getById(workspaceId);
      instances.upsert({
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
      });
      pointerStore.set({ workspaceId: `${LOCAL_PREFIX}${identity}`, setBy: requestedBy, atIso });
      const active = getActive();
      if (active === undefined) {
        throw new TaskWorkspaceError("POINTER_DRIFT", "The local checkout could not be verified.");
      }
      logWorkspaceLifecycle(
        {},
        {
          operation: "activate",
          outcome: "activated",
          workspaceId,
          taskId: active.instance.taskId,
          correlationId,
          attempt: 1,
          durationMs: 0,
          worktreeCount: 0,
          baseBranch: branch,
        },
      );
      return active;
    },
  };
}
