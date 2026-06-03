// Re-export shim: types now live in @oscharko-dev/keiko-model-gateway (issue #160, ADR-0019).
// All existing import sites (`from "../gateway/types.js"`) keep resolving unchanged via this barrel.

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
