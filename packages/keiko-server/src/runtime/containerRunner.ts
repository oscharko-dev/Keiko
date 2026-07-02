// Issue #1388 (Epic #1491, ADR-0070, D2/D3) — the governed container-run pilot manager. A request
// names a `taskId` from a server-frozen CLOSED catalog; the server resolves it to a vetted
// ContainerTask whose image is in a closed allowlist and constructs the EXACT, server-frozen
// `docker run` argv (no client-supplied image/argv/mount/flag). Execution reuses the single governed
// runCommand spawn boundary (ADR-0043 D2) exactly as the #1387 command runner does — no Docker SDK,
// no daemon-socket client, no second spawn path.
//
// Engine-unavailable is a GOVERNANCE failure, not an execution outcome: `execute` THROWS
// ContainerRunnerError("CONTAINER_ENGINE_UNAVAILABLE") BEFORE any run id is minted, so there is no
// run/event/evidence for a run that never started. Only real execution outcomes become a
// ContainerRunResult.

import { randomUUID } from "node:crypto";
import {
  CommandCancelledError,
  CommandDeniedError,
  CommandTimeoutError,
  DEFAULT_SANDBOX_POLICY,
  runCommand,
  type CommandResult,
  type RunCommandDeps,
  type SandboxPolicy,
} from "@oscharko-dev/keiko-tools";
import { nodeSpawnFn } from "@oscharko-dev/keiko-tools/internal/exec";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import {
  CONTAINER_RUNTIME_SCHEMA_VERSION,
  CONTAINER_TASK_RULES,
  type ContainerCapabilityResponse,
  type ContainerExecutionPolicy,
  type ContainerFailureReason,
  type ContainerResourceLimits,
  type ContainerRunResult,
  type ContainerRunnerEvent,
  type ContainerRunnerEventKind,
  type ContainerTask,
  type ContainerTaskCatalog,
} from "@oscharko-dev/keiko-contracts";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { ContainerRunnerError } from "./containerRunner-errors.js";
import {
  appendContainerRunEvidence,
  buildContainerRunEvidenceEntry,
} from "./containerRunner-evidence.js";
import { detectContainerEngines, type ContainerProbeDeps } from "./containerEngineDetector.js";
import type { Project, UiStore } from "../store/index.js";

// Tight cap — a container run is a high-trust surface, so a small number of concurrent runs.
const MAX_CONCURRENT_CONTAINER_RUNS = 2;
const MIN_TIMEOUT_MS = 1_000;
const CAPABILITY_CACHE_TTL_MS = 30_000;

// ─── Defaults (conservative; justified inline) ─────────────────────────────────────

export const DEFAULT_CONTAINER_RESOURCE_LIMITS: ContainerResourceLimits = {
  pidsLimit: 256, // enough for a small toolchain; blocks fork-bombs
  memoryBytes: 536_870_912, // 512 MiB — bounded, fits a diagnostic image
  cpus: 1, // single core; deterministic, no host saturation
};

// The pilot image is pinned by TAG (not digest) because no published Keiko-vetted digest exists yet;
// the digest-pin path is documented in docs/container-runtime/security-notes.md and is a one-line
// change here once a digest is vetted. `--pull never` means the image MUST already be present
// locally — a missing image is a structured image-missing failure, never a silent network fetch.
const PILOT_IMAGE = "docker.io/library/alpine:3.20";

export const DEFAULT_CONTAINER_EXECUTION_POLICY: ContainerExecutionPolicy = {
  // Closed set: exactly the one pinned pilot image. An image ∉ this list → IMAGE_NOT_ALLOWED.
  imageAllowlist: Object.freeze([PILOT_IMAGE]),
  limits: DEFAULT_CONTAINER_RESOURCE_LIMITS,
  mountMode: "read-only",
  networkMode: "none",
  workspaceMountPath: "/workspace",
  pull: "never",
};

