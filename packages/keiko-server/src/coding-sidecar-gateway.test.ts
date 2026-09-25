import { resetCodingWorkbenchContextWindowProbesForTests } from "./gateway-readiness.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProviderError,
  resolveCodingSafeSidecarGatewayProfile,
  type GatewayCallRequest,
  type GatewayConfig,
  type GatewayRequest,
  type GatewayStreamChunk,
  type ModelCapability,
  type ModelProviderConfig,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import {
  codingWorkbenchProviderTimeoutMs,
  providerRequestBudgetMs,
  streamRequestBudgetMs,
} from "@oscharko-dev/keiko-model-gateway/internal/resilience";
import {
  AuthenticationError,
  CircuitOpenError,
  ConfigInvalidError,
  ContextOverflowError,
  ProviderOutputExhaustedError,
  RateLimitError,
  TimeoutError,
} from "@oscharko-dev/keiko-security/errors/gateway";
import { TOOL_CALLING_VERIFICATION_MAX_AGE_MS } from "@oscharko-dev/keiko-contracts/runtime/gateway";
import { activityLogEventRegistration } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { buildRedactor, type UiHandlerDeps } from "./deps.js";
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";
import {
  _classifyBadRequestReasonForTests,
  codingSidecarGatewayRequestDeadlineMs,
  createOpenCodeGatewayReadinessRegistry,
  handleCodingSidecarGatewayChatCompletions,
  handleCodingSidecarGatewayProfile,
  PROFILE_PROBE_WAIT_MS,
  MINIMUM_ADMITTED_OUTPUT_TOKENS,
  admissiblePromptTokens,
  admittedOutputTokens,
} from "./coding-sidecar-gateway.js";
import { mockRequest, mockResponse, probeVerifiedGatewayConfig } from "./_support.js";
import {
  createOpenCodeGatewayToolCatalogAdvertisement,
  OPENCODE_MODEL_VISIBLE_TOOL_NAMES,
  opencodeGatewayOfferLifetimeMs,
} from "./coding-runtime/opencodeToolSchemas.js";
import { proposalIdPattern } from "./gitDelivery/proposalId.js";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
  type BufferedServerLogSink,
  type ServerLogThreshold,
} from "./observability/index.js";
import { createRunRegistry } from "./runs.js";
import { createInMemoryUiStore } from "./store/index.js";
import { STREAMING, type RouteContext, type RouteResult } from "./routes.js";
import { resetGatewayInstanceCacheForTests } from "./gateway-instance-cache.js";
import { MAX_TIMER_DELAY_MS } from "./abort-race.js";
import { OPENCODE_RUNTIME_READINESS_PROMPT } from "./coding-runtime/opencodeLaunchProfile.js";
import { CodingRuntimeEventHub } from "./coding-runtime/codingRuntimeEventHub.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

// Installs a buffered process logger at `level` and returns its sink, mirroring
// `bounded-request-body.test.ts`'s helper of the same name. `resetServerLogger` in each suite's
// own `afterEach` puts the process-wide slot back so no other suite in this file shares it.
function captureServerLog(level: ServerLogThreshold): BufferedServerLogSink {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level }));
  return sink;
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
    toolCallingVerification: {
      status: "verified",
      checkedAt: new Date().toISOString(),
      probe: "gateway-tool-calling-v1",
      configurationFingerprint: "test-fingerprint",
    },
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
    readonly evidenceAggregator?: UiHandlerDeps["codingSidecarGatewayEvidenceAggregator"];
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
    ...(options.evidenceAggregator === undefined
      ? {}
      : { codingSidecarGatewayEvidenceAggregator: options.evidenceAggregator }),
    // Every sidecar request is capability-authenticated. The readiness registry
    // remains absent here so generic gateway tests do not claim the OpenCode lane.
    runtimeCapabilityAuthenticator: {
      authenticate: (capability: string, audience: "model-gateway" | "tool-facade") =>
        capability === "gateway-capability-material-0000000001" && audience === "model-gateway"
          ? { ok: true, binding: { runId: "run-gateway-test" } }
          : { ok: false },
      reservePromptTokens: () => ({ ok: true, runId: "run-gateway-test" }),
    },
  };
}

