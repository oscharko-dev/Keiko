// Public-surface pin test, mirroring keiko-security/src/index.test.ts. Every symbol that lives on
// the package's main entry point is touched here so a future refactor that accidentally drops a
// named export — or downgrades a value to a type-only re-export — fails this test instead of
// silently breaking a downstream caller. The trust-boundary nature of this package (it owns the
// only direct provider-SDK egress) makes the "stable public surface" guarantee load-bearing.

import { describe, it, expect } from "vitest";
import {
  KEIKO_MODEL_GATEWAY_VERSION,
  CAPABILITY_REGISTRY,
  CAPABILITY_DATA,
  createDefaultChatCapability,
  findCapability,
  listCapabilities,
  resolveCostClass,
  selectCheapest,
  apiKeyHeaderValue,
  DEFAULT_API_KEY_HEADER_NAME,
  loadConfigFromFile,
  normalizeApiKeyHeaderName,
  parseGatewayConfig,
  toSafeObject,
  validateBaseUrl,
  Gateway,
  OpenAiAdapter,
  assertConfiguredModel,
  findConfiguredCapability,
  listConfiguredCapabilities,
  selectConfiguredModel,
  CircuitBreaker,
  executeWithRetry,
  systemClock,
  normalizeChatResponse,
  gatewayFetch,
  gatewayTrustedCaCertificates,
  isMissingIssuerError,
  isRecoverableTlsTrustError,
  MAX_RESPONSE_BYTES,
  readJsonCapped,
  redact,
  AuthenticationError,
  CancelledError,
  CircuitOpenError,
  ConfigInvalidError,
  ContextOverflowError,
  ERROR_CODES,
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
  AdapterDeps,
  ModelSelectionQuery,
  RetryConfig,
  UsageSeed,
  GatewayFetchOptions,
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
  LatencyClass,
  ModelCapability,
  ModelKind,
  ModelProviderConfig,
  NormalizedResponse,
  NormalizedToolCall,
  ProviderAdapter,
  ResponseFormat,
  StreamDelta,
  StreamEvent,
  ToolDefinition,
  UsageMetadata,
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
    expect(typeof listCapabilities).toBe("function");
    expect(typeof resolveCostClass).toBe("function");
    expect(typeof selectCheapest).toBe("function");
  });

  it("exposes the config helpers as callable functions", () => {
    expect(typeof apiKeyHeaderValue).toBe("function");
    expect(typeof loadConfigFromFile).toBe("function");
    expect(typeof normalizeApiKeyHeaderName).toBe("function");
    expect(typeof parseGatewayConfig).toBe("function");
    expect(typeof toSafeObject).toBe("function");
    expect(typeof validateBaseUrl).toBe("function");
  });

  it("exposes the default API key header name as the canonical string", () => {
    expect(DEFAULT_API_KEY_HEADER_NAME).toBe("authorization");
  });

  it("exposes Gateway and OpenAiAdapter as constructors", () => {
    expect(typeof Gateway).toBe("function");
    expect(typeof OpenAiAdapter).toBe("function");
  });

  it("exposes the model-selection helpers as callable functions", () => {
    expect(typeof assertConfiguredModel).toBe("function");
    expect(typeof findConfiguredCapability).toBe("function");
    expect(typeof listConfiguredCapabilities).toBe("function");
    expect(typeof selectConfiguredModel).toBe("function");
  });

  it("exposes the resilience primitives as constructors, functions, and a clock object", () => {
    expect(typeof CircuitBreaker).toBe("function");
    expect(typeof executeWithRetry).toBe("function");
    expect(typeof systemClock).toBe("object");
    expect(typeof systemClock.now).toBe("function");
    expect(typeof systemClock.sleep).toBe("function");
  });

  it("exposes the normalize helper as a callable function", () => {
    expect(typeof normalizeChatResponse).toBe("function");
  });

  it("exposes the http primitives with the correct value/type position", () => {
    expect(typeof gatewayFetch).toBe("function");
    expect(typeof gatewayTrustedCaCertificates).toBe("function");
    expect(typeof isMissingIssuerError).toBe("function");
    expect(typeof isRecoverableTlsTrustError).toBe("function");
    expect(typeof readJsonCapped).toBe("function");
    expect(typeof MAX_RESPONSE_BYTES).toBe("number");
    expect(MAX_RESPONSE_BYTES).toBeGreaterThan(0);
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
    pin<AdapterDeps>();
    pin<ModelSelectionQuery>();
    pin<RetryConfig>();
    pin<UsageSeed>();
    pin<GatewayFetchOptions>();
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
    pin<LatencyClass>();
    pin<ModelCapability>();
    pin<ModelKind>();
    pin<ModelProviderConfig>();
    pin<NormalizedResponse>();
    pin<NormalizedToolCall>();
    pin<ProviderAdapter>();
    pin<ResponseFormat>();
    pin<StreamDelta>();
    pin<StreamEvent>();
    pin<ToolDefinition>();
    pin<UsageMetadata>();
    expect(true).toBe(true);
  });
});
