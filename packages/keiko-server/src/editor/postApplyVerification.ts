// Post-apply verification orchestration for editor-driven patch apply (Issue #1204, ADR-0042 D7,
// ADR-0043). After a generated test patch is applied to the workspace, this re-confirms the candidate
// IN PLACE — it runs the applied test file(s) as a targeted-test step through the keiko-verification
// orchestrator, isolated by an ENFORCED, deny-by-default network-egress boundary (keiko-sandbox). It is
// a confirmation that an already-assured candidate still holds (integration + write-conflict), NOT the
// generation-time mutation/coverage gate (that stays in #1202/#1203).
//
// Egress is enforced fail-closed: the host is probed for a network-isolating sandbox backend, and the
// orchestrator runs with "enforce-or-fail-closed". On a host with a backend the applied test executes
// with network:"none" (attested); on a host without one the untrusted test code is NOT executed and the
// outcome is `denied`. The applied test runs against the real workspace (filesystem inherited) because
// the user explicitly applied the patch there; only egress — the data-exfiltration threat — is blocked.
//
// The node effects (sandbox probe, orchestrator run) sit behind an injectable port so the route's tests
// drive deterministic outcomes without a sandbox backend.

import { currentPlatform, planIsolatedRun, probeBackends } from "@oscharko-dev/keiko-sandbox";
import { DEFAULT_SANDBOX_POLICY } from "@oscharko-dev/keiko-tools";
import {
  DEFAULT_VERIFICATION_LIMITS,
  planDirectTargetedTests,
  runVerification,
  type VerificationReport,
  type VerificationResult,
} from "@oscharko-dev/keiko-verification";
import { detectWorkspaceAt, type WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import type { EditorPatchVerificationSummary } from "@oscharko-dev/keiko-contracts";

export interface PostApplyVerificationArgs {
  readonly realRoot: string;
  // Workspace-relative paths of the applied test files to re-confirm (deleted paths excluded).
  readonly appliedTestFiles: readonly string[];
  readonly signal: AbortSignal;
}

export interface PostApplyVerificationResult {
  readonly summary: EditorPatchVerificationSummary;
  // Content-free command label for the audit record (Issue #1204 AC13). No file paths.
  readonly command: string;
}

/** Injectable post-apply verification port (tests supply a deterministic outcome). */
export type PostApplyVerificationPort = (
  args: PostApplyVerificationArgs,
) => Promise<PostApplyVerificationResult>;

const ENV_ALLOWLIST_COUNT = DEFAULT_SANDBOX_POLICY.envAllowlist.length;

function bounds(): EditorPatchVerificationSummary["bounds"] {
  return {
    wallTimeMs: DEFAULT_VERIFICATION_LIMITS.wallTimeMs,
    maxOutputBytes: DEFAULT_VERIFICATION_LIMITS.maxOutputBytes,
    envAllowlistCount: ENV_ALLOWLIST_COUNT,
  };
}

/** The summary for a post-apply verification that did not run (no resolvable targeted test). */
export function notRunVerificationSummary(): EditorPatchVerificationSummary {
  return {
    outcome: "not-run",
    networkEnforced: false,
    sandboxBackend: "none",
    stepCount: 0,
    passed: 0,
    failed: 0,
    durationMs: 0,
    bounds: bounds(),
    preApply: false,
    secretsRedacted: true,
    detail: "No runnable test was resolved for the applied files; verification did not run.",
  };
}

/** The summary for a verification explicitly skipped by configured policy (`verify: false`). */
export function skippedVerificationSummary(): EditorPatchVerificationSummary {
  return {
    outcome: "skipped",
    networkEnforced: false,
    sandboxBackend: "none",
    stepCount: 0,
    passed: 0,
    failed: 0,
    durationMs: 0,
    bounds: bounds(),
    preApply: false,
    secretsRedacted: true,
    detail: "Post-apply verification was disabled by configured policy.",
  };
}

interface NetworkIsolationProbe {
  readonly available: boolean;
  readonly backend: string;
}

// Probes whether THIS host can enforce a deny-by-default network-egress boundary for a run rooted at
// `cwd` (filesystem inherited — the applied test runs against the real workspace). No untrusted command
// is spawned during the probe. A network:"none" run is enforceable on more backends (macOS seatbelt,
// Linux bubblewrap/unshare) than the execution-root boundary the assured pre-filter requires.
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

const FAILED_STATUSES: ReadonlySet<VerificationResult["status"]> = new Set([
  "failed",
  "timed-out",
  "resource-exceeded",
  "denied",
]);

function networkEnforcedFromReport(results: readonly VerificationResult[]): boolean {
  return results.some((result) =>
    result.appliedLimits.some((decision) => decision.dimension === "network" && decision.enforced),
  );
}

// Maps the orchestrator report onto the content-free verification summary. A `denied` step (egress could
// not be enforced) is surfaced distinctly from a `failed` step (the applied test did not pass).
function toSummary(
  report: VerificationReport,
  probe: NetworkIsolationProbe,
): EditorPatchVerificationSummary {
  const results = report.results;
  const denied = results.some((result) => result.status === "denied");
  const passed = results.filter((result) => result.status === "passed").length;
  const failed = results.filter((result) => FAILED_STATUSES.has(result.status)).length;
  const outcome = denied ? "denied" : report.overallStatus === "passed" ? "passed" : "failed";
  return {
    outcome,
    networkEnforced: !denied && networkEnforcedFromReport(results),
    sandboxBackend: denied ? "none" : probe.backend,
    stepCount: results.length,
    passed,
    failed,
    durationMs: report.durationMs,
    bounds: bounds(),
    preApply: false,
    secretsRedacted: true,
    detail: detailFor(outcome),
  };
}

function detailFor(outcome: EditorPatchVerificationSummary["outcome"]): string {
  if (outcome === "denied") {
    return "No enforcing sandbox backend is available on this host; the applied test was not executed.";
  }
  if (outcome === "failed") {
    return "The applied test did not pass under enforced isolation. Review the change and the revert proposal.";
  }
  return "The applied test passed under enforced isolation.";
}

function verificationCommand(workspace: WorkspaceInfo): string {
  if (workspace.testFramework === "vitest") {
    return "npx vitest run";
  }
  if (workspace.testFramework === "jest") {
    return "npx jest";
  }
  return "none";
}

// The route's default post-apply verification: plan a targeted-test step for the applied files, then run
// it through the orchestrator with enforced, fail-closed egress isolation.
export const defaultPostApplyVerification: PostApplyVerificationPort = async (args) => {
  const workspace = detectWorkspaceAt(args.realRoot, nodeWorkspaceFs);
  const steps = planDirectTargetedTests(workspace, args.appliedTestFiles, nodeWorkspaceFs);
  if (steps.length === 0) {
    return { summary: notRunVerificationSummary(), command: "none" };
  }
  const probe = probeNetworkIsolation(args.realRoot);
  const report = await runVerification(
    { workspaceRoot: workspace.root, steps },
    {
      workspace,
      signal: args.signal,
      networkEnforcement: "enforce-or-fail-closed",
      enforcedNetworkAvailable: probe.available,
    },
  );
  return { summary: toSummary(report, probe), command: verificationCommand(workspace) };
};
