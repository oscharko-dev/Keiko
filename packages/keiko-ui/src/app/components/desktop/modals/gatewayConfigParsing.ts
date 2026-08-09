/**
 * Parses an uploaded `keiko.config.json` into the gateway-setup form fields (owner-directed,
 * 0.3.0-beta.2): teams that already maintain a model-gateway configuration file load it instead of
 * retyping every field. The parser is fail-closed — any structural violation, connection-scalar
 * conflict, or provider kind this form cannot represent refuses the whole file rather than
 * applying a distorted half of it — and it runs entirely in the browser: the file is never
 * uploaded anywhere, and the parsed values flow into the exact same form state and validation
 * path as manual entry.
 *
 * Voice providers (`kind: "voice"`) map onto the dedicated voice setup fields: the file this
 * feature exists for is a persisted product configuration, so the connection scalars, role model
 * ids, AND the endpoint protocol (endpoint style, API version, realtime auth mode) travel through
 * the form — the setup route persists the protocol verbatim (#3037), and profiles map to the
 * output voice.
 */

import { PROVIDER_ENDPOINT_STYLES, REALTIME_AUTH_MODES } from "@/lib/types";
import type { VoiceProviderLocality } from "@/lib/types";

export const MAX_GATEWAY_CONFIG_BYTES = 256 * 1024;

/** Mirrors the setup route's MAX_DEPLOYMENT_NAMES so an oversized file fails here, not at Test & Save. */
const MAX_IMPORT_PROVIDERS = 100;
/** Mirrors the setup route's model-id bound so an unusable id fails here, not at Test & Save. */
const MAX_IMPORT_MODEL_ID_LENGTH = 160;
/**
 * Mirrors the model gateway's SUPPORTED_API_KEY_HEADER_NAMES — an unsupported header would be
 * rejected by Test & Save AFTER a reported upload success (review finding on #3031).
 */
const SUPPORTED_API_KEY_HEADER_NAMES = new Set([
  "authorization",
  "x-litellm-key",
  "x-api-key",
  "api-key",
]);
/**
 * Generic provider settings the setup form has no field for — importing a chat or embedding
 * provider that carries one would silently change runtime behavior (review finding on #3031).
 * Voice providers are exempt: their endpoint protocol fields are imported and submitted
 * verbatim through the voice setup fields (#3037), and profiles map to the output voice.
 * Retry tuning (maxRetries, retryBaseDelayMs) stays tolerated everywhere: the form has no field
 * for it either, but it does not change which endpoint or protocol the connection speaks.
 * `endpointStyle` is checked value-aware instead (see unsupportedGenericEndpointStyle).
 */
/**
 * A secret REFERENCE is a credential source the form cannot carry (the token field takes a
 * plaintext key that the save re-seals into the vault) — silently dropping a provider's only
 * credential source would leave the form unsavable or inherit an unrelated stored token. The
 * product's own persisted file never carries the field (its credentials live in the sealed
 * vault, outside the JSON), so refusing cannot reject a round-trip (review finding on #3037).
 */
const UNSUPPORTED_CREDENTIAL_REFERENCE = "apiKeySecretRef";

const UNSUPPORTED_GENERIC_PROVIDER_SETTINGS = [
  "apiVersion",
  "outputTokenParameter",
  "realtimeAuthMode",
  "voiceProfiles",
] as const;

/**
 * An explicit `endpointStyle: "openai-compatible"` on a chat/embedding provider is behaviorally
 * identical to the absent default — LiteLLM-shaped files state the default explicitly, and
 * refusing it would reject exactly the files this feature exists for (LiteLLM production
 * audit). The Azure deployment style and unknown values keep refusing: the setup form cannot
 * represent a generic provider that speaks a different endpoint shape.
 */
function unsupportedGenericEndpointStyle(value: unknown): boolean {
  if (value === undefined) return false;
  return !(typeof value === "string" && value.trim() === "openai-compatible");
}
/**
 * Top-level blocks the setup form can represent. A file carrying `grounding`, `reranker`,
 * `egress`, or any other policy block would be persisted WITHOUT it by the rebuild — loading and
 * saving must never silently change retrieval, reranking, or egress behavior (review finding on
 * #3031).
 */
const REPRESENTABLE_ROOT_KEYS = new Set(["providers", "capabilities", "circuitBreaker", "figma"]);
const KNOWN_KINDS = new Set(["chat", "embedding", "ocr-vision", "voice"]);
const VOICE_PERSONAS = new Set(["male", "female", "neutral"]);
/** The provider kinds SOME setup field can represent; `ocr-vision` has none. */
const REPRESENTABLE_KINDS = new Set(["chat", "embedding", "voice"]);
const VOICE_LOCALITIES: ReadonlySet<VoiceProviderLocality> = new Set([
  "azure-foundry",
  "customer-hosted",
  "local-only",
]);
/**
 * The setup route rebuilds the circuit breaker with exactly these values and the form has no
 * field for them — a file that tunes them differently cannot be represented without silently
 * changing retry-isolation behavior (review finding on #3031).
 */
const REBUILT_CIRCUIT_BREAKER = { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 };
/**
 * The rebuild writes exactly these retry values onto generic providers; a file tuning them
 * differently would be silently rewritten on save (review finding on #3031). Voice providers
 * are exempt — the voice route inherits their stored retry tuning.
 */
const REBUILT_GENERIC_RETRY = { maxRetries: 2, retryBaseDelayMs: 500 };
const CAPABILITY_FLAG_KEYS = [
  "supportsImageInput",
  "workflowEligible",
  "supportsSpeechInput",
  "supportsSpeechOutput",
  "supportsRealtimeVoice",
  "supportsSemanticTurnDetection",
  "supportsSpeechSynthesisInstructions",
] as const;

