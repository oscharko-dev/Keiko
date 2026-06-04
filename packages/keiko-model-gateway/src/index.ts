// Public barrel for the model gateway: wire/config types, the Gateway orchestrator,
// capability helpers, config loaders, model selection, and the typed error taxonomy.
// Low-level provider adapters, HTTP transport, response normalization, and retry primitives
// are intentionally kept off this surface so productive calls cannot bypass Gateway routing.

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

export {
  assertConfiguredModel,
  findConfiguredCapability,
  listConfiguredCapabilities,
  selectConfiguredModel,
  type ModelSelectionQuery,
} from "./model-selection.js";

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
