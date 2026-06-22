// The single public entry: generateUnitTests (ADR-0008 D2/D5/D6). A deterministic linear pipeline
// (NOT the harness loop): intake -> detect -> context -> conventions -> [prompt -> model -> parse ->
// validate -> production-guard] (bounded retries) -> [dry-run | apply -> verify] -> report. It
// composes #3-#7 UNCHANGED and emits redacted progress events. The model loop, verify stage, and
// report stages live in sibling files to keep each under the LOC limit; this file owns only the
// stage sequencing and the single top-level catch boundary that maps an unexpected IO failure to a
// redacted "failed" report (and a CancelledError to a "cancelled" report).

import { CancelledError } from "@oscharko-dev/keiko-model-gateway";
import { detectWorkspace } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { buildTestGenContext } from "./context.js";
import { detectConventions } from "./conventions.js";
import { computeFingerprint } from "./emit.js";
import { runModelLoop } from "./model-loop.js";
import { resolveTestStrategy } from "./strategy.js";
import {
  cancelledReport,
  emitCompleted,
  failedReport,
  finishPipeline,
  unsupportedReport,
} from "./stages.js";
import { buildRunState, EMPTY_LOOP, type RunState } from "./internal.js";
import { assertTargetWithinWorkspace } from "./target-guard.js";
import type {
  UnitTestWorkflowDeps,
  UnitTestWorkflowInput,
  UnitTestWorkflowReport,
} from "./types.js";

async function runPipeline(state: RunState): Promise<UnitTestWorkflowReport> {
  const fs = state.deps.fs ?? nodeWorkspaceFs;
  const workspace = detectWorkspace(state.input.workspaceRoot, fs);
  state.emitter.emit({
    type: "workflow:started",
    workflowId: "unit-test-generation",
    modelId: state.input.modelId,
    applyEnabled: state.input.apply === true,
    limits: state.limits,
  });
  // Issue #641: enforce workspace containment on the input target before context selection so
  // escaped, denied, or symlink-escape paths fail closed with modelCallCount=0 and no model call.
  assertTargetWithinWorkspace(workspace, state.input.target, fs);
  const pack = buildTestGenContext(workspace, state.input, state.limits, { fs });
  const conventions = detectConventions(workspace, pack);
  state.emitter.emit({
    type: "conventions:detected",
    framework: conventions.framework,
    testDirs: conventions.testDirs,
    fileNamingStyle: conventions.fileNamingStyle,
  });
  state.emitter.emit({
    type: "context:selected",
    entryCount: pack.selected.length,
    usedBytes: pack.usedBytes,
    budgetBytes: pack.budgetBytes,
    droppedForBudget: pack.droppedForBudget,
  });
  // Convention-driven test-style selection (Issue #1203). An unsupported frontend stack short-circuits
  // here with a reviewable limitation and NO model call (AC5: no fabricated test).
  const strategy = resolveTestStrategy(workspace, state.input.target, conventions, pack, fs);
  if (strategy.style === "unsupported") {
    return unsupportedReport(state, strategy);
  }
  const loop = await runModelLoop(state, workspace, conventions, strategy, pack);
  return finishPipeline(state, workspace, loop, strategy);
}

export async function generateUnitTests(
  input: UnitTestWorkflowInput,
  deps: UnitTestWorkflowDeps,
): Promise<UnitTestWorkflowReport> {
  const state = buildRunState(input, deps, computeFingerprint(input.target, input.modelId));
  let report: UnitTestWorkflowReport;
  try {
    report = await runPipeline(state);
  } catch (error) {
    report =
      error instanceof CancelledError
        ? cancelledReport(state, EMPTY_LOOP, undefined)
        : failedReport(state, error);
  }
  return emitCompleted(state, report);
}
