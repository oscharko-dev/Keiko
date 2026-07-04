import {
  COST_RANK,
  createDefaultChatCapability,
  createDefaultEmbeddingCapability,
  isLikelyEmbeddingModelId,
  listCapabilities,
  modelSupportsRealtimeVoice,
  modelSupportsSpeechInput,
  modelSupportsSpeechOutput,
  resolveVoiceCapabilityFromCapabilities,
  selectCompletionModelFromCapabilities,
  type CompletionSelectionOptions,
  type VoiceResolutionOptions,
} from "./capabilities.js";
import { ConfigInvalidError } from "@oscharko-dev/keiko-security/errors/gateway";
import type {
  CompletionModelSelection,
  GatewayConfig,
  ModelCapability,
  ModelKind,
  VoiceCapabilityResolution,
  VoicePersona,
} from "./types.js";

const voiceCapabilityCache = new WeakMap<
  ConfiguredCapabilitySource,
  Map<string, VoiceCapabilityResolution>
>();

export interface ModelSelectionQuery {
  readonly kind: ModelKind;
  readonly toolCalling?: boolean | undefined;
  readonly structuredOutput?: boolean | undefined;
  readonly minContextWindow?: number | undefined;
  // Issue #810: require image-input (multimodal) capability. When true, only configured
  // models that advertise supportsImageInput === true are eligible.
  readonly supportsImageInput?: boolean | undefined;
}

export interface ConfiguredCapabilityProvider {
  readonly modelId: string;
}

export interface ConfiguredCapabilitySource {
  readonly providers: readonly ConfiguredCapabilityProvider[];
  readonly capabilities?: readonly ModelCapability[] | undefined;
}

function matches(capability: ModelCapability, query: ModelSelectionQuery): boolean {
  if (capability.kind !== query.kind) {
    return false;
  }
  if (query.toolCalling === true && !capability.toolCalling) {
    return false;
  }
  if (query.structuredOutput === true && !capability.structuredOutput) {
    return false;
  }
  if (query.supportsImageInput === true && !capability.supportsImageInput) {
    return false;
  }
  if (query.minContextWindow !== undefined && capability.contextWindow < query.minContextWindow) {
    return false;
  }
  return true;
}

export function assertConfiguredModel(config: ConfiguredCapabilitySource, modelId: string): void {
  if (!config.providers.some((provider) => provider.modelId === modelId)) {
    throw new ConfigInvalidError(`model '${modelId}' is not configured as a provider`);
  }
}

export function findConfiguredCapability(
  config: ConfiguredCapabilitySource,
  modelId: string,
): ModelCapability | undefined {
  return (
    config.capabilities?.find((capability) => capability.id === modelId) ??
    listCapabilities().find((capability) => capability.id === modelId) ??
    (config.providers.some((provider) => provider.modelId === modelId)
      ? isLikelyEmbeddingModelId(modelId)
        ? createDefaultEmbeddingCapability(modelId)
        : createDefaultChatCapability(modelId)
      : undefined)
  );
}

export function listConfiguredCapabilities(
  config: ConfiguredCapabilitySource,
): readonly ModelCapability[] {
  return config.providers
    .map((provider) => findConfiguredCapability(config, provider.modelId))
    .filter((capability): capability is ModelCapability => capability !== undefined);
}

export function selectConfiguredModel(
  config: ConfiguredCapabilitySource,
  query: ModelSelectionQuery,
): string | undefined {
  let best: ModelCapability | undefined;
  for (const capability of listConfiguredCapabilities(config)) {
    if (!matches(capability, query)) {
      continue;
    }
    if (best === undefined || COST_RANK[capability.costClass] < COST_RANK[best.costClass]) {
      best = capability;
    }
  }
  return best?.id;
}

// Completion-oriented model selection (Issue #1210, ADR-0042 D5). Resolves the configured
// capabilities and applies the infilling-aware decision tree (as-you-type → manual → deterministic)
// from `selectCompletionModelFromCapabilities`. Only configured providers are eligible, so a
// capability that names no provider can never be elected. The result is content-free.
export function selectCompletionModel(
  config: GatewayConfig,
  options: CompletionSelectionOptions = {},
): CompletionModelSelection {
  return selectCompletionModelFromCapabilities(listConfiguredCapabilities(config), options);
}

function voiceResolutionCacheKey(options: VoiceResolutionOptions): string {
  const unreachable = options.unreachableProviderIds;
  const unreachableKey =
    unreachable === undefined ? "" : [...unreachable].sort((a, b) => a.localeCompare(b)).join("\0");
  return `${options.policyDisabled === true ? "1" : "0"}:${unreachableKey}`;
}

