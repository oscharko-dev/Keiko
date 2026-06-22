// Public-surface pin test, mirroring keiko-security/src/index.test.ts. Every symbol that lives on
// the package's main entry point is touched here so a future refactor that accidentally drops a
// named export — or downgrades a value to a type-only re-export — fails this test instead of
// silently breaking a downstream caller. The trust-boundary nature of this package (it owns the
// only direct provider-SDK egress) makes the "stable public surface" guarantee load-bearing.

import { describe, it, expect } from "vitest";
import * as gateway from "./index.js";
import {
  KEIKO_MODEL_GATEWAY_VERSION,
  CAPABILITY_REGISTRY,
  CAPABILITY_DATA,
  createDefaultChatCapability,
  findCapability,
  INFILLING_ALIGNMENTS,
  isAlignedInfillingModel,
  isAsYouTypeCompletionModel,
  listCapabilities,
  modelSupportsInfilling,
  resolveCostClass,
  selectCheapest,
  selectCompletionModelFromCapabilities,
  apiKeyHeaderValue,
  DEFAULT_API_KEY_HEADER_NAME,
  loadConfigFromFile,
  loadEgressConfigFromFile,
  normalizeApiKeyHeaderName,
  parseGatewayConfig,
  resolveOutboundHttpEgressConfig,
  toSafeObject,
  validateBaseUrl,
  Gateway,
  assertConfiguredModel,
  findConfiguredCapability,
  listConfiguredCapabilities,
  selectCompletionModel,
  selectConfiguredModel,
  redact,
  AuthenticationError,
  CancelledError,
  CircuitOpenError,
  ConfigInvalidError,
  ContextOverflowError,
  ERROR_CODES,
  GatewayEgressError,
  GatewayError,
  MalformedToolCallError,
  ModelRefusalError,
  ProviderError,
  RateLimitError,
  TimeoutError,
  TransportError,
  UnknownModelError,
} from "./index.js";
import type {
  CapabilityQuery,
  EnvSource,
  SafeGatewayConfig,
  SafeProviderConfig,
  GatewayDeps,
  ModelSelectionQuery,
  ErrorCode,
  CircuitBreakerConfig,
  CircuitBreakerStatus,
  CircuitState,
  ChatMessage,
  Clock,
  CostClass,
  FinishReason,
  GatewayConfig,
  GatewayRequest,
  InfillingAlignment,
  LatencyClass,
  ModelCapability,
  ModelKind,
  ModelProviderConfig,
  NormalizedResponse,
  NormalizedToolCall,
  OutboundHttpEgressConfig,
  ProviderAdapter,
  ResponseFormat,
  StreamDelta,
  StreamEvent,
  ToolDefinition,
  UsageMetadata,
  GatewayEgressErrorCode,
  CompletionInteractionMode,
  CompletionDegradeReason,
  CompletionModelSelection,
  CompletionSelectionOptions,
} from "./index.js";

