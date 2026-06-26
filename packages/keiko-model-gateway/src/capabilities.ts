// Capability registry: the single source of truth for model routing. Workflow code
// selects models by querying this registry (by id or by capability requirements),
// never by hard-coding a model name.

import { CAPABILITY_DATA } from "./capabilities.data.js";
import {
  isAlignedInfillingModel,
  isAsYouTypeCompletionModel,
  isVoiceCapability,
  modelSupportsInfilling,
  modelSupportsRealtimeVoice,
  modelSupportsSpeechInput,
  modelSupportsSpeechOutput,
  VOICE_PERSONAS,
} from "@oscharko-dev/keiko-contracts";
import type {
  CompletionDegradeReason,
  CompletionModelSelection,
  CostClass,
  ModelCapability,
  ModelKind,
  VoiceCapabilityResolution,
  VoicePersona,
  VoiceProfile,
  VoiceProviderLocality,
  VoiceUnavailableReason,
} from "./types.js";

// Issue #144 / Epic #142: conversation eligibility helpers and reason type.
// The canonical definitions live in `@oscharko-dev/keiko-contracts/gateway`
// so the browser-tier `keiko-ui` package can value-import them without
// crossing ADR-0019 trust rule 3 (UI → model-gateway/src forbidden at error).
// They are re-exported here so server-tier consumers that already depend on
// the model-gateway barrel keep a single import path.
export {
  isConversationEligibleModel,
  explainConversationIneligibility,
} from "@oscharko-dev/keiko-contracts";
export type { ConversationIneligibilityReason } from "@oscharko-dev/keiko-contracts";

// Issue #1210 / ADR-0042 D5: infilling (FIM) capability helpers and the content-free
// completion-model selection result. The pure predicates live in `@oscharko-dev/keiko-contracts`
// (browser-importable, single source of truth) and are re-exported here for server-tier consumers
// that already depend on the model-gateway barrel, mirroring the conversation-eligibility helpers.
export {
  modelSupportsInfilling,
  isAlignedInfillingModel,
  isAsYouTypeCompletionModel,
  INFILLING_ALIGNMENTS,
} from "@oscharko-dev/keiko-contracts";
export type {
  InfillingAlignment,
  CompletionInteractionMode,
  CompletionDegradeReason,
  CompletionModelSelection,
} from "@oscharko-dev/keiko-contracts";

// Issue #493 / ADR-0058: voice-capability predicates and the content-free resolution result. The
// pure predicates live in `@oscharko-dev/keiko-contracts` (browser-importable, single source of
// truth) and are re-exported here for server-tier consumers that already depend on the
// model-gateway barrel, mirroring the conversation-eligibility and infilling helpers.
export {
  isVoiceCapability,
  modelSupportsSpeechInput,
  modelSupportsSpeechOutput,
  modelSupportsRealtimeVoice,
  isConfiguredVoiceProvider,
  describeVoiceProviderAvailability,
  listVoicePersonas,
  VOICE_PROVIDER_LOCALITIES,
  VOICE_PERSONAS,
} from "@oscharko-dev/keiko-contracts";
export type {
  VoiceProviderLocality,
  VoicePersona,
  VoiceProfile,
  VoiceUnavailableReason,
  VoiceTransportPosture,
  VoiceCapabilityResolution,
  VoiceProviderAvailability,
} from "@oscharko-dev/keiko-contracts";

export const CAPABILITY_REGISTRY: readonly ModelCapability[] = CAPABILITY_DATA;

const COST_RANK: Readonly<Record<CostClass, number>> = { low: 0, medium: 1, high: 2 };

export interface CapabilityQuery {
  readonly kind?: ModelKind | undefined;
  readonly toolCalling?: boolean | undefined;
  readonly structuredOutput?: boolean | undefined;
  readonly minContextWindow?: number | undefined;
  // Issue #810: require image-input (multimodal) capability. When true, only models that
  // advertise supportsImageInput === true match — the routing key for vision-augmented work.
  readonly supportsImageInput?: boolean | undefined;
}

export function findCapability(modelId: string): ModelCapability | undefined {
  return CAPABILITY_REGISTRY.find((cap) => cap.id === modelId);
}

