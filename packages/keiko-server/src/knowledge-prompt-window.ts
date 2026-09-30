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
      values: ["trimmed", "refused"],
    },
    referenceCount: { type: "integer", dataClass: "count", required: true },
    sentReferenceCount: { type: "integer", dataClass: "count", required: true },
    inputBudget: { type: "integer", dataClass: "count", required: true },
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

function logPromptWindowFit(
  state: "trimmed" | "refused",
  referenceCount: number,
  sentReferenceCount: number,
  inputBudget: number,
  correlationId: string | undefined,
): void {
  getServerLogger().info(
    activityLogEvent(
      KNOWLEDGE_PROMPT_WINDOW_OPERATION,
      {
        correlationId: correlationIdOrUnknown(correlationId),
        ...(state === "refused" ? { errorKind: "invalid-request" } : {}),
      },
      {
        state,
        referenceCount,
        sentReferenceCount,
        inputBudget,
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}

export interface FittedKnowledgePrompt<T> {
  readonly prompt: T;
  readonly referenceCount: number;
}

function fitsBudget(prompt: GatewayPromptTokenInput, profile: ContextProfile): boolean {
  return (
    countGatewayPromptTokens(prompt, profile.tokenAccounting, {
      contextWindow: profile.maxInputTokens,
    }) <= profile.effectiveInputBudget
  );
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
  correlationId: string | undefined,
): FittedKnowledgePrompt<T> {
  const full = render(available);
  if (profile === undefined || available === 0 || fitsBudget(full, profile)) {
    return { prompt: full, referenceCount: available };
  }
  const count = largestFittingCount(available, render, profile);
  if (count === 0) {
    logPromptWindowFit("refused", available, 0, profile.effectiveInputBudget, correlationId);
    throw new ContextOverflowError(
      "the grounded question with one reference exceeds the model input budget",
    );
  }
  logPromptWindowFit("trimmed", available, count, profile.effectiveInputBudget, correlationId);
  return { prompt: render(count), referenceCount: count };
}
