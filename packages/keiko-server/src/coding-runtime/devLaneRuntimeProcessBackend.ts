import { execFile, spawn, type StdioOptions } from "node:child_process";
import { dirname } from "node:path";
import { Duplex, Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import {
  copyRuntimeGatewayConfinement,
  currentPlatform,
  isRuntimeGatewayConfinement,
  LINUX_GATEWAY_DIAGNOSTIC_FD,
  LINUX_GATEWAY_DIAGNOSTIC_FD_ENV,
  parseLinuxGatewayDiagnosticLine,
  probeBackends,
  resolveDarwinGitExecutable,
  type AttestedDarwinGitExecutable,
  type BackendAvailability,
  type RuntimeGatewayConfinement,
} from "@oscharko-dev/keiko-sandbox";
import type { LinuxGatewayDiagnosticKind } from "@oscharko-dev/keiko-contracts";
import {
  activityLogEvent,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { causeChain, keikoStackFrames } from "@oscharko-dev/keiko-activity-log";
import { processServerLogSink } from "../process-log-sink.js";
import { createCodingRuntimeLineParser } from "./codingRuntimeProcessIo.js";
import {
  parseProcessListing,
  RuntimeDescendantTracker,
  sweepProvesEnd,
  type DescendantSweep,
  type DescendantTrackerOptions,
  type ProcessIdentity,
} from "./darwinRuntimeDescendants.js";
import {
  createSandboxMembership,
  SANDBOX_MEMBER_FD,
  sandboxMemberLaunch,
} from "./darwinSandboxMembership.js";
import {
  RUNTIME_CONFINEMENT_FAILED_OPERATION,
  RUNTIME_CONFINEMENT_UNAVAILABLE_OPERATION,
} from "./codingRuntimeActivityOperations.js";

import {
  invalidRequest,
  pathIsContained,
  safeRealDirectory,
  safeRealFile,
} from "./nativeRuntimeProcessPaths.js";
import type {
  PreparedRuntimeSandboxLaunch,
  RuntimeProcessBackend,
  RuntimeProcessTree,
  RuntimeSupervisorLaunchRequest,
  RuntimeTreeSignal,
} from "./runtimeProcessSupervisor.js";
import {
  prepareRuntimeGatewayProcessSandbox,
  recordRuntimeGatewayConfinementSpawned,
} from "./runtimeGatewayProcessSandbox.js";

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
  /** Retained by this existing process owner solely as OpenCode's native lifetime lease. */
  readonly stdin?: Writable | undefined;
  readonly launcherDiagnostics?: Readable | undefined;
  /** macOS: the descriptor of the run's sandbox member (darwinSandboxMembership.ts). */
  readonly sandboxMember?: Duplex | undefined;
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
    /** Opens descriptor 3 for the run's sandbox member (macOS native profile). */
    readonly sandboxMember?: boolean | undefined;
    readonly shell: false;
    readonly parentLifetime?: "stdin-eof" | undefined;
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
  /**
   * Test seam for the macOS descendant record and sweep. By default it reads the host's process
   * table, but only for children this backend really spawned: a substituted spawn has no real
   * process tree, and its fake PIDs must never be matched against the host's processes.
   */
  readonly trackDescendants?:
    ((options: DescendantTrackerOptions) => RuntimeDescendantTracker) | undefined;
}

interface DevLaneTree extends RuntimeProcessTree {
  readonly child: DevLaneRuntimeChildProcess;
  readonly exits: Set<(code: number | null) => void>;
  readonly parentLifetime: "stdin-eof" | undefined;
  reapUncertain: boolean;
  exited: boolean;
  exitCode: number | null;
  /** macOS: the service's descendants, ended once it has exited (darwinRuntimeDescendants.ts). */
  descendants?: RuntimeDescendantTracker;
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
    options.trackDescendants ??
      (options.spawnRuntime === undefined
        ? (tracker): RuntimeDescendantTracker => new RuntimeDescendantTracker(tracker)
        : undefined),
  );
}