export const DEFAULT_CONTAINER_TASKS: readonly ContainerTask[] = Object.freeze([
  {
    id: "container-pilot:diagnostic",
    kind: "diagnostic",
    label: "Container engine pilot diagnostic",
    image: PILOT_IMAGE,
    // Trivial in-container command (NOT docker flags). Proves the detection+policy+spawn composition.
    // Deliberately NOT `sh -c …`: `-c` is a CONTAINER_DENY_FLAGS member (a transitive-shell escalation
    // flag), so a `-c` anywhere in the argv would self-deny at the runCommand boundary. A bare
    // `echo …` argv keeps the frozen hardened argv passing isCommandAllowed (the §1.8 LOAD-BEARING
    // no-self-deny invariant).
    args: Object.freeze(["echo", "keiko-container-pilot ok"]),
    engine: "docker",
  },
]);

// ─── Server-frozen argv (D3) — PURE, unit-tested in isolation ──────────────────────

// Returns the EXACT docker/podman argv. The image MUST already be asserted ∈ policy.imageAllowlist
// by the caller (execute does this and throws IMAGE_NOT_ALLOWED otherwise); this builder additionally
// re-asserts so a misuse can never emit a non-allowlisted image. No client input reaches this argv.
export function buildContainerRunArgv(
  task: ContainerTask,
  policy: ContainerExecutionPolicy,
  workspaceRoot: string,
): readonly string[] {
  if (!policy.imageAllowlist.includes(task.image)) {
    throw new ContainerRunnerError("IMAGE_NOT_ALLOWED", "Task image is not allowlisted.");
  }
  return [
    "run",
    "--rm", // no container persistence (NIST 800-190 4.4)
    "--network",
    policy.networkMode, // "none" — the container has no network (4.1.3)
    "--read-only", // read-only root filesystem (3.1.2 / 4.5.2)
    "--cap-drop",
    "ALL", // drop all Linux capabilities (4.5.3)
    "--security-opt",
    "no-new-privileges", // forbid privilege escalation (4.5.3)
    "--pids-limit",
    String(policy.limits.pidsLimit),
    "--memory",
    String(policy.limits.memoryBytes),
    "--cpus",
    String(policy.limits.cpus),
    "--pull",
    policy.pull, // "never" — the image must already be present locally (3.1.1 / 4.2)
    "-v",
    // read-only workspace bind mount at a fixed in-container path; NO read-write/broad host mount,
    // and NEVER the Docker socket.
    `${workspaceRoot}:${policy.workspaceMountPath}:ro`,
    task.image,
    ...task.args,
  ];
}

// ─── Public types ─────────────────────────────────────────────────────────────────

export interface ContainerRunInput {
  readonly projectId: string;
  readonly taskId: string;
  readonly timeoutMs?: number | undefined;
  readonly requestId?: string | undefined;
}

export type ContainerRunnerEventEmitter = (event: ContainerRunnerEvent) => void;

export interface ContainerRunnerManager {
  readonly capability: (projectId: string) => Promise<ContainerCapabilityResponse>;
  readonly listCatalog: (projectId: string) => Promise<ContainerTaskCatalog>;
  readonly execute: (input: ContainerRunInput) => Promise<ContainerRunResult>;
  readonly abort: (runId: string) => boolean;
  readonly subscribe: (listener: ContainerRunnerEventEmitter) => () => void;
  readonly inFlightCount: () => number;
}

export interface ContainerRunnerManagerOptions {
  readonly store: UiStore;
  readonly evidenceStore?: EvidenceStore | undefined;
  readonly policy?: SandboxPolicy | undefined; // host CLI spawn policy (network:"inherit")
  readonly executionPolicy?: ContainerExecutionPolicy | undefined;
  readonly catalog?: readonly ContainerTask[] | undefined;
  readonly processEnv?: NodeJS.ProcessEnv | undefined;
  readonly redactor?: ((input: string) => string) | undefined;
  readonly runDeps?: Partial<RunCommandDeps> | undefined; // injectable spawn seam
  // Injectable detector outcome (tests pass a fake; production uses detectContainerEngines).
  readonly detect?: ((projectId: string) => Promise<ContainerCapabilityResponse>) | undefined;
  readonly now?: (() => number) | undefined;
}