// Resolves the cost class for a model id by consulting the capability registry.
// Returns "unknown" for unrecognised models so callers can record an honest,
// non-fatal fall-through rather than silently dropping the run. The evidence
// layer receives this through its injected `EvidenceDeps.costClassResolver` port.
export function resolveCostClass(modelId: string): CostClass | "unknown" {
  return findCapability(modelId)?.costClass ?? "unknown";
}

export function listCapabilities(): readonly ModelCapability[] {
  return CAPABILITY_REGISTRY;
}

// Issue #144 / Epic #142: conservative name-based heuristic for embedding model ids.
// Matches ids that contain an embed token on a word boundary (dash, underscore, slash,
// dot, or start/end of string). Also matches `ada-002` which is OpenAI's legacy
// embedding model name that predates the `text-embedding-*` convention.
// ReDoS-safe: no nested quantifiers, linear worst-case.
export const EMBEDDING_ID_PATTERN =
  /(?:^|[-_/. ])(?:text-)?embed(?:ding)?s?(?:[-_/. ]|$)|ada-002(?:$|[-_/. ])/i;

export function isLikelyEmbeddingModelId(id: string): boolean {
  return EMBEDDING_ID_PATTERN.test(id);
}

export function createDefaultEmbeddingCapability(modelId: string): ModelCapability {
  return {
    id: modelId,
    kind: "embedding",
    contextWindow: 8_191,
    maxOutputTokens: 0,
    toolCalling: false,
    structuredOutput: false,
    streaming: false,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: false,
    costClass: "low",
    latencyClass: "fast",
    throughputHint: "runtime-configured embedding endpoint",
    preferredUseCases: ["Embeddings"],
    knownLimitations: [
      "Runtime-configured capability; validate against the target endpoint before production use",
    ],
  };
}

export function createDefaultChatCapability(modelId: string): ModelCapability {
  return {
    id: modelId,
    kind: "chat",
    contextWindow: 0,
    maxOutputTokens: 0,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    // Conservative defaults for an UNKNOWN discovered chat model (Issue #143 / AC #2):
    // text-only and not workflow-eligible until explicitly enriched.
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: false,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "runtime-configured endpoint",
    preferredUseCases: ["Chat"],
    knownLimitations: [
      "Runtime-configured capability; validate against the target endpoint before production use",
      "Image input, document input, and workflow eligibility require explicit enrichment",
    ],
  };
}

// Every requested boolean capability (when true) must be advertised by the model.
function satisfiesBooleanRequirements(cap: ModelCapability, query: CapabilityQuery): boolean {
  if (query.toolCalling === true && !cap.toolCalling) {
    return false;
  }
  if (query.structuredOutput === true && !cap.structuredOutput) {
    return false;
  }
  if (query.supportsImageInput === true && !cap.supportsImageInput) {
    return false;
  }
  return true;
}

function matches(cap: ModelCapability, query: CapabilityQuery): boolean {
  if (query.kind !== undefined && cap.kind !== query.kind) {
    return false;
  }
  if (!satisfiesBooleanRequirements(cap, query)) {
    return false;
  }
  if (query.minContextWindow !== undefined && cap.contextWindow < query.minContextWindow) {
    return false;
  }
  return true;
}

// Returns the lowest-cost capability satisfying the query, or undefined if none.
// Ties on cost class are broken by registry order (first declared wins).
export function selectCheapest(query: CapabilityQuery): ModelCapability | undefined {
  let best: ModelCapability | undefined;
  for (const cap of CAPABILITY_REGISTRY) {
    if (!matches(cap, query)) {
      continue;
    }
    if (best === undefined || COST_RANK[cap.costClass] < COST_RANK[best.costClass]) {
      best = cap;
    }
  }
  return best;
}

// ─── Completion-model selection (Issue #1210, ADR-0042 D5) ─────────────────────

// Options for completion-model selection.
export interface CompletionSelectionOptions {
  // The maximum cost class the inline-completion feature is allowed to spend on a per-call basis
  // (#1206 server-side cost ceiling). A candidate above this ceiling is excluded; if excluding it
  // leaves no eligible model, selection degrades deterministically with reason "over-cost-ceiling".
  // Omitted means no ceiling — the caller (#1206) supplies the deployment policy, so this layer
  // invents no default budget.
  readonly maxCostClass?: CostClass | undefined;
}

