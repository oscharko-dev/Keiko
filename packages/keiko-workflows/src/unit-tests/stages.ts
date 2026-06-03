// Terminal-report stages (ADR-0008 D3/D5). Each function maps a pipeline outcome — rejected,
// dry-run, applied+verified, cancelled, or failed — to the redacted UnitTestWorkflowReport via
// assembleReport. applyPatch (apply mode) is the one IO boundary here and is fail-closed in #6
// (applyEnabled gates the write). finishPipeline selects the branch; emitCompleted stamps the
// terminal event. All prose/diff redaction happens inside assembleReport.

import { redact } from "../../gateway/redaction.js";
import {
  applyPatch,
  CommandCancelledError,
  renderDryRun,
  type PatchApplyResult,
} from "../../tools/index.js";
import { nodeWorkspaceFs } from "../../workspace/fs.js";
import type { WorkspaceInfo } from "../../workspace/index.js";
import { assembleReport } from "./report.js";
import { runWorkflowVerification } from "./verify-stage.js";
import {
  nextActionsFor,
  type AcceptedPatch,
  type ModelLoopResult,
  type RunState,
} from "./internal.js";
import type { UnitTestWorkflowReport } from "./types.js";

export function rejectedReport(state: RunState, loop: ModelLoopResult): UnitTestWorkflowReport {
  return assembleReport({
    status: "rejected",
    modelId: state.input.modelId,
    durationMs: state.now() - state.startedAt,
    patchFiles: [],
    dryRunPreview: undefined,
    proposedDiff: undefined,
    coveredBehavior: undefined,
    knownGaps: undefined,
    nextActions: [
      `The model did not produce an in-scope test patch (${loop.lastRejectionCode ?? "unknown"})`,
    ],
    failureReason: undefined,
    verificationSummary: undefined,
    verificationSkipReason: undefined,
    modelCallCount: loop.modelCallCount,
    patchRetryCount: loop.patchRetryCount,
  });
}

export function dryRunReport(
  state: RunState,
  loop: ModelLoopResult,
  accepted: AcceptedPatch,
): UnitTestWorkflowReport {
  const files = accepted.validation.files.map((f) => f.path);
  return assembleReport({
    status: "dry-run",
    modelId: state.input.modelId,
    durationMs: state.now() - state.startedAt,
    patchFiles: accepted.validation.files,
    dryRunPreview: renderDryRun(accepted.validation),
    proposedDiff: accepted.diff,
    coveredBehavior: accepted.coveredBehavior,
    knownGaps: accepted.knownGaps,
    nextActions: nextActionsFor(false, files),
    failureReason: undefined,
    verificationSummary: undefined,
    verificationSkipReason: "verification skipped: dry-run, no files written",
    modelCallCount: loop.modelCallCount,
    patchRetryCount: loop.patchRetryCount,
  });
}

export function cancelledReport(
  state: RunState,
  loop: ModelLoopResult,
  accepted: AcceptedPatch | undefined,
): UnitTestWorkflowReport {
  return assembleReport({
    status: "cancelled",
    modelId: state.input.modelId,
    durationMs: state.now() - state.startedAt,
    patchFiles: accepted?.validation.files ?? [],
    dryRunPreview: accepted === undefined ? undefined : renderDryRun(accepted.validation),
    proposedDiff: accepted?.diff,
    coveredBehavior: undefined,
    knownGaps: undefined,
    nextActions: ["The workflow was cancelled before completion"],
    failureReason: undefined,
    verificationSummary: undefined,
    verificationSkipReason: "verification skipped: cancelled",
    modelCallCount: loop.modelCallCount,
    patchRetryCount: loop.patchRetryCount,
  });
}

export function failedReport(state: RunState, error: unknown): UnitTestWorkflowReport {
  const message = redact(error instanceof Error ? error.message : "unexpected workflow failure");
  const errorCode = error instanceof Error ? error.name : "UNKNOWN";
  state.emitter.emit({ type: "workflow:failed", errorCode, message });
  return assembleReport({
    status: "failed",
    modelId: state.input.modelId,
    durationMs: state.now() - state.startedAt,
    patchFiles: [],
    dryRunPreview: undefined,
    proposedDiff: undefined,
    coveredBehavior: undefined,
    knownGaps: undefined,
    nextActions: [`Inspect the error and retry: ${message}`],
    failureReason: message,
    verificationSummary: undefined,
    verificationSkipReason: undefined,
    modelCallCount: state.progress.modelCallCount,
    patchRetryCount: state.progress.patchRetryCount,
  });
}

async function applyAndVerify(
  state: RunState,
  workspace: WorkspaceInfo,
  loop: ModelLoopResult,
  accepted: AcceptedPatch,
): Promise<UnitTestWorkflowReport> {
  const fs = state.deps.fs ?? nodeWorkspaceFs;
  let applyResult: PatchApplyResult;
  try {
    applyResult = applyPatch(workspace, accepted.diff, {
      applyEnabled: true,
      signal: state.signal,
      fs,
      ...(state.deps.writer === undefined ? {} : { writer: state.deps.writer }),
    });
  } catch (error) {
    if (error instanceof CommandCancelledError) {
      return cancelledReport(state, loop, accepted);
    }
    throw error;
  }
  state.emitter.emit({
    type: "workflow:patch:applied",
    changedFiles: applyResult.changedFiles.length,
    created: applyResult.created.length,
    deleted: applyResult.deleted.length,
  });
  if (state.signal.aborted) {
    return cancelledReport(state, loop, accepted);
  }
  const verification = await runWorkflowVerification(state, workspace, fs);
  return assembleReport({
    status: "completed",
    modelId: state.input.modelId,
    durationMs: state.now() - state.startedAt,
    patchFiles: accepted.validation.files,
    dryRunPreview: renderDryRun(accepted.validation),
    proposedDiff: accepted.diff,
    coveredBehavior: accepted.coveredBehavior,
    knownGaps: accepted.knownGaps,
    nextActions: nextActionsFor(true, applyResult.changedFiles),
    failureReason: undefined,
    verificationSummary: verification.summary,
    verificationSkipReason: verification.skipReason,
    modelCallCount: loop.modelCallCount,
    patchRetryCount: loop.patchRetryCount,
  });
}

export function emitCompleted(
  state: RunState,
  report: UnitTestWorkflowReport,
): UnitTestWorkflowReport {
  state.emitter.emit({
    type: "workflow:completed",
    status: report.status,
    durationMs: report.durationMs,
  });
  return report;
}

// Selects the terminal branch from the model-loop result: rejected (no patch), cancelled (abort
// before apply), apply+verify (apply mode), or dry-run (default).
export async function finishPipeline(
  state: RunState,
  workspace: WorkspaceInfo,
  loop: ModelLoopResult,
): Promise<UnitTestWorkflowReport> {
  if (loop.accepted === undefined) {
    return rejectedReport(state, loop);
  }
  if (state.signal.aborted) {
    return cancelledReport(state, loop, loop.accepted);
  }
  if (state.input.apply === true) {
    return applyAndVerify(state, workspace, loop, loop.accepted);
  }
  return dryRunReport(state, loop, loop.accepted);
}
