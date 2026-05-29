// The verification stage (ADR-0008 D5, steering note C). Runs ONLY after a successful apply: it
// resolves a verification plan by deriving the just-created test from the target SOURCE file(s) via
// #7 resolveTargetedTests, falling back to the full `test` script, and records an explicit skip
// reason when neither resolves or the framework is unknown. Verification reuses the #7 orchestrator
// unchanged; this stage only wires the plan and projects an output-text-free audit summary.

import { nodeSpawnFn } from "../../tools/index.js";
import { type WorkspaceFs, type WorkspaceInfo } from "../../workspace/index.js";
import {
  buildVerificationPlan,
  detectScripts,
  resolveTargetedTests,
  runVerification,
  summarizeForAudit,
  DEFAULT_VERIFICATION_LIMITS,
  type VerificationAuditSummary,
  type VerificationPlan,
} from "../../verification/index.js";
import type { RunState } from "./internal.js";
import type { UnitTestTarget } from "./types.js";

export const SKIP_UNRESOLVED = "verification skipped: framework unknown or no test files resolved";

// The source files the target points at — passed to resolveTargetedTests so it can find the
// just-created sibling/mirrored test (steering note C). Test files are NOT passed here.
function targetSourceFiles(target: UnitTestTarget): readonly string[] {
  if (target.kind === "file") {
    return [target.filePath];
  }
  if (target.kind === "changedFiles") {
    return target.filePaths;
  }
  return [target.moduleDir];
}

function buildPlanFallback(workspace: WorkspaceInfo, fs: WorkspaceFs): VerificationPlan {
  const catalog = detectScripts(workspace, fs);
  return buildVerificationPlan(workspace, catalog, { only: ["test"] }, fs);
}

function resolveVerificationPlan(
  workspace: WorkspaceInfo,
  target: UnitTestTarget,
  fs: WorkspaceFs,
): VerificationPlan | undefined {
  const targeted = resolveTargetedTests(
    workspace,
    targetSourceFiles(target),
    fs,
    DEFAULT_VERIFICATION_LIMITS,
  );
  if (targeted.length > 0) {
    return { workspaceRoot: workspace.root, steps: targeted };
  }
  const fallback = buildPlanFallback(workspace, fs);
  const runnable = fallback.steps.filter((step) => step.skipReason === undefined);
  return runnable.length > 0 ? { workspaceRoot: workspace.root, steps: runnable } : undefined;
}

export interface VerificationOutcome {
  readonly summary: VerificationAuditSummary | undefined;
  readonly skipReason: string | undefined;
}

export async function runWorkflowVerification(
  state: RunState,
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
): Promise<VerificationOutcome> {
  if (workspace.testFramework === "unknown") {
    return { summary: undefined, skipReason: SKIP_UNRESOLVED };
  }
  const plan = resolveVerificationPlan(workspace, state.input.target, fs);
  if (plan === undefined) {
    return { summary: undefined, skipReason: SKIP_UNRESOLVED };
  }
  const report = await runVerification(plan, {
    workspace,
    signal: state.signal,
    spawn: state.deps.spawn ?? nodeSpawnFn,
    processEnv: state.deps.processEnv ?? process.env,
    now: state.now,
    fs,
  });
  const summary = summarizeForAudit(report);
  state.emitter.emit({
    type: "workflow:verification:result",
    overallStatus: summary.overallStatus,
    stepCount: summary.results.length,
    passedCount: summary.results.filter((r) => r.status === "passed").length,
    durationMs: summary.durationMs,
  });
  return { summary, skipReason: undefined };
}
