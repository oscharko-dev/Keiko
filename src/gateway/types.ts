// All gateway interfaces and type aliases. No runtime code lives here.

// ─── Modality discriminant ────────────────────────────────────────────────────

export type ModelKind = "chat" | "embedding" | "ocr-vision";

export type CostClass = "low" | "medium" | "high";

export type LatencyClass = "fast" | "standard" | "slow";

// ─── Capability registry entry ────────────────────────────────────────────────

export interface ModelCapability {
  readonly id: string;
  readonly kind: ModelKind;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly toolCalling: boolean;
  readonly structuredOutput: boolean;
  readonly streaming: boolean;
  readonly costClass: CostClass;
  readonly latencyClass: LatencyClass;
  readonly throughputHint: string;
  readonly preferredUseCases: readonly string[];
  readonly knownLimitations: readonly string[];
}

// ─── Provider configuration ───────────────────────────────────────────────────

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

// ─── Request / response ───────────────────────────────────────────────────────

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCallId?: string | undefined;
  readonly toolCalls?: readonly NormalizedToolCall[] | undefined;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export type ResponseFormat =
  | { readonly type: "text" }
  | { readonly type: "json_schema"; readonly schema: Record<string, unknown> };

export interface GatewayRequest {
  readonly modelId: string;
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolDefinition[] | undefined;
  readonly responseFormat?: ResponseFormat | undefined;
  readonly stream?: boolean | undefined;
  readonly cancellationSignal?: AbortSignal | undefined;
}

// ─── Tool-call normalisation ──────────────────────────────────────────────────

export interface NormalizedToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

// ─── Usage metadata (first-class, non-optional on every response) ─────────────

export interface UsageMetadata {
  readonly requestId: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly latencyMs: number;
  readonly costClass: CostClass;
}

// ─── Normalised response ──────────────────────────────────────────────────────

export type FinishReason =
  | "stop"
  | "tool_calls"
  | "length"
  | "content_filter"
  | "error"
  | "cancelled";

export interface NormalizedResponse {
  readonly modelId: string;
  readonly content: string;
  readonly finishReason: FinishReason;
  readonly toolCalls: readonly NormalizedToolCall[];
  readonly structuredOutput: Record<string, unknown> | null;
  readonly usage: UsageMetadata;
}

// ─── Streaming (schema only — Wave 1 adapter does not process chunked streams) ─

export interface StreamDelta {
  readonly role?: "assistant" | undefined;
  readonly contentDelta?: string | undefined;
  readonly toolCallDelta?: Partial<NormalizedToolCall> | undefined;
  readonly finishReason?: FinishReason | undefined;
  readonly usage?: UsageMetadata | undefined;
}

export type StreamEvent =
  | { readonly type: "delta"; readonly delta: StreamDelta }
  | { readonly type: "done"; readonly response: NormalizedResponse };

// ─── Provider adapter interface ───────────────────────────────────────────────

export interface ProviderAdapter {
  readonly call: (
    request: GatewayRequest,
    config: ModelProviderConfig,
  ) => Promise<NormalizedResponse>;
}

// ─── Clock interface (injectable for deterministic tests) ─────────────────────

export interface Clock {
  readonly now: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

// ─── Circuit-breaker observable state ────────────────────────────────────────

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerStatus {
  readonly modelId: string;
  readonly state: CircuitState;
  readonly consecutiveFailures: number;
  readonly openedAt: number | null;
}
