// Terminal-report stages (ADR-0009 D3/D4/D11). Each function maps a pipeline outcome —
// fix-proposed (dry-run), fix-applied, investigation-only, rejected, cancelled, or failed — to the
// redacted BugInvestigationReport via assembleBugReport. applyPatch (apply mode) is the one IO
// boundary here and is fail-closed in #6 (applyEnabled gates the write); it receives the SAME
// tighter PatchLimits as validatePatch (D6 bound 1, defence-in-depth re-validation). finishPipeline
// selects the branch; emitCompleted stamps the terminal event. All redaction is inside assembleBugReport.

import { redact } from "@oscharko-dev/keiko-security";
import {
  applyPatch,
  CommandCancelledError,
  renderDryRun,
  type PatchApplyResult,
} from "@oscharko-dev/keiko-tools";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { assembleBugReport } from "./report.js";
import { runBugVerification } from "./verify-stage.js";
import {
  investigationNextActions,
  nextActionsFor,
  patchLimitsFrom,
  type AcceptedBugPatch,
  type BugModelLoopResult,
  type BugRunState,
} from "./internal.js";
import { isElevatedReviewPath } from "./guard.js";
import type { BugInvestigationReport, FailureEvidence, Hypothesis } from "./types.js";

const EMPTY_HYPOTHESIS: Hypothesis = {
  rootCause: undefined,
  regressionTestStrategy: undefined,
  uncertainty: undefined,
  confidence: undefined,
};

function elevatedPaths(accepted: AcceptedBugPatch): readonly string[] {
  return accepted.validation.files.map((f) => f.path).filter((p) => isElevatedReviewPath(p));
}

export function rejectedReport(
  state: BugRunState,
  loop: BugModelLoopResult,
  evidence: FailureEvidence,
): BugInvestigationReport {
  return assembleBugReport({
    status: "rejected",
    modelId: state.input.modelId,
    durationMs: state.now() - state.startedAt,
    patchFiles: [],
    patchValidates: false,
    patchApplied: false,
    verification: undefined,
    failureFrames: evidence.frames,
    hypothesis: EMPTY_HYPOTHESIS,
    proposedDiff: undefined,
    dryRunPreview: undefined,
    verificationSkipReason: undefined,
    nextActions: [
      `The model did not produce an in-scope fix (${loop.lastRejectionCode ?? "insufficient evidence"})`,
    ],
    failureReason: undefined,
    modelCallCount: loop.modelCallCount,
    patchRetryCount: loop.patchRetryCount,
  });
}

// Insufficient-input rejection: returned by the intake precondition before any model call.
export function insufficientInputReport(state: BugRunState): BugInvestigationReport {
  return assembleBugReport({
    status: "rejected",
    modelId: state.input.modelId,
    durationMs: state.now() - state.startedAt,
    patchFiles: [],
    patchValidates: false,
    patchApplied: false,
    verification: undefined,
    failureFrames: [],
    hypothesis: EMPTY_HYPOTHESIS,
    proposedDiff: undefined,
    dryRunPreview: undefined,
    verificationSkipReason: undefined,
    nextActions: [
      "Provide at least one of: a description, failing output, a stack trace, or suspected target files",
    ],
    failureReason: undefined,
    modelCallCount: 0,
    patchRetryCount: 0,
  });
}

export function investigationOnlyReport(
  state: BugRunState,
  loop: BugModelLoopResult,
  hypothesis: Hypothesis,
  evidence: FailureEvidence,
): BugInvestigationReport {
  return assembleBugReport({
    status: "investigation-only",
    modelId: state.input.modelId,
    durationMs: state.now() - state.startedAt,
    patchFiles: [],
    patchValidates: false,
    patchApplied: false,
    verification: undefined,
    failureFrames: evidence.frames,
    hypothesis,
    proposedDiff: undefined,
    dryRunPreview: undefined,
    verificationSkipReason: "verification skipped: no patch produced (investigation-only)",
    nextActions: investigationNextActions(),
    failureReason: undefined,
    modelCallCount: loop.modelCallCount,
    patchRetryCount: loop.patchRetryCount,
  });
}

export function dryRunReport(
  state: BugRunState,
  loop: BugModelLoopResult,
  accepted: AcceptedBugPatch,
  evidence: FailureEvidence,
): BugInvestigationReport {
  const files = accepted.validation.files.map((f) => f.path);
  return assembleBugReport({
    status: "fix-proposed",
    modelId: state.input.modelId,
    durationMs: state.now() - state.startedAt,
    patchFiles: accepted.validation.files,
    patchValidates: true,
    patchApplied: false,
    verification: undefined,
    failureFrames: evidence.frames,
    hypothesis: accepted.hypothesis,
    proposedDiff: accepted.diff,
    dryRunPreview: renderDryRun(accepted.validation),
    verificationSkipReason: "verification skipped: dry-run, no files written",
    nextActions: nextActionsFor(false, files, elevatedPaths(accepted)),
    failureReason: undefined,
    modelCallCount: loop.modelCallCount,
    patchRetryCount: loop.patchRetryCount,
  });
}

