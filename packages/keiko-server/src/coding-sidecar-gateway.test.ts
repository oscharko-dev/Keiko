import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { buildRedactor, buildUiHandlerDeps, type UiHandlerDeps } from "./deps.js";
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";
import {
  createOpenCodeGatewayReadinessRegistry,
  handleCodingSidecarGatewayChatCompletions,
  handleCodingSidecarGatewayProfile,
} from "./coding-sidecar-gateway.js";
import { mockRequest, mockResponse } from "./_support.js";
import { createRunRegistry } from "./runs.js";
import { createInMemoryUiStore } from "./store/index.js";
import { STREAMING, type RouteContext, type RouteResult } from "./routes.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

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
    readonly codingWorkbenchEvidenceStore?: UiHandlerDeps["codingWorkbenchEvidenceStore"];
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
    ...(options.codingWorkbenchEvidenceStore === undefined
      ? {}
      : { codingWorkbenchEvidenceStore: options.codingWorkbenchEvidenceStore }),
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

function runtimeGatewayDeps(
  authenticate: (capability: string, audience: "model-gateway" | "tool-facade") => unknown,
  chatFactory?: UiHandlerDeps["codingSidecarGatewayChatFactory"],
  readiness = createOpenCodeGatewayReadinessRegistry(),
): UiHandlerDeps {
  return {
    ...depsValue(configValue(provider(), capability()), chatFactory),
    runtimeCapabilityAuthenticator: { authenticate },
    openCodeGatewayReadinessRegistry: readiness,
  } as unknown as UiHandlerDeps;
}

function authenticatedContext(body: unknown, origin?: string): RouteContext {
  const rawBody = typeof body === "string" ? body : JSON.stringify(body);
  const response = mockResponse({ captureBody: true });
  return {
    req: mockRequest({
      method: "POST",
      url: "/api/coding-sidecar/gateway/chat/completions",
      body: rawBody,
      headers: {
        authorization: "Bearer gateway-capability-material-0000000001",
        ...(origin === undefined ? {} : { origin }),
      },
    }),
    res: response.res,
    params: {},
    url: new URL("http://127.0.0.1/api/coding-sidecar/gateway/chat/completions"),
  };
}

const QUESTION_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  properties: {
    questions: {
      description: "Questions to ask",
      items: {
        properties: {
          header: { description: "Very short label (max 30 chars)", type: "string" },
          multiple: { description: "Allow selecting multiple choices", type: "boolean" },
          options: {
            description: "Available choices",
            items: {
              properties: {
                description: { description: "Explanation of choice", type: "string" },
                label: { description: "Display text (1-5 words, concise)", type: "string" },
              },
              required: ["label", "description"],
              type: "object",
            },
            type: "array",
          },
          question: { description: "Complete question", type: "string" },
        },
        required: ["question", "header", "options"],
        type: "object",
      },
      type: "array",
    },
  },
  required: ["questions"],
  type: "object",
} as const;

const WORKSPACE_READ_SCHEMA = {
  type: "object",
  properties: {
    relativePath: {
      type: "string",
      minLength: 1,
      maxLength: 512,
      pattern: "^(?![\\\\/])(?!.*(?:^|/)\\.\\.?(/|$))(?!.*\\\\).+$",
    },
  },
  required: ["relativePath"],
} as const;

const CHANGESET_EDIT_SCHEMA = {
  type: "object",
  properties: {
    changeset: {
      type: "object",
      additionalProperties: false,
      properties: {
        patch: { type: "string", maxLength: 262_144 },
        files: { type: "array", maxItems: 256 },
        selectedFiles: { type: "array", maxItems: 256 },
        prepared: { type: "object" },
      },
    },
  },
  required: ["changeset"],
} as const;

const PINNED_MODEL_VISIBLE_TOOLS = [
  { name: "question", parameters: QUESTION_SCHEMA },
  { name: "keiko_workspace_read", parameters: WORKSPACE_READ_SCHEMA },
  { name: "keiko_changeset_edit", parameters: CHANGESET_EDIT_SCHEMA },
] as const;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function schemaDigest(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

interface ModelVisibleRequestTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly parameters: unknown;
  };
}

