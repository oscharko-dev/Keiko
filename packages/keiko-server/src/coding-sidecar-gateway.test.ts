import { describe, expect, it, vi } from "vitest";
import {
  resolveCodingSafeSidecarGatewayProfile,
  type GatewayConfig,
  type GatewayRequest,
  type ModelCapability,
  type ModelProviderConfig,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import {
  validateCodingWorkbenchEvidenceRecord,
  type CodingWorkbenchEvidenceRecord,
} from "@oscharko-dev/keiko-contracts";
import { buildRedactor, type UiHandlerDeps } from "./deps.js";
import {
  handleCodingSidecarGatewayChatCompletions,
  handleCodingSidecarGatewayProfile,
} from "./coding-sidecar-gateway.js";
import { mockRequest, mockResponse } from "./_support.js";
import { createRunRegistry } from "./runs.js";
import { createInMemoryUiStore } from "./store/index.js";
import type { RouteContext } from "./routes.js";

function provider(overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig {
  return {
    modelId: "azure-coding-model",
    baseUrl: "https://provider.example/v1",
    apiKey: "provider-secret",
    apiKeyHeaderName: "api-key",
    endpointStyle: "azure-openai-deployment",
    apiVersion: "2024-06-01",
    timeoutMs: 30_000,
    maxRetries: 3,
    retryBaseDelayMs: 500,
    ...overrides,
  };
}

function capability(overrides: Partial<ModelCapability> = {}): ModelCapability {
  return {
    id: "azure-coding-model",
    kind: "chat",
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: true,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "coding-sidecar",
    preferredUseCases: ["Coding"],
    knownLimitations: [],
    ...overrides,
  };
}

function configValue(
  providerValue: ModelProviderConfig,
  capabilityValue: ModelCapability,
): GatewayConfig {
  return {
    providers: [providerValue],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    capabilities: [capabilityValue],
  };
}

function depsValue(
  config: GatewayConfig,
  chatFactory?: UiHandlerDeps["codingSidecarGatewayChatFactory"],
  env: UiHandlerDeps["env"] = {},
  evidenceStore: UiHandlerDeps["evidenceStore"] = {
    put: () => "",
    list: () => [],
    get: () => undefined,
    delete: () => undefined,
  },
  options: {
    readonly diagnostics?: UiHandlerDeps["diagnostics"];
    readonly modelSource?: UiHandlerDeps["codingSidecarGatewayModelSource"];
  } = {},
): UiHandlerDeps {
  return {
    config,
    configPresent: true,
    evidenceStore,
    env,
    redactor: buildRedactor({}),
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    ...(chatFactory === undefined ? {} : { codingSidecarGatewayChatFactory: chatFactory }),
    ...(options.modelSource === undefined
      ? {}
      : { codingSidecarGatewayModelSource: options.modelSource }),
  };
}

function routeContext(body: unknown): RouteContext {
  const rawBody = typeof body === "string" ? body : JSON.stringify(body);
  const request = mockRequest({
    method: "POST",
    url: "/api/coding-sidecar/gateway/chat/completions",
    body: rawBody,
  });
  const response = mockResponse();
  return {
    req: request,
    res: response.res,
    params: {},
    url: new URL("http://127.0.0.1/api/coding-sidecar/gateway/chat/completions"),
  };
}

function assistantResponse(modelId: string): NormalizedResponse {
  return {
    modelId,
    content: "assistant-content",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "req-1",
      promptTokens: 12,
      completionTokens: 8,
      latencyMs: 1,
      costClass: "medium",
    },
  };
}

function parseEvidenceRecord(value: string): CodingWorkbenchEvidenceRecord {
  const parsed = validateCodingWorkbenchEvidenceRecord(JSON.parse(value));
  if (!parsed.ok) {
    throw new Error(parsed.errors.join("; "));
  }
  return parsed.value;
}

describe("coding-sidecar gateway", () => {
  it("projects an available coding-capable model without provider endpoint or credential details", () => {
    const result = resolveCodingSafeSidecarGatewayProfile(configValue(provider(), capability()));

    expect(result).toMatchObject({
      status: "available",
      profileId: "coding-safe-openai-compatible",
      modelAlias: "azure-coding-model",
      localEndpointPath: "/api/coding-sidecar/gateway",
      supportsStreaming: false,
      supportsToolCalling: true,
    });
    expect(JSON.stringify(result)).not.toContain("baseUrl");
    expect(JSON.stringify(result)).not.toContain("apiKey");
    expect(JSON.stringify(result)).not.toContain("api-key");
  });

  it("surfaces the same content-free projection through the profile route", () => {
    const context = {
      req: mockRequest({ method: "GET", url: "/api/coding-sidecar/gateway/profile" }),
      res: mockResponse().res,
      params: {},
      url: new URL("http://127.0.0.1/api/coding-sidecar/gateway/profile"),
    } satisfies RouteContext;
    const deps = depsValue(configValue(provider(), capability()));
    const result = handleCodingSidecarGatewayProfile(context, deps);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      status: "available",
      profileId: "coding-safe-openai-compatible",
      modelAlias: "azure-coding-model",
    });
    expect(JSON.stringify(result.body)).not.toContain("baseUrl");
    expect(JSON.stringify(result.body)).not.toContain("apiKey");
  });

  it("fails closed through the profile route when the injected model source is subscription-backed", () => {
    const context = {
      req: mockRequest({ method: "GET", url: "/api/coding-sidecar/gateway/profile" }),
      res: mockResponse().res,
      params: {},
      url: new URL("http://127.0.0.1/api/coding-sidecar/gateway/profile"),
    } satisfies RouteContext;
    const result = handleCodingSidecarGatewayProfile(
      context,
      depsValue(
        configValue(provider(), capability()),
        undefined,
        {},
        {
          put: () => "",
          list: () => [],
          get: () => undefined,
          delete: () => undefined,
        },
        { modelSource: "chatgpt-codex-subscription-profile" },
      ),
    );

    expect(result).toEqual({
      status: 200,
      body: {
        status: "unavailable",
        reason: "subscription-source",
      },
    });
  });

  it.each([
    {
      label: "Azure",
      config: configValue(
        provider({ endpointStyle: "azure-openai-deployment", apiKeyHeaderName: "api-key" }),
        capability(),
      ),
    },
    {
      label: "LiteLLM",
      config: configValue(
        provider({
          modelId: "litellm-coding-model",
          baseUrl: "https://litellm.example/v1",
          apiKey: "litellm-secret",
          apiKeyHeaderName: "x-litellm-key",
          endpointStyle: "openai-compatible",
        }),
        capability({ id: "litellm-coding-model" }),
      ),
    },
    {
      label: "CodeCoda",
      config: configValue(
        provider({
          modelId: "codecoda-coding-model",
          baseUrl: "https://codecoda.example/v1",
          apiKey: "codecoda-secret",
          apiKeyHeaderName: "x-api-key",
        }),
        capability({ id: "codecoda-coding-model" }),
      ),
    },
  ])("selects $label-style provider config and keeps the projection content-free", ({ config }) => {
    const result = resolveCodingSafeSidecarGatewayProfile(config);

    expect(result.status).toBe("available");
    expect(JSON.stringify(result)).not.toContain("https://");
    expect(JSON.stringify(result)).not.toContain("api-key");
    expect(JSON.stringify(result)).not.toContain("x-litellm-key");
    expect(JSON.stringify(result)).not.toContain("x-api-key");
  });

  it.each([
    {
      label: "non-chat",
      config: configValue(
        provider({ modelId: "text-model" }),
        capability({ id: "text-model", kind: "embedding" }),
      ),
      reason: "non-chat",
    },
    {
      label: "no tool calling",
      config: configValue(
        provider({ modelId: "no-tools" }),
        capability({ id: "no-tools", toolCalling: false }),
      ),
      reason: "no-tool-calling",
    },
    {
      label: "workflow disabled",
      config: configValue(
        provider({ modelId: "no-workflow" }),
        capability({ id: "no-workflow", workflowEligible: false }),
      ),
      reason: "non-workflow-eligible",
    },
    {
      label: "missing credential",
      config: configValue(
        provider({ modelId: "missing-credential", baseUrl: " ", apiKey: "" }),
        capability({ id: "missing-credential" }),
      ),
      reason: "missing-credentials",
    },
  ])("fails closed for $label", ({ config, reason }) => {
    expect(resolveCodingSafeSidecarGatewayProfile(config)).toEqual({
      status: "unavailable",
      reason,
    });
  });

  it("returns non-coding-capable when the selected model is chat, tool-calling, and workflow-eligible but lacks a coding use case", () => {
    const config = configValue(
      provider({ modelId: "chat-only-sidecar" }),
      capability({ id: "chat-only-sidecar", preferredUseCases: ["Chat"] }),
    );

    expect(resolveCodingSafeSidecarGatewayProfile(config)).toEqual({
      status: "unavailable",
      reason: "non-coding-capable",
    });
  });

  it("fails closed for deployment policy and subscription source", () => {
    expect(
      resolveCodingSafeSidecarGatewayProfile(configValue(provider(), capability()), {
        deploymentPolicyDisabled: true,
      }),
    ).toEqual({ status: "unavailable", reason: "deployment-policy-disabled" });
    expect(
      resolveCodingSafeSidecarGatewayProfile(configValue(provider(), capability()), {
        modelSource: "chatgpt-codex-subscription-profile",
      }),
    ).toEqual({ status: "unavailable", reason: "subscription-source" });
  });

  it("routes chat completions through the fake seam without provider endpoint or credential data in the request", async () => {
    const seenRequests: GatewayRequest[] = [];
    const deps = depsValue(
      configValue(provider(), capability()),
      (
        _config: GatewayConfig,
        modelId: string,
      ): ((request: GatewayRequest) => Promise<NormalizedResponse>) => {
        return (request: GatewayRequest): Promise<NormalizedResponse> => {
          seenRequests.push(request);
          return Promise.resolve(assistantResponse(modelId));
        };
      },
    );
    const context = routeContext({
      model: "azure-coding-model",
      messages: [{ role: "user", content: "continue" }],
      tools: [],
      temperature: 0.2,
      top_p: 0.9,
    });

    const result = await handleCodingSidecarGatewayChatCompletions(context, deps);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      model: "azure-coding-model",
      choices: [{ message: { role: "assistant", content: "assistant-content" } }],
    });
    expect(seenRequests).toHaveLength(1);
    expect(JSON.stringify(seenRequests[0])).not.toContain("baseUrl");
    expect(JSON.stringify(seenRequests[0])).not.toContain("apiKey");
    expect(JSON.stringify(seenRequests[0])).not.toContain("api-key");
    expect(JSON.stringify(result.body)).not.toContain("provider-secret");
  });

  it("returns BAD_REQUEST for malformed OpenAI-compatible tools", async () => {
    const deps = depsValue(configValue(provider(), capability()));
    const result = await handleCodingSidecarGatewayChatCompletions(
      routeContext({
        model: "azure-coding-model",
        messages: [{ role: "user", content: "continue" }],
        tools: [{ type: "function", function: { name: "search", parameters: [] } }],
      }),
      deps,
    );

    expect(result).toEqual({
      status: 400,
      body: {
        error: {
          code: "BAD_REQUEST",
          message: "Request body tools must be OpenAI-compatible function tools.",
        },
      },
    });
  });

  it("projects a valid OpenAI-compatible tool into the gateway request shape", async () => {
    const seenRequests: GatewayRequest[] = [];
    const deps = depsValue(
      configValue(provider(), capability()),
      (
        _config: GatewayConfig,
        modelId: string,
      ): ((request: GatewayRequest) => Promise<NormalizedResponse>) => {
        return (request: GatewayRequest): Promise<NormalizedResponse> => {
          seenRequests.push(request);
          return Promise.resolve(assistantResponse(modelId));
        };
      },
    );

    const result = await handleCodingSidecarGatewayChatCompletions(
      routeContext({
        model: "azure-coding-model",
        messages: [{ role: "user", content: "continue" }],
        tools: [
          {
            type: "function",
            function: {
              name: "search",
              description: "Look up files",
              parameters: {
                type: "object",
                properties: {
                  query: { type: "string" },
                },
                required: ["query"],
              },
            },
          },
        ],
      }),
      deps,
    );

    expect(result.status).toBe(200);
    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]?.tools).toEqual([
      {
        name: "search",
        description: "Look up files",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
      },
    ]);
  });

  it("returns BAD_REQUEST for invalid JSON bodies via readJsonObject", async () => {
    const deps = depsValue(configValue(provider(), capability()));
    const result = await handleCodingSidecarGatewayChatCompletions(routeContext("{"), deps);

    expect(result).toEqual({
      status: 400,
      body: {
        error: {
          code: "BAD_REQUEST",
          message: "Request body is not valid JSON.",
        },
      },
    });
  });

  it("returns BAD_REQUEST for invalid temperature before calling the gateway", async () => {
    const seenRequests: GatewayRequest[] = [];
    const deps = depsValue(
      configValue(provider(), capability()),
      (
        _config: GatewayConfig,
        modelId: string,
      ): ((request: GatewayRequest) => Promise<NormalizedResponse>) => {
        return (request: GatewayRequest): Promise<NormalizedResponse> => {
          seenRequests.push(request);
          return Promise.resolve(assistantResponse(modelId));
        };
      },
    );

    const result = await handleCodingSidecarGatewayChatCompletions(
      routeContext({
        messages: [{ role: "user", content: "continue" }],
        temperature: 2.1,
      }),
      deps,
    );

    expect(result).toEqual({
      status: 400,
      body: {
        error: {
          code: "BAD_REQUEST",
          message: "Request body temperature must be a finite number between 0 and 2.",
        },
      },
    });
    expect(seenRequests).toHaveLength(0);
  });

  it("returns BAD_REQUEST for invalid top_p before calling the gateway", async () => {
    const seenRequests: GatewayRequest[] = [];
    const deps = depsValue(
      configValue(provider(), capability()),
      (
        _config: GatewayConfig,
        modelId: string,
      ): ((request: GatewayRequest) => Promise<NormalizedResponse>) => {
        return (request: GatewayRequest): Promise<NormalizedResponse> => {
          seenRequests.push(request);
          return Promise.resolve(assistantResponse(modelId));
        };
      },
    );

    const result = await handleCodingSidecarGatewayChatCompletions(
      routeContext({
        messages: [{ role: "user", content: "continue" }],
        top_p: 1.1,
      }),
      deps,
    );

    expect(result).toEqual({
      status: 400,
      body: {
        error: {
          code: "BAD_REQUEST",
          message: "Request body top_p must be a finite number between 0 and 1.",
        },
      },
    });
    expect(seenRequests).toHaveLength(0);
  });

  it("writes content-free accepted routing evidence after a successful chat completion", async () => {
    const put = vi.fn(() => "");
    const deps = depsValue(
      configValue(provider(), capability()),
      (
        _config: GatewayConfig,
        modelId: string,
      ): ((request: GatewayRequest) => Promise<NormalizedResponse>) => {
        return (request: GatewayRequest): Promise<NormalizedResponse> => {
          void request;
          return Promise.resolve(assistantResponse(modelId));
        };
      },
      {},
      {
        put,
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
    );

    const result = await handleCodingSidecarGatewayChatCompletions(
      routeContext({
        model: "azure-coding-model",
        messages: [{ role: "user", content: "continue" }],
      }),
      deps,
    );

    expect(result.status).toBe(200);
    expect(put).toHaveBeenCalledTimes(1);
    const evidenceJson = put.mock.calls[0]?.[1];
    expect(typeof evidenceJson).toBe("string");
    const record = parseEvidenceRecord(String(evidenceJson));
    expect(record).toMatchObject({
      kind: "run",
      effectiveMode: "governed-assist",
      runtimeSource: "keiko-sidecar",
      modelSource: "keiko-model-gateway",
      safeSummary: "sidecar-gateway-ready",
    });
    expect(record.denied).toBeUndefined();
    expect(String(evidenceJson)).not.toContain("continue");
    expect(String(evidenceJson)).not.toContain("assistant-content");
    expect(String(evidenceJson)).not.toContain("provider-secret");
    expect(String(evidenceJson)).not.toContain("api-key");
    expect(String(evidenceJson)).not.toContain("https://provider.example/v1");
  });

  it("returns a content-free unavailable error when deployment policy disables the gateway", async () => {
    const deps = depsValue(configValue(provider(), capability()), undefined, {
      KEIKO_CODING_SIDECAR_DISABLED: "1",
    });
    const context = routeContext({
      messages: [{ role: "user", content: "continue" }],
    });

    const result = await handleCodingSidecarGatewayChatCompletions(context, deps);

    expect(result).toEqual({
      status: 503,
      body: {
        error: {
          code: "CODING_SIDECAR_UNAVAILABLE",
          message: "Coding sidecar gateway is unavailable.",
        },
      },
    });
  });

  it("returns a content-free unavailable error for the injected subscription-backed model source", async () => {
    const put = vi.fn(() => "");
    const deps = depsValue(
      configValue(provider(), capability()),
      undefined,
      {},
      {
        put,
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
      { modelSource: "chatgpt-codex-subscription-profile" },
    );

    const result = await handleCodingSidecarGatewayChatCompletions(
      routeContext({
        messages: [{ role: "user", content: "continue" }],
      }),
      deps,
    );

    expect(result).toEqual({
      status: 503,
      body: {
        error: {
          code: "CODING_SIDECAR_UNAVAILABLE",
          message: "Coding sidecar gateway is unavailable.",
        },
      },
    });
    expect(put).toHaveBeenCalledTimes(1);
    const record = parseEvidenceRecord(String(put.mock.calls[0]?.[1]));
    expect(record).toMatchObject({
      kind: "failure",
      modelSource: "chatgpt-codex-subscription-profile",
      safeSummary: "sidecar-gateway-denied",
      denied: true,
    });
  });

  it("writes failed routing evidence and emits a diagnostic when the gateway call throws", async () => {
    const put = vi.fn(() => "");
    const diagnostics = { record: vi.fn() };
    const deps = depsValue(
      configValue(provider(), capability()),
      (): ((request: GatewayRequest) => Promise<NormalizedResponse>) => {
        return (request: GatewayRequest): Promise<NormalizedResponse> => {
          void request;
          return Promise.reject(new Error("gateway-failure"));
        };
      },
      {},
      {
        put,
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
      { diagnostics },
    );

    await expect(
      handleCodingSidecarGatewayChatCompletions(
        routeContext({
          messages: [{ role: "user", content: "continue" }],
        }),
        deps,
      ),
    ).rejects.toThrow("gateway-failure");
    expect(put).toHaveBeenCalledTimes(1);
    const evidenceJson = String(put.mock.calls[0]?.[1]);
    const record = parseEvidenceRecord(evidenceJson);
    expect(record).toMatchObject({
      kind: "failure",
      modelSource: "keiko-model-gateway",
      safeSummary: "sidecar-gateway-failed",
      denied: true,
    });
    expect(evidenceJson).not.toContain("continue");
    expect(evidenceJson).not.toContain("gateway-failure");
    expect(diagnostics.record).toHaveBeenCalledTimes(1);
  });
});
