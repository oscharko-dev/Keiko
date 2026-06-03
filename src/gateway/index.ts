// Re-export shim: the gateway barrel now lives in @oscharko-dev/keiko-model-gateway (issue #160,
// ADR-0019). All existing import sites (`from "../gateway/index.js"`) keep resolving unchanged via
// this barrel. The full public surface of the original src/gateway/index.ts is preserved.

export type {
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
} from "@oscharko-dev/keiko-model-gateway";

export {
  CAPABILITY_REGISTRY,
  createDefaultChatCapability,
  findCapability,
  listCapabilities,
  resolveCostClass,
  selectCheapest,
} from "@oscharko-dev/keiko-model-gateway";
export type { CapabilityQuery } from "@oscharko-dev/keiko-model-gateway";

export {
  apiKeyHeaderValue,
  DEFAULT_API_KEY_HEADER_NAME,
  loadConfigFromFile,
  normalizeApiKeyHeaderName,
  parseGatewayConfig,
  toSafeObject,
  validateBaseUrl,
} from "@oscharko-dev/keiko-model-gateway";
export type {
  EnvSource,
  SafeGatewayConfig,
  SafeProviderConfig,
} from "@oscharko-dev/keiko-model-gateway";

export { Gateway } from "@oscharko-dev/keiko-model-gateway";
export type { GatewayDeps } from "@oscharko-dev/keiko-model-gateway";

export { OpenAiAdapter } from "@oscharko-dev/keiko-model-gateway";
export type { AdapterDeps } from "@oscharko-dev/keiko-model-gateway";

export {
  assertConfiguredModel,
  findConfiguredCapability,
  listConfiguredCapabilities,
  selectConfiguredModel,
} from "@oscharko-dev/keiko-model-gateway";
export type { ModelSelectionQuery } from "@oscharko-dev/keiko-model-gateway";

export { CircuitBreaker, executeWithRetry, systemClock } from "@oscharko-dev/keiko-model-gateway";
export type { RetryConfig } from "@oscharko-dev/keiko-model-gateway";

export { normalizeChatResponse } from "@oscharko-dev/keiko-model-gateway";
export type { UsageSeed } from "@oscharko-dev/keiko-model-gateway";

export { redact } from "@oscharko-dev/keiko-model-gateway";

export {
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
} from "@oscharko-dev/keiko-model-gateway";
export type { ErrorCode } from "@oscharko-dev/keiko-model-gateway";
