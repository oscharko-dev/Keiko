import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import {
  invalidRequest,
  pathIsContained,
  safeRealDirectory,
  safeRealFile,
} from "./nativeRuntimeProcessPaths.js";
import type {
  RuntimeProcessBackend,
  RuntimeProcessTree,
  RuntimeSupervisorLaunchRequest,
  RuntimeTreeSignal,
} from "./runtimeProcessSupervisor.js";

/**
 * Development-lane process backend for macOS dev checkouts (#2475, ADR-0140).
 *
 * Posture: this backend deliberately forgoes the release-qualified runtime supervisor's
 * long-lived-process containment and orphan-reaping guarantees (ADR-0137 D5). It spawns the
 * managed runtime as the leader of a fresh POSIX process group and terminates the whole group,
 * but a descendant that leaves the group survives unobserved — group termination is best effort,
 * never a containment proof. It is reachable only through dev-lane discovery, which is
 * structurally confined to repository checkouts; packaged installs never compose it.
 */
export interface DevLaneRuntimeBackendIdentity {
  readonly platform: "darwin";
  readonly arch: "arm64" | "x64";
  readonly backend: "macos-app-sandbox";
}

export interface DevLaneRuntimeChildProcess {
  readonly pid: number | undefined;
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(signal: NodeJS.Signals): boolean;
  onExit(listener: (code: number | null) => void): void;
  onError(listener: () => void): void;
}

export type DevLaneRuntimeSpawn = (
  executable: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly detached: true;
    readonly shell: false;
  },
) => DevLaneRuntimeChildProcess;

export interface DevLaneRuntimeProcessBackendOptions {
  readonly identity: DevLaneRuntimeBackendIdentity;
  /** The verified staged runtime root; every launched executable must resolve inside it. */
  readonly runtimeRoot: string;
  readonly spawnRuntime?: DevLaneRuntimeSpawn | undefined;
  readonly killProcessGroup?: ((pid: number, signal: NodeJS.Signals) => void) | undefined;
}

interface DevLaneTree extends RuntimeProcessTree {
  readonly child: DevLaneRuntimeChildProcess;
  readonly exits: Set<(code: number | null) => void>;
  exited: boolean;
  exitCode: number | null;
}

export function createDevLaneRuntimeProcessBackend(
  options: DevLaneRuntimeProcessBackendOptions,
): RuntimeProcessBackend {
  return new DevLaneRuntimeProcessBackend(
    options.identity,
    safeRealDirectory(options.runtimeRoot),
    options.spawnRuntime ?? spawnDevLaneChild,
    options.killProcessGroup ?? killGroup,
  );
}

class DevLaneRuntimeProcessBackend implements RuntimeProcessBackend {
  private readonly ownedTrees = new WeakSet<RuntimeProcessTree>();
  private nextTreeId = 0;

  public constructor(
    public readonly identity: DevLaneRuntimeBackendIdentity,
    private readonly runtimeRoot: string,
    private readonly spawnRuntime: DevLaneRuntimeSpawn,
    private readonly killProcessGroup: (pid: number, signal: NodeJS.Signals) => void,
  ) {}

  public spawnOwnedTree(request: RuntimeSupervisorLaunchRequest): RuntimeProcessTree {
    const executable = safeRealFile(request.executable);
    if (!pathIsContained(this.runtimeRoot, executable)) invalidRequest();
    const cwd = safeRealDirectory(request.cwd);
    const child = this.spawnRuntime(executable, request.args, {
      cwd,
      env: request.env,
      detached: true,
      shell: false,
    });
    const tree = ownTree(`dev-lane-opencode-${String(this.nextTreeId++)}`, child);
    this.ownedTrees.add(tree);
    return tree;
  }

  public signalTree(tree: RuntimeProcessTree, signal: RuntimeTreeSignal): void {
    const owned = this.ownedTree(tree);
    if (owned.exited) return;
    const posixSignal: NodeJS.Signals = signal === "graceful" ? "SIGTERM" : "SIGKILL";
    if (owned.child.pid !== undefined) {
      try {
        this.killProcessGroup(owned.child.pid, posixSignal);
        return;
      } catch {
        // The group can already be gone while the direct child lingers; fall through.
      }
    }
    owned.child.kill(posixSignal);
  }

  public waitForCompleteTreeExit(tree: RuntimeProcessTree, timeoutMs: number): Promise<boolean> {
    const owned = this.ownedTree(tree);
    if (owned.exited) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        owned.exits.delete(onExit);
        resolve(owned.exited);
      }, timeoutMs);
      timeout.unref();
      const onExit = (): void => {
        clearTimeout(timeout);
        resolve(true);
      };
      owned.exits.add(onExit);
    });
  }

  public reconcileTreeExit(tree: RuntimeProcessTree): Promise<boolean> {
    return Promise.resolve(this.ownedTree(tree).exited);
  }

  private ownedTree(tree: RuntimeProcessTree): DevLaneTree {
    if (!this.ownedTrees.has(tree)) throw new Error("dev-lane-runtime-tree-not-owned");
    return tree as DevLaneTree;
  }
}

function ownTree(treeId: string, child: DevLaneRuntimeChildProcess): DevLaneTree {
  const tree: DevLaneTree = {
    treeId,
    child,
    stdout: child.stdout,
    stderr: child.stderr,
    exits: new Set(),
    exited: false,
    exitCode: null,
    onTreeExit(callback): void {
      if (tree.exited) callback(tree.exitCode);
      else tree.exits.add(callback);
    },
  };
  const settle = (code: number | null): void => {
    if (tree.exited) return;
    tree.exited = true;
    tree.exitCode = code;
    for (const callback of tree.exits) callback(code);
    tree.exits.clear();
  };
  child.onExit(settle);
  child.onError(() => {
    settle(null);
  });
  return tree;
}

function spawnDevLaneChild(
  executable: string,
  args: readonly string[],
  options: Parameters<DevLaneRuntimeSpawn>[2],
): DevLaneRuntimeChildProcess {
  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(executable, [...args], {
    cwd: options.cwd,
    env: { ...options.env },
    detached: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    pid: child.pid,
    stdout: child.stdout,
    stderr: child.stderr,
    kill: (signal): boolean => child.kill(signal),
    onExit: (listener): void => {
      child.once("exit", listener);
    },
    onError: (listener): void => {
      child.once("error", listener);
    },
  };
}

/** Negative-pid kill targets the whole POSIX process group led by the spawned child. */
function killGroup(pid: number, signal: NodeJS.Signals): void {
  process.kill(-pid, signal);
}
