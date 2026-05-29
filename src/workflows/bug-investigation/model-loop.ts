// The bounded model/validate/scope-guard retry loop (ADR-0009 D6/D10). Each attempt builds the
// prompt, calls the injected ModelPort, parses the output, and classifies the result. The KEY
// behavioural difference from #8: an EMPTY diff with a root-cause hypothesis is a VALID
// investigation-only outcome (NOT a retry); only a malformed/oversized/out-of-scope NON-empty patch
// retries. The change budget (D6 bound 1) is enforced by passing a workflow-owned PatchLimits into
// #6 validatePatch; the sensitive-path guard (D6 bound 2) runs on validation.files[].path. The
// model call is the one IO boundary here; its failure propagates to the workflow catch boundary.

import type { ChatMessage } from "../../gateway/types.js";
import { nodeWorkspaceFs, type ContextPack, type WorkspaceInfo } from "../../workspace/index.js";
import { validatePatch, type PatchValidation } from "../../tools/index.js";
import { isSensitivePath } from "./guard.js";
import { parseBugModelOutput } from "./parse.js";
import { buildBugPrompt } from "./prompt.js";
import {
  patchLimitsFrom,
  type AcceptedBugPatch,
  type BugModelLoopResult,
  type BugRunState,
} from "./internal.js";
import type { BugReportInput, FailureEvidence, Hypothesis, ParsedBugOutput } from "./types.js";

// The sensitive-path scope guard (D6 bound 2): every changed path must NOT be sensitive. Returns
// "out-of-scope" when any path is traversal/.github/.husky/lockfile, else undefined. The change
// budget (bound 1) is enforced by #6 itself via the limits passed to validatePatch.
function scopeGuard(validation: PatchValidation): string | undefined {
  const offending = validation.files.some((file) => isSensitivePath(file.path));
  return offending ? "out-of-scope" : undefined;
}

function emitValidation(
  state: BugRunState,
  validation: PatchValidation,
  code: string | undefined,
): void {
  const ok = code === undefined && validation.ok;
  state.emitter.emit({
    type: "bug:patch:validated",
    ok,
    patchBytes: validation.totalBytes,
    filesChanged: validation.files.length,
    ...(ok ? {} : { rejectionCode: code ?? validation.reasons[0]?.code }),
  });
}

function hypothesisOf(parsed: ParsedBugOutput): Hypothesis {
  return {
    rootCause: parsed.rootCause,
    regressionTestStrategy: parsed.regressionTestStrategy,
    uncertainty: parsed.uncertainty,
    confidence: parsed.confidence,
  };
}

// True when the parsed output carries at least one prose section (any hypothesis content).
function hasProse(parsed: ParsedBugOutput): boolean {
  return (
    parsed.rootCause !== undefined ||
    parsed.regressionTestStrategy !== undefined ||
    parsed.uncertainty !== undefined ||
    parsed.confidence !== undefined
  );
}

async function callModel(
  state: BugRunState,
  messages: readonly ChatMessage[],
  attempt: number,
  contextBytes: number,
): Promise<string> {
  state.emitter.emit({ type: "bug:model:call:started", attempt, contextBytes });
  const response = await state.deps.model.call(
    { modelId: state.input.modelId, messages },
    state.signal,
  );
  state.emitter.emit({
    type: "bug:model:call:completed",
    attempt,
    finishReason: response.finishReason,
    promptTokens: response.usage.promptTokens,
    completionTokens: response.usage.completionTokens,
    latencyMs: response.usage.latencyMs,
  });
  return response.content;
}

// One attempt's classification: accepted patch, investigation-only hypothesis, or a retryable
// rejection (with its code). Exactly one of accepted/investigationOnly/rejectionCode is set.
interface AttemptResult {
  readonly accepted: AcceptedBugPatch | undefined;
  readonly investigationOnly: Hypothesis | undefined;
  readonly rejectionCode: string | undefined;
}

function classifyEmptyDiff(parsed: ParsedBugOutput): AttemptResult {
  // Empty diff + a hypothesis -> investigation-only (NOT a retry). Empty diff + no prose -> retry.
  if (hasProse(parsed)) {
    return {
      accepted: undefined,
      investigationOnly: hypothesisOf(parsed),
      rejectionCode: undefined,
    };
  }
  return { accepted: undefined, investigationOnly: undefined, rejectionCode: "empty" };
}

function classifyValidated(parsed: ParsedBugOutput, validation: PatchValidation): AttemptResult {
  const guardCode = validation.ok ? scopeGuard(validation) : validation.reasons[0]?.code;
  if (validation.ok && guardCode === undefined) {
    const accepted: AcceptedBugPatch = {
      diff: parsed.diff,
      validation,
      hypothesis: hypothesisOf(parsed),
    };
    return { accepted, investigationOnly: undefined, rejectionCode: undefined };
  }
  return {
    accepted: undefined,
    investigationOnly: undefined,
    rejectionCode: guardCode ?? "malformed",
  };
}

async function attemptOnce(
  state: BugRunState,
  workspace: WorkspaceInfo,
  report: BugReportInput,
  evidence: FailureEvidence,
  pack: ContextPack,
  attempt: number,
  rejectionReason: string | undefined,
): Promise<AttemptResult> {
  const messages = buildBugPrompt(report, evidence, pack, workspace.testFramework, rejectionReason);
  const content = await callModel(state, messages, attempt, pack.usedBytes);
  const parsed = parseBugModelOutput(content);
  state.emitter.emit({
    type: "bug:rootcause:proposed",
    hasPatch: parsed.diff.length > 0,
    ...(parsed.confidence === undefined ? {} : { confidence: parsed.confidence }),
  });
  if (parsed.diff.length === 0) {
    return classifyEmptyDiff(parsed);
  }
  const validation = validatePatch(workspace, parsed.diff, {
    fs: state.deps.fs ?? nodeWorkspaceFs,
    limits: patchLimitsFrom(state.limits),
  });
  const result = classifyValidated(parsed, validation);
  emitValidation(state, validation, result.rejectionCode);
  return result;
}

// True when the attempt produced a terminal outcome (accepted patch or investigation-only); a
// retryable rejection is the only non-terminal case.
function isTerminal(result: AttemptResult): boolean {
  return result.accepted !== undefined || result.investigationOnly !== undefined;
}

export async function runBugModelLoop(
  state: BugRunState,
  workspace: WorkspaceInfo,
  report: BugReportInput,
  evidence: FailureEvidence,
  pack: ContextPack,
): Promise<BugModelLoopResult> {
  let modelCallCount = 0;
  let patchRetryCount = 0;
  let rejectionReason: string | undefined;
  while (
    modelCallCount < state.limits.maxModelCalls &&
    patchRetryCount <= state.limits.maxRetries
  ) {
    modelCallCount += 1;
    const r = await attemptOnce(
      state,
      workspace,
      report,
      evidence,
      pack,
      modelCallCount,
      rejectionReason,
    );
    if (isTerminal(r)) {
      return {
        accepted: r.accepted,
        investigationOnly: r.investigationOnly,
        modelCallCount,
        patchRetryCount,
        lastRejectionCode: undefined,
      };
    }
    patchRetryCount += 1;
    rejectionReason = r.rejectionCode;
  }
  return {
    accepted: undefined,
    investigationOnly: undefined,
    modelCallCount,
    patchRetryCount,
    lastRejectionCode: rejectionReason,
  };
}
