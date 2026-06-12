// Public barrel for the model gateway: wire/config types, the Gateway orchestrator,
// capability helpers, config loaders, model selection, and the typed error taxonomy.
// Low-level provider adapters, HTTP transport, response normalization, and retry primitives
// for PRODUCTIVE chat calls are intentionally kept off this surface so productive calls
// cannot bypass Gateway routing.
//
// Carve-out (#192): the OpenAI-compatible embeddings transport (`requestOpenAIEmbedding`)
// IS exported as the default `OpenAIEmbeddingAdapter.request` implementation. This is the
// `OpenAIEmbeddingAdapter` injection port for `verifyEmbeddingCapability` — an out-of-band
// capability probe, not a productive model call. Productive embedding flows still compose
// the adapter behind the Local Knowledge Connector orchestrator (#196), so the Gateway-
// routing invariant is preserved.

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
  GatewayStreamChunk,
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
  explainConversationIneligibility,
  findCapability,
  isConversationEligibleModel,
  listCapabilities,
  resolveCostClass,
  selectCheapest,
  type CapabilityQuery,
  type ConversationIneligibilityReason,
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

export {
  assertCompatibleEmbeddingIdentity,
  verifyEmbeddingCapability,
  type EmbeddingCapabilityCheck,
  type EmbeddingFailureReason,
  type EmbeddingIdentityWarning,
  type EmbeddingProbeOptions,
  type OpenAIEmbeddingAdapter,
} from "./embedding.js";

export {
  requestOpenAIEmbedding,
  type OpenAIEmbeddingErrorKind,
  type OpenAIEmbeddingOutcome,
  type OpenAIEmbeddingRequest,
  type OpenAIEmbeddingSuccess,
} from "./openai-embedding-adapter.js";

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

// Quality Intelligence sub-module (Epic #270, Issue #279). Exposed under a namespace so
// callers reach typed task profiles, the prompt-segmentation seam, the capability gate,
// the safe-error taxonomy, and (post-M3) the dispatcher via a single import surface.
export * as QualityIntelligence from "./qualityIntelligence/index.js";
// Flat re-exports of the QI dispatcher surface so downstream orchestration packages
// (Issue #273 keiko-workflows runners) avoid namespace plumbing on hot paths.
export {
  QualityIntelligenceSafeErrorException,
  createInMemoryReplayCache,
  deriveReplayCacheKey,
  dispatchQualityIntelligenceRequest,
  isCacheable,
  type QualityIntelligenceBudgetState,
  type QualityIntelligenceCancellationHandle,
  type QualityIntelligenceReplayCachePort,
  type QualityIntelligenceSafeError,
  type QualityIntelligenceSafeErrorCode,
} from "./qualityIntelligence/index.js";
export type {
  QualityIntelligenceDispatcherArgs,
  QualityIntelligenceDispatcherResult,
} from "./qualityIntelligence/dispatcher.js";
