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
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";

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
}

export interface ExecuteVerificationResult {
  readonly report: VerificationReport;
  readonly probe: NetworkIsolationProbe;
}

// Probe, then run the plan under enforced, fail-closed egress isolation. Behavior is identical to the
// composition postApplyVerification.ts performed inline before this extraction.
export async function executeVerificationEnforced(
  args: ExecuteVerificationArgs,
): Promise<ExecuteVerificationResult> {
  const probe = probeNetworkIsolation(args.probeCwd ?? args.workspace.root);
  const report = await runVerification(args.plan, {
    workspace: args.workspace,
    signal: args.signal,
    networkEnforcement: "enforce-or-fail-closed",
    enforcedNetworkAvailable: probe.available,
  });
  return { report, probe };
}
