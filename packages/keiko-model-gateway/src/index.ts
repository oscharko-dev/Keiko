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
  InfillingAlignment,
  LatencyClass,
  ModelCapability,
  CompletionInteractionMode,
  CompletionDegradeReason,
  CompletionModelSelection,
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
  VoicePersona,
  VoicePersonaVoice,
  VoiceProviderAvailability,
} from "./types.js";

export {
  CAPABILITY_REGISTRY,
  createDefaultChatCapability,
  explainConversationIneligibility,
  findCapability,
  INFILLING_ALIGNMENTS,
  isAlignedInfillingModel,
  isAsYouTypeCompletionModel,
  isConfiguredVoiceProvider,
  isConversationEligibleModel,
  isVoiceCapability,
  describeVoiceProviderAvailability,
  listCapabilities,
  listVoicePersonas,
  modelSupportsInfilling,
  modelSupportsRealtimeVoice,
  modelSupportsSpeechInput,
  modelSupportsSpeechOutput,
  resolveCostClass,
  resolveVoiceCapabilityFromCapabilities,
  selectCheapest,
  selectCompletionModelFromCapabilities,
  VOICE_PERSONAS,
  VOICE_PROVIDER_LOCALITIES,
  type CapabilityQuery,
  type CompletionSelectionOptions,
  type ConversationIneligibilityReason,
  type VoiceCapabilityResolution,
  type VoiceProfile,
  type VoiceProviderLocality,
  type VoiceResolutionOptions,
  type VoiceTransportPosture,
  type VoiceUnavailableReason,
} from "./capabilities.js";

export { CAPABILITY_DATA } from "./capabilities.data.js";

export {
  apiKeyHeaderValue,
  DEFAULT_API_KEY_HEADER_NAME,
  loadConfigFromFile,
  loadEgressConfigFromFile,
  normalizeApiKeyHeaderName,
  parseGatewayConfig,
  resolveOutboundHttpEgressConfig,
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
  resolveVoiceCapability,
  selectCompletionModel,
  selectConfiguredModel,
  selectRealtimeVoiceModel,
  selectSpeechOutputModel,
  selectSpeechToTextModel,
  selectVoicePersonaVoice,
  type ConfiguredCapabilityProvider,
  type ConfiguredCapabilitySource,
  type ModelSelectionQuery,
} from "./model-selection.js";

export {
  requestSpeechToText,
  type SpeechToTextErrorKind,
  type SpeechToTextOutcome,
  type SpeechToTextRequest,
  type SpeechToTextSuccess,
} from "./speech-to-text-adapter.js";

export {
  MAX_SDP_BYTES,
  requestRealtimeNegotiation,
  type RealtimeNegotiationErrorKind,
  type RealtimeNegotiationOutcome,
  type RealtimeNegotiationRequest,
  type RealtimeNegotiationSuccess,
} from "./realtime-voice-adapter.js";

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
  requestOpenAIEmbeddingBatch,
  type OpenAIEmbeddingBatchOutcome,
  type OpenAIEmbeddingBatchRequest,
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
  GatewayEgressError,
  GatewayError,
  MalformedToolCallError,
  ModelRefusalError,
  ProviderError,
  RateLimitError,
  TimeoutError,
  TransportError,
  UnknownModelError,
  type ErrorCode,
  type GatewayEgressErrorCode,
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

// Prompt Enhancer sub-module (Epic #1307, Issue #1310; ADR-0044 §1). Exposed under a namespace,
// mirroring Quality Intelligence, so callers reach the generation-profile execution catalog, the
// deterministic planner, the structured generator, and the provider-neutral renderers. Model-bound
// candidate/critic dispatch is added by #1312.
export * as PromptEnhancer from "./promptEnhancer/index.js";
