import { ConfigInvalidError } from "@oscharko-dev/keiko-security/errors/gateway";
import {
  CodexCliClient,
  type CodexCliClientDeps,
  type CodexCliCommandRunner,
} from "./codex-cli.js";
import type {
  GatewayRequest,
  ModelCapability,
  ModelProviderConfig,
  NormalizedResponse,
  OpenAiCodexLocalSessionProviderConfig,
  ProviderAdapter,
  ResponseFormat,
} from "./types.js";
import { isOpenAiCodexLocalSessionProviderConfig } from "./types.js";

export interface CodexLocalSessionAdapterDeps extends CodexCliClientDeps {
  readonly requestId: string;
  readonly costClass: NormalizedResponse["usage"]["costClass"];
  readonly now?: (() => number) | undefined;
}

function renderMessages(request: GatewayRequest): string {
  return request.messages
    .map((message) => {
      const header =
        message.role === "tool"
          ? `TOOL${message.toolCallId === undefined ? "" : ` ${message.toolCallId}`}`
          : message.role.toUpperCase();
      const toolCalls =
        message.toolCalls === undefined || message.toolCalls.length === 0
          ? ""
          : `\nTOOL_CALLS ${JSON.stringify(message.toolCalls)}`;
      return `[${header}]\n${message.content}${toolCalls}`;
    })
    .join("\n\n");
}

function formatResponseDirective(responseFormat: ResponseFormat | undefined): string {
  if (responseFormat === undefined || responseFormat.type === "text") {
    return "Respond with plain text only.";
  }
  return [
    "Respond with exactly one JSON object matching this schema.",
    "Do not wrap the JSON in markdown fences or explanatory prose.",
    JSON.stringify(responseFormat.schema),
  ].join("\n");
}

function buildPrompt(request: GatewayRequest): string {
  return [
    "You are answering through Keiko's local Codex session provider.",
    "Treat the transcript below as the full conversation state.",
    formatResponseDirective(request.responseFormat),
    "",
    renderMessages(request),
  ].join("\n");
}

function parseStructuredOutput(
  content: string,
  responseFormat: ResponseFormat | undefined,
): Record<string, unknown> | null {
  if (responseFormat === undefined || responseFormat.type === "text") {
    return null;
  }
  try {
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new ConfigInvalidError("codex local session did not return valid JSON for the requested schema");
  }
}

function ensureSupportedRequest(request: GatewayRequest): void {
  if (request.tools !== undefined && request.tools.length > 0) {
    throw new ConfigInvalidError(
      "codex local session does not support Gateway tool-call definitions",
    );
  }
}

export class CodexLocalSessionAdapter implements ProviderAdapter {
  readonly providerType = "openai-codex-local-session" as const;
  private readonly client: CodexCliClient;
  private readonly now: () => number;

  constructor(
    private readonly deps: CodexLocalSessionAdapterDeps,
  ) {
    this.client = new CodexCliClient(deps);
    this.now = deps.now ?? Date.now;
  }

  validateConfig(config: ModelProviderConfig): void {
    if (!isOpenAiCodexLocalSessionProviderConfig(config)) {
      throw new ConfigInvalidError(
        `provider '${config.modelId}' is not compatible with the Codex local-session adapter`,
      );
    }
  }

  async discoverModels(config: ModelProviderConfig): Promise<readonly string[]> {
    this.validateConfig(config);
    await this.client.ensureReady(config.modelId);
    const capabilities = await this.client.discoverCapabilities();
    return capabilities.map((capability) => capability.id);
  }

  async probeCapabilities(config: ModelProviderConfig): Promise<readonly ModelCapability[]> {
    this.validateConfig(config);
    await this.client.ensureReady(config.modelId);
    return this.client.discoverCapabilities();
  }

  async call(
    request: GatewayRequest,
    config: ModelProviderConfig,
  ): Promise<NormalizedResponse> {
    this.validateConfig(config);
    ensureSupportedRequest(request);
    const provider = config as OpenAiCodexLocalSessionProviderConfig;
    await this.client.ensureReady(provider.modelId, request.cancellationSignal);
    const startedAt = this.now();
    const result = await this.client.execJson(
      provider.modelId,
      buildPrompt(request),
      request.cancellationSignal,
    );
    return {
      modelId: provider.modelId,
      content: result.content,
      finishReason: "stop",
      toolCalls: [],
      structuredOutput: parseStructuredOutput(result.content, request.responseFormat),
      usage: {
        requestId: this.deps.requestId,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        latencyMs: Math.max(1, this.now() - startedAt),
        costClass: this.deps.costClass,
      },
    };
  }
}

export type { CodexCliCommandRunner };
