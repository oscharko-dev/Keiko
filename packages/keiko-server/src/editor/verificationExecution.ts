// Shared editor verification execution primitive (Issue #2211, Epic #2092, ADR-0043 D4). Extracted
// from postApplyVerification.ts's previously-inline "probe network isolation, then run under
// enforce-or-fail-closed" composition so BOTH callers use one implementation: the patch-apply
// post-apply phase (unchanged, synchronous) and the new editor verification route
// (VerificationRunnerManager). No new execution pipeline — this composes the UNCHANGED
// keiko-verification orchestrator with the keiko-sandbox network-isolation probe, exactly as the
// post-apply phase did before the extraction.
//
// Network and execution-root writes are enforced fail-closed: the host is probed for a backend and the
// orchestrator runs with "enforce-or-fail-closed". On a host with a backend the run executes with
// network:"none" and filesystem:"execution-root" (attested); without one, code is not executed and steps are
// reported `denied`.

import {
  currentPlatform,
  planIsolatedRun,
  type BackendAvailability,
  probeBackends,
  resolveLocalDockerEndpoint,
  LocalDockerEndpointUnavailableError,
} from "@oscharko-dev/keiko-sandbox";
import { createHash } from "node:crypto";
import { request } from "node:http";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  runVerification,
  type NetworkEnforcementMode,
  type VerificationPlan,
  type VerificationReport,
  type VerificationStepOutput,
  type VerificationDeps,
} from "@oscharko-dev/keiko-verification";
import type {
  CommandTerminationEvidence,
  WindowsStepSupervisor,
} from "@oscharko-dev/keiko-contracts";
import type { WorkspaceFs, WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import {
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticSink,
} from "../diagnostics-log.js";
import { logCommandTermination, processServerLogSink } from "../process-log-sink.js";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { createWorkspaceMutexRegistry, fileWriteKeys } from "../task-workspace/mutex.js";

import { resolveVerificationRuntimeTarget } from "./verificationRuntimeTarget.js";
import { resolveWindowsStepSupervisor } from "./windowsStepSupervisor.js";
import { privateStepWorkspace, type PrivateStepWorkspace } from "./windowsStepWorkspace.js";

const verificationWorkspaces = createWorkspaceMutexRegistry();
const VERIFICATION_WORKSPACE_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "editor.verification.workspace",
  category: "process",
  owner: "keiko-server",
  emitter: "editor.verificationExecution.workspaceAdmission",
  fields: {
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["waiting", "acquired", "released", "runtime-target"],
    },
    workspaceDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    runtimeTargetOutcome: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["measured", "refused"],
    },
    runtimeIdentityDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["verification-runner-failure"],
  proofIds: ["editor.verification.workspace.emitted-line"],
  releaseImpact: "patch",
});

function workspaceAdmission(
  args: ExecuteVerificationArgs,
  state: "waiting" | "acquired" | "released" | "runtime-target",
  runtimeTargetOutcome?: "measured" | "refused",
  runtimeIdentityDigest?: string,
): void {
  (args.activityLog ?? processServerLogSink()).write(
    activityLogEvent(
      VERIFICATION_WORKSPACE_OPERATION,
      { correlationId: args.correlationId ?? UNKNOWN_CORRELATION_ID },
      {
        state,
        workspaceDigest: createHash("sha256").update(args.workspace.root).digest("hex"),
        ...(runtimeTargetOutcome === undefined ? {} : { runtimeTargetOutcome }),
        ...(runtimeIdentityDigest === undefined ? {} : { runtimeIdentityDigest }),
      },
    ),
  );
}

export interface NetworkIsolationProbe {
  readonly available: boolean;
  readonly backend: string;
  // How the local Docker engine answered, when the backend is one and the run asked it (#4519).
  readonly engine?: DockerEngineAnswer | undefined;
}

// The local Docker endpoint the run would use, or undefined when none is usable.
function localDockerHost(
  cwd: string,
  diagnostics: ServerDiagnosticSink | undefined,
  correlationId: string | undefined,
): string | undefined {
  try {
    const endpoint = resolveLocalDockerEndpoint(process.env, cwd);
    return endpoint.kind === "available" ? endpoint.host : undefined;
  } catch (error) {
    if (!(error instanceof LocalDockerEndpointUnavailableError)) throw error;
    emitServerDiagnostic(
      diagnostics,
      serverDiagnosticFromError({
        correlationId: correlationId ?? UNKNOWN_CORRELATION_ID,
        operation: "verification.isolation-probe",
        source: "verification.isolation-probe.local-docker",
        error,
        redact: () => "docker-local-context-unavailable",
      }),
    );
    return undefined;
  }
}