describe("keiko-model-gateway package surface", () => {
  it("exposes the version constant pinned at 0.1.0", () => {
    expect(KEIKO_MODEL_GATEWAY_VERSION).toBe("0.1.0");
  });

  it("exposes the capability registry as a frozen-shaped readonly array", () => {
    expect(Array.isArray(CAPABILITY_REGISTRY)).toBe(true);
    expect(Array.isArray(CAPABILITY_DATA)).toBe(true);
  });

  it("exposes the capability helpers as callable functions", () => {
    expect(typeof createDefaultChatCapability).toBe("function");
    expect(typeof findCapability).toBe("function");
    expect(Array.from(INFILLING_ALIGNMENTS)).toEqual(["base", "instruct", "edit-tuned"]);
    expect(typeof isAlignedInfillingModel).toBe("function");
    expect(typeof isAsYouTypeCompletionModel).toBe("function");
    expect(typeof listCapabilities).toBe("function");
    expect(typeof modelSupportsInfilling).toBe("function");
    expect(typeof resolveCostClass).toBe("function");
    expect(typeof selectCheapest).toBe("function");
    expect(typeof selectCompletionModelFromCapabilities).toBe("function");
  });

  it("exposes the config helpers as callable functions", () => {
    expect(typeof apiKeyHeaderValue).toBe("function");
    expect(typeof loadConfigFromFile).toBe("function");
    expect(typeof loadEgressConfigFromFile).toBe("function");
    expect(typeof normalizeApiKeyHeaderName).toBe("function");
    expect(typeof parseGatewayConfig).toBe("function");
    expect(typeof resolveOutboundHttpEgressConfig).toBe("function");
    expect(typeof toSafeObject).toBe("function");
    expect(typeof validateBaseUrl).toBe("function");
  });

  it("exposes the default API key header name as the canonical string", () => {
    expect(DEFAULT_API_KEY_HEADER_NAME).toBe("authorization");
  });

  it("exposes Gateway as a constructor", () => {
    expect(typeof Gateway).toBe("function");
  });

  it("does not expose the low-level provider adapter or transport helpers on the package barrel", () => {
    expect(gateway).not.toHaveProperty("OpenAiAdapter");
    expect(gateway).not.toHaveProperty("gatewayFetch");
    expect(gateway).not.toHaveProperty("gatewayTrustedCaCertificates");
    expect(gateway).not.toHaveProperty("readJsonCapped");
    expect(gateway).not.toHaveProperty("MAX_RESPONSE_BYTES");
    expect(gateway).not.toHaveProperty("CircuitBreaker");
    expect(gateway).not.toHaveProperty("executeWithRetry");
    expect(gateway).not.toHaveProperty("systemClock");
    expect(gateway).not.toHaveProperty("normalizeChatResponse");
  });

  it("exposes the model-selection helpers as callable functions", () => {
    expect(typeof assertConfiguredModel).toBe("function");
    expect(typeof findConfiguredCapability).toBe("function");
    expect(typeof listConfiguredCapabilities).toBe("function");
    expect(typeof selectCompletionModel).toBe("function");
    expect(typeof selectConfiguredModel).toBe("function");
  });

  it("exposes completion-model selection through the barrel (#1210)", () => {
    const fastAligned: ModelCapability = {
      id: "fast-instruct",
      kind: "chat",
      contextWindow: 128_000,
      maxOutputTokens: 4_096,
      toolCalling: true,
      structuredOutput: true,
      streaming: true,
      supportsImageInput: false,
      supportsDocumentInput: false,
      workflowEligible: true,
      costClass: "low",
      latencyClass: "fast",
      throughputHint: "test",
      preferredUseCases: ["completion"],
      knownLimitations: [],
      supportsInfilling: true,
      infillingAlignment: "instruct",
    };

    const selection = selectCompletionModelFromCapabilities([fastAligned]);
    expect(modelSupportsInfilling(fastAligned)).toBe(true);
    expect(isAlignedInfillingModel(fastAligned)).toBe(true);
    expect(isAsYouTypeCompletionModel(fastAligned)).toBe(true);
    expect(selection).toEqual({
      mode: "as-you-type",
      modelId: "fast-instruct",
      latencyClass: "fast",
    });
  });

  it("exposes config-bound completion-model selection through the barrel (#1210)", () => {
    const capability: ModelCapability = {
      id: "standard-edit",
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
      throughputHint: "test",
      preferredUseCases: ["completion"],
      knownLimitations: [],
      supportsInfilling: true,
      infillingAlignment: "edit-tuned",
    };
    const config: GatewayConfig = {
      providers: [
        {
          modelId: "standard-edit",
          baseUrl: "https://provider.example/v1",
          apiKey: "test-config-secret-value-1234567890",
          timeoutMs: 30_000,
          maxRetries: 3,
          retryBaseDelayMs: 500,
        },
      ],
      circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      capabilities: [capability],
    };

    expect(selectCompletionModel(config)).toEqual({
      mode: "manual",
      modelId: "standard-edit",
      latencyClass: "standard",
    });
  });

  it("re-exposes the redaction primitive from keiko-security as a callable function", () => {
    expect(typeof redact).toBe("function");
  });

  it("ERROR_CODES.AUTHENTICATION is the canonical gateway code string", () => {
    expect(ERROR_CODES.AUTHENTICATION).toBe("GATEWAY_AUTHENTICATION");
  });

  it("every safe-error class is exported as a constructor", () => {
    expect(typeof AuthenticationError).toBe("function");
    expect(typeof CancelledError).toBe("function");
    expect(typeof CircuitOpenError).toBe("function");
    expect(typeof ConfigInvalidError).toBe("function");
    expect(typeof ContextOverflowError).toBe("function");
    expect(typeof GatewayEgressError).toBe("function");
    expect(typeof GatewayError).toBe("function");
    expect(typeof MalformedToolCallError).toBe("function");
    expect(typeof ModelRefusalError).toBe("function");
    expect(typeof ProviderError).toBe("function");
    expect(typeof RateLimitError).toBe("function");
    expect(typeof TimeoutError).toBe("function");
    expect(typeof TransportError).toBe("function");
    expect(typeof UnknownModelError).toBe("function");
  });

  it("each error subclass extends GatewayError and carries an ERROR_CODES code", () => {
    const transport = new TransportError("boom");
    expect(transport).toBeInstanceOf(GatewayError);
    expect(transport.code).toBe(ERROR_CODES.TRANSPORT);
  });

  it("each type-only export is reachable by name at compile time", () => {
    // verbatimModuleSyntax requires the type imports above to be used in a type position. A
    // phantom generic `pin<T>()` references the type argument at the call site without producing
    // any runtime value, so each symbol stays load-bearing on the public surface without tripping
    // `no-unnecessary-type-assertion`.
    const pin = <T>(_value?: T): T | undefined => undefined;
    pin<CapabilityQuery>();
    pin<EnvSource>();
    pin<SafeGatewayConfig>();
    pin<SafeProviderConfig>();
    pin<GatewayDeps>();
    pin<ModelSelectionQuery>();
    pin<ErrorCode>();
    pin<CircuitBreakerConfig>();
    pin<CircuitBreakerStatus>();
    pin<CircuitState>();
    pin<ChatMessage>();
    pin<Clock>();
    pin<CostClass>();
    pin<FinishReason>();
    pin<GatewayConfig>();
    pin<GatewayRequest>();
    pin<InfillingAlignment>();
    pin<LatencyClass>();
    pin<ModelCapability>();
    pin<ModelKind>();
    pin<ModelProviderConfig>();
    pin<NormalizedResponse>();
    pin<NormalizedToolCall>();
    pin<OutboundHttpEgressConfig>();
    pin<ProviderAdapter>();
    pin<ResponseFormat>();
    pin<StreamDelta>();
    pin<StreamEvent>();
    pin<ToolDefinition>();
    pin<UsageMetadata>();
    pin<GatewayEgressErrorCode>();
    pin<CompletionInteractionMode>();
    pin<CompletionDegradeReason>();
    pin<CompletionModelSelection>();
    pin<CompletionSelectionOptions>();
    expect(true).toBe(true);
  });
});
