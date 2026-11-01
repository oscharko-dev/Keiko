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

type RequiredConversationCapability = "conversation" | "tool-calling";
const TOOL_CALLING_REQUIRED_MESSAGE =
  "Jira access requires a model with verified tool calling. Run the tool-calling check in Settings > Models, choose a verified model, or disconnect the Jira Pod.";
const CONVERSATION_REQUIRED_MESSAGE =
  "The selected model failed its live readiness check. Open Settings > Models and run the readiness check to see the provider status.";

export class ConversationModelNotReadyError extends Error {
  public constructor(
    public readonly requiredCapability: RequiredConversationCapability = "conversation",
  ) {
    super(
      requiredCapability === "tool-calling"
        ? TOOL_CALLING_REQUIRED_MESSAGE
        : CONVERSATION_REQUIRED_MESSAGE,
    );
    this.name = "ConversationModelNotReadyError";
  }
}

export function conversationModelNotReadyResult(
  requiredCapability: RequiredConversationCapability = "conversation",
): RouteResult {
  return {
    status: 400,
    body: errorBody(
      requiredCapability === "tool-calling" ? "CONVERSATION_UNAVAILABLE_MODEL" : "BAD_REQUEST",
      requiredCapability === "tool-calling"
        ? TOOL_CALLING_REQUIRED_MESSAGE
        : CONVERSATION_REQUIRED_MESSAGE,
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

/**
 * Checks the model again through the conversation-request readiness check (ADR-0171). Given to the
 * guard, an admission that merely expired during a long turn is checked once more instead of
 * refused: a tool turn can outlast the freshness interval without a served response, and refusing it
 * then ended a working Jira turn with "failed its live readiness check" while the very next check of
 * the same model answered ready (2026-11-01, S08).
 */
export type ConversationReadinessRecheck = (
  modelId: string,
  correlationId: string | undefined,
) => Promise<void>;

interface ConversationCallGuard {
  assert(request: GatewayCallRequest, signal: AbortSignal): Promise<void>;
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
  recheck: ConversationReadinessRecheck | undefined,
): ConversationCallGuard {
  let completedAt: number | undefined;
  const decide = (request: GatewayCallRequest): ConversationAdmissionDisposition => {
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
    return disposition;
  };
  return {
    async assert(request, signal): Promise<void> {
      signal.throwIfAborted();
      let disposition = decide(request);
      // Only an expiry is checked again; a failed probe, a replaced model or configuration and a
      // missing or malformed observation still refuse at once. The recheck must leave a fresh
      // positive observation of this generation, or the call is refused before any provider work.
      if (disposition === "expired" && recheck !== undefined) {
        await recheck(modelId, request.logContext?.correlationId);
        signal.throwIfAborted();
        disposition = decide(request);
      }
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
  recheck?: ConversationReadinessRecheck,
): ModelPort {
  const guard = conversationCallGuard(modelId, admission, deps, recheck);
  const call: ModelPort["call"] = async (request, signal) => {
    await guard.assert(request, signal);
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
      await guard.assert(request, signal);
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
    ? conversationModelNotReadyResult(error.requiredCapability)
    : undefined;
}
