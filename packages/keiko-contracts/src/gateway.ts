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
// #493 voice sub-capability flags and #3182 transient conversation readiness) never bump it.
export const CONVERSATION_CAPABILITY_CONTRACT_VERSION = 3 as const;

// ─── Modality discriminant ────────────────────────────────────────────────────

// "voice" (Issue #493, ADR-0100 D5) is the modality discriminant for speech-to-text,
// speech-output, and realtime-speech endpoints (the Voice Digital Twin). It is deliberately a
// distinct kind, NOT a flag on "chat", so a transcription/realtime endpoint can never be elected
// for chat completion, is never conversation-eligible, and is filtered out of the chat smoke-test
// loop by construction. The voice sub-capabilities (speech input/output/realtime) are refined by
// the additive optional flags below.
export type ModelKind = "chat" | "embedding" | "ocr-vision" | "voice";

export type CostClass = "low" | "medium" | "high";

export const MODEL_COST_RANK: Readonly<Record<CostClass, number>> = {
  low: 0,
  medium: 1,
  high: 2,
};

export type LatencyClass = "fast" | "standard" | "slow";

export type ModelTokenAccountingSource = "calibrated";

export interface ModelTokenAccounting {
  readonly source: ModelTokenAccountingSource;
  readonly counterId: string;
  // 1000 == 1.0x the deterministic fallback estimate. Integer-only for stable JSON configs.
  readonly scaleMilli: number;
  readonly offsetTokens?: number | undefined;
}

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

// ─── Voice provider locality (Issue #493, ADR-0100 D7) ─────────────────────────
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

// ─── Provider endpoint protocol (wire-value unions, #3037 follow-up) ───────────
// How a provider endpoint speaks: the OpenAI-compatible path shape (LiteLLM, OpenAI, most
// gateways) or the Azure deployment-path shape (which additionally requires an apiVersion).
// These literals live in the contract seam so the UI upload parser, the server setup route, and
// the model gateway validate against ONE source. The value arrays derive from Record<Union, true>
// tables: adding a union member without registering its value — or a value without its member —
// fails to compile in both directions.
export type ProviderEndpointStyle = "openai-compatible" | "azure-openai-deployment";
export type RealtimeAuthMode = "api-key" | "ephemeral-session";

const PROVIDER_ENDPOINT_STYLE_TABLE: Record<ProviderEndpointStyle, true> = {
  "openai-compatible": true,
  "azure-openai-deployment": true,
};
export const PROVIDER_ENDPOINT_STYLES = Object.keys(
  PROVIDER_ENDPOINT_STYLE_TABLE,
) as readonly ProviderEndpointStyle[];

