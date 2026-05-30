// The verification stage (ADR-0009 D11). Runs ONLY after a successful apply: it resolves a
// verification plan by deriving the just-fixed/added tests from the changed SOURCE files via #7
// resolveTargetedTests (so it finds the sibling/mirrored test incl. the just-added regression
// test), falling back to the full `test` script, and records an explicit skip reason when neither
// resolves or the framework is unknown. Verification reuses the #7 orchestrator unchanged; this
// stage only wires the plan and projects an output-text-free audit summary. DEFERRED (D11): a
// pre-patch reproduction baseline — Wave-1 verifies only the post-apply state.

import { nodeSpawnFn, type PatchFileChange } from "../../tools/index.js";
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
  type VerificationStep,
} from "../../verification/index.js";
import { isSensitivePath } from "./guard.js";
import type { BugRunState } from "./internal.js";

export const SKIP_UNRESOLVED = "verification skipped: framework unknown or no test files resolved";

// The non-test source files the patch changed — passed to resolveTargetedTests so it can find the
// associated tests (incl. the just-added regression test). We approximate "source" as any changed
// path that is not itself a test file (basename marks .test/.spec) and not a sensitive path.
function changedSourceFiles(files: readonly PatchFileChange[]): readonly string[] {
  return files.map((f) => f.path).filter((path) => !isSensitivePath(path) && !isTestFile(path));
}

function changedTestFiles(files: readonly PatchFileChange[]): readonly string[] {
  return files.map((f) => f.path).filter((path) => !isSensitivePath(path) && isTestFile(path));
}

function isTestFile(path: string): boolean {
  const slash = path.lastIndexOf("/");
  const base = slash === -1 ? path : path.slice(slash + 1);
  const segments = base.split(".");
  return segments.includes("test") || segments.includes("spec");
}

function buildPlanFallback(workspace: WorkspaceInfo, fs: WorkspaceFs): VerificationPlan {
  const catalog = detectScripts(workspace, fs);
  return buildVerificationPlan(workspace, catalog, { only: ["test"] }, fs);
}

function targetedChangedTests(
  workspace: WorkspaceInfo,
  testFiles: readonly string[],
): VerificationStep | undefined {
  if (testFiles.length === 0) {
    return undefined;
  }
  if (workspace.testFramework === "vitest") {
    return {
      kind: "targeted-test",
      scriptName: undefined,
      command: "npx",
      args: ["vitest", "run", ...testFiles],
      limits: DEFAULT_VERIFICATION_LIMITS,
    };
  }
  if (workspace.testFramework === "jest") {
    return {
      kind: "targeted-test",
      scriptName: undefined,
      command: "npx",
      args: ["jest", ...testFiles],
      limits: DEFAULT_VERIFICATION_LIMITS,
    };
  }
  return undefined;
}

function resolveVerificationPlan(
  workspace: WorkspaceInfo,
  changedFiles: readonly PatchFileChange[],
  fs: WorkspaceFs,
): VerificationPlan | undefined {
  const directTests = targetedChangedTests(workspace, changedTestFiles(changedFiles));
  if (directTests !== undefined) {
    return { workspaceRoot: workspace.root, steps: [directTests] };
  }
  const targeted = resolveTargetedTests(
    workspace,
    changedSourceFiles(changedFiles),
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

export interface BugVerificationOutcome {
  readonly summary: VerificationAuditSummary | undefined;
  readonly skipReason: string | undefined;
}

export async function runBugVerification(
  state: BugRunState,
  workspace: WorkspaceInfo,
  changedFiles: readonly PatchFileChange[],
  fs: WorkspaceFs,
): Promise<BugVerificationOutcome> {
  const plan = resolveVerificationPlan(workspace, changedFiles, fs);
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
    type: "bug:verification:result",
    overallStatus: summary.overallStatus,
    stepCount: summary.results.length,
    passedCount: summary.results.filter((r) => r.status === "passed").length,
    durationMs: summary.durationMs,
  });
  return { summary, skipReason: undefined };
}