// Lowest-cost capability among the candidates, breaking cost ties by input order (first wins) —
// the same deterministic discipline as `selectCheapest` / `selectConfiguredModel`.
function cheapest(candidates: readonly ModelCapability[]): ModelCapability | undefined {
  let best: ModelCapability | undefined;
  for (const cap of candidates) {
    if (best === undefined || COST_RANK[cap.costClass] < COST_RANK[best.costClass]) {
      best = cap;
    }
  }
  return best;
}

function withinCostCeiling(cap: ModelCapability, ceiling: CostClass | undefined): boolean {
  return ceiling === undefined || COST_RANK[cap.costClass] <= COST_RANK[ceiling];
}

// Classifies WHY no model-backed mode was chosen, in strict precedence so the reason is the most
// specific true cause: an over-ceiling aligned model (the model exists, the budget does not) is a
// different operator signal than only-base (a security rejection) or no-infilling (a capability gap).
function degradeReasonFor(
  capabilities: readonly ModelCapability[],
  ceiling: CostClass | undefined,
): CompletionDegradeReason {
  if (
    capabilities.some((cap) => isAlignedInfillingModel(cap) && !withinCostCeiling(cap, ceiling))
  ) {
    return "over-cost-ceiling";
  }
  if (capabilities.some((cap) => modelSupportsInfilling(cap))) {
    return "only-base-infilling-model";
  }
  return "no-infilling-model";
}

// Selects the completion-model interaction mode from a set of capabilities, applying ADR-0042 D5:
// prefer a fast, aligned FIM model for as-you-type ghost text; otherwise a slower aligned FIM model
// for manual-invoke suggestion; otherwise degrade to deterministic language-service completion
// (#1198). The result is content-free and serialisable across the host/server boundary. This is the
// pure core; `selectCompletionModel` (model-selection.ts) binds it to a GatewayConfig.
export function selectCompletionModelFromCapabilities(
  capabilities: readonly ModelCapability[],
  options: CompletionSelectionOptions = {},
): CompletionModelSelection {
  const ceiling = options.maxCostClass;
  const alignedWithinCeiling = capabilities.filter(
    (cap) => isAlignedInfillingModel(cap) && withinCostCeiling(cap, ceiling),
  );

  const asYouType = cheapest(alignedWithinCeiling.filter(isAsYouTypeCompletionModel));
  if (asYouType !== undefined) {
    return { mode: "as-you-type", modelId: asYouType.id, latencyClass: asYouType.latencyClass };
  }

  const manual = cheapest(alignedWithinCeiling);
  if (manual !== undefined) {
    return { mode: "manual", modelId: manual.id, latencyClass: manual.latencyClass };
  }

  return { mode: "deterministic", degradeReason: degradeReasonFor(capabilities, ceiling) };
}

// ─── Voice capability resolution (Issue #493, ADR-0058 D1/D2/D3) ───────────────
// Resolves the effective voice profile from a set of capabilities. Pure, deterministic, and
// content-free: it performs NO network probe (capability probing must not call external endpoints
// during ordinary startup — ADR-0058 out-of-scope for #493) and returns only enum literals and
// booleans, so the result is safe to serialise to the browser and safe to log (AC4/AC5). This is
// the pure core; `resolveVoiceCapability` (model-selection.ts) binds it to a GatewayConfig.

export interface VoiceResolutionOptions {
  // When true, voice is disabled by deployment policy (an operator kill-switch). The resolution is
  // a clean `unavailable` with reason "policy-disabled" — Keiko never fails to start (AC1, D1).
  readonly policyDisabled?: boolean | undefined;
  // Provider/model ids currently known to be unreachable (e.g. an open circuit breaker). Voice
  // providers in this set are excluded. Reachability is supplied by the caller; this layer performs
  // no probe of its own, so a missing/unreachable provider degrades cleanly rather than crashing.
  readonly unreachableProviderIds?: ReadonlySet<string> | undefined;
}