function routeContext(body: unknown): RouteContext {
  const rawBody = typeof body === "string" ? body : JSON.stringify(body);
  const request = mockRequest({
    method: "POST",
    url: "/api/coding-sidecar/gateway/chat/completions",
    body: rawBody,
    headers: { authorization: "Bearer gateway-capability-material-0000000001" },
  });
  const response = mockResponse();
  return {
    correlationId: undefined,
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
  streamFactory?: unknown,
): UiHandlerDeps {
  let authenticatedRunId = "run-1";
  const authenticateAndRemember = (
    capability: string,
    audience: "model-gateway" | "tool-facade",
  ): unknown => {
    const value = authenticate(capability, audience);
    if (typeof value === "object" && value !== null && "binding" in value) {
      const binding = value.binding;
      if (
        typeof binding === "object" &&
        binding !== null &&
        "runId" in binding &&
        typeof binding.runId === "string"
      ) {
        authenticatedRunId = binding.runId;
      }
    }
    return value;
  };
  return {
    ...depsValue(configValue(provider(), capability()), chatFactory),
    runtimeCapabilityAuthenticator: {
      authenticate: authenticateAndRemember,
      reservePromptTokens: () => ({ ok: true, runId: authenticatedRunId }),
    },
    openCodeGatewayReadinessRegistry: readiness,
    ...(streamFactory === undefined
      ? {}
      : { codingSidecarGatewayChatStreamFactory: streamFactory }),
  } as unknown as UiHandlerDeps;
}

function authenticatedContext(body: unknown, origin?: string): RouteContext {
  const rawBody = typeof body === "string" ? body : JSON.stringify(body);
  const response = mockResponse({ captureBody: true });
  return {
    correlationId: undefined,
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

// Captured from the real OpenCode 2.0.10 model request (schemas only, no request content).
// These bytes are independent of Keiko's tool-catalog implementation.
const PINNED_MODEL_VISIBLE_TOOLS = JSON.parse(
  readFileSync(
    new URL(
      "./coding-runtime/opencodeToolSchemas.opencode-2.0.10-advertised.fixture.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as readonly { readonly name: string; readonly parameters: Readonly<Record<string, unknown>> }[];

function pinnedToolSchema(name: string): Readonly<Record<string, unknown>> {
  const tool = PINNED_MODEL_VISIBLE_TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new TypeError(`Missing captured OpenCode tool: ${name}`);
  return tool.parameters;
}

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

function v2ModelVisibleTools(): ModelVisibleRequestTool[] {
  return modelVisibleTools();
}

/**
 * The exact schema-only `tools` array sent by OpenCode 2.0.10 on a real macOS run.
 * This route-level proof complements the isolated contract matcher.
 */
function realOpenCodeAdvertisedTools(): ModelVisibleRequestTool[] {
  return modelVisibleTools(PINNED_MODEL_VISIBLE_TOOLS);
}

/**
 * Replayed child history for the adoption-gap fingerprint: two system messages, the private task
 * prompt, then `rounds` assistant/user pairs. With `toolCallName` the final round carries one
 * settled tool call so adoption (keiko_*) and planning-only loops (todowrite) stay distinguishable.
 */
function adoptionGapMessages(rounds: number, toolCallName?: string): readonly unknown[] {
  const messages: unknown[] = [
    { role: "system", content: "governed prompt" },
    { role: "system", content: "environment" },
    { role: "user", content: "private task content" },
  ];
  for (let round = 0; round < rounds; round += 1) {
    const withToolCall = toolCallName !== undefined && round === rounds - 1;
    messages.push(
      withToolCall
        ? {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: `call-${String(round)}`,
                type: "function",
                function: { name: toolCallName, arguments: "{}" },
              },
            ],
          }
        : { role: "assistant", content: `private analysis ${String(round)}` },
    );
    messages.push(
      withToolCall
        ? { role: "tool", content: "private tool result", tool_call_id: `call-${String(round)}` }
        : { role: "user", content: "continue" },
    );
  }
  return messages;
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

async function* streamedResponse(response: NormalizedResponse): AsyncGenerator<GatewayStreamChunk> {
  await Promise.resolve();
  if (response.content.length > 0) yield { type: "delta" as const, token: response.content };
  yield { type: "done" as const, response };
}

describe("coding-sidecar gateway", () => {
  afterEach(resetServerLogger);

  it.each([
    { label: "buffered", stream: false },
    { label: "streaming", stream: true },
  ])(
    "pins the $label sidecar request to the gateway resolved before body intake",
    async ({ stream }) => {
      resetGatewayInstanceCacheForTests();
      let requestedUrl: string | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn((input: string | URL | Request): Promise<Response> => {
          requestedUrl = input instanceof Request ? input.url : String(input);
          return Promise.reject(new Error("provider unavailable"));
        }),
      );
      const initialConfig = configValue(
        provider({ baseUrl: "https://initial-gateway.example/v1", maxRetries: 0 }),
        capability(),
      );
      const runtimeConfig = probeVerifiedGatewayConfig(initialConfig);
      const deps = {
        ...runtimeGatewayDeps(() => ({ ok: true, binding: { runId: "run-pinned" } })),
        gatewayConfig: runtimeConfig,
      };
      const body = new PassThrough();
      const request = body as unknown as IncomingMessage & {
        method: string;
        url: string;
        headers: Record<string, string>;
      };
      request.method = "POST";
      request.url = "/api/coding-sidecar/gateway/chat/completions";
      request.headers = { authorization: "Bearer gateway-capability-material-0000000001" };
      const context = { ...authenticatedContext({}), req: request };

      try {
        const pending = handleCodingSidecarGatewayChatCompletions(context, deps);
        runtimeConfig.set(
          configValue(
            provider({ baseUrl: "https://replacement-gateway.example/v1", maxRetries: 0 }),
            capability(),
          ),
          true,
        );
        body.end(
          JSON.stringify({
            model: "coding",
            stream,
            messages: [{ role: "user", content: "continue" }],
            tools: modelVisibleTools(),
          }),
        );

        const result = await pending;
        if (stream) expect(result).toBe(STREAMING);
        else expect(result).toMatchObject({ status: 503 });
        expect(requestedUrl).toContain("initial-gateway.example");
        expect(requestedUrl).not.toContain("replacement-gateway.example");
      } finally {
        vi.unstubAllGlobals();
        resetGatewayInstanceCacheForTests();
      }
    },
  );

  it("produces a GatewayRequest whose toolCatalog projection canonically equals the forwarded managed tools and reaches fetch", async () => {
    resetGatewayInstanceCacheForTests();
    let requestBody:
      { tools?: readonly { function: { name: string; parameters: unknown } }[] } | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const body = typeof init?.body === "string" ? init.body : "{}";
        requestBody = JSON.parse(body) as typeof requestBody;
        return Promise.resolve(
          new Response(
            JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }),
    );
    const deps = runtimeGatewayDeps(() => ({ ok: true, binding: { runId: "run-real" } }));
    try {
      const result = await handleCodingSidecarGatewayChatCompletions(
        authenticatedContext({
          model: "coding",
          messages: [{ role: "user", content: "continue" }],
          tools: modelVisibleTools(),
        }),
        deps,
      );
      assertRouteResult(result);
      expect(result.status).toBe(200);
      expect(requestBody?.tools).toBeDefined();
      const sentTools = requestBody?.tools ?? [];
      const advertisement = createOpenCodeGatewayToolCatalogAdvertisement(
        Date.now(),
        undefined,
        opencodeGatewayOfferLifetimeMs(30_000),
      );
      // The forwarded set is the governed catalog plus the native question tool,
      // matching the captured OpenCode 2.0.10 model-visible set.
      const expectedParametersByName = new Map<string, unknown>([
        ...advertisement.projection.tools.map((tool): [string, unknown] => [
          tool.alias,
          tool.inputSchema,
        ]),
        ...PINNED_MODEL_VISIBLE_TOOLS.filter((tool) =>
          advertisement.projection.nativeExtensions.some(
            (extension) => extension.alias === tool.name,
          ),
        ).map((tool): [string, unknown] => [tool.name, tool.parameters]),
      ]);
      expect(new Set(sentTools.map((tool) => tool.function.name))).toEqual(
        new Set(OPENCODE_MODEL_VISIBLE_TOOL_NAMES),
      );
      for (const tool of sentTools) {
        expect(tool.function.parameters).toEqual(expectedParametersByName.get(tool.function.name));
      }
    } finally {
      vi.unstubAllGlobals();
      resetGatewayInstanceCacheForTests();
    }
  });

  // The per-request offer used to expire after a fixed 30 s, shorter than the provider deadline the
  // gateway itself enforces: a 49 s generation bound against a dead offer and the run failed as if
  // the model had emitted a malformed call (2026-09-10). The offer now lives for the model's request
  // deadline plus the settlement grace, and the bridge logs how long it had left when projected.
  it("advertises an offer that outlives the provider request deadline and logs its remaining lifetime", async () => {
    resetGatewayInstanceCacheForTests();
    const sink = captureServerLog("info");
    vi.stubGlobal(
      "fetch",
      vi.fn((): Promise<Response> =>
        Promise.resolve(
          new Response(
            JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
      ),
    );
    const deps = runtimeGatewayDeps(() => ({ ok: true, binding: { runId: "run-real" } }));
    try {
      const result = await handleCodingSidecarGatewayChatCompletions(
        authenticatedContext({
          model: "coding",
          messages: [{ role: "user", content: "continue" }],
          tools: modelVisibleTools(),
        }),
        deps,
      );
      assertRouteResult(result);
      expect(result.status).toBe(200);
      const projected = sink.events.find((event) => event.op === "gateway.tool-catalog.projected");
      expect(projected).toBeDefined();
      const remaining = projected?.extra?.offerRemainingMs;
      // The offer must still be bindable past the route's own deadline for the model by the
      // settlement grace, minus the milliseconds between mint and projection.
      const deadline = codingSidecarGatewayRequestDeadlineMs(
        configValue(provider(), capability()),
        provider().modelId,
      );
      expect(typeof remaining).toBe("number");
      expect(remaining as number).toBeGreaterThan(deadline);
      expect(remaining as number).toBeLessThanOrEqual(opencodeGatewayOfferLifetimeMs(deadline));
    } finally {
      vi.unstubAllGlobals();
      resetGatewayInstanceCacheForTests();
    }
  });

  // #3384 wave-3 W3-1 redirect (reviewer 3941816393 / B1): a tool whose real handler binding is
  // reported unavailable for this run must be ABSENT from the advertised (and therefore forwarded)
  // tool set, not merely denied if the model ever tries to call it (#3413-AC1/#3414-AC4/AC9).
  it("omits unavailable optional tools and logs each effective offer distinctly", async () => {
    resetGatewayInstanceCacheForTests();
    const sink = captureServerLog("info");
    let unavailable = new Set<"keiko_research_fetch" | "keiko_child_agent">([
      "keiko_research_fetch",
    ]);
    let requestBody:
      { tools?: readonly { function: { name: string; parameters: unknown } }[] } | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const body = typeof init?.body === "string" ? init.body : "{}";
        requestBody = JSON.parse(body) as typeof requestBody;
        return Promise.resolve(
          new Response(
            JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }),
    );
    const deps: UiHandlerDeps = {
      ...depsValue(configValue(provider(), capability())),
      runtimeCapabilityAuthenticator: {
        authenticate: () => ({ ok: true, binding: { runId: "run-real" } }),
        reservePromptTokens: () => ({ ok: true, runId: "run-real" }),
        unavailableOptionalTools: (runId: string) =>
          runId === "run-real" ? unavailable : undefined,
      },
      openCodeGatewayReadinessRegistry: createOpenCodeGatewayReadinessRegistry(),
    } as unknown as UiHandlerDeps;
    try {
      const request = (): RouteContext => ({
        ...authenticatedContext({
          model: "coding",
          messages: [{ role: "user", content: "continue" }],
          tools: modelVisibleTools(),
        }),
        correlationId: "correlation-tool-availability",
      });
      const result = await handleCodingSidecarGatewayChatCompletions(request(), deps);
      assertRouteResult(result);
      expect(result.status).toBe(200);
      const sentToolNames = new Set((requestBody?.tools ?? []).map((tool) => tool.function.name));
      expect(sentToolNames.has("keiko_research_fetch")).toBe(false);
      expect(sentToolNames).toEqual(
        new Set(
          OPENCODE_MODEL_VISIBLE_TOOL_NAMES.filter((name) => name !== "keiko_research_fetch"),
        ),
      );

      unavailable = new Set(["keiko_child_agent"]);
      const second = await handleCodingSidecarGatewayChatCompletions(request(), deps);
      assertRouteResult(second);
      expect(second.status).toBe(200);

      const availabilityEvents = sink.events.filter(
        (event) => event.op === "coding-sidecar.gateway.tool-availability",
      );
      expect(availabilityEvents).toHaveLength(2);
      expect(availabilityEvents[0]).toMatchObject({
        correlationId: "correlation-tool-availability",
        extra: {
          runId: "run-real",
          unavailableOptionalTools: ["keiko_research_fetch"],
          unavailableOptionalToolCount: 1,
          offeredOptionalTools: ["keiko_child_agent", "keiko_skill", "keiko_skill_discover"],
          offeredOptionalToolCount: 3,
          completeness: "complete",
          loss: "none",
        },
      });
      expect(availabilityEvents[1]).toMatchObject({
        correlationId: "correlation-tool-availability",
        extra: {
          runId: "run-real",
          unavailableOptionalTools: ["keiko_child_agent"],
          unavailableOptionalToolCount: 1,
          offeredOptionalTools: ["keiko_research_fetch", "keiko_skill", "keiko_skill_discover"],
          offeredOptionalToolCount: 3,
          completeness: "complete",
          loss: "none",
        },
      });
      expect(
        activityLogEventRegistration(
          availabilityEvents[0] as unknown as Readonly<Record<PropertyKey, unknown>>,
        ),
      ).toBeDefined();
      expect(availabilityEvents[0]?.extra?.handlerSetDigest).not.toBe(
        availabilityEvents[1]?.extra?.handlerSetDigest,
      );
      const persistedAvailability = expectActivityLogProof(
        "coding-sidecar.gateway.tool-availability.line",
        formatActivityLogProofLine(availabilityEvents[0] ?? {}),
      );
      expect(persistedAvailability).toMatchObject({
        runId: "run-real",
        unavailableOptionalTools: ["keiko_research_fetch"],
        offeredOptionalToolCount: 3,
      });
    } finally {
      vi.unstubAllGlobals();
      resetGatewayInstanceCacheForTests();
      resetServerLogger();
    }
  });

  it("passes a native extension tool call ('question') through unbound instead of rejecting it (#3414 follow-up)", async () => {
    resetGatewayInstanceCacheForTests();
    vi.stubGlobal(
      "fetch",
      vi.fn((): Promise<Response> =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  finish_reason: "tool_calls",
                  message: {
                    content: "",
                    tool_calls: [
                      {
                        id: "call-1",
                        type: "function",
                        function: {
                          name: "question",
                          arguments: JSON.stringify({ questions: [] }),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
      ),
    );
    const deps = runtimeGatewayDeps(() => ({ ok: true, binding: { runId: "run-question" } }));
    try {
      const result = await handleCodingSidecarGatewayChatCompletions(
        authenticatedContext({
          model: "coding",
          messages: [{ role: "user", content: "continue" }],
          tools: modelVisibleTools(),
        }),
        deps,
      );
      assertRouteResult(result);
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        choices: [{ message: { tool_calls: [{ function: { name: "question" } }] } }],
      });
    } finally {
      vi.unstubAllGlobals();
      resetGatewayInstanceCacheForTests();
    }
  });

  it("keeps circuit-breaker failures across separate production gateway requests", async () => {
    resetGatewayInstanceCacheForTests();
    const fetchMock = vi.fn(() => Promise.reject(new Error("provider unavailable")));
    vi.stubGlobal("fetch", fetchMock);
    const config = {
      ...configValue(provider({ maxRetries: 0 }), capability()),
      circuitBreaker: { failureThreshold: 2, cooldownMs: 30_000, halfOpenProbes: 1 },
    };
    const deps = depsValue(config);
    const request = (): RouteContext =>
      authenticatedContext({
        model: "azure-coding-model",
        messages: [{ role: "user", content: "continue" }],
        tools: [],
      });

    try {
      await handleCodingSidecarGatewayChatCompletions(request(), deps);
      await handleCodingSidecarGatewayChatCompletions(request(), deps);
      await handleCodingSidecarGatewayChatCompletions(request(), deps);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
      resetGatewayInstanceCacheForTests();
    }
  });

  it("fails closed when a runtime gateway route has no capability authenticator", async () => {
    const sink = captureServerLog("warn");
    const chat = vi.fn(() => Promise.resolve(assistantResponse("azure-coding-model")));
    const deps = { ...depsValue(configValue(provider(), capability()), () => chat) } as Record<
      string,
      unknown
    >;
    delete deps.runtimeCapabilityAuthenticator;
    const result = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "azure-coding-model",
        messages: [{ role: "user", content: "continue" }],
        tools: [],
      }),
      deps as unknown as UiHandlerDeps,
    );

    expect(result).toMatchObject({ status: 401 });
    expect(chat).not.toHaveBeenCalled();
    expect(sink.events).toEqual([
      expect.objectContaining({
        op: "coding-sidecar.gateway.rejected",
        status: 401,
        errorKind: "unavailable",
        extra: {
          reason: "capability-authenticator-unavailable",
          completeness: "complete",
          loss: "none",
        },
      }),
    ]);
    const persistedRejection = expectActivityLogProof(
      "coding-sidecar.gateway.rejected.line",
      formatActivityLogProofLine(sink.events[0] ?? {}),
    );
    expect(persistedRejection).toMatchObject({ reason: "capability-authenticator-unavailable" });
  });

  it("logs a body-free rejection line for a request missing a bearer capability", async () => {
    const sink = captureServerLog("warn");
    const chat = vi.fn(() => Promise.resolve(assistantResponse("azure-coding-model")));
    const deps = depsValue(configValue(provider(), capability()), () => chat);
    const context = authenticatedContext({
      model: "azure-coding-model",
      messages: [{ role: "user", content: "continue" }],
      tools: [],
    });
    delete (context.req.headers as Record<string, unknown>).authorization;

    const result = await handleCodingSidecarGatewayChatCompletions(context, deps);

    expect(result).toMatchObject({ status: 401 });
    expect(chat).not.toHaveBeenCalled();
    expect(sink.events).toEqual([
      expect.objectContaining({
        op: "coding-sidecar.gateway.rejected",
        status: 401,
        errorKind: "permission-denied",
        extra: { reason: "capability-missing", completeness: "complete", loss: "none" },
      }),
    ]);
  });

  it("authenticates the model-gateway audience before parsing a body and rejects Origin", async () => {
    const sink = captureServerLog("warn");
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
    expect(sink.events).toEqual([
      expect.objectContaining({
        op: "coding-sidecar.gateway.rejected",
        status: 401,
        errorKind: "permission-denied",
        extra: { reason: "capability-invalid", completeness: "complete", loss: "none" },
      }),
    ]);

    const browser = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({ messages: [{ role: "user", content: "hello" }] }, "http://evil.test"),
      runtimeGatewayDeps(() => ({ ok: true, binding: { runId: "run-1" } })),
    );
    expect(browser).toMatchObject({ status: 403 });
  });

  it("fails closed before provider dispatch when the cumulative prompt budget is exhausted", async () => {
    const chat = vi.fn(() => Promise.resolve(assistantResponse("azure-coding-model")));
    const deps = {
      ...runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-1" } }),
        () => chat,
      ),
      runtimeCapabilityAuthenticator: {
        authenticate: (): unknown => ({ ok: true, binding: { runId: "run-1" } }),
        reservePromptTokens: (): unknown => ({
          ok: false,
          reason: "authority-budget-exceeded",
        }),
      },
    };

    const result = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        messages: [{ role: "user", content: "continue" }],
        tools: modelVisibleTools(),
      }),
      deps,
    );

    expect(result).toMatchObject({ status: 403 });
    expect(chat).not.toHaveBeenCalled();
  });

  it("keeps the hand-typed proposalId pin in sync with the derived pattern", () => {
    const schema = pinnedToolSchema("keiko_git_execute");
    const properties = schema.properties as Readonly<Record<string, { readonly pattern?: string }>>;
    expect(properties.proposalId?.pattern).toBe(proposalIdPattern());
  });

  it("accepts exactly the captured OpenCode 2.0.10 visible schemas by canonical digest", async () => {
    expect(
      PINNED_MODEL_VISIBLE_TOOLS.map((tool) => [tool.name, schemaDigest(tool.parameters)]),
    ).toEqual([
      ["keiko_changeset_edit", "ed31a7b545d02b150eb3896ca88a2b6823a4b9c02f1c86bb425351334dc9a2e1"],
      ["keiko_child_agent", "370bb0f282b4b848f08ce4a780ceb45d4959c150839d71025c32b54de4c87773"],
      ["keiko_ci_status", "0c55bc6340d0d7f1622c529153d24ccae35be81da319b5369c49385aa3aba58e"],
      ["keiko_git_commit", "21f595f8c387e9f705c4146ee99d3d0acbb5d69b460834ae114b400c0372a6bf"],
      ["keiko_git_diff", "0d3a0f35cca521a4883ce70ad847f2585425483ae0d9c58d8ff6cea14119c079"],
      ["keiko_git_execute", "fa0e9a6590a7012c266a77fe380c587fcc96f6e7fef39037f8596267d478d60f"],
      ["keiko_git_push", "d746974fa9afd5e951f76f9af38954b0ad7f436f2120dc974da65e5ee39f856f"],
      ["keiko_git_stage", "6c0ce52bf8a41e07edd650c8f2cb37ebf89706a88ed4112e7166e43eef6860ba"],
      ["keiko_git_status", "d746974fa9afd5e951f76f9af38954b0ad7f436f2120dc974da65e5ee39f856f"],
      ["keiko_pull_request", "3a1a2638bddc571a74a54ff53556219b1ead22034797cd62f683b2abd7ab8ef1"],
      [
        "keiko_repository_search",
        "c793976afbd7705d6dcfc9c82a6568b63162c506f7ba5aeb22a7909bd7fc87dc",
      ],
      ["keiko_research_fetch", "af805d28c78e78e6e103cd7e0964a51f9f8198660b9882dc077b989a6ebfcf2d"],
      ["keiko_skill", "6fe6bd523b0b52035e62c565bb047b24906161d97f549b320b28c2099a1ddd67"],
      ["keiko_skill_discover", "d746974fa9afd5e951f76f9af38954b0ad7f436f2120dc974da65e5ee39f856f"],
      ["keiko_verification", "8cbb4582b87ff37f13040c8f064d1080b848bcfe7b6ff2159adf682acd41c35f"],
      [
        "keiko_workspace_discover",
        "fdc3bd7f51fd0a7c913909fee514aa0c0f31127b9b4e10324c569fbfcdf4df6c",
      ],
      ["keiko_workspace_read", "29233b25ff1788400500ee0ec33c7ef915a016ea8646c5d9884bac699a618503"],
      ["question", "c5e745bc20ee80f7cbad35122b5e3b58db1c6b863821ec26ef203d1e94c451a3"],
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

  it("dispatches the model and reasoning effort bound to the authenticated run", async () => {
    const chat = vi.fn((_request: GatewayRequest) =>
      Promise.resolve(assistantResponse("qwen-coder")),
    );
    const selectedConfig: GatewayConfig = {
      ...configValue(provider(), capability()),
      providers: [
        provider(),
        provider({ modelId: "qwen-coder", endpointStyle: "openai-compatible" }),
      ],
      capabilities: [capability(), capability({ id: "qwen-coder" })],
    };
    const deps = {
      ...runtimeGatewayDeps(
        () => ({
          ok: true,
          binding: {
            runId: "run-qwen",
            modelProfileId: "qwen-coder",
            reasoningEffort: "high",
          },
        }),
        () => chat,
      ),
      config: selectedConfig,
    };

    const result = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        messages: [{ role: "user", content: "use the selected model" }],
        tools: modelVisibleTools(),
      }),
      deps,
    );

    expect(result).toMatchObject({ status: 200 });
    expect(chat.mock.calls[0]?.[0]).toMatchObject({
      modelId: "qwen-coder",
      reasoningEffort: "high",
    });
  });

  it.each(["coding", "coding-safe-openai-compatible"])(
    "treats %s as a runtime transport model id",
    async (modelProfileId) => {
      const chat = vi.fn((request: GatewayRequest) =>
        Promise.resolve(assistantResponse(request.modelId)),
      );
      const deps = runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-alias", modelProfileId } }),
        () => chat,
      );

      const result = await handleCodingSidecarGatewayChatCompletions(
        authenticatedContext({
          model: "coding",
          messages: [{ role: "user", content: "use the configured safe model" }],
          tools: modelVisibleTools(),
        }),
        deps,
      );

      expect(result).toMatchObject({ status: 200 });
      expect(chat).toHaveBeenCalledOnce();
      expect(chat.mock.calls[0]?.[0].modelId).toBe("azure-coding-model");
    },
  );

  it("keeps the safe runtime transport profile usable without a readiness registry", async () => {
    const chat = vi.fn((request: GatewayRequest) =>
      Promise.resolve(assistantResponse(request.modelId)),
    );
    const deps = runtimeGatewayDeps(
      () => ({
        ok: true,
        binding: {
          runId: "run-live",
          adapterKind: "model-gateway-sidecar",
          modelProfileId: "coding-safe-openai-compatible",
        },
      }),
      () => chat,
      undefined,
    );

    const result = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        messages: [{ role: "user", content: "live runtime task" }],
        tools: modelVisibleTools(),
      }),
      deps,
    );

    expect(result).toMatchObject({ status: 200 });
    expect(chat).toHaveBeenCalledOnce();
    expect(chat.mock.calls[0]?.[0].modelId).toBe("azure-coding-model");
  });

  it("fails closed when the verification schema allows extra arguments", async () => {
    const chat = vi.fn(() => Promise.resolve(assistantResponse("azure-coding-model")));
    const tools = modelVisibleTools(
      PINNED_MODEL_VISIBLE_TOOLS.map((tool) =>
        tool.name === "keiko_verification"
          ? { ...tool, parameters: { ...tool.parameters, additionalProperties: true } }
          : tool,
      ),
    );
    const result = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        messages: [{ role: "user", content: "verify" }],
        tools,
      }),
      runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-1" } }),
        () => chat,
      ),
    );

    expect(result).toMatchObject({ status: 403 });
    expect(chat).not.toHaveBeenCalled();
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
        messages: [{ role: "user", content: OPENCODE_RUNTIME_READINESS_PROMPT }],
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
        messages: [{ role: "user", content: OPENCODE_RUNTIME_READINESS_PROMPT }],
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

  it("emits only a closed reason when the authenticated runtime tool contract is rejected", async () => {
    const diagnostics = { record: vi.fn<(record: ServerDiagnosticRecord) => void>() };
    const deps = {
      ...runtimeGatewayDeps(() => ({ ok: true, binding: { runId: "run-1" } })),
      diagnostics,
    };

    for (const [tools, code] of [
      [undefined, "CODING_GATEWAY_TOOL_CONTRACT_MISSING"],
      [[], "CODING_GATEWAY_TOOL_CONTRACT_EMPTY"],
      [modelVisibleTools().slice(0, 2), "CODING_GATEWAY_TOOL_CONTRACT_DRIFT"],
    ] as const) {
      const result = await handleCodingSidecarGatewayChatCompletions(
        authenticatedContext({
          model: "coding",
          messages: [{ role: "user", content: "private runtime content" }],
          ...(tools === undefined ? {} : { tools }),
        }),
        deps,
      );
      expect(result).toMatchObject({ status: 403 });
      expect(diagnostics.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          source: "coding-sidecar-gateway.tool-contract",
          errorClass: "CodingSidecarGatewayToolContractRejection",
          message: "coding-sidecar-gateway-tool-contract-rejected",
          code,
        }),
      );
    }
    expect(diagnostics.record).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(diagnostics.record.mock.calls)).not.toContain("private runtime content");
  });

  it("emits the tool-adoption-gap diagnostic once per run for keiko_*-free governed histories", async () => {
    // #2680 live-probe fingerprint: many model requests, zero keiko_* facade calls. The
    // diagnostic is observability only — the request must keep flowing to the model — and a
    // persisting gap must not flood the operator log with one record per request.
    const diagnostics = { record: vi.fn<(record: ServerDiagnosticRecord) => void>() };
    const chat = vi.fn(() => Promise.resolve(assistantResponse("azure-coding-model")));
    const readiness = createOpenCodeGatewayReadinessRegistry();
    const deps = {
      ...runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-1" } }),
        () => chat,
        readiness,
      ),
      diagnostics,
    };
    const send = async (): Promise<void> => {
      const result = await handleCodingSidecarGatewayChatCompletions(
        authenticatedContext({
          model: "coding",
          messages: adoptionGapMessages(3),
          tools: modelVisibleTools(),
        }),
        deps,
      );
      expect(result).toMatchObject({ status: 200 });
    };
    const adoptionRecords = (): readonly ServerDiagnosticRecord[] =>
      diagnostics.record.mock.calls
        .map(([record]) => record)
        .filter((record) => record.code === "CODING_GATEWAY_TOOL_ADOPTION_GAP");

    await send();
    await send();
    expect(chat).toHaveBeenCalledTimes(2);
    expect(adoptionRecords()).toHaveLength(1);
    expect(adoptionRecords()[0]).toMatchObject({
      source: "coding-sidecar-gateway.tool-adoption",
      errorClass: "CodingSidecarGatewayToolAdoptionGap",
      message: "coding-sidecar-gateway-tool-adoption-gap",
    });
    expect(JSON.stringify(diagnostics.record.mock.calls)).not.toContain("private");

    // A disposed run releases the mark; the next run's gap is diagnosable again.
    readiness.clear("run-1");
    await send();
    expect(adoptionRecords()).toHaveLength(2);
  });

  it("keeps planning-only todowrite loops inside the tool-adoption-gap fingerprint", async () => {
    const diagnostics = { record: vi.fn<(record: ServerDiagnosticRecord) => void>() };
    const chat = vi.fn(() => Promise.resolve(assistantResponse("azure-coding-model")));
    const deps = {
      ...runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-1" } }),
        () => chat,
      ),
      diagnostics,
    };
    const result = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        messages: adoptionGapMessages(3, "todowrite"),
        tools: modelVisibleTools(),
      }),
      deps,
    );

    expect(result).toMatchObject({ status: 200 });
    expect(
      diagnostics.record.mock.calls.some(
        ([record]) => record.code === "CODING_GATEWAY_TOOL_ADOPTION_GAP",
      ),
    ).toBe(true);
  });

  it("stays silent below the adoption threshold and once one keiko_* call is in the history", async () => {
    const diagnostics = { record: vi.fn<(record: ServerDiagnosticRecord) => void>() };
    const chat = vi.fn(() => Promise.resolve(assistantResponse("azure-coding-model")));
    const deps = {
      ...runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-1" } }),
        () => chat,
      ),
      diagnostics,
    };
    for (const messages of [
      adoptionGapMessages(1),
      adoptionGapMessages(3, "keiko_workspace_read"),
    ]) {
      const result = await handleCodingSidecarGatewayChatCompletions(
        authenticatedContext({ model: "coding", messages, tools: modelVisibleTools() }),
        deps,
      );
      expect(result).toMatchObject({ status: 200 });
    }
    expect(
      diagnostics.record.mock.calls.some(
        ([record]) => record.code === "CODING_GATEWAY_TOOL_ADOPTION_GAP",
      ),
    ).toBe(false);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("never fingerprints an empty or threshold-minus-one history", async () => {
    const diagnostics = { record: vi.fn<(record: ServerDiagnosticRecord) => void>() };
    const chat = vi.fn(() => Promise.resolve(assistantResponse("azure-coding-model")));
    const deps = {
      ...runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-1" } }),
        () => chat,
      ),
      diagnostics,
    };
    // The gap fires at TOOL_ADOPTION_GAP_MESSAGE_THRESHOLD (9) messages; the builder only yields
    // odd counts, so the exact 8-message boundary is constructed inline alongside the empty case.
    const thresholdMinusOne: readonly unknown[] = [
      { role: "system", content: "governed prompt" },
      { role: "system", content: "environment" },
      { role: "user", content: "private task content" },
      { role: "assistant", content: "private analysis 0" },
      { role: "user", content: "next" },
      { role: "assistant", content: "private analysis 1" },
      { role: "user", content: "next" },
      { role: "assistant", content: "private analysis 2" },
    ];
    expect(thresholdMinusOne).toHaveLength(8);
    for (const messages of [[] as readonly unknown[], thresholdMinusOne]) {
      await handleCodingSidecarGatewayChatCompletions(
        authenticatedContext({ model: "coding", messages, tools: modelVisibleTools() }),
        deps,
      );
    }
    expect(
      diagnostics.record.mock.calls.some(
        ([record]) => record.code === "CODING_GATEWAY_TOOL_ADOPTION_GAP",
      ),
    ).toBe(false);
  });

  it("admits tool-free compaction only after the exact runtime handshake and before disposal", async () => {
    const readiness = createOpenCodeGatewayReadinessRegistry();
    const controller = new AbortController();
    const observed = readiness.waitForObservedRequest("run-1", controller.signal);
    const chat = vi.fn(() => Promise.resolve(assistantResponse("azure-coding-model")));
    const deps = runtimeGatewayDeps(
      () => ({ ok: true, binding: { runId: "run-1" } }),
      () => chat,
      readiness,
    );
    const request = (
      tools?: readonly ModelVisibleRequestTool[],
      content = "bounded private runtime content",
    ): RouteContext =>
      authenticatedContext({
        model: "coding",
        messages: [{ role: "user", content }],
        ...(tools === undefined ? {} : { tools }),
      });

    expect(await handleCodingSidecarGatewayChatCompletions(request(), deps)).toMatchObject({
      status: 403,
    });
    expect(readiness.isVerified("run-1")).toBe(false);
    expect(
      await handleCodingSidecarGatewayChatCompletions(
        authenticatedContext({
          model: "coding",
          messages: [
            { role: "system", content: "native injected system instruction" },
            { role: "user", content: OPENCODE_RUNTIME_READINESS_PROMPT },
          ],
          tools: modelVisibleTools(),
        }),
        deps,
      ),
    ).toMatchObject({ status: 200 });
    await expect(observed).resolves.toBe(true);
    expect(readiness.isVerified("run-1")).toBe(true);
    readiness.clear("run-1", true);

    expect(await handleCodingSidecarGatewayChatCompletions(request(), deps)).toMatchObject({
      status: 200,
    });
    expect(chat).toHaveBeenCalledOnce();
    expect(await handleCodingSidecarGatewayChatCompletions(request([]), deps)).toMatchObject({
      status: 403,
    });

    readiness.clear("run-1");
    expect(readiness.isVerified("run-1")).toBe(false);
    expect(await handleCodingSidecarGatewayChatCompletions(request(), deps)).toMatchObject({
      status: 403,
    });
    expect(chat).toHaveBeenCalledOnce();
  });

  it("forwards a real exact-tool runtime turn and verifies the run for later compaction", async () => {
    const readiness = createOpenCodeGatewayReadinessRegistry();
    const chat = vi.fn(() => Promise.resolve(assistantResponse("azure-coding-model")));
    const deps = runtimeGatewayDeps(
      () => ({ ok: true, binding: { runId: "run-1" } }),
      () => chat,
      readiness,
    );

    expect(
      await handleCodingSidecarGatewayChatCompletions(
        authenticatedContext({
          model: "coding",
          messages: [{ role: "user", content: "real user task" }],
          tools: modelVisibleTools(),
        }),
        deps,
      ),
    ).toMatchObject({ status: 200 });
    expect(chat).toHaveBeenCalledOnce();
    expect(readiness.isVerified("run-1")).toBe(true);

    expect(
      await handleCodingSidecarGatewayChatCompletions(
        authenticatedContext({
          model: "coding",
          messages: [{ role: "user", content: "compaction follow-up" }],
        }),
        deps,
      ),
    ).toMatchObject({ status: 200 });
    expect(chat).toHaveBeenCalledTimes(2);
  });

  // A real OpenCode 2.0.10 schema capture must pass the route-level contract gate.
  it("accepts the real OpenCode 2.0.10 live-captured advertisement", async () => {
    const chat = vi.fn(() => Promise.resolve(assistantResponse("azure-coding-model")));
    const result = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        messages: [{ role: "user", content: "real user task" }],
        tools: realOpenCodeAdvertisedTools(),
      }),
      runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-1" } }),
        () => chat,
      ),
    );
    expect(result).toMatchObject({ status: 200 });
    expect(chat).toHaveBeenCalledOnce();
  });

  it("canonicalizes key order but denies empty, drifted, unknown, and productive built-in tools", async () => {
    const chat = vi.fn(() => Promise.resolve(assistantResponse("azure-coding-model")));
    const acceptedWithReorderedKeys = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        messages: [{ role: "user", content: "continue" }],
        tools: modelVisibleTools(
          PINNED_MODEL_VISIBLE_TOOLS.map((tool) => ({
            name: tool.name,
            parameters: Object.fromEntries(Object.entries(tool.parameters).reverse()),
          })),
        ),
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
            ...pinnedToolSchema("keiko_workspace_read"),
            properties: { relativePath: { type: "string", minLength: 1 } },
          },
        },
        ...PINNED_MODEL_VISIBLE_TOOLS.slice(2, 3),
      ]),
      modelVisibleTools([
        ...PINNED_MODEL_VISIBLE_TOOLS,
        { name: "unknown_tool", parameters: pinnedToolSchema("question") },
      ]),
      modelVisibleTools([
        ...PINNED_MODEL_VISIBLE_TOOLS,
        { name: "bash", parameters: pinnedToolSchema("question") },
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
            content: null,
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
        tools: v2ModelVisibleTools(),
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
        createOpenCodeGatewayReadinessRegistry(),
        (): (() => AsyncIterable<GatewayStreamChunk>) => (): AsyncIterable<GatewayStreamChunk> =>
          streamedResponse({ ...assistantResponse("azure-coding-model"), content: "Completed." }),
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

  it("retains positive completion usage when a streamed proxy answer has no usage", async () => {
    const sink = captureServerLog("info");
    const response = mockResponse({ captureBody: true });
    const record = vi.fn();
    const normalized = {
      ...assistantResponse("azure-coding-model"),
      content: "Answered.",
      usage: { ...assistantResponse("azure-coding-model").usage, completionTokens: 0 },
    };
    const context: RouteContext = {
      ...authenticatedContext({
        model: "coding",
        stream: true,
        messages: [{ role: "user", content: "answer" }],
        tools: modelVisibleTools(),
      }),
      res: response.res,
    };
    const deps = {
      ...runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-no-usage" } }),
        undefined,
        createOpenCodeGatewayReadinessRegistry(),
        (): (() => AsyncIterable<GatewayStreamChunk>) => (): AsyncIterable<GatewayStreamChunk> =>
          streamedResponse(normalized),
      ),
      codingSidecarGatewayEvidenceAggregator: { record },
    } as UiHandlerDeps;
    expect(await handleCodingSidecarGatewayChatCompletions(context, deps)).toBe(STREAMING);
    expect(response.body()).toContain('"completion_tokens":3');
    expect(record).toHaveBeenCalledWith({
      runId: "run-no-usage",
      outcome: "accepted",
      completionTokens: 3,
      outputBytes: 62,
    });
    const settled = sink.events.find(
      (event) => event.op === "coding-sidecar.gateway.usage-settled",
    );
    expect(settled?.extra).toMatchObject({
      source: "streamed-byte-estimate",
      completionTokens: 3,
    });
    expectActivityLogProof(
      "coding-sidecar.gateway.usage-settled.line",
      formatActivityLogProofLine(settled ?? {}),
    );
    const outcome = sink.events.find((event) => event.op === "coding-sidecar.gateway.outcome");
    expect(outcome?.extra).toMatchObject({
      runId: "run-no-usage",
      outcome: "accepted",
      completionTokens: 3,
    });
    expectActivityLogProof(
      "coding-sidecar.gateway.outcome.line",
      formatActivityLogProofLine(outcome ?? {}),
    );
  });

  it("preserves a smaller positive provider token count over the stream byte estimate", async () => {
    const sink = captureServerLog("info");
    const response = mockResponse({ captureBody: true });
    const record = vi.fn();
    const normalized = {
      ...assistantResponse("azure-coding-model"),
      content: "hello",
      usage: { ...assistantResponse("azure-coding-model").usage, completionTokens: 1 },
    };
    const context: RouteContext = {
      ...authenticatedContext({
        model: "coding",
        stream: true,
        messages: [{ role: "user", content: "answer" }],
        tools: modelVisibleTools(),
      }),
      res: response.res,
    };
    const deps = {
      ...runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-reported-usage" } }),
        undefined,
        createOpenCodeGatewayReadinessRegistry(),
        (): (() => AsyncIterable<GatewayStreamChunk>) => (): AsyncIterable<GatewayStreamChunk> =>
          streamedResponse(normalized),
      ),
      codingSidecarGatewayEvidenceAggregator: { record },
    } as UiHandlerDeps;
    expect(await handleCodingSidecarGatewayChatCompletions(context, deps)).toBe(STREAMING);
    expect(response.body()).toContain('"completion_tokens":1');
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "accepted", completionTokens: 1 }),
    );
    expect(
      sink.events.find((event) => event.op === "coding-sidecar.gateway.usage-settled")?.extra,
    ).toMatchObject({ source: "provider-reported", completionTokens: 1 });
  });

  it("accounts for a tool-call-only streamed answer without provider usage", async () => {
    const sink = captureServerLog("info");
    const response = mockResponse({ captureBody: true });
    const record = vi.fn<(entry: { outcome: string; completionTokens: number }) => void>();
    const normalized: NormalizedResponse = {
      ...assistantResponse("azure-coding-model"),
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call-1", name: "keiko_workspace_read", arguments: { relativePath: "a" } }],
      usage: { ...assistantResponse("azure-coding-model").usage, completionTokens: 0 },
    };
    const context: RouteContext = {
      ...authenticatedContext({
        model: "coding",
        stream: true,
        messages: [{ role: "user", content: "read" }],
        tools: modelVisibleTools(),
      }),
      res: response.res,
    };
    const deps = {
      ...runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-tool-only" } }),
        undefined,
        createOpenCodeGatewayReadinessRegistry(),
        (): (() => AsyncIterable<GatewayStreamChunk>) => (): AsyncIterable<GatewayStreamChunk> =>
          streamedResponse(normalized),
      ),
      codingSidecarGatewayEvidenceAggregator: { record },
    } as UiHandlerDeps;
    expect(await handleCodingSidecarGatewayChatCompletions(context, deps)).toBe(STREAMING);
    expect(response.body()).toContain('"tool_calls"');
    const accepted = record.mock.calls.find(([entry]) => entry.outcome === "accepted")?.[0];
    expect(accepted?.completionTokens).toBeGreaterThan(0);
    expect(response.body()).not.toContain('"completion_tokens":0');
    expect(
      sink.events.find((event) => event.op === "coding-sidecar.gateway.usage-settled")?.extra,
    ).toMatchObject({
      source: "output-byte-estimate",
      completionTokens: accepted?.completionTokens,
    });
  });

  it("accounts for streamed text and tool arguments together when usage is absent", async () => {
    const sink = captureServerLog("info");
    const response = mockResponse({ captureBody: true });
    const record = vi.fn<(entry: { outcome: string; completionTokens: number }) => void>();
    const normalized: NormalizedResponse = {
      ...assistantResponse("azure-coding-model"),
      content: "hello",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call-1",
          name: "keiko_workspace_read",
          arguments: { relativePath: "a".repeat(1_000) },
        },
      ],
      usage: { ...assistantResponse("azure-coding-model").usage, completionTokens: 0 },
    };
    const context: RouteContext = {
      ...authenticatedContext({
        model: "coding",
        stream: true,
        messages: [{ role: "user", content: "read" }],
        tools: modelVisibleTools(),
      }),
      res: response.res,
    };
    const deps = {
      ...runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-mixed-output" } }),
        undefined,
        createOpenCodeGatewayReadinessRegistry(),
        (): (() => AsyncIterable<GatewayStreamChunk>) => (): AsyncIterable<GatewayStreamChunk> =>
          streamedResponse(normalized),
      ),
      codingSidecarGatewayEvidenceAggregator: { record },
    } as UiHandlerDeps;
    expect(await handleCodingSidecarGatewayChatCompletions(context, deps)).toBe(STREAMING);
    const accepted = record.mock.calls.find(([entry]) => entry.outcome === "accepted")?.[0];
    expect(accepted?.completionTokens).toBeGreaterThan(250);
    expect(response.body()).toContain(`"completion_tokens":${String(accepted?.completionTokens)}`);
    expect(
      sink.events.find((event) => event.op === "coding-sidecar.gateway.usage-settled")?.extra,
    ).toMatchObject({
      source: "output-byte-estimate",
      completionTokens: accepted?.completionTokens,
    });
  });

  it("synthesizes OpenAI SSE from a buffered tool-call response", async () => {
    const sink = captureServerLog("info");
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
      usage: { ...assistantResponse("azure-coding-model").usage, completionTokens: 0 },
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
    expect(response.body()).toMatch(/"completion_tokens":[1-9]/u);
    expect(response.body()).toContain("data: [DONE]");
    expect(
      sink.events.find((event) => event.op === "coding-sidecar.gateway.usage-settled")?.extra,
    ).toMatchObject({ source: "output-byte-estimate" });
  });

  it("commits the buffered SSE handshake before waiting for the provider", async () => {
    vi.useFakeTimers();
    let resolveProvider: ((response: NormalizedResponse) => void) | undefined;
    const provider = new Promise<NormalizedResponse>((resolve) => {
      resolveProvider = resolve;
    });
    const response = mockResponse({ captureBody: true });
    const context: RouteContext = {
      ...authenticatedContext({
        model: "coding",
        stream: true,
        messages: [{ role: "user", content: "wait for a tool" }],
        tools: modelVisibleTools(),
      }),
      res: response.res,
    };

    const pending = handleCodingSidecarGatewayChatCompletions(
      context,
      runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-buffered-handshake" } }),
        (): (() => Promise<NormalizedResponse>) => (): Promise<NormalizedResponse> => provider,
      ),
    );
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(response.body()).toContain('"role":"assistant"');
      expect(response.body()).not.toContain(": keep-alive");

      await vi.advanceTimersByTimeAsync(5_000);
      expect(response.body()).toContain(": keep-alive\n\n");

      resolveProvider?.(assistantResponse("azure-coding-model"));
      await expect(pending).resolves.toBe(STREAMING);
      const settledBody = response.body();
      expect(settledBody).toContain("data: [DONE]");

      await vi.advanceTimersByTimeAsync(10_000);
      expect(response.body()).toBe(settledBody);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a buffered provider call on response close and run stop", async () => {
    for (const cancellation of ["response-close", "run-stop"] as const) {
      const run = new AbortController();
      let seenSignal: AbortSignal | undefined;
      let observeAbort: (() => void) | undefined;
      const providerAborted = new Promise<void>((resolve) => {
        observeAbort = resolve;
      });
      const chat = vi.fn(
        (request: GatewayRequest): Promise<NormalizedResponse> =>
          new Promise((_resolve, reject) => {
            seenSignal = request.cancellationSignal;
            request.cancellationSignal?.addEventListener(
              "abort",
              () => {
                observeAbort?.();
                reject(new Error("provider cancellation details must not escape"));
              },
              { once: true },
            );
          }),
      );
      const deps = {
        ...runtimeGatewayDeps(
          () => ({ ok: true, binding: { runId: "run-cancel" } }),
          () => chat,
        ),
        codingSidecarGatewayCancellationRegistry: { signalFor: () => run.signal },
      } as unknown as UiHandlerDeps;
      const context = authenticatedContext({
        model: "coding",
        messages: [{ role: "user", content: "cancel" }],
        tools: modelVisibleTools(),
      });

      const pending = handleCodingSidecarGatewayChatCompletions(context, deps);
      await vi.waitFor((): void => {
        expect(chat).toHaveBeenCalledOnce();
      });
      if (cancellation === "response-close") context.res.emit("close");
      else run.abort();
      await expect(providerAborted).resolves.toBeUndefined();
      await expect(pending).resolves.toMatchObject({ status: 503 });
      expect(seenSignal?.aborted).toBe(true);
    }
  });

  // The route deadline is a backstop behind the gateway's own end-to-end budget. It used to be the
  // provider's per-attempt `timeoutMs` and cancelled the retry of a hung attempt (run 23).
  it("sets the route deadline behind the provider's whole retry budget", () => {
    for (const value of [
      provider(),
      provider({ timeoutMs: 120_000, maxRetries: 2 }),
      provider({ maxRetries: 0 }),
    ]) {
      expect(
        codingSidecarGatewayRequestDeadlineMs(configValue(value, capability()), value.modelId),
      ).toBeGreaterThan(providerRequestBudgetMs(value));
    }
  });

  // #3591: a 30 s configured timeout no longer bounds a Workbench turn. The one attempt is held to
  // the 300 s silence floor, the buffered call to the 600 s budget floor, a streamed read to the
  // 1,800 s stream floor, and the route adds its one-second grace behind the LONGER of the two
  // budgets — with no retries the buffered budget is the shorter one, and a deadline derived from
  // it alone cancelled a healthy stream the gateway was still reading (PR #3602 review).
  it("keeps a slow Coding Workbench turn alive past a 30-second provider spike", () => {
    const slow = provider({ timeoutMs: 30_000, maxRetries: 0 });
    expect(
      codingSidecarGatewayRequestDeadlineMs(configValue(slow, capability()), slow.modelId),
    ).toBe(1_801_000);
  });

  // The sidecar reaches the gateway both ways (`chat()` buffered, `chatStream()` streamed), so the
  // backstop must sit behind whichever budget is longer: the streamed read's when retries are few,
  // the buffered retry budget when they are many.
  it("sets the route deadline behind the streamed read's budget as well as the buffered one", () => {
    for (const value of [
      provider({ maxRetries: 0 }),
      provider({ timeoutMs: 120_000, maxRetries: 1 }),
      provider({ timeoutMs: 30_000, maxRetries: 3 }),
      provider({ timeoutMs: 2_400_000, maxRetries: 0 }),
    ]) {
      const raised = { ...value, timeoutMs: codingWorkbenchProviderTimeoutMs(value.timeoutMs) };
      const deadline = codingSidecarGatewayRequestDeadlineMs(
        configValue(value, capability()),
        value.modelId,
      );
      expect(deadline).toBeGreaterThan(streamRequestBudgetMs(raised));
      expect(deadline).toBeGreaterThan(providerRequestBudgetMs(raised));
    }
    // The fixture that makes the buffered budget the longer one, so the assertion above is not
    // satisfied by the stream floor alone.
    const retried = provider({ timeoutMs: 30_000, maxRetries: 3 });
    const raised = { ...retried, timeoutMs: codingWorkbenchProviderTimeoutMs(retried.timeoutMs) };
    expect(providerRequestBudgetMs(raised)).toBeGreaterThan(streamRequestBudgetMs(raised));
  });

  // A timer armed with more than 2^31 - 1 ms fires at once: a budget that large must not turn the
  // route's backstop into an immediate abort (PR #3452 review).
  it("keeps the route deadline inside what a timer can hold", () => {
    const vast = provider({ maxRetries: 1_000_000 });
    const deadline = codingSidecarGatewayRequestDeadlineMs(
      configValue(vast, capability()),
      vast.modelId,
    );
    expect(deadline).toBe(MAX_TIMER_DELAY_MS);
    // The budget itself stops at the ceiling, so the grace the route adds would pass it: the
    // route's own clamp still has to hold.
    expect(providerRequestBudgetMs(vast)).toBe(MAX_TIMER_DELAY_MS);
  });

  it("bounds an unconfigured model before it can enter the Workbench provider path", () => {
    const unconfigured = configValue(provider(), capability());
    expect(codingSidecarGatewayRequestDeadlineMs(unconfigured, "unconfigured-model")).toBe(31_000);
  });

  // Run 23 (2026-09-11), end to end through the route and the real gateway: the first attempt hangs
  // until its own timeout, and the call must be retried instead of ending GATEWAY_CANCELLED.
  it("lets the gateway retry an attempt that hung to its timeout instead of cancelling the call", async () => {
    resetGatewayInstanceCacheForTests();
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: unknown, init?: RequestInit): Promise<Response> => {
        calls += 1;
        const signal = init?.signal;
        if (calls === 1 && signal != null) {
          // A provider that never answers: only the attempt's own timeout ends this call.
          return new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
              },
              { once: true },
            );
          });
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }),
    );
    const deps = {
      ...runtimeGatewayDeps(() => ({ ok: true, binding: { runId: "run-hung-attempt" } })),
      config: configValue(provider({ timeoutMs: 50, retryBaseDelayMs: 1 }), capability()),
    } as UiHandlerDeps;
    try {
      const pending = handleCodingSidecarGatewayChatCompletions(
        authenticatedContext({
          model: "coding",
          messages: [{ role: "user", content: "continue" }],
          tools: modelVisibleTools(),
        }),
        deps,
      );
      // The hung attempt ends at the floored Workbench timeout, not at the configured 50 ms.
      await vi.advanceTimersByTimeAsync(codingWorkbenchProviderTimeoutMs(50) + 50);
      const result = await pending;
      assertRouteResult(result);
      expect(result.status).toBe(200);
      expect(calls).toBe(2);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
      resetGatewayInstanceCacheForTests();
    }
  });

  // Coding run 24 (2026-09-11, F73): admitted while the forced tool-call proof was fresh, the run
  // lost its model 3.5 min later, when the proof aged out; every later call was refused.
  function agedProofCapability(): ModelCapability {
    return capability({
      toolCallingVerification: {
        status: "verified",
        checkedAt: new Date(
          Date.now() - TOOL_CALLING_VERIFICATION_MAX_AGE_MS - 60_000,
        ).toISOString(),
        probe: "gateway-tool-calling-v1",
        configurationFingerprint: "test-fingerprint",
      },
    });
  }

  it("keeps serving a run admitted while the tool-calling proof was fresh after it ages out", async () => {
    const chat = vi.fn((): Promise<NormalizedResponse> =>
      Promise.resolve(assistantResponse("azure-coding-model")),
    );
    const deps = {
      ...runtimeGatewayDeps(
        () => ({
          ok: true,
          binding: { runId: "run-admitted", modelProfileId: "azure-coding-model" },
          issuedAtMs: Date.now() - TOOL_CALLING_VERIFICATION_MAX_AGE_MS / 2,
        }),
        () => chat,
      ),
      config: configValue(provider(), agedProofCapability()),
    } as UiHandlerDeps;

    const result = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        messages: [{ role: "user", content: "continue" }],
        tools: modelVisibleTools(),
      }),
      deps,
    );

    assertRouteResult(result);
    expect(result.status).toBe(200);
    expect(chat).toHaveBeenCalledOnce();
  });

  it("refuses a run admitted after the proof aged out and names the stale proof", async () => {
    const diagnostics = { record: vi.fn<(record: ServerDiagnosticRecord) => void>() };
    const deps = {
      ...runtimeGatewayDeps(() => ({
        ok: true,
        binding: { runId: "run-stale", modelProfileId: "azure-coding-model" },
        issuedAtMs: Date.now() - 1_000,
      })),
      config: configValue(provider(), agedProofCapability()),
      diagnostics,
    } as UiHandlerDeps;

    const result = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        messages: [{ role: "user", content: "continue" }],
        tools: modelVisibleTools(),
      }),
      deps,
    );

    expect(result).toMatchObject({ status: 503 });
    expect(diagnostics.record).toHaveBeenCalledWith(
      expect.objectContaining({
        errorClass: "CodingSidecarGatewayUnavailable",
        code: expect.stringContaining("reason=tool-calling-unverified") as string,
      }),
    );
  });

  it("passes the sidecar deadline through to an in-flight provider call", async () => {
    // No retries: the route deadline is the floored single attempt plus the route's grace. The
    // value is taken from the route's own derivation so the mock follows the floors, not a literal.
    const deadlineProvider = provider({ timeoutMs: 10, maxRetries: 0 });
    const deadlineConfig = configValue(deadlineProvider, capability());
    const routeDeadlineMs = codingSidecarGatewayRequestDeadlineMs(
      deadlineConfig,
      deadlineProvider.modelId,
    );
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms) => nativeTimeout(ms === routeDeadlineMs ? 10 : ms));
    let seenSignal: AbortSignal | undefined;
    let observeAbort: (() => void) | undefined;
    const providerAborted = new Promise<void>((resolve) => {
      observeAbort = resolve;
    });
    const chat = vi.fn(
      (request: GatewayRequest): Promise<NormalizedResponse> =>
        new Promise((_resolve, reject) => {
          seenSignal = request.cancellationSignal;
          request.cancellationSignal?.addEventListener(
            "abort",
            () => {
              observeAbort?.();
              reject(new Error("deadline cancellation details must not escape"));
            },
            { once: true },
          );
        }),
    );
    const deps = {
      ...runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-deadline" } }),
        () => chat,
      ),
      config: deadlineConfig,
    } as UiHandlerDeps;

    try {
      const result = await handleCodingSidecarGatewayChatCompletions(
        authenticatedContext({
          model: "coding",
          messages: [{ role: "user", content: "deadline" }],
          tools: modelVisibleTools(),
        }),
        deps,
      );
      await expect(providerAborted).resolves.toBeUndefined();
      expect(result).toMatchObject({ status: 503 });
      expect(seenSignal?.aborted).toBe(true);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("rejects buffered responses that exceed completion-token or UTF-8 output bounds", async () => {
    const oversizedArguments = { secretLikePayload: "x".repeat(800) };
    const responses: readonly NormalizedResponse[] = [
      {
        ...assistantResponse("azure-coding-model"),
        content: "too many",
        usage: { ...assistantResponse("azure-coding-model").usage, completionTokens: 3 },
      },
      {
        ...assistantResponse("azure-coding-model"),
        content: "",
        finishReason: "tool_calls",
        toolCalls: [
          { id: "call-oversized", name: "keiko_workspace_read", arguments: oversizedArguments },
        ],
        usage: { ...assistantResponse("azure-coding-model").usage, completionTokens: 1 },
      },
    ];
    for (const response of responses) {
      const deps = {
        ...runtimeGatewayDeps(
          () => ({ ok: true, binding: { runId: "run-output" } }),
          (): (() => Promise<NormalizedResponse>) => (): Promise<NormalizedResponse> =>
            Promise.resolve(response),
        ),
        config: configValue(provider(), capability({ maxOutputTokens: 2 })),
      } as UiHandlerDeps;
      const result = await handleCodingSidecarGatewayChatCompletions(
        authenticatedContext({
          model: "coding",
          messages: [{ role: "user", content: "bounded" }],
          tools: modelVisibleTools(),
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
      expect(JSON.stringify(result)).not.toContain("secretLikePayload");
    }
  });

  it("uses the injected gateway stream, bounds cumulative output, and returns it on overflow", async () => {
    let returned = false;
    const stream = async function* (): AsyncGenerator<GatewayStreamChunk> {
      try {
        await Promise.resolve();
        yield { type: "delta", token: "x".repeat(20) };
        yield { type: "done", response: assistantResponse("azure-coding-model") };
      } finally {
        returned = true;
      }
    };
    const response = mockResponse({ captureBody: true });
    const context: RouteContext = {
      ...authenticatedContext({
        model: "coding",
        stream: true,
        messages: [{ role: "user", content: "bounded stream" }],
        tools: modelVisibleTools(),
      }),
      res: response.res,
    };

    const deps = {
      ...runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-stream" } }),
        undefined,
        createOpenCodeGatewayReadinessRegistry(),
        (): (() => AsyncIterable<GatewayStreamChunk>) => (): AsyncIterable<GatewayStreamChunk> =>
          stream(),
      ),
      config: configValue(provider(), capability({ maxOutputTokens: 2 })),
    } as UiHandlerDeps;
    const result = await handleCodingSidecarGatewayChatCompletions(context, deps);

    expect(result).toBe(STREAMING);
    expect(returned).toBe(true);
    expect(response.body()).not.toContain("x".repeat(20));
    expect(response.body()).toContain('"finish_reason":"length"');
    expect(response.body()).toContain("data: [DONE]");
  });

  // 0.3.0 audit: `pumpGatewayStream` failing mid-response went into a bare `catch {}` — the exact
  // pattern AGENTS.md §7 forbids — on the coding path. The SSE error frame still went out, but the
  // cause was recorded nowhere, so an interrupted coding turn had no diagnosable reason. The frame is
  // unchanged; the redacted cause is added and is distinguishable from a pre-stream failure by `source`.
  it("records the mid-stream failure cause with the run correlation id", async () => {
    const diagnostics = { record: vi.fn<(record: ServerDiagnosticRecord) => void>() };
    const eventHub = new CodingRuntimeEventHub();
    const stream = async function* (): AsyncGenerator<GatewayStreamChunk> {
      await Promise.resolve();
      yield { type: "delta", token: "partial" };
      throw Object.assign(new Error("upstream reset key sk-ABCDEFGHIJKLMNOPQRSTUV"), {
        code: "GATEWAY_TRANSPORT",
        partialUsage: { promptTokens: 11, completionTokens: 3 },
      });
    };
    const response = mockResponse({ captureBody: true });
    const context: RouteContext = {
      ...authenticatedContext({
        model: "coding",
        stream: true,
        messages: [{ role: "user", content: "mid-stream failure" }],
        tools: modelVisibleTools(),
      }),
      res: response.res,
      correlationId: "sidecar-corr-0001",
    };
    const deps = {
      ...runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-stream-failure" } }),
        undefined,
        createOpenCodeGatewayReadinessRegistry(),
        (): (() => AsyncIterable<GatewayStreamChunk>) => (): AsyncIterable<GatewayStreamChunk> =>
          stream(),
      ),
      diagnostics,
      codingRuntimeEventHub: eventHub,
      codingRuntimeOrchestrator: {
        getSnapshot: () => ({ state: "running", revision: 3 }),
      } as unknown as UiHandlerDeps["codingRuntimeOrchestrator"],
    } as UiHandlerDeps;

    const result = await handleCodingSidecarGatewayChatCompletions(context, deps);

    expect(result).toBe(STREAMING);
    const streamRecords = diagnostics.record.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.source === "coding-sidecar-gateway.stream");
    expect(streamRecords).toHaveLength(1);
    expect(streamRecords[0]?.correlationId).toBe("sidecar-corr-0001");
    expect(streamRecords[0]?.parentCorrelationId).toBe("run-stream-failure");
    expect(streamRecords[0]?.errorClass).toBe("Error");
    expect(streamRecords[0]?.code).toBe("GATEWAY_TRANSPORT");
    // Interrupted-turn token counts survive the failure instead of vanishing with the error.
    expect(streamRecords[0]?.partialUsage).toEqual({ promptTokens: 11, completionTokens: 3 });
    expect(JSON.stringify(streamRecords)).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUV");
    expect(JSON.stringify(streamRecords)).not.toContain("upstream reset");
    const replay = eventHub.replay("run-stream-failure");
    expect(replay.ok && replay.events).toMatchObject([
      { kind: "runtime-event", eventKind: "failure-redacted", failureCode: "stream-incomplete" },
    ]);
  });

  // Regression: a mid-stream failure without a request correlation once produced bare "unknown",
  // which the diagnostic sanitizer rewrote to "invalid-correlation-id". The authenticated run id
  // is always available and now anchors the diagnostic directly in support analyze's run timeline.
  it("uses the authenticated run id when the request correlation is missing", async () => {
    const diagnostics = { record: vi.fn<(record: ServerDiagnosticRecord) => void>() };
    const stream = async function* (): AsyncGenerator<GatewayStreamChunk> {
      await Promise.resolve();
      yield { type: "delta", token: "partial" };
      throw Object.assign(new Error("upstream reset"), { code: "GATEWAY_TRANSPORT" });
    };
    const response = mockResponse({ captureBody: true });
    const context: RouteContext = {
      ...authenticatedContext({
        model: "coding",
        stream: true,
        messages: [{ role: "user", content: "mid-stream failure, no correlation id" }],
        tools: modelVisibleTools(),
      }),
      res: response.res,
    };
    const deps = {
      ...runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-stream-failure-no-corr" } }),
        undefined,
        createOpenCodeGatewayReadinessRegistry(),
        (): (() => AsyncIterable<GatewayStreamChunk>) => (): AsyncIterable<GatewayStreamChunk> =>
          stream(),
      ),
      diagnostics,
    } as UiHandlerDeps;

    const result = await handleCodingSidecarGatewayChatCompletions(context, deps);

    expect(result).toBe(STREAMING);
    const streamRecords = diagnostics.record.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.source === "coding-sidecar-gateway.stream");
    expect(streamRecords).toHaveLength(1);
    expect(streamRecords[0]?.correlationId).toBe("run-stream-failure-no-corr");
    expect(streamRecords[0]?.correlationId).not.toBe("invalid-correlation-id");
  });

  it("counts only each new UTF-8 stream delta instead of re-encoding accumulated output", async () => {
    const firstToken = "gateway-delta-one-α";
    const secondToken = "gateway-delta-two-β";
    const byteLength = vi.spyOn(Buffer, "byteLength");
    const stream = async function* (): AsyncGenerator<GatewayStreamChunk> {
      await Promise.resolve();
      yield { type: "delta", token: firstToken };
      yield { type: "delta", token: secondToken };
      yield { type: "done", response: assistantResponse("azure-coding-model") };
    };
    const response = mockResponse({ captureBody: true });
    const context: RouteContext = {
      ...authenticatedContext({
        model: "coding",
        stream: true,
        messages: [{ role: "user", content: "stream incrementally" }],
        tools: modelVisibleTools(),
      }),
      res: response.res,
    };
    const deps = runtimeGatewayDeps(
      () => ({ ok: true, binding: { runId: "run-stream" } }),
      undefined,
      createOpenCodeGatewayReadinessRegistry(),
      (): (() => AsyncIterable<GatewayStreamChunk>) => (): AsyncIterable<GatewayStreamChunk> =>
        stream(),
    );

    try {
      const result = await handleCodingSidecarGatewayChatCompletions(context, deps);

      expect(result).toBe(STREAMING);
      expect(response.body()).toContain(firstToken);
      expect(response.body()).toContain(secondToken);
      expect(byteLength.mock.calls.some(([value]) => value === firstToken + secondToken)).toBe(
        false,
      );
    } finally {
      byteLength.mockRestore();
    }
  });

  it("counts a UTF-8 surrogate pair split across stream deltas as one scalar", async () => {
    const record = vi.fn();
    const stream = async function* (): AsyncGenerator<GatewayStreamChunk> {
      await Promise.resolve();
      yield { type: "delta", token: "\ud83d" };
      yield { type: "delta", token: "\ude00" };
    };
    const response = mockResponse({ captureBody: true });
    const context: RouteContext = {
      ...authenticatedContext({
        model: "coding",
        stream: true,
        messages: [{ role: "user", content: "stream one emoji" }],
        tools: modelVisibleTools(),
      }),
      res: response.res,
    };
    const deps = {
      ...runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-stream" } }),
        undefined,
        createOpenCodeGatewayReadinessRegistry(),
        (): (() => AsyncIterable<GatewayStreamChunk>) => (): AsyncIterable<GatewayStreamChunk> =>
          stream(),
      ),
      config: configValue(provider(), capability({ maxOutputTokens: 1 })),
      codingSidecarGatewayEvidenceAggregator: { record },
    } as UiHandlerDeps;

    const result = await handleCodingSidecarGatewayChatCompletions(context, deps);

    expect(result).toBe(STREAMING);
    expect(response.body()).not.toContain('"finish_reason":"length"');
    expect(response.body()).toContain('"finish_reason":"error"');
    expect(record).toHaveBeenCalledWith({
      runId: "run-stream",
      outcome: "failed",
      completionTokens: 1,
      outputBytes: 4,
    });
  });

  it("returns the injected stream and aborts its provider signal when the client disconnects", async () => {
    let returned = false;
    let seenSignal: AbortSignal | undefined;
    let started: (() => void) | undefined;
    const streamStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const stream = async function* (request: GatewayRequest): AsyncGenerator<GatewayStreamChunk> {
      seenSignal = request.cancellationSignal;
      started?.();
      try {
        await new Promise<void>((resolve) => {
          request.cancellationSignal?.addEventListener(
            "abort",
            () => {
              resolve();
            },
            { once: true },
          );
        });
        yield* [] as GatewayStreamChunk[];
      } finally {
        returned = true;
      }
    };
    const response = mockResponse({ captureBody: true });
    const context: RouteContext = {
      ...authenticatedContext({
        model: "coding",
        stream: true,
        messages: [{ role: "user", content: "disconnect" }],
        tools: modelVisibleTools(),
      }),
      res: response.res,
    };
    const deps = runtimeGatewayDeps(
      () => ({ ok: true, binding: { runId: "run-stream-cancel" } }),
      undefined,
      createOpenCodeGatewayReadinessRegistry(),
      (): ((request: GatewayRequest) => AsyncIterable<GatewayStreamChunk>) =>
        (request: GatewayRequest): AsyncIterable<GatewayStreamChunk> =>
          stream(request),
    );

    const pending = handleCodingSidecarGatewayChatCompletions(context, deps);
    await streamStarted;
    context.res.emit("close");
    await expect(pending).resolves.toBe(STREAMING);
    expect(seenSignal?.aborted).toBe(true);
    expect(returned).toBe(true);
  });

  it("cancels the provider iterator when the streaming response applies backpressure", async () => {
    let pulls = 0;
    let returned = false;
    const stream = async function* (): AsyncGenerator<GatewayStreamChunk> {
      try {
        await Promise.resolve();
        pulls += 1;
        yield { type: "delta", token: "first" };
        pulls += 1;
        yield { type: "delta", token: "must-not-be-pulled" };
      } finally {
        returned = true;
      }
    };
    const response = mockResponse({ captureBody: true });
    let writes = 0;
    response.res.write = vi.fn(() => {
      writes += 1;
      return writes === 1;
    });
    const context: RouteContext = {
      ...authenticatedContext({
        model: "coding",
        stream: true,
        messages: [{ role: "user", content: "stream slowly" }],
        tools: modelVisibleTools(),
      }),
      res: response.res,
    };

    const result = await handleCodingSidecarGatewayChatCompletions(
      context,
      runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-backpressure" } }),
        undefined,
        createOpenCodeGatewayReadinessRegistry(),
        (): (() => AsyncIterable<GatewayStreamChunk>) => (): AsyncIterable<GatewayStreamChunk> =>
          stream(),
      ),
    );

    expect(result).toBe(STREAMING);
    expect(returned).toBe(true);
    expect(pulls).toBe(1);
    expect(response.res.destroyed).toBe(true);
  });

  it.each(["empty", "partial"] as const)(
    "reports a %s stream without a terminal response chunk as one turn error",
    async (streamKind) => {
      const sink = captureServerLog("warn");
      const eventHub = new CodingRuntimeEventHub();
      const diagnostics = { record: vi.fn<(record: ServerDiagnosticRecord) => void>() };
      const stream = async function* (): AsyncGenerator<GatewayStreamChunk> {
        await Promise.resolve();
        if (streamKind === "partial") yield { type: "delta", token: "partial" };
      };
      const response = mockResponse({ captureBody: true });
      const context: RouteContext = {
        ...authenticatedContext({
          model: "coding",
          stream: true,
          messages: [{ role: "user", content: "truncate" }],
          tools: modelVisibleTools(),
        }),
        res: response.res,
        correlationId: "request-truncated",
      };

      const deps = {
        ...runtimeGatewayDeps(
          () => ({ ok: true, binding: { runId: "run-truncated" } }),
          undefined,
          createOpenCodeGatewayReadinessRegistry(),
          (): (() => AsyncIterable<GatewayStreamChunk>) => (): AsyncIterable<GatewayStreamChunk> =>
            stream(),
        ),
        diagnostics,
        codingRuntimeEventHub: eventHub,
        codingRuntimeOrchestrator: {
          getSnapshot: () => ({ state: "running", revision: 4 }),
        } as unknown as UiHandlerDeps["codingRuntimeOrchestrator"],
      } as UiHandlerDeps;
      const result = await handleCodingSidecarGatewayChatCompletions(context, deps);

      expect(result).toBe(STREAMING);
      expect(response.body()).toContain('"finish_reason":"error"');
      expect(response.body()).not.toContain('"finish_reason":"stop"');
      const replay = eventHub.replay("run-truncated");
      expect(replay.ok && replay.events).toMatchObject([
        { kind: "runtime-event", eventKind: "failure-redacted", failureCode: "stream-incomplete" },
      ]);
      expect(
        sink.events.filter((event) => event.op === "coding-sidecar.gateway.turn-failed"),
      ).toHaveLength(1);
      const records = diagnostics.record.mock.calls
        .map(([record]) => record)
        .filter((record) => record.source === "coding-sidecar-gateway.stream");
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        correlationId: "request-truncated",
        parentCorrelationId: "run-truncated",
        errorClass: "ProviderError",
        code: "GATEWAY_PROVIDER_ERROR",
      });
      expect(records[0]?.frames?.some((frame) => frame.includes("coding-sidecar-gateway"))).toBe(
        true,
      );
    },
  );

  it("destroys the response when the terminal tool-call frame hits backpressure", async () => {
    let returned = false;
    const toolResponse: NormalizedResponse = {
      ...assistantResponse("azure-coding-model"),
      content: "",
      toolCalls: [{ id: "call-1", name: "workspace_read", arguments: { path: "README.md" } }],
    };
    const stream = async function* (): AsyncGenerator<GatewayStreamChunk> {
      try {
        await Promise.resolve();
        yield { type: "done", response: toolResponse };
      } finally {
        returned = true;
      }
    };
    const response = mockResponse({ captureBody: true });
    let writes = 0;
    response.res.write = vi.fn(() => {
      writes += 1;
      return writes === 1;
    });
    const context: RouteContext = {
      ...authenticatedContext({
        model: "coding",
        stream: true,
        messages: [{ role: "user", content: "tool call backpressure" }],
        tools: modelVisibleTools(),
      }),
      res: response.res,
    };

    const result = await handleCodingSidecarGatewayChatCompletions(
      context,
      runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-tool-backpressure" } }),
        undefined,
        createOpenCodeGatewayReadinessRegistry(),
        (): (() => AsyncIterable<GatewayStreamChunk>) => (): AsyncIterable<GatewayStreamChunk> =>
          stream(),
      ),
    );

    expect(result).toBe(STREAMING);
    expect(returned).toBe(true);
    expect(response.res.destroyed).toBe(true);
  });

  it("returns an opaque 503 when stream construction fails before committing SSE headers", async () => {
    const response = mockResponse({ captureBody: true });
    const context: RouteContext = {
      ...authenticatedContext({
        model: "coding",
        stream: true,
        messages: [{ role: "user", content: "construct stream" }],
        tools: modelVisibleTools(),
      }),
      res: response.res,
    };

    const result = await handleCodingSidecarGatewayChatCompletions(
      context,
      runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-stream-setup" } }),
        undefined,
        createOpenCodeGatewayReadinessRegistry(),
        (): (() => AsyncIterable<GatewayStreamChunk>) => (): AsyncIterable<GatewayStreamChunk> => {
          throw new Error("private stream setup failure");
        },
      ),
    );

    assertRouteResult(result);
    expect(result).toMatchObject({ status: 503 });
    expect(response.headers.get("content-type") ?? "").not.toContain("text/event-stream");
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

  it("surfaces the same content-free projection through the profile route", async () => {
    const put = vi.fn((_runId: string, _json: string): string => "");
    const context = {
      req: mockRequest({ method: "GET", url: "/api/coding-sidecar/gateway/profile" }),
      res: mockResponse().res,
      params: {},
      url: new URL("http://127.0.0.1/api/coding-sidecar/gateway/profile"),
      correlationId: undefined,
    } satisfies RouteContext;
    const deps = depsValue(configValue(provider(), capability()), undefined, {}, undefined, {
      codingWorkbenchEvidenceStore: {
        put,
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
    });
    const result = await handleCodingSidecarGatewayProfile(context, deps);

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

  // F-01: `status: "available"` describes the stored configuration. A deps assembly with no probe
  // record must therefore publish `verification: "unverified"` — the Workbench renders this field,
  // and a missing one would let it keep reading a configured source as a healthy one.
  it("publishes the last probe outcome alongside the config-derived profile", async () => {
    const context = {
      req: mockRequest({ method: "GET", url: "/api/coding-sidecar/gateway/profile" }),
      res: mockResponse().res,
      params: {},
      url: new URL("http://127.0.0.1/api/coding-sidecar/gateway/profile"),
      correlationId: undefined,
    } satisfies RouteContext;
    const config = configValue(provider(), capability());
    const unprobed = await handleCodingSidecarGatewayProfile(context, depsValue(config));

    expect(unprobed.body).toMatchObject({ status: "available", verification: "unverified" });

    const verified = await handleCodingSidecarGatewayProfile(context, {
      ...depsValue(config),
      gatewayConfig: {
        storagePath: "/dev/null",
        current: () => config,
        present: () => true,
        set: () => undefined,
        generation: () => 0,
        verification: () => "verified",
        recordVerification: () => undefined,
        verifiedCapability: () => undefined,
        recordVerifiedCapability: () => undefined,
        clearVerifiedCapability: () => false,
      },
    });

    expect(verified.body).toMatchObject({ status: "available", verification: "verified" });
  });

  // #3591 (1.1.7): the browser reads this profile with a 15 s deadline. While the automatic probe
  // of a slow gateway is still running, the read must answer within the bounded wait and say that
  // the verification is pending, instead of hanging until the browser gives up or refusing.
  it("answers within the bounded wait with a pending verification while the probe still runs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    resetCodingWorkbenchContextWindowProbesForTests();
    try {
      const context = {
        req: mockRequest({ method: "GET", url: "/api/coding-sidecar/gateway/profile" }),
        res: mockResponse().res,
        params: {},
        url: new URL("http://127.0.0.1/api/coding-sidecar/gateway/profile"),
        correlationId: undefined,
      } satisfies RouteContext;
      const config = configValue(provider(), capability({ contextWindow: 4_096 }));
      const deps: UiHandlerDeps = {
        ...depsValue(config),
        gatewayConfig: {
          storagePath: "/dev/null",
          current: () => config,
          present: () => true,
          set: () => undefined,
          generation: () => 0,
          verification: () => "verified",
          recordVerification: () => undefined,
          verifiedCapability: () => undefined,
          recordVerifiedCapability: () => undefined,
          clearVerifiedCapability: () => false,
        },
        gatewayReadinessFetch: (): Promise<Response> =>
          new Promise<Response>(() => {
            // The gateway never answers within the test: the probe stays in flight.
          }),
      };
      const read = handleCodingSidecarGatewayProfile(context, deps);
      await vi.advanceTimersByTimeAsync(PROFILE_PROBE_WAIT_MS);
      const result = await read;
      expect(result.body).toEqual({
        status: "unavailable",
        reason: "model-verification-pending",
      });
    } finally {
      vi.useRealTimers();
      resetCodingWorkbenchContextWindowProbesForTests();
    }
  });

  // Review of #3591: an unverified tool-calling proof answers `unavailable` before the automatic
  // probe has run. While that probe is still open the read must say so too — the Workbench polls
  // only that reason — instead of a refusal that stands until an unrelated refresh.
  it("answers with a pending verification while the tool-calling probe of an unverified model runs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    resetCodingWorkbenchContextWindowProbesForTests();
    try {
      const context = {
        req: mockRequest({ method: "GET", url: "/api/coding-sidecar/gateway/profile" }),
        res: mockResponse().res,
        params: {},
        url: new URL("http://127.0.0.1/api/coding-sidecar/gateway/profile"),
        correlationId: undefined,
      } satisfies RouteContext;
      const aged = capability({
        toolCallingVerification: {
          status: "verified",
          checkedAt: new Date(
            Date.now() - TOOL_CALLING_VERIFICATION_MAX_AGE_MS - 60_000,
          ).toISOString(),
          probe: "gateway-tool-calling-v1",
          configurationFingerprint: "test-fingerprint",
        },
      });
      const config = configValue(provider(), aged);
      const deps: UiHandlerDeps = {
        ...depsValue(config),
        gatewayConfig: {
          storagePath: "/dev/null",
          current: () => config,
          present: () => true,
          set: () => undefined,
          generation: () => 0,
          verification: () => "verified",
          recordVerification: () => undefined,
          verifiedCapability: () => undefined,
          recordVerifiedCapability: () => undefined,
          clearVerifiedCapability: () => false,
        },
        gatewayReadinessFetch: (): Promise<Response> =>
          new Promise<Response>(() => {
            // The gateway never answers within the test: the tool-calling probe stays in flight.
          }),
      };
      const read = handleCodingSidecarGatewayProfile(context, deps);
      await vi.advanceTimersByTimeAsync(PROFILE_PROBE_WAIT_MS);
      const result = await read;
      expect(result.body).toEqual({ status: "unavailable", reason: "model-verification-pending" });
    } finally {
      vi.useRealTimers();
      resetCodingWorkbenchContextWindowProbesForTests();
    }
  });

  it("fails closed through the profile route when the injected model source is subscription-backed", async () => {
    const context = {
      req: mockRequest({ method: "GET", url: "/api/coding-sidecar/gateway/profile" }),
      res: mockResponse().res,
      params: {},
      url: new URL("http://127.0.0.1/api/coding-sidecar/gateway/profile"),
      correlationId: undefined,
    } satisfies RouteContext;
    const result = await handleCodingSidecarGatewayProfile(
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

  // Owner decision for 1.1.1: a gateway-discovered model carries neither a coding use case nor
  // the manual workflow flag, and must still power the Workbench once its tool calling is proven.
  it("admits a verified tool-calling chat model without a coding label or workflow flag", () => {
    const config = configValue(
      provider({ modelId: "chat-only-sidecar" }),
      capability({
        id: "chat-only-sidecar",
        preferredUseCases: ["Chat"],
        workflowEligible: false,
      }),
    );

    expect(resolveCodingSafeSidecarGatewayProfile(config)).toMatchObject({
      status: "available",
      modelAlias: "chat-only-sidecar",
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
    expect(seenRequests[0]?.maxOutputTokens).toBe(4_096);
    expect(JSON.stringify(seenRequests[0])).not.toContain("baseUrl");
    expect(JSON.stringify(seenRequests[0])).not.toContain("apiKey");
    expect(JSON.stringify(seenRequests[0])).not.toContain("api-key");
    expect(JSON.stringify(result.body)).not.toContain("provider-secret");
  });

  // ADR-0173 D5: the buffered chat completion request built for the gateway must carry the HTTP
  // request's correlation id in GatewayCallRequest.logContext, so a gateway retry/circuit-breaker
  // line for this call joins the same trail as the sidecar request that triggered it.
  it("threads the request correlation id into the Gateway double's GatewayCallRequest.logContext", async () => {
    const seenRequests: GatewayCallRequest[] = [];
    const deps = depsValue(
      configValue(provider(), capability()),
      (
        _config: GatewayConfig,
        modelId: string,
      ): ((request: GatewayCallRequest) => Promise<NormalizedResponse>) => {
        return (request: GatewayCallRequest): Promise<NormalizedResponse> => {
          seenRequests.push(request);
          return Promise.resolve(assistantResponse(modelId));
        };
      },
    );
    const context: RouteContext = {
      ...routeContext({
        model: "azure-coding-model",
        messages: [{ role: "user", content: "continue" }],
      }),
      correlationId: "sidecar-corr-logcontext-0001",
    };

    const result = await handleCodingSidecarGatewayChatCompletions(context, deps);

    assertRouteResult(result);
    expect(result.status).toBe(200);
    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]?.logContext?.correlationId).toBe("sidecar-corr-logcontext-0001");
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

  it("rejects a non-catalog handwritten tool before the gateway request", async () => {
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
    expect(result.status).toBe(403);
    expect(seenRequests).toHaveLength(0);
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

  it("returns a provider context overflow when messages exceed maxInputMessages", async () => {
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
        messages: Array.from({ length: 513 }, (_, index) => ({
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
          code: "context_length_exceeded",
          message: "Request body messages exceed profile maxInputMessages (512).",
        },
      },
    });
    expect(seenRequests).toHaveLength(0);
  });

  it("accepts a bounded coding transcript beyond 64 KB within the profile token allowance", async () => {
    const sink = captureServerLog("info");
    const seen: GatewayRequest[] = [];
    const deps = depsValue(configValue(provider(), capability()), (_config, modelId) => {
      return (request: GatewayRequest): Promise<NormalizedResponse> => {
        seen.push(request);
        return Promise.resolve(assistantResponse(modelId));
      };
    });
    const content = "bounded source context\n".repeat(3_500);
    const result = await handleCodingSidecarGatewayChatCompletions(
      routeContext({ messages: [{ role: "user", content }] }),
      deps,
    );
    assertRouteResult(result);
    expect(result.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.messages).toEqual([{ role: "user", content }]);
    const validated = sink.events.find(
      (event) => event.op === "coding-sidecar.gateway.request-validated",
    );
    expect(validated?.correlationId).toEqual(expect.any(String));
    expect(validated?.extra).toMatchObject({
      maxRequestBytes: 1_048_576,
      inputMessageCount: 1,
      completeness: "complete",
      loss: "none",
    });
    expect(validated?.extra?.estimatedPromptTokens).toEqual(expect.any(Number));
    // #3591 (1.1.7): the output allowance actually sent is part of the request's evidence.
    expect(validated?.extra?.maxOutputTokens).toEqual(expect.any(Number));
    expect(
      activityLogEventRegistration(validated as unknown as Readonly<Record<PropertyKey, unknown>>),
    ).toBeDefined();
    expect(JSON.stringify(sink.events)).not.toContain("bounded source context");
    const persistedValidated = expectActivityLogProof(
      "coding-sidecar.gateway.request-validated.line",
      formatActivityLogProofLine(validated ?? {}),
    );
    expect(persistedValidated).toMatchObject({ maxRequestBytes: 1_048_576, inputMessageCount: 1 });
  });

  it("rejects an over-limit assistant tool-call continuation before provider dispatch or spend", async () => {
    const providerCall = vi.fn((_request: GatewayRequest) =>
      Promise.resolve(assistantResponse("azure-coding-model")),
    );
    const reservePromptTokens = vi.fn(() => ({ ok: true, runId: "run-tool-context" }));
    const base = runtimeGatewayDeps(
      () => ({ ok: true, binding: { runId: "run-tool-context" } }),
      () => providerCall,
    );
    const deps = {
      ...base,
      runtimeCapabilityAuthenticator: {
        ...base.runtimeCapabilityAuthenticator,
        reservePromptTokens,
      },
    } as UiHandlerDeps;
    const privateArguments = { patch: "x".repeat(600_000) };

    const result = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        messages: [
          { role: "user", content: "continue" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-large",
                type: "function",
                function: {
                  name: "keiko_changeset_edit",
                  arguments: JSON.stringify(privateArguments),
                },
              },
            ],
          },
          { role: "tool", content: "rejected", tool_call_id: "call-large" },
        ],
        tools: modelVisibleTools(),
      }),
      deps,
    );

    expect(result).toEqual({
      status: 400,
      body: {
        error: {
          code: "context_length_exceeded",
          message: expect.stringMatching(
            /^Request body estimated prompt tokens exceed profile maxPromptTokens \(128000\) less the reserved output allowance \(\d+ admissible\)\.$/,
          ) as string,
        },
      },
    });
    expect(providerCall).not.toHaveBeenCalled();
    expect(reservePromptTokens).not.toHaveBeenCalled();
  });

  it("retains a hard transport cap and body-free rejection before model dispatch", async () => {
    const sink = captureServerLog("warn");
    const eventHub = new CodingRuntimeEventHub();
    const calls = vi.fn((_request: GatewayRequest) =>
      Promise.resolve(assistantResponse("azure-coding-model")),
    );
    const deps = {
      ...depsValue(configValue(provider(), capability()), () => calls),
      codingRuntimeEventHub: eventHub,
      codingRuntimeOrchestrator: {
        getSnapshot: () => ({ state: "running", revision: 4 }),
      } as unknown as UiHandlerDeps["codingRuntimeOrchestrator"],
    } as UiHandlerDeps;
    const result = await handleCodingSidecarGatewayChatCompletions(
      routeContext({ messages: [{ role: "user", content: "private-overflow".repeat(100_000) }] }),
      deps,
    );
    assertRouteResult(result);
    expect(result.status).toBe(413);
    expect(calls).not.toHaveBeenCalled();
    const rejected = sink.events.find((event) => event.op === "coding-sidecar.gateway.rejected");
    expect(rejected?.extra).toMatchObject({ reason: "request-too-large" });
    const replay = eventHub.replay("run-gateway-test");
    expect(replay.ok && replay.events).toMatchObject([
      { kind: "runtime-event", eventKind: "failure-redacted", failureCode: "turn-rejected" },
    ]);
    expect(
      sink.events.filter((event) => event.op === "coding-sidecar.gateway.turn-failed"),
    ).toHaveLength(1);
    expect(JSON.stringify(sink.events)).not.toContain("private-overflow");
  });

  it("returns a provider context overflow when estimated prompt tokens exceed maxPromptTokens", async () => {
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
          code: "context_length_exceeded",
          message: expect.stringMatching(
            /^Request body estimated prompt tokens exceed profile maxPromptTokens \(16\) less the reserved output allowance \(-?\d+ admissible\)\.$/,
          ) as string,
        },
      },
    });
    expect(seenRequests).toHaveLength(0);
  });

  it("accepts normal prompts when capability token geometry is not yet enriched", async () => {
    const seenRequests: GatewayRequest[] = [];
    const deps = depsValue(
      configValue(provider(), capability({ contextWindow: 0, maxOutputTokens: 0 })),
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
        messages: [{ role: "user", content: "normal prompt ".repeat(50) }],
      }),
      deps,
    );

    expect(result).toMatchObject({ status: 200 });
    expect(seenRequests).toHaveLength(1);
  });

  it("aggregates accepted counts without a durable per-request evidence write", async () => {
    const rootPut = vi.fn((_runId: string, _json: string): string => "");
    const codingPut = vi.fn((_runId: string, _json: string): string => "");
    const record =
      vi.fn<
        (event: {
          readonly runId: string;
          readonly outcome: "accepted" | "cancelled" | "failed" | "output-limit";
          readonly completionTokens: number;
          readonly outputBytes: number;
        }) => void
      >();
    const deps = depsValue(
      configValue(provider(), capability()),
      (
        _config: GatewayConfig,
        modelId: string,
      ): ((request: GatewayRequest) => Promise<NormalizedResponse>) => {
        return (_request: GatewayRequest): Promise<NormalizedResponse> => {
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
        evidenceAggregator: { record },
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
    expect(codingPut).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith({
      runId: "run-gateway-test",
      outcome: "accepted",
      completionTokens: 8,
      outputBytes: expect.any(Number) as number,
    });
  });

  it.each([
    [
      "synchronous",
      (): void => {
        throw new Error("customer/path/secret-sync");
      },
    ],
    ["asynchronous", (): Promise<void> => Promise.reject(new Error("customer/path/secret-async"))],
  ])(
    "emits a content-free diagnostic for %s evidence aggregation failure",
    async (_kind, record) => {
      const diagnostics = { record: vi.fn<(record: ServerDiagnosticRecord) => void>() };
      const deps = depsValue(
        configValue(provider(), capability()),
        (
          _config: GatewayConfig,
          modelId: string,
        ): ((request: GatewayRequest) => Promise<NormalizedResponse>) => {
          return (_request: GatewayRequest): Promise<NormalizedResponse> => {
            return Promise.resolve(assistantResponse(modelId));
          };
        },
        {},
        {
          put: () => "",
          list: () => [],
          get: () => undefined,
          delete: () => undefined,
        },
        { diagnostics, evidenceAggregator: { record } },
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
      await vi.waitFor(() => {
        expect(diagnostics.record).toHaveBeenCalledTimes(1);
      });
      expect(diagnostics.record).toHaveBeenCalledWith(
        expect.objectContaining({
          correlationId: "run-gateway-test",
          operation: "POST /api/coding-sidecar/gateway/chat/completions",
          source: "coding-sidecar-gateway.evidence-aggregation",
          errorClass: "CodingSidecarGatewayEvidenceAggregationFailure",
          message: "sidecar-gateway-evidence-aggregation-failed",
        }),
      );
      expect(JSON.stringify(diagnostics.record.mock.calls)).not.toContain("customer/path/secret");
    },
  );

  it("does not substitute diagnostics or root evidence for the optional aggregator", async () => {
    const rootPut = vi.fn((_runId: string, _json: string): string => "");
    const diagnostics = { record: vi.fn<(record: ServerDiagnosticRecord) => void>() };
    const deps = depsValue(
      configValue(provider(), capability()),
      (
        _config: GatewayConfig,
        modelId: string,
      ): ((request: GatewayRequest) => Promise<NormalizedResponse>) => {
        return (_request: GatewayRequest): Promise<NormalizedResponse> => {
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
    expect(diagnostics.record).not.toHaveBeenCalled();
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

  it("diagnoses unavailable gateway profiles without recording request bodies", async () => {
    const diagnostics = { record: vi.fn<(record: ServerDiagnosticRecord) => void>() };
    const deps = depsValue(
      configValue(provider(), capability()),
      undefined,
      { KEIKO_CODING_SIDECAR_DISABLED: "1" },
      undefined,
      { diagnostics },
    );

    const result = await handleCodingSidecarGatewayChatCompletions(
      routeContext({
        messages: [{ role: "user", content: "private runtime task text" }],
      }),
      deps,
    );

    expect(result).toMatchObject({ status: 503 });
    expect(diagnostics.record).toHaveBeenCalledOnce();
    expect(diagnostics.record).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "coding-sidecar-gateway.chat",
        errorClass: "CodingSidecarGatewayUnavailable",
        message: "coding-sidecar-gateway-profile-unavailable",
        code: "status=unavailable:reason=deployment-policy-disabled:config=configured:gateway=configured:source=model-gateway:selector=absent:authority=gateway",
      }),
    );
    expect(JSON.stringify(diagnostics.record.mock.calls)).not.toContain("private runtime task");
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
    expect(codingPut).not.toHaveBeenCalled();
  });

  it("aggregates a content-free failure without a durable per-request evidence write", async () => {
    const rootPut = vi.fn((_runId: string, _json: string): string => "");
    const codingPut = vi.fn((_runId: string, _json: string): string => "");
    let capturedDiagnostic: ServerDiagnosticRecord | undefined;
    const diagnostics = {
      record: vi.fn((record: ServerDiagnosticRecord): void => {
        capturedDiagnostic = record;
      }),
    };
    const record = vi.fn();
    const hostileMessage =
      "tool call '/Users/customer/private-repo/secret-tool' has non-JSON arguments";
    const gatewayError = new ProviderError(hostileMessage, 400);
    gatewayError.requestId = "gateway-request-1";
    const deps = depsValue(
      configValue(provider(), capability()),
      (): ((request: GatewayRequest) => Promise<NormalizedResponse>) => {
        return (_request: GatewayRequest): Promise<NormalizedResponse> => {
          return Promise.reject(gatewayError);
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
        evidenceAggregator: { record },
      },
    );
    const eventHub = new CodingRuntimeEventHub();
    const runtimeDeps = {
      ...deps,
      codingRuntimeEventHub: eventHub,
      codingRuntimeOrchestrator: {
        getSnapshot: () => ({ state: "running", revision: 3 }),
      } as unknown as UiHandlerDeps["codingRuntimeOrchestrator"],
    } as UiHandlerDeps;

    const result = await handleCodingSidecarGatewayChatCompletions(
      routeContext({
        messages: [{ role: "user", content: "continue" }],
      }),
      runtimeDeps,
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
    expect(codingPut).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith({
      runId: "run-gateway-test",
      outcome: "failed",
      completionTokens: 0,
      outputBytes: 0,
    });
    expect(diagnostics.record).toHaveBeenCalledTimes(1);
    expect(diagnostics.record).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "coding-sidecar-gateway.chat",
        errorClass: "ProviderError",
        code: "GATEWAY_PROVIDER_ERROR",
        gatewayRequestId: "gateway-request-1",
        correlationId: "run-gateway-test",
        message: "server-operation-failed",
      }),
    );
    const replay = eventHub.replay("run-gateway-test");
    expect(replay.ok && replay.events).toMatchObject([
      { kind: "runtime-event", eventKind: "failure-redacted", failureCode: "provider-failed" },
    ]);
    expect(JSON.stringify(capturedDiagnostic)).not.toContain(hostileMessage);
    expect(JSON.stringify(capturedDiagnostic)).not.toContain(
      "/Users/customer/private-repo/secret-tool",
    );
  });
});

describe("coding sidecar gateway turn failure projection", () => {
  afterEach(resetServerLogger);

  it("keeps concurrent failed requests distinct beneath their shared run", async () => {
    const sink = captureServerLog("warn");
    const diagnostics = { record: vi.fn<(record: ServerDiagnosticRecord) => void>() };
    const deps = {
      ...depsValue(
        configValue(provider(), capability()),
        (): (() => Promise<NormalizedResponse>) => (): Promise<NormalizedResponse> =>
          Promise.reject(new ProviderError("synthetic unavailable", 503)),
        {},
        undefined,
        { diagnostics },
      ),
      codingRuntimeOrchestrator: {
        getSnapshot: () => ({ state: "running", revision: 3 }),
      } as unknown as UiHandlerDeps["codingRuntimeOrchestrator"],
    } as UiHandlerDeps;
    const contexts = ["request-chat-a", "request-chat-b"].map((correlationId): RouteContext => ({
      ...routeContext({ messages: [{ role: "user", content: "synthetic" }] }),
      correlationId,
    }));
    await Promise.all(
      contexts.map((context) => handleCodingSidecarGatewayChatCompletions(context, deps)),
    );
    expect(diagnostics.record.mock.calls.map(([record]) => record)).toMatchObject([
      { correlationId: "request-chat-a", parentCorrelationId: "run-gateway-test" },
      { correlationId: "request-chat-b", parentCorrelationId: "run-gateway-test" },
    ]);
    expect(
      sink.events
        .filter((event) => event.op === "coding-sidecar.gateway.turn-failed")
        .map((event) => ({
          correlationId: event.correlationId,
          parentCorrelationId: event.parentCorrelationId,
        })),
    ).toEqual([
      { correlationId: "request-chat-a", parentCorrelationId: "run-gateway-test" },
      { correlationId: "request-chat-b", parentCorrelationId: "run-gateway-test" },
    ]);
  });

  it("records a failed SSE projection for an active run when the event hub is unavailable", async () => {
    const sink = captureServerLog("warn");
    const deps: UiHandlerDeps = {
      ...depsValue(
        configValue(provider(), capability()),
        () => () => Promise.reject(new ProviderError("synthetic unavailable", 503)),
      ),
      codingRuntimeOrchestrator: {
        getSnapshot: () => ({ state: "running", revision: 4 }),
      } as unknown as UiHandlerDeps["codingRuntimeOrchestrator"],
    };
    await handleCodingSidecarGatewayChatCompletions(
      routeContext({ messages: [{ role: "user", content: "synthetic" }] }),
      deps,
    );
    expect(
      sink.events.find((event) => event.op === "coding-sidecar.gateway.turn-failed"),
    ).toMatchObject({
      correlationId: "run-gateway-test",
      extra: {
        runId: "run-gateway-test",
        revision: 4,
        published: false,
        publicationReason: "event-hub-unavailable",
      },
    });
  });

  it("records capacity pressure when a critical turn failure cannot be retained", async () => {
    const sink = captureServerLog("warn");
    const eventHub = new CodingRuntimeEventHub({ maxEvents: 1 });
    eventHub.publishTurnFailure("run-gateway-test", "running", 1, "provider-failed");
    const deps: UiHandlerDeps = {
      ...depsValue(
        configValue(provider(), capability()),
        () => () => Promise.reject(new ProviderError("synthetic unavailable", 503)),
      ),
      codingRuntimeEventHub: eventHub,
      codingRuntimeOrchestrator: {
        getSnapshot: () => ({ state: "running", revision: 1 }),
      } as unknown as UiHandlerDeps["codingRuntimeOrchestrator"],
    };
    await handleCodingSidecarGatewayChatCompletions(
      routeContext({ messages: [{ role: "user", content: "synthetic" }] }),
      deps,
    );
    expect(
      sink.events.find((event) => event.op === "coding-sidecar.gateway.turn-failed")?.extra,
    ).toMatchObject({ published: false, publicationReason: "capacity-pressure" });
  });

  it("classifies a local spend rejection as a rejected turn", async () => {
    const sink = captureServerLog("warn");
    const deps: UiHandlerDeps = {
      ...depsValue(
        configValue(provider(), capability()),
        () => () => Promise.reject(new ConfigInvalidError("spend-budget-exceeded")),
      ),
      codingRuntimeOrchestrator: {
        getSnapshot: () => ({ state: "running", revision: 3 }),
      } as unknown as UiHandlerDeps["codingRuntimeOrchestrator"],
    };
    await handleCodingSidecarGatewayChatCompletions(
      routeContext({ messages: [{ role: "user", content: "synthetic" }] }),
      deps,
    );
    expect(
      sink.events.find((event) => event.op === "coding-sidecar.gateway.turn-failed")?.extra,
    ).toMatchObject({ failureCode: "turn-rejected" });
  });

  it("classifies a streaming spend rejection before provider dispatch as a rejected turn", async () => {
    const sink = captureServerLog("warn");
    const stream = (): AsyncIterable<GatewayStreamChunk> => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new ConfigInvalidError("spend-budget-exceeded")),
      }),
    });
    const deps = {
      ...runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-stream-spend" } }),
        undefined,
        createOpenCodeGatewayReadinessRegistry(),
        (): (() => AsyncIterable<GatewayStreamChunk>) => stream,
      ),
      codingRuntimeOrchestrator: {
        getSnapshot: () => ({ state: "running", revision: 3 }),
      } as unknown as UiHandlerDeps["codingRuntimeOrchestrator"],
    } as UiHandlerDeps;
    const result = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        stream: true,
        messages: [{ role: "user", content: "synthetic" }],
        tools: modelVisibleTools(),
      }),
      deps,
    );
    expect(result).toBe(STREAMING);
    expect(
      sink.events.find((event) => event.op === "coding-sidecar.gateway.turn-failed")?.extra,
    ).toMatchObject({ failureCode: "turn-rejected" });
  });

  it.each([
    new AuthenticationError("synthetic authentication failure"),
    new RateLimitError("synthetic rate limit"),
    new CircuitOpenError("synthetic circuit open"),
  ])("classifies streamed %s as a provider failure", async (error) => {
    const sink = captureServerLog("warn");
    const stream = (): AsyncIterable<GatewayStreamChunk> => ({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }),
    });
    const deps = {
      ...runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-stream-provider" } }),
        undefined,
        createOpenCodeGatewayReadinessRegistry(),
        (): (() => AsyncIterable<GatewayStreamChunk>) => stream,
      ),
      codingRuntimeOrchestrator: {
        getSnapshot: () => ({ state: "running", revision: 3 }),
      } as unknown as UiHandlerDeps["codingRuntimeOrchestrator"],
    } as UiHandlerDeps;
    await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        stream: true,
        messages: [{ role: "user", content: "synthetic" }],
        tools: modelVisibleTools(),
      }),
      deps,
    );
    expect(
      sink.events.find((event) => event.op === "coding-sidecar.gateway.turn-failed")?.extra,
    ).toMatchObject({ failureCode: "provider-failed" });
  });

  it.each([
    [new ProviderError("synthetic unavailable", 503), "provider-failed"],
    [new ProviderError("empty assistant stream", 200), "stream-incomplete"],
    // #3591 (1.1.7): the budget ran out before any content — a budget to raise, not a broken stream.
    [new ProviderOutputExhaustedError("coding"), "output-exhausted"],
    [new TimeoutError("synthetic timeout"), "stream-incomplete"],
    [new ContextOverflowError("synthetic context limit"), "turn-rejected"],
  ] as const)("projects %s as %s without exposing provider text", async (error, code) => {
    const sink = captureServerLog("warn");
    const eventHub = new CodingRuntimeEventHub();
    const deps: UiHandlerDeps = {
      ...depsValue(configValue(provider(), capability()), () => () => Promise.reject(error)),
      codingRuntimeEventHub: eventHub,
      codingRuntimeOrchestrator: {
        getSnapshot: () => ({ state: "running", revision: 2 }),
      } as unknown as UiHandlerDeps["codingRuntimeOrchestrator"],
    };
    const result = await handleCodingSidecarGatewayChatCompletions(
      routeContext({ messages: [{ role: "user", content: "synthetic" }] }),
      deps,
    );
    expect(result).toMatchObject({ status: 503 });
    const replay = eventHub.replay("run-gateway-test");
    expect(replay.ok && replay.events).toMatchObject([{ failureCode: code }]);
    expect(JSON.stringify(replay)).not.toContain(error.message);
    const projected = sink.events.find(
      (event) => event.op === "coding-sidecar.gateway.turn-failed",
    );
    expect(projected).toMatchObject({
      correlationId: "run-gateway-test",
      extra: { runId: "run-gateway-test", revision: 2, failureCode: code, published: true },
    });
    expectActivityLogProof(
      "coding-sidecar.gateway.turn-failed.emitted-line",
      formatActivityLogProofLine(projected ?? {}),
    );
  });
});

