import { randomUUID } from "node:crypto";
import {
  Gateway,
  resolveCodingSafeSidecarGatewayProfile,
  type GatewayConfig,
  type GatewayRequest,
  type NormalizedResponse,
  type ToolDefinition,
} from "@oscharko-dev/keiko-model-gateway";
import { currentGatewayConfig, type UiHandlerDeps } from "./deps.js";
import { readJsonObject } from "./files.js";
import { errorBody, type RouteContext, type RouteResult } from "./routes.js";

const ENABLE_TOKENS = new Set(["1", "true", "on", "yes", "enabled"]);
const CODING_SIDECAR_DISABLED_ENV = "KEIKO_CODING_SIDECAR_DISABLED";
const CODING_SIDECAR_GATEWAY_ERROR_CODE = "CODING_SIDECAR_UNAVAILABLE";

export interface CodingSidecarGatewayChatCompletionRequest {
  readonly model?: string | undefined;
  readonly messages: readonly CodingSidecarGatewayChatMessage[];
  readonly tools?: readonly ToolDefinition[] | undefined;
  readonly stream?: boolean | undefined;
  readonly temperature?: number | undefined;
  readonly top_p?: number | undefined;
}

export interface CodingSidecarGatewayChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
}

export type CodingSidecarGatewayChatFactory = (
  config: GatewayConfig,
  modelId: string,
) => (request: GatewayRequest) => Promise<NormalizedResponse>;

function envEnabled(value: string | undefined): boolean {
  return value !== undefined && ENABLE_TOKENS.has(value.trim().toLowerCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRouteResult(value: unknown): value is RouteResult {
  return isRecord(value) && typeof value.status === "number" && "body" in value;
}

function isCodingSidecarGatewayChatRole(
  value: string,
): value is CodingSidecarGatewayChatMessage["role"] {
  return value === "system" || value === "user" || value === "assistant" || value === "tool";
}

function chatFactoryFor(deps: UiHandlerDeps): CodingSidecarGatewayChatFactory {
  return deps.codingSidecarGatewayChatFactory ?? defaultChatFactory;
}

function defaultChatFactory(
  config: GatewayConfig,
  modelId: string,
): (request: GatewayRequest) => Promise<NormalizedResponse> {
  const gateway = new Gateway(config);
  return (request: GatewayRequest) => gateway.chat({ ...request, modelId });
}

function unavailableError(): RouteResult {
  return {
    status: 503,
    body: errorBody(CODING_SIDECAR_GATEWAY_ERROR_CODE, "Coding sidecar gateway is unavailable."),
  };
}

function parseMessageEntry(value: unknown): CodingSidecarGatewayChatMessage | undefined {
  if (!isRecord(value) || typeof value.role !== "string" || typeof value.content !== "string") {
    return undefined;
  }
  if (!isCodingSidecarGatewayChatRole(value.role)) {
    return undefined;
  }
  return { role: value.role, content: value.content };
}

function parseMessages(value: unknown): readonly CodingSidecarGatewayChatMessage[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const messages: CodingSidecarGatewayChatMessage[] = [];
  for (const entry of value) {
    const message = parseMessageEntry(entry);
    if (message === undefined) {
      return undefined;
    }
    messages.push(message);
  }
  return messages;
}

function badRequest(message: string): RouteResult {
  return { status: 400, body: errorBody("BAD_REQUEST", message) };
}

function isOpenAiCompatibleFunctionToolFunction(value: unknown): value is {
  readonly name: string;
  readonly description?: string | undefined;
  readonly parameters: Record<string, unknown>;
} {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    (value.description === undefined || typeof value.description === "string") &&
    isRecord(value.parameters)
  );
}

function parseTools(value: unknown): readonly ToolDefinition[] | RouteResult | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return badRequest("Request body tools must be OpenAI-compatible function tools.");
  }
  const tools: ToolDefinition[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      entry.type !== "function" ||
      !isOpenAiCompatibleFunctionToolFunction(entry.function)
    ) {
      return badRequest("Request body tools must be OpenAI-compatible function tools.");
    }
    tools.push({
      name: entry.function.name,
      description: entry.function.description ?? "",
      parameters: entry.function.parameters,
    });
  }
  return tools;
}