export interface GatewayConfigUploadFields {
  readonly baseUrl: string | undefined;
  readonly apiKey: string | undefined;
  readonly apiKeyHeaderName: string | undefined;
  readonly timeoutMs: string | undefined;
  readonly deploymentNames: readonly string[];
  /**
   * `undefined` when the file never speaks about the flag (no chat/embedding capability record
   * anywhere); an EMPTY list when it speaks and declares no model eligible — which must clear
   * the form field exactly like manually emptying it would.
   */
  readonly imageInputModelIds: readonly string[] | undefined;
  readonly workflowEligibleModelIds: readonly string[] | undefined;
  /**
   * The embedding-kind deployment ids the file declares — asserted through the setup request so
   * a FRESH setup cannot chat-probe (and drop) an embedding whose id defies the server's name
   * heuristic (review finding on #3037). `undefined` when the file declares none.
   */
  readonly embeddingModelIds: readonly string[] | undefined;
  readonly voiceBaseUrl: string | undefined;
  readonly voiceApiKey: string | undefined;
  readonly voiceApiKeyHeaderName: string | undefined;
  readonly voiceTimeoutMs: string | undefined;
  /**
   * The endpoint protocol of the imported voice connection, submitted verbatim so a fresh save
   * of an Azure speech endpoint keeps its deployment-path URL shape (#3037).
   */
  readonly voiceEndpointStyle: string | undefined;
  readonly voiceApiVersion: string | undefined;
  readonly voiceRealtimeAuthMode: string | undefined;
  /** The speech-to-text deployment id. */
  readonly voiceModelId: string | undefined;
  readonly voiceSpeechOutputModelId: string | undefined;
  readonly voiceRealtimeModelId: string | undefined;
  readonly voiceRealtimeTranscriptionModelId: string | undefined;
  /** `undefined` when the file carries no realtime voice capability to speak about it. */
  readonly voiceSemanticTurnDetection: boolean | undefined;
  /** `undefined` when the file carries no speech-output provider to speak about it. */
  readonly voiceSupportsSpeechSynthesisInstructions: boolean | undefined;
  /** Derived from the speech-output provider's voice profiles — see voiceProfilesReduced. */
  readonly voiceOutputVoiceId: string | undefined;
  /**
   * True when the speech-output provider carries several DIFFERENT profile voices: the form
   * holds one output voice, so the neutral persona's voice is applied and the reduction is
   * stated (review finding on #3031 — never silently, never a refusal that would lose the
   * whole file).
   */
  readonly voiceProfilesReduced: boolean;
  readonly voiceProviderLocality: VoiceProviderLocality | undefined;
  /**
   * True when the file carries a realtime voice provider on a DIFFERENT connection than the
   * speech providers. The form holds one voice connection per submit, so that provider cannot
   * be imported alongside them — the upload states the skip instead of silently dropping it or
   * refusing the whole file (the persisted product configuration this feature exists for has
   * exactly this shape: realtime on the gateway endpoint, speech on a dedicated one).
   */
  readonly voiceRealtimeSkipped: boolean;
  /**
   * True when an imported voice provider tunes maxRetries/retryBaseDelayMs away from the values
   * a fresh save persists (1/500) — the flat form cannot express per-role retry tuning, so the
   * reset is stated loudly instead of silently rewriting or refusing the file (#3037).
   */
  readonly voiceRetryTuningReset: boolean;
  readonly figmaAccessToken: string | undefined;
}

export type GatewayConfigUploadResult =
  | { readonly outcome: "fields"; readonly fields: GatewayConfigUploadFields }
  | { readonly outcome: "invalid" }
  | { readonly outcome: "unsupportedKind" }
  | { readonly outcome: "unsupportedSetting" };

interface ParsedVoiceProfile {
  readonly persona: string;
  readonly voiceId: string;
}

interface ParsedProvider {
  readonly modelId: string;
  readonly baseUrl: string | undefined;
  readonly apiKey: string | undefined;
  readonly apiKeyHeaderName: string | undefined;
  readonly timeoutMs: number | undefined;
  /** Voice endpoint protocol — tolerated on voice providers, unsupported on generic ones. */
  readonly endpointStyle: string | undefined;
  readonly apiVersion: string | undefined;
  readonly realtimeAuthMode: string | undefined;
  readonly voiceProfiles: readonly ParsedVoiceProfile[] | undefined;
  readonly capability: ParsedCapability | undefined;
}

interface ParsedCapability {
  readonly kind: string;
  readonly supportsImageInput: boolean;
  readonly workflowEligible: boolean;
  readonly speechInput: boolean;
  readonly speechOutput: boolean;
  readonly realtime: boolean;
  readonly semanticTurnDetection: boolean;
  readonly speechSynthesisInstructions: boolean;
  readonly realtimeTranscriptionModel: string | undefined;
  readonly voiceProviderLocality: VoiceProviderLocality | undefined;
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Mirrors the setup route's model-id constraints (length bound, no control characters). A comma
 * is additionally refused fail-closed: it would survive the import only to be silently split
 * into two bogus ids by the dialog textarea's newline-and-comma splitter (LiteLLM production
 * audit).
 */
function usableModelId(id: string): boolean {
  if (id.length === 0 || id.length > MAX_IMPORT_MODEL_ID_LENGTH) return false;
  if (id.includes(",")) return false;
  for (const character of id) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return false;
  }
  return true;
}

/**
 * An ABSENT field reads as `undefined`; a PRESENT field must be a non-blank string or the whole
 * file refuses. Converting a malformed present value to silence would report a hostile or
 * corrupted file as successfully loaded (review finding on #3031).
 */
function readString(value: unknown): { readonly ok: boolean; readonly value: string | undefined } {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string" || value.trim() === "") return { ok: false, value: undefined };
  return { ok: true, value: value.trim() };
}

function readTimeout(value: unknown): { readonly ok: boolean; readonly value: number | undefined } {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return { ok: false, value: undefined };
  }
  return { ok: true, value };
}

function capabilityFlagsAreBooleans(value: Record<string, unknown>): boolean {
  return CAPABILITY_FLAG_KEYS.every(
    (key) => value[key] === undefined || typeof value[key] === "boolean",
  );
}

function readLocality(value: unknown): {
  readonly ok: boolean;
  readonly value: VoiceProviderLocality | undefined;
} {
  const locality = readString(value);
  if (!locality.ok) return { ok: false, value: undefined };
  if (locality.value === undefined) return { ok: true, value: undefined };
  return VOICE_LOCALITIES.has(locality.value as VoiceProviderLocality)
    ? { ok: true, value: locality.value as VoiceProviderLocality }
    : { ok: false, value: undefined };
}

/**
 * An inline capability whose `id` names a DIFFERENT model than its owning provider is corrupted
 * input — the canonical gateway parser rejects the same mismatch (review finding on #3031).
 */
function capabilityIdMatches(
  value: Record<string, unknown>,
  expectedId: string | undefined,
): boolean {
  if (expectedId === undefined) return true;
  const id = readString(value.id);
  return id.ok && (id.value === undefined || id.value === expectedId);
}

/**
 * A capability must carry a known string `kind` and boolean-or-absent flags; coercing a corrupted
 * declaration to `false` could clear stored image or workflow eligibility during an update while
 * reporting the file as loaded (review finding on #3031). Metadata fields the form does not read
 * (context window, cost class, …) stay tolerated — the persisted product configuration carries
 * them.
 */
