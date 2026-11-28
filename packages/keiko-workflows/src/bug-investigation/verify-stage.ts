// The verification stage (ADR-0009 D11). Runs ONLY after a successful apply: it resolves a
// verification plan by deriving the just-fixed/added tests from the changed SOURCE files via #7
// resolveTargetedTests (so it finds the sibling/mirrored test incl. the just-added regression
// test), falling back to the full `test` script, and records an explicit skip reason when neither
// resolves or the framework is unknown. Verification reuses the #7 orchestrator unchanged; this
// stage only wires the plan and projects an output-text-free audit summary. DEFERRED (D11): a
// pre-patch reproduction baseline — Wave-1 verifies only the post-apply state.

import type { PatchFileChange } from "@oscharko-dev/keiko-tools";
import {
  DEFAULT_VERIFICATION_LIMITS,
  planDirectTargetedTests,
  resolveTargetedTests,
  type VerificationAuditSummary,
  type VerificationStep,
} from "@oscharko-dev/keiko-verification";
import type { WorkspaceFs, WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import {
  resolvePlannedVerification,
  runPlannedVerification,
  SKIP_UNRESOLVED,
  verificationResultFields,
} from "../verification/planned-verification.js";
import { isSensitivePath } from "./guard.js";
import type { BugRunState } from "./internal.js";

export { SKIP_UNRESOLVED };

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
  const segments = new Set(base.split("."));
  return segments.has("test") || segments.has("spec");
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
  const planned = resolvePlannedVerification(workspace, fs, [
    (): readonly VerificationStep[] =>
      planDirectTargetedTests(workspace, changedTestFiles(changedFiles), fs),
    (): readonly VerificationStep[] =>
      resolveTargetedTests(
        workspace,
        changedSourceFiles(changedFiles),
        fs,
        DEFAULT_VERIFICATION_LIMITS,
      ),
  ]);
  if (planned === undefined) {
    return { summary: undefined, skipReason: SKIP_UNRESOLVED };
  }
  const summary = await runPlannedVerification(state, workspace, fs, planned);
  state.emitter.emit({ type: "bug:verification:result", ...verificationResultFields(summary) });
  return { summary, skipReason: undefined };
}