// `applied` is set ONLY on a post-apply abort: the patch is already on disk, so the report (and the
// #10 ledger record) must reflect that (patchApplied: true) rather than hard-coding false. A
// pre-apply abort passes applied === undefined and stays patchApplied: false.
export function cancelledReport(
  state: BugRunState,
  loop: BugModelLoopResult,
  accepted: AcceptedBugPatch | undefined,
  evidence: FailureEvidence,
  applied?: { readonly changedFiles: readonly string[] },
): BugInvestigationReport {
  const nextActions =
    applied === undefined
      ? ["The workflow was cancelled before completion"]
      : [
          `The fix was applied to ${applied.changedFiles[0] ?? "disk"} but the workflow was cancelled before verification completed`,
          "Run `keiko verify` to confirm the suite",
        ];
  return assembleBugReport({
    status: "cancelled",
    modelId: state.input.modelId,
    durationMs: state.now() - state.startedAt,
    patchFiles: accepted?.validation.files ?? [],
    patchValidates: accepted !== undefined,
    patchApplied: applied !== undefined,
    verification: undefined,
    failureFrames: evidence.frames,
    hypothesis: accepted?.hypothesis ?? EMPTY_HYPOTHESIS,
    proposedDiff: accepted?.diff,
    dryRunPreview: accepted === undefined ? undefined : renderDryRun(accepted.validation),
    verificationSkipReason: "verification skipped: cancelled",
    nextActions,
    failureReason: undefined,
    modelCallCount: loop.modelCallCount,
    patchRetryCount: loop.patchRetryCount,
  });
}

export function failedReport(state: BugRunState, error: unknown): BugInvestigationReport {
  const message = redact(error instanceof Error ? error.message : "unexpected workflow failure");
  const errorCode = error instanceof Error ? error.name : "UNKNOWN";
  state.emitter.emit({ type: "bug:failed", errorCode, message });
  return assembleBugReport({
    status: "failed",
    modelId: state.input.modelId,
    durationMs: state.now() - state.startedAt,
    patchFiles: [],
    patchValidates: false,
    patchApplied: false,
    verification: undefined,
    failureFrames: [],
    hypothesis: EMPTY_HYPOTHESIS,
    proposedDiff: undefined,
    dryRunPreview: undefined,
    verificationSkipReason: undefined,
    nextActions: [`Inspect the error and retry: ${message}`],
    failureReason: message,
    modelCallCount: state.progress.modelCallCount,
    patchRetryCount: state.progress.patchRetryCount,
  });
}

function applyBugPatch(
  state: BugRunState,
  workspace: WorkspaceInfo,
  accepted: AcceptedBugPatch,
): { readonly fs: typeof nodeWorkspaceFs; readonly applyResult: PatchApplyResult } {
  const fs = state.deps.fs ?? nodeWorkspaceFs;
  const applyResult = applyPatch(workspace, accepted.diff, {
    applyEnabled: true,
    signal: state.signal,
    fs,
    limits: patchLimitsFrom(state.limits),
    ...(state.deps.writer === undefined ? {} : { writer: state.deps.writer }),
  });
  return { fs, applyResult };
}

async function applyAndVerify(
  state: BugRunState,
  workspace: WorkspaceInfo,
  loop: BugModelLoopResult,
  accepted: AcceptedBugPatch,
  evidence: FailureEvidence,
): Promise<BugInvestigationReport> {
  let applyResult: PatchApplyResult;
  let fs: typeof nodeWorkspaceFs;
  try {
    ({ fs, applyResult } = applyBugPatch(state, workspace, accepted));
  } catch (error) {
    if (error instanceof CommandCancelledError) {
      return cancelledReport(state, loop, accepted, evidence);
    }
    throw error;
  }
  state.emitter.emit({
    type: "bug:patch:applied",
    changedFiles: applyResult.changedFiles.length,
    created: applyResult.created.length,
    deleted: applyResult.deleted.length,
  });
  if (state.signal.aborted) {
    // Post-apply abort: the patch is already on disk, so the report must reflect patchApplied: true
    // (M1) — the #10 ledger record must match the real filesystem state.
    return cancelledReport(state, loop, accepted, evidence, {
      changedFiles: applyResult.changedFiles,
    });
  }
  const verification = await runBugVerification(state, workspace, accepted.validation.files, fs);
  return assembleBugReport({
    status: "fix-applied",
    modelId: state.input.modelId,
    durationMs: state.now() - state.startedAt,
    patchFiles: accepted.validation.files,
    patchValidates: true,
    patchApplied: true,
    verification: verification.summary,
    failureFrames: evidence.frames,
    hypothesis: accepted.hypothesis,
    proposedDiff: accepted.diff,
    dryRunPreview: renderDryRun(accepted.validation),
    verificationSkipReason: verification.skipReason,
    nextActions: nextActionsFor(true, applyResult.changedFiles, elevatedPaths(accepted)),
    failureReason: undefined,
    modelCallCount: loop.modelCallCount,
    patchRetryCount: loop.patchRetryCount,
  });
}

export function emitCompleted(
  state: BugRunState,
  report: BugInvestigationReport,
): BugInvestigationReport {
  state.emitter.emit({
    type: "bug:completed",
    status: report.status,
    durationMs: report.durationMs,
  });
  return report;
}

// Selects the terminal branch from the model-loop result: investigation-only (hypothesis, no
// patch), rejected (nothing usable), cancelled (abort before apply), apply+verify (apply mode), or
// dry-run (default).
export async function finishPipeline(
  state: BugRunState,
  workspace: WorkspaceInfo,
  loop: BugModelLoopResult,
  evidence: FailureEvidence,
): Promise<BugInvestigationReport> {
  if (loop.accepted === undefined) {
    if (loop.investigationOnly !== undefined) {
      return investigationOnlyReport(state, loop, loop.investigationOnly, evidence);
    }
    return rejectedReport(state, loop, evidence);
  }
  if (state.signal.aborted) {
    return cancelledReport(state, loop, loop.accepted, evidence);
  }
  if (state.input.apply === true) {
    return applyAndVerify(state, workspace, loop, loop.accepted, evidence);
  }
  return dryRunReport(state, loop, loop.accepted, evidence);
}
