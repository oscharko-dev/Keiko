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
  probeBackends,
  resolveLocalDockerEndpoint,
  LocalDockerEndpointUnavailableError,
} from "@oscharko-dev/keiko-sandbox";
import { createHash } from "node:crypto";
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
import type { CommandTerminationEvidence } from "@oscharko-dev/keiko-contracts";
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
      values: ["waiting", "acquired", "released"],
    },
    workspaceDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
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
  state: "waiting" | "acquired" | "released",
): void {
  (args.activityLog ?? processServerLogSink()).write(
    activityLogEvent(
      VERIFICATION_WORKSPACE_OPERATION,
      { correlationId: args.correlationId ?? UNKNOWN_CORRELATION_ID },
      { state, workspaceDigest: createHash("sha256").update(args.workspace.root).digest("hex") },
    ),
  );
}

export interface NetworkIsolationProbe {
  readonly available: boolean;
  readonly backend: string;
}

function localDockerAvailable(
  cwd: string,
  diagnostics: ServerDiagnosticSink | undefined,
  correlationId: string | undefined,
): boolean {
  try {
    return resolveLocalDockerEndpoint(process.env, cwd).kind === "available";
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
    return false;
  }
}

// Probes whether THIS host can enforce a deny-by-default network-egress boundary for a run rooted at
// `cwd`, with writes confined to that execution root. No untrusted command is
// spawned during the probe.
export function probeNetworkIsolation(
  cwd: string,
  diagnostics?: ServerDiagnosticSink,
  correlationId?: string,
): NetworkIsolationProbe {
  const decision = planIsolatedRun(
    { command: "node", args: [], cwd, network: "none", filesystem: "execution-root" },
    probeBackends(),
    currentPlatform(),
  );
  return {
    available:
      decision.kind === "wrapped" &&
      decision.attestation.networkEnforced &&
      decision.attestation.filesystemEnforced &&
      (decision.attestation.backend !== "container-docker" ||
        localDockerAvailable(cwd, diagnostics, correlationId)),
    backend: decision.attestation.backend,
  };
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
  // The orchestrator's redacted output tail of a step that did not pass (ADR-0126 D3), forwarded
  // as it happens; never part of the persisted report.
  readonly onStepOutput?: ((output: VerificationStepOutput) => void) | undefined;
}

// The egress policy every verification run executes under: a step that needs an enforced
// `network: "none"` boundary runs only where the probe found a backend, and is denied before
// spawning where it did not. It never degrades to an inherited network. One constant, so the policy
// the orchestrator receives and the policy the run reports cannot differ (F14, #3873).
const VERIFICATION_NETWORK_ENFORCEMENT =
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
  const probeStartedAtMs = Date.now();
  const probe = probeNetworkIsolation(
    args.probeCwd ?? args.workspace.root,
    args.diagnostics,
    args.correlationId,
  );
  const probeDurationMs = Math.max(0, Date.now() - probeStartedAtMs);
  const activityLog = args.activityLog ?? processServerLogSink();
  const report = await runVerification(args.plan, {
    workspace: args.workspace,
    ...(args.fs === undefined ? {} : { fs: args.fs }),
    signal: args.signal,
    networkEnforcement: VERIFICATION_NETWORK_ENFORCEMENT,
    enforcedNetworkAvailable: probe.available,
    // Deps-level termination-evidence port (PR #3354 review, 3887021650): a verification step's
    // timeout/abort leaves its verified Windows tree-kill disposition in the log.
    onTerminated: verificationTerminationHandler(activityLog, args.correlationId),
    onDependencyBootstrapFailure: verificationDependencyFailureHandler(
      args.diagnostics,
      args.correlationId,
    ),
    ...(args.dependencyBootstrap === undefined
      ? {}
      : { dependencyBootstrap: args.dependencyBootstrap }),
    ...(args.onStepOutput === undefined ? {} : { onStepOutput: args.onStepOutput }),
  });
  return {
    report,
    probe,
    probeDurationMs,
    networkEnforcement: VERIFICATION_NETWORK_ENFORCEMENT,
  };
}
