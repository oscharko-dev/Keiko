// The bounded model/validate/production-guard retry loop (ADR-0008 D6/D8). Each attempt builds the
// prompt, calls the injected ModelPort, parses the output, validates the diff through #6, and
// applies the production-code guard. The loop stops on the first accepted patch, after maxRetries
// rejections, or when model calls reach the maxModelCalls hard ceiling — whichever comes first. The
// model call is the one IO boundary here; its failure propagates to the workflow catch boundary.

import type { ChatMessage } from "@oscharko-dev/keiko-model-gateway";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import type { ContextPack, WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { validatePatch, type PatchValidation } from "@oscharko-dev/keiko-tools";
import { isTestPath } from "./conventions.js";
import { parseModelOutput } from "./parse.js";
import { buildPrompt } from "./prompt.js";
import type { AcceptedPatch, ModelLoopResult, RunState } from "./internal.js";
import type { TestConventions } from "./types.js";

// The production-code guard (D6): every changed path must satisfy isTestPath. Returns "out-of-scope"
// when any path is a non-test/traversal path, or undefined when all pass. The guard runs on
// validation.files[].path — the SAME string #6 resolves and would write.
function productionGuard(
  workspace: WorkspaceInfo,
  validation: PatchValidation,
): string | undefined {
  const offending = validation.files.some((file) => !isTestPath(workspace, file.path));
  return offending ? "out-of-scope" : undefined;
}

function emitValidation(
  state: RunState,
  validation: PatchValidation,
  code: string | undefined,
): void {
  const ok = code === undefined && validation.ok;
  state.emitter.emit({
    type: "patch:validated",
    ok,
    patchBytes: validation.totalBytes,
    filesChanged: validation.files.length,
    ...(ok ? {} : { rejectionCode: code ?? validation.reasons[0]?.code }),
  });
}

function emptyPatchRejection(parsedDiff: string, validation: PatchValidation): string | undefined {
  return parsedDiff.trim().length === 0 || validation.files.length === 0 ? "empty" : undefined;
}

async function callModel(
  state: RunState,
  messages: readonly ChatMessage[],
  attempt: number,
  contextBytes: number,
): Promise<string> {
  state.progress.modelCallCount = Math.max(state.progress.modelCallCount, attempt);
  state.emitter.emit({ type: "workflow:model:call:started", attempt, contextBytes });
  const response = await state.deps.model.call(
    { modelId: state.input.modelId, messages },
    state.signal,
  );
  state.emitter.emit({
    type: "workflow:model:call:completed",
    attempt,
    finishReason: response.finishReason,
    promptTokens: response.usage.promptTokens,
    completionTokens: response.usage.completionTokens,
    latencyMs: response.usage.latencyMs,
  });
  return response.content;
}

interface AttemptResult {
  readonly accepted: AcceptedPatch | undefined;
  readonly rejectionCode: string | undefined;
}

// One attempt: prompt -> model -> parse -> validate -> guard.
async function attemptOnce(
  state: RunState,
  workspace: WorkspaceInfo,
  conventions: TestConventions,
  pack: ContextPack,
  attempt: number,
  rejectionReason: string | undefined,
): Promise<AttemptResult> {
  const messages = buildPrompt(state.input, conventions, pack, rejectionReason);
  const content = await callModel(state, messages, attempt, pack.usedBytes);
  const parsed = parseModelOutput(content);
  const validation = validatePatch(workspace, parsed.diff, {
    fs: state.deps.fs ?? nodeWorkspaceFs,
  });
  const effectiveDiff = validation.normalizedDiff ?? parsed.diff;
  const guardCode = validation.ok
    ? (emptyPatchRejection(effectiveDiff, validation) ?? productionGuard(workspace, validation))
    : validation.reasons[0]?.code;
  emitValidation(state, validation, guardCode);
  if (validation.ok && guardCode === undefined) {
    const accepted: AcceptedPatch = {
      diff: effectiveDiff,
      validation,
      coveredBehavior: parsed.coveredBehavior,
      knownGaps: parsed.knownGaps,
    };
    return { accepted, rejectionCode: undefined };
  }
  return { accepted: undefined, rejectionCode: guardCode ?? "malformed" };
}

export async function runModelLoop(
  state: RunState,
  workspace: WorkspaceInfo,
  conventions: TestConventions,
  pack: ContextPack,
): Promise<ModelLoopResult> {
  let modelCallCount = 0;
  let patchRetryCount = 0;
  let rejectionReason: string | undefined;
  while (
    modelCallCount < state.limits.maxModelCalls &&
    patchRetryCount <= state.limits.maxRetries
  ) {
    modelCallCount += 1;
    const result = await attemptOnce(
      state,
      workspace,
      conventions,
      pack,
      modelCallCount,
      rejectionReason,
    );
    if (result.accepted !== undefined) {
      return {
        accepted: result.accepted,
        modelCallCount,
        patchRetryCount,
        lastRejectionCode: undefined,
      };
    }
    patchRetryCount += 1;
    state.progress.patchRetryCount = patchRetryCount;
    rejectionReason = result.rejectionCode;
  }
  return {
    accepted: undefined,
    modelCallCount,
    patchRetryCount,
    lastRejectionCode: rejectionReason,
  };
}