const REALTIME_AUTH_MODE_TABLE: Record<RealtimeAuthMode, true> = {
  "api-key": true,
  "ephemeral-session": true,
};
export const REALTIME_AUTH_MODES = Object.keys(
  REALTIME_AUTH_MODE_TABLE,
) as readonly RealtimeAuthMode[];

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
  /**
   * Transient server observation that this configured chat model passed a basic-chat probe for the
   * current runtime configuration generation. This is never persisted as provider capability
   * metadata. Tri-state on the wire: `true`/`false` only when a current-generation observation
   * exists; ABSENT when the model was never probed since the configuration was (re)loaded. A
   * consumer must not collapse "unknown" into "not ready" — that turned every process restart
   * into a dead model picker until a manual probe (customer field incident, 0.3.11).
   */
  readonly conversationReady?: boolean | undefined;
  /**
   * Whether the provider's discovery metadata explicitly declared a chat-compatible mode for this
   * model (e.g. a LiteLLM `/model/info` `mode` of "chat" / "completion" / "responses"). Absent
   * when discovery declared no mode either way — such models stay conversation-eligible but rank
   * behind mode-declared ones as the DEFAULT conversation model (`conversationDefaultRank`),
   * because a mode-less entry may be a special-purpose engine (customer field incident: an OCR
   * model first in the configured list captured the default for every new chat). Additive
   * optional flag — no contract version bump.
   */
  readonly chatModeDeclared?: boolean | undefined;
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
  /**
   * Optional content-free token accounting metadata for prompt budgeting. Calibrated counters are
   * deterministic local adjustments over Keiko's fallback estimate; tokenizer dependencies remain
   * out of the wire contract and must be governed separately before an exact source is advertised.
   */
  readonly tokenAccounting?: ModelTokenAccounting | undefined;
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
   * Whether speech synthesis accepts delivery instructions for tone, pacing, and intonation.
   * Only meaningful when speech output is supported; absent means fail-safe plain synthesis.
   */
  readonly supportsSpeechSynthesisInstructions?: boolean | undefined;
  /**
   * Whether the voice provider advertises Realtime WebRTC input, VAD, and live transcription.
   * Only meaningful for `kind: "voice"`. It grants no provider assistant response or output-audio
   * authority (ADR-0154).
   */
  readonly supportsRealtimeVoice?: boolean | undefined;
  /** Whether the realtime provider supports semantic end-of-turn detection. */
  readonly supportsSemanticTurnDetection?: boolean | undefined;
  /** Provider-specific input transcription model used for realtime dialogue. */
  readonly realtimeTranscriptionModel?: string | undefined;
  /**
   * Where a `kind: "voice"` provider runs (Issue #493, ADR-0100 D7). Declared explicitly, never
   * inferred from the endpoint URL or environment name. Required when `kind === "voice"`.
   */
  readonly voiceProviderLocality?: VoiceProviderLocality | undefined;
  /**
   * The product voice personas this voice provider offers as OUTPUT voices (Issue #1557, ADR-0094
   * D2). CONTENT-FREE: persona enums only, never a provider voice id — the sensitive persona →
   * voice-id mapping lives on the credential-tier `ModelProviderConfig.voiceProfiles`. This field is
   * DERIVED at config parse time from that mapping (sorted canonical `VOICE_PERSONAS` order); it is
   * never an operator input key and is never persisted. Only meaningful for a `kind: "voice"`
   * provider that advertises speech output.
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
  "no-infilling-model" | "only-base-infilling-model" | "over-cost-ceiling";

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

// ─── Voice capability predicates (Issue #493, ADR-0100 D2/D5) ──────────────────
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

// Whether the voice provider advertises Realtime WebRTC input/VAD/transcription.
export function modelSupportsRealtimeVoice(capability: ModelCapability): boolean {
  return capability.kind === "voice" && capability.supportsRealtimeVoice === true;
}

export function isCompleteRealtimeVoiceCapability(capability: ModelCapability): boolean {
  return (
    modelSupportsRealtimeVoice(capability) &&
    (capability.realtimeTranscriptionModel?.trim().length ?? 0) > 0
  );
}

function selectCheapestVoiceCapability(
  capabilities: readonly ModelCapability[],
  supportsRole: (capability: ModelCapability) => boolean,
): ModelCapability | undefined {
  let selected: ModelCapability | undefined;
  for (const capability of capabilities) {
    if (!supportsRole(capability)) continue;
    if (
      selected === undefined ||
      MODEL_COST_RANK[capability.costClass] < MODEL_COST_RANK[selected.costClass]
    ) {
      selected = capability;
    }
  }
  return selected;
}

export function selectSpeechInputCapability(
  capabilities: readonly ModelCapability[],
): ModelCapability | undefined {
  return selectCheapestVoiceCapability(capabilities, modelSupportsSpeechInput);
}

export function selectSpeechOutputCapability(
  capabilities: readonly ModelCapability[],
): ModelCapability | undefined {
  return selectCheapestVoiceCapability(capabilities, modelSupportsSpeechOutput);
}

export function selectRealtimeVoiceCapability(
  capabilities: readonly ModelCapability[],
): ModelCapability | undefined {
  return selectCheapestVoiceCapability(capabilities, isCompleteRealtimeVoiceCapability);
}

// ─── Voice capability resolution result (content-free, serialisable) ───────────
// The stable, content-free result the BFF voice-capability endpoint returns and the UI reads
// before rendering any voice affordance. It carries only enum literals and booleans — never a
// provider base URL, credential, model id, audio buffer, or transcript — so it is safe to
// serialise across the host/server boundary and safe to log (Issue #493 AC4/AC5, by construction).

// The effective voice profile, ordered by the graceful-degradation ladder (ADR-0100 D2/architecture
// §5). `none` means no voice affordance is rendered at all.
export type VoiceProfile = "none" | "speech-to-text" | "speech-output" | "full-realtime";

// Why voice is unavailable (present only when `available` is false). Content-free.
//   - "no-voice-provider"    — no configured provider advertises a voice capability.
//   - "policy-disabled"      — voice is disabled by deployment policy (operator kill-switch).
//   - "provider-unreachable" — voice providers are configured but currently unreachable.
export type VoiceUnavailableReason =
  "no-voice-provider" | "policy-disabled" | "provider-unreachable";

// Transport posture for the resolved profile (ADR-0100 D3, ADR-0154). Both fields describe the
// productive Realtime input path and are true only when a complete Realtime deployment is available.
// Batch dictation and TTS use same-origin HTTP through the Model Gateway and advertise neither.
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
    // Compatibility-only capability bit retained for existing consumers. Canonical Twin Voice does
    // not use provider tool calling; retrieval and memory remain owned by canonical Chat (ADR-0154).
    readonly realtimeToolCalling?: boolean | undefined;
  };
  readonly transport: VoiceTransportPosture;
  // Aggregate union of the product voice personas offered across reachable speech-output providers,
  // sorted in canonical `VOICE_PERSONAS` order (Issue #1557, ADR-0094 D2/D7).
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
  | {
      readonly type: "json_schema";
      readonly schema: Record<string, unknown>;
      readonly name?: string | undefined;
      readonly strict?: boolean | undefined;
    };

export interface GatewaySamplingParameters {
  readonly temperature?: unknown;
  readonly topP?: unknown;
}

export type GatewaySamplingParameterName = "temperature" | "topP";

export interface GatewaySamplingParameterIssue {
  readonly parameter: GatewaySamplingParameterName;
  readonly message: string;
}

export const GATEWAY_TEMPERATURE_RANGE = Object.freeze({ min: 0, max: 2 });
export const GATEWAY_TOP_P_RANGE = Object.freeze({ min: 0, max: 1 });
const GATEWAY_TEMPERATURE_RANGE_LABEL = `${String(GATEWAY_TEMPERATURE_RANGE.min)} and ${String(
  GATEWAY_TEMPERATURE_RANGE.max,
)}`;
const GATEWAY_TOP_P_RANGE_LABEL = `${String(GATEWAY_TOP_P_RANGE.min)} and ${String(
  GATEWAY_TOP_P_RANGE.max,
)}`;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isValidGatewayTemperature(value: unknown): value is number {
  return (
    isFiniteNumber(value) &&
    value >= GATEWAY_TEMPERATURE_RANGE.min &&
    value <= GATEWAY_TEMPERATURE_RANGE.max
  );
}

export function isValidGatewayTopP(value: unknown): value is number {
  return (
    isFiniteNumber(value) && value >= GATEWAY_TOP_P_RANGE.min && value <= GATEWAY_TOP_P_RANGE.max
  );
}

export function validateGatewaySamplingParameters(
  parameters: GatewaySamplingParameters,
): readonly GatewaySamplingParameterIssue[] {
  const issues: GatewaySamplingParameterIssue[] = [];
  if (parameters.temperature !== undefined && !isValidGatewayTemperature(parameters.temperature)) {
    issues.push({
      parameter: "temperature",
      message: `temperature must be a finite number between ${GATEWAY_TEMPERATURE_RANGE_LABEL}`,
    });
  }
  if (parameters.topP !== undefined && !isValidGatewayTopP(parameters.topP)) {
    issues.push({
      parameter: "topP",
      message: `topP must be a finite number between ${GATEWAY_TOP_P_RANGE_LABEL}`,
    });
  }
  return Object.freeze(issues);
}

export function isValidGatewaySamplingParameters(parameters: GatewaySamplingParameters): boolean {
  return validateGatewaySamplingParameters(parameters).length === 0;
}

export function assertValidGatewaySamplingParameters(parameters: GatewaySamplingParameters): void {
  const issues = validateGatewaySamplingParameters(parameters);
  if (issues.length === 0) return;
  throw new RangeError(issues.map((issue) => issue.message).join("; "));
}

export interface GatewayRequest {
  readonly modelId: string;
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolDefinition[] | undefined;
  readonly responseFormat?: ResponseFormat | undefined;
  readonly stream?: boolean | undefined;
  readonly cancellationSignal?: AbortSignal | undefined;
  /**
   * Optional server-selected positive completion budget.  Adapters translate this
   * provider-neutral value to their provider-specific output-token parameter.
   */
  readonly maxOutputTokens?: number | undefined;
  /** Optional provider-neutral temperature for sampling; valid range is 0..2. */
  readonly temperature?: number | undefined;
  /** Optional provider-neutral nucleus sampling value; serialized as `top_p` for OpenAI APIs. */
  readonly topP?: number | undefined;
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
  "stop" | "tool_calls" | "length" | "content_filter" | "error" | "cancelled";

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
// hold a conversation by modality. This configured eligibility derives from the `kind`
// discriminant alone; the separate optional `conversationReady` field is a transient live
// observation that consumers must additionally require before productive chat. The pure helpers
// live in contracts (not in keiko-model-gateway) so
// the browser-tier `keiko-ui` package can value-import them without violating
// ADR-0019 trust rule 3 (UI → model-gateway/src is forbidden at error severity).
// Pinned by keiko-model-gateway/src/capabilities.test.ts (re-exported there).

