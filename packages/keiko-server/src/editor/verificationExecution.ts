// Shared editor verification execution primitive (Issue #2211, Epic #2092, ADR-0043 D4). Extracted
// from postApplyVerification.ts's previously-inline "probe network isolation, then run under
// enforce-or-fail-closed" composition so BOTH callers use one implementation: the patch-apply
// post-apply phase (unchanged, synchronous) and the new editor verification route
// (VerificationRunnerManager). No new execution pipeline — this composes the UNCHANGED
// keiko-verification orchestrator with the keiko-sandbox network-isolation probe, exactly as the
// post-apply phase did before the extraction.
//
// Egress is enforced fail-closed: the host is probed for a network-isolating sandbox backend and the
// orchestrator runs with "enforce-or-fail-closed". On a host with a backend the run executes with
// network:"none" (attested); on a host without one, untrusted code is NOT executed and steps are
// reported `denied`.

import { currentPlatform, planIsolatedRun, probeBackends } from "@oscharko-dev/keiko-sandbox";
import {
  runVerification,
  type VerificationPlan,
  type VerificationReport,
} from "@oscharko-dev/keiko-verification";
import type { CommandTerminationEvidence } from "@oscharko-dev/keiko-contracts";
import type { WorkspaceFs, WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { logCommandTermination, processServerLogSink } from "../process-log-sink.js";
import type { ServerLogSink } from "../observability/server-log.js";

export interface NetworkIsolationProbe {
  readonly available: boolean;
  readonly backend: string;
}

// Probes whether THIS host can enforce a deny-by-default network-egress boundary for a run rooted at
// `cwd` (filesystem inherited — the run executes against the real workspace). No untrusted command is
// spawned during the probe.
export function probeNetworkIsolation(cwd: string): NetworkIsolationProbe {
  const decision = planIsolatedRun(
    { command: "node", args: [], cwd, network: "none" },
    probeBackends(),
    currentPlatform(),
  );
  return {
    available: decision.kind === "wrapped" && decision.attestation.networkEnforced,
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
  readonly fs?: WorkspaceFs | undefined;
}

export interface ExecuteVerificationResult {
  readonly report: VerificationReport;
  readonly probe: NetworkIsolationProbe;
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

// Probe, then run the plan under enforced, fail-closed egress isolation. Behavior is identical to the
// composition postApplyVerification.ts performed inline before this extraction.
export async function executeVerificationEnforced(
  args: ExecuteVerificationArgs,
): Promise<ExecuteVerificationResult> {
  const probe = probeNetworkIsolation(args.probeCwd ?? args.workspace.root);
  const activityLog = args.activityLog ?? processServerLogSink();
  const report = await runVerification(args.plan, {
    workspace: args.workspace,
    ...(args.fs === undefined ? {} : { fs: args.fs }),
    signal: args.signal,
    networkEnforcement: "enforce-or-fail-closed",
    enforcedNetworkAvailable: probe.available,
    // Deps-level termination-evidence port (PR #3354 review, 3887021650): a verification step's
    // timeout/abort leaves its verified Windows tree-kill disposition in the log.
    onTerminated: verificationTerminationHandler(activityLog, args.correlationId),
  });
  return { report, probe };
}