function modelVisibleTools(
  tools: readonly {
    readonly name: string;
    readonly parameters: unknown;
  }[] = PINNED_MODEL_VISIBLE_TOOLS,
): ModelVisibleRequestTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, parameters: tool.parameters },
  }));
}

function assertRouteResult(result: RouteResult | typeof STREAMING): asserts result is RouteResult {
  expect(result).not.toBe(STREAMING);
  if (result === STREAMING) throw new Error("Expected a buffered route result.");
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
  it("fails closed when a runtime gateway route has no capability authenticator", async () => {
    const chat = vi.fn(() => Promise.resolve(assistantResponse("azure-coding-model")));
    const result = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "azure-coding-model",
        messages: [{ role: "user", content: "continue" }],
        tools: [],
      }),
      depsValue(configValue(provider(), capability()), () => chat),
    );

    expect(result).toMatchObject({ status: 401 });
    expect(chat).not.toHaveBeenCalled();
  });

  it("authenticates the model-gateway audience before parsing a body and rejects Origin", async () => {
    const authenticate = vi.fn(() => ({ ok: false, reason: "invalid" }));
    const malformed = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext("{"),
      runtimeGatewayDeps(authenticate),
    );
    expect(authenticate).toHaveBeenCalledWith(
      "gateway-capability-material-0000000001",
      "model-gateway",
    );
    expect(malformed).toMatchObject({ status: 401 });

    const browser = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({ messages: [{ role: "user", content: "hello" }] }, "http://evil.test"),
      runtimeGatewayDeps(() => ({ ok: true, binding: { runId: "run-1" } })),
    );
    expect(browser).toMatchObject({ status: 403 });
  });

  it("accepts exactly the pinned OpenCode v1.17.17 visible schemas by canonical digest", async () => {
    expect(
      PINNED_MODEL_VISIBLE_TOOLS.map((tool) => [tool.name, schemaDigest(tool.parameters)]),
    ).toEqual([
      ["question", "4f618d23c27d7147ab8564c3ec1050c508762a19b9a4858951a9cd3089b52df3"],
      ["keiko_workspace_read", "a5d6f6b96c5e0c5906ce1c9bad5b7f13fc4763b762f4aa5d019d6fc2d194ada3"],
      ["keiko_changeset_edit", "720fa492da7b2ff3cb0f6c3c19e1cf68d714d850207d1c614c37c8b6499c0089"],
    ]);
    const chat = vi.fn((_request: GatewayRequest) =>
      Promise.resolve(assistantResponse("azure-coding-model")),
    );
    const result = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        messages: [{ role: "user", content: "ask and read" }],
        tools: modelVisibleTools(),
      }),
      runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-1" } }),
        () => chat,
      ),
    );

    expect(result).toMatchObject({ status: 200 });
    expect(chat).toHaveBeenCalledOnce();
    expect(chat.mock.calls[0]?.[0]).toMatchObject({ modelId: "azure-coding-model" });
  });

  it("denies selected-upstream and arbitrary model ids on the authenticated runtime lane", async () => {
    const chat = vi.fn(() => Promise.resolve(assistantResponse("azure-coding-model")));
    for (const model of [undefined, "azure-coding-model", "other-profile-model"]) {
      const result = await handleCodingSidecarGatewayChatCompletions(
        authenticatedContext({
          model,
          messages: [{ role: "user", content: "continue" }],
          tools: modelVisibleTools(),
        }),
        runtimeGatewayDeps(
          () => ({ ok: true, binding: { runId: "run-1" } }),
          () => chat,
        ),
      );
      expect(result).toMatchObject({
        status: 400,
        body: { error: { code: "INVALID_MODEL" } },
      });
    }
    expect(chat).not.toHaveBeenCalled();
  });

  it("observes readiness only after authenticated exact tool-contract validation", async () => {
    const readiness = createOpenCodeGatewayReadinessRegistry();
    const signal = new AbortController().signal;
    const chat = vi.fn(() => Promise.resolve(assistantResponse("azure-coding-model")));
    const observed = readiness.waitForObservedRequest("run-1", signal);
    const exact = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        messages: [{ role: "user", content: "readiness" }],
        tools: modelVisibleTools(),
      }),
      runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-1" } }),
        () => chat,
        readiness,
      ),
    );
    expect(exact).toMatchObject({ status: 200 });
    await expect(observed).resolves.toBe(true);
    expect(chat).not.toHaveBeenCalled();

    const duplicate = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        messages: [{ role: "user", content: "normal turn" }],
        tools: modelVisibleTools(),
      }),
      runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-1" } }),
        () => chat,
        readiness,
      ),
    );
    expect(duplicate).toMatchObject({ status: 200 });
    expect(chat).toHaveBeenCalledOnce();

    const driftAbort = new AbortController();
    let driftSettled = false;
    const driftPending = readiness
      .waitForObservedRequest("run-2", driftAbort.signal)
      .finally(() => {
        driftSettled = true;
      });
    const drifted = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        messages: [{ role: "user", content: "readiness" }],
        tools: modelVisibleTools().slice(0, 2),
      }),
      runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-2" } }),
        () => chat,
        readiness,
      ),
    );
    expect(drifted).toMatchObject({ status: 403 });
    await Promise.resolve();
    expect(driftSettled).toBe(false);
    driftAbort.abort();
    await expect(driftPending).resolves.toBe(false);
    const afterAbortedReadiness = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        messages: [{ role: "user", content: "normal after aborted readiness" }],
        tools: modelVisibleTools(),
      }),
      runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-2" } }),
        () => chat,
        readiness,
      ),
    );
    expect(afterAbortedReadiness).toMatchObject({ status: 200 });
    expect(chat).toHaveBeenCalledTimes(2);

    const crossAbort = new AbortController();
    let crossSettled = false;
    const crossPending = readiness
      .waitForObservedRequest("run-a", crossAbort.signal)
      .finally(() => {
        crossSettled = true;
      });
    const crossRun = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        messages: [{ role: "user", content: "normal cross-run turn" }],
        tools: modelVisibleTools(),
      }),
      runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-b" } }),
        () => chat,
        readiness,
      ),
    );
    expect(crossRun).toMatchObject({ status: 200 });
    expect(chat).toHaveBeenCalledTimes(3);
    await Promise.resolve();
    expect(crossSettled).toBe(false);
    crossAbort.abort();
    await expect(crossPending).resolves.toBe(false);
  });

  it("canonicalizes key order but denies empty, drifted, unknown, and productive built-in tools", async () => {
    const chat = vi.fn(() => Promise.resolve(assistantResponse("azure-coding-model")));
    const acceptedWithReorderedKeys = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        messages: [{ role: "user", content: "continue" }],
        tools: modelVisibleTools([
          { name: "question", parameters: { ...QUESTION_SCHEMA, required: ["questions"] } },
          {
            name: "keiko_workspace_read",
            parameters: {
              required: ["relativePath"],
              properties: { ...WORKSPACE_READ_SCHEMA.properties },
              type: "object",
            },
          },
          {
            name: "keiko_changeset_edit",
            parameters: {
              required: ["changeset"],
              properties: { ...CHANGESET_EDIT_SCHEMA.properties },
              type: "object",
            },
          },
        ]),
      }),
      runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-1" } }),
        () => chat,
      ),
    );
    expect(acceptedWithReorderedKeys).toMatchObject({ status: 200 });

    for (const tools of [
      modelVisibleTools().map((tool) => ({
        ...tool,
        function: { ...tool.function, parameters: {} },
      })),
      modelVisibleTools([
        ...PINNED_MODEL_VISIBLE_TOOLS.slice(0, 1),
        {
          name: "keiko_workspace_read",
          parameters: {
            ...WORKSPACE_READ_SCHEMA,
            properties: { relativePath: { type: "string", minLength: 1 } },
          },
        },
        PINNED_MODEL_VISIBLE_TOOLS[2],
      ]),
      modelVisibleTools([
        ...PINNED_MODEL_VISIBLE_TOOLS,
        { name: "unknown_tool", parameters: QUESTION_SCHEMA },
      ]),
      modelVisibleTools([
        ...PINNED_MODEL_VISIBLE_TOOLS,
        { name: "bash", parameters: QUESTION_SCHEMA },
      ]),
    ]) {
      const denied = await handleCodingSidecarGatewayChatCompletions(
        authenticatedContext({
          model: "coding",
          messages: [{ role: "user", content: "continue" }],
          tools,
        }),
        runtimeGatewayDeps(
          () => ({ ok: true, binding: { runId: "run-1" } }),
          () => chat,
        ),
      );
      expect(denied).toMatchObject({ status: 403 });
    }
    expect(chat).toHaveBeenCalledOnce();
  });

  it("preserves assistant tool_calls and tool_call_id on continuation turns", async () => {
    const seen: GatewayRequest[] = [];
    const result = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        messages: [
          { role: "user", content: "read it" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "keiko_workspace_read",
                  arguments: '{"relativePath":"src/a.ts"}',
                },
              },
            ],
          },
          { role: "tool", content: "result", tool_call_id: "call-1" },
        ],
        tools: modelVisibleTools(),
      }),
      runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-1" } }),
        (): ((request: GatewayRequest) => Promise<NormalizedResponse>) =>
          (request: GatewayRequest): Promise<NormalizedResponse> => {
            seen.push(request);
            return Promise.resolve(assistantResponse("azure-coding-model"));
          },
      ),
    );

    expect(result).toMatchObject({ status: 200 });
    expect(seen[0]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          toolCalls: [expect.objectContaining({ id: "call-1" })],
        }),
        expect.objectContaining({ role: "tool", toolCallId: "call-1" }),
      ]),
    );
  });

  it("emits the pinned role, text, terminal, and done frame order for final text", async () => {
    const response = mockResponse({ captureBody: true });
    const context: RouteContext = {
      ...authenticatedContext({
        model: "coding",
        stream: true,
        messages: [
          { role: "user", content: "finish" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-edit",
                type: "function",
                function: {
                  name: "keiko_changeset_edit",
                  arguments: '{"changeset":{"patch":"bounded"}}',
                },
              },
            ],
          },
          { role: "tool", content: "completed", tool_call_id: "call-edit" },
        ],
        tools: modelVisibleTools(),
      }),
      res: response.res,
    };
    const result = await handleCodingSidecarGatewayChatCompletions(
      context,
      runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-1" } }),
        (): (() => Promise<NormalizedResponse>) => (): Promise<NormalizedResponse> =>
          Promise.resolve({ ...assistantResponse("azure-coding-model"), content: "Completed." }),
      ),
    );

    expect(result).toBe(STREAMING);
    expect(response.res.writableEnded).toBe(true);
    const frames = response
      .body()
      .trim()
      .split("\n\n")
      .map((frame) => frame.slice("data: ".length));
    expect(frames).toHaveLength(5);
    expect(JSON.parse(frames[0] ?? "null")).toMatchObject({
      choices: [{ delta: { role: "assistant" }, finish_reason: null }],
    });
    expect(JSON.parse(frames[1] ?? "null")).toMatchObject({
      choices: [{ delta: { content: "Completed." }, finish_reason: null }],
    });
    expect(JSON.parse(frames[2] ?? "null")).toMatchObject({
      choices: [{ delta: {}, finish_reason: "stop" }],
    });
    expect(JSON.parse(frames[3] ?? "null")).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    });
    expect(frames[4]).toBe("[DONE]");
  });

  it("synthesizes OpenAI SSE from a buffered tool-call response", async () => {
    const response = mockResponse({ captureBody: true });
    const context: RouteContext = {
      ...authenticatedContext({
        model: "coding",
        stream: true,
        messages: [{ role: "user", content: "read" }],
        tools: modelVisibleTools(),
      }),
      res: response.res,
    };
    const normalized: NormalizedResponse = {
      ...assistantResponse("azure-coding-model"),
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        { id: "call-1", name: "keiko_workspace_read", arguments: { relativePath: "src/a.ts" } },
      ],
    };

    const result = await handleCodingSidecarGatewayChatCompletions(
      context,
      runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-1" } }),
        (): (() => Promise<NormalizedResponse>) => (): Promise<NormalizedResponse> =>
          Promise.resolve(normalized),
      ),
    );

    expect(result).toBe(STREAMING);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.body()).toContain('"tool_calls"');
    expect(response.body()).toContain('"finish_reason":"tool_calls"');
    expect(response.body()).toContain("data: [DONE]");
  });
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
    const put = vi.fn((_runId: string, _json: string): string => "");
    const context = {
      req: mockRequest({ method: "GET", url: "/api/coding-sidecar/gateway/profile" }),
      res: mockResponse().res,
      params: {},
      url: new URL("http://127.0.0.1/api/coding-sidecar/gateway/profile"),
    } satisfies RouteContext;
    const deps = depsValue(configValue(provider(), capability()), undefined, {}, undefined, {
      codingWorkbenchEvidenceStore: {
        put,
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
    });
    const result = handleCodingSidecarGatewayProfile(context, deps);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      status: "available",
      profileId: "coding-safe-openai-compatible",
      modelAlias: "azure-coding-model",
    });
    expect(JSON.stringify(result.body)).not.toContain("baseUrl");
    expect(JSON.stringify(result.body)).not.toContain("apiKey");
    expect(put).not.toHaveBeenCalled();
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

    assertRouteResult(result);
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

    assertRouteResult(result);
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

  it("returns BAD_REQUEST when messages exceed the advertised maxInputMessages", async () => {
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
        messages: Array.from({ length: 65 }, (_, index) => ({
          role: "user",
          content: `message-${String(index)}`,
        })),
      }),
      deps,
    );

    expect(result).toEqual({
      status: 400,
      body: {
        error: {
          code: "BAD_REQUEST",
          message: "Request body messages exceed profile maxInputMessages (64).",
        },
      },
    });
    expect(seenRequests).toHaveLength(0);
  });

  it("returns BAD_REQUEST when estimated prompt tokens exceed the advertised maxPromptTokens", async () => {
    const seenRequests: GatewayRequest[] = [];
    const deps = depsValue(
      configValue(provider(), capability({ contextWindow: 16 })),
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
        messages: [{ role: "user", content: "x".repeat(400) }],
      }),
      deps,
    );

    expect(result).toEqual({
      status: 400,
      body: {
        error: {
          code: "BAD_REQUEST",
          message: "Request body estimated prompt tokens exceed profile maxPromptTokens (16).",
        },
      },
    });
    expect(seenRequests).toHaveLength(0);
  });

  it("writes content-free accepted routing evidence after a successful chat completion", async () => {
    const rootPut = vi.fn((_runId: string, _json: string): string => "");
    const codingPut = vi.fn((_runId: string, _json: string): string => "");
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
        put: rootPut,
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
      {
        codingWorkbenchEvidenceStore: {
          put: codingPut,
          list: () => [],
          get: () => undefined,
          delete: () => undefined,
        },
      },
    );

    const result = await handleCodingSidecarGatewayChatCompletions(
      routeContext({
        model: "azure-coding-model",
        messages: [{ role: "user", content: "continue" }],
      }),
      deps,
    );

    assertRouteResult(result);
    expect(result.status).toBe(200);
    expect(rootPut).not.toHaveBeenCalled();
    expect(codingPut).toHaveBeenCalledTimes(1);
    const evidenceJson = codingPut.mock.calls[0]?.[1];
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

  it("emits a content-free routing diagnostic instead of writing to the root evidence store when no dedicated coding store is configured", async () => {
    const rootPut = vi.fn((_runId: string, _json: string): string => "");
    const diagnostics = { record: vi.fn<(record: ServerDiagnosticRecord) => void>() };
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
        put: rootPut,
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
      { diagnostics },
    );

    const result = await handleCodingSidecarGatewayChatCompletions(
      routeContext({
        model: "azure-coding-model",
        messages: [{ role: "user", content: "continue" }],
      }),
      deps,
    );

    assertRouteResult(result);
    expect(result.status).toBe(200);
    expect(rootPut).not.toHaveBeenCalled();
    expect(diagnostics.record).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "coding-sidecar-gateway.routing",
        errorClass: "RoutingDecision",
        message: "sidecar-gateway-ready:keiko-model-gateway",
      }),
    );
  });

  it("uses the default production coding-workbench evidence store instead of the root evidence store", async () => {
    const evidenceDir = tempDir("keiko-sidecar-evidence-");
    const configPath = join(evidenceDir, "keiko.config.json");
    writeFileSync(configPath, JSON.stringify(configValue(provider(), capability())), "utf8");
    const built = buildUiHandlerDeps({
      configPath,
      evidenceDir,
      env: {},
      store: createInMemoryUiStore(),
    });
    const deps: UiHandlerDeps = {
      ...built,
      codingSidecarGatewayChatFactory:
        (_config: GatewayConfig, modelId: string) =>
        (_request: GatewayRequest): Promise<NormalizedResponse> =>
          Promise.resolve(assistantResponse(modelId)),
    };
    const rootEntriesBefore = deps.evidenceStore.list();
    const codingEntriesBefore = deps.codingWorkbenchEvidenceStore?.list() ?? [];

    const result = await handleCodingSidecarGatewayChatCompletions(
      routeContext({
        model: "azure-coding-model",
        messages: [{ role: "user", content: "continue" }],
      }),
      deps,
    );

    assertRouteResult(result);
    expect(result.status).toBe(200);
    expect(deps.evidenceStore.list()).toEqual(rootEntriesBefore);
    expect(deps.codingWorkbenchEvidenceStore).toBeDefined();
    expect(deps.codingWorkbenchEvidenceStore?.list()).toHaveLength(codingEntriesBefore.length + 1);
    const runId = deps.codingWorkbenchEvidenceStore?.list().at(-1);
    expect(runId).toBeDefined();
    const record = parseEvidenceRecord(
      String(deps.codingWorkbenchEvidenceStore?.get(String(runId))),
    );
    expect(record).toMatchObject({
      kind: "run",
      modelSource: "keiko-model-gateway",
      safeSummary: "sidecar-gateway-ready",
    });
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
    const rootPut = vi.fn((_runId: string, _json: string): string => "");
    const codingPut = vi.fn((_runId: string, _json: string): string => "");
    const deps = depsValue(
      configValue(provider(), capability()),
      undefined,
      {},
      {
        put: rootPut,
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
      {
        modelSource: "chatgpt-codex-subscription-profile",
        codingWorkbenchEvidenceStore: {
          put: codingPut,
          list: () => [],
          get: () => undefined,
          delete: () => undefined,
        },
      },
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
    expect(rootPut).not.toHaveBeenCalled();
    expect(codingPut).toHaveBeenCalledTimes(1);
    const record = parseEvidenceRecord(String(codingPut.mock.calls[0]?.[1]));
    expect(record).toMatchObject({
      kind: "failure",
      modelSource: "chatgpt-codex-subscription-profile",
      safeSummary: "sidecar-gateway-denied",
      denied: true,
    });
  });

  it("writes failed routing evidence and emits a diagnostic when the gateway call throws", async () => {
    const rootPut = vi.fn((_runId: string, _json: string): string => "");
    const codingPut = vi.fn((_runId: string, _json: string): string => "");
    let capturedDiagnostic: ServerDiagnosticRecord | undefined;
    const diagnostics = {
      record: vi.fn((record: ServerDiagnosticRecord): void => {
        capturedDiagnostic = record;
      }),
    };
    const hostileMessage =
      "tool call '/Users/customer/private-repo/secret-tool' has non-JSON arguments";
    const deps = depsValue(
      configValue(provider(), capability()),
      (): ((request: GatewayRequest) => Promise<NormalizedResponse>) => {
        return (request: GatewayRequest): Promise<NormalizedResponse> => {
          void request;
          return Promise.reject(new Error(hostileMessage));
        };
      },
      {},
      {
        put: rootPut,
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
      {
        diagnostics,
        codingWorkbenchEvidenceStore: {
          put: codingPut,
          list: () => [],
          get: () => undefined,
          delete: () => undefined,
        },
      },
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
    expect(rootPut).not.toHaveBeenCalled();
    expect(codingPut).toHaveBeenCalledTimes(1);
    const evidenceJson = String(codingPut.mock.calls[0]?.[1]);
    const record = parseEvidenceRecord(evidenceJson);
    expect(record).toMatchObject({
      kind: "failure",
      modelSource: "keiko-model-gateway",
      safeSummary: "sidecar-gateway-failed",
      denied: true,
    });
    expect(evidenceJson).not.toContain("continue");
    expect(evidenceJson).not.toContain(hostileMessage);
    expect(diagnostics.record).toHaveBeenCalledTimes(1);
    expect(diagnostics.record).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "coding-sidecar-gateway.chat",
        errorClass: "CodingSidecarGatewayFailure",
        message: "sidecar-gateway-failed",
      }),
    );
    expect(JSON.stringify(capturedDiagnostic)).not.toContain(hostileMessage);
    expect(JSON.stringify(capturedDiagnostic)).not.toContain(
      "/Users/customer/private-repo/secret-tool",
    );
  });
});
