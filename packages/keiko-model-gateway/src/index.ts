// Public barrel for the model gateway: all types, the Gateway orchestrator, the
// capability registry helpers, config loaders, and the typed error taxonomy.

export { KEIKO_MODEL_GATEWAY_VERSION } from "./version.js";

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
} from "./types.js";

export {
  CAPABILITY_REGISTRY,
  createDefaultChatCapability,
  findCapability,
  listCapabilities,
  resolveCostClass,
  selectCheapest,
  type CapabilityQuery,
} from "./capabilities.js";

export { CAPABILITY_DATA } from "./capabilities.data.js";

export {
  apiKeyHeaderValue,
  DEFAULT_API_KEY_HEADER_NAME,
  loadConfigFromFile,
  normalizeApiKeyHeaderName,
  parseGatewayConfig,
  toSafeObject,
  validateBaseUrl,
  type EnvSource,
  type SafeGatewayConfig,
  type SafeProviderConfig,
} from "./config.js";

export { Gateway, type GatewayDeps } from "./gateway.js";

export { OpenAiAdapter, type AdapterDeps } from "./openai-adapter.js";

export {
  assertConfiguredModel,
  findConfiguredCapability,
  listConfiguredCapabilities,
  selectConfiguredModel,
  type ModelSelectionQuery,
} from "./model-selection.js";

export { CircuitBreaker, executeWithRetry, systemClock, type RetryConfig } from "./resilience.js";

export { normalizeChatResponse, type UsageSeed } from "./normalize.js";

export {
  gatewayFetch,
  gatewayTrustedCaCertificates,
  isMissingIssuerError,
  isRecoverableTlsTrustError,
  MAX_RESPONSE_BYTES,
  readJsonCapped,
  type GatewayFetchOptions,
} from "./http.js";

export { redact } from "@oscharko-dev/keiko-security";

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
  type ErrorCode,
} from "@oscharko-dev/keiko-security/errors/gateway";
