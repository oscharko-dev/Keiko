import { deriveContextProfileFromCapability } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { ContextOverflowError } from "@oscharko-dev/keiko-security/errors/gateway";
import type { GatewayCallRequest } from "./gateway.js";
import type { ModelCapability } from "./types.js";
import type { ModelGatewayLogSink } from "./observability.js";
import {
  countGatewayPromptTokens,
  type GatewayPromptTokenInput,
} from "./prompt-token-accounting.js";
import type { ProviderTokenCount } from "./provider-token-counter.js";

const PROMPT_ADMISSION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.prompt.admission",
  category: "gateway",
  owner: "keiko-model-gateway",
  emitter: "prompt-admission.admitGatewayPrompt",
  fields: {
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["admitted", "overflow"],
    },
    counterSource: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["calibrated", "fallback-estimated", "gateway-reported"],
    },
    counterStatus: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["disabled", "available", "unavailable", "invalid"],
    },
    tokenizer: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["openai", "huggingface", "other", "unknown"],
    },
    promptTokens: { type: "integer", dataClass: "count", required: true },
    inputBudget: { type: "integer", dataClass: "count", required: true },
    outputBudget: { type: "integer", dataClass: "count", required: true },
    contextWindow: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["gateway-context-admission"],
  proofIds: ["gateway.prompt.admission.bounds"],
  releaseImpact: "patch",
});

const DISABLED_COUNTER: ProviderTokenCount = { status: "disabled" };

export function admitGatewayPrompt(
  request: GatewayCallRequest & GatewayPromptTokenInput,
  capability: ModelCapability,
  log: ModelGatewayLogSink,
  correlationId: string,
  measured: ProviderTokenCount = DISABLED_COUNTER,
): GatewayCallRequest {
  const profile = deriveContextProfileFromCapability(capability);
  const outputBudget = outputAllocation(request.maxOutputTokens, profile.reservedOutputTokens);
  const inputBudget = Math.max(
    0,
    profile.maxInputTokens - outputBudget - profile.safetyMarginTokens,
  );
  const estimatedTokens = countGatewayPromptTokens(request, profile.tokenAccounting);
  const promptTokens = Math.max(estimatedTokens, measured.tokens ?? 0);
  const overflow = promptTokens > inputBudget || outputExceedsCapability(outputBudget, capability);
  log.write(
    activityLogEvent(
      PROMPT_ADMISSION,
      { correlationId },
      {
        state: overflow ? "overflow" : "admitted",
        counterSource: selectedCounterSource(
          measured.tokens,
          estimatedTokens,
          profile.tokenAccounting?.source,
        ),
        counterStatus: measured.status,
        tokenizer: measured.tokenizer ?? "unknown",
        promptTokens,
        inputBudget,
        outputBudget,
        contextWindow: profile.maxInputTokens,
        completeness: "complete",
        loss: "none",
      },
    ),
  );
  if (overflow)
    throw new ContextOverflowError(
      "complete provider prompt and output allocation exceed the model context budget",
    );
  return { ...request, maxOutputTokens: outputBudget };
}

function outputExceedsCapability(output: number, capability: ModelCapability): boolean {
  return (
    !Number.isSafeInteger(output) ||
    output <= 0 ||
    (capability.maxOutputTokens > 0 && output > capability.maxOutputTokens)
  );
}

function outputAllocation(requested: number | undefined, fallback: number): number {
  const output = requested ?? fallback;
  return Number.isSafeInteger(output) && output > 0 ? output : 0;
}

function selectedCounterSource(
  measured: number | undefined,
  estimated: number,
  source: "calibrated" | "fallback-estimated" | undefined,
): "calibrated" | "fallback-estimated" | "gateway-reported" {
  return measured !== undefined && measured >= estimated
    ? "gateway-reported"
    : (source ?? "fallback-estimated");
}