function readTranscriptionModel(value: unknown): {
  readonly ok: boolean;
  readonly value: string | undefined;
} {
  const transcription = readString(value);
  if (!transcription.ok) return { ok: false, value: undefined };
  if (transcription.value !== undefined && !usableModelId(transcription.value)) {
    return { ok: false, value: undefined };
  }
  return transcription;
}

function knownCapabilityKind(value: unknown): string | undefined {
  return typeof value === "string" && KNOWN_KINDS.has(value) ? value : undefined;
}

/**
 * A flag may only be TRUE on the kind that owns it (chat: image/workflow; voice: the speech
 * roles) — the canonical parser rejects cross-kind declarations, and setup would silently drop
 * or rewrite them on save (review finding on #3031). False/absent stays tolerated everywhere:
 * the persisted product configuration writes explicit false onto every kind.
 */
function capabilityFlagsMatchKind(value: Record<string, unknown>, kind: string): boolean {
  const chatOnly = ["supportsImageInput", "workflowEligible"];
  const voiceOnly = [
    "supportsSpeechInput",
    "supportsSpeechOutput",
    "supportsRealtimeVoice",
    "supportsSemanticTurnDetection",
    "supportsSpeechSynthesisInstructions",
  ];
  if (kind !== "chat" && chatOnly.some((flag) => value[flag] === true)) return false;
  if (kind !== "voice" && voiceOnly.some((flag) => value[flag] === true)) return false;
  if (!realtimeTuningMatchesSupport(value)) return false;
  // The canonical parser requires an explicit locality on every voice capability
  // (resolveVoiceKindFields) — defaulting an absent one would silently rewrite a file the
  // product itself refuses to load (review finding on #3037).
  if (kind === "voice" && value.voiceProviderLocality === undefined) return false;
  return true;
}

/**
 * Realtime-scoped tuning requires realtime support (canonical assertVoiceTuningInvariants). A
 * transcription model without supportsRealtimeVoice also covers every non-voice kind, where the
 * flag can never be true — the form would otherwise report success and silently drop the model,
 * because only a realtime provider carries it into the voice fields; semantic turn detection is
 * the same class (review findings on #3031/#3037).
 */
function realtimeTuningMatchesSupport(value: Record<string, unknown>): boolean {
  if (value.realtimeTranscriptionModel !== undefined && value.supportsRealtimeVoice !== true) {
    return false;
  }
  // Synthesis instructions are speech-output tuning — the canonical parser checks field
  // PRESENCE (a declared false without speech output refuses too, review finding on #3041).
  if (
    value.supportsSpeechSynthesisInstructions !== undefined &&
    value.supportsSpeechOutput !== true
  ) {
    return false;
  }
  return !(value.supportsSemanticTurnDetection === true && value.supportsRealtimeVoice !== true);
}

function parsedCapability(value: unknown, expectedId?: string): ParsedCapability | undefined {
  if (!objectRecord(value) || !capabilityFlagsAreBooleans(value)) return undefined;
  if (!capabilityIdMatches(value, expectedId)) return undefined;
  const kind = knownCapabilityKind(value.kind);
  if (kind === undefined) return undefined;
  if (!capabilityFlagsMatchKind(value, kind)) return undefined;
  const transcription = readTranscriptionModel(value.realtimeTranscriptionModel);
  if (!transcription.ok) return undefined;
  const locality = readLocality(value.voiceProviderLocality);
  if (!locality.ok) return undefined;
  // Voice-tier fields belong to voice capabilities only — the canonical parser rejects a chat or
  // embedding capability carrying voiceProviderLocality (assertNoVoiceFieldsForNonVoiceKind), so
  // accepting it here would report success for a file the product refuses, silently discarding
  // the field on save (review finding on #3037).
  if (kind !== "voice" && locality.value !== undefined) return undefined;
  return {
    kind,
    supportsImageInput: value.supportsImageInput === true,
    workflowEligible: value.workflowEligible === true,
    speechInput: value.supportsSpeechInput === true,
    speechOutput: value.supportsSpeechOutput === true,
    realtime: value.supportsRealtimeVoice === true,
    semanticTurnDetection: value.supportsSemanticTurnDetection === true,
    speechSynthesisInstructions: value.supportsSpeechSynthesisInstructions === true,
    realtimeTranscriptionModel: transcription.value,
    voiceProviderLocality: locality.value,
  };
}

function readVoiceProfiles(value: unknown): {
  readonly ok: boolean;
  readonly value: readonly ParsedVoiceProfile[] | undefined;
} {
  if (value === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(value)) return { ok: false, value: undefined };
  const profiles: ParsedVoiceProfile[] = [];
  const seenPersonas = new Set<string>();
  for (const entry of value) {
    if (!objectRecord(entry)) return { ok: false, value: undefined };
    const persona = readString(entry.persona);
    const voiceId = readString(entry.voiceId);
    if (persona.value === undefined || voiceId.value === undefined) {
      return { ok: false, value: undefined };
    }
    // The production parser requires a known persona and rejects duplicates — a corrupted
    // mapping must not silently pick an arbitrary voice on save (review finding on #3031).
    if (!VOICE_PERSONAS.has(persona.value) || seenPersonas.has(persona.value)) {
      return { ok: false, value: undefined };
    }
    seenPersonas.add(persona.value);
    profiles.push({ persona: persona.value, voiceId: voiceId.value });
  }
  return { ok: true, value: profiles };
}

// Mirrors the canonical validateBaseUrl shape rules: absolute http(s), plaintext http only for
// loopback hosts, no credentials, query, or fragment — a malformed URL would turn a reported
// upload success into a guaranteed Test & Save failure (review finding on #3037).
// Mirrors validateBaseUrl's loopback set: localhost, ::1 (bracketed or not), and every
// well-formed IPv4 address in 127.0.0.0/8 (review finding on #3037).
function isLoopbackHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") return true;
  const octets = hostname.split(".");
  if (octets.length !== 4 || octets[0] !== "127") return false;
  return octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255);
}

function representableBaseUrl(value: string | undefined): boolean {
  if (value === undefined) return true;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    return false;
  }
  return url.username === "" && url.password === "" && url.search === "" && url.hash === "";
}