function isMatchingModelAlias(model: string | undefined, modelAlias: string): boolean {
  return model === undefined || model === modelAlias;
}

function buildChatRequest(
  parsed: CodingSidecarGatewayChatCompletionRequest,
  modelAlias: string,
): GatewayRequest {
  return {
    modelId: modelAlias,
    messages: parsed.messages.map((message) => ({ role: message.role, content: message.content })),
    ...(parsed.tools === undefined ? {} : { tools: parsed.tools }),
    ...(parsed.temperature === undefined ? {} : { temperature: parsed.temperature }),
    ...(parsed.top_p === undefined ? {} : { topP: parsed.top_p }),
  };
}

function parseChatRequest(
  body: Record<string, unknown>,
): CodingSidecarGatewayChatCompletionRequest | RouteResult | undefined {
  const messages = parseMessages(body.messages);
  if (messages === undefined) {
    return undefined;
  }
  const tools = parseTools(body.tools);
  if (isRouteResult(tools)) {
    return tools;
  }
  return {
    ...(typeof body.model === "string" && body.model.length > 0 ? { model: body.model } : {}),
    messages,
    ...(tools === undefined ? {} : { tools }),
    ...(typeof body.stream === "boolean" ? { stream: body.stream } : {}),
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === "number" ? { top_p: body.top_p } : {}),
  };
}

function openAiResponse(
  modelId: string,
  content: string,
  usage: NormalizedResponse["usage"],
): RouteResult {
  return {
    status: 200,
    body: {
      id: `chatcmpl-${randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
        total_tokens: usage.promptTokens + usage.completionTokens,
      },
    },
  };
}

function unsupportedStreaming(): RouteResult {
  return {
    status: 400,
    body: errorBody("STREAMING_UNSUPPORTED", "Streaming is not available on this gateway."),
  };
}

function sidecarPolicyDisabled(deps: UiHandlerDeps): boolean {
  return envEnabled(deps.env[CODING_SIDECAR_DISABLED_ENV]);
}

export function handleCodingSidecarGatewayProfile(
  _ctx: RouteContext,
  deps: UiHandlerDeps,
): RouteResult {
  const config = currentGatewayConfig(deps);
  const result = resolveCodingSafeSidecarGatewayProfile(config, {
    deploymentPolicyDisabled: sidecarPolicyDisabled(deps),
  });
  return { status: 200, body: result };
}

export async function handleCodingSidecarGatewayChatCompletions(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const config = currentGatewayConfig(deps);
  const result = resolveCodingSafeSidecarGatewayProfile(config, {
    deploymentPolicyDisabled: sidecarPolicyDisabled(deps),
  });
  if (result.status === "unavailable") {
    return unavailableError();
  }
  if (config === undefined) {
    return unavailableError();
  }
  const body = await readJsonObject(ctx.req, result.runMetadata.maxRequestBytes);
  if (isRouteResult(body)) {
    return body;
  }
  if (!isRecord(body)) {
    return badRequest("Request body must be a JSON object.");
  }
  const parsed = parseChatRequest(body);
  if (isRouteResult(parsed)) {
    return parsed;
  }
  if (parsed === undefined) {
    return badRequest("Request body must include a non-empty messages array.");
  }
  if (parsed.stream === true) {
    return unsupportedStreaming();
  }
  if (!isMatchingModelAlias(parsed.model, result.modelAlias)) {
    return {
      status: 400,
      body: errorBody("INVALID_MODEL", "Request model does not match the selected profile."),
    };
  }
  const chat = chatFactoryFor(deps)(config, result.modelAlias);
  const response = await chat(buildChatRequest(parsed, result.modelAlias));
  return openAiResponse(result.modelAlias, response.content, response.usage);
}