const LOCAL_DOCKER_PING_TIMEOUT_MS = 2_000;

/** How a local Docker engine answered the verifier's ping (#4519); closed values only. */
export const DOCKER_ENGINE_ANSWER_VALUES = [
  "answered",
  "refused",
  "unanswered",
  "rejected",
] as const;
export type DockerEngineAnswer = (typeof DOCKER_ENGINE_ANSWER_VALUES)[number];

/**
 * How a local Docker engine answers its API's `GET /_ping` (#4519). `answered` (HTTP 200) is the
 * only running engine. `refused` is a connection that failed, such as a socket file a crashed or
 * stopped engine left behind: the file still stats as a socket, so only a request tells the two
 * apart. `unanswered` is no response within the timeout, and `rejected` any other response, such
 * as a socket whose engine is still starting. A Windows named pipe is already proven served when it
 * resolves (a pipe nobody serves does not exist), so it is not asked again.
 */
export function localDockerEngineAnswer(
  host: string,
  timeoutMs: number = LOCAL_DOCKER_PING_TIMEOUT_MS,
): Promise<DockerEngineAnswer> {
  if (host.startsWith("npipe://")) return Promise.resolve("answered");
  if (!host.startsWith("unix://")) return Promise.resolve("refused");
  return new Promise((resolve) => {
    const ping = request({
      socketPath: host.slice("unix://".length),
      path: "/_ping",
      agent: false,
      timeout: timeoutMs,
    });
    ping.on("response", (response) => {
      // The answer is taken from the status alone; a body cut short afterwards changes nothing.
      response.on("error", () => {
        resolve("rejected");
      });
      response.resume();
      resolve(response.statusCode === 200 ? "answered" : "rejected");
    });
    ping.on("timeout", () => {
      resolve("unanswered");
      ping.destroy();
    });
    ping.on("error", () => {
      resolve("refused");
    });
    ping.end();
  });
}

// Probes whether THIS host can enforce a deny-by-default network-egress boundary for a run rooted at
// `cwd`, with writes confined to that execution root. No untrusted command is
// spawned during the probe.
// The host's backends: the probed ones, and on Windows the verified supervisor, never a PATH entry.
function isolationAvailability(
  platform: NodeJS.Platform,
  correlationId: string | undefined,
): BackendAvailability {
  return {
    ...probeBackends(),
    windowsAppContainer:
      platform === "win32" &&
      resolveWindowsStepSupervisor({ activityLog: processServerLogSink(), correlationId }) !==
        undefined,
  };
}

/**
 * The execution-root backend a verification run gets on this host, and whether it can enforce. A
 * Docker that is installed but not served is no backend; on Windows the supervisor's step backend
 * then takes the run, as on a host without a container runtime (#4496, ADR-0043 D20).
 */
export function planIsolationProbe(
  cwd: string,
  availability: BackendAvailability,
  platform: NodeJS.Platform,
  dockerServed: () => boolean,
): NetworkIsolationProbe {
  const decision = planIsolatedRun(
    { command: "node", args: [], cwd, network: "none", filesystem: "execution-root" },
    availability,
    platform,
  );
  const enforced =
    decision.kind === "wrapped" &&
    decision.attestation.networkEnforced &&
    decision.attestation.filesystemEnforced;
  const backend = decision.attestation.backend;
  if (backend !== "container-docker") return { available: enforced, backend };
  if (enforced && dockerServed()) return { available: true, backend };
  return availability.windowsAppContainer === true
    ? planIsolationProbe(cwd, { ...availability, docker: false }, platform, dockerServed)
    : { available: false, backend };
}

export function probeNetworkIsolation(
  cwd: string,
  diagnostics?: ServerDiagnosticSink,
  correlationId?: string,
): NetworkIsolationProbe {
  const platform = currentPlatform();
  return planIsolationProbe(
    cwd,
    isolationAvailability(platform, correlationId),
    platform,
    () => localDockerHost(cwd, diagnostics, correlationId) !== undefined,
  );
}

