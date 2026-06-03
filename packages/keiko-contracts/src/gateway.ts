// Gateway-layer WIRE contract types: model identity, request/response shapes, streaming envelope,
// and tool-call normalisation. Credential-bearing or runtime-port shapes (ModelProviderConfig,
// GatewayConfig, CircuitBreakerConfig, ProviderAdapter, Clock, CircuitBreakerStatus) STAY in
// src/gateway/types.ts so contracts never carries an apiKey-shaped surface. No runtime code lives
// here. `readonly` everywhere; optional props are `| undefined` because exactOptionalPropertyTypes
// is on.

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