export type ConversationIneligibilityReason =
  "embedding-only" | "ocr-vision-only" | "voice-only" | "non-chat";

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

// ─── Conversation default preference ─────────────────────────────────────────
// Choosing the DEFAULT conversation model among eligible chat capabilities ranks them in three
// tiers; order within a tier is preserved by the stable sort below, so the configured order keeps
// breaking ties. Pure and total; lives in contracts so the browser-tier UI picker and the
// server-side default selection can never disagree (mirrors isConversationEligibleModel).
//
// Customer field incident (0.3.11): a mode-less OCR model sat FIRST in the configured list. It
// answers a minimal chat probe while its backend is warm, so every "first eligible model wins"
// default durably pinned new chats to an engine that is useless for conversation. A declared
// chat-compatible mode is the only affirmative signal a gateway gives; a special-purpose id is
// the strongest negative one. Ranking is a PREFERENCE, never an eligibility gate — with one
// configured model the rank-2 entry is still chosen and still probed honestly.
const SPECIAL_PURPOSE_ID_TOKENS: ReadonlySet<string> = new Set([
  "ocr",
  "whisper",
  "speech",
  "tts",
  "asr",
  "rerank",
  "reranker",
]);

// Token-wise match so "dots.ocr" and "my-ocr-model" rank down while ordinary chat ids never can.
// The suffix form covers separator-free composites like "dotsocr"; it is deliberately limited to
// "ocr" — the only marker observed fused into an id in the field — because broader suffix
// matching starts swallowing legitimate names.
function isLikelySpecialPurposeModelId(modelId: string): boolean {
  const tokens = modelId.toLowerCase().split(/[^a-z0-9]+/u);
  return tokens.some(
    (token) => SPECIAL_PURPOSE_ID_TOKENS.has(token) || (token.length > 3 && token.endsWith("ocr")),
  );
}