/**
 * The probe a verification run executes under: `probeNetworkIsolation`, and for a local Docker
 * engine also whether that engine answers its ping (#4519). A Docker that is installed and not running is no
 * enforcing backend, so its steps are refused as isolation unavailable instead of failing inside the
 * Docker client as if the project's own check had failed; on Windows the supervisor's step backend
 * takes such a run instead (#4496).
 */
export async function probeNetworkIsolationServed(
  cwd: string,
  diagnostics?: ServerDiagnosticSink,
  correlationId?: string,
): Promise<NetworkIsolationProbe> {
  const platform = currentPlatform();
  const availability = isolationAvailability(platform, correlationId);
  const served = (): boolean => localDockerHost(cwd, diagnostics, correlationId) !== undefined;
  const probe = planIsolationProbe(cwd, availability, platform, served);
  if (!probe.available || probe.backend !== "container-docker") return probe;
  const host = localDockerHost(cwd, diagnostics, correlationId);
  if (host === undefined) return { ...probe, available: false };
  const engine = await localDockerEngineAnswer(host);
  if (engine === "answered") return { ...probe, engine };
  return availability.windowsAppContainer === true
    ? planIsolationProbe(cwd, { ...availability, docker: false }, platform, served)
    : { ...probe, available: false, engine };
}

/**
 * The backends a verification run's steps select from. A run the probe gave the Windows step
 * backend runs its steps with exactly the backends the probe planned with: a Docker that is
 * installed but not served must not take the steps back (#4496). A supervisor that is gone when the
 * steps start leaves the run without an enforcing backend, a closed refusal.
 */
export function windowsStepRunDeps(
  probe: NetworkIsolationProbe,
  supervisor: WindowsStepSupervisor | undefined,
  installed: BackendAvailability = probeBackends(),
): Pick<VerificationDeps, "enforcedNetworkAvailable" | "sandboxAvailability"> {
  if (probe.backend !== "windows-appcontainer")
    return { enforcedNetworkAvailable: probe.available };
  if (supervisor === undefined) return { enforcedNetworkAvailable: false };
  return {
    enforcedNetworkAvailable: probe.available,
    sandboxAvailability: { ...installed, docker: false, podman: false, windowsAppContainer: true },
  };
}

/** An isolation probe and its own wall time, in whole milliseconds. */
export interface TimedNetworkIsolationProbe {
  readonly probe: NetworkIsolationProbe;
  readonly durationMs: number;
}

export async function timedNetworkIsolationProbe(
  cwd: string,
  diagnostics?: ServerDiagnosticSink,
  correlationId?: string,
): Promise<TimedNetworkIsolationProbe> {
  const startedAtMs = Date.now();
  const probe = await probeNetworkIsolationServed(cwd, diagnostics, correlationId);
  return { probe, durationMs: Math.max(0, Date.now() - startedAtMs) };
}

export interface ExecuteVerificationArgs {
  readonly plan: VerificationPlan;
  readonly workspace: WorkspaceInfo;
  readonly signal: AbortSignal;
  // The cwd probed for network-isolation capability; defaults to the workspace root. Post-apply passes
  // its `realRoot` here to keep its probe cwd byte-identical to the pre-extraction behavior.
  readonly probeCwd?: string | undefined;
  // The caller's own run-scoped correlation id (e.g. VerificationRunnerManager's per-run
  // `entry.correlationId`), threaded onto the termination-evidence line below when the caller has
  // one. Callers without a request-scoped id (or that have not been updated to pass one) fall back
  // to UNKNOWN_CORRELATION_ID exactly as before — this field is additive.
  readonly correlationId?: string | undefined;
  // Activity-log port for the runCommand termination-evidence seam, mirroring every sibling
  // composition site (command-runner.ts, terminal.ts, containerRunner.ts, …). Defaults to
  // processServerLogSink() so production logging needs no wiring; tests inject a capture sink —
  // without this seam the evidence line was unobservable to any test in this file.
  readonly activityLog?: ServerLogSink | undefined;
  readonly diagnostics?: ServerDiagnosticSink | undefined;
  readonly fs?: WorkspaceFs | undefined;
  // ADR-0043 D17: install the manifest's declared dependencies before the first script step when
  // the installed tree is not current. Off unless the caller asks, exactly like the orchestrator.
  readonly dependencyBootstrap?: "off" | "auto" | undefined;
  // The platform of the native coding runtime that shares this workspace (`sharedHostPlatform` of
  // the bootstrap): an install for another platform is refused instead of replacing its bindings.
  readonly sharedHostPlatform?: VerificationDeps["sharedHostPlatform"];
  // The orchestrator's redacted output tail of a step that did not pass (ADR-0126 D3), forwarded
  // as it happens; never part of the persisted report.
  readonly onStepOutput?: ((output: VerificationStepOutput) => void) | undefined;
  readonly onTargetedProjectFailure?: VerificationDeps["onTargetedProjectFailure"];
  // An isolation probe the caller already took (#4519). The run then executes under the verdict its
  // script-trust decision was made on: a run admitted without trust because no step could be
  // isolated never runs a step that a backend started meanwhile would admit. Absent, the run
  // probes the host itself.
  readonly isolation?: TimedNetworkIsolationProbe | undefined;
}