// #3390 closeout: every 400/403 rejection the gateway route hands back must leave a body-free
// activity-log line carrying the REASON (AGENTS.md §8) — before this the only evidence was the
// generic `http`/`request` line's opaque status. These pin the two rejection classes the task
// names explicitly; `classifyBadRequestReason`/`emitGatewayToolContractDiagnostic` cover the rest.
describe("coding sidecar gateway rejection activity log", () => {
  afterEach(() => {
    resetServerLogger();
  });

  it("classifies an unknown rejection separately without changing its wire response", () => {
    const result: RouteResult = {
      status: 400,
      body: { error: { code: "FUTURE_REJECTION", message: "Future fixed rejection text." } },
    };
    const wire = structuredClone(result);

    expect(_classifyBadRequestReasonForTests(result)).toBe("unclassified-rejection");
    expect(result).toEqual(wire);
  });

  it("keeps invalid JSON on the explicit body-not-json evidence path without changing its wire response", async () => {
    const sink = captureServerLog("warn");
    const deps = depsValue(configValue(provider(), capability()));

    const result = await handleCodingSidecarGatewayChatCompletions(routeContext("{"), deps);

    expect(result).toEqual({
      status: 400,
      body: { error: { code: "BAD_REQUEST", message: "Request body is not valid JSON." } },
    });
    expect(sink.events).toEqual([
      expect.objectContaining({
        op: "coding-sidecar.gateway.rejected",
        status: 400,
        errorKind: "invalid-request",
        extra: {
          reason: "body-not-json",
          runId: "run-gateway-test",
          completeness: "complete",
          loss: "none",
        },
      }),
    ]);
    expect(
      activityLogEventRegistration(
        sink.events[0] as unknown as Readonly<Record<PropertyKey, unknown>>,
      ),
    ).toBeDefined();
  });

  it("logs a body-free rejection line when estimated prompt tokens exceed the profile budget", async () => {
    const sink = captureServerLog("warn");
    const deps = depsValue(configValue(provider(), capability({ contextWindow: 16 })));

    const result = await handleCodingSidecarGatewayChatCompletions(
      routeContext({ messages: [{ role: "user", content: "x".repeat(400) }] }),
      deps,
    );

    expect(result).toMatchObject({ status: 400 });
    const estimatedPromptTokens = sink.events[0]?.extra?.estimatedPromptTokens;
    expect(typeof estimatedPromptTokens).toBe("number");
    // The bound the prompt was admitted against sits below the raw window (#3591 review).
    const admissible = sink.events[0]?.extra?.admissiblePromptTokens;
    expect(typeof admissible).toBe("number");
    expect(admissible).toBeLessThan(16);
    expect(sink.events).toEqual([
      {
        level: "warn",
        category: "gateway",
        op: "coding-sidecar.gateway.rejected",
        correlationId: "unknown-correlation-id",
        parentCorrelationId: "run-gateway-test",
        durationMs: undefined,
        status: 400,
        errorKind: "invalid-request",
        extra: {
          reason: "prompt-tokens-exceeded",
          runId: "run-gateway-test",
          estimatedPromptTokens,
          maxPromptTokens: 16,
          admissiblePromptTokens: admissible,
          inputMessageCount: 1,
          maxInputMessages: 512,
          completeness: "complete",
          loss: "none",
        },
      },
    ]);
    expect(JSON.stringify(sink.events)).not.toContain("x".repeat(100));
  });

  it("logs body-free observed bounds when the input message count exceeds the profile", async () => {
    const sink = captureServerLog("warn");
    const deps = depsValue(configValue(provider(), capability()));

    const result = await handleCodingSidecarGatewayChatCompletions(
      routeContext({
        messages: Array.from({ length: 513 }, () => ({ role: "user", content: "private" })),
      }),
      deps,
    );

    expect(result).toMatchObject({ status: 400 });
    const estimatedPromptTokens = sink.events[0]?.extra?.estimatedPromptTokens;
    expect(typeof estimatedPromptTokens).toBe("number");
    expect(sink.events).toEqual([
      expect.objectContaining({
        op: "coding-sidecar.gateway.rejected",
        status: 400,
        errorKind: "invalid-request",
        extra: {
          reason: "input-messages-exceeded",
          runId: "run-gateway-test",
          estimatedPromptTokens,
          maxPromptTokens: 128_000,
          admissiblePromptTokens: admissiblePromptTokens({
            maxPromptTokens: 128_000,
            maxOutputTokens: 4_096,
          }),
          inputMessageCount: 513,
          maxInputMessages: 512,
          completeness: "complete",
          loss: "none",
        },
      }),
    ]);
    expect(JSON.stringify(sink.events)).not.toContain("private");
  });

  it("logs a body-free count-and-digest proof for a tool-contract-drift rejection", async () => {
    const sink = captureServerLog("warn");
    const deps = runtimeGatewayDeps(() => ({ ok: true, binding: { runId: "run-1" } }));

    const result = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        messages: [{ role: "user", content: "private runtime content" }],
        tools: modelVisibleTools().slice(0, 2),
      }),
      deps,
    );

    expect(result).toMatchObject({ status: 403 });
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      level: "warn",
      category: "gateway",
      op: "coding-sidecar.gateway.rejected",
      correlationId: "unknown-correlation-id",
      status: 403,
      extra: {
        reason: "tool-contract-drift",
        runId: "run-1",
        expectedToolCount: 18,
        receivedToolCount: 2,
        unexpectedToolCount: 0,
        missingToolCount: 16,
        completeness: "complete",
        loss: "none",
      },
    });
    expect(sink.events[0]?.errorKind).toBe("authority-denied");
    expect(sink.events[0]?.extra?.toolMismatchSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      activityLogEventRegistration(
        sink.events[0] as unknown as Readonly<Record<PropertyKey, unknown>>,
      ),
    ).toBeDefined();
    expect(JSON.stringify(sink.events)).not.toContain("private runtime content");
  });

  it("never preserves a caller-selected unexpected tool name in rejection evidence", async () => {
    const sink = captureServerLog("warn");
    const hostileToolName = "private_customer_token_123";
    const deps = runtimeGatewayDeps(() => ({ ok: true, binding: { runId: "run-hostile" } }));

    const result = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        messages: [{ role: "user", content: "private runtime content" }],
        tools: modelVisibleTools([{ name: hostileToolName, parameters: { type: "object" } }]),
      }),
      deps,
    );

    expect(result).toMatchObject({ status: 403 });
    expect(sink.events[0]?.extra).toMatchObject({
      unexpectedToolCount: 1,
      missingToolCount: 18,
      completeness: "complete",
      loss: "none",
    });
    expect(sink.events[0]?.extra?.toolMismatchSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(sink.events)).not.toContain(hostileToolName);
    expect(JSON.stringify(sink.events)).not.toContain("private runtime content");
  });

  // #3390 root cause: the server sends the first turn as TWO text parts (opencodeHttpClient.ts
  // `promptParts`: the task text plus the issue context as a synthetic part), so OpenCode's
  // AI-SDK provider forwards the outgoing user message as an OpenAI content-part ARRAY instead of
  // a bare string. `parseMessageBase` accepted only `typeof content === "string"`, dropping the
  // entry, so `parseMessages` returned `undefined` and the request was refused 400 under the
  // misleading `body-empty-messages` reason -- every real ISSUE-BOUND run died on its first model
  // call while a bare-string run (no issue context) never hit this path. These four tests pin the
  // fix: the two-text-part shape is accepted and joined, a non-text part is rejected under its own
  // reason, an unparsable entry is distinguished from an empty array, and the two previously
  // unlogged 403 refusals now leave the same body-free rejection line as every other one.
  it("keeps a plain string message content unchanged (regression: the multipart fix must not alter the pre-existing single-part path)", async () => {
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
        messages: [{ role: "user", content: "bounded task" }],
      }),
      deps,
    );

    assertRouteResult(result);
    expect(result.status).toBe(200);
    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]?.messages).toEqual([{ role: "user", content: "bounded task" }]);
  });

  it("accepts a user message whose content is the OpenAI content-part ARRAY OpenCode's AI-SDK provider sends for a multi-part prompt, joining the parts into one string", async () => {
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
        messages: [
          {
            role: "user",
            // Real producer shape, pinned in opencodeHttpClient.test.ts's
            // "pins the two-part prompt shape sent for a prompt with initial context".
            content: [
              { type: "text", text: "bounded task" },
              { type: "text", text: "issue context", synthetic: true },
            ],
          },
        ],
      }),
      deps,
    );

    assertRouteResult(result);
    expect(result.status).toBe(200);
    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]?.messages).toEqual([
      { role: "user", content: "bounded task\n\nissue context" },
    ]);
  });

  it("logs a body-free rejection line and returns BAD_REQUEST content-part-unsupported for a non-text content part", async () => {
    const sink = captureServerLog("warn");
    const deps = depsValue(configValue(provider(), capability()));

    const result = await handleCodingSidecarGatewayChatCompletions(
      routeContext({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "bounded task" },
              { type: "image_url", image_url: { url: "https://example.invalid/x.png" } },
            ],
          },
        ],
      }),
      deps,
    );

    expect(result).toEqual({
      status: 400,
      body: {
        error: {
          code: "BAD_REQUEST",
          message: "Request body message content included an unsupported content part.",
        },
      },
    });
    expect(sink.events).toEqual([
      {
        level: "warn",
        category: "gateway",
        op: "coding-sidecar.gateway.rejected",
        correlationId: "unknown-correlation-id",
        parentCorrelationId: "run-gateway-test",
        durationMs: undefined,
        status: 400,
        errorKind: "invalid-request",
        extra: {
          reason: "content-part-unsupported",
          runId: "run-gateway-test",
          completeness: "complete",
          loss: "none",
        },
      },
    ]);
  });

  it("logs a body-free rejection line and returns BAD_REQUEST message-shape-invalid for an unparsable message entry, distinct from an empty messages array", async () => {
    const sink = captureServerLog("warn");
    const deps = depsValue(configValue(provider(), capability()));

    const result = await handleCodingSidecarGatewayChatCompletions(
      routeContext({ messages: [{ role: "user" }] }),
      deps,
    );

    expect(result).toEqual({
      status: 400,
      body: {
        error: {
          code: "BAD_REQUEST",
          message: "Request body messages must be well-formed chat messages (entries: 1).",
        },
      },
    });
    expect(sink.events).toEqual([
      {
        level: "warn",
        category: "gateway",
        op: "coding-sidecar.gateway.rejected",
        correlationId: "unknown-correlation-id",
        parentCorrelationId: "run-gateway-test",
        durationMs: undefined,
        status: 400,
        errorKind: "invalid-request",
        extra: {
          reason: "message-shape-invalid",
          runId: "run-gateway-test",
          completeness: "complete",
          loss: "none",
        },
      },
    ]);
  });

  it("logs a body-free rejection line for a browser-origin request refused before authentication runs", async () => {
    const sink = captureServerLog("warn");
    const deps = depsValue(configValue(provider(), capability()));

    const result = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext(
        { messages: [{ role: "user", content: "continue" }] },
        "https://example.invalid",
      ),
      deps,
    );

    expect(result).toEqual({
      status: 403,
      body: { error: { code: "FORBIDDEN", message: "Coding sidecar gateway request is denied." } },
    });
    expect(sink.events).toEqual([
      {
        level: "warn",
        category: "gateway",
        op: "coding-sidecar.gateway.rejected",
        correlationId: "unknown-correlation-id",
        durationMs: undefined,
        status: 403,
        errorKind: "authority-denied",
        extra: { reason: "origin-not-allowed", completeness: "complete", loss: "none" },
      },
    ]);
  });

  it("logs a body-free rejection line when the runtime prompt-budget reservation is denied", async () => {
    const sink = captureServerLog("warn");
    const deps: UiHandlerDeps = {
      ...depsValue(configValue(provider(), capability())),
      runtimeCapabilityAuthenticator: {
        authenticate: (capability: string, audience: "model-gateway" | "tool-facade") =>
          capability === "gateway-capability-material-0000000001" && audience === "model-gateway"
            ? { ok: true, binding: { runId: "run-gateway-test" } }
            : { ok: false },
        reservePromptTokens: () => ({ ok: false }),
      },
    };

    const result = await handleCodingSidecarGatewayChatCompletions(
      routeContext({ messages: [{ role: "user", content: "continue" }] }),
      deps,
    );

    expect(result).toEqual({
      status: 403,
      body: { error: { code: "FORBIDDEN", message: "Coding sidecar gateway request is denied." } },
    });
    expect(sink.events).toEqual([
      {
        level: "warn",
        category: "gateway",
        op: "coding-sidecar.gateway.rejected",
        correlationId: "unknown-correlation-id",
        parentCorrelationId: "run-gateway-test",
        durationMs: undefined,
        status: 403,
        errorKind: "authority-denied",
        extra: {
          reason: "runtime-prompt-budget-denied",
          runId: "run-gateway-test",
          completeness: "complete",
          loss: "none",
        },
      },
    ]);
  });
});

