import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import {
  copyRuntimeGatewayConfinement,
  currentPlatform,
  isRuntimeGatewayConfinement,
  LINUX_GATEWAY_DIAGNOSTIC_FD,
  LINUX_GATEWAY_DIAGNOSTIC_FD_ENV,
  parseLinuxGatewayDiagnosticLine,
  planIsolatedRun,
  probeBackends,
  resolveDarwinGitExecutable,
  type AttestedDarwinGitExecutable,
  type BackendAvailability,
  type RuntimeGatewayConfinement,
} from "@oscharko-dev/keiko-sandbox";
import type {
  LinuxGatewayDiagnosticKind,
  NetworkGatewayPolicy,
} from "@oscharko-dev/keiko-contracts";
import {
  activityLogEvent,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { ServerLogSink } from "../observability/server-log.js";
import { causeChain, keikoStackFrames } from "../observability/stack-frames.js";
import { processServerLogSink } from "../process-log-sink.js";
import { createCodingRuntimeLineParser } from "./codingRuntimeProcessIo.js";
import {
  RUNTIME_CONFINEMENT_FAILED_OPERATION,
  RUNTIME_CONFINEMENT_SPAWNED_OPERATION,
  RUNTIME_CONFINEMENT_UNAVAILABLE_OPERATION,
} from "./codingRuntimeActivityOperations.js";

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
 * Gateway-enforcing POSIX process backend. macOS uses Seatbelt for development/evaluation while a
 * release-qualified Linux runtime uses the namespace-to-gateway launcher. Both routes consume the
 * same sandbox planner and fail closed when their platform backend is unavailable.
 */
export type DevLaneRuntimeBackendIdentity =
  | {
      readonly platform: "darwin";
      readonly arch: "arm64" | "x64";
      readonly backend: "macos-app-sandbox";
    }
  | {
      readonly platform: "linux";
      readonly arch: "x64";
      readonly backend: "linux-namespace-gateway";
    };

export interface DevLaneRuntimeChildProcess {
  readonly pid: number | undefined;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly launcherDiagnostics?: Readable | undefined;
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
    readonly launcherDiagnostics: boolean;
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

type DevLaneLaunchPhase =
  | "gateway-policy"
  | "platform-identity"
  | "runtime-path"
  | "workspace-path"
  | "git-attestation"
  | "sandbox-plan"
  | "process-spawn"
  | "launcher-diagnostics"
  | "tree-ownership";

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
    let launchPhase: DevLaneLaunchPhase = "gateway-policy";
    try {
      return this.spawnConfinedTree(request, (phase) => {
        launchPhase = phase;
      });
    } catch (error) {
      if (isUnavailableError(error)) {
        recordConfinementUnavailable(this.activityLog, request.runId, this.identity);
      } else {
        recordConfinementFailure(this.activityLog, request.runId, error, launchPhase);
      }
      throw error;
    }
  }

  private spawnConfinedTree(
    request: RuntimeSupervisorLaunchRequest,
    setLaunchPhase: (phase: DevLaneLaunchPhase) => void,
  ): RuntimeProcessTree {
    const policy = validatedGatewayConfinement(this.gatewayConfinement, request);
    setLaunchPhase("platform-identity");
    assertPlatformIdentity(this.platform, this.identity);
    const { executable, cwd } = resolveLaunchPaths(this.runtimeRoot, request, setLaunchPhase);
    setLaunchPhase("git-attestation");
    const gitExecutable = platformGitExecutable(this.identity, this.resolveGitExecutable);
    // Routed through the shared keiko-sandbox plan/backend core (ADR-0043 D14, #2951) rather than
    // the seatbelt-argv formula directly, so a host missing sandbox-exec fails this launch closed
    // instead of spawning the literal, hardcoded "/usr/bin/sandbox-exec" path unconfined.
    setLaunchPhase("sandbox-plan");
    const decision = wrappedGatewayDecision(
      request,
      executable,
      cwd,
      policy,
      gitExecutable,
      this.probeAvailability(),
      this.platform,
    );
    setLaunchPhase("process-spawn");
    const child = this.spawnRuntime(decision.command, decision.args, {
      cwd,
      env: runtimeEnvironment(request.env, gitExecutable),
      detached: true,
      launcherDiagnostics: linuxGatewayLauncherBackend(decision.attestation.backend),
      shell: false,
    });
    setLaunchPhase("launcher-diagnostics");
    attachOrTerminateLinuxGatewayDiagnostics(
      child,
      this.activityLog,
      request.runId,
      decision.attestation.backend,
      this.killProcessGroup,
    );
    setLaunchPhase("tree-ownership");
    recordConfinementSpawned(
      this.activityLog,
      request.runId,
      decision.attestation.backend,
      policy,
      gitExecutable?.sha256,
    );
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

function resolveLaunchPaths(
  runtimeRoot: string,
  request: RuntimeSupervisorLaunchRequest,
  setLaunchPhase: (phase: DevLaneLaunchPhase) => void,
): { executable: string; cwd: string } {
  setLaunchPhase("runtime-path");
  const executable = safeRealFile(request.executable);
  if (!pathIsContained(runtimeRoot, executable)) invalidRequest();
  setLaunchPhase("workspace-path");
  const cwd = safeRealDirectory(request.cwd);
  return { executable, cwd };
}

function validatedGatewayConfinement(
  policy: RuntimeGatewayConfinement | undefined,
  request: RuntimeSupervisorLaunchRequest,
): RuntimeGatewayConfinement {
  if (!isRuntimeGatewayConfinement(policy)) throw new Error("runtime-gateway-confinement-required");
  if (policy.runId !== request.runId || policy.treeBindingId !== request.treeBindingId)
    throw new Error("runtime-gateway-confinement-drift");
  return policy;
}

function assertPlatformIdentity(
  platform: NodeJS.Platform,
  identity: DevLaneRuntimeBackendIdentity,
): void {
  if (platform !== identity.platform) throw new Error("runtime-gateway-platform-identity-drift");
}

function platformGitExecutable(
  identity: DevLaneRuntimeBackendIdentity,
  resolveGitExecutable: () => AttestedDarwinGitExecutable,
): AttestedDarwinGitExecutable | undefined {
  return identity.platform === "darwin" ? resolveGitExecutable() : undefined;
}

function wrappedGatewayDecision(
  request: RuntimeSupervisorLaunchRequest,
  executable: string,
  cwd: string,
  policy: RuntimeGatewayConfinement,
  gitExecutable: AttestedDarwinGitExecutable | undefined,
  availability: BackendAvailability,
  platform: NodeJS.Platform,
): Extract<ReturnType<typeof planIsolatedRun>, { readonly kind: "wrapped" }> {
  const decision = planIsolatedRun(
    {
      command: executable,
      args: request.args,
      cwd,
      network: gatewayNetworkPolicy(policy),
      ...(gitExecutable === undefined ? {} : { gatewayChildExecutable: gitExecutable.path }),
    },
    availability,
    platform,
  );
  if (decision.kind !== "wrapped") throw new Error("runtime-gateway-confinement-unavailable");
  return decision;
}

function runtimeEnvironment(
  environment: Readonly<Record<string, string>>,
  gitExecutable: AttestedDarwinGitExecutable | undefined,
): Readonly<Record<string, string>> {
  return gitExecutable === undefined
    ? { ...environment }
    : { ...environment, PATH: dirname(gitExecutable.path) };
}

function gatewayNetworkPolicy(policy: RuntimeGatewayConfinement): NetworkGatewayPolicy {
  return {
    mode: "gateway",
    host: policy.addressFamily === "ipv4" ? "127.0.0.1" : "::1",
    port: policy.port,
  };
}

function recordConfinementFailure(
  sink: ServerLogSink,
  runId: string,
  error: unknown,
  launchPhase?: DevLaneLaunchPhase,
): void {
  sink.write(
    activityLogEvent(
      RUNTIME_CONFINEMENT_FAILED_OPERATION,
      { level: "error", correlationId: runId, errorKind: confinementFailureErrorKind(error) },
      {
        ...(launchPhase === undefined ? {} : { launchPhase }),
        frames: keikoStackFrames(error),
        causeChain: causeChain(error),
      },
    ),
  );
}

function confinementFailureErrorKind(error: unknown): ActivityLogErrorKind {
  if (!(error instanceof Error)) return "internal";
  if (error.message === "runtime-gateway-confinement-drift") return "conflict";
  if (
    error.message === "runtime-gateway-confinement-required" ||
    error.message === "runtime-gateway-confinement-unavailable"
  ) {
    return "unavailable";
  }
  return error instanceof TypeError ? "validation-failed" : "internal";
}

function isUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.message === "runtime-gateway-confinement-unavailable";
}

function recordConfinementUnavailable(
  sink: ServerLogSink,
  runId: string,
  identity: DevLaneRuntimeBackendIdentity,
): void {
  sink.write(
    activityLogEvent(
      RUNTIME_CONFINEMENT_UNAVAILABLE_OPERATION,
      { level: "info", correlationId: runId },
      { platform: identity.platform, arch: identity.arch, backend: identity.backend },
    ),
  );
}

function recordConfinementSpawned(
  sink: ServerLogSink,
  runId: string,
  backend: string,
  policy: RuntimeGatewayConfinement,
  childExecutableDigest: string | undefined,
): void {
  sink.write(
    activityLogEvent(
      RUNTIME_CONFINEMENT_SPAWNED_OPERATION,
      { correlationId: runId },
      {
        backend: recordedConfinementBackend(backend),
        policyDigest: policy.policyDigest,
        authorityDigest: policy.envelopeDigest,
        runtimeArtifactDigest: policy.runtimeArtifactDigest,
        modelProfileDigest: policy.modelProfileDigest,
        treeBindingId: policy.treeBindingId,
        profile: policy.profile,
        childExecutablePolicy:
          childExecutableDigest === undefined
            ? "namespace-inherited"
            : "runtime-and-attested-git-only",
        ...(childExecutableDigest === undefined ? {} : { childExecutableDigest }),
      },
    ),
  );
}

function recordedConfinementBackend(backend: string): "bubblewrap" | "unshare" | "seatbelt" {
  if (backend === "bubblewrap" || backend === "unshare" || backend === "seatbelt") return backend;
  throw new TypeError("invalid recorded confinement backend");
}

function linuxGatewayLauncherBackend(backend: string): backend is "bubblewrap" | "unshare" {
  return backend === "bubblewrap" || backend === "unshare";
}

function recordLinuxGatewayLauncherFailure(
  sink: ServerLogSink,
  runId: string,
  backend: "bubblewrap" | "unshare",
  errorKind: LinuxGatewayDiagnosticKind,
): void {
  sink.write(
    activityLogEvent(
      RUNTIME_CONFINEMENT_FAILED_OPERATION,
      { level: "error", correlationId: runId, errorKind: linuxGatewayErrorKind(errorKind) },
      {
        backend,
        diagnosticSource: "linux-gateway-launcher",
        diagnosticKind: errorKind,
        frames: [],
        causeChain: [],
      },
    ),
  );
}

function linuxGatewayErrorKind(errorKind: LinuxGatewayDiagnosticKind): ActivityLogErrorKind {
  if (errorKind === "unsupported-platform" || errorKind === "loopback-tool-unavailable") {
    return "unavailable";
  }
  if (
    errorKind === "invalid-backend" ||
    errorKind === "invalid-command" ||
    errorKind === "invalid-cwd" ||
    errorKind === "invalid-gateway-host" ||
    errorKind === "invalid-gateway-port" ||
    errorKind === "invalid-mode"
  ) {
    return "validation-failed";
  }
  return "internal";
}

function attachLinuxGatewayDiagnostics(
  child: DevLaneRuntimeChildProcess,
  sink: ServerLogSink,
  runId: string,
  backend: string,
): void {
  if (!linuxGatewayLauncherBackend(backend)) return;
  const diagnostics = child.launcherDiagnostics;
  if (diagnostics === undefined) throw new Error("linux-gateway-diagnostics-unavailable");
  let reported = false;
  const report = (errorKind: LinuxGatewayDiagnosticKind): void => {
    if (reported) return;
    reported = true;
    recordLinuxGatewayLauncherFailure(sink, runId, backend, errorKind);
  };
  const parser = createCodingRuntimeLineParser({
    maxLineBytes: 128,
    onLine: (line) => {
      report(parseLinuxGatewayDiagnosticLine(line) ?? "internal-failure");
    },
  });
  diagnostics.on("data", (chunk) => {
    const value = Buffer.isBuffer(chunk) ? chunk : String(chunk);
    if (!parser.push(value).ok) report("internal-failure");
  });
  diagnostics.once("end", () => {
    if (!parser.finish().ok) report("internal-failure");
  });
  diagnostics.once("error", () => {
    report("internal-failure");
  });
}

function attachOrTerminateLinuxGatewayDiagnostics(
  child: DevLaneRuntimeChildProcess,
  sink: ServerLogSink,
  runId: string,
  backend: string,
  killProcessGroup: (pid: number, signal: NodeJS.Signals) => void,
): void {
  try {
    attachLinuxGatewayDiagnostics(child, sink, runId, backend);
  } catch (error) {
    terminateUnownedChild(child, killProcessGroup);
    throw error;
  }
}

function terminateUnownedChild(
  child: DevLaneRuntimeChildProcess,
  killProcessGroup: (pid: number, signal: NodeJS.Signals) => void,
): void {
  if (child.settled()) return;
  if (child.pid !== undefined) {
    try {
      killProcessGroup(child.pid, "SIGKILL");
      return;
    } catch {
      // Fall back to the immediate child when the detached group cannot be addressed.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The enclosing launch failure is recorded and remains authoritative if the child raced exit.
  }
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
  const child = spawn(executable, [...args], {
    cwd: options.cwd,
    env: {
      ...options.env,
      ...(options.launcherDiagnostics
        ? { [LINUX_GATEWAY_DIAGNOSTIC_FD_ENV]: String(LINUX_GATEWAY_DIAGNOSTIC_FD) }
        : {}),
    },
    detached: true,
    shell: false,
    stdio: options.launcherDiagnostics
      ? ["ignore", "pipe", "pipe", "pipe"]
      : ["ignore", "pipe", "pipe"],
  });
  if (child.stdout === null || child.stderr === null)
    throw new TypeError("dev-lane-runtime-pipes-unavailable");
  const launcherDiagnostics = options.launcherDiagnostics
    ? child.stdio[LINUX_GATEWAY_DIAGNOSTIC_FD]
    : undefined;
  if (options.launcherDiagnostics && !(launcherDiagnostics instanceof Readable))
    throw new TypeError("linux-gateway-diagnostics-unavailable");
  return {
    pid: child.pid,
    stdout: child.stdout,
    stderr: child.stderr,
    ...(launcherDiagnostics instanceof Readable ? { launcherDiagnostics } : {}),
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
