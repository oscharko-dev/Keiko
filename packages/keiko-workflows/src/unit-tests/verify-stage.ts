// The verification stage (ADR-0008 D5, steering note C). Runs ONLY after a successful apply: it
// resolves a verification plan by deriving the just-created test from the target SOURCE file(s) via
// #7 resolveTargetedTests, falling back to the full `test` script, and records an explicit skip
// reason when neither resolves or the framework is unknown. Verification reuses the #7 orchestrator
// unchanged; this stage only wires the plan and projects an output-text-free audit summary.

import {
  resolveTargetedTests,
  DEFAULT_VERIFICATION_LIMITS,
} from "@oscharko-dev/keiko-verification";
import type { VerificationAuditSummary, VerificationStep } from "@oscharko-dev/keiko-verification";
import type { WorkspaceFs, WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import {
  resolvePlannedVerification,
  runPlannedVerification,
  SKIP_UNRESOLVED,
  verificationResultFields,
} from "../verification/planned-verification.js";
import type { RunState } from "./internal.js";
import type { UnitTestTarget } from "./types.js";

export { SKIP_UNRESOLVED };

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

export interface VerificationOutcome {
  readonly summary: VerificationAuditSummary | undefined;
  readonly skipReason: string | undefined;
}

export async function runWorkflowVerification(
  state: RunState,
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
): Promise<VerificationOutcome> {
  const planned = resolvePlannedVerification(workspace, fs, [
    (): readonly VerificationStep[] =>
      resolveTargetedTests(
        workspace,
        targetSourceFiles(state.input.target),
        fs,
        DEFAULT_VERIFICATION_LIMITS,
      ),
  ]);
  if (planned === undefined) {
    return { summary: undefined, skipReason: SKIP_UNRESOLVED };
  }
  const summary = await runPlannedVerification(state, workspace, fs, planned);
  state.emitter.emit({
    type: "workflow:verification:result",
    ...verificationResultFields(summary),
  });
  return { summary, skipReason: undefined };
}