const execFileAsync = promisify(execFile);
const PS_PATH = "/bin/ps";
const PS_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** This user's processes, locale-independent (macOS `ps`); the run's descendants are among them. */
async function listDarwinProcesses(): Promise<readonly ProcessIdentity[]> {
  const uid = String(process.getuid?.() ?? -1);
  const { stdout } = await execFileAsync(
    PS_PATH,
    ["-x", "-U", uid, "-o", "pid=,ppid=,stat=,lstart="],
    { encoding: "utf8", env: { LC_ALL: "C" }, maxBuffer: PS_MAX_BUFFER_BYTES },
  );
  return parseProcessListing(stdout);
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
    private readonly createDescendantTracker:
      ((options: DescendantTrackerOptions) => RuntimeDescendantTracker) | undefined,
  ) {}

  public get supportsStdinLifetime(): true | undefined {
    return this.identity.platform === this.platform ? true : undefined;
  }

  public spawnOwnedTree(
    request: RuntimeSupervisorLaunchRequest,
    sandbox?: PreparedRuntimeSandboxLaunch,
  ): RuntimeProcessTree {
    let launchPhase: DevLaneLaunchPhase = "gateway-policy";
    try {
      if (request.parentLifetime !== undefined && this.supportsStdinLifetime !== true)
        throw new TypeError("runtime-stdin-lifetime-unavailable");
      return sandbox === undefined || this.gatewayConfinement !== undefined
        ? this.spawnConfinedTree(request, (phase) => {
            launchPhase = phase;
          })
        : this.spawnPreparedTree(request, sandbox, (phase) => {
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

  private spawnPreparedTree(
    request: RuntimeSupervisorLaunchRequest,
    sandbox: PreparedRuntimeSandboxLaunch,
    setLaunchPhase: (phase: DevLaneLaunchPhase) => void,
  ): RuntimeProcessTree {
    const { cwd } = resolveLaunchPaths(this.runtimeRoot, request, setLaunchPhase);
    setLaunchPhase("process-spawn");
    const child = this.spawnRuntime(sandbox.command, sandbox.args, {
      cwd,
      env: { ...request.env },
      detached: true,
      launcherDiagnostics: linuxGatewayLauncherBackend(sandbox.attestation.backend),
      shell: false,
      ...(request.parentLifetime === undefined ? {} : { parentLifetime: request.parentLifetime }),
    });
    this.attachLaunchPorts(child, request, sandbox.attestation.backend, setLaunchPhase);
    const tree = ownTree(
      `dev-lane-opencode-${String(this.nextTreeId++)}`,
      child,
      request.parentLifetime,
      (error) => {
        recordChildConfinementFailure(this.activityLog, request.runId, child, error);
      },
    );
    this.ownedTrees.add(tree);
    this.trackDescendants(tree, request.runId);
    return tree;
  }

  private spawnConfinedTree(
    request: RuntimeSupervisorLaunchRequest,
    setLaunchPhase: (phase: DevLaneLaunchPhase) => void,
  ): RuntimeProcessTree {
    const policy = validatedGatewayConfinement(this.gatewayConfinement, request);
    setLaunchPhase("platform-identity");
    assertPlatformIdentity(this.platform, this.identity);
    const { executable, cwd } = resolveLaunchPaths(this.runtimeRoot, request, setLaunchPhase);
    const gitExecutable = this.attestedGit(setLaunchPhase);
    setLaunchPhase("sandbox-plan");
    const sandboxMember = this.admitsSandboxMember(policy);
    const decision = this.plannedLaunch(request, policy, { executable, cwd }, gitExecutable);
    setLaunchPhase("process-spawn");
    const child = this.spawnRuntime(decision.command, decision.args, {
      cwd,
      env: runtimeEnvironment(request.env, gitExecutable, policy.profile),
      detached: true,
      launcherDiagnostics: linuxGatewayLauncherBackend(decision.attestation.backend),
      sandboxMember,
      shell: false,
      ...(request.parentLifetime === undefined ? {} : { parentLifetime: request.parentLifetime }),
    });
    this.attachLaunchPorts(child, request, decision.attestation.backend, setLaunchPhase);
    recordRuntimeGatewayConfinementSpawned(
      this.activityLog,
      request.runId,
      recordedConfinementBackend(decision.attestation.backend),
      policy,
      gitExecutable,
      request.parentLifetime,
    );
    const tree = ownTree(
      `dev-lane-opencode-${String(this.nextTreeId++)}`,
      child,
      request.parentLifetime,
      (error) => {
        recordChildConfinementFailure(this.activityLog, request.runId, child, error);
      },
    );
    this.ownedTrees.add(tree);
    this.trackDescendants(tree, request.runId);
    return tree;
  }

  // The native macOS profile admits a shell, so its run gets a sandbox member beside the service.
  private admitsSandboxMember(policy: RuntimeGatewayConfinement): boolean {
    return this.identity.platform === "darwin" && policy.profile === "keiko-native";
  }

  // Routed through the shared keiko-sandbox plan/backend core (ADR-0043 D14, #2951) rather than
  // the seatbelt-argv formula directly, so a host missing sandbox-exec fails this launch closed
  // instead of spawning the literal, hardcoded "/usr/bin/sandbox-exec" path unconfined.
  private plannedLaunch(
    request: RuntimeSupervisorLaunchRequest,
    policy: RuntimeGatewayConfinement,
    paths: { readonly executable: string; readonly cwd: string },
    gitExecutable: AttestedDarwinGitExecutable | undefined,
  ): ReturnType<typeof prepareRuntimeGatewayProcessSandbox> {
    const launch = this.admitsSandboxMember(policy)
      ? sandboxMemberLaunch(paths.executable, request.args)
      : { executable: paths.executable, args: request.args };
    return prepareRuntimeGatewayProcessSandbox({
      request: { ...request, args: launch.args },
      executable: launch.executable,
      cwd: paths.cwd,
      policy,
      gitExecutable,
      runtimeRoots: [this.runtimeRoot],
      availability: this.probeAvailability(),
      platform: this.platform,
    });
  }

  // macOS only: Linux's namespace launcher owns its own tree, and its exit is the proof it gives.
  private trackDescendants(tree: DevLaneTree, runId: string): void {
    if (
      this.identity.platform !== "darwin" ||
      tree.child.pid === undefined ||
      this.createDescendantTracker === undefined
    )
      return;
    const member = tree.child.sandboxMember;
    const tracker = this.createDescendantTracker({
      runId,
      activityLog: this.activityLog,
      list: listDarwinProcesses,
      startedAtMs: Date.now(),
      ...(member === undefined ? {} : { membership: createSandboxMembership(member) }),
    });
    tree.descendants = tracker;
    tree.onTreeExit(() => {
      void tracker.sweep();
    });
  }

  private attestedGit(
    setLaunchPhase: (phase: DevLaneLaunchPhase) => void,
  ): AttestedDarwinGitExecutable | undefined {
    setLaunchPhase("git-attestation");
    return platformGitExecutable(this.identity, this.resolveGitExecutable);
  }

  private attachLaunchPorts(
    child: DevLaneRuntimeChildProcess,
    request: RuntimeSupervisorLaunchRequest,
    backend: string,
    setLaunchPhase: (phase: DevLaneLaunchPhase) => void,
  ): void {
    setLaunchPhase("tree-ownership");
    assertStdinLifetime(child, request.parentLifetime, this.killProcessGroup);
    setLaunchPhase("launcher-diagnostics");
    attachOrTerminateLinuxGatewayDiagnostics(
      child,
      this.activityLog,
      request.runId,
      backend,
      this.killProcessGroup,
    );
    setLaunchPhase("tree-ownership");
  }

  public signalTree(tree: RuntimeProcessTree, signal: RuntimeTreeSignal): void {
    const owned = this.ownedTree(tree);
    // `settled()` is the synchronous exit fact: once the runtime has been reaped its process
    // group id may already be reused, and a group kill would target an unrelated process tree.
    // The remaining OS-level reuse window before Node observes the exit is part of the
    // documented best-effort dev-lane posture (ADR-0140 D3).
    if (owned.exited || owned.child.settled()) return;
    if (signal === "graceful" && endStdinLifetime(owned)) return;
    // A forced/uncertain namespace wrapper exit cannot attest that its database producer is gone.
    if (this.identity.platform === "linux") owned.reapUncertain = true;
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

  // Ownership is refused synchronously, before any waiting starts.
  public waitForCompleteTreeExit(tree: RuntimeProcessTree, timeoutMs: number): Promise<boolean> {
    return this.completeTreeExit(this.ownedTree(tree), timeoutMs);
  }

  public reconcileTreeExit(tree: RuntimeProcessTree): Promise<boolean> {
    return this.completeTreeExit(this.ownedTree(tree), 0);
  }

  private async completeTreeExit(tree: DevLaneTree, timeoutMs: number): Promise<boolean> {
    const deadline = performance.now() + timeoutMs;
    if (!tree.exited && timeoutMs > 0) await this.rootExit(tree, timeoutMs);
    if (!this.completedTreeExit(tree)) return false;
    // Reconciliation answers for an exited tree: its sweep is awaited to its own end.
    const remaining = timeoutMs > 0 ? deadline - performance.now() : Number.POSITIVE_INFINITY;
    return descendantsEnded(await sweepWithin(tree, remaining));
  }

  private rootExit(tree: DevLaneTree, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        tree.exits.delete(onExit);
        resolve();
      }, timeoutMs);
      timeout.unref();
      const onExit = (): void => {
        clearTimeout(timeout);
        resolve();
      };
      tree.exits.add(onExit);
    });
  }

  private completedTreeExit(tree: DevLaneTree): boolean {
    return (
      tree.exited &&
      (this.identity.platform !== "linux" || (!tree.reapUncertain && tree.exitCode === 0))
    );
  }

  private ownedTree(tree: RuntimeProcessTree): DevLaneTree {
    if (!this.ownedTrees.has(tree)) throw new Error("dev-lane-runtime-tree-not-owned");
    return tree as DevLaneTree;
  }
}

