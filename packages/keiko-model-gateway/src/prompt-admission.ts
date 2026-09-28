import {
  deriveContextProfileFromCapability,
  type ContextTokenAccounting,
  type ContextProfile,
} from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { ContextOverflowError } from "@oscharko-dev/keiko-security/errors/gateway";
import type { GatewayCallRequest } from "./gateway.js";
import type { ModelCapability } from "./types.js";
import {
  GATEWAY_FAILURE_EVIDENCE_FIELDS,
  gatewayFailureEvidence,
  type ModelGatewayLogSink,
} from "./observability.js";
import {
  countGatewayPromptTokens,
  countGatewayResponseFormatTokens,
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
    ...GATEWAY_FAILURE_EVIDENCE_FIELDS,
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
      values: ["calibrated", "fallback-estimated", "gateway-reported", "retained-measurement"],
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
    imageCount: { type: "integer", dataClass: "count", required: true },
    imageAccounting: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["none", "fallback-estimated", "provider-measured", "retained-measurement"],
    },
    imageReserveTokens: { type: "integer", dataClass: "count", required: true },
    localPromptTokens: { type: "integer", dataClass: "count", required: true },
    fallbackPromptTokens: { type: "integer", dataClass: "count", required: true },
    reportedPromptTokens: { type: "integer", dataClass: "count", required: false },
    providerPromptTokens: { type: "integer", dataClass: "count", required: false },
    retainedPromptTokens: { type: "integer", dataClass: "count", required: false },
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
  retainedTokens?: number,
): GatewayCallRequest {
  const profile = deriveContextProfileFromCapability(capability);
  const outputBudget = outputAllocation(request.maxOutputTokens, profile.reservedOutputTokens);
  const inputBudget = Math.max(
    0,
    profile.maxInputTokens - outputBudget - profile.safetyMarginTokens,
  );
  const evidence = promptTokenEvidence(request, profile, measured, retainedTokens);
  const promptTokens = Math.max(
    evidence.localPromptTokens,
    evidence.providerPromptTokens ?? 0,
    evidence.retainedPromptTokens ?? 0,
  );
  const refusal = promptRefusal(promptTokens, inputBudget, outputBudget, capability);
  log.write(
    activityLogEvent(
      PROMPT_ADMISSION,
      { correlationId, ...(refusal === undefined ? {} : { errorKind: "invalid-request" }) },
      {
        ...(refusal === undefined ? {} : gatewayFailureEvidence(log, refusal)),
        state: refusal === undefined ? "admitted" : "overflow",
        counterSource: selectedCounterSource(evidence, profile.tokenAccounting?.source),
        counterStatus: measured.status,
        tokenizer: measured.tokenizer ?? "unknown",
        ...evidence,
        promptTokens,
        inputBudget,
        outputBudget,
        contextWindow: profile.maxInputTokens,
        completeness: "complete",
        loss: "none",
      },
    ),
  );
  if (refusal !== undefined) throw refusal;
  return request;
}

interface PromptTokenEvidence {
  readonly imageCount: number;
  readonly imageAccounting:
    "none" | "fallback-estimated" | "provider-measured" | "retained-measurement";
  readonly imageReserveTokens: number;
  readonly localPromptTokens: number;
  readonly fallbackPromptTokens: number;
  readonly reportedPromptTokens?: number;
  readonly providerPromptTokens?: number;
  readonly retainedPromptTokens?: number;
}

function promptTokenEvidence(
  request: GatewayPromptTokenInput,
  profile: ContextProfile,
  measured: ProviderTokenCount,
  retainedTokens: number | undefined,
): PromptTokenEvidence {
  const imageCount = request.messages.reduce(
    (count, message) =>
      count + (message.contentParts?.filter((part) => part.type === "image_url").length ?? 0),
    0,
  );
  const imageAccounting = imageAccountingSource(imageCount, measured.tokens, retainedTokens);
  const options = { contextWindow: profile.maxInputTokens };
  const fallbackPromptTokens = countGatewayPromptTokens(request, profile.tokenAccounting, options);
  const textFloor =
    imageCount === 0
      ? fallbackPromptTokens
      : countGatewayPromptTokens(request, profile.tokenAccounting, {
          ...options,
          imageTokensMeasured: true,
        });
  const localPromptTokens =
    imageAccounting === "fallback-estimated" ? fallbackPromptTokens : textFloor;
  const providerPromptTokens = completeMeasuredTokens(
    request,
    measured.tokens,
    profile.tokenAccounting,
  );
  const retainedPromptTokens = completeMeasuredTokens(
    request,
    retainedTokens,
    profile.tokenAccounting,
  );
  return {
    imageCount,
    imageAccounting,
    imageReserveTokens: localPromptTokens - textFloor,
    localPromptTokens,
    fallbackPromptTokens,
    ...(measured.tokens === undefined ? {} : { reportedPromptTokens: measured.tokens }),
    ...(providerPromptTokens === undefined ? {} : { providerPromptTokens }),
    ...(retainedPromptTokens === undefined ? {} : { retainedPromptTokens }),
  };
}

function imageAccountingSource(
  imageCount: number,
  current: number | undefined,
  retained: number | undefined,
): PromptTokenEvidence["imageAccounting"] {
  if (imageCount === 0) return "none";
  if ((current ?? 0) > 0) return "provider-measured";
  return (retained ?? 0) > 0 ? "retained-measurement" : "fallback-estimated";
}

function promptRefusal(
  promptTokens: number,
  inputBudget: number,
  outputBudget: number,
  capability: ModelCapability,
): ContextOverflowError | undefined {
  if (promptTokens <= inputBudget && !outputExceedsCapability(outputBudget, capability))
    return undefined;
  return new ContextOverflowError(
    "complete provider prompt and output allocation exceed the model context budget",
  );
}

function completeMeasuredTokens(
  request: GatewayPromptTokenInput,
  tokens: number | undefined,
  accounting: ContextTokenAccounting | undefined,
): number | undefined {
  return tokens === undefined
    ? undefined
    : tokens + countGatewayResponseFormatTokens(request, accounting);
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
  evidence: PromptTokenEvidence,
  source: "calibrated" | "fallback-estimated" | undefined,
): "calibrated" | "fallback-estimated" | "gateway-reported" | "retained-measurement" {
  const measured = evidence.providerPromptTokens;
  const retained = evidence.retainedPromptTokens ?? 0;
  if (retained > Math.max(evidence.localPromptTokens, measured ?? 0)) return "retained-measurement";
  return measured !== undefined && measured >= evidence.localPromptTokens
    ? "gateway-reported"
    : (source ?? "fallback-estimated");
}