// The egress policy every verification run executes under: a step that needs an enforced
// `network: "none"` boundary runs only where the probe found a backend, and is denied before
// spawning where it did not. It never degrades to an inherited network. One constant, so the policy
// the orchestrator receives and the policy the run reports cannot differ (F14, #3873).
export const VERIFICATION_NETWORK_ENFORCEMENT =
  "enforce-or-fail-closed" as const satisfies NetworkEnforcementMode;

export interface ExecuteVerificationResult {
  readonly report: VerificationReport;
  readonly probe: NetworkIsolationProbe;
  // Wall time of the isolation probe, in whole milliseconds. It runs before the report's own clock
  // starts, so no duration on the report accounts for it. Optional so a caller-supplied execution
  // port that does not measure it stays valid; the real execution always reports it.
  readonly probeDurationMs?: number | undefined;
  // The egress policy the orchestrator ran under (see VERIFICATION_NETWORK_ENFORCEMENT).
  readonly networkEnforcement?: NetworkEnforcementMode | undefined;
}

// Builds the runCommand termination-evidence callback for one verification run, tagged with the
// caller's own correlationId when it has one (audit finding: VerificationRunnerManager already
// tracks a per-run correlationId at both its call sites but never forwarded it this far). Exported
// for direct unit coverage: forcing this seam through a REAL timeout/abort in a test would make the
// assertion host-dependent — on a host with no enforcing sandbox backend the run denies BEFORE
// spawning (see this file's own host-adaptive test) and onTerminated never fires at all.
export function verificationTerminationHandler(
  activityLog: ServerLogSink,
  correlationId: string | undefined,
): (evidence: CommandTerminationEvidence) => void {
  return (evidence): void => {
    logCommandTermination(activityLog, correlationId ?? UNKNOWN_CORRELATION_ID, evidence);
  };
}

export function verificationDependencyFailureHandler(
  diagnostics: ServerDiagnosticSink | undefined,
  correlationId: string | undefined,
): NonNullable<VerificationDeps["onDependencyBootstrapFailure"]> {
  return ({ stage, error }): void => {
    emitServerDiagnostic(
      diagnostics,
      serverDiagnosticFromError({
        correlationId: correlationId ?? UNKNOWN_CORRELATION_ID,
        operation: "verification.dependency-bootstrap",
        source: `verification.dependency-bootstrap.${stage}`,
        error,
        redact: () => "server-operation-failed",
      }),
    );
  };
}

function targetedProjectFailureHandler(
  args: ExecuteVerificationArgs,
): NonNullable<VerificationDeps["onTargetedProjectFailure"]> {
  return (error): void => {
    emitServerDiagnostic(
      args.diagnostics,
      serverDiagnosticFromError({
        correlationId: args.correlationId ?? UNKNOWN_CORRELATION_ID,
        operation: "verification.targeted-project",
        source: "verification.targeted-project.guard",
        error,
        redact: () => "server-operation-failed",
      }),
    );
    args.onTargetedProjectFailure?.(error);
  };
}