function unavailableVoice(reason: VoiceUnavailableReason): VoiceCapabilityResolution {
  return {
    available: false,
    profile: "none",
    capabilities: { speechToText: false, speechOutput: false, realtimeVoice: false },
    transport: { websocketControl: false, webrtcMedia: false },
    // HAZARD-2: an unavailable resolution offers no personas. Empty is the honest value (the field
    // is required on VoiceCapabilityResolution).
    availableVoicePersonas: [],
    reason,
  };
}

// Aggregate union of the product voice personas across the reachable providers that advertise
// speech output or realtime voice (Issue #1557, ADR-0088 D2 / HAZARD-2). Personas are OUTPUT voices,
// so an STT-only provider contributes none. Sorted canonical (VOICE_PERSONAS) order, content-free.
function availablePersonasFor(capabilities: readonly ModelCapability[]): readonly VoicePersona[] {
  const present = new Set<VoicePersona>();
  for (const capability of capabilities) {
    if (!modelSupportsSpeechOutput(capability) && !modelSupportsRealtimeVoice(capability)) {
      continue;
    }
    for (const persona of capability.supportedVoicePersonas ?? []) {
      present.add(persona);
    }
  }
  return VOICE_PERSONAS.filter((persona) => present.has(persona));
}

// The single effective locality when every elected voice provider agrees; undefined when none
// declare one or they disagree (a mixed deployment), so the UI never claims a single locality
// that is not in effect.
function singleVoiceLocality(
  capabilities: readonly ModelCapability[],
): VoiceProviderLocality | undefined {
  const localities = new Set<VoiceProviderLocality>();
  for (const capability of capabilities) {
    if (capability.voiceProviderLocality !== undefined) {
      localities.add(capability.voiceProviderLocality);
    }
  }
  return localities.size === 1 ? [...localities][0] : undefined;
}

// Maps the advertised sub-capabilities to a profile on the degradation ladder. Full realtime
// conversation requires realtime speech OR both speech input AND speech output (AC3, ADR-0058 D2).
function voiceProfileFor(
  speechToText: boolean,
  speechOutput: boolean,
  realtimeVoice: boolean,
): VoiceProfile {
  if (realtimeVoice || (speechToText && speechOutput)) {
    return "full-realtime";
  }
  if (speechToText) {
    return "speech-to-text";
  }
  if (speechOutput) {
    return "speech-output";
  }
  return "none";
}

export function resolveVoiceCapabilityFromCapabilities(
  capabilities: readonly ModelCapability[],
  options: VoiceResolutionOptions = {},
): VoiceCapabilityResolution {
  if (options.policyDisabled === true) {
    return unavailableVoice("policy-disabled");
  }
  const voiceCapabilities = capabilities.filter(isVoiceCapability);
  const unreachable = options.unreachableProviderIds;
  const reachable =
    unreachable === undefined
      ? voiceCapabilities
      : voiceCapabilities.filter((capability) => !unreachable.has(capability.id));
  if (reachable.length === 0) {
    // Configured but all unreachable is a distinct operator signal from "none configured".
    return unavailableVoice(
      voiceCapabilities.length > 0 ? "provider-unreachable" : "no-voice-provider",
    );
  }
  const speechToText = reachable.some(modelSupportsSpeechInput);
  const speechOutput = reachable.some(modelSupportsSpeechOutput);
  const realtimeVoice = reachable.some(modelSupportsRealtimeVoice);
  const profile = voiceProfileFor(speechToText, speechOutput, realtimeVoice);
  if (profile === "none") {
    // Defensive: a voice capability advertises ≥1 sub-capability by config invariant, so this is
    // unreachable in practice — kept fail-closed rather than reporting a broken affordance.
    return unavailableVoice("no-voice-provider");
  }
  const locality = singleVoiceLocality(reachable);
  return {
    available: true,
    profile,
    capabilities: { speechToText, speechOutput, realtimeVoice },
    transport: { websocketControl: true, webrtcMedia: profile === "full-realtime" },
    availableVoicePersonas: availablePersonasFor(reachable),
    ...(locality !== undefined ? { providerLocality: locality } : {}),
  };
}