// #3390 closeout: a profile can be "available" per config and probe yet still be unusable because
// its derived `maxPromptTokens` cannot survive one real request. The readiness projection must
// demote it to a closed, named reason instead of reporting "ready".
describe("coding sidecar gateway readiness — insufficient context window", () => {
  afterEach(() => {
    resetServerLogger();
  });

  function profileContext(): RouteContext {
    return {
      req: mockRequest({ method: "GET", url: "/api/coding-sidecar/gateway/profile" }),
      res: mockResponse().res,
      params: {},
      url: new URL("http://127.0.0.1/api/coding-sidecar/gateway/profile"),
      correlationId: undefined,
    } satisfies RouteContext;
  }

  it.each([false, true])(
    "records passive tool-capability refusal without probing: %s",
    async (declared) => {
      const sink = captureServerLog("warn");
      const chat = vi.fn();
      const { toolCallingVerification: _verification, ...unverified } = capability();
      const result = await handleCodingSidecarGatewayProfile(
        { ...profileContext(), correlationId: "passive-profile-0001" },
        depsValue(configValue(provider(), { ...unverified, toolCalling: declared }), chat),
      );
      const reason = declared ? "tool-calling-unverified" : "no-tool-calling";
      expect(result.body).toMatchObject({ status: "unavailable", reason });
      expect(chat).not.toHaveBeenCalled();
      const line = expectActivityLogProof(
        "coding-sidecar.gateway.readiness-insufficient.line",
        formatActivityLogProofLine(sink.events[0] ?? {}),
      );
      expect(line).toMatchObject({
        correlationId: "passive-profile-0001",
        errorKind: "unavailable",
        reason,
        probeMode: "passive",
      });
      expect(JSON.stringify(line)).not.toContain("apiKey");
    },
  );

  it("demotes an available profile whose setup-placeholder capability cannot survive one request", async () => {
    const sink = captureServerLog("warn");
    // #3390 live incident: a coding-safe model configured with the setup placeholder capability
    // (contextWindow 4096 / maxOutputTokens 0) reported "available" and died on the first gateway
    // call with "estimated prompt tokens exceed profile maxPromptTokens (4096)".
    const deps = depsValue(
      configValue(provider(), capability({ contextWindow: 4_096, maxOutputTokens: 0 })),
    );

    const result = await handleCodingSidecarGatewayProfile(profileContext(), deps);

    expect(result).toEqual({
      status: 200,
      body: { status: "unavailable", reason: "model-context-window-insufficient" },
    });
    expect(sink.events).toEqual([
      {
        level: "warn",
        category: "gateway",
        op: "coding-sidecar.gateway.readiness-insufficient",
        correlationId: "unknown-correlation-id",
        parentCorrelationId: undefined,
        durationMs: undefined,
        status: undefined,
        errorKind: "unavailable",
        extra: {
          reason: "model-context-window-insufficient",
          probeMode: "passive",
          maxPromptTokens: 4_096,
          minimumRequiredPromptTokens: 32_000,
          completeness: "complete",
          loss: "none",
        },
      },
    ]);
    expect(
      activityLogEventRegistration(
        sink.events[0] as unknown as Readonly<Record<PropertyKey, unknown>>,
      ),
    ).toBeDefined();
    const persistedReadiness = expectActivityLogProof(
      "coding-sidecar.gateway.readiness-insufficient.line",
      formatActivityLogProofLine(sink.events[0] ?? {}),
    );
    expect(persistedReadiness).toMatchObject({
      reason: "model-context-window-insufficient",
      maxPromptTokens: 4_096,
      minimumRequiredPromptTokens: 32_000,
    });
  });

  it("keeps reporting available when the derived prompt budget clears the minimum", async () => {
    const sink = captureServerLog("warn");
    const deps = depsValue(configValue(provider(), capability()));

    const result = await handleCodingSidecarGatewayProfile(profileContext(), deps);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: "available" });
    expect(sink.events).toHaveLength(0);
  });

  it("keeps the repository's real 32k coding profile available", async () => {
    const sink = captureServerLog("warn");
    const deps = depsValue(
      configValue(provider(), capability({ contextWindow: 32_000, maxOutputTokens: 2_048 })),
    );

    const result = await handleCodingSidecarGatewayProfile(profileContext(), deps);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      status: "available",
      runMetadata: { maxPromptTokens: 32_000 },
    });
    expect(sink.events).toHaveLength(0);
  });
});