// ─── Outcome normalization (one settle path for success and failure) ───────────────

interface SettledOutcome {
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly truncated: boolean;
  readonly timedOut: boolean;
  readonly failureReason: ContainerFailureReason;
  readonly eventKind: ContainerRunnerEventKind;
  readonly stdout: string;
  readonly stderr: string;
}

const IMAGE_MISSING_SIGNATURES = [
  "no such image",
  "unable to find image",
  "image not known",
  "manifest unknown",
];
const PULL_DENIED_SIGNATURES = [
  "pull policy",
  "pull never",
  "--pull=never",
  "image must be present",
];
const MOUNT_FAILURE_SIGNATURES = [
  "error mounting",
  "invalid mount",
  "bind mount",
  "no such file or directory", // bind source absent
  "are you trying to mount",
];

function matchesSignature(haystack: string, signatures: readonly string[]): boolean {
  const lower = haystack.toLowerCase();
  return signatures.some((needle) => lower.includes(needle));
}

// Classifies a NON-ZERO exit into a container-specific failure reason by stderr signature, so the
// audit distinguishes a missing image / denied pull / mount failure from a plain non-zero exit.
function classifyNonZeroFailure(stderr: string): ContainerFailureReason {
  if (matchesSignature(stderr, IMAGE_MISSING_SIGNATURES)) return "image-missing";
  if (matchesSignature(stderr, PULL_DENIED_SIGNATURES)) return "pull-denied";
  if (matchesSignature(stderr, MOUNT_FAILURE_SIGNATURES)) return "mount-failure";
  return "non-zero-exit";
}

function outcomeFromResult(result: CommandResult): SettledOutcome {
  // runCommand resolves only on a real process exit (timeout/cancel reject). A truncation that
  // killed the child is terminal → output-capped; otherwise classify by exit code + stderr.
  const failureReason: ContainerFailureReason = result.truncated
    ? "output-capped"
    : result.exitCode === 0
      ? "none"
      : classifyNonZeroFailure(result.stderr);
  return {
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    truncated: result.truncated,
    timedOut: false,
    failureReason,
    eventKind: failureReason === "none" ? "run-completed" : "run-failed",
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function deniedFailureReason(error: unknown): ContainerFailureReason {
  if (error instanceof CommandDeniedError && !error.message.includes("not found on PATH")) {
    return "denied";
  }
  return "spawn-error";
}

function outcomeFromError(
  error: unknown,
  cancelledByUser: boolean,
  durationMs: number,
): SettledOutcome {
  const base = { exitCode: null, durationMs, truncated: false, stdout: "", stderr: "" } as const;
  if (error instanceof CommandCancelledError || cancelledByUser) {
    return { ...base, timedOut: false, failureReason: "cancelled", eventKind: "run-cancelled" };
  }
  if (error instanceof CommandTimeoutError) {
    return { ...base, timedOut: true, failureReason: "timed-out", eventKind: "run-failed" };
  }
  return {
    ...base,
    timedOut: false,
    failureReason: deniedFailureReason(error),
    eventKind: "run-failed",
  };
}

function clampTimeout(requested: number | undefined, ceiling: number): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return ceiling;
  }
  const rounded = Math.round(requested);
  if (rounded <= MIN_TIMEOUT_MS) return MIN_TIMEOUT_MS;
  if (rounded >= ceiling) return ceiling;
  return rounded;
}

function requestIdPayload(input: ContainerRunInput): Record<string, string> {
  return input.requestId === undefined ? {} : { requestId: input.requestId };
}

