// Gateway-layer WIRE contract types: model identity, request/response shapes, streaming envelope,
// and tool-call normalisation. Credential-bearing or runtime-port shapes (ModelProviderConfig,
// GatewayConfig, CircuitBreakerConfig, ProviderAdapter, Clock, CircuitBreakerStatus) STAY in
// packages/keiko-model-gateway/src/types.ts so contracts never carries an apiKey-shaped surface. No runtime code lives
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

// ─── Infilling (fill-in-the-middle) alignment posture (Issue #1210, ADR-0042 D5) ───
// Editor inline completion is an infilling task: the cursor almost always has code after it, so a
// prefix-only model duplicates code and breaks closing context (Bavarian et al. 2022,
// arXiv:2207.14255). A model that advertises suffix-aware completion declares HOW its infilling
// endpoint is trained, because the choice carries a security consequence, not only a quality one:
//   - "base"       — a raw base-model FIM endpoint. Fast and capable, but re-opens a documented
//                    prompt-injection surface (SAL benchmark: base-FIM attack-success-rate ≈99% vs
//                    ≈13.8% for instruct/edit-tuned infilling). NEVER elected for editor ghost text.
//   - "instruct"   — an aligned/instruct infilling variant.
//   - "edit-tuned" — a search-and-replace / edit-tuned infilling variant.
// Only "instruct" and "edit-tuned" are eligible for governed editor completion. An undeclared
// alignment is treated as unsafe (fail-closed) by the predicates below.
export type InfillingAlignment = "base" | "instruct" | "edit-tuned";

export const INFILLING_ALIGNMENTS: readonly InfillingAlignment[] = [
  "base",
  "instruct",
  "edit-tuned",
] as const;

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
  /** Whether the model supports a `seed` parameter for deterministic sampling (Epic #761). */
  readonly supportsSeeding?: boolean | undefined;
  /** Whether the model supports a `responseFormat` parameter for JSON output (Epic #761). */
  readonly supportsResponseFormat?: boolean | undefined;
  /**
   * Whether the model supports suffix-aware (fill-in-the-middle / FIM) completion (Issue #1210).
   * Required for Keiko editor inline completion; a prefix-only model is a documented anti-pattern
   * for in-editor ghost text. Only meaningful for `kind: "chat"` models.
   */
  readonly supportsInfilling?: boolean | undefined;
  /**
   * Alignment posture of the model's infilling endpoint (Issue #1210). Only meaningful when
   * `supportsInfilling` is true. Editor ghost text requires an aligned ("instruct") or edit-tuned
   * ("edit-tuned") variant; a raw "base" FIM endpoint — or an undeclared alignment — is rejected
   * for governed completion because base-FIM re-opens a prompt-injection surface (ADR-0042 D5).
   */
  readonly infillingAlignment?: InfillingAlignment | undefined;
}

// ─── Completion / infilling capability helpers (Issue #1210, ADR-0042 D5) ──────
// These are additive, optional fields: a future capability flag (e.g. `edit-prediction` for
// next-edit prediction) is another optional member, never a structural break, so
// CONVERSATION_CAPABILITY_CONTRACT_VERSION is intentionally NOT bumped (same precedent as the
// Epic #761 determinism flags). The single source of truth for "does a model satisfy the editor
// completion requirement?" lives in these pure, total predicates so the completion-model selection
// (keiko-model-gateway) and any consuming route can never disagree on what the capability means.
// Pure helpers live in contracts (not keiko-model-gateway) so the browser-tier `keiko-ui`/editor
// host can value-import them without crossing ADR-0019 trust rule 3 (UI → model-gateway/src is
// forbidden at error severity), mirroring `isConversationEligibleModel`.

// Whether the model advertises suffix-aware (FIM) completion at all. Total: a non-chat model can
// never infill, and an absent flag is treated as "no" (conservative default).
export function modelSupportsInfilling(capability: ModelCapability): boolean {
  return capability.kind === "chat" && capability.supportsInfilling === true;
}

// Whether the model is an aligned/instruct or edit-tuned infilling variant — the only postures
// eligible for GOVERNED editor completion. Fail-closed: a base endpoint or an undeclared alignment
// is rejected (the prompt-injection guardrail, ADR-0042 D5).
export function isAlignedInfillingModel(capability: ModelCapability): boolean {
  if (!modelSupportsInfilling(capability)) return false;
  return (
    capability.infillingAlignment === "instruct" || capability.infillingAlignment === "edit-tuned"
  );
}

// Whether the model is eligible for AS-YOU-TYPE ghost text: an aligned infilling variant AND a
// `fast` latency class. A `standard`/`slow` model is never elected for per-keystroke completion
// (ADR-0042 D5: the as-you-type query requires BOTH the FIM capability AND `latencyClass: "fast"`).
export function isAsYouTypeCompletionModel(capability: ModelCapability): boolean {
  return isAlignedInfillingModel(capability) && capability.latencyClass === "fast";
}

// ─── Completion-model selection result (content-free, serialisable) ────────────
// The stable, content-free result the completion (#1199) and inline-completion (#1200) routes
// consume. It carries only enum literals plus a configured model id — never buffer text, prompts,
// queries, or any customer content — so it is safe to serialise across the host/server boundary.

// The interaction mode the inline-completion feature should drive:
//   - "as-you-type"   — debounced ghost text backed by a fast, aligned FIM model.
//   - "manual"        — manual-invoke inline suggestion backed by an aligned FIM model that is too
//                       slow (`standard`/`slow`) for per-keystroke completion.
//   - "deterministic" — no governed FIM model is usable; degrade to the deterministic
//                       language-service completion path (#1198). Never a silent ungoverned model.
export type CompletionInteractionMode = "as-you-type" | "manual" | "deterministic";

// Why a model-backed mode was not chosen, present only when `mode === "deterministic"`:
//   - "no-infilling-model"        — no configured model advertises suffix-aware completion.
//   - "only-base-infilling-model" — infilling models exist but only as raw base / undeclared
//                                   alignment (rejected by the injection guardrail).
//   - "over-cost-ceiling"         — an aligned FIM model exists but every candidate exceeds the
//                                   caller's cost ceiling (#1206).
export type CompletionDegradeReason =
  | "no-infilling-model"
  | "only-base-infilling-model"
  | "over-cost-ceiling";

export interface CompletionModelSelection {
  readonly mode: CompletionInteractionMode;
  // The selected configured model id. Present iff `mode !== "deterministic"`.
  readonly modelId?: string | undefined;
  // The selected model's latency class — the effective-latency awareness the feature uses to
  // confirm the interaction mode. Present iff a model is chosen.
  readonly latencyClass?: LatencyClass | undefined;
  // Present iff `mode === "deterministic"`.
  readonly degradeReason?: CompletionDegradeReason | undefined;
}

// ─── Request / response ───────────────────────────────────────────────────────

export interface ChatMessageTextContentPart {
  readonly type: "text";
  readonly text: string;
}

export interface ChatMessageImageUrlContentPart {
  readonly type: "image_url";
  readonly image_url: {
    readonly url: string;
  };
}

export type ChatMessageContentPart = ChatMessageTextContentPart | ChatMessageImageUrlContentPart;

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly contentParts?: readonly ChatMessageContentPart[] | undefined;
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
  /** Optional seed for deterministic sampling when the model supports it (Epic #761). */
  readonly seed?: number | undefined;
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
