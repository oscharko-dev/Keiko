// Gateway-layer WIRE contract types: model identity, request/response shapes, streaming envelope,
// and tool-call normalisation. Credential-bearing or runtime-port shapes (ModelProviderConfig,
// GatewayConfig, CircuitBreakerConfig, ProviderAdapter, Clock, CircuitBreakerStatus) STAY in
// packages/keiko-model-gateway/src/types.ts so contracts never carries an apiKey-shaped surface. No runtime code lives
// here. `readonly` everywhere; optional props are `| undefined` because exactOptionalPropertyTypes
// is on.

// Bumped to 2 by issue #143 (Epic #142 Conversation Center): ModelCapability now carries
// supportsImageInput / supportsDocumentInput / workflowEligible. Bumped to 3 by issue #493
// (Epic #491 Voice Digital Twin): ModelKind gained the "voice" member — a STRUCTURAL change
// that adds a new literal discriminant. A structural break adds a new literal member (and bumps
// this constant); additive OPTIONAL flags (Epic #761 determinism, Issue #1210 infilling, the
// #493 voice sub-capability flags) never bump it.
export const CONVERSATION_CAPABILITY_CONTRACT_VERSION = 3 as const;

// ─── Modality discriminant ────────────────────────────────────────────────────

// "voice" (Issue #493, ADR-0058 D5) is the modality discriminant for speech-to-text,
// speech-output, and realtime-speech endpoints (the Voice Digital Twin). It is deliberately a
// distinct kind, NOT a flag on "chat", so a transcription/realtime endpoint can never be elected
// for chat completion, is never conversation-eligible, and is filtered out of the chat smoke-test
// loop by construction. The voice sub-capabilities (speech input/output/realtime) are refined by
// the additive optional flags below.
export type ModelKind = "chat" | "embedding" | "ocr-vision" | "voice";

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

// ─── Voice provider locality (Issue #493, ADR-0058 D7) ─────────────────────────
// Where a configured voice provider runs. Provider-neutral: the locality is declared explicitly
// per capability, never inferred from an endpoint URL, environment name, or package availability
// (the epic invariant). Azure Foundry is ONE valid provider, never a required destination.
//   - "azure-foundry"   — an Azure AI Foundry / Azure OpenAI voice deployment (e.g. the existing
//                         `keiko-stt` STT deployment, development / academic profiles).
//   - "customer-hosted" — a customer-operated voice endpoint inside a controlled network, which
//                         may be a private/RFC-1918 host (regulated bank/insurance professional
//                         deployments). Private hosts are first-class.
//   - "local-only"      — a voice endpoint that never leaves the Keiko host (loopback / on-device).
export type VoiceProviderLocality = "azure-foundry" | "customer-hosted" | "local-only";

export const VOICE_PROVIDER_LOCALITIES: readonly VoiceProviderLocality[] = [
  "azure-foundry",
  "customer-hosted",
  "local-only",
] as const;

// ─── Product voice persona (Issue #1557, Epic #1556, ADR-0094 D1) ──────────────
// A `VoicePersona` is a PRODUCT-level voice identity the operator offers to the end user — "what
// the assistant sounds like." It is deliberately distinct from `VoiceProfile` (the capability
// DEGRADATION ladder, "how much voice the deployment can do"): the two are orthogonal axes and must
// never collide. Personas are OUTPUT voices, so an STT-only deployment offers none. The persona →
// provider-voice-id MAPPING is provider-sensitive and lives on the credential tier
// (`ModelProviderConfig.voiceProfiles` in keiko-model-gateway) — it never crosses to contracts; only
// the content-free persona enum below does (ADR-0094 D2).
export type VoicePersona = "male" | "female" | "neutral";