/**
 * Preference tier for electing a DEFAULT conversation model:
 * 0 — discovery explicitly declared a chat-compatible mode;
 * 1 — no mode signal either way;
 * 2 — no declared chat mode AND the id names a special-purpose engine (OCR, speech, reranking).
 */
export function conversationDefaultRank(
  capability: Pick<ModelCapability, "id" | "chatModeDeclared">,
): 0 | 1 | 2 {
  if (capability.chatModeDeclared === true) return 0;
  return isLikelySpecialPurposeModelId(capability.id) ? 2 : 1;
}

/** Stable rank-ordering of conversation candidates; configured order breaks ties within a tier. */
export function preferredConversationModelOrder<
  T extends Pick<ModelCapability, "id" | "chatModeDeclared">,
>(models: readonly T[]): readonly T[] {
  return [...models].sort((a, b) => conversationDefaultRank(a) - conversationDefaultRank(b));
}

/**
 * Elects the DEFAULT conversation model. Tiers are walked in rank order; within a tier a
 * VERIFIED conversation probe wins, then an UNPROBED model. Verification never promotes a
 * worse-ranked model past a better-ranked candidate that is merely unprobed — a
 * special-purpose engine that happened to answer one probe while warm would otherwise capture
 * the default, which is the exact field capture this rank exists to prevent. A tier whose
 * members are all OBSERVED-unready is exhausted, so the walk falls through to the next tier
 * instead of forcing an admission already known to fail. Callers supply the tri-state
 * observation (true = verified, false = observed unready, undefined = never probed) because
 * the signal lives in different places (the UI reads the wire capability, the server reads
 * its observation store).
 */
export function electConversationDefault<
  T extends Pick<ModelCapability, "id" | "chatModeDeclared">,
>(models: readonly T[], observation: (model: T) => boolean | undefined): T | undefined {
  const ordered = preferredConversationModelOrder(models);
  for (const tier of [0, 1, 2] as const) {
    const members = ordered.filter((model) => conversationDefaultRank(model) === tier);
    const pick =
      members.find((model) => observation(model) === true) ??
      members.find((model) => observation(model) === undefined);
    if (pick !== undefined) return pick;
  }
  // Every candidate is observed-unready: return the best-ranked head so the caller's
  // admission yields the precise "not ready" error for the most legitimate candidate.
  return ordered.at(0);
}