function verificationRuntimeTargetResolver(
  args: ExecuteVerificationArgs,
  windowsStepSupervisor: VerificationDeps["windowsStepSupervisor"],
): NonNullable<VerificationDeps["resolveDependencyInstallTarget"]> {
  return async () => {
    try {
      const target = await resolveVerificationRuntimeTarget({
        workspace: args.workspace,
        signal: args.signal,
        ...(args.fs === undefined ? {} : { fs: args.fs }),
        ...(windowsStepSupervisor === undefined ? {} : { windowsStepSupervisor }),
        onTerminated: verificationTerminationHandler(
          args.activityLog ?? processServerLogSink(),
          args.correlationId,
        ),
      });
      workspaceAdmission(args, "runtime-target", "measured", target.runtimeIdentitySha256);
      return target;
    } catch (error) {
      workspaceAdmission(args, "runtime-target", "refused");
      throw error;
    }
  };
}

// Probe, then run the plan under enforced, fail-closed egress isolation. Behavior is identical to the
// composition postApplyVerification.ts performed inline before this extraction.
export async function executeVerificationEnforced(
  args: ExecuteVerificationArgs,
): Promise<ExecuteVerificationResult> {
  workspaceAdmission(args, "waiting");
  return verificationWorkspaces.runExclusive(fileWriteKeys(args.workspace.root), async () => {
    workspaceAdmission(args, "acquired");
    try {
      return await executeExclusiveVerification(args);
    } finally {
      workspaceAdmission(args, "released");
    }
  });
}

async function executeExclusiveVerification(
  args: ExecuteVerificationArgs,
): Promise<ExecuteVerificationResult> {
  const { probe, durationMs: probeDurationMs } =
    args.isolation ??
    (await timedNetworkIsolationProbe(
      args.probeCwd ?? args.workspace.root,
      args.diagnostics,
      args.correlationId,
    ));
  const activityLog = args.activityLog ?? processServerLogSink();
  // #4496: only a run the probe gave the Windows backend frames its steps to the supervisor, in a
  // private copy of the workspace that the run removes when it ends.
  const windowsStepSupervisor =
    probe.available && probe.backend === "windows-appcontainer"
      ? resolveWindowsStepSupervisor({ activityLog, correlationId: args.correlationId })
      : undefined;
  const stepCopy =
    windowsStepSupervisor === undefined
      ? undefined
      : privateStepWorkspace(args.workspace, activityLog, args.correlationId);
  try {
    return {
      report: await runVerification(
        args.plan,
        verificationDeps(args, activityLog, probe, windowsStepSupervisor, stepCopy),
      ),
      probe,
      probeDurationMs,
      networkEnforcement: VERIFICATION_NETWORK_ENFORCEMENT,
    };
  } finally {
    stepCopy?.dispose();
  }
}

function verificationDeps(
  args: ExecuteVerificationArgs,
  activityLog: ServerLogSink,
  probe: NetworkIsolationProbe,
  windowsStepSupervisor: WindowsStepSupervisor | undefined,
  stepCopy: PrivateStepWorkspace | undefined,
): VerificationDeps {
  return {
    workspace: args.workspace,
    resolveDependencyInstallTarget: verificationRuntimeTargetResolver(args, windowsStepSupervisor),
    ...(windowsStepSupervisor === undefined ? {} : { windowsStepSupervisor }),
    ...(stepCopy === undefined ? {} : { stepWorkspace: stepCopy.workspace }),
    ...(args.fs === undefined ? {} : { fs: args.fs }),
    signal: args.signal,
    networkEnforcement: VERIFICATION_NETWORK_ENFORCEMENT,
    ...windowsStepRunDeps(probe, windowsStepSupervisor),
    // Deps-level termination-evidence port (PR #3354 review, 3887021650): a verification step's
    // timeout/abort leaves its verified Windows tree-kill disposition in the log.
    onTerminated: verificationTerminationHandler(activityLog, args.correlationId),
    onTargetedProjectFailure: targetedProjectFailureHandler(args),
    onDependencyBootstrapFailure: verificationDependencyFailureHandler(
      args.diagnostics,
      args.correlationId,
    ),
    ...(args.dependencyBootstrap === undefined
      ? {}
      : { dependencyBootstrap: args.dependencyBootstrap }),
    ...(args.sharedHostPlatform === undefined
      ? {}
      : { sharedHostPlatform: args.sharedHostPlatform }),
    ...(args.onStepOutput === undefined ? {} : { onStepOutput: args.onStepOutput }),
  };
}