// Canonical, ordered tuple of personas. Derivation of `supportedVoicePersonas` and aggregation of
// `availableVoicePersonas` both sort against this order so the wire surface is deterministic.
export const VOICE_PERSONAS: readonly VoicePersona[] = ["male", "female", "neutral"] as const;

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
  /**
   * Whether the voice provider advertises speech-to-text / transcription, i.e. controlled
   * composer dictation (audio in → text). Only meaningful for `kind: "voice"` (Issue #493).
   */
  readonly supportsSpeechInput?: boolean | undefined;
  /**
   * Whether the voice provider advertises speech output / synthesis (text → audio playback).
   * Only meaningful for `kind: "voice"` (Issue #493).
   */
  readonly supportsSpeechOutput?: boolean | undefined;
  /**
   * Whether the voice provider advertises realtime, full-duplex speech (interruptible,
   * colleague-like conversation / speech-in-speech-out). Only meaningful for `kind: "voice"`.
   * Realtime is the gate for the full-conversation profile (Issue #493 AC3, ADR-0058 D2).
   */
  readonly supportsRealtimeVoice?: boolean | undefined;
  /**
   * Where a `kind: "voice"` provider runs (Issue #493, ADR-0058 D7). Declared explicitly, never
   * inferred from the endpoint URL or environment name. Required when `kind === "voice"`.
   */
  readonly voiceProviderLocality?: VoiceProviderLocality | undefined;
  /**
   * The product voice personas this voice provider offers as OUTPUT voices (Issue #1557, ADR-0094
   * D2). CONTENT-FREE: persona enums only, never a provider voice id — the sensitive persona →
   * voice-id mapping lives on the credential-tier `ModelProviderConfig.voiceProfiles`. This field is
   * DERIVED at config parse time from that mapping (sorted canonical `VOICE_PERSONAS` order); it is
   * never an operator input key and is never persisted. Only meaningful for a `kind: "voice"`
   * provider that advertises speech output or realtime voice.
   */
  readonly supportedVoicePersonas?: readonly VoicePersona[] | undefined;
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

// ─── Voice capability predicates (Issue #493, ADR-0058 D2/D5) ──────────────────
// Pure, total predicates over a capability. They live in contracts (not keiko-model-gateway) so
// the browser-tier keiko-ui can value-import them without crossing ADR-0019 trust rule 3 (UI →
// model-gateway/src forbidden at error), mirroring `modelSupportsInfilling`. Every predicate is
// fail-closed: a non-voice kind, or an absent flag, is "no".

// Whether the capability is the voice modality at all.
export function isVoiceCapability(capability: ModelCapability): boolean {
  return capability.kind === "voice";
}

// Whether the voice provider advertises speech-to-text (dictation). Total: only a voice-kind model
// with the flag set qualifies.
export function modelSupportsSpeechInput(capability: ModelCapability): boolean {
  return capability.kind === "voice" && capability.supportsSpeechInput === true;
}

// Whether the voice provider advertises speech output (synthesis / playback).
export function modelSupportsSpeechOutput(capability: ModelCapability): boolean {
  return capability.kind === "voice" && capability.supportsSpeechOutput === true;
}

// Whether the voice provider advertises realtime full-duplex speech.
export function modelSupportsRealtimeVoice(capability: ModelCapability): boolean {
  return capability.kind === "voice" && capability.supportsRealtimeVoice === true;
}

// ─── Voice capability resolution result (content-free, serialisable) ───────────
// The stable, content-free result the BFF voice-capability endpoint returns and the UI reads
// before rendering any voice affordance. It carries only enum literals and booleans — never a
// provider base URL, credential, model id, audio buffer, or transcript — so it is safe to
// serialise across the host/server boundary and safe to log (Issue #493 AC4/AC5, by construction).

// The effective voice profile, ordered by the graceful-degradation ladder (ADR-0058 D2/architecture
// §5). `none` means no voice affordance is rendered at all.
export type VoiceProfile = "none" | "speech-to-text" | "speech-output" | "full-realtime";

// Why voice is unavailable (present only when `available` is false). Content-free.
//   - "no-voice-provider"    — no configured provider advertises a voice capability.
//   - "policy-disabled"      — voice is disabled by deployment policy (operator kill-switch).
//   - "provider-unreachable" — voice providers are configured but currently unreachable.
export type VoiceUnavailableReason =
  | "no-voice-provider"
  | "policy-disabled"
  | "provider-unreachable";

// Transport posture for the resolved profile (ADR-0058 D3). The control/signaling plane
// ("WebSocket is authoritative") is realized today on the loopback HTTP + SSE seam, so
// `websocketControl` reflects the control-plane role being active for any non-`none` profile.
// `webrtcMedia` (the preferred media plane) is indicated only for the full-realtime profile.
export interface VoiceTransportPosture {
  readonly websocketControl: boolean;
  readonly webrtcMedia: boolean;
}