// Voice-capability resolution (Issue #493, ADR-0100 D1/D2). Resolves the configured capabilities
// and applies the voice profile ladder. Only configured providers are eligible, so a voice
// capability that names no provider can never be elected — the same fail-closed rule as completion
// selection. The result is content-free and safe to serialise to the browser (AC4/AC5).
export function resolveVoiceCapability(
  config: ConfiguredCapabilitySource,
  options: VoiceResolutionOptions = {},
): VoiceCapabilityResolution {
  const key = voiceResolutionCacheKey(options);
  let byOptions = voiceCapabilityCache.get(config);
  if (byOptions === undefined) {
    byOptions = new Map();
    voiceCapabilityCache.set(config, byOptions);
  }
  const cached = byOptions.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const resolved = resolveVoiceCapabilityFromCapabilities(
    listConfiguredCapabilities(config),
    options,
  );
  byOptions.set(key, resolved);
  return resolved;
}

// Speech-to-text model selection (Issue #494, ADR-0100 D2/D4). Returns the configured voice
// provider that advertises speech-to-text (dictation), cheapest-first by cost class, or undefined
// when none is configured. Only configured providers are eligible — the same fail-closed rule as
// `selectConfiguredModel` — so a voice capability that names no provider can never be elected, and a
// no-voice deployment yields undefined (the BFF dictation route then answers voice-unavailable, AC1).
export function selectSpeechToTextModel(config: ConfiguredCapabilitySource): string | undefined {
  let best: ModelCapability | undefined;
  for (const capability of listConfiguredCapabilities(config)) {
    if (!modelSupportsSpeechInput(capability)) {
      continue;
    }
    if (best === undefined || COST_RANK[capability.costClass] < COST_RANK[best.costClass]) {
      best = capability;
    }
  }
  return best?.id;
}

// Realtime-voice model selection (Issue #497, ADR-0100 D3, ADR-0101). Returns the configured voice
// provider that advertises realtime voice (full-duplex conversation), cheapest-first by cost class,
// or undefined when none is configured. Only configured providers are eligible — the same
// fail-closed rule as `selectSpeechToTextModel` — so a voice capability that names no provider can
// never be elected, and a no-voice / STT-only deployment yields undefined (the BFF realtime route
// then answers voice-unavailable and the WebSocket control upgrade stays hard-rejected, AC1/AC3).
export function selectRealtimeVoiceModel(config: ConfiguredCapabilitySource): string | undefined {
  let best: ModelCapability | undefined;
  for (const capability of listConfiguredCapabilities(config)) {
    if (!modelSupportsRealtimeVoice(capability)) {
      continue;
    }
    if (best === undefined || COST_RANK[capability.costClass] < COST_RANK[best.costClass]) {
      best = capability;
    }
  }
  return best?.id;
}

// Speech-output model selection (Issue #1557, ADR-0094 D6). Returns the configured voice provider
// that advertises speech output (synthesis / playback), cheapest-first by cost class, or undefined
// when none is configured. Only configured providers are eligible — the same fail-closed rule as
// `selectSpeechToTextModel` — so a no-voice / STT-only deployment yields undefined.
export function selectSpeechOutputModel(config: ConfiguredCapabilitySource): string | undefined {
  let best: ModelCapability | undefined;
  for (const capability of listConfiguredCapabilities(config)) {
    if (!modelSupportsSpeechOutput(capability)) {
      continue;
    }
    if (best === undefined || COST_RANK[capability.costClass] < COST_RANK[best.costClass]) {
      best = capability;
    }
  }
  return best?.id;
}

// The persona → voice-id resolution for one configured voice provider, or undefined when the
// provider does not map the persona. Reads the credential-tier `voiceProfiles` (Issue #1557).
function voiceIdForPersona(
  config: GatewayConfig,
  modelId: string,
  persona: VoicePersona,
): string | undefined {
  const provider = config.providers.find((candidate) => candidate.modelId === modelId);
  return provider?.voiceProfiles?.find((profile) => profile.persona === persona)?.voiceId;
}

// Server-side persona → voice-id resolver (Issue #1557, ADR-0094 D6) — the seam Issue #1558 consumes.
// Among configured providers whose capability advertises speech output OR realtime voice AND whose
// `voiceProfiles` maps `persona`, returns the cheapest-first `{ modelId, voiceId }`, or undefined.
// The returned `voiceId` is provider-sensitive, so this STAYS server-side and is never a BFF body.
export function selectVoicePersonaVoice(
  config: GatewayConfig,
  persona: VoicePersona,
): { readonly modelId: string; readonly voiceId: string } | undefined {
  let best: { readonly capability: ModelCapability; readonly voiceId: string } | undefined;
  for (const capability of listConfiguredCapabilities(config)) {
    if (!modelSupportsSpeechOutput(capability) && !modelSupportsRealtimeVoice(capability)) {
      continue;
    }
    const voiceId = voiceIdForPersona(config, capability.id, persona);
    if (voiceId === undefined) {
      continue;
    }
    if (
      best === undefined ||
      COST_RANK[capability.costClass] < COST_RANK[best.capability.costClass]
    ) {
      best = { capability, voiceId };
    }
  }
  return best === undefined ? undefined : { modelId: best.capability.id, voiceId: best.voiceId };
}