function projectFor(store: UiStore, projectId: string): Project | undefined {
  for (const project of store.listProjects()) {
    if (project.path === projectId) {
      return project;
    }
  }
  return undefined;
}

function projectRootOrThrow(project: Project): string {
  try {
    return nodeWorkspaceFs.realPath(project.path);
  } catch {
    throw new ContainerRunnerError("PROJECT_NOT_FOUND", "Project root path could not be resolved.");
  }
}

function buildWorkspaceInfo(projectRoot: string): WorkspaceInfo {
  return {
    root: projectRoot,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

// ─── Manager ───────────────────────────────────────────────────────────────────────

interface InFlightRun {
  readonly controller: AbortController;
  cancelledByUser: boolean;
}

interface CapabilityCacheEntry {
  readonly expiresAt: number;
  readonly promise: Promise<ContainerCapabilityResponse>;
}

class ContainerRunnerManagerImpl implements ContainerRunnerManager {
  private readonly store: UiStore;
  private readonly evidenceStore: EvidenceStore | undefined;
  private readonly policy: SandboxPolicy;
  private readonly executionPolicy: ContainerExecutionPolicy;
  private readonly catalog: readonly ContainerTask[];
  private readonly processEnv: NodeJS.ProcessEnv;
  private readonly redactor: (input: string) => string;
  private readonly runDeps: Partial<RunCommandDeps>;
  private readonly detect:
    ((projectId: string) => Promise<ContainerCapabilityResponse>) | undefined;
  private readonly now: () => number;
  private readonly runs = new Map<string, InFlightRun>();
  private readonly subscribers = new Set<ContainerRunnerEventEmitter>();
  private readonly capabilityCache = new Map<string, CapabilityCacheEntry>();

  public constructor(opts: ContainerRunnerManagerOptions) {
    this.store = opts.store;
    this.evidenceStore = opts.evidenceStore;
    this.policy = opts.policy ?? DEFAULT_SANDBOX_POLICY;
    this.executionPolicy = opts.executionPolicy ?? DEFAULT_CONTAINER_EXECUTION_POLICY;
    this.catalog = opts.catalog ?? DEFAULT_CONTAINER_TASKS;
    this.processEnv = opts.processEnv ?? process.env;
    this.redactor = opts.redactor ?? ((input: string): string => input);
    this.runDeps = opts.runDeps ?? {};
    this.detect = opts.detect;
    this.now = opts.now ?? Date.now;
  }

  public readonly inFlightCount = (): number => this.runs.size;

  public readonly subscribe = (listener: ContainerRunnerEventEmitter): (() => void) => {
    this.subscribers.add(listener);
    return (): void => {
      this.subscribers.delete(listener);
    };
  };

  public readonly abort = (runId: string): boolean => {
    const entry = this.runs.get(runId);
    if (entry === undefined) return false;
    entry.cancelledByUser = true;
    entry.controller.abort();
    return true;
  };

  public readonly capability = (projectId: string): Promise<ContainerCapabilityResponse> => {
    return this.resolveCapability(projectId);
  };

  public readonly listCatalog = async (projectId: string): Promise<ContainerTaskCatalog> => {
    const capability = await this.resolveCapability(projectId);
    // Graceful degradation: no engine → engineAvailable:false + tasks:[] (never an error).
    const engineAvailable = capability.anyAvailable;
    return {
      schemaVersion: CONTAINER_RUNTIME_SCHEMA_VERSION,
      projectId,
      engineAvailable,
      tasks: engineAvailable ? this.catalog : [],
    };
  };

  public readonly execute = async (input: ContainerRunInput): Promise<ContainerRunResult> => {
    const workspace = this.resolveWorkspace(input.projectId);
    // Engine-unavailable is a GOVERNANCE failure: throw BEFORE minting a run id (route → 503).
    const capability = await this.resolveCapability(input.projectId);
    if (!capability.anyAvailable) {
      throw new ContainerRunnerError(
        "CONTAINER_ENGINE_UNAVAILABLE",
        "No container engine is available.",
      );
    }
    const task = this.catalog.find((entry) => entry.id === input.taskId);
    if (task === undefined) {
      throw new ContainerRunnerError("TASK_NOT_FOUND", "Task is not in the container catalog.");
    }
    if (!this.executionPolicy.imageAllowlist.includes(task.image)) {
      throw new ContainerRunnerError("IMAGE_NOT_ALLOWED", "Task image is not allowlisted.");
    }
    if (this.runs.size >= MAX_CONCURRENT_CONTAINER_RUNS) {
      throw new ContainerRunnerError("RUN_LIMIT_EXCEEDED", "Too many in-flight container runs.");
    }
    return this.runExecution(task, workspace, input);
  };

  private resolveCapability(projectId: string): Promise<ContainerCapabilityResponse> {
    const now = this.now();
    const cached = this.capabilityCache.get(projectId);
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.promise;
    }
    if (this.detect !== undefined) {
      const promise = this.detect(projectId);
      this.capabilityCache.set(projectId, { expiresAt: now + CAPABILITY_CACHE_TTL_MS, promise });
      promise.catch(() => {
        if (this.capabilityCache.get(projectId)?.promise === promise) {
          this.capabilityCache.delete(projectId);
        }
      });
      return promise;
    }
    const probeDeps: ContainerProbeDeps = {
      runCommand,
      workspace: this.tryWorkspace(projectId),
      policy: this.policy,
      processEnv: this.processEnv,
      now: this.now,
    };
    const promise = detectContainerEngines(probeDeps);
    this.capabilityCache.set(projectId, { expiresAt: now + CAPABILITY_CACHE_TTL_MS, promise });
    promise.catch(() => {
      if (this.capabilityCache.get(projectId)?.promise === promise) {
        this.capabilityCache.delete(projectId);
      }
    });
    return promise;
  }

  private tryWorkspace(projectId: string): WorkspaceInfo | undefined {
    const project = projectFor(this.store, projectId);
    if (project === undefined) {
      return undefined;
    }
    try {
      return buildWorkspaceInfo(projectRootOrThrow(project));
    } catch {
      return undefined;
    }
  }

  private resolveWorkspace(projectId: string): WorkspaceInfo {
    const project = projectFor(this.store, projectId);
    if (project === undefined) {
      throw new ContainerRunnerError("PROJECT_NOT_FOUND", "Project not found.");
    }
    return buildWorkspaceInfo(projectRootOrThrow(project));
  }

  private buildRunDeps(workspace: WorkspaceInfo): RunCommandDeps {
    return {
      workspace,
      // Host CLI policy: network:"inherit" so the docker/podman CLI reaches the daemon socket. The
      // CONTAINER is isolated by --network none in the frozen argv (D4).
      policy: { ...this.policy, network: "inherit" },
      commandRules: CONTAINER_TASK_RULES,
      spawn: this.runDeps.spawn ?? nodeSpawnFn,
      processEnv: this.processEnv,
      now: this.runDeps.now ?? this.now,
      ...(this.runDeps.resolveExecutable === undefined
        ? {}
        : { resolveExecutable: this.runDeps.resolveExecutable }),
      ...(this.runDeps.fs === undefined ? {} : { fs: this.runDeps.fs }),
      ...(this.runDeps.home === undefined ? {} : { home: this.runDeps.home }),
    };
  }

  private async runExecution(
    task: ContainerTask,
    workspace: WorkspaceInfo,
    input: ContainerRunInput,
  ): Promise<ContainerRunResult> {
    const runId = randomUUID();
    const controller = new AbortController();
    const entry: InFlightRun = { controller, cancelledByUser: false };
    this.runs.set(runId, entry);
    const startedAt = this.now();
    this.emit({
      kind: "run-started",
      runId,
      payload: {
        taskId: task.id,
        kind: task.kind,
        engine: task.engine,
        startedAt,
        ...requestIdPayload(input),
      },
    });
    try {
      return await this.invoke(runId, task, workspace, input, entry, startedAt);
    } finally {
      this.runs.delete(runId);
    }
  }

  private async invoke(
    runId: string,
    task: ContainerTask,
    workspace: WorkspaceInfo,
    input: ContainerRunInput,
    entry: InFlightRun,
    startedAt: number,
  ): Promise<ContainerRunResult> {
    const deps = this.buildRunDeps(workspace);
    const argv = buildContainerRunArgv(task, this.executionPolicy, workspace.root);
    const timeoutMs = clampTimeout(input.timeoutMs, this.policy.defaultTimeoutMs);
    try {
      // Single governed spawn boundary; the injected fake spawn (if any) rides in `deps.spawn`.
      const result = await runCommand(
        {
          command: task.engine,
          args: argv,
          cwd: undefined,
          timeoutMs,
          signal: entry.controller.signal,
        },
        deps,
      );
      return this.finalize(runId, task, argv.length, input, outcomeFromResult(result), startedAt);
    } catch (error) {
      const outcome = outcomeFromError(error, entry.cancelledByUser, this.now() - startedAt);
      return this.finalize(runId, task, argv.length, input, outcome, startedAt);
    }
  }

  private finalize(
    runId: string,
    task: ContainerTask,
    argCount: number,
    input: ContainerRunInput,
    outcome: SettledOutcome,
    startedAt: number,
  ): ContainerRunResult {
    this.persist(runId, task, argCount, input, outcome, startedAt);
    this.emit({
      kind: outcome.eventKind,
      runId,
      payload: {
        exitCode: outcome.exitCode,
        durationMs: outcome.durationMs,
        truncated: outcome.truncated,
        timedOut: outcome.timedOut,
        failureReason: outcome.failureReason,
        ...requestIdPayload(input),
      },
    });
    return {
      schemaVersion: CONTAINER_RUNTIME_SCHEMA_VERSION,
      runId,
      taskId: task.id,
      kind: task.kind,
      engine: task.engine,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      truncated: outcome.truncated,
      timedOut: outcome.timedOut,
      failureReason: outcome.failureReason,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
    };
  }

  private persist(
    runId: string,
    task: ContainerTask,
    argCount: number,
    input: ContainerRunInput,
    outcome: SettledOutcome,
    startedAt: number,
  ): void {
    if (this.evidenceStore === undefined) return;
    try {
      const evidence = buildContainerRunEvidenceEntry({
        runId,
        projectId: input.projectId,
        taskId: task.id,
        kind: task.kind,
        engine: task.engine,
        imageId: task.id, // closed-catalog id, NOT the raw image ref free-text
        argCount,
        exitCode: outcome.exitCode,
        durationMs: outcome.durationMs,
        timedOut: outcome.timedOut,
        truncated: outcome.truncated,
        failureReason: outcome.failureReason,
        stdoutBytes: Buffer.byteLength(outcome.stdout, "utf8"),
        stderrBytes: Buffer.byteLength(outcome.stderr, "utf8"),
        startedAt,
      });
      appendContainerRunEvidence(this.evidenceStore, evidence, this.redactor);
    } catch {
      // Evidence is best-effort process-evidence; a write hiccup must not corrupt a real run result.
    }
  }

  private emit(event: ContainerRunnerEvent): void {
    for (const listener of [...this.subscribers]) {
      try {
        listener(event);
      } catch {
        // A subscriber throwing must not stop fan-out (matches the command-runner pattern).
      }
    }
  }
}

export function createContainerRunnerManager(
  opts: ContainerRunnerManagerOptions,
): ContainerRunnerManager {
  return new ContainerRunnerManagerImpl(opts);
}
