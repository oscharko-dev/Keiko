import type { NormalizedResponse } from "@oscharko-dev/keiko-contracts";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { GatewayCallRequest, GatewayStreamChunk } from "@oscharko-dev/keiko-model-gateway";

import {
  CONVERSATION_READINESS_MAX_AGE_MS,
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

export interface ConversationReadinessAdmission {
  readonly modelId: string;
  readonly gatewayConfigGeneration?: number | undefined;
}

export class ConversationModelNotReadyError extends Error {
  public constructor() {
    super(
      "The selected model failed its live readiness check. Open Settings > Models and run the readiness check to see the provider status.",
    );
    this.name = "ConversationModelNotReadyError";
  }
}

export function conversationModelNotReadyResult(): RouteResult {
  return {
    status: 400,
    body: errorBody(
      "BAD_REQUEST",
      "The selected model failed its live readiness check. Open Settings > Models and run the readiness check to see the provider status.",
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
  completedAt?: number,
): ConversationAdmissionDisposition {
  if (modelId !== admission.modelId) return "model-changed";
  const holder = deps.gatewayConfig;
  if (holder === undefined) return "allowed-untracked";
  if (holder.generation() !== admission.gatewayConfigGeneration) return "generation-changed";
  const observation = holder.verifiedCapability(modelId);
  if (observation?.generation !== holder.generation() || observation.modelId !== modelId)
    return "observation-unavailable";
  return observationDisposition(observation, completedAt);
}

function observationDisposition(
  observation: VerifiedModelCapabilityObservation,
  completedAt: number | undefined,
): ConversationAdmissionDisposition {
  if (observation.fields.conversationReady !== true)
    return observation.fields.conversationReady === false
      ? "probe-failed"
      : "observation-unavailable";
  const ageMs = conversationReadinessAgeMs(observation);
  if (!Number.isFinite(ageMs) || ageMs < 0) return "timestamp-invalid";
  if (ageMs < CONVERSATION_READINESS_MAX_AGE_MS) return "allowed-fresh";
  const completionAgeMs = completedAt === undefined ? Number.NaN : Date.now() - completedAt;
  return completionAgeMs >= 0 && completionAgeMs < CONVERSATION_READINESS_MAX_AGE_MS
    ? "allowed-continuation"
    : "expired";
}

interface ConversationCallGuard {
  assert(request: GatewayCallRequest, signal: AbortSignal): void;
  complete(response: NormalizedResponse, signal: AbortSignal): void;
}

const SERVED_FINISH_REASONS = new Set<NormalizedResponse["finishReason"]>([
  "stop",
  "tool_calls",
  "length",
]);

function conversationCallGuard(
  modelId: string,
  admission: ConversationReadinessAdmission,
  deps: Pick<UiHandlerDeps, "gatewayConfig">,
): ConversationCallGuard {
  let completedAt: number | undefined;
  return {
    assert(request, signal): void {
      signal.throwIfAborted();
      const disposition =
        request.modelId === modelId
          ? admissionDisposition(deps, admission, modelId, completedAt)
          : "model-changed";
      logConversationAdmission(
        disposition,
        request.logContext?.correlationId,
        admission.gatewayConfigGeneration,
        deps.gatewayConfig?.generation(),
      );
      if (!disposition.startsWith("allowed-")) throw new ConversationModelNotReadyError();
    },
    complete(response, signal): void {
      if (
        !signal.aborted &&
        response.modelId === modelId &&
        SERVED_FINISH_REASONS.has(response.finishReason)
      )
        completedAt = Date.now();
    },
  };
}

export function withConversationReadinessAdmission(
  model: ModelPort,
  modelId: string,
  admission: ConversationReadinessAdmission,
  deps: Pick<UiHandlerDeps, "gatewayConfig">,
): ModelPort {
  const guard = conversationCallGuard(modelId, admission, deps);
  const call: ModelPort["call"] = async (request, signal) => {
    guard.assert(request, signal);
    const response = await model.call(request, signal);
    guard.complete(response, signal);
    return response;
  };
  if (model.callStream === undefined) return { call };
  // Bind the receiver: GatewayModelPort.callStream is a prototype method reading
  // this.gateway — extracting it bare would throw a TypeError on the first next() of any
  // streaming consumer (same rule chat-stream-handlers already follows with .bind).
  const callStream = model.callStream.bind(model);
  return {
    call,
    callStream: async function* (request, signal): AsyncIterable<GatewayStreamChunk> {
      guard.assert(request, signal);
      let completedResponse: NormalizedResponse | undefined;
      for await (const chunk of callStream(request, signal)) {
        if (chunk.type === "done") completedResponse = chunk.response;
        yield chunk;
      }
      if (completedResponse !== undefined) guard.complete(completedResponse, signal);
    },
  };
}

export function mappedConversationReadinessError(error: unknown): RouteResult | undefined {
  return error instanceof ConversationModelNotReadyError
    ? conversationModelNotReadyResult()
    : undefined;
}
