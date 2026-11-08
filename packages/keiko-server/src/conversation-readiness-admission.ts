import type { ModelPort } from "@oscharko-dev/keiko-harness";
import {
  AuthenticationError,
  ProviderError,
  UnknownModelError,
  type GatewayCallRequest,
  type GatewayStreamChunk,
} from "@oscharko-dev/keiko-model-gateway";

import {
  ConversationModelNotReadyError,
  type RequiredConversationCapability,
  type ToolCallingReadinessReason,
} from "./conversation-readiness-error.js";

import {
  CONVERSATION_READINESS_CACHED_AFTER_MS,
  conversationReadinessAgeMs,
  currentConversationReady,
  type UiHandlerDeps,
  type VerifiedModelCapabilityObservation,
} from "./deps.js";
import {
  logConversationAdmission,
  type ConversationAdmissionDisposition,
} from "./conversation-readiness-log.js";
import { errorBody, type RouteResult } from "./routes.js";

export { ConversationModelNotReadyError };

export interface ConversationReadinessAdmission {
  readonly modelId: string;
  readonly gatewayConfigGeneration?: number | undefined;
}

export function conversationModelNotReadyResult(
  requiredCapability: RequiredConversationCapability = "conversation",
  reason: ToolCallingReadinessReason | undefined = requiredCapability === "tool-calling"
    ? "unsupported"
    : undefined,
): RouteResult {
  const unsupported = requiredCapability === "tool-calling" && reason === "unsupported";
  const failure = new ConversationModelNotReadyError(requiredCapability, reason);
  return {
    status: 400,
    body: errorBody(
      unsupported ? "CONVERSATION_UNAVAILABLE_MODEL" : "CONVERSATION_MODEL_NOT_READY",
      failure.message,
    ),
  };
}

export function captureConversationReadinessAdmission(
  deps: Pick<UiHandlerDeps, "gatewayConfig">,
  modelId: string,
): ConversationReadinessAdmission | RouteResult {
  const holder = deps.gatewayConfig;
  if (holder === undefined) return { modelId };
  const gatewayConfigGeneration = holder.generation();
  return currentConversationReady(deps, modelId)
    ? { modelId, gatewayConfigGeneration }
    : conversationModelNotReadyResult();
}

export function assertConversationReadinessAdmission(
  deps: Pick<UiHandlerDeps, "gatewayConfig">,
  admission: ConversationReadinessAdmission,
  modelId: string,
): void {
  if (validateConversationReadinessAdmission(deps, admission, modelId) !== undefined) {
    throw new ConversationModelNotReadyError();
  }
}

export function validateConversationReadinessAdmission(
  deps: Pick<UiHandlerDeps, "gatewayConfig">,
  admission: ConversationReadinessAdmission,
  modelId: string,
): RouteResult | undefined {
  return admissionDisposition(deps, admission, modelId).startsWith("allowed-")
    ? undefined
    : conversationModelNotReadyResult();
}

function admissionDisposition(
  deps: Pick<UiHandlerDeps, "gatewayConfig">,
  admission: ConversationReadinessAdmission,
  modelId: string,
): ConversationAdmissionDisposition {
  if (modelId !== admission.modelId) return "model-changed";
  const holder = deps.gatewayConfig;
  if (holder === undefined) return "allowed-untracked";
  if (holder.generation() !== admission.gatewayConfigGeneration) return "generation-changed";
  const observation = holder.verifiedCapability(modelId);
  if (observation?.generation !== holder.generation() || observation.modelId !== modelId)
    return "observation-unavailable";
  return observationDisposition(observation);
}

function observationDisposition(
  observation: VerifiedModelCapabilityObservation,
): ConversationAdmissionDisposition {
  if (observation.fields.conversationReady !== true)
    return observation.fields.conversationReady === false
      ? "probe-failed"
      : "observation-unavailable";
  const ageMs = conversationReadinessAgeMs(observation);
  if (!Number.isFinite(ageMs) || ageMs < 0) return "timestamp-invalid";
  return ageMs < CONVERSATION_READINESS_CACHED_AFTER_MS ? "allowed-fresh" : "allowed-cached";
}

function observeConversationFailure(
  deps: Pick<UiHandlerDeps, "gatewayConfig">,
  admission: ConversationReadinessAdmission,
  observation: VerifiedModelCapabilityObservation | undefined,
  request: GatewayCallRequest,
  error: unknown,
): void {
  const definitive =
    error instanceof AuthenticationError ||
    error instanceof UnknownModelError ||
    (error instanceof ProviderError && error.httpStatus === 404);
  const holder = deps.gatewayConfig;
  if (
    !definitive ||
    holder === undefined ||
    observation === undefined ||
    holder.generation() !== admission.gatewayConfigGeneration ||
    holder.verifiedCapability(admission.modelId) !== observation
  )
    return;
  holder.recordVerifiedCapability(
    admission.modelId,
    { ...observation.fields, conversationReady: false },
    observation.checkedAt,
    admission.gatewayConfigGeneration,
    new Date().toISOString(),
  );
  logConversationAdmission(
    "provider-rejected",
    request.logContext?.correlationId,
    admission.gatewayConfigGeneration,
    holder.generation(),
  );
}

/** Read the current generation-bound result at dispatch; never send a readiness probe. */
export function withConversationReadinessAdmission(
  model: ModelPort,
  modelId: string,
  admission: ConversationReadinessAdmission,
  deps: Pick<UiHandlerDeps, "gatewayConfig">,
): ModelPort {
  const assert = (request: GatewayCallRequest, signal: AbortSignal): void => {
    signal.throwIfAborted();
    const disposition =
      request.modelId === modelId
        ? admissionDisposition(deps, admission, modelId)
        : "model-changed";
    logConversationAdmission(
      disposition,
      request.logContext?.correlationId,
      admission.gatewayConfigGeneration,
      deps.gatewayConfig?.generation(),
    );
    if (!disposition.startsWith("allowed-")) throw new ConversationModelNotReadyError();
  };
  const call: ModelPort["call"] = async (request, signal) => {
    assert(request, signal);
    const observation = deps.gatewayConfig?.verifiedCapability(modelId);
    try {
      return await model.call(request, signal);
    } catch (error) {
      observeConversationFailure(deps, admission, observation, request, error);
      throw error;
    }
  };
  if (model.callStream === undefined) return { call };
  const stream = model.callStream.bind(model);
  return {
    call,
    callStream /* NOSONAR typescript:S7503 -- async iterator delegation. */:
      /* NOSONAR typescript:S7503 -- yield* awaits async next/throw/return delegation. */ async function* (
        request,
        signal,
      ): AsyncIterable<GatewayStreamChunk> {
        assert(request, signal);
        const observation = deps.gatewayConfig?.verifiedCapability(modelId);
        try {
          yield* stream(request, signal);
        } catch (error) {
          observeConversationFailure(deps, admission, observation, request, error);
          throw error;
        }
      },
  };
}

export function mappedConversationReadinessError(error: unknown): RouteResult | undefined {
  return error instanceof ConversationModelNotReadyError
    ? conversationModelNotReadyResult(error.requiredCapability, error.reason)
    : undefined;
}