// Monetary admission regression pins now live at the shared owning boundary:
// gateway-spend-budget.test.ts and keiko-model-gateway/src/gateway.spend-budget.test.ts.
// Those tests use real Gateway dispatch, including independent sources, retries and restart;
// a codingSidecarGatewayChatFactory replacement would bypass that production boundary.

// ─── #3384 wave-3 W3-3 "needs": runtime prompt-token settlement wiring ──────────
// `settleRuntimePromptTokens` (agentAuthorityRegistry.ts) had zero production callers before this
// change — the gateway reserved the pre-call ESTIMATE before dispatch but never reconciled it
// against the provider's real reported usage, so a run's retained authority-level prompt budget
// permanently over-counted by (estimate - actual) on every single call.
describe("coding-sidecar gateway runtime prompt-token settlement", () => {
  afterEach(resetServerLogger);
  function promptSettlementRequest(): RouteContext {
    return authenticatedContext({
      model: "azure-coding-model",
      messages: [{ role: "user", content: "continue the coding task, please, thank you" }],
      tools: [],
    });
  }

  it(
    "settles the runtime prompt-token reservation with the provider's real reported usage " +
      "across repeated calls, never the pre-call estimate reused as if it were the actual",
    async () => {
      const sink = captureServerLog("info");
      const chat = vi.fn(() => Promise.resolve(assistantResponse("azure-coding-model")));
      const reservedEstimates: number[] = [];
      const settlements: { reservedPromptTokens: number; actualPromptTokens: number }[] = [];
      const deps: UiHandlerDeps = {
        ...depsValue(configValue(provider(), capability()), () => chat),
        runtimeCapabilityAuthenticator: {
          authenticate: (authCapability: string, audience: "model-gateway" | "tool-facade") =>
            authCapability === "gateway-capability-material-0000000001" &&
            audience === "model-gateway"
              ? { ok: true, binding: { runId: "run-gateway-test" } }
              : { ok: false },
          reservePromptTokens: (_authCapability: string, promptTokens: number): unknown => {
            reservedEstimates.push(promptTokens);
            return { ok: true, runId: "run-gateway-test" };
          },
          settlePromptTokens: (
            _authCapability: string,
            reservedPromptTokens: number,
            actualPromptTokens: number,
          ): unknown => {
            settlements.push({ reservedPromptTokens, actualPromptTokens });
            return { ok: true, runId: "run-gateway-test" };
          },
        },
      };

      const first = await handleCodingSidecarGatewayChatCompletions(
        promptSettlementRequest(),
        deps,
      );
      const second = await handleCodingSidecarGatewayChatCompletions(
        promptSettlementRequest(),
        deps,
      );

      expect(first).toMatchObject({ status: 200 });
      expect(second).toMatchObject({ status: 200 });
      expect(chat).toHaveBeenCalledTimes(2);
      expect(reservedEstimates).toHaveLength(2);
      expect(settlements).toHaveLength(2);
      // Guard the fixture itself: the estimate must differ from the provider's real usage or the
      // assertions below could pass even with the old bug (settling the estimate as the actual).
      expect(reservedEstimates[0]).not.toBe(assistantResponse("x").usage.promptTokens);
      for (const [index, settlement] of settlements.entries()) {
        expect(settlement.reservedPromptTokens).toBe(reservedEstimates[index]);
        // assistantResponse's real usage.promptTokens is 12 on every call.
        expect(settlement.actualPromptTokens).toBe(12);
      }
      const totalSettledActual = settlements.reduce((sum, s) => sum + s.actualPromptTokens, 0);
      const totalEstimate = reservedEstimates.reduce((sum, value) => sum + value, 0);
      expect(totalSettledActual).toBe(24);
      expect(totalSettledActual).not.toBe(totalEstimate);
      const usageLines = sink.events.filter(
        (event) => event.op === "coding-sidecar.gateway.usage-settled",
      );
      expect(usageLines).toHaveLength(2);
      for (const line of usageLines) {
        expect(line.extra).toMatchObject({
          promptTokens: 12,
          promptSource: "provider-reported",
          promptSettlementStatus: "settled",
        });
      }
    },
  );

  it("settles conservatively (the full reserved estimate) when the provider call fails before usage is observed", async () => {
    const chat = vi.fn(() => Promise.reject(new Error("provider unavailable")));
    const settlements: { reservedPromptTokens: number; actualPromptTokens: number }[] = [];
    const deps: UiHandlerDeps = {
      ...depsValue(configValue(provider(), capability()), () => chat),
      runtimeCapabilityAuthenticator: {
        authenticate: () => ({ ok: true, binding: { runId: "run-gateway-test" } }),
        reservePromptTokens: () => ({ ok: true, runId: "run-gateway-test" }),
        settlePromptTokens: (
          _authCapability: string,
          reservedPromptTokens: number,
          actualPromptTokens: number,
        ): unknown => {
          settlements.push({ reservedPromptTokens, actualPromptTokens });
          return { ok: true, runId: "run-gateway-test" };
        },
      },
    };

    await handleCodingSidecarGatewayChatCompletions(promptSettlementRequest(), deps);

    expect(settlements).toHaveLength(1);
    expect(settlements[0]?.actualPromptTokens).toBe(settlements[0]?.reservedPromptTokens);
  });

  it("keeps the full reservation when a successful compatible stream reports no usage", async () => {
    const sink = captureServerLog("info");
    const answer = assistantResponse("azure-coding-model");
    const chat = vi.fn(() =>
      Promise.resolve({
        ...answer,
        usage: { ...answer.usage, promptTokens: 0 },
      }),
    );
    const settlePromptTokens =
      vi.fn<(capability: string, reserved: number, actual: number) => void>();
    const deps: UiHandlerDeps = {
      ...depsValue(configValue(provider(), capability()), () => chat),
      runtimeCapabilityAuthenticator: {
        authenticate: () => ({ ok: true, binding: { runId: "run-gateway-test" } }),
        reservePromptTokens: () => ({ ok: true, runId: "run-gateway-test" }),
        settlePromptTokens,
      },
    };

    const result = await handleCodingSidecarGatewayChatCompletions(promptSettlementRequest(), deps);

    expect(result).toMatchObject({ status: 200 });
    expect(settlePromptTokens).toHaveBeenCalledOnce();
    const [, reserved, actual] = settlePromptTokens.mock.calls[0] ?? [];
    expect(actual).toBeGreaterThan(0);
    expect(actual).toBe(reserved);
    expect(
      sink.events.find((event) => event.op === "coding-sidecar.gateway.usage-settled")?.extra,
    ).toMatchObject({
      promptTokens: actual,
      promptSource: "reserved-estimate",
    });
  });

  it("records a retained reservation when authority refuses settlement after a pause", async () => {
    const sink = captureServerLog("info");
    const reservedEstimates: number[] = [];
    const deps: UiHandlerDeps = {
      ...depsValue(
        configValue(provider(), capability()),
        () => () => Promise.resolve(assistantResponse("azure-coding-model")),
      ),
      runtimeCapabilityAuthenticator: {
        authenticate: () => ({ ok: true, binding: { runId: "run-gateway-test" } }),
        reservePromptTokens: (_capability: string, count: number) => {
          reservedEstimates.push(count);
          return { ok: true, runId: "run-gateway-test" };
        },
        settlePromptTokens: () => ({ ok: false, reason: "authority-resolution-failed" }),
      },
    };
    const result = await handleCodingSidecarGatewayChatCompletions(promptSettlementRequest(), deps);
    expect(result).toMatchObject({ status: 200 });
    expect(reservedEstimates[0]).toBeGreaterThan(12);
    expect(
      sink.events.find((event) => event.op === "coding-sidecar.gateway.usage-settled")?.extra,
    ).toMatchObject({
      promptTokens: reservedEstimates[0],
      promptSource: "reserved-estimate",
      promptSettlementStatus: "retained-after-refusal",
    });
  });
});

