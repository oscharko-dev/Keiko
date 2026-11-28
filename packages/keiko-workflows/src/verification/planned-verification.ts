// The verification wiring the unit-test and bug-investigation stages share (ADR-0008 D5, ADR-0009
// D11). Each stage decides WHICH test files its plan targets; resolving the plan (targeted steps
// first, then the full `test` script), binding the plan to the package scripts it was built on, and
// running it under the fail-closed egress policy are the same for both and live here once.

import type { SpawnFn } from "@oscharko-dev/keiko-tools";
import { nodeSpawnFn } from "@oscharko-dev/keiko-tools/internal/exec";
import type { WorkspaceFs, WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import {
  buildVerificationPlan,
  detectScripts,
  runVerification,
  scriptTableDigest,
  summarizeForAudit,
  type NetworkEnforcementMode,
  type VerificationAuditSummary,
  type VerificationPlan,
  type VerificationStep,
} from "@oscharko-dev/keiko-verification";

export const SKIP_UNRESOLVED = "verification skipped: framework unknown or no test files resolved";

// A plan together with the digest of the package scripts it was built on, from that very read: the
// effect re-proves it right before each script step, so a script changed after planning is never
// run under this plan (targeted steps run no package script and carry none).
export interface PlannedVerification {
  readonly plan: VerificationPlan;
  readonly approvedScriptsDigest: string | undefined;
}

// A candidate is evaluated only when every earlier one resolved no step, so a stage keeps the order
// and the laziness of its own lookups.
export type TargetedCandidate = () => readonly VerificationStep[];

function buildPlanFallback(
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
): { readonly plan: VerificationPlan; readonly scriptsDigest: string } {
  const catalog = detectScripts(workspace, fs);
  return {
    plan: buildVerificationPlan(workspace, catalog, { only: ["test"] }, fs),
    scriptsDigest: scriptTableDigest(catalog.scripts),
  };
}

export function resolvePlannedVerification(
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
  candidates: readonly TargetedCandidate[],
): PlannedVerification | undefined {
  for (const candidate of candidates) {
    const steps = candidate();
    if (steps.length > 0) {
      return {
        plan: { workspaceRoot: workspace.root, steps },
        approvedScriptsDigest: undefined,
      };
    }
  }
  const fallback = buildPlanFallback(workspace, fs);
  const runnable = fallback.plan.steps.filter((step) => step.skipReason === undefined);
  return runnable.length > 0
    ? {
        plan: { workspaceRoot: workspace.root, steps: runnable },
        approvedScriptsDigest: fallback.scriptsDigest,
      }
    : undefined;
}

// What both stages' run state offers the verification run.
export interface VerificationRunHost {
  readonly signal: AbortSignal;
  readonly now: () => number;
  readonly deps: {
    readonly spawn?: SpawnFn | undefined;
    readonly processEnv?: NodeJS.ProcessEnv | undefined;
    readonly verificationNetworkEnforcement?: NetworkEnforcementMode | undefined;
    readonly verificationEnforcedNetworkAvailable?: boolean | undefined;
  };
}

export async function runPlannedVerification(
  host: VerificationRunHost,
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
  planned: PlannedVerification,
): Promise<VerificationAuditSummary> {
  const { deps } = host;
  const report = await runVerification(planned.plan, {
    workspace,
    signal: host.signal,
    spawn: deps.spawn ?? nodeSpawnFn,
    processEnv: deps.processEnv ?? process.env,
    now: host.now,
    fs,
    // A package script runs only as the bytes this plan was built on: a model patch that rewrites
    // package.json after planning is denied, and a plan without a digest never runs a script.
    requireApprovedScripts: true,
    ...(planned.approvedScriptsDigest === undefined
      ? {}
      : { approvedScriptsDigest: planned.approvedScriptsDigest }),
    // Explicit-only (ADR-0043 D8): leaving this undefined applies the orchestrator's fail-closed
    // default. Deriving it from an injected dependency instead — `spawn !== undefined`, as shorthand
    // for "a test harness is driving this" — also matched the production budget wrapper, which is
    // exactly how a governed run injects its spawn, so the egress boundary was disabled on the one
    // path that executes model-authored code.
    networkEnforcement: deps.verificationNetworkEnforcement,
    ...(deps.verificationEnforcedNetworkAvailable === undefined
      ? {}
      : { enforcedNetworkAvailable: deps.verificationEnforcedNetworkAvailable }),
  });
  return summarizeForAudit(report);
}

// The output-text-free fields of the stage's `verification:result` event.
export function verificationResultFields(summary: VerificationAuditSummary): {
  readonly overallStatus: VerificationAuditSummary["overallStatus"];
  readonly stepCount: number;
  readonly passedCount: number;
  readonly durationMs: number;
} {
  return {
    overallStatus: summary.overallStatus,
    stepCount: summary.results.length,
    passedCount: summary.results.filter((r) => r.status === "passed").length,
    durationMs: summary.durationMs,
  };
}