function providerConnectionScalars(value: Record<string, unknown>): ConnectionScalars | undefined {
  const baseUrl = readString(value.baseUrl);
  const apiKey = readString(value.apiKey);
  const header = readString(value.apiKeyHeaderName);
  const timeout = readTimeout(value.timeoutMs);
  if (!baseUrl.ok || !apiKey.ok || !header.ok || !timeout.ok) return undefined;
  if (
    header.value !== undefined &&
    !SUPPORTED_API_KEY_HEADER_NAMES.has(header.value.toLowerCase())
  ) {
    return undefined;
  }
  if (!representableBaseUrl(baseUrl.value)) return undefined;
  return {
    baseUrl: baseUrl.value,
    apiKey: apiKey.value,
    // Lowercase-normalized: the gateway treats header names case-insensitively and the setup
    // route lowercases on submit, so raw casing must neither fail the uniformity check
    // ('x-litellm-key' vs 'X-Litellm-Key' — LiteLLM production audit) nor leak into the form.
    apiKeyHeaderName: header.value?.toLowerCase(),
    timeoutMs: timeout.value,
  };
}

/** Present retry tuning must equal what the rebuild writes — or the file refuses (generic only). */
function retryTuningRepresentable(value: Record<string, unknown>): boolean {
  const expectedKeys = Object.keys(
    REBUILT_GENERIC_RETRY,
  ) as readonly (keyof typeof REBUILT_GENERIC_RETRY)[];
  return expectedKeys.every(
    (key) => value[key] === undefined || value[key] === REBUILT_GENERIC_RETRY[key],
  );
}

function parsedProviderEndpointFields(
  value: Record<string, unknown>,
): VoiceEndpointScalars | undefined {
  const endpointStyle = readString(value.endpointStyle);
  const apiVersion = readString(value.apiVersion);
  const realtimeAuthMode = readString(value.realtimeAuthMode);
  if (!endpointStyle.ok || !apiVersion.ok || !realtimeAuthMode.ok) return undefined;
  return {
    endpointStyle: endpointStyle.value,
    apiVersion: apiVersion.value,
    realtimeAuthMode: realtimeAuthMode.value,
  };
}

function parsedProvider(value: unknown): ParsedProvider | undefined {
  if (!objectRecord(value)) return undefined;
  const modelId = readString(value.modelId);
  if (modelId.value === undefined || !usableModelId(modelId.value)) return undefined;
  const scalars = providerConnectionScalars(value);
  if (scalars === undefined) return undefined;
  const endpoint = parsedProviderEndpointFields(value);
  if (endpoint === undefined) return undefined;
  const voiceProfiles = readVoiceProfiles(value.voiceProfiles);
  if (!voiceProfiles.ok) return undefined;
  // A capability that is PRESENT but malformed is corrupted input, not an absent field — the
  // production parser rejects the same shape (review finding on #3031).
  const capability =
    value.capability === undefined ? undefined : parsedCapability(value.capability, modelId.value);
  if (value.capability !== undefined && capability === undefined) return undefined;
  return {
    modelId: modelId.value,
    ...scalars,
    ...endpoint,
    voiceProfiles: voiceProfiles.value,
    capability,
  };
}

function parsedProviders(value: unknown): readonly ParsedProvider[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const providers: ParsedProvider[] = [];
  for (const entry of value) {
    const provider = parsedProvider(entry);
    // Fail closed on the whole file: silently dropping a malformed provider would present a
    // half-applied configuration as a fully loaded one.
    if (provider === undefined) return undefined;
    providers.push(provider);
  }
  return providers;
}

function parsedTopLevelCapabilities(
  value: unknown,
): ReadonlyMap<string, ParsedCapability> | undefined {
  const byId = new Map<string, ParsedCapability>();
  if (value === undefined) return byId;
  if (!Array.isArray(value)) return undefined;
  for (const entry of value) {
    // Same fail-closed policy as the provider list: a malformed capability record refuses the
    // whole file instead of being silently skipped (review finding on #3031).
    if (!objectRecord(entry)) return undefined;
    const id = readString(entry.id);
    const capability = parsedCapability(entry);
    if (id.value === undefined || capability === undefined) return undefined;
    // A duplicated capability id would silently overwrite the earlier declaration — corrupted
    // input, refused like every other malformed record (review finding on #3031).
    if (byId.has(id.value)) return undefined;
    byId.set(id.value, capability);
  }
  return byId;
}

/**
 * One connection per provider group: the form holds a single base URL, token, header, and timeout
 * for the generic providers and a single set for voice. Providers that disagree — including a MIX
 * of a stated value and an omitted one — cannot be represented: applying one provider's value to
 * the others would silently rewrite them (review findings on #3031).
 */