// #3591 (1.1.7): the run's output reserve is a reserve against the whole window; the allowance
// actually sent must fit into what the prompt leaves, or a 30k prompt in a 32k window would send
// an 8k allowance and a request larger than the model window.
describe("admittedOutputTokens", () => {
  const bounds = { maxPromptTokens: 32_000, maxOutputTokens: 8_000 };

  it("keeps the full reserve while the prompt leaves room for it", () => {
    expect(admittedOutputTokens(bounds, 7_000)).toBe(8_000);
  });

  it("shrinks the allowance to what remains after the prompt and the safety margin", () => {
    // 32,000 window, 1,000 safety margin at that size: 30,000 prompt leaves 1,000.
    expect(admittedOutputTokens(bounds, 30_000)).toBe(1_000);
  });

  // Review of #3591 (P1): the allowance used to floor at 512 for a prompt just under the window,
  // which sent 512 output tokens PAST the proven window. Admission now stops such a prompt, and
  // the largest admissible prompt still gets exactly the minimum allowance.
  it("grants the largest admissible prompt exactly the minimum allowance", () => {
    // 32,000 window, 1,000 safety margin, 512 minimum: 30,488 is the last admissible prompt.
    expect(admissiblePromptTokens(bounds)).toBe(30_488);
    expect(admittedOutputTokens(bounds, admissiblePromptTokens(bounds))).toBe(
      MINIMUM_ADMITTED_OUTPUT_TOKENS,
    );
    expect(
      admissiblePromptTokens(bounds) +
        admittedOutputTokens(bounds, admissiblePromptTokens(bounds)) +
        1_000,
    ).toBe(bounds.maxPromptTokens);
  });

  it("reserves the whole output budget when it is smaller than the minimum allowance", () => {
    const tiny = { maxPromptTokens: 128_000, maxOutputTokens: 4 };
    // 4,000 safety margin at that size, then the 4-token reserve.
    expect(admissiblePromptTokens(tiny)).toBe(128_000 - 4_000 - 4);
    expect(admittedOutputTokens(tiny, admissiblePromptTokens(tiny))).toBe(4);
  });

  it("never exceeds the run's reserve, even a reserve below the floor", () => {
    expect(admittedOutputTokens({ maxPromptTokens: 128_000, maxOutputTokens: 8_000 }, 10)).toBe(
      8_000,
    );
    expect(admittedOutputTokens({ maxPromptTokens: 128_000, maxOutputTokens: 4 }, 10)).toBe(4);
  });
});