/** The tree's sweep, or undefined while it is still running at the deadline or never ran. */
function sweepWithin(
  tree: DevLaneTree,
  remainingMs: number,
): Promise<DescendantSweep | "untracked" | undefined> {
  if (tree.descendants === undefined) return Promise.resolve("untracked");
  if (!tree.exited) return Promise.resolve(undefined);
  const sweep = tree.descendants.sweep();
  if (!Number.isFinite(remainingMs)) return sweep;
  return new Promise((resolve) => {
    const timeout = setTimeout(
      () => {
        resolve(undefined);
      },
      Math.max(0, remainingMs),
    );
    timeout.unref();
    void sweep.then((result) => {
      clearTimeout(timeout);
      resolve(result);
    });
  });
}

// Only a sweep that proves the run's execution ended settles the tree; anything else leaves it
// unproven (`runtime-reap-unproven`), never a false stop.
function descendantsEnded(sweep: DescendantSweep | "untracked" | undefined): boolean {
  if (sweep === "untracked") return true;
  return sweep !== undefined && sweepProvesEnd(sweep);
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

function runtimeEnvironment(
  environment: Readonly<Record<string, string>>,
  gitExecutable: AttestedDarwinGitExecutable | undefined,
  profile: RuntimeGatewayConfinement["profile"] = "keiko-gateway",
): Readonly<Record<string, string>> {
  if (gitExecutable === undefined) return { ...environment };
  // The native profile (#3897) keeps the launcher's allowlisted PATH so the agent's shell finds
  // the project's toolchains, with the attested Git first; the gateway profile sees Git only.
  const gitDirectory = dirname(gitExecutable.path);
  const inherited = environment.PATH;
  const path =
    profile === "keiko-native" && inherited !== undefined && inherited.length > 0
      ? `${gitDirectory}:${inherited}`
      : gitDirectory;
  return { ...environment, PATH: path };
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

function recordChildConfinementFailure(
  sink: ServerLogSink,
  runId: string,
  child: DevLaneRuntimeChildProcess,
  error: unknown,
): void {
  recordConfinementFailure(
    sink,
    runId,
    error,
    child.pid === undefined ? "process-spawn" : undefined,
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

function assertStdinLifetime(
  child: DevLaneRuntimeChildProcess,
  parentLifetime: "stdin-eof" | undefined,
  killProcessGroup: (pid: number, signal: NodeJS.Signals) => void,
): void {
  if (parentLifetime === undefined) return;
  const stdin = child.stdin;
  if (stdin instanceof Writable && stdin.writable && !stdin.destroyed && !stdin.writableEnded)
    return;
  terminateUnownedChild(child, killProcessGroup);
  throw new TypeError("runtime-stdin-lifetime-unavailable");
}

function endStdinLifetime(tree: DevLaneTree): boolean {
  const stdin = tree.child.stdin;
  if (tree.parentLifetime !== "stdin-eof" || stdin === undefined || stdin.destroyed) return false;
  if (!stdin.writableEnded) stdin.end();
  return true;
}

function ownTree(
  treeId: string,
  child: DevLaneRuntimeChildProcess,
  parentLifetime: "stdin-eof" | undefined,
  recordError: (error: unknown) => void,
): DevLaneTree {
  const tree: DevLaneTree = {
    treeId,
    child,
    stdout: child.stdout,
    stderr: child.stderr,
    exits: new Set(),
    parentLifetime,
    reapUncertain: false,
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
  const onError = (error: unknown): void => {
    tree.reapUncertain = true;
    recordError(error);
    // Node also emits `error` for failed kill/send operations on a live process. Only a failed
    // spawn with no PID, or the child's actual settled state, proves there is no process left.
    if (child.pid === undefined || child.settled()) settle(null);
  };
  child.onError(onError);
  child.stdin?.once("error", onError);
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
    stdio: devLaneStdio(options),
  });
  if (child.stdout === null || child.stderr === null)
    throw new TypeError("dev-lane-runtime-pipes-unavailable");
  return {
    pid: child.pid,
    stdout: child.stdout,
    stderr: child.stderr,
    ...(child.stdin instanceof Writable ? { stdin: child.stdin } : {}),
    ...extraDescriptors(child.stdio, options),
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

// Descriptor 3 carries the Linux launcher's diagnostics or the macOS run's sandbox member.
function extraDescriptors(
  stdio: readonly unknown[],
  options: Parameters<DevLaneRuntimeSpawn>[2],
): Pick<DevLaneRuntimeChildProcess, "launcherDiagnostics" | "sandboxMember"> {
  if (options.launcherDiagnostics) {
    const launcherDiagnostics = stdio[LINUX_GATEWAY_DIAGNOSTIC_FD];
    if (!(launcherDiagnostics instanceof Readable))
      throw new TypeError("linux-gateway-diagnostics-unavailable");
    return { launcherDiagnostics };
  }
  if (options.sandboxMember !== true) return {};
  const sandboxMember = stdio[SANDBOX_MEMBER_FD];
  if (!(sandboxMember instanceof Duplex))
    throw new TypeError("sandbox-member-descriptor-unavailable");
  return { sandboxMember };
}

function devLaneStdio(options: Parameters<DevLaneRuntimeSpawn>[2]): StdioOptions {
  const stdin = options.parentLifetime === "stdin-eof" ? "pipe" : "ignore";
  return options.launcherDiagnostics || options.sandboxMember === true
    ? [stdin, "pipe", "pipe", "pipe"]
    : [stdin, "pipe", "pipe"];
}

/** Negative-pid kill targets the whole POSIX process group led by the spawned child. */
function killGroup(pid: number, signal: NodeJS.Signals): void {
  process.kill(-pid, signal);
}