export interface VoiceCapabilityResolution {
  // AC1: false when no voice model is configured (or voice is disabled / unreachable).
  readonly available: boolean;
  readonly profile: VoiceProfile;
  // Aggregate of the advertised voice sub-capabilities across reachable voice providers.
  readonly capabilities: {
    readonly speechToText: boolean;
    readonly speechOutput: boolean;
    readonly realtimeVoice: boolean;
  };
  readonly transport: VoiceTransportPosture;
  // Aggregate union of the product voice personas offered across reachable speech-output / realtime
  // voice providers, sorted in canonical `VOICE_PERSONAS` order (Issue #1557, ADR-0094 D2/D7).
  // CONTENT-FREE (persona enums only, never a voice id). REQUIRED: the empty array is the honest
  // "no personas available" value, so an STT-only or no-voice deployment reports `[]` rather than an
  // ambiguous absent field.
  readonly availableVoicePersonas: readonly VoicePersona[];
  // Locality of the elected voice provider(s); present only when a single locality is in effect.
  readonly providerLocality?: VoiceProviderLocality | undefined;
  // Present when `available` is false.
  readonly reason?: VoiceUnavailableReason | undefined;
}

// ─── Kind-aware voice provider availability (Issue #1557, ADR-0094 D3) ─────────
// Content-free descriptor that distinguishes a WORKING voice provider (advertises ≥1 usable voice
// sub-capability) from a model that is merely non-chat. The UI branches on `isConfiguredVoiceProvider`
// to render a positive "Voice provider" badge instead of the red chat-ineligibility warning (AC4),
// without making voice conversation-eligible. Deterministic and probe-free (ADR-0094 D3): every field
// is read from the already-parsed capability, never from a network call.

export interface VoiceProviderAvailability {
  // True when the capability is the voice modality AND advertises ≥1 voice sub-capability.
  readonly available: boolean;
  readonly speechToText: boolean;
  readonly speechOutput: boolean;
  readonly realtimeVoice: boolean;
  // The product voice personas advertised (sorted canonical order). Empty for an STT-only provider.
  readonly personas: readonly VoicePersona[];
  // The provider locality when declared; absent otherwise.
  readonly providerLocality?: VoiceProviderLocality | undefined;
}

// Whether the capability is a CONFIGURED, working voice provider: the voice modality advertising at
// least one of speech input / speech output / realtime voice. Fail-closed: a non-voice kind, or a
// voice kind with no advertised sub-capability, is false.
export function isConfiguredVoiceProvider(capability: ModelCapability): boolean {
  return (
    isVoiceCapability(capability) &&
    (modelSupportsSpeechInput(capability) ||
      modelSupportsSpeechOutput(capability) ||
      modelSupportsRealtimeVoice(capability))
  );
}

// The product voice personas a single capability offers, sorted in canonical `VOICE_PERSONAS` order
// and de-duplicated. Fail-closed: empty for a non-voice capability (even if a persona field is
// present — defence in depth alongside the config parser, which prevents that at parse time) or one
// that advertises none.
export function listVoicePersonas(capability: ModelCapability): readonly VoicePersona[] {
  if (!isVoiceCapability(capability)) {
    return [];
  }
  const declared = capability.supportedVoicePersonas;
  if (declared === undefined || declared.length === 0) {
    return [];
  }
  const present = new Set<VoicePersona>(declared);
  return VOICE_PERSONAS.filter((persona) => present.has(persona));
}

// Content-free availability descriptor for one capability (ADR-0094 D3). Total and probe-free.
export function describeVoiceProviderAvailability(
  capability: ModelCapability,
): VoiceProviderAvailability {
  const locality = capability.voiceProviderLocality;
  return {
    available: isConfiguredVoiceProvider(capability),
    speechToText: modelSupportsSpeechInput(capability),
    speechOutput: modelSupportsSpeechOutput(capability),
    realtimeVoice: modelSupportsRealtimeVoice(capability),
    personas: listVoicePersonas(capability),
    ...(locality !== undefined ? { providerLocality: locality } : {}),
  };
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

export type ConversationIneligibilityReason =
  | "embedding-only"
  | "ocr-vision-only"
  | "voice-only"
  | "non-chat";

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
  voice: "voice-only",
};

export function explainConversationIneligibility(
  capability: ModelCapability,
): ConversationIneligibilityReason | undefined {
  if (capability.kind === "chat") return undefined;
  return INELIGIBILITY_REASON_BY_KIND[capability.kind];
}
