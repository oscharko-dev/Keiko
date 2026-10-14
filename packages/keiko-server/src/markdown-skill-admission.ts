import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { GatewayCallRequest, GatewayStreamChunk } from "@oscharko-dev/keiko-model-gateway";
import type { MarkdownSkillStore } from "./store/markdownSkills.js";

/** Narrow every physical attempt, including Gateway transport retries, to the pinned revision. */
export function protectMarkdownSkillRequest(
  request: GatewayCallRequest,
  library: MarkdownSkillStore,
  messageId: string | undefined,
): GatewayCallRequest {
  if (messageId === undefined || library.forTurn(messageId) === undefined) return request;
  return {
    ...request,
    attemptAdmission: (input): ReturnType<NonNullable<GatewayCallRequest["attemptAdmission"]>> => {
      library.forTurn(messageId);
      return request.attemptAdmission === undefined
        ? { settle: (): void => undefined }
        : request.attemptAdmission(input);
    },
  };
}

export function withMarkdownSkillAdmission(
  model: ModelPort,
  library: MarkdownSkillStore,
  messageId: string | undefined,
): ModelPort {
  if (messageId === undefined || library.forTurn(messageId) === undefined) return model;
  const protect = (request: GatewayCallRequest): GatewayCallRequest =>
    protectMarkdownSkillRequest(request, library, messageId);
  const call: ModelPort["call"] = async (request, signal) => model.call(protect(request), signal);
  if (model.callStream === undefined) return { call };
  const stream = model.callStream.bind(model);
  return {
    call,
    callStream: async function* (request, signal): AsyncIterable<GatewayStreamChunk> {
      yield* stream(protect(request), signal);
    },
  };
}
