import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { GatewayStreamChunk } from "@oscharko-dev/keiko-model-gateway";

import { currentConversationReady, type UiHandlerDeps } from "./deps.js";
import { errorBody, type RouteResult } from "./routes.js";

export interface ConversationReadinessAdmission {
  readonly modelId: string;
  readonly gatewayConfigGeneration?: number | undefined;
}

export class ConversationModelNotReadyError extends Error {
  public constructor() {
    super("The selected model is not ready for conversations.");
    this.name = "ConversationModelNotReadyError";
  }
}

export function conversationModelNotReadyResult(): RouteResult {
  return {
    status: 400,
    body: errorBody("BAD_REQUEST", "The selected model is not ready for conversations."),
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
  const holder = deps.gatewayConfig;
  if (
    modelId !== admission.modelId ||
    (holder !== undefined &&
      (holder.generation() !== admission.gatewayConfigGeneration ||
        !currentConversationReady(deps, modelId)))
  ) {
    return conversationModelNotReadyResult();
  }
  return undefined;
}

export function withConversationReadinessAdmission(
  model: ModelPort,
  modelId: string,
  admission: ConversationReadinessAdmission,
  deps: Pick<UiHandlerDeps, "gatewayConfig">,
): ModelPort {
  const call: ModelPort["call"] = (request, signal) => {
    assertConversationReadinessAdmission(deps, admission, modelId);
    return model.call(request, signal);
  };
  if (model.callStream === undefined) return { call };
  // Bind the receiver: GatewayModelPort.callStream is a prototype method reading
  // this.gateway — extracting it bare would throw a TypeError on the first next() of any
  // streaming consumer (same rule chat-stream-handlers already follows with .bind).
  const callStream = model.callStream.bind(model);
  return {
    call,
    callStream: async function* (request, signal): AsyncIterable<GatewayStreamChunk> {
      assertConversationReadinessAdmission(deps, admission, modelId);
      yield* callStream(request, signal);
    },
  };
}

export function mappedConversationReadinessError(error: unknown): RouteResult | undefined {
  return error instanceof ConversationModelNotReadyError
    ? conversationModelNotReadyResult()
    : undefined;
}
