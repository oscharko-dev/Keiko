// The single public entry: investigateBug (ADR-0009 D2/D6/D10/D11). A deterministic linear pipeline
// (NOT the harness loop): intake precondition -> parse failure evidence -> build context -> [prompt
// -> model -> parse -> validate -> scope-guard] (bounded retries) -> [investigation-only |
// rejected | dry-run | apply -> verify] -> report. It composes #3-#7 UNCHANGED and emits redacted
// progress events. The model loop, verify stage, and report stages live in sibling files to keep
// each under the LOC limit; this file owns the stage sequencing, the intake precondition (return
// `rejected` with no model call when no evidence is present), and the single top-level catch
// boundary that maps a CancelledError to a "cancelled" report and any other IO failure to a
// redacted "failed" report.

import { CancelledError } from "@oscharko-dev/keiko-model-gateway";
import { detectWorkspace } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { buildBugContext } from "./context.js";
import { computeBugFingerprint } from "./emit.js";
import { parseFailureEvidence } from "./failure-parse.js";
import { acquireMemoryContext, emitMemoryWriteCandidate } from "./memory.js";
import { runBugModelLoop } from "./model-loop.js";
import {
  cancelledReport,
  emitCompleted,
  failedReport,
  finishPipeline,
  insufficientInputReport,
} from "./stages.js";
import { buildBugRunState, EMPTY_BUG_LOOP, type BugRunState } from "./internal.js";
import type {
  BugInvestigationDeps,
  BugInvestigationInput,
  BugInvestigationReport,
  BugReportInput,
} from "./types.js";

// Intake precondition (D2): at least one evidence field must be present, else there is nothing to
// investigate and we reject WITHOUT calling the model.
function hasEvidence(report: BugReportInput): boolean {
  return (
    nonEmpty(report.description) ||
    nonEmpty(report.failingOutput) ||
    nonEmpty(report.stackTrace) ||
    (report.targetFiles?.some((file) => nonEmpty(file)) ?? false)
  );
}

function nonEmpty(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

async function runPipeline(state: BugRunState): Promise<BugInvestigationReport> {
  const report = state.input.report;
  state.emitter.emit({
    type: "bug:started",
    workflowId: "bug-investigation",
    modelId: state.input.modelId,
    applyEnabled: state.input.apply === true,
    limits: state.limits,
  });
  if (!hasEvidence(report)) {
    return insufficientInputReport(state);
  }
  const fs = state.deps.fs ?? nodeWorkspaceFs;
  const workspace = detectWorkspace(state.input.workspaceRoot, fs);
  const evidence = parseFailureEvidence(report);
  // Memory composition (Issue #213): fetch a scoped memory context before any model call so
  // the model loop can prepend it to the user message. NO-OP when no port is injected; the
  // returned text is redacted + byte-capped at the prompt boundary (defence-in-depth).
  const memoryContext = await acquireMemoryContext(
    state.deps.memoryPort,
    report,
    state.input.workspaceRoot,
  );
  state.memoryPromptText = memoryContext?.text;
  state.emitter.emit({
    type: "bug:failure:parsed",
    frameCount: evidence.frames.length,
    messageCount: evidence.messages.length,
  });
  const pack = buildBugContext(workspace, report.description, evidence, state.limits, { fs });
  state.emitter.emit({
    type: "bug:context:selected",
    entryCount: pack.selected.length,
    usedBytes: pack.usedBytes,
    budgetBytes: pack.budgetBytes,
    droppedForBudget: pack.droppedForBudget,
  });
  const loop = await runBugModelLoop(state, workspace, report, evidence, pack);
  return finishPipeline(state, workspace, loop, evidence);
}

export async function investigateBug(
  input: BugInvestigationInput,
  deps: BugInvestigationDeps,
): Promise<BugInvestigationReport> {
  const state = buildBugRunState(input, deps, computeBugFingerprint(input.report, input.modelId));
  let report: BugInvestigationReport;
  try {
    report = await runPipeline(state);
  } catch (error) {
    report =
      error instanceof CancelledError
        ? cancelledReport(state, EMPTY_BUG_LOOP, undefined, { frames: [], messages: [] })
        : failedReport(state, error);
  }
  // Memory write-candidate (Issue #213): emit ONLY for terminal success outcomes
  // (fix-applied / fix-proposed / investigation-only). NO-OP for cancelled / failed /
  // rejected, and NO-OP when no port is injected. Emitted before emitCompleted so the audit
  // ledger and MemoriaViva UI see the candidate alongside the run-completed event.
  emitMemoryWriteCandidate(state.deps.memoryPort, report, state.input.workspaceRoot);
  return emitCompleted(state, report);
}
