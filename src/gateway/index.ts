// Public barrel for the model gateway: all types, the Gateway orchestrator, the
// capability registry helpers, config loaders, and the typed error taxonomy.

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
  findCapability,
  listCapabilities,
  selectCheapest,
  type CapabilityQuery,
} from "./capabilities.js";

export {
  loadConfigFromFile,
  parseGatewayConfig,
  toSafeObject,
  type EnvSource,
  type SafeGatewayConfig,
  type SafeProviderConfig,
} from "./config.js";

export { Gateway, type GatewayDeps } from "./gateway.js";

export { OpenAiAdapter, type AdapterDeps } from "./openai-adapter.js";

export { CircuitBreaker, executeWithRetry, systemClock, type RetryConfig } from "./resilience.js";

export { normalizeChatResponse, type UsageSeed } from "./normalize.js";

export { redact } from "./redaction.js";

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
} from "./errors.js";