function uniformScalar<T>(values: readonly (T | undefined)[]): {
  readonly ok: boolean;
  readonly value: T | undefined;
} {
  const distinct = [...new Set(values)];
  return distinct.length > 1 ? { ok: false, value: undefined } : { ok: true, value: distinct[0] };
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

/**
 * Top-level capability records are authoritative, mirroring the production configuration parser:
 * they override inline provider declarations for the same model id (review finding on #3031).
 */
function effectiveCapabilities(
  providers: readonly ParsedProvider[],
  topLevel: ReadonlyMap<string, ParsedCapability>,
): ReadonlyMap<string, ParsedCapability> | undefined {
  const byId = new Map<string, ParsedCapability>();
  const providerIds = new Set(providers.map((provider) => provider.modelId));
  for (const provider of providers) {
    if (provider.capability !== undefined) byId.set(provider.modelId, provider.capability);
  }
  for (const [id, capability] of topLevel) {
    // A capability for a model no provider imports would put an untestable id into the flag
    // lists and fail Test & Save AFTER a reported success (review finding on #3031).
    if (!providerIds.has(id)) return undefined;
    byId.set(id, capability);
  }
  return byId;
}

interface PartitionedProviders {
  readonly generic: readonly ParsedProvider[];
  readonly voice: readonly ParsedProvider[];
  readonly capabilities: ReadonlyMap<string, ParsedCapability>;
}

function partitionProviders(
  providers: readonly ParsedProvider[],
  capabilities: ReadonlyMap<string, ParsedCapability>,
): PartitionedProviders {
  const voiceIds = new Set(
    [...capabilities.entries()]
      .filter(([, capability]) => capability.kind === "voice")
      .map(([id]) => id),
  );
  return {
    generic: providers.filter((provider) => !voiceIds.has(provider.modelId)),
    voice: providers.filter((provider) => voiceIds.has(provider.modelId)),
    capabilities,
  };
}

function carriesUnsupportedGenericSetting(
  rawProviders: unknown,
  genericIds: ReadonlySet<string>,
): boolean {
  if (!Array.isArray(rawProviders)) return false;
  return rawProviders.some(
    (entry) =>
      objectRecord(entry) &&
      typeof entry.modelId === "string" &&
      ((genericIds.has(entry.modelId.trim()) &&
        (UNSUPPORTED_GENERIC_PROVIDER_SETTINGS.some((setting) => entry[setting] !== undefined) ||
          unsupportedGenericEndpointStyle(entry.endpointStyle))) ||
        // A secret reference refuses on EVERY provider kind — no form field can carry it.
        entry[UNSUPPORTED_CREDENTIAL_REFERENCE] !== undefined),
  );
}

function carriesUnrepresentableRetryTuning(
  rawProviders: unknown,
  genericIds: ReadonlySet<string>,
): boolean {
  if (!Array.isArray(rawProviders)) return false;
  return rawProviders.some(
    (entry) =>
      objectRecord(entry) &&
      typeof entry.modelId === "string" &&
      genericIds.has(entry.modelId.trim()) &&
      !retryTuningRepresentable(entry),
  );
}

/** The generic (non-voice) deployment ids whose declared kind is embedding. */
function genericEmbeddingIds(partition: PartitionedProviders): readonly string[] | undefined {
  const ids = partition.generic
    .filter((provider) => partition.capabilities.get(provider.modelId)?.kind === "embedding")
    .map((provider) => provider.modelId);
  return ids.length > 0 ? ids : undefined;
}

/** Flag lists derive from CHAT capabilities only: the setup route smoke-tests chat candidates and
 * rejects non-chat ids in either list AFTER a reported upload success (review finding on #3031). */
function chatFlaggedIds(
  capabilities: ReadonlyMap<string, ParsedCapability>,
  flag: "supportsImageInput" | "workflowEligible",
): readonly string[] {
  return unique(
    [...capabilities.entries()]
      .filter(([, capability]) => capability.kind === "chat" && capability[flag])
      .map(([id]) => id),
  );
}

interface VoiceRoleProvider {
  readonly provider: ParsedProvider;
  readonly capability: ParsedCapability;
}

interface VoiceRoles {
  readonly speech: readonly VoiceRoleProvider[];
  readonly stt: VoiceRoleProvider | undefined;
  readonly tts: VoiceRoleProvider | undefined;
  readonly realtime: VoiceRoleProvider | undefined;
}

function singleRole(entries: readonly VoiceRoleProvider[]): {
  readonly ok: boolean;
  readonly value: VoiceRoleProvider | undefined;
} {
  // Two providers claiming the same voice role cannot both fill the one form field — refuse
  // rather than silently dropping one of them.
  return entries.length > 1 ? { ok: false, value: undefined } : { ok: true, value: entries.at(0) };
}

function voiceRoles(partition: PartitionedProviders): VoiceRoles | undefined {
  const withCapability = partition.voice.flatMap((provider) => {
    const capability = partition.capabilities.get(provider.modelId);
    return capability === undefined ? [] : [{ provider, capability }];
  });
  // A voice provider with no role flag at all cannot fill any field — refuse rather than
  // silently dropping it from a "successful" load.
  const roleless = withCapability.some(
    (entry) =>
      !entry.capability.speechInput && !entry.capability.speechOutput && !entry.capability.realtime,
  );
  if (roleless) return undefined;
  // Voice profiles belong to speech-output-capable providers — the canonical gateway parser
  // requires supportsSpeechOutput for a voiceProfiles block (a realtime-only capability does not
  // qualify), so accepting such a file here would report success for a configuration the product
  // itself rejects (review findings on #3031/#3037).
  const orphanedProfiles = withCapability.some(
    (entry) => entry.provider.voiceProfiles !== undefined && !entry.capability.speechOutput,
  );
  if (orphanedProfiles) return undefined;
  const stt = singleRole(
    withCapability.filter((entry) => entry.capability.speechInput && !entry.capability.realtime),
  );
  const tts = singleRole(
    withCapability.filter((entry) => entry.capability.speechOutput && !entry.capability.realtime),
  );
  const realtime = singleRole(withCapability.filter((entry) => entry.capability.realtime));
  if (!stt.ok || !tts.ok || !realtime.ok) return undefined;
  const speech = [...new Set([stt.value, tts.value])].filter(
    (entry): entry is VoiceRoleProvider => entry !== undefined,
  );
  return { speech, stt: stt.value, tts: tts.value, realtime: realtime.value };
}

interface VoiceFields {
  readonly connection: ConnectionScalars;
  readonly endpoint: VoiceEndpointScalars;
  readonly voiceModelId: string | undefined;
  readonly voiceSpeechOutputModelId: string | undefined;
  readonly voiceRealtimeModelId: string | undefined;
  readonly voiceRealtimeTranscriptionModelId: string | undefined;
  readonly voiceSemanticTurnDetection: boolean | undefined;
  readonly voiceSupportsSpeechSynthesisInstructions: boolean | undefined;
  readonly voiceOutputVoiceId: string | undefined;
  readonly voiceProfilesReduced: boolean;
  readonly voiceProviderLocality: VoiceProviderLocality | undefined;
  readonly voiceRealtimeSkipped: boolean;
}

function realtimeVoiceFields(realtime: VoiceRoleProvider | undefined): {
  readonly voiceRealtimeModelId: string | undefined;
  readonly voiceRealtimeTranscriptionModelId: string | undefined;
  readonly voiceSemanticTurnDetection: boolean | undefined;
} {
  return {
    voiceRealtimeModelId: realtime?.provider.modelId,
    voiceRealtimeTranscriptionModelId: realtime?.capability.realtimeTranscriptionModel,
    voiceSemanticTurnDetection: realtime?.capability.semanticTurnDetection,
  };
}

/**
 * The one voice connection a submit can hold. The speech (STT/TTS) providers must agree on it or
 * the file refuses; a realtime provider is included when it shares that connection (trivially so
 * when it is the only voice provider) and skipped otherwise — see
 * {@link GatewayConfigUploadFields.voiceRealtimeSkipped}.
 */
function resolvedVoiceConnection(roles: VoiceRoles):
  | {
      readonly connection: ConnectionScalars;
      readonly endpoint: VoiceEndpointScalars;
      readonly realtimeSkipped: boolean;
    }
  | undefined {
  const speechProviders = roles.speech.map((entry) => entry.provider);
  const speechConnection = uniformConnectionScalars(speechProviders);
  if (speechConnection === undefined) return undefined;
  const withRealtime =
    roles.realtime === undefined ? undefined : [...speechProviders, roles.realtime.provider];
  const combined = withRealtime === undefined ? undefined : uniformConnectionScalars(withRealtime);
  // The endpoint protocol is read from exactly the providers the chosen connection imports — a
  // SKIPPED realtime provider (different connection) must not contribute its protocol fields.
  const importedProviders = combined === undefined ? speechProviders : (withRealtime ?? []);
  const endpoint = uniformVoiceEndpoint(importedProviders);
  if (endpoint === undefined) return undefined;
  if (combined !== undefined) return { connection: combined, endpoint, realtimeSkipped: false };
  return {
    connection: speechConnection,
    endpoint,
    realtimeSkipped: roles.realtime !== undefined,
  };
}

/**
 * The form holds ONE output voice; the setup route persists it as the neutral persona's profile.
 * A uniform profile set imports losslessly; several different voices reduce to the neutral
 * persona's (first profile as fallback) with an explicit flag (review finding on #3031). No
 * profiles means no voice to derive — the form field stays empty and visibly required.
 */
function outputVoiceFromProfiles(profiles: readonly ParsedVoiceProfile[] | undefined): {
  readonly voiceId: string | undefined;
  readonly reduced: boolean;
} {
  if (profiles === undefined || profiles.length === 0) {
    return { voiceId: undefined, reduced: false };
  }
  const distinctVoices = new Set(profiles.map((profile) => profile.voiceId));
  if (distinctVoices.size === 1) return { voiceId: profiles[0]?.voiceId, reduced: false };
  const neutral = profiles.find((profile) => profile.persona === "neutral") ?? profiles[0];
  return { voiceId: neutral?.voiceId, reduced: true };
}

/**
 * The locality of every imported voice provider must agree — the form has one locality select.
 * Every parsed voice capability carries an explicit locality (parsedCapability refuses an
 * absent one, mirroring the canonical resolveVoiceKindFields requirement), so no default is
 * substituted here — a drifted undefined would surface as a disagreement, never as a silent
 * rewrite (review findings on #3031/#3037).
 */
function uniformVoiceLocality(imported: readonly VoiceRoleProvider[]): {
  readonly ok: boolean;
  readonly value: VoiceProviderLocality | undefined;
} {
  if (imported.length === 0) return { ok: true, value: undefined };
  const localities = new Set(imported.map((entry) => entry.capability.voiceProviderLocality));
  if (localities.size > 1) return { ok: false, value: undefined };
  return { ok: true, value: [...localities][0] };
}

/**
 * The setup route merges roles that share one model id, so a realtime provider that also
 * advertises speech roles fills any UNCLAIMED speech field — dropping the flag would silently
 * remove Dictate or Read-aloud support (review finding on #3031). A dedicated provider wins,
 * and a SKIPPED realtime provider (different connection) claims nothing.
 */
function effectiveSpeechRoles(
  roles: VoiceRoles,
  realtime: VoiceRoleProvider | undefined,
): { readonly stt: VoiceRoleProvider | undefined; readonly tts: VoiceRoleProvider | undefined } {
  return {
    stt: roles.stt ?? (realtime?.capability.speechInput === true ? realtime : undefined),
    tts: roles.tts ?? (realtime?.capability.speechOutput === true ? realtime : undefined),
  };
}

function definedVoiceProviders(
  entries: readonly (VoiceRoleProvider | undefined)[],
): readonly VoiceRoleProvider[] {
  return [...new Set(entries)].filter((entry): entry is VoiceRoleProvider => entry !== undefined);
}

// A voice section must name its endpoint: the canonical parser requires baseUrl on every
// provider and the product's sealed file always carries it. Importing role ids while
// voiceBaseUrl stays undefined would split the dialog's file-scoped replacement semantics,
// which key on voiceBaseUrl to decide whether the file speaks about voice at all (KfQ finding
// on #3037).
function voiceSectionLacksBaseUrl(
  partition: PartitionedProviders,
  connection: ConnectionScalars,
): boolean {
  return partition.voice.length > 0 && connection.baseUrl === undefined;
}

function voiceFields(partition: PartitionedProviders): VoiceFields | undefined {
  const roles = voiceRoles(partition);
  if (roles === undefined) return undefined;
  const resolved = resolvedVoiceConnection(roles);
  if (resolved === undefined) return undefined;
  if (voiceSectionLacksBaseUrl(partition, resolved.connection)) return undefined;
  const realtime = resolved.realtimeSkipped ? undefined : roles.realtime;
  const { stt, tts } = effectiveSpeechRoles(roles, realtime);
  const outputVoice = outputVoiceFromProfiles(tts?.provider.voiceProfiles);
  const locality = uniformVoiceLocality(definedVoiceProviders([stt, tts, realtime]));
  if (!locality.ok) return undefined;
  return {
    connection: resolved.connection,
    endpoint: resolved.endpoint,
    voiceModelId: stt?.provider.modelId,
    voiceSpeechOutputModelId: tts?.provider.modelId,
    // Behavior-bearing speech-output tuning travels with the TTS role — dropping it would
    // report success and silently lose instruction support (review finding on #3037).
    voiceSupportsSpeechSynthesisInstructions: tts?.capability.speechSynthesisInstructions,
    ...realtimeVoiceFields(realtime),
    voiceOutputVoiceId: outputVoice.voiceId,
    voiceProfilesReduced: outputVoice.reduced,
    voiceProviderLocality: locality.value,
    voiceRealtimeSkipped: resolved.realtimeSkipped,
  };
}

interface ConnectionScalars {
  readonly baseUrl: string | undefined;
  readonly apiKey: string | undefined;
  readonly apiKeyHeaderName: string | undefined;
  readonly timeoutMs: number | undefined;
}

interface VoiceEndpointScalars {
  readonly endpointStyle: string | undefined;
  readonly apiVersion: string | undefined;
  readonly realtimeAuthMode: string | undefined;
}

// The endpoint-protocol wire values come from the contract seam — the same compiler-checked
// source the server setup route and the model gateway validate against (#3037 follow-up).
const VOICE_ENDPOINT_STYLES = new Set<string>(PROVIDER_ENDPOINT_STYLES);
const VOICE_REALTIME_AUTH_MODES = new Set<string>(REALTIME_AUTH_MODES);

/**
 * The endpoint protocol of the imported voice connection. The setup route persists these fields
 * verbatim (#3037) — so the same fail-closed rules the product parser enforces apply here: every
 * imported provider must agree (the form submits ONE protocol per connection), the style and auth
 * mode must be values the gateway speaks, and an apiVersion is only meaningful for the Azure
 * deployment shape.
 */
// Mirrors the model gateway's API_VERSION_RE (resolveProviderApiVersion): an invalid version
// would turn a reported upload success into a guaranteed Test & Save failure (#3037).
const AZURE_API_VERSION_RE = /^\d{4}-\d{2}-\d{2}(?:-preview)?$/u;

function representableVoiceEndpoint(endpoint: VoiceEndpointScalars): boolean {
  if (endpoint.endpointStyle !== undefined && !VOICE_ENDPOINT_STYLES.has(endpoint.endpointStyle)) {
    return false;
  }
  if (
    endpoint.realtimeAuthMode !== undefined &&
    !VOICE_REALTIME_AUTH_MODES.has(endpoint.realtimeAuthMode)
  ) {
    return false;
  }
  if (endpoint.apiVersion !== undefined && !AZURE_API_VERSION_RE.test(endpoint.apiVersion)) {
    return false;
  }
  // The canonical parser binds apiVersion to the Azure deployment shape — in both directions.
  return (
    (endpoint.apiVersion !== undefined) === (endpoint.endpointStyle === "azure-openai-deployment")
  );
}

function uniformVoiceEndpoint(
  providers: readonly ParsedProvider[],
): VoiceEndpointScalars | undefined {
  const style = uniformScalar(providers.map((provider) => provider.endpointStyle));
  const apiVersion = uniformScalar(providers.map((provider) => provider.apiVersion));
  const authMode = uniformScalar(providers.map((provider) => provider.realtimeAuthMode));
  if (!style.ok || !apiVersion.ok || !authMode.ok) return undefined;
  const endpoint: VoiceEndpointScalars = {
    endpointStyle: style.value,
    apiVersion: apiVersion.value,
    realtimeAuthMode: authMode.value,
  };
  return representableVoiceEndpoint(endpoint) ? endpoint : undefined;
}

function uniformConnectionScalars(
  providers: readonly ParsedProvider[],
): ConnectionScalars | undefined {
  const baseUrl = uniformScalar(providers.map((provider) => provider.baseUrl));
  const apiKey = uniformScalar(providers.map((provider) => provider.apiKey));
  const header = uniformScalar(providers.map((provider) => provider.apiKeyHeaderName));
  const timeout = uniformScalar(providers.map((provider) => provider.timeoutMs));
  if (!baseUrl.ok || !apiKey.ok || !header.ok || !timeout.ok) return undefined;
  return {
    baseUrl: baseUrl.value,
    apiKey: apiKey.value,
    apiKeyHeaderName: header.value,
    timeoutMs: timeout.value,
  };
}

function timeoutField(timeoutMs: number | undefined): string | undefined {
  return timeoutMs === undefined ? undefined : String(timeoutMs);
}

function fieldsFrom(
  partition: PartitionedProviders,
  generic: ConnectionScalars,
  voice: VoiceFields,
  figmaAccessToken: string | undefined,
  voiceRetryTuningReset: boolean,
): GatewayConfigUploadFields {
  // Only a CHAT capability can speak about the chat flag lists: an embedding-only declaration
  // must not clear stored chat image/workflow flags the file never mentioned (review finding on
  // #3031). When a chat capability speaks, an empty result still clears the field like manual
  // emptying would.
  const speaksAboutFlags = [...partition.capabilities.values()].some(
    (capability) => capability.kind === "chat",
  );
  return {
    figmaAccessToken,
    baseUrl: generic.baseUrl,
    apiKey: generic.apiKey,
    apiKeyHeaderName: generic.apiKeyHeaderName,
    timeoutMs: timeoutField(generic.timeoutMs),
    deploymentNames: unique(partition.generic.map((provider) => provider.modelId)),
    imageInputModelIds: speaksAboutFlags
      ? chatFlaggedIds(partition.capabilities, "supportsImageInput")
      : undefined,
    embeddingModelIds: genericEmbeddingIds(partition),
    workflowEligibleModelIds: speaksAboutFlags
      ? chatFlaggedIds(partition.capabilities, "workflowEligible")
      : undefined,
    voiceBaseUrl: voice.connection.baseUrl,
    voiceApiKey: voice.connection.apiKey,
    voiceApiKeyHeaderName: voice.connection.apiKeyHeaderName,
    voiceTimeoutMs: timeoutField(voice.connection.timeoutMs),
    voiceEndpointStyle: voice.endpoint.endpointStyle,
    voiceApiVersion: voice.endpoint.apiVersion,
    voiceRealtimeAuthMode: voice.endpoint.realtimeAuthMode,
    voiceModelId: voice.voiceModelId,
    voiceSpeechOutputModelId: voice.voiceSpeechOutputModelId,
    voiceRealtimeModelId: voice.voiceRealtimeModelId,
    voiceRealtimeTranscriptionModelId: voice.voiceRealtimeTranscriptionModelId,
    voiceSemanticTurnDetection: voice.voiceSemanticTurnDetection,
    voiceSupportsSpeechSynthesisInstructions: voice.voiceSupportsSpeechSynthesisInstructions,
    voiceOutputVoiceId: voice.voiceOutputVoiceId,
    voiceProfilesReduced: voice.voiceProfilesReduced,
    voiceProviderLocality: voice.voiceProviderLocality,
    voiceRealtimeSkipped: voice.voiceRealtimeSkipped,
    voiceRetryTuningReset,
  };
}

/**
 * The setup route rebuilds the circuit breaker with fixed values and the form has no field for
 * it: a file that matches them imports losslessly, a file that tunes them differently cannot be
 * represented, and a malformed block is corrupted input (review finding on #3031).
 */
function circuitBreakerOutcome(value: unknown): "representable" | "invalid" | "unsupportedSetting" {
  if (value === undefined) return "representable";
  if (!objectRecord(value)) return "invalid";
  const expectedKeys = Object.keys(
    REBUILT_CIRCUIT_BREAKER,
  ) as readonly (keyof typeof REBUILT_CIRCUIT_BREAKER)[];
  // An omitted key means the rebuilt default — only a PRESENT differing value is unrepresentable
  // (review finding on #3031).
  const matches = expectedKeys.every(
    (key) => value[key] === undefined || value[key] === REBUILT_CIRCUIT_BREAKER[key],
  );
  // Object.hasOwn, not `in`: an inherited name like `toString` must count as an extra key.
  const noExtraKeys = Object.keys(value).every((key) =>
    Object.hasOwn(REBUILT_CIRCUIT_BREAKER, key),
  );
  return matches && noExtraKeys ? "representable" : "unsupportedSetting";
}

function capabilitiesForUpload(
  root: Record<string, unknown>,
  providers: readonly ParsedProvider[],
):
  | { readonly outcome: "capabilities"; readonly partition: PartitionedProviders }
  | { readonly outcome: "invalid" }
  | { readonly outcome: "unsupportedKind" } {
  const topLevel = parsedTopLevelCapabilities(root.capabilities);
  if (topLevel === undefined) return { outcome: "invalid" };
  const capabilities = effectiveCapabilities(providers, topLevel);
  if (capabilities === undefined) return { outcome: "invalid" };
  // `ocr-vision` has no setup field at all — importing it as a generic deployment would persist
  // the wrong capability kind (review finding on #3031).
  const unrepresentable = [...capabilities.values()].some(
    (capability) => !REPRESENTABLE_KINDS.has(capability.kind),
  );
  if (unrepresentable) return { outcome: "unsupportedKind" };
  return { outcome: "capabilities", partition: partitionProviders(providers, capabilities) };
}

function uploadRoot(serialized: string): Record<string, unknown> | undefined {
  let root: unknown;
  try {
    root = JSON.parse(serialized);
  } catch {
    return undefined;
  }
  return objectRecord(root) ? root : undefined;
}

function assembledFields(
  root: Record<string, unknown>,
  partition: PartitionedProviders,
): GatewayConfigUploadResult {
  const generic = uniformConnectionScalars(partition.generic);
  const voice = voiceFields(partition);
  if (generic === undefined || voice === undefined) {
    return { outcome: "invalid" };
  }
  // A PRESENT but non-object figma block is corrupted input, not an absent connector — the
  // production parser rejects the same shape (review finding on #3031).
  if (root.figma !== undefined && !objectRecord(root.figma)) return { outcome: "invalid" };
  const figma = readString(objectRecord(root.figma) ? root.figma.accessToken : undefined);
  if (!figma.ok) return { outcome: "invalid" };
  return {
    outcome: "fields",
    fields: fieldsFrom(
      partition,
      generic,
      voice,
      figma.value,
      importedVoiceRetryTuningReset(root.providers, voice),
    ),
  };
}

/** The voice route persists exactly these retry values on a FRESH import (no stored template). */
const REBUILT_VOICE_RETRY = { maxRetries: 1, retryBaseDelayMs: 500 };

function voiceRetryTuningRepresentable(value: Record<string, unknown>): boolean {
  const keys = Object.keys(REBUILT_VOICE_RETRY) as readonly (keyof typeof REBUILT_VOICE_RETRY)[];
  return keys.every((key) => value[key] === undefined || value[key] === REBUILT_VOICE_RETRY[key]);
}

// A file tuning an imported voice provider's retries differently is applied WITH the reduction
// stated loudly — never silently rewritten and never a refusal that would lose the whole file
// (the persisted product configuration this feature exists for carries per-role voice retry
// tuning the flat form cannot express; same policy as voiceProfilesReduced — review finding on
// #3037). A SKIPPED realtime provider is not imported, so its tuning is not lost and not counted.
function importedVoiceRetryTuningReset(rawProviders: unknown, voice: VoiceFields): boolean {
  if (!Array.isArray(rawProviders)) return false;
  const importedIds = new Set(
    [voice.voiceModelId, voice.voiceSpeechOutputModelId, voice.voiceRealtimeModelId].filter(
      (id): id is string => id !== undefined,
    ),
  );
  return rawProviders.some(
    (entry) =>
      objectRecord(entry) &&
      typeof entry.modelId === "string" &&
      importedIds.has(entry.modelId.trim()) &&
      !voiceRetryTuningRepresentable(entry),
  );
}

/**
 * Defence in depth: the upload control checks file.size before reading, but the parser owns its
 * own ceiling so no future call site can feed an unbounded payload into JSON.parse (review
 * findings on #3031). UTF-16 length under-counts multi-byte UTF-8, so the cheap length check is
 * only the fast reject (bytes >= length always) and the byte-accurate measurement decides.
 */
function exceedsByteCeiling(serialized: string): boolean {
  if (serialized.length > MAX_GATEWAY_CONFIG_BYTES) return true;
  return new TextEncoder().encode(serialized).length > MAX_GATEWAY_CONFIG_BYTES;
}

export function parseGatewayConfigUpload(serialized: string): GatewayConfigUploadResult {
  if (exceedsByteCeiling(serialized)) return { outcome: "invalid" };
  const root = uploadRoot(serialized);
  if (root === undefined) return { outcome: "invalid" };
  if (!Object.keys(root).every((key) => REPRESENTABLE_ROOT_KEYS.has(key))) {
    return { outcome: "unsupportedSetting" };
  }
  const providers = parsedProviders(root.providers);
  if (providers === undefined || providers.length > MAX_IMPORT_PROVIDERS) {
    return { outcome: "invalid" };
  }
  const resolved = capabilitiesForUpload(root, providers);
  if (resolved.outcome !== "capabilities") return resolved;
  // A voice-only file cannot be saved: Test & Save requires the main gateway connection, so a
  // "successful" load would leave the form permanently unsubmittable (review finding on #3031).
  if (resolved.partition.generic.length === 0) return { outcome: "invalid" };
  const unrepresentable = unrepresentableSettingOutcome(root, resolved.partition);
  if (unrepresentable !== undefined) return unrepresentable;
  return assembledFields(root, resolved.partition);
}

function unrepresentableSettingOutcome(
  root: Record<string, unknown>,
  partition: PartitionedProviders,
): GatewayConfigUploadResult | undefined {
  const genericIds = new Set(partition.generic.map((provider) => provider.modelId));
  if (carriesUnsupportedGenericSetting(root.providers, genericIds)) {
    return { outcome: "unsupportedSetting" };
  }
  if (carriesUnrepresentableRetryTuning(root.providers, genericIds)) {
    return { outcome: "unsupportedSetting" };
  }
  const circuitBreaker = circuitBreakerOutcome(root.circuitBreaker);
  if (circuitBreaker !== "representable") return { outcome: circuitBreaker };
  return undefined;
}

/** How many form fields an upload fills — the number the status line reports. */
export function appliedGatewayConfigFieldCount(fields: GatewayConfigUploadFields): number {
  const scalars = [
    fields.baseUrl,
    fields.apiKey,
    fields.apiKeyHeaderName,
    fields.timeoutMs,
    fields.figmaAccessToken,
    fields.voiceBaseUrl,
    fields.voiceApiKey,
    fields.voiceApiKeyHeaderName,
    fields.voiceTimeoutMs,
    fields.voiceModelId,
    fields.voiceSpeechOutputModelId,
    fields.voiceRealtimeModelId,
    fields.voiceRealtimeTranscriptionModelId,
    fields.voiceOutputVoiceId,
    fields.voiceProviderLocality,
  ];
  // A defined-but-empty flag list clears its field, which is an applied change too.
  const flagLists = [fields.imageInputModelIds, fields.workflowEligibleModelIds];
  return (
    scalars.filter((value) => value !== undefined).length +
    (fields.deploymentNames.length > 0 ? 1 : 0) +
    flagLists.filter((list) => list !== undefined).length
  );
}
