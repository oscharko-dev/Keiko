import { spawn, type ChildProcessByStdio } from "node:child_process";
import { dirname } from "node:path";
import type { Readable } from "node:stream";
import {
  copyRuntimeGatewayConfinement,
  currentPlatform,
  isRuntimeGatewayConfinement,
  planIsolatedRun,
  probeBackends,
  resolveDarwinGitExecutable,
  type AttestedDarwinGitExecutable,
  type BackendAvailability,
  type RuntimeGatewayConfinement,
} from "@oscharko-dev/keiko-sandbox";
import type { NetworkGatewayPolicy } from "@oscharko-dev/keiko-contracts";
import { errorKindOf, type ServerLogSink } from "../observability/server-log.js";
import { causeChain, keikoStackFrames } from "../observability/stack-frames.js";
import { processServerLogSink } from "../process-log-sink.js";

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
 * The existing dev/evaluation backend wraps the runtime in a deny-by-default network profile.
 * Service-based process escapes (mach-lookup, Apple Events, LSOpen) are denied. Fork remains
 * available for the sidecar's git handshake (#3390), while process-exec admits only the verified
 * runtime and one root-owned, content-attested Git implementation. Descendants inherit that exact
 * executable allowlist and the gateway TCP family/port restriction. Release signatures and
 * platform qualification remain separate requirements.
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
  /** Synchronous exit fact (Node sets exitCode/signalCode before the async exit event fires). */
  settled(): boolean;
  kill(signal: NodeJS.Signals): boolean;
  onExit(listener: (code: number | null) => void): void;
  onError(listener: (error: unknown) => void): void;
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
  readonly gatewayConfinement?: RuntimeGatewayConfinement | undefined;
  readonly activityLog?: ServerLogSink | undefined;
  readonly spawnRuntime?: DevLaneRuntimeSpawn | undefined;
  readonly killProcessGroup?: ((pid: number, signal: NodeJS.Signals) => void) | undefined;
  /** Test seam for the host-probe keiko-sandbox uses to pick a confining backend; real host by default. */
  readonly probeAvailability?: (() => BackendAvailability) | undefined;
  /** Test seam for the platform keiko-sandbox plans against; real host platform by default. */
  readonly platform?: NodeJS.Platform | undefined;
  /** Test seam; production resolves and attests one developer-tool Git executable per launch. */
  readonly resolveGitExecutable?: (() => AttestedDarwinGitExecutable) | undefined;
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
    copyRuntimeGatewayConfinement(options.gatewayConfinement),
    options.activityLog ?? processServerLogSink(),
    options.probeAvailability ?? probeBackends,
    options.platform ?? currentPlatform(),
    options.resolveGitExecutable ?? resolveDarwinGitExecutable,
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
    private readonly gatewayConfinement: RuntimeGatewayConfinement | undefined,
    private readonly activityLog: ServerLogSink,
    private readonly probeAvailability: () => BackendAvailability,
    private readonly platform: NodeJS.Platform,
    private readonly resolveGitExecutable: () => AttestedDarwinGitExecutable,
  ) {}

  public spawnOwnedTree(request: RuntimeSupervisorLaunchRequest): RuntimeProcessTree {
    try {
      return this.spawnConfinedTree(request);
    } catch (error) {
      recordConfinementFailure(this.activityLog, request.runId, error);
      throw error;
    }
  }

  private spawnConfinedTree(request: RuntimeSupervisorLaunchRequest): RuntimeProcessTree {
    const policy = this.gatewayConfinement;
    if (!isRuntimeGatewayConfinement(policy))
      throw new Error("runtime-gateway-confinement-required");
    if (policy.runId !== request.runId || policy.treeBindingId !== request.treeBindingId)
      throw new Error("runtime-gateway-confinement-drift");
    const executable = safeRealFile(request.executable);
    if (!pathIsContained(this.runtimeRoot, executable)) invalidRequest();
    const cwd = safeRealDirectory(request.cwd);
    const gitExecutable = this.resolveGitExecutable();
    // Routed through the shared keiko-sandbox plan/backend core (ADR-0043 D14, #2951) rather than
    // the seatbelt-argv formula directly, so a host missing sandbox-exec fails this launch closed
    // instead of spawning the literal, hardcoded "/usr/bin/sandbox-exec" path unconfined.
    const decision = planIsolatedRun(
      {
        command: executable,
        args: request.args,
        cwd,
        network: gatewayNetworkPolicy(policy),
        gatewayChildExecutable: gitExecutable.path,
      },
      this.probeAvailability(),
      this.platform,
    );
    if (decision.kind !== "wrapped") throw new Error("runtime-gateway-confinement-unavailable");
    const child = this.spawnRuntime(decision.command, decision.args, {
      cwd,
      env: { ...request.env, PATH: dirname(gitExecutable.path) },
      detached: true,
      shell: false,
    });
    this.activityLog.write({
      category: "process",
      op: "runtime.confinement.spawned",
      correlationId: request.runId,
      extra: {
        backend: decision.attestation.backend,
        policyDigest: policy.policyDigest,
        authorityDigest: policy.envelopeDigest,
        runtimeArtifactDigest: policy.runtimeArtifactDigest,
        modelProfileDigest: policy.modelProfileDigest,
        treeBindingId: policy.treeBindingId,
        profile: policy.profile,
        childExecutablePolicy: "runtime-and-attested-git-only",
        childExecutableDigest: gitExecutable.sha256,
      },
    });
    const tree = ownTree(`dev-lane-opencode-${String(this.nextTreeId++)}`, child, (error) => {
      recordConfinementFailure(this.activityLog, request.runId, error);
    });
    this.ownedTrees.add(tree);
    return tree;
  }

  public signalTree(tree: RuntimeProcessTree, signal: RuntimeTreeSignal): void {
    const owned = this.ownedTree(tree);
    // `settled()` is the synchronous exit fact: once the runtime has been reaped its process
    // group id may already be reused, and a group kill would target an unrelated process tree.
    // The remaining OS-level reuse window before Node observes the exit is part of the
    // documented best-effort dev-lane posture (ADR-0140 D3).
    if (owned.exited || owned.child.settled()) return;
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

function gatewayNetworkPolicy(policy: RuntimeGatewayConfinement): NetworkGatewayPolicy {
  return {
    mode: "gateway",
    host: policy.addressFamily === "ipv4" ? "127.0.0.1" : "::1",
    port: policy.port,
  };
}

function recordConfinementFailure(sink: ServerLogSink, runId: string, error: unknown): void {
  sink.write({
    category: "process",
    level: "error",
    op: "runtime.confinement.failed",
    correlationId: runId,
    errorKind: errorKindOf(error),
    extra: { frames: keikoStackFrames(error), causeChain: causeChain(error) },
  });
}

function ownTree(
  treeId: string,
  child: DevLaneRuntimeChildProcess,
  recordError: (error: unknown) => void,
): DevLaneTree {
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
  child.onError((error) => {
    recordError(error);
    // Node also emits `error` for failed kill/send operations on a live process. Only a failed
    // spawn with no PID, or the child's actual settled state, proves there is no process left.
    if (child.pid === undefined || child.settled()) settle(null);
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
    settled: (): boolean => child.exitCode !== null || child.signalCode !== null,
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
