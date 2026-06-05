// Gateway-layer WIRE contract types: model identity, request/response shapes, streaming envelope,
// and tool-call normalisation. Credential-bearing or runtime-port shapes (ModelProviderConfig,
// GatewayConfig, CircuitBreakerConfig, ProviderAdapter, Clock, CircuitBreakerStatus) STAY in
// src/gateway/types.ts so contracts never carries an apiKey-shaped surface. No runtime code lives
// here. `readonly` everywhere; optional props are `| undefined` because exactOptionalPropertyTypes
// is on.

// Bumped to 2 by issue #143 (Epic #142 Conversation Center): ModelCapability now carries
// supportsImageInput / supportsDocumentInput / workflowEligible. A future structural break
// adds a new literal member rather than mutating this constant.
export const CONVERSATION_CAPABILITY_CONTRACT_VERSION = 2 as const;

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
  // Conversation Center modality flags (Issue #143 / Epic #142). Conservative
  // defaults: unknown discovered chat models are text-only and not workflow-eligible.
  // Image and document INPUT support; workflow eligibility MUST be false for non-chat
  // kinds (the parser in keiko-model-gateway/src/config.ts enforces this).
  readonly supportsImageInput: boolean;
  readonly supportsDocumentInput: boolean;
  readonly workflowEligible: boolean;
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

// ─── Conversation eligibility (Issue #144 / Epic #142) ────────────────────────
// Why: the chat-completions dropdown must only show models that can actually
// hold a conversation. Eligibility derives from the `kind` discriminant alone
// because chat-kind capabilities that reach persistence are smoke-tested by
// construction at `defaultGatewaySetupTester` in `keiko-server` (non-chat
// `kind`s are filtered earlier by the discovery normaliser before any model
// id reaches the smoke loop). This is a derived discriminant, not a new wire
// field — `CONVERSATION_CAPABILITY_CONTRACT_VERSION` is intentionally not
// bumped. The pure helpers live in contracts (not in keiko-model-gateway) so
// the browser-tier `keiko-ui` package can value-import them without violating
// ADR-0019 trust rule 3 (UI → model-gateway/src is forbidden at error severity).
// Pinned by keiko-model-gateway/src/capabilities.test.ts (re-exported there).

export type ConversationIneligibilityReason = "embedding-only" | "ocr-vision-only" | "non-chat";

// Why: see header — only `kind === "chat"` is conversation-eligible by
// construction. Pure, total, no side effects.
export function isConversationEligibleModel(capability: ModelCapability): boolean {
  return capability.kind === "chat";
}

// Why: returns a typed reason the UI can map to a localisable explanation
// without leaking provider URLs or credentials. Returns `undefined` for
// chat-eligible capabilities so callers can branch on presence. The lookup
// is total over `Exclude<ModelKind, "chat">` by construction — if a future
// `ModelKind` member is added in a CONVERSATION_CAPABILITY_CONTRACT_VERSION
// bump, this map will fail to typecheck (mandatory key missing), forcing the
// new member to be classified explicitly rather than silently leaking
// through as conversation-eligible.
const INELIGIBILITY_REASON_BY_KIND: Readonly<
  Record<Exclude<ModelKind, "chat">, ConversationIneligibilityReason>
> = {
  embedding: "embedding-only",
  "ocr-vision": "ocr-vision-only",
};

export function explainConversationIneligibility(
  capability: ModelCapability,
): ConversationIneligibilityReason | undefined {
  if (capability.kind === "chat") return undefined;
  return INELIGIBILITY_REASON_BY_KIND[capability.kind];
}
