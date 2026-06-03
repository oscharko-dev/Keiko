// The bounded model/validate/scope-guard retry loop (ADR-0009 D6/D10). Each attempt builds the
// prompt, calls the injected ModelPort, parses the output, and classifies the result. The KEY
// behavioural difference from #8: an EMPTY diff with a root-cause hypothesis is a VALID
// investigation-only outcome (NOT a retry); only a malformed/oversized/out-of-scope NON-empty patch
// retries. The change budget (D6 bound 1) is enforced by passing a workflow-owned PatchLimits into
// #6 validatePatch; the sensitive-path guard (D6 bound 2) runs on validation.files[].path. The
// model call is the one IO boundary here; its failure propagates to the workflow catch boundary.

import type { ChatMessage } from "@oscharko-dev/keiko-model-gateway";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace";
import type { ContextPack, WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { validatePatch, type PatchValidation } from "@oscharko-dev/keiko-tools";
import { isTestPath } from "../unit-tests/conventions.js";
import { isSensitivePath } from "./guard.js";
import { parseBugModelOutputCandidates } from "./parse.js";
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
  state.progress.modelCallCount = Math.max(state.progress.modelCallCount, attempt);
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
  readonly rejectionReason: string | undefined;
}

function classifyEmptyDiff(parsed: ParsedBugOutput): AttemptResult {
  // Empty diff + a hypothesis -> investigation-only (NOT a retry). Empty diff + no prose -> retry.
  if (hasProse(parsed)) {
    return {
      accepted: undefined,
      investigationOnly: hypothesisOf(parsed),
      rejectionCode: undefined,
      rejectionReason: undefined,
    };
  }
  return {
    accepted: undefined,
    investigationOnly: undefined,
    rejectionCode: "empty",
    rejectionReason: "empty: no diff or root-cause hypothesis was provided",
  };
}

function validationRejectionReason(
  validation: PatchValidation,
  code: string | undefined,
): string | undefined {
  if (code === undefined) {
    return undefined;
  }
  const message = validation.reasons[0]?.message;
  if (message !== undefined) {
    return `${code}: ${message}`;
  }
  if (code === "test-only") {
    return "test-only: a source bug fix must include a minimal non-test source change; tests may be added in the same diff";
  }
  const conflict = validation.conflicts[0];
  if (conflict !== undefined) {
    return `${code}: ${conflict.path} hunk#${String(conflict.hunkIndex)} ${conflict.reason}`;
  }
  return code;
}

function sourceBugRequiresSourcePatch(
  workspace: WorkspaceInfo,
  report: BugReportInput,
  evidence: FailureEvidence,
): boolean {
  const paths = [...(report.targetFiles ?? []), ...evidence.frames.map((frame) => frame.file)];
  return paths.some((path) => !isTestPath(workspace, path));
}

function semanticGuard(
  workspace: WorkspaceInfo,
  validation: PatchValidation,
  requiresSourcePatch: boolean,
): string | undefined {
  if (validation.files.length === 0) {
    return "malformed";
  }
  const scopeCode = scopeGuard(validation);
  if (scopeCode !== undefined) {
    return scopeCode;
  }
  return requiresSourcePatch && validation.files.every((file) => isTestPath(workspace, file.path))
    ? "test-only"
    : undefined;
}

function emptyParsedOutput(): ParsedBugOutput {
  return {
    diff: "",
    rootCause: undefined,
    regressionTestStrategy: undefined,
    uncertainty: undefined,
    confidence: undefined,
  };
}

function classifyValidated(
  workspace: WorkspaceInfo,
  parsed: ParsedBugOutput,
  validation: PatchValidation,
  requiresSourcePatch: boolean,
): AttemptResult {
  const guardCode = validation.ok
    ? semanticGuard(workspace, validation, requiresSourcePatch)
    : validation.reasons[0]?.code;
  if (validation.ok && guardCode === undefined) {
    const accepted: AcceptedBugPatch = {
      diff: parsed.diff,
      validation,
      hypothesis: hypothesisOf(parsed),
    };
    return {
      accepted,
      investigationOnly: undefined,
      rejectionCode: undefined,
      rejectionReason: undefined,
    };
  }
  const rejectionCode = guardCode ?? "malformed";
  return {
    accepted: undefined,
    investigationOnly: undefined,
    rejectionCode,
    rejectionReason: validationRejectionReason(validation, rejectionCode),
  };
}

function validateCandidate(
  state: BugRunState,
  workspace: WorkspaceInfo,
  parsed: ParsedBugOutput,
  requiresSourcePatch: boolean,
): { readonly result: AttemptResult; readonly validation: PatchValidation } {
  const validation = validatePatch(workspace, parsed.diff, {
    fs: state.deps.fs ?? nodeWorkspaceFs,
    limits: patchLimitsFrom(state.limits),
  });
  const result = classifyValidated(
    workspace,
    { ...parsed, diff: validation.normalizedDiff ?? parsed.diff },
    validation,
    requiresSourcePatch,
  );
  return { result, validation };
}

function classifyPatchCandidates(
  state: BugRunState,
  workspace: WorkspaceInfo,
  report: BugReportInput,
  evidence: FailureEvidence,
  candidates: readonly ParsedBugOutput[],
): AttemptResult {
  const patchCandidates = candidates.filter((candidate) => candidate.diff.length > 0);
  if (patchCandidates.length === 0) {
    return classifyEmptyDiff(candidates[0] ?? emptyParsedOutput());
  }
  const requiresSourcePatch = sourceBugRequiresSourcePatch(workspace, report, evidence);
  let last: { result: AttemptResult; validation: PatchValidation } | undefined;
  for (const parsed of patchCandidates) {
    const next = validateCandidate(state, workspace, parsed, requiresSourcePatch);
    if (next.result.accepted !== undefined) {
      emitValidation(state, next.validation, next.result.rejectionCode);
      return next.result;
    }
    last = next;
  }
  if (last === undefined) {
    return classifyEmptyDiff(emptyParsedOutput());
  }
  emitValidation(state, last.validation, last.result.rejectionCode);
  return last.result;
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
  const candidates = parseBugModelOutputCandidates(content);
  state.emitter.emit({
    type: "bug:rootcause:proposed",
    hasPatch: candidates.some((candidate) => candidate.diff.length > 0),
    ...(candidates[0]?.confidence === undefined ? {} : { confidence: candidates[0].confidence }),
  });
  return classifyPatchCandidates(state, workspace, report, evidence, candidates);
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
  let lastRejectionCode: string | undefined;
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
    state.progress.patchRetryCount = patchRetryCount;
    lastRejectionCode = r.rejectionCode;
    rejectionReason = r.rejectionReason ?? r.rejectionCode;
  }
  return {
    accepted: undefined,
    investigationOnly: undefined,
    modelCallCount,
    patchRetryCount,
    lastRejectionCode,
  };
}
