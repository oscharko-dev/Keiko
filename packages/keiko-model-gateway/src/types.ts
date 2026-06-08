// Re-export shim: wire-safe gateway contract types live in @oscharko-dev/keiko-contracts
// (issue #158). Credential-bearing / port shapes (ModelProviderConfig, GatewayConfig,
// CircuitBreakerConfig, ProviderAdapter, Clock, CircuitState, CircuitBreakerStatus) STAY here
// so contracts never carries an apiKey-shaped surface (ADR-0019 direction 1 contracts-leaf).
// `verbatimModuleSyntax` is on, so type-only names use `export type`.

import type {
  ModelCapability,
  NormalizedResponse,
  GatewayRequest,
} from "@oscharko-dev/keiko-contracts";

export type {
  ModelKind,
  CostClass,
  LatencyClass,
  ModelCapability,
  ChatMessage,
  ToolDefinition,
  ResponseFormat,
  GatewayRequest,
  NormalizedToolCall,
  UsageMetadata,
  NormalizedResponse,
  FinishReason,
  StreamDelta,
  StreamEvent,
} from "@oscharko-dev/keiko-contracts";
export { CONVERSATION_CAPABILITY_CONTRACT_VERSION } from "@oscharko-dev/keiko-contracts";

// ─── Provider configuration (credential-bearing — STAYS local) ────────────────

export interface ModelProviderConfig {
  readonly modelId: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly apiKeyHeaderName?: string | undefined;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly retryBaseDelayMs: number;
}

export interface CircuitBreakerConfig {
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  readonly halfOpenProbes: number;
}

export interface GatewayConfig {
  readonly providers: readonly ModelProviderConfig[];
  readonly circuitBreaker: CircuitBreakerConfig;
  readonly capabilities?: readonly ModelCapability[] | undefined;
}

// ─── Provider adapter interface (runtime port — STAYS local) ──────────────────

// A single chunk emitted by the streaming chat path. Content deltas arrive as
// `delta` chunks (one per provider token group); a terminal `done` chunk carries the
// fully assembled, redacted NormalizedResponse. Tool-call streaming is out of scope
// for Layer 1 — only content deltas are surfaced.
export type GatewayStreamChunk =
  | { readonly type: "delta"; readonly token: string }
  | { readonly type: "done"; readonly response: NormalizedResponse };

export interface ProviderAdapter {
  readonly call: (
    request: GatewayRequest,
    config: ModelProviderConfig,
  ) => Promise<NormalizedResponse>;
  // Optional streaming variant. Absent on adapters that only support buffered calls;
  // the Gateway synthesises a single delta+done from `call` in that case.
  readonly callStream?: (
    request: GatewayRequest,
    config: ModelProviderConfig,
  ) => AsyncIterable<GatewayStreamChunk>;
}

// ─── Clock interface (injectable for deterministic tests — STAYS local) ───────

export interface Clock {
  readonly now: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

// ─── Circuit-breaker observable state (STAYS local) ──────────────────────────

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerStatus {
  readonly modelId: string;
  readonly state: CircuitState;
  readonly consecutiveFailures: number;
  readonly openedAt: number | null;
}
