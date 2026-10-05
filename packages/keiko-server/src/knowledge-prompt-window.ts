// Fits a Knowledge Pod answer prompt into the answering model's input budget (field report 1.1.13).
//
// The Knowledge Pod answer prompt carries up to `maxPromptReferences` excerpts and used to be sent
// whatever the model's window: a deployment with a small window then refused every grounded
// question, and after Keiko adopted a provider-reported window there was nothing to re-plan. The
// prompt now keeps the highest-ranked references that fit — the numbering of the kept references is
// unchanged, so their [n] markers still resolve — and refuses locally when not even one fits. The
// token count is the gateway admission's own (`countGatewayPromptTokens`), never a second estimate.

import type { ContextProfile } from "@oscharko-dev/keiko-contracts";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  countGatewayPromptTokens,
  type GatewayPromptTokenInput,
} from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import { ContextOverflowError } from "@oscharko-dev/keiko-security/errors/gateway";

import { correlationIdOrUnknown } from "./correlation.js";
import {
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticSink,
} from "./diagnostics-log.js";
import { getServerLogger } from "./observability/index.js";

const KNOWLEDGE_PROMPT_WINDOW_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "search.prompt.window-fitted",
  category: "search",
  owner: "keiko-server",
  emitter: "knowledge-prompt-window.logPromptWindowFit",
  fields: {
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["trimmed", "metadata-trimmed", "refused"],
    },
    referenceCount: { type: "integer", dataClass: "count", required: true },
    sentReferenceCount: { type: "integer", dataClass: "count", required: true },
    inputBudget: { type: "integer", dataClass: "count", required: true },
    // The estimate of the prompt that was sent (trimmed) or of the smallest one refused.
    promptTokens: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["knowledge-prompt-window"],
  proofIds: ["search.prompt.window-fitted.line"],
  releaseImpact: "patch",
});

export interface PromptWindowFit {
  readonly state: "trimmed" | "metadata-trimmed" | "refused";
  readonly referenceCount: number;
  readonly sentReferenceCount: number;
  readonly promptTokens: number;
  /** The input budget the prompt was fitted to. */
  readonly inputBudget: number;
}

/**
 * Records a grounded prompt that was trimmed or refused to fit the model. The Knowledge Pod and
 * hybrid prompts report through `fitKnowledgePrompt`; the multi-source prompt, which trims excerpt
 * bytes instead of references, reports here directly (PR #3678 review).
 */
export function logPromptWindowFit(fit: PromptWindowFit, correlationId: string | undefined): void {
  getServerLogger().info(
    activityLogEvent(
      KNOWLEDGE_PROMPT_WINDOW_OPERATION,
      {
        correlationId: correlationIdOrUnknown(correlationId),
        ...(fit.state === "refused" ? { errorKind: "invalid-request" } : {}),
      },
      { ...fit, completeness: "complete", loss: "none" },
    ),
  );
}

/** Where a fitted prompt reports: the request's correlation and the server diagnostic port. */
export interface KnowledgePromptWindowContext {
  readonly correlationId: string | undefined;
  readonly diagnostics?: ServerDiagnosticSink | undefined;
}

// A local refusal never reaches the gateway, so its structured failure diagnostic — error class and
// dist-anchored frames on the request's correlation — is emitted here (PR #3678 review).
function refusal(context: KnowledgePromptWindowContext): ContextOverflowError {
  const error = new ContextOverflowError(
    "the grounded question with one reference exceeds the model input budget",
  );
  emitServerDiagnostic(
    context.diagnostics,
    serverDiagnosticFromError({
      correlationId: correlationIdOrUnknown(context.correlationId),
      operation: "search.prompt.window-fitted",
      source: "knowledge-prompt-window.fit",
      error,
      summary:
        "A Knowledge Pod question did not fit the model's context window with a single reference.",
      redact: (message): string => message,
    }),
  );
  return error;
}

export interface FittedKnowledgePrompt<T> {
  readonly prompt: T;
  readonly referenceCount: number;
}

function promptTokens(prompt: GatewayPromptTokenInput, profile: ContextProfile): number {
  return countGatewayPromptTokens(prompt, profile.tokenAccounting, {
    contextWindow: profile.maxInputTokens,
  });
}

function fitsBudget(prompt: GatewayPromptTokenInput, profile: ContextProfile): boolean {
  return promptTokens(prompt, profile) <= profile.effectiveInputBudget;
}

// Largest reference count in [1, available) whose prompt fits; 0 when not even one fits.
function largestFittingCount(
  available: number,
  render: (referenceCount: number) => GatewayPromptTokenInput,
  profile: ContextProfile,
): number {
  let low = 0;
  let high = available - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fitsBudget(render(mid), profile)) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * Renders the prompt with the highest-ranked `available` references, dropping trailing references
 * until it fits the profile's input budget. Throws `ContextOverflowError` when the question with a
 * single reference already exceeds the budget: a grounded answer without evidence would read as
 * "nothing found" instead of the real cause.
 */
export function fitKnowledgePrompt<T extends GatewayPromptTokenInput>(
  available: number,
  render: (referenceCount: number) => T,
  profile: ContextProfile | undefined,
  context: KnowledgePromptWindowContext,
): FittedKnowledgePrompt<T> {
  const full = render(available);
  if (profile === undefined || available === 0 || fitsBudget(full, profile)) {
    return { prompt: full, referenceCount: available };
  }
  const count = largestFittingCount(available, render, profile);
  if (count === 0) {
    const smallest = promptTokens(render(1), profile);
    logPromptWindowFit(
      {
        state: "refused",
        referenceCount: available,
        sentReferenceCount: 0,
        promptTokens: smallest,
        inputBudget: profile.effectiveInputBudget,
      },
      context.correlationId,
    );
    throw refusal(context);
  }
  const prompt = render(count);
  logPromptWindowFit(
    {
      state: "trimmed",
      referenceCount: available,
      sentReferenceCount: count,
      promptTokens: promptTokens(prompt, profile),
      inputBudget: profile.effectiveInputBudget,
    },
    context.correlationId,
  );
  return { prompt, referenceCount: count };
}

/**
 * The estimated size of a rendered prompt, the share its source excerpts take (the difference to
 * the same prompt rendered without references) and the share of its system instructions. Counted
 * with the admission's own accounting.
 */
export function knowledgePromptShare(
  prompt: GatewayPromptTokenInput,
  withoutSources: GatewayPromptTokenInput,
  accounting: ContextProfile["tokenAccounting"],
): {
  readonly estimatedTokens: number;
  readonly sourceTokens: number;
  readonly instructionTokens: number;
} {
  const estimatedTokens = countGatewayPromptTokens(prompt, accounting);
  const instructions = prompt.messages.filter((message) => message.role === "system");
  return {
    estimatedTokens,
    sourceTokens: Math.max(
      0,
      estimatedTokens - countGatewayPromptTokens(withoutSources, accounting),
    ),
    instructionTokens: countGatewayPromptTokens({ messages: instructions }, accounting),
  };
}
