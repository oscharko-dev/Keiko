// First-run gateway setup for non-technical UI users. The browser provides a base URL, API token,
// and optionally a Figma PAT; the loopback BFF builds the local provider config, performs a real
// chat-completions smoke call, stores the resulting config on disk with private permissions, and
// updates the in-memory runtime config without exposing credentials back to the browser.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolveEvidenceDir } from "@oscharko-dev/keiko-evidence";
import {
  apiKeyHeaderValue,
  ConfigInvalidError,
  DEFAULT_API_KEY_HEADER_NAME,
  ERROR_CODES,
  Gateway,
  GATEWAY_CONFIG_SCHEMA_VERSION,
  createDefaultChatCapability,
  createDefaultEmbeddingCapability,
  findConfiguredCapability,
  GatewayError,
  MODEL_REASONING_EFFORTS,
  isLikelyEmbeddingModelId,
  isVoiceCapability,
  listConfiguredCapabilities,
  loadConfigFromFile,
  modelSupportsRealtimeVoice,
  modelSupportsSpeechInput,
  modelSupportsSpeechOutput,
  normalizeApiKeyHeaderName,
  parseGatewayConfig,
  requestOpenAIEmbedding,
  selectRealtimeVoiceModel,
  selectSpeechOutputModel,
  selectSpeechToTextModel,
  toSafeObject,
  validateBaseUrl,
  PROVIDER_ENDPOINT_STYLES,
  REALTIME_AUTH_MODES,
  toolCallingConfigurationFingerprint,
  VOICE_PROVIDER_LOCALITIES,
  // KEIKO-0572: shared circuitBreaker defaults; hoisted into this import block instead of the
  // separate `import { DEFAULT_CIRCUIT_BREAKER_CONFIG } from ...` line Sonar S3863 flagged.
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
} from "@oscharko-dev/keiko-model-gateway";
import {
  boundedUnsupportedReason,
  isChatCompatibleDeclaredMode,
  modelKindForDeclaredMode,
} from "@oscharko-dev/keiko-contracts/runtime/gateway";
import {
  GATEWAY_SETUP_AUDIT_SCHEMA_VERSION,
  validateGatewaySetupAuditRecord,
} from "@oscharko-dev/keiko-contracts/runtime/gateway-setup-audit";
import type {
  GatewayModelUnsupportedReason,
  GatewaySetupAuditRecord,
  GatewaySetupOutcomeKind,
  GatewaySetupTargetClass,
  GatewayUnsupportedDiscoveredModel,
  ToolCallingVerification,
} from "@oscharko-dev/keiko-contracts";
import type { GatewayReadinessReport } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  classifyOutboundHost,
  gatewayFetch,
  readJsonCapped,
} from "@oscharko-dev/keiko-model-gateway/internal/http";
import type {
  EnvSource,
  GatewayConfig,
  ModelCapability,
  ModelReasoningEffort,
  ModelProviderConfig,
  OpenAIEmbeddingOutcome,
  ParseGatewayConfigOptions,
  VoicePersonaVoice,
  VoiceProviderLocality,
} from "@oscharko-dev/keiko-model-gateway";
import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import type {
  GatewayDiscoveredModelMetadata,
  GatewayDiscoveredModels,
  GatewayModelDiscoveryOutput,
  GatewaySetupTestResult,
  GatewaySetupToolCallingObservation,
  RuntimeGatewayConfig,
  UiHandlerDeps,
  VerifiedModelCapabilityFields,
} from "./deps.js";
import { currentGatewayConfig, currentGatewayEgressConfig } from "./deps.js";
import { UNKNOWN_CORRELATION_ID } from "./correlation.js";
import {
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticSink,
} from "./diagnostics-log.js";
import { CONVERSATION_SYSTEM_PROMPT } from "./conversation-prompt.js";
import { processServerLogSink } from "./process-log-sink.js";
import {
  classifyFigmaTransportError,
  FigmaConnectorError,
  type FigmaConnectorErrorCode,
} from "./qualityIntelligence/figma/figmaConnectorErrors.js";
import { classifyTokenFailure } from "./qualityIntelligence/figma/figmaTokenSource.js";
import {
  buildQiJudgePreflightRequest,
  tryParseJudgeVerdict,
} from "./qualityIntelligence/judgePort.js";
import { persistSealedGatewayConfig } from "./credentialPersistence.js";
import { probeGatewayToolCalling } from "./gateway-tool-calling-probe.js";

const MODEL_REASONING_EFFORT_SET: ReadonlySet<string> = new Set(MODEL_REASONING_EFFORTS);

function isModelReasoningEffort(value: string): value is ModelReasoningEffort {
  return MODEL_REASONING_EFFORT_SET.has(value);
}
import { createProviderSecretResolver } from "./credentialVault.js";

const MAX_BODY_BYTES = 64_000;
// Issue #144: exported so discovery-normalization tests can pin the slice cap
// without hardcoding the number. The discovery surface is a public seam.
export const MAX_DISCOVERED_MODELS = 100;
const MAX_DEPLOYMENT_NAMES = 100;
const MAX_MODEL_ID_LENGTH = 160;
const MISTRAL_TOOL_CALLING_LIMITATION =
  "Tool calling is disabled by default for Mistral deployments until endpoint readiness verifies it";
const DISCOVERED_MODEL_SMOKE_TIMEOUT_MS = 15_000;
const DEPLOYMENT_SMOKE_TIMEOUT_MS = 30_000;
const FIGMA_CREDENTIAL_SMOKE_TIMEOUT_MS = 15_000;
const FIGMA_CREDENTIAL_SMOKE_RESPONSE_BYTES = 64_000;
const SETUP_SMOKE_CONCURRENCY = 4;
// The chat vocabulary lives in the contract table (modelKindForDeclaredMode); this predicate
// only adapts it to the local "no declaration" case.
function declaresChatCompatibleMode(mode: string | undefined): boolean {
  return mode !== undefined && isChatCompatibleDeclaredMode(mode);
}
const IMAGE_INPUT_ID_PATTERNS: readonly RegExp[] = [
  /(?:^|[-_/. ])(?:vision|multimodal|multi-modal|llava|pixtral|omni|gpt-4o)(?:$|[-_/. ])/i,
  /(?:^|[-_/. ])vl(?:$|[-_/. ])/i,
  /qwen(?:2(?:\.5)?|3)?[-_/. ]?vl(?:$|[-_/. ])/i,
];
const ALLOW_LINK_LOCAL_GATEWAY_ENV = "KEIKO_ALLOW_LINK_LOCAL_GATEWAY";

type GatewaySetupTester = NonNullable<UiHandlerDeps["gatewaySetupTester"]>;
type GatewayEmbeddingProbe = NonNullable<UiHandlerDeps["gatewayEmbeddingProbe"]>;
type GatewayModelDiscovery = NonNullable<UiHandlerDeps["gatewayModelDiscovery"]>;
type FigmaCredentialTester = NonNullable<UiHandlerDeps["figmaCredentialTester"]>;
type GatewayEgressConfig = NonNullable<GatewayConfig["egress"]>;
type SetupParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly routeError: RouteResult };

function acceptedSetupValue<T>(value: T): SetupParseResult<T> {
  return { ok: true, value };
}

function rejectedSetupValue<T>(routeError: RouteResult): SetupParseResult<T> {
  return { ok: false, routeError };
}

class BodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "BodyTooLargeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRouteResult(value: unknown): value is RouteResult {
  return isRecord(value) && typeof value.status === "number";
}

function readBody(req: RouteContext["req"]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        if (!capped) {
          capped = true;
          chunks.length = 0;
          reject(new BodyTooLargeError());
          req.resume();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!capped) {
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    req.on("error", reject);
  });
}

// Exported so a co-located test can pin the ReDoS-safe behavior directly without hardcoding the
// module's other exports (mirrors the MAX_DISCOVERED_MODELS precedent below).
// `/\/+$/u` looks like a harmless anchored trim, but it is unanchored at the *start*: engines try
// every start position looking for a run of "/" that reaches the true end of the string, which is
// quadratic whenever that never happens (e.g. a long string that ends in a non-"/" character). A
// single backward scan for the trim point is linear and cannot backtrack.
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") {
    end -= 1;
  }
  return value.slice(0, end);
}

function normalizeBaseUrl(raw: string): string {
  let value = stripTrailingSlashes(raw.trim());
  if (value.endsWith("/chat/completions")) {
    value = stripTrailingSlashes(value.slice(0, -"/chat/completions".length));
  }
  return value;
}

function canonicalBaseUrlIdentity(raw: string): string {
  const normalized = normalizeBaseUrl(raw);
  try {
    return stripTrailingSlashes(new URL(normalized).href);
  } catch {
    return normalized;
  }
}

function sameBaseUrlIdentity(left: string, right: string): boolean {
  return canonicalBaseUrlIdentity(left) === canonicalBaseUrlIdentity(right);
}

function envFlagEnabled(env: EnvSource, key: string): boolean {
  const value = env[key];
  return typeof value === "string" && /^(?:1|true|yes)$/iu.test(value.trim());
}

function unbracketHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isIpv4LinkLocal(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map(Number);
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  return octets[0] === 169 && octets[1] === 254;
}

function parseIpv4MappedHextet(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? "", 16);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 0xffff ? parsed : undefined;
}

function ipv4MappedBytes(hostname: string): readonly number[] | undefined {
  const lower = hostname.toLowerCase();
  if (!lower.startsWith("::ffff:")) return undefined;
  const hextets = lower.slice("::ffff:".length).split(":");
  if (hextets.length !== 2) return undefined;
  const high = parseIpv4MappedHextet(hextets[0]);
  const low = parseIpv4MappedHextet(hextets[1]);
  if (high === undefined || low === undefined) return undefined;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function isIpv6LinkLocal(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  const mapped = ipv4MappedBytes(lower);
  if (mapped !== undefined) return mapped[0] === 169 && mapped[1] === 254;
  const first = Number.parseInt(lower.split(":", 1)[0] ?? "", 16);
  return Number.isInteger(first) && first >= 0xfe80 && first <= 0xfebf;
}

function isLinkLocalGatewayBaseUrl(baseUrl: string): boolean {
  try {
    const hostname = unbracketHostname(new URL(baseUrl).hostname);
    return isIpv4LinkLocal(hostname) || isIpv6LinkLocal(hostname);
  } catch {
    return false;
  }
}

function validateLinkLocalGatewayBaseUrl(baseUrl: string, env: EnvSource): RouteResult | undefined {
  if (!isLinkLocalGatewayBaseUrl(baseUrl)) return undefined;
  if (envFlagEnabled(env, ALLOW_LINK_LOCAL_GATEWAY_ENV)) return undefined;
  return {
    status: 400,
    body: errorBody(
      "BAD_REQUEST",
      `Gateway baseUrl may not target link-local metadata addresses unless ${ALLOW_LINK_LOCAL_GATEWAY_ENV}=1 is set.`,
    ),
  };
}

// The candidate baseUrl has already passed `validateLinkLocalGatewayBaseUrl`'s dedicated,
// env-flag-gated check by the time any egress-level validation runs (both the initial
// `validateSetupConnection` guard and `verifySetupCandidate`'s defence-in-depth re-check are
// reached only after that gate). Thread the same narrow, non-config-file opt-in into the egress
// used for THIS candidate's validation only, so the downstream shared SSRF classifier (hardened
// to unconditionally block metadata/link-local for the generic `allowPrivateNetwork` opt-in,
// AUDIT-SEC-002) does not re-reject a URL this route has already deliberately approved. This
// must never be derived from a generic env-to-egress mapping -- only from this one call site --
// or every other `currentGatewayEgressConfig` consumer (reranker, voice, update-preflight,
// local-knowledge connectors) would silently inherit the override too.
function egressForCandidateValidation(
  deps: Pick<UiHandlerDeps, "config" | "gatewayConfig" | "env" | "egress">,
): GatewayEgressConfig | undefined {
  const base = currentGatewayEgressConfig(deps);
  if (!envFlagEnabled(deps.env, ALLOW_LINK_LOCAL_GATEWAY_ENV)) return base;
  return { ...base, allowLinkLocalAndMetadata: true };
}

function candidateBaseUrls(baseUrl: string): readonly string[] {
  const primary = normalizeBaseUrl(baseUrl);
  const candidates = [primary];
  try {
    const url = new URL(primary);
    if (url.hostname.endsWith(".services.ai.azure.com")) {
      const openAiV1 = `${url.origin}/openai/v1`;
      if (url.pathname === "" || url.pathname === "/") {
        candidates.push(`${url.origin}/openai/v1`);
      } else if (primary.endsWith("/openai")) {
        candidates.push(`${primary}/v1`);
      } else if (primary !== openAiV1 && !primary.endsWith("/openai/v1")) {
        candidates.push(openAiV1);
      }
    } else if (!primary.endsWith("/v1")) {
      candidates.push(`${primary}/v1`);
    }
  } catch {
    if (!primary.endsWith("/v1")) {
      candidates.push(`${primary}/v1`);
    }
  }
  return Array.from(new Set(candidates));
}

function isAzureFoundryBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.hostname.endsWith(".services.ai.azure.com");
  } catch {
    return false;
  }
}

interface ProviderRawOptions {
  /** True on preserve-mode rebuilds — stored-capability carry-overs are preserve semantics. */
  readonly preserveExisting?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxRetries?: number | undefined;
  readonly retryBaseDelayMs?: number | undefined;
  readonly apiKeyHeaderName?: string | undefined;
  /** Generic endpoint protocol, persisted VERBATIM — see setupEndpointProtocol (#3042). */
  readonly endpointStyle?: string | undefined;
  readonly apiVersion?: string | undefined;
  readonly imageInputModelIds?: readonly string[] | undefined;
  readonly responseFormatModelIds?: readonly string[] | undefined;
  readonly toolCallingObservations?: readonly GatewaySetupToolCallingObservation[] | undefined;
  readonly embeddingModelIds?: readonly string[] | undefined;
  readonly modelMetadata?: Readonly<Record<string, GatewayDiscoveredModelMetadata>> | undefined;
  readonly current?: GatewayConfig | undefined;
  /** The durable stored view — the protocol of record for capability identity (see #3046). */
  readonly stored?: GatewayConfig | undefined;
  readonly workflowEligibleModelIds?: readonly string[] | undefined;
}

// Capability reuse at the SAME endpoint is deliberate and pinned: it is how a readiness-verified
// observation (recordVerifiedCapability → replaceModelCapability) survives a routine re-save,
// which submits no preserveExisting flag. The mode gate belongs on the ENDPOINT-MOVE carry-over
// below, where this URL match misses and nothing verified the stored value at the new endpoint.
// The protocol the adapter actually speaks: an absent endpoint style IS the OpenAI-compatible
// shape, so the two spellings must compare equal wherever a protocol CHANGE is the question.
function effectiveEndpointStyle(style: string | undefined): string {
  return style ?? "openai-compatible";
}

function storedProviderForModel(
  stored: GatewayConfig | undefined,
  modelId: string,
): ModelProviderConfig | undefined {
  return stored?.providers.find((candidate) => candidate.modelId === modelId);
}

// What the adapter will send AFTER the save: the statement if there is one, else what the file
// declares, else what the environment already resolves the provider to. Falling through to the
// resolved provider is what keeps a plain rotation — which states nothing — comparing equal.
function effectiveSubmittedProtocol(
  protocol: {
    readonly submitted: {
      readonly endpointStyle?: string | undefined;
      readonly apiVersion?: string | undefined;
    };
    readonly durable: ModelProviderConfig | undefined;
  },
  provider: ModelProviderConfig,
): { readonly endpointStyle: string | undefined; readonly apiVersion: string | undefined } {
  return {
    endpointStyle:
      protocol.submitted.endpointStyle ?? protocol.durable?.endpointStyle ?? provider.endpointStyle,
    apiVersion:
      protocol.submitted.apiVersion ?? protocol.durable?.apiVersion ?? provider.apiVersion,
  };
}

function existingCapabilityForSetup(
  current: GatewayConfig | undefined,
  modelId: string,
  baseUrl: string,
  protocol: {
    readonly submitted: {
      readonly endpointStyle?: string | undefined;
      readonly apiVersion?: string | undefined;
    };
    readonly durable: ModelProviderConfig | undefined;
  },
): ModelCapability | undefined {
  const provider = current?.providers.find((candidate) => candidate.modelId === modelId);
  if (provider === undefined || !sameBaseUrlIdentity(provider.baseUrl, baseUrl)) return undefined;
  // Both sides are the EFFECTIVE protocol — what the adapter will actually send. The durable
  // view alone was not enough: with the file silent and KEIKO_DEFAULT_* resolving `current` to
  // Azure, an explicit switch to openai-compatible compared undefined against openai-compatible
  // and read as unchanged, keeping observations made over the deployment path (review finding on
  // #3046). Completing the submitted side with the same defaults keeps a plain rotation — which
  // states nothing — comparing equal.
  const submitted = effectiveSubmittedProtocol(protocol, provider);
  // The protocol is part of the endpoint's identity: the deployment path and the api version
  // change the request route, so streaming, tool calling and image observations made over the
  // old one prove nothing about the new one. The setup probe performs buffered chat only and
  // reverifies none of them, so a reused capability would advertise unverified behavior (review
  // finding on #3046). Unchanged protocol, unchanged identity — a rotation still keeps them.
  // An absent style and an explicit "openai-compatible" are the SAME protocol — the adapter sends
  // the identical request shape — so a same-URL import that merely spells the default out must
  // not discard verified observations (review finding on #3046).
  if (
    effectiveEndpointStyle(provider.endpointStyle) !==
      effectiveEndpointStyle(submitted.endpointStyle) ||
    provider.apiVersion !== submitted.apiVersion
  ) {
    return undefined;
  }
  return current?.capabilities?.find((candidate) => candidate.id === modelId);
}

function codingUseCases(capability: ModelCapability): readonly string[] {
  return capability.preferredUseCases.some((useCase) => useCase.toLowerCase().includes("coding"))
    ? capability.preferredUseCases
    : [...capability.preferredUseCases, "Coding"];
}

function storedStreamingRestriction(
  current: GatewayConfig | undefined,
  modelId: string,
): Partial<ModelCapability> {
  const stored = current?.capabilities?.find((candidate) => candidate.id === modelId);
  return stored?.kind === "chat" && !stored.streaming ? { streaming: false } : {};
}

function discoveredReasoningFields(
  discovered: GatewayDiscoveredModelMetadata | undefined,
): Partial<Pick<ModelCapability, "reasoningEfforts">> {
  return discovered?.reasoningEfforts === undefined
    ? {}
    : { reasoningEfforts: discovered.reasoningEfforts };
}

function discoveredCapabilityFields(
  discovered: GatewayDiscoveredModelMetadata | undefined,
): Partial<ModelCapability> {
  // Discovery metadata is a provider declaration, not evidence that this deployment accepted
  // Keiko's forced tool call. Keep it out of toolCalling: only the live probe can enable tools.
  return {
    ...(discovered?.contextWindow === undefined ? {} : { contextWindow: discovered.contextWindow }),
    ...(discovered?.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: discovered.maxOutputTokens }),
    ...discoveredReasoningFields(discovered),
    ...(discovered?.chatModeDeclared === undefined
      ? {}
      : { chatModeDeclared: discovered.chatModeDeclared }),
  };
}

function workflowCapabilityFields(
  modelId: string,
  baseCapability: ModelCapability,
  existing: ModelCapability | undefined,
  workflowEligibleModelIds: readonly string[] | undefined,
): Partial<ModelCapability> {
  if (baseCapability.kind !== "chat" || workflowEligibleModelIds === undefined) {
    return {};
  }
  if (!workflowEligibleModelIds.includes(modelId)) {
    return {
      workflowEligible: false,
      preferredUseCases: (existing ?? baseCapability).preferredUseCases,
    };
  }
  return {
    workflowEligible: true,
    preferredUseCases: codingUseCases(existing ?? baseCapability),
  };
}

function createDefaultSetupCapability(
  modelId: string,
  baseUrl: string,
  embeddingModelIds: readonly string[] | undefined,
  options: ProviderRawOptions,
): ModelCapability {
  const baseCapability =
    embeddingModelIds?.includes(modelId) === true
      ? createDefaultEmbeddingCapability(modelId)
      : createDefaultChatCapability(modelId);
  const rawExisting = existingCapabilityForSetup(options.current, modelId, baseUrl, {
    submitted: options,
    // The protocol of record is the DURABLE one, which is what the rebuild persists. Comparing
    // against the env-RESOLVED view made a plain rotation look like a protocol change whenever
    // KEIKO_DEFAULT_* supplied a tuple the file never declared, discarding verified observations
    // for nothing (review finding on #3046).
    durable: storedProviderForModel(options.stored, modelId),
  });
  // When the resolved kind CHANGES (e.g. a stored embedding is being switched back to chat by an
  // explicit deployment list — review finding on #3037), observations made under the old kind are
  // stale by construction and carrying them over would produce a hybrid capability whose numeric
  // fields (contextWindow, maxOutputTokens) belong to the wrong kind — a chat capability with an
  // embedding's contextWindow: 0 fails config-parse under KEIKO-0520. Treat existing as absent
  // when its kind no longer matches so the flow restarts from baseCapability's defaults.
  const existing = rawExisting?.kind === baseCapability.kind ? rawExisting : undefined;
  const discovered = options.modelMetadata?.[modelId];
  const capability: ModelCapability = {
    ...baseCapability,
    // The endpoint-move restriction is PRESERVE semantics: a fresh replacement deliberately
    // treats stored capabilities as absent, like every stored list on this route (review
    // finding on #3042).
    ...(existing ??
      (options.preserveExisting === true
        ? storedStreamingRestriction(options.current, modelId)
        : {})),
    ...discoveredCapabilityFields(discovered),
    id: modelId,
    kind: baseCapability.kind,
    ...workflowCapabilityFields(
      modelId,
      baseCapability,
      existing,
      options.workflowEligibleModelIds,
    ),
  };
  return capability;
}

// The generic endpoint protocol persists VERBATIM — absent fields stay absent so the runtime
// default layering is unchanged (#3042).
function genericEndpointProtocolRaw(
  options: ProviderRawOptions,
): Pick<Record<string, unknown>, string> {
  return {
    ...(options.endpointStyle === undefined ? {} : { endpointStyle: options.endpointStyle }),
    ...(options.apiVersion === undefined ? {} : { apiVersion: options.apiVersion }),
  };
}

function providerRaw(
  modelId: string,
  baseUrl: string,
  apiKey: string,
  options: ProviderRawOptions = {},
): Record<string, unknown> {
  const defaultCapability = createDefaultSetupCapability(
    modelId,
    baseUrl,
    options.embeddingModelIds,
    options,
  );
  const supportsResponseFormat = options.responseFormatModelIds?.includes(modelId) === true;
  return {
    modelId,
    baseUrl,
    apiKey,
    apiKeyHeaderName: options.apiKeyHeaderName ?? DEFAULT_API_KEY_HEADER_NAME,
    ...genericEndpointProtocolRaw(options),
    capability: {
      ...defaultCapability,
      // The provided list is authoritative, not additive: a model absent from it loses a stored
      // supportsImageInput flag, which is what lets an update ever REMOVE image capability
      // (review finding on #3031 — previously true could never be cleared).
      ...(options.imageInputModelIds === undefined
        ? {}
        : { supportsImageInput: options.imageInputModelIds.includes(modelId) }),
      ...(supportsResponseFormat ? { structuredOutput: true, supportsResponseFormat: true } : {}),
    },
    timeoutMs: options.timeoutMs ?? 30_000,
    maxRetries: options.maxRetries ?? 2,
    retryBaseDelayMs: options.retryBaseDelayMs ?? 500,
  };
}

interface SetupVoiceCapabilities {
  readonly speechInput: boolean;
  readonly speechOutput: boolean;
  readonly realtime: boolean;
  readonly supportsSemanticTurnDetection?: boolean | undefined;
  /** Submitted tri-state: true sets, false clears, undefined follows the stored template. */
  readonly supportsSpeechSynthesisInstructions?: boolean | undefined;
  readonly realtimeTranscriptionModel?: string | undefined;
}

function semanticTurnDetectionCapability(
  capabilities: SetupVoiceCapabilities,
): Pick<ModelCapability, "supportsSemanticTurnDetection"> {
  return capabilities.realtime && capabilities.supportsSemanticTurnDetection === true
    ? { supportsSemanticTurnDetection: true }
    : {};
}

// Speech-synthesis instruction support is a behavior-bearing canonical flag bound to speech
// output (the config parser requires supportsSpeechOutput) — it travels through the setup
// contract exactly like semantic turn detection, or an uploaded declaration would be silently
// lost on the rebuild (review finding on #3037).
function speechSynthesisInstructionsCapability(
  capabilities: SetupVoiceCapabilities,
): Pick<ModelCapability, "supportsSpeechSynthesisInstructions"> {
  return capabilities.speechOutput && capabilities.supportsSpeechSynthesisInstructions === true
    ? { supportsSpeechSynthesisInstructions: true }
    : {};
}

function createDefaultVoiceCapabilityForSetup(
  modelId: string,
  providerLocality: VoiceProviderLocality,
  capabilities: SetupVoiceCapabilities,
): ModelCapability {
  const preferredUseCases = [
    ...(capabilities.speechInput ? ["Dictation"] : []),
    ...(capabilities.speechOutput ? ["Speech output"] : []),
    ...(capabilities.realtime ? ["Digital Voice"] : []),
  ];
  return {
    id: modelId,
    kind: "voice",
    contextWindow: 0,
    maxOutputTokens: 0,
    toolCalling: false,
    structuredOutput: false,
    streaming: capabilities.realtime,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: false,
    ...(capabilities.speechInput ? { supportsSpeechInput: true } : {}),
    ...(capabilities.speechOutput ? { supportsSpeechOutput: true } : {}),
    ...(capabilities.realtime ? { supportsRealtimeVoice: true } : {}),
    ...semanticTurnDetectionCapability(capabilities),
    ...speechSynthesisInstructionsCapability(capabilities),
    ...(capabilities.realtime && capabilities.realtimeTranscriptionModel !== undefined
      ? { realtimeTranscriptionModel: capabilities.realtimeTranscriptionModel }
      : {}),
    voiceProviderLocality: providerLocality,
    costClass: "low",
    latencyClass: "fast",
    throughputHint: "runtime-configured audio endpoint",
    preferredUseCases,
    knownLimitations: ["Audio availability is verified on first use"],
  };
}

interface VoiceProviderRawOptions {
  readonly apiKeyHeaderName?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxRetries?: number | undefined;
  readonly retryBaseDelayMs?: number | undefined;
  readonly endpointStyle?: ModelProviderConfig["endpointStyle"];
  readonly apiVersion?: string | undefined;
  readonly realtimeAuthMode?: ModelProviderConfig["realtimeAuthMode"];
  readonly providerLocality?: VoiceProviderLocality | undefined;
  readonly capabilities: SetupVoiceCapabilities;
  readonly rawCapability?: ModelCapability | undefined;
  readonly voiceProfiles?: readonly VoicePersonaVoice[] | undefined;
  // KEIKO-0167 (PR-review follow-up, Codex thread 3769711637): pass a per-provider
  // circuitBreaker override through voice reserialization so applyVoiceProviders /
  // validateVoiceProviderConnection can round-trip it without dropping.
  readonly circuitBreaker?: ModelProviderConfig["circuitBreaker"];
}

function voiceProviderEndpointRaw(options: VoiceProviderRawOptions): Record<string, unknown> {
  const endpoint: Record<string, unknown> = {};
  if (options.endpointStyle !== undefined) endpoint.endpointStyle = options.endpointStyle;
  if (options.apiVersion !== undefined) endpoint.apiVersion = options.apiVersion;
  if (options.realtimeAuthMode !== undefined) endpoint.realtimeAuthMode = options.realtimeAuthMode;
  return endpoint;
}

function configuredOrDefaultVoiceCapability(
  modelId: string,
  options: VoiceProviderRawOptions,
): ModelCapability {
  return options.rawCapability === undefined
    ? createDefaultVoiceCapabilityForSetup(
        modelId,
        options.providerLocality ?? "azure-foundry",
        options.capabilities,
      )
    : stripDerivedVoicePersonas(options.rawCapability);
}

function voiceProviderRaw(
  modelId: string,
  baseUrl: string,
  apiKey: string,
  options: VoiceProviderRawOptions,
): Record<string, unknown> {
  return {
    modelId,
    baseUrl,
    apiKey,
    apiKeyHeaderName: options.apiKeyHeaderName ?? DEFAULT_API_KEY_HEADER_NAME,
    ...voiceProviderEndpointRaw(options),
    capability: configuredOrDefaultVoiceCapability(modelId, options),
    ...(options.voiceProfiles === undefined ? {} : { voiceProfiles: options.voiceProfiles }),
    // KEIKO-0167 (PR-review follow-up, Codex thread 3769711637): re-serialize the
    // per-provider circuit-breaker override so a voice/setup save preserves it.
    ...(options.circuitBreaker === undefined ? {} : { circuitBreaker: options.circuitBreaker }),
    timeoutMs: options.timeoutMs ?? 30_000,
    maxRetries: options.maxRetries ?? 1,
    retryBaseDelayMs: options.retryBaseDelayMs ?? 500,
  };
}

function isLikelyImageInputModelId(modelId: string): boolean {
  return IMAGE_INPUT_ID_PATTERNS.some((pattern) => pattern.test(modelId));
}

function discoveryRecords(item: Record<string, unknown>): readonly Record<string, unknown>[] {
  return [
    item,
    nestedRecord(item, "model_info"),
    nestedRecord(item, "litellm_params"),
    nestedRecord(item, "capabilities"),
  ].filter((record): record is Record<string, unknown> => record !== undefined);
}

function booleanFieldFromRecords(
  records: readonly Record<string, unknown>[],
  fields: readonly string[],
): boolean {
  return records.some((record) => fields.some((field) => record[field] === true));
}

function optionalBooleanFieldFromRecords(
  records: readonly Record<string, unknown>[],
  fields: readonly string[],
): boolean | undefined {
  for (const record of records) {
    for (const field of fields) {
      const value = record[field];
      if (typeof value === "boolean") return value;
    }
  }
  return undefined;
}

function numberFieldFromRecords(
  records: readonly Record<string, unknown>[],
  fields: readonly string[],
): number | undefined {
  for (const record of records) {
    for (const field of fields) {
      const value = record[field];
      if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
    }
  }
  return undefined;
}

function metadataFromDiscoveryItem(item: Record<string, unknown>): GatewayDiscoveredModelMetadata {
  const records = discoveryRecords(item);
  const contextWindow = numberFieldFromRecords(records, ["max_input_tokens"]);
  const maxOutputTokens = numberFieldFromRecords(records, ["max_output_tokens", "max_tokens"]);
  const toolCalling = optionalBooleanFieldFromRecords(records, [
    "supports_function_calling",
    "supportsFunctionCalling",
  ]);
  const reasoningEfforts = [
    ...new Set(
      stringListFieldFromRecords(records, [
        "supported_reasoning_efforts",
        "reasoning_efforts",
      ]).filter(isModelReasoningEffort),
    ),
  ];
  // An affirmative chat-compatible `mode` declaration ranks the model ahead of mode-less
  // entries as the conversation default (keiko-contracts conversationDefaultRank). Only ever
  // true — declared NON-chat modes never reach the chat list, and "no mode" is no signal.
  const mode = modelModeFromDiscoveryItem(item);
  const chatModeDeclared = declaresChatCompatibleMode(mode);
  return {
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(toolCalling === undefined ? {} : { toolCalling }),
    ...(reasoningEfforts.length === 0 ? {} : { reasoningEfforts }),
    ...(chatModeDeclared ? { chatModeDeclared } : {}),
  };
}

function stringsFromValue(value: unknown): readonly string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

function stringListFieldFromRecords(
  records: readonly Record<string, unknown>[],
  fields: readonly string[],
): readonly string[] {
  return records.flatMap((record) =>
    fields.flatMap((field) => stringsFromValue(record[field]).map((value) => value.toLowerCase())),
  );
}

function supportsImageInputFromDiscoveryItem(
  item: Record<string, unknown>,
  modelId: string,
): boolean {
  const records = discoveryRecords(item);
  if (
    booleanFieldFromRecords(records, [
      "supports_vision",
      "supportsVision",
      "vision",
      "image_input",
      "imageInput",
      "supports_image_input",
      "supportsImageInput",
    ])
  ) {
    return true;
  }
  const modalities = stringListFieldFromRecords(records, [
    "input_modalities",
    "inputModalities",
    "modalities",
  ]);
  if (modalities.some((entry) => entry === "image" || entry === "vision")) {
    return true;
  }
  return isLikelyImageInputModelId(modelId);
}

function mergeChatAndEmbeddingModelIds(
  chatModelIds: readonly string[],
  embeddingModelIds: readonly string[],
): readonly string[] {
  const merged = [...chatModelIds];
  const seen = new Set(merged);
  for (const modelId of embeddingModelIds) {
    if (seen.has(modelId)) {
      continue;
    }
    seen.add(modelId);
    merged.push(modelId);
  }
  return merged;
}

function embeddingModelIdsFromDeployments(deploymentNames: readonly string[]): readonly string[] {
  return deploymentNames.filter(isLikelyEmbeddingModelId);
}

function buildRawConfig(
  baseUrl: string,
  apiKey: string,
  modelIds: readonly string[],
  options: ProviderRawOptions = {},
): Record<string, unknown> {
  return {
    providers: modelIds.map((modelId) => providerRaw(modelId, baseUrl, apiKey, options)),
    circuitBreaker: DEFAULT_CIRCUIT_BREAKER_CONFIG,
  };
}

function currentImageInputModelIds(config: GatewayConfig | undefined): readonly string[] {
  return (
    config?.capabilities
      ?.filter((capability) => capability.kind === "chat" && capability.supportsImageInput)
      .map((capability) => capability.id) ?? []
  );
}

function currentEmbeddingModelIds(config: GatewayConfig | undefined): readonly string[] {
  return (
    config?.capabilities
      ?.filter((capability) => capability.kind === "embedding")
      .map((capability) => capability.id) ?? []
  );
}

function currentOcrModelIds(config: GatewayConfig | undefined): readonly string[] {
  return (
    config?.capabilities
      ?.filter((capability) => capability.kind === "ocr-vision")
      .map((capability) => capability.id) ?? []
  );
}

/**
 * Stored embedding providers with their OWN connection: the rebuild writes every derived
 * embedding onto the setup-wide connection, which would silently migrate a different endpoint
 * OR overwrite a distinct same-endpoint credential with the gateway token (review findings on
 * #3031). Dedicated means the FULL stored connection identity differs from the stored primary
 * provider's — embeddings sharing the gateway connection keep following rotations and endpoint
 * moves through the normal rebuild.
 */
// The stored MAIN gateway provider: the first provider that is not a voice deployment. Array
// order is not a contract — a valid stored file may list a dedicated voice provider first, and
// treating position zero as the primary would break the connection-identity comparison: an
// embedding that shared the CHAT gateway would classify as dedicated and be restored with its
// obsolete credential after a rotation (review finding on #3037).
function storedPrimaryGatewayProvider(
  config: GatewayConfig | undefined,
): ModelProviderConfig | undefined {
  const kindOf = (provider: ModelProviderConfig): string | undefined =>
    config?.capabilities?.find((capability) => capability.id === provider.modelId)?.kind;
  // The primary is the MAIN CHAT connection (an absent capability entry defaults to chat) — the
  // first non-voice provider is not enough, because a dedicated embedding or OCR provider may
  // be listed first and its connection would misclassify every chat-sharing provider as
  // dedicated (review finding on #3037). Voice-only stores have no chat primary and no
  // restoration comparisons to make.
  const chat = config?.providers.find((provider) => {
    const kind = kindOf(provider);
    return kind === undefined || kind === "chat";
  });
  return chat ?? config?.providers.find((provider) => kindOf(provider) !== "voice");
}

function currentDedicatedEmbeddingModelIds(config: GatewayConfig | undefined): readonly string[] {
  const primary = storedPrimaryGatewayProvider(config);
  if (config === undefined || primary === undefined) return [];
  const embeddingIds = new Set(currentEmbeddingModelIds(config));
  const primaryHeader = primary.apiKeyHeaderName ?? DEFAULT_API_KEY_HEADER_NAME;
  return config.providers
    .filter((provider) => {
      if (!embeddingIds.has(provider.modelId)) return false;
      const sharesConnection =
        sameBaseUrlIdentity(provider.baseUrl, primary.baseUrl) &&
        provider.apiKey === primary.apiKey &&
        (provider.apiKeyHeaderName ?? DEFAULT_API_KEY_HEADER_NAME) === primaryHeader &&
        // A provider that deliberately spoke a DIFFERENT protocol over the same connection is
        // dedicated for this purpose: rebuilding it with the setup-wide protocol would put an
        // unprobed request shape on it (review finding on #3046, the embedding twin of the
        // restored-provider rule).
        spokeStoredGatewayProtocol(provider, primary);
      return !sharesConnection;
    })
    .map((provider) => provider.modelId);
}

function currentVoiceModelIds(config: GatewayConfig | undefined): readonly string[] {
  return (
    config?.capabilities
      ?.filter((capability) => isVoiceCapability(capability))
      .map((capability) => capability.id) ?? []
  );
}

// `supportedVoicePersonas` is DERIVED at parse time from a provider's `voiceProfiles` (Issue #1557,
// ADR-0094 D2 / HAZARD-3). It must NOT be persisted: the strict top-level `capabilities` parser
// rejects it as an unrecognised input key, and re-deriving it on reload keeps a single source of
// truth (the credential-tier `voiceProfiles`). Strip it so a save → reload round-trip re-derives.
function stripDerivedVoicePersonas(capability: ModelCapability): ModelCapability {
  const { supportedVoicePersonas, ...rest } = capability;
  return supportedVoicePersonas === undefined ? capability : rest;
}

// Exported as a test seam (mirroring `smokeTestCandidates` / the discovery-normalization exports):
// the preserve-existing save path round-trips a parsed config back to raw for persistence, and the
// Issue #1557 voice-persona round-trip (voiceProfiles preserved, derived supportedVoicePersonas
// stripped and re-derived on reload — ADR-0094 D2) is pinned directly against this function.
function rawProviderFromCurrent(
  provider: ModelProviderConfig,
  capability: ModelCapability | undefined,
  timeoutMs: number | undefined,
): Record<string, unknown> {
  return {
    modelId: provider.modelId,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    apiKeyHeaderName: provider.apiKeyHeaderName ?? DEFAULT_API_KEY_HEADER_NAME,
    ...(provider.endpointStyle === undefined ? {} : { endpointStyle: provider.endpointStyle }),
    ...(provider.apiVersion === undefined ? {} : { apiVersion: provider.apiVersion }),
    ...(provider.outputTokenParameter === undefined
      ? {}
      : { outputTokenParameter: provider.outputTokenParameter }),
    ...(provider.realtimeAuthMode === undefined
      ? {}
      : { realtimeAuthMode: provider.realtimeAuthMode }),
    timeoutMs: timeoutMs ?? provider.timeoutMs,
    maxRetries: provider.maxRetries,
    retryBaseDelayMs: provider.retryBaseDelayMs,
    // Persist the credential-tier persona → voice-id mapping so personas survive a save; the
    // derived content-free `supportedVoicePersonas` is stripped and re-derived on reload.
    ...(provider.voiceProfiles === undefined ? {} : { voiceProfiles: provider.voiceProfiles }),
    // KEIKO-0167 (PR-review follow-up): persist the per-provider circuit-breaker override so
    // a credential rotation or an otherwise unrelated setup save does not silently drop it.
    ...(provider.circuitBreaker === undefined ? {} : { circuitBreaker: provider.circuitBreaker }),
    ...(capability === undefined ? {} : { capability: stripDerivedVoicePersonas(capability) }),
  };
}

export function rawConfigFromCurrent(
  config: GatewayConfig,
  figmaAccessToken: string | undefined,
  timeoutMs?: number,
): Record<string, unknown> {
  return {
    providers: config.providers.map((provider) =>
      rawProviderFromCurrent(
        provider,
        config.capabilities?.find((item) => item.id === provider.modelId),
        timeoutMs,
      ),
    ),
    circuitBreaker: config.circuitBreaker,
    ...(config.capabilities === undefined
      ? {}
      : { capabilities: config.capabilities.map(stripDerivedVoicePersonas) }),
    ...(config.grounding === undefined ? {} : { grounding: config.grounding }),
    ...(config.reranker === undefined ? {} : { reranker: config.reranker }),
    ...(figmaAccessToken === undefined ? {} : { figma: { accessToken: figmaAccessToken } }),
  };
}

function rawCapabilityIsVoice(value: unknown): boolean {
  return isRecord(value) && value.kind === "voice";
}

function rawProviderIsVoice(value: unknown): boolean {
  return isRecord(value) && rawCapabilityIsVoice(value.capability);
}

function setupVoiceProviderFromCurrent(
  provider: ModelProviderConfig,
  capabilities: readonly ModelCapability[] | undefined,
): readonly SetupVoiceProvider[] {
  const capability = capabilities?.find(
    (candidate) => candidate.id === provider.modelId && isVoiceCapability(candidate),
  );
  if (capability === undefined) return [];
  return [
    {
      modelId: provider.modelId,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      apiKeyHeaderName: provider.apiKeyHeaderName ?? DEFAULT_API_KEY_HEADER_NAME,
      timeoutMs: provider.timeoutMs,
      maxRetries: provider.maxRetries,
      retryBaseDelayMs: provider.retryBaseDelayMs,
      ...voiceProviderEndpointRaw({ capabilities: voiceCapabilities(capability), ...provider }),
      providerLocality: capability.voiceProviderLocality ?? "azure-foundry",
      capabilities: voiceCapabilities(capability),
      rawCapability: capability,
      ...(provider.voiceProfiles === undefined ? {} : { voiceProfiles: provider.voiceProfiles }),
      // KEIKO-0167 (PR-review follow-up, Codex thread 3769711637): carry the persisted
      // per-provider circuit-breaker override through the setup round-trip.
      ...(provider.circuitBreaker === undefined ? {} : { circuitBreaker: provider.circuitBreaker }),
    },
  ];
}

function voiceCapabilities(capability: ModelCapability): SetupVoiceCapabilities {
  return {
    speechInput: modelSupportsSpeechInput(capability),
    speechOutput: modelSupportsSpeechOutput(capability),
    realtime: modelSupportsRealtimeVoice(capability),
    ...(capability.supportsSemanticTurnDetection === true
      ? { supportsSemanticTurnDetection: true }
      : {}),
    ...(capability.supportsSpeechSynthesisInstructions === true
      ? { supportsSpeechSynthesisInstructions: true }
      : {}),
    ...(capability.realtimeTranscriptionModel === undefined
      ? {}
      : { realtimeTranscriptionModel: capability.realtimeTranscriptionModel }),
  };
}

function setupVoiceProvidersFromCurrent(
  current: GatewayConfig | undefined,
): readonly SetupVoiceProvider[] {
  if (current === undefined) return [];
  return current.providers.flatMap((provider) =>
    setupVoiceProviderFromCurrent(provider, current.capabilities),
  );
}

function applyVoiceProviders(
  rawConfig: Record<string, unknown>,
  voiceProviders: readonly SetupVoiceProvider[],
): Record<string, unknown> {
  if (voiceProviders.length === 0) {
    return rawConfig;
  }
  const providers: unknown[] = Array.isArray(rawConfig.providers) ? rawConfig.providers : [];
  const nextProviders = providers.filter((provider) => {
    if (!isRecord(provider)) return true;
    return !rawProviderIsVoice(provider);
  });
  const nextConfig: Record<string, unknown> = {
    ...rawConfig,
    providers: [
      ...nextProviders,
      ...voiceProviders.map((provider) =>
        voiceProviderRaw(provider.modelId, provider.baseUrl, provider.apiKey, {
          apiKeyHeaderName: provider.apiKeyHeaderName,
          timeoutMs: provider.timeoutMs,
          maxRetries: provider.maxRetries,
          retryBaseDelayMs: provider.retryBaseDelayMs,
          endpointStyle: provider.endpointStyle,
          apiVersion: provider.apiVersion,
          realtimeAuthMode: provider.realtimeAuthMode,
          providerLocality: provider.providerLocality,
          capabilities: provider.capabilities,
          rawCapability: provider.rawCapability,
          ...(provider.voiceProfiles === undefined
            ? {}
            : { voiceProfiles: provider.voiceProfiles }),
          ...(provider.circuitBreaker === undefined
            ? {}
            : { circuitBreaker: provider.circuitBreaker }),
        }),
      ),
    ],
  };
  if (Array.isArray(rawConfig.capabilities)) {
    nextConfig.capabilities = rawConfig.capabilities.filter(
      (capability) => !rawCapabilityIsVoice(capability),
    );
  }
  return nextConfig;
}

function withInheritedEgress(
  rawConfig: Record<string, unknown>,
  egress: GatewayEgressConfig | undefined,
): Record<string, unknown> {
  if (egress === undefined || Object.hasOwn(rawConfig, "egress")) {
    return rawConfig;
  }
  return { ...rawConfig, egress };
}

function modelsEndpoint(baseUrl: string): string {
  return `${baseUrl}/models`;
}

function modelInfoEndpointCandidates(baseUrl: string): readonly string[] {
  const normalized = normalizeBaseUrl(baseUrl);
  return [`${normalized}/model/info`];
}

function apiKeyHeaders(apiKey: string, apiKeyHeaderName: string): Record<string, string> {
  return { [apiKeyHeaderName]: apiKeyHeaderValue(apiKeyHeaderName, apiKey) };
}

function hasDisallowedModelIdCharacter(id: string): boolean {
  for (let index = 0; index < id.length; index += 1) {
    const code = id.codePointAt(index) ?? 0;
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}

function isUsableModelId(id: string): boolean {
  return id.length > 0 && id.length <= MAX_MODEL_ID_LENGTH && !hasDisallowedModelIdCharacter(id);
}

function modelIdFromKnownFields(item: Record<string, unknown>): string | undefined {
  for (const field of ["id", "model_name", "model", "deployment_name", "deploymentName"]) {
    const value = item[field];
    if (typeof value === "string") {
      const id = value.trim();
      if (isUsableModelId(id)) {
        return id;
      }
    }
  }
  return undefined;
}

function nestedRecord(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const nested = value[key];
  return isRecord(nested) ? nested : undefined;
}

function modelModeFromDiscoveryItem(item: Record<string, unknown>): string | undefined {
  const modelInfo = nestedRecord(item, "model_info");
  const litellmParams = nestedRecord(item, "litellm_params");
  const candidates = [item.mode, modelInfo?.mode, litellmParams?.mode];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim().toLowerCase();
    }
  }
  return undefined;
}

// Issue #144: exported as part of the discovery-normalization seam so a
// sibling test file can drive it with synthetic payloads. Behaviour unchanged
// — only the visibility is widened.
export function isExplicitlyNonChatModel(item: Record<string, unknown>): boolean {
  const capabilities = isRecord(item.capabilities) ? item.capabilities : undefined;
  if (capabilities?.chat_completion === false) {
    return true;
  }
  const mode = modelModeFromDiscoveryItem(item);
  return mode !== undefined && !declaresChatCompatibleMode(mode);
}

// "unsupported" is a DISCOVERY outcome, never a configured capability: the model is recognised
// and reported to the operator, but it gets no provider entry and no slot in any selection list.
type DiscoveryModelKind = "chat" | "embedding" | "unsupported";

interface ClassifiedDiscoveryModel {
  readonly id: string;
  readonly kind: DiscoveryModelKind;
  readonly supportsImageInput: boolean;
  readonly metadata: GatewayDiscoveredModelMetadata;
  /** Why the model is unsupported. Always present on an "unsupported" entry, absent otherwise. */
  readonly reason?: GatewayModelUnsupportedReason;
}

/** Narrowed view of an entry the classifier marked unsupported: the reason is guaranteed. */
interface UnsupportedDiscoveryModel extends ClassifiedDiscoveryModel {
  readonly kind: "unsupported";
  readonly reason: GatewayModelUnsupportedReason;
}

function isUnsupportedEntry(entry: ClassifiedDiscoveryModel): entry is UnsupportedDiscoveryModel {
  return entry.kind === "unsupported" && entry.reason !== undefined;
}

// Classification WITHOUT a declaration: the id heuristic is all a `/models`-only gateway gives us.
function classifyUndeclaredDiscoveryItem(
  item: Record<string, unknown>,
  id: string,
  metadata: GatewayDiscoveredModelMetadata,
): ClassifiedDiscoveryModel {
  if (isLikelyEmbeddingModelId(id)) {
    return { id, kind: "embedding", supportsImageInput: false, metadata };
  }
  return {
    id,
    kind: "chat",
    supportsImageInput: supportsImageInputFromDiscoveryItem(item, id),
    metadata,
  };
}

// A DECLARED mode is authoritative; the id heuristic is only the no-declaration fallback.
// Field incident (LiteLLM customer, 2026-08): the old order let a name beat the declaration, so a
// `mode: "rerank"` endpoint named "bge-reranker-v2-m3" was stored as this gateway's embedding
// model, bound to every new Knowledge Pod, and indexing wrote zero vectors. Keiko is
// model-agnostic — the customer hosts whatever models they like, so only the gateway's own
// statement about a model can decide its role.
function classifyDiscoveryItem(item: unknown): ClassifiedDiscoveryModel | undefined {
  if (!isRecord(item)) {
    return undefined;
  }
  const id = modelIdFromKnownFields(item);
  if (id === undefined) {
    return undefined;
  }
  const metadata = metadataFromDiscoveryItem(item);
  const declaredMode = modelModeFromDiscoveryItem(item);
  if (declaredMode !== undefined) {
    const role = modelKindForDeclaredMode(declaredMode);
    if (role === "unsupported") {
      // The reason is drawn from a CLOSED vocabulary. A declared mode is gateway-controlled text of
      // unbounded shape; echoing it verbatim would put foreign strings into the diagnostic channel
      // and the setup response, which the redaction rules forbid.
      const reason = boundedUnsupportedReason(declaredMode);
      return { id, kind: "unsupported", supportsImageInput: false, metadata, reason };
    }
    if (role === "embedding") {
      return { id, kind: "embedding", supportsImageInput: false, metadata };
    }
    return {
      id,
      kind: "chat",
      supportsImageInput: supportsImageInputFromDiscoveryItem(item, id),
      metadata,
    };
  }
  // No declaration. `capabilities.chat_completion === false` states what the model is NOT, which
  // is not a role: an embedding model legitimately carries it. So the id heuristic still decides,
  // exactly as before — it just cannot fall through to "chat".
  if (isExplicitlyNonChatModel(item)) {
    return isLikelyEmbeddingModelId(id)
      ? { id, kind: "embedding", supportsImageInput: false, metadata }
      : {
          id,
          kind: "unsupported",
          supportsImageInput: false,
          metadata,
          reason: "not-chat-capable",
        };
  }
  return classifyUndeclaredDiscoveryItem(item, id, metadata);
}

// Issue #144: exported as part of the discovery-normalization seam. Gateway setup now returns
// embedding-capable records so setup can persist them for Local Knowledge while keeping them out of
// chat.
// Returns undefined for unknown/non-record/unsupported/malformed input so
// callers can drop the entry silently and keep healthy peers.
export function modelIdFromDiscoveryItem(item: unknown): string | undefined {
  const classified = classifyDiscoveryItem(item);
  return classified === undefined || classified.kind === "unsupported" ? undefined : classified.id;
}

// Issue #144: exported as part of the discovery-normalization seam. Throws on schema-level
// malformation (no data array) and on the "every entry filtered" terminal case so the caller
// (production path) returns an honest error rather than a silently-empty model list.
export function parseModelDiscovery(payload: unknown): GatewayDiscoveredModels {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error("model discovery response must contain a data array");
  }
  // First occurrence wins, with ONE exception: a usable entry replaces an unsupported one for the
  // same id. A LiteLLM `model_name` is a routing alias that can front several deployments, and an
  // unusable one listed first must not shadow the usable duplicate behind it.
  const byId = new Map<string, ClassifiedDiscoveryModel>();
  for (const item of payload.data) {
    const classified = classifyDiscoveryItem(item);
    if (classified === undefined) continue;
    const existing = byId.get(classified.id);
    if (
      existing === undefined ||
      (existing.kind === "unsupported" && classified.kind !== "unsupported")
    ) {
      byId.set(classified.id, classified);
    }
  }
  const entries: ClassifiedDiscoveryModel[] = [...byId.values()];
  // KEIKO-0325: raise a truncation flag alongside the limited slice so callers can
  // surface "N of M models discovered; add the rest by deployment name" instead of the
  // pre-fix silent drop. Kept optional-and-off-by-default so a fitting-within-cap
  // discovery does not carry a redundant `truncated: false` on the wire.
  // Recognised-but-unusable models are reported, never configured: they get no provider entry and
  // no slot in any selection list, but the operator learns they exist and why they were skipped.
  // They are partitioned BEFORE the cap — a gateway listing 60 audio endpoints ahead of its chat
  // aliases must not push the chat models past MAX_DISCOVERED_MODELS.
  const unsupported = entries.filter(isUnsupportedEntry);
  const usableEntries = entries.filter((entry) => entry.kind !== "unsupported");
  const wasTruncated = usableEntries.length > MAX_DISCOVERED_MODELS;
  const usable = usableEntries.slice(0, MAX_DISCOVERED_MODELS);
  assertDiscoveryYieldedUsableModels(usable, unsupported);
  return {
    modelIds: usable.map((entry) => entry.id),
    chatModelIds: usable.filter((entry) => entry.kind === "chat").map((entry) => entry.id),
    embeddingModelIds: usable
      .filter((entry) => entry.kind === "embedding")
      .map((entry) => entry.id),
    imageInputModelIds: usable
      .filter((entry) => entry.kind === "chat" && entry.supportsImageInput)
      .map((entry) => entry.id),
    modelMetadata: Object.fromEntries(usable.map((entry) => [entry.id, entry.metadata])),
    ...(unsupported.length > 0
      ? {
          unsupportedModels: unsupported.map((entry) => ({
            id: entry.id,
            reason: entry.reason,
          })),
        }
      : {}),
    ...(wasTruncated ? { truncated: true } : {}),
  };
}

function assertDiscoveryYieldedUsableModels(
  usable: readonly ClassifiedDiscoveryModel[],
  unsupported: readonly UnsupportedDiscoveryModel[],
): void {
  if (usable.length > 0) return;
  const terminal =
    unsupported.length > 0
      ? discoveryTerminal(
          "model discovery found only models this gateway declared as unsupported modes",
          "DISCOVERY_ALL_ENTRIES_UNSUPPORTED",
        )
      : discoveryTerminal("model discovery returned no model ids", "DISCOVERY_EMPTY");
  throw terminal;
}

// Tags a discovery terminal so the caller can tell "this gateway has no /model/info" (fall back to
// /models) from "the endpoint answered and the answer is unusable" (surface it). Mirrors the
// existing httpStatus tagging on fetch failures.
function discoveryTerminal(message: string, code: string): Error {
  return Object.assign(new Error(message), { discoveryCode: code });
}

export function parseModelList(payload: unknown): readonly string[] {
  return parseModelDiscovery(payload).modelIds;
}

// Issue #144 AC #4: the public discovery-normalization seam. Test target. Pure
// wrapper around `parseModelList` so the AC ("Discovery handles additional
// customer gateway models without requiring code changes for each model name")
// can be pinned against a stable export name even if the internal helper is
// reshaped later.
export function normalizeDiscoveryPayload(payload: unknown): readonly string[] {
  return parseModelList(payload);
}

export function normalizeDiscoveryPayloadForSetup(payload: unknown): GatewayDiscoveredModels {
  return parseModelDiscovery(payload);
}

async function fetchDiscoveryJson(
  url: string,
  apiKey: string,
  apiKeyHeaderName: string,
  egress?: GatewayEgressConfig,
): Promise<unknown> {
  const response = await gatewayFetch(url, {
    method: "GET",
    headers: apiKeyHeaders(apiKey, apiKeyHeaderName),
    signal: AbortSignal.timeout(30_000),
    ...(egress !== undefined ? { egress } : {}),
  });
  if (!response.ok) {
    // The classifier (`setupCandidateError` via `setupHttpStatus`) reads the status as an error
    // property; carrying it only inside the message left a 401/403 discovery — a wrong or
    // model-restricted proxy key — as the generic body-free 502 (LiteLLM production audit).
    throw Object.assign(new Error(`model discovery returned HTTP ${String(response.status)}`), {
      httpStatus: response.status,
    });
  }
  try {
    return await readJsonCapped(response);
  } catch {
    throw new Error("model discovery response was not readable JSON");
  }
}

// `/model/info` is a LiteLLM management route. Plenty of healthy deployments refuse it — an
// ingress that exposes only /v1/*, a virtual key without management scope, a rate-limited proxy —
// and they have always set up fine by degrading to the mode-free /models list. Losing mode
// enrichment is not a silent failure: a genuinely bad credential still fails the chat smoke test
// loudly. So EVERY transport or HTTP outcome falls back, exactly as before.
//
// Exactly one outcome must NOT fall back: the endpoint answered, Keiko understood every entry, and
// every one declared a mode with no lane. Falling back there would re-read the same models from
// /models WITHOUT their declarations and hand them to the id heuristic — resurrecting the very
// misclassification this change exists to prevent.
function modelInfoAnswerIsUnusable(cause: unknown): boolean {
  return (
    (cause as { discoveryCode?: unknown } | null)?.discoveryCode ===
    "DISCOVERY_ALL_ENTRIES_UNSUPPORTED"
  );
}

async function discoverLiteLlmModelInfo(
  baseUrl: string,
  apiKey: string,
  apiKeyHeaderName: string,
  egress?: GatewayEgressConfig,
): Promise<GatewayDiscoveredModels | undefined> {
  for (const endpoint of modelInfoEndpointCandidates(baseUrl)) {
    try {
      return parseModelDiscovery(
        await fetchDiscoveryJson(endpoint, apiKey, apiKeyHeaderName, egress),
      );
    } catch (cause) {
      if (modelInfoAnswerIsUnusable(cause) && cause instanceof Error) throw cause;
    }
  }
  return undefined;
}

async function defaultGatewayModelDiscovery(
  baseUrl: string,
  apiKey: string,
  apiKeyHeaderName = DEFAULT_API_KEY_HEADER_NAME,
  egress?: GatewayEgressConfig,
): Promise<GatewayDiscoveredModels> {
  const litellmModels = await discoverLiteLlmModelInfo(baseUrl, apiKey, apiKeyHeaderName, egress);
  if (litellmModels !== undefined) {
    return litellmModels;
  }
  return parseModelDiscovery(
    await fetchDiscoveryJson(modelsEndpoint(baseUrl), apiKey, apiKeyHeaderName, egress),
  );
}

function deploymentNameValues(value: unknown): readonly string[] | undefined {
  if (typeof value === "string") {
    return value.split(/[\n,]/u);
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  return undefined;
}

function normalizeDeploymentNames(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values.map((item) => item.trim()).filter((item) => item.length > 0)));
}

function parseDeploymentNames(value: unknown): readonly string[] | RouteResult {
  if (value === undefined) {
    return [];
  }
  const values = deploymentNameValues(value);
  if (values === undefined) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "deploymentNames must be a string or an array of strings."),
    };
  }
  const names = normalizeDeploymentNames(values);
  if (names.length > MAX_DEPLOYMENT_NAMES) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "deploymentNames exceeds the model setup limit."),
    };
  }
  if (names.some((name) => !isUsableModelId(name))) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "deploymentNames contains an invalid model id."),
    };
  }
  return names;
}

function parseImageInputModelIds(value: unknown): readonly string[] | undefined | RouteResult {
  // Absent and explicitly empty are different statements: absent inherits the stored set in
  // update mode, an explicit empty list clears it — exactly like the workflow-eligible field
  // (review finding on #3031).
  if (value === undefined) {
    return undefined;
  }
  const values = deploymentNameValues(value);
  if (values === undefined) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "imageInputModelIds must be a string or an array of strings."),
    };
  }
  const names = normalizeDeploymentNames(values);
  if (names.length > MAX_DEPLOYMENT_NAMES) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "imageInputModelIds exceeds the model setup limit."),
    };
  }
  if (names.some((name) => !isUsableModelId(name))) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "imageInputModelIds contains an invalid model id."),
    };
  }
  return names;
}

/**
 * Embedding ids the CLIENT asserts (e.g. imported from a configuration file whose capability
 * records carry the kind). Authoritative over the name heuristic for fresh setups, where no
 * stored kind exists yet — without it a non-heuristic embedding id would be chat-probed and
 * dropped or persisted as chat (review finding on #3037). Absent means "derive as before".
 */
function parseEmbeddingModelIds(value: unknown): readonly string[] | undefined | RouteResult {
  if (value === undefined) {
    return undefined;
  }
  const values = deploymentNameValues(value);
  if (values === undefined) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "embeddingModelIds must be a string or an array of strings."),
    };
  }
  const names = normalizeDeploymentNames(values);
  if (names.length > MAX_DEPLOYMENT_NAMES) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "embeddingModelIds exceeds the model setup limit."),
    };
  }
  if (names.some((name) => !isUsableModelId(name))) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "embeddingModelIds contains an invalid model id."),
    };
  }
  return names;
}

function parseWorkflowEligibleModelIds(value: unknown): readonly string[] | RouteResult {
  if (value === undefined) return [];
  const values = deploymentNameValues(value);
  if (values === undefined) {
    return {
      status: 400,
      body: errorBody(
        "BAD_REQUEST",
        "workflowEligibleModelIds must be a string or an array of strings.",
      ),
    };
  }
  const names = normalizeDeploymentNames(values);
  if (names.length > MAX_DEPLOYMENT_NAMES || names.some((name) => !isUsableModelId(name))) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "workflowEligibleModelIds contains invalid model ids."),
    };
  }
  return names;
}

// Shared by every `parseGatewayConfig` call that runs immediately after
// `validateLinkLocalGatewayBaseUrl` has already approved the same baseUrl for this request, so
// the shared SSRF classifier (hardened to unconditionally block metadata/link-local for the
// generic `allowPrivateNetwork` opt-in, AUDIT-SEC-002) does not re-reject a URL this route has
// already deliberately approved via its own, narrower, env-flag-gated check.
function linkLocalGatewayOverrideOptions(env: EnvSource): ParseGatewayConfigOptions {
  return envFlagEnabled(env, ALLOW_LINK_LOCAL_GATEWAY_ENV)
    ? { egressOverride: { allowLinkLocalAndMetadata: true } }
    : {};
}

function validateSetupConnection(
  baseUrl: string,
  apiKey: string,
  apiKeyHeaderName: string,
  env: EnvSource,
  protocol: {
    readonly endpointStyle?: string | undefined;
    readonly apiVersion?: string | undefined;
  } = {},
): RouteResult | undefined {
  const linkLocalError = validateLinkLocalGatewayBaseUrl(baseUrl, env);
  if (linkLocalError !== undefined) return linkLocalError;
  try {
    parseGatewayConfig(
      buildRawConfig(baseUrl, apiKey, ["setup-validation"], {
        apiKeyHeaderName,
        ...(protocol.endpointStyle === undefined ? {} : { endpointStyle: protocol.endpointStyle }),
        ...(protocol.apiVersion === undefined ? {} : { apiVersion: protocol.apiVersion }),
      }),
      env,
      linkLocalGatewayOverrideOptions(env),
    );
    return undefined;
  } catch (error) {
    if (error instanceof ConfigInvalidError) {
      return { status: 400, body: errorBody("BAD_REQUEST", error.message) };
    }
    throw error;
  }
}

/**
 * Classification evidence captured from a swallowed per-model probe failure — exactly the
 * code/status pair `setupCandidateError` reads, never probe messages or response bodies
 * (LiteLLM production audit: an all-probes auth failure must classify as a credential failure
 * instead of the generic body-free 502).
 */
interface ProbeFailureEvidence {
  readonly code: string | undefined;
  readonly httpStatus: number | undefined;
}

const PROBE_FAILURE_UNCLASSIFIED = 0;

function probeCodeSeverity(code: string | undefined): number {
  if (code === ERROR_CODES.AUTHENTICATION) return 4;
  if (code === ERROR_CODES.RATE_LIMIT) return 3;
  if (code !== undefined && SETUP_NETWORK_ERROR_CODES.has(code)) return 2;
  if (code === ERROR_CODES.UNKNOWN_MODEL) return 1;
  return PROBE_FAILURE_UNCLASSIFIED;
}

function probeStatusSeverity(status: number | undefined): number {
  if (status === 401 || status === 403) return 4;
  if (status === 429) return 3;
  if (status === 404) return 1;
  return PROBE_FAILURE_UNCLASSIFIED;
}

// Mirrors `setupCandidateError`'s precedence: a recognized code classifies first, the HTTP
// status classifies only when the code does not.
function probeFailureSeverity(evidence: ProbeFailureEvidence): number {
  const codeSeverity = probeCodeSeverity(evidence.code);
  return codeSeverity === PROBE_FAILURE_UNCLASSIFIED
    ? probeStatusSeverity(evidence.httpStatus)
    : codeSeverity;
}

function mostSevereProbeFailure(
  failures: readonly ProbeFailureEvidence[],
): ProbeFailureEvidence | undefined {
  let worst: ProbeFailureEvidence | undefined;
  let worstSeverity = PROBE_FAILURE_UNCLASSIFIED;
  for (const failure of failures) {
    const severity = probeFailureSeverity(failure);
    if (severity > worstSeverity) {
      worst = failure;
      worstSeverity = severity;
    }
  }
  return worst;
}

async function passingCandidates(
  candidates: readonly string[],
  probe: (modelId: string) => Promise<void>,
  concurrency: number,
  failures?: ProbeFailureEvidence[],
): Promise<readonly string[]> {
  const tested = new Array<string | undefined>(candidates.length).fill(undefined);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < candidates.length) {
      const index = next;
      next += 1;
      const modelId = candidates[index];
      if (modelId === undefined) {
        continue;
      }
      try {
        await probe(modelId);
        tested[index] = modelId;
      } catch (error) {
        // Probe rejection is the documented signal that this candidate is not
        // chat-callable. We drop it silently so healthy peers still surface — capturing only
        // the classification code/status as evidence for the all-rejected aggregate.
        failures?.push({ code: setupErrorCode(error), httpStatus: setupHttpStatus(error) });
      }
    }
  }
  const workerCount = Math.max(1, Math.min(concurrency, candidates.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return tested.filter((modelId): modelId is string => modelId !== undefined);
}

// The aggregate keeps the exact historic message; additionally it carries the most severe
// classified code/status observed across the per-model probe failures so `setupCandidateError`
// maps an all-probes auth or rate-limit failure onto its existing guidance instead of the
// generic body-free 502 (LiteLLM production audit).
function allProbesFailedError(failures: readonly ProbeFailureEvidence[]): Error {
  const error = new Error("no discovered model accepted the chat-completions smoke test");
  const worst = mostSevereProbeFailure(failures);
  if (worst === undefined) return error;
  return Object.assign(error, {
    ...(worst.code === undefined ? {} : { code: worst.code }),
    ...(worst.httpStatus === undefined ? {} : { httpStatus: worst.httpStatus }),
  });
}

// Issue #144: pure smoke-test loop extracted from `defaultGatewaySetupTester`
// for testability. Concurrency is a parameter so callers (tests) can pin peak
// in-flight count deterministically. Original-order preservation among
// survivors is part of the observable contract — pinned by gateway-setup tests
// that assert tested-model-id order matches input order with failed entries
// dropped.
//
// Throws with the exact error message that `defaultGatewaySetupTester` has
// always thrown so existing call sites and tests keep compiling.
export async function smokeTestCandidates(
  candidates: readonly string[],
  probe: (modelId: string) => Promise<void>,
  concurrency: number,
): Promise<readonly string[]> {
  const failures: ProbeFailureEvidence[] = [];
  const accepted = await passingCandidates(candidates, probe, concurrency, failures);
  if (accepted.length === 0) {
    throw allProbesFailedError(failures);
  }
  return accepted;
}

async function defaultGatewaySetupTester(
  config: GatewayConfig,
  candidateModelIds: readonly string[],
  correlationId: string | undefined,
  deps: UiHandlerDeps,
): Promise<GatewaySetupTestResult> {
  // Wired to the process activity log: first-run setup is where an operator's endpoint is wrong
  // in a way no UI message can name (a proxy that blocks CONNECT, a provider that answers 404 for
  // every model). Without the sink the smoke loop's retries and rejections are invisible.
  const gateway = new Gateway(config, { log: processServerLogSink() });
  const testedModelIds = await smokeTestCandidates(
    candidateModelIds,
    async (modelId) => {
      await gateway.chat({
        modelId,
        messages: [
          { role: "system", content: CONVERSATION_SYSTEM_PROMPT },
          { role: "user", content: "Reply with exactly: OK" },
        ],
        logContext: { correlationId },
      });
    },
    SETUP_SMOKE_CONCURRENCY,
  );
  const responseFormatModelIds = await passingCandidates(
    testedModelIds,
    async (modelId) => {
      const response = await gateway.chat({
        ...buildQiJudgePreflightRequest(modelId),
        logContext: { correlationId },
      });
      if (tryParseJudgeVerdict(response.content) === null) {
        throw new Error("response format unsupported");
      }
    },
    SETUP_SMOKE_CONCURRENCY,
  );
  // Both probe rounds independently use the endpoint-wide concurrency budget. Keep them
  // sequential so setup never doubles the operator-approved in-flight request ceiling.
  const toolCallingObservations = await setupToolCallingObservations(
    config,
    testedModelIds,
    correlationId,
    deps,
  );
  return { testedModelIds, responseFormatModelIds, toolCallingObservations };
}

async function setupToolCallingObservations(
  config: GatewayConfig,
  testedModelIds: readonly string[],
  correlationId: string | undefined,
  deps: UiHandlerDeps,
): Promise<readonly GatewaySetupToolCallingObservation[]> {
  const checkedAt = new Date().toISOString();
  const observations = new Array<GatewaySetupToolCallingObservation>(testedModelIds.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < testedModelIds.length) {
      const index = next;
      next += 1;
      const modelId = testedModelIds[index];
      if (modelId === undefined) continue;
      const provider = config.providers.find((candidate) => candidate.modelId === modelId);
      if (provider === undefined) {
        observations[index] = { modelId, status: "unverified", checkedAt };
        continue;
      }
      const status = await probeGatewayToolCalling(config, provider, undefined, (error) => {
        reportSetupVerificationFailure(
          deps,
          error,
          correlationId,
          "gateway.setup.tool-calling-probe",
        );
      });
      observations[index] = {
        modelId,
        status,
        checkedAt,
      };
      logToolCallingVerification(config, modelId, status, correlationId ?? UNKNOWN_CORRELATION_ID);
    }
  }
  const workerCount = Math.max(1, Math.min(SETUP_SMOKE_CONCURRENCY, testedModelIds.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return observations;
}

// Field incident (LiteLLM customer, 2026-08): chat models were smoke-tested, embedding models were
// persisted on the strength of a classification alone. A model the gateway DECLARES as an embedding
// engine but which cannot answer /embeddings was bound to every new Knowledge Pod, and indexing
// wrote zero vectors with no earlier signal. One real request per candidate closes that gap; the
// four-input space fingerprint stays where it belongs (the pod's first indexing preflight), because
// on CPU-served hardware four inputs per model would make setup crawl.
const EMBEDDING_PROBE_INPUT = "Keiko embedding setup probe";

// One embedding request against the model, using the SAME endpoint protocol the provider will
// persist with — an Azure deployment path must not be probed at the OpenAI-compatible URL, or the
// probe measures a 404 that production would never see.
async function embedOnceForProbe(
  provider: ModelProviderConfig,
  modelId: string,
): Promise<OpenAIEmbeddingOutcome> {
  return requestOpenAIEmbedding({
    endpoint: provider.baseUrl,
    apiKey: provider.apiKey,
    ...(provider.apiKeyHeaderName !== undefined
      ? { apiKeyHeaderName: provider.apiKeyHeaderName }
      : {}),
    ...(provider.egress !== undefined ? { egress: provider.egress } : {}),
    ...(provider.endpointStyle !== undefined ? { endpointStyle: provider.endpointStyle } : {}),
    ...(provider.apiVersion !== undefined ? { apiVersion: provider.apiVersion } : {}),
    modelId,
    input: EMBEDDING_PROBE_INPUT,
    timeoutMs: provider.timeoutMs,
    // The probe exists because an embedding model used to be persisted on a classification alone.
    // The sink is what turns a rejected probe into a line naming the status and the error kind,
    // rather than a model that silently fails to make the candidate list.
    log: processServerLogSink(),
  });
}

// Transient kinds get exactly ONE retry, matching the chat lane's `maxRetries: 1`: a single
// rate-limit or cold-start blip must not permanently exclude a working embedding model, and
// requestOpenAIEmbedding is a bare transport that does no retrying of its own.
const RETRYABLE_PROBE_KINDS: ReadonlySet<string> = new Set([
  "rate-limited",
  "timeout",
  "transport",
]);
// An immediate retry against a gateway that just answered 429 answers 429 again, so it would burn a
// request and change nothing. One short pause, matching the chat lane's backoff base.
const EMBEDDING_PROBE_RETRY_DELAY_MS = 500;

async function defaultGatewayEmbeddingProbe(
  config: GatewayConfig,
  candidateModelIds: readonly string[],
): Promise<readonly string[]> {
  return passingCandidates(
    candidateModelIds,
    async (modelId) => {
      const provider = config.providers.find((entry) => entry.modelId === modelId);
      if (provider === undefined) throw new Error("embedding candidate has no provider entry");
      let outcome = await embedOnceForProbe(provider, modelId);
      if (!outcome.ok && RETRYABLE_PROBE_KINDS.has(outcome.kind)) {
        await new Promise((resolve) => setTimeout(resolve, EMBEDDING_PROBE_RETRY_DELAY_MS));
        outcome = await embedOnceForProbe(provider, modelId);
      }
      // The per-model verdict is what the operator acts on, and it travels in
      // droppedEmbeddingModelIds / unverifiedEmbeddingModelIds. passingCandidates drops the
      // rejection, which is the intended contract here: a failed candidate is not admitted.
      if (!outcome.ok || outcome.value.vector.length === 0) {
        throw new Error("embedding probe returned no usable vector");
      }
    },
    SETUP_SMOKE_CONCURRENCY,
  );
}

function gatewayEmbeddingProbe(deps: UiHandlerDeps): GatewayEmbeddingProbe {
  return deps.gatewayEmbeddingProbe ?? defaultGatewayEmbeddingProbe;
}

// The seam type (UiHandlerDeps["gatewaySetupTester"]) is a fixed 2-arg shape shared by every
// test override, so the request-scoped correlation id is closed over here rather than added as a
// 3rd seam parameter — the override contract stays untouched while the real tester still stamps
// GatewayCallRequest.logContext (ADR-0173 D5).
function gatewaySetupTester(
  deps: UiHandlerDeps,
  correlationId: string | undefined,
): GatewaySetupTester {
  const override = deps.gatewaySetupTester;
  if (override !== undefined) return override;
  return (config, candidateModelIds) =>
    defaultGatewaySetupTester(config, candidateModelIds, correlationId, deps);
}

const FIGMA_ME_ENDPOINT = "https://api.figma.com/v1/me";

function figmaReason(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const reason = body.err ?? body.message;
  return typeof reason === "string" ? reason : undefined;
}

async function defaultFigmaCredentialTester(
  accessToken: string,
  egress?: GatewayEgressConfig,
): Promise<void> {
  try {
    const response = await gatewayFetch(FIGMA_ME_ENDPOINT, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Figma-Token": accessToken,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(FIGMA_CREDENTIAL_SMOKE_TIMEOUT_MS),
      ...(egress !== undefined ? { egress } : {}),
    });
    let body: unknown;
    try {
      body = await readJsonCapped(response, FIGMA_CREDENTIAL_SMOKE_RESPONSE_BYTES);
    } catch {
      throw new FigmaConnectorError("FIGMA_RESPONSE_TOO_LARGE");
    }
    if (!response.ok) {
      throw classifyTokenFailure(response.status, figmaReason(body));
    }
    if (!isRecord(body)) {
      throw new FigmaConnectorError("FIGMA_INTERNAL");
    }
  } catch (error) {
    if (error instanceof FigmaConnectorError) {
      throw error;
    }
    throw new FigmaConnectorError(classifyFigmaTransportError(error));
  }
}

// Seals the verified raw config's secrets into their local vaults and writes a credential-free
// keiko.config.json (Issue #1320). `deps.evidenceDir` is the resolved evidence root used by the
// encrypted Figma PAT vault; it is resolved defensively so persistence never depends on the optional
// field being pre-populated.
//
// PR-review follow-up (Codex thread 3772192295): stamp `schemaVersion:
// GATEWAY_CONFIG_SCHEMA_VERSION` on every write so the pre-KEIKO-0520 legacy-migration guard
// (config.ts:migrateLegacyChatContextWindows) can distinguish a legacy pre-migration file
// from a modern hand-edited/corrupted one. A modern file that carries schemaVersion >= 2
// with contextWindow: 0 now fails strict parsing instead of being silently rewritten to a
// 4096-token default.
function persistGatewayConfig(
  raw: Record<string, unknown>,
  storagePath: string,
  deps: UiHandlerDeps,
): void {
  persistSealedGatewayConfig(
    { ...raw, schemaVersion: GATEWAY_CONFIG_SCHEMA_VERSION },
    {
      env: deps.env,
      storagePath,
      evidenceDir: resolveEvidenceDir(deps.evidenceDir, deps.env),
      securityLogSink: processServerLogSink(),
    },
  );
}

interface SetupRequest {
  readonly correlationId: string | undefined;
  readonly preserveExisting: boolean;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly apiKeyHeaderName: string;
  /** Generic endpoint protocol — see {@link SetupGatewayCredentials} (#3042). */
  readonly endpointStyle: string | undefined;
  readonly apiVersion: string | undefined;
  readonly timeoutMs: number | undefined;
  readonly deploymentNames: readonly string[];
  readonly imageInputModelIds: readonly string[];
  /** True when the request stated the list explicitly — discovery must not re-add models then. */
  readonly imageInputModelIdsProvided: boolean;
  /**
   * Model ids whose stored capability kind is `embedding` — authoritative over the name
   * heuristic when a preserve-mode rebuild re-verifies inherited or resubmitted deployments
   * (review finding on #3031: a misclassified stored embedding fails the chat probe and
   * silently vanishes). Empty outside preserve mode.
   */
  readonly storedEmbeddingModelIds: readonly string[];
  /** Client-asserted embedding ids (validated against the deployment set) — same authority. */
  readonly submittedEmbeddingModelIds: readonly string[];
  /**
   * The DURABLE stored view for restore classification — the persisted file with per-model env
   * overrides masked (see {@link durableStoredGatewayConfig}); undefined on a fresh setup.
   */
  readonly stored: GatewayConfig | undefined;
  /**
   * Model ids whose stored capability kind is `ocr-vision` — the rebuild neither chat-probes
   * nor re-derives them; the stored providers are restored verbatim, exactly like voice
   * (review finding on #3031: the same silent-loss class as embeddings, fixed for every stored
   * non-chat kind). Empty outside preserve mode.
   */
  readonly storedOcrModelIds: readonly string[];
  /**
   * Stored embedding ids whose FULL connection identity differs from the stored primary
   * provider's — rebuilt embeddings land on the setup-wide connection, so these are restored
   * verbatim instead (review findings on #3031). Empty outside inherited-deployment preserve
   * mode.
   */
  readonly storedDedicatedEmbeddingModelIds: readonly string[];
  /** Stored voice ids excluded from the chat probe — restored by applyVoiceProviders. */
  readonly storedVoiceModelIds: readonly string[];
  readonly workflowEligibleModelIds: readonly string[];
  readonly workflowEligibleModelIdsConfigured: boolean;
  readonly voiceProviders: readonly SetupVoiceProvider[];
  readonly figmaAccessToken: string | undefined;
  readonly verifyGateway: boolean;
  readonly verifyFigmaCredential: boolean;
}

interface SetupModelLists {
  readonly deploymentNames: readonly string[];
  /** `undefined` = the field was absent; an explicit empty list clears the image-capable set. */
  readonly imageInputModelIds: readonly string[] | undefined;
  /** Client-asserted embedding kinds — see parseEmbeddingModelIds. */
  readonly embeddingModelIds: readonly string[] | undefined;
  readonly workflowEligibleModelIds: readonly string[];
}

interface SetupGatewayCredentials {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly apiKeyHeaderName: string;
  /**
   * The generic endpoint PROTOCOL of the setup-wide connection (#3042): submitted values win
   * (an uploaded LiteLLM config declares openai-compatible explicitly and a server-side
   * KEIKO_DEFAULT_ENDPOINT_STYLE must not override the file's statement after save); absent
   * values inherit from the stored primary only while the connection stays on the same
   * endpoint, so a persisted style survives a credential rotation but never travels to a moved
   * endpoint it was not declared for. The style/apiVersion pairing is enforced by the canonical
   * parser on the validation and candidate configs downstream.
   */
  readonly endpointStyle: string | undefined;
  readonly apiVersion: string | undefined;
}

interface SetupVoiceProvider {
  readonly modelId: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly apiKeyHeaderName: string;
  readonly timeoutMs: number | undefined;
  readonly maxRetries: number;
  readonly retryBaseDelayMs: number;
  readonly endpointStyle?: ModelProviderConfig["endpointStyle"];
  readonly apiVersion?: string | undefined;
  readonly realtimeAuthMode?: ModelProviderConfig["realtimeAuthMode"];
  readonly providerLocality: VoiceProviderLocality;
  readonly capabilities: SetupVoiceCapabilities;
  readonly rawCapability?: ModelCapability | undefined;
  readonly voiceProfiles?: readonly VoicePersonaVoice[] | undefined;
  // KEIKO-0167 (PR-review follow-up, Codex thread 3769711637): carry a per-provider
  // circuitBreaker override through the setup round-trip. Without this field
  // setupVoiceProviderFromCurrent / applyVoiceProviders / voiceProviderRaw silently drop
  // the persisted override on any unrelated voice/setup save.
  readonly circuitBreaker?: ModelProviderConfig["circuitBreaker"];
}

function normalizeSetupApiKeyHeaderName(value: unknown): SetupParseResult<string> {
  try {
    return acceptedSetupValue(
      normalizeApiKeyHeaderName(value, "apiKeyHeaderName", DEFAULT_API_KEY_HEADER_NAME),
    );
  } catch (error) {
    if (error instanceof ConfigInvalidError) {
      return rejectedSetupValue({
        status: 400,
        body: errorBody("BAD_REQUEST", error.message),
      });
    }
    throw error;
  }
}

function readSetupModelLists(raw: Record<string, unknown>): SetupModelLists | RouteResult {
  const deploymentNames = parseDeploymentNames(raw.deploymentNames);
  if (isRouteResult(deploymentNames)) {
    return deploymentNames;
  }
  const imageInputModelIds = parseImageInputModelIds(raw.imageInputModelIds);
  if (isRouteResult(imageInputModelIds)) {
    return imageInputModelIds;
  }
  const embeddingModelIds = parseEmbeddingModelIds(raw.embeddingModelIds);
  if (isRouteResult(embeddingModelIds)) {
    return embeddingModelIds;
  }
  const workflowEligibleModelIds = parseWorkflowEligibleModelIds(raw.workflowEligibleModelIds);
  if (isRouteResult(workflowEligibleModelIds)) {
    return workflowEligibleModelIds;
  }
  return { deploymentNames, imageInputModelIds, embeddingModelIds, workflowEligibleModelIds };
}

function optionalSetupSecret(value: unknown, path: string): SetupParseResult<string | undefined> {
  if (value === undefined) {
    return acceptedSetupValue(undefined);
  }
  if (typeof value !== "string") {
    return rejectedSetupValue({
      status: 400,
      body: errorBody("BAD_REQUEST", `${path} must be a string.`),
    });
  }
  const trimmed = value.trim();
  return acceptedSetupValue(trimmed.length === 0 ? undefined : trimmed);
}

function optionalSetupPositiveInt(
  value: unknown,
  path: string,
): SetupParseResult<number | undefined> {
  if (value === undefined) {
    return acceptedSetupValue(undefined);
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return rejectedSetupValue({
      status: 400,
      body: errorBody("BAD_REQUEST", `${path} must be a positive integer.`),
    });
  }
  return acceptedSetupValue(value);
}

function optionalSetupBoolean(value: unknown, path: string): SetupParseResult<boolean | undefined> {
  if (value === undefined) {
    return acceptedSetupValue(undefined);
  }
  if (typeof value !== "boolean") {
    return rejectedSetupValue({
      status: 400,
      body: errorBody("BAD_REQUEST", `${path} must be a boolean.`),
    });
  }
  return acceptedSetupValue(value);
}

function parseVoiceProviderLocality(
  value: unknown,
  fallback: VoiceProviderLocality,
): SetupParseResult<VoiceProviderLocality> {
  if (value === undefined) {
    return acceptedSetupValue(fallback);
  }
  if (
    typeof value !== "string" ||
    !VOICE_PROVIDER_LOCALITIES.includes(value as VoiceProviderLocality)
  ) {
    return rejectedSetupValue({
      status: 400,
      body: errorBody("BAD_REQUEST", "voiceProviderLocality is not supported."),
    });
  }
  return acceptedSetupValue(value as VoiceProviderLocality);
}

function hasNonBlankStringField(raw: Record<string, unknown>, key: string): boolean {
  const value = raw[key];
  return typeof value === "string" && value.trim().length > 0;
}

function hasNonEmptyListField(raw: Record<string, unknown>, key: string): boolean {
  const value = raw[key];
  if (typeof value === "string") {
    return normalizeDeploymentNames(deploymentNameValues(value) ?? []).length > 0;
  }
  return Array.isArray(value) && value.some((item) => typeof item === "string" && item.trim());
}

function hasListField(raw: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(raw, key);
}

const VOICE_PROVIDER_STRING_FIELDS = [
  "voiceBaseUrl",
  "voiceApiKey",
  "voiceApiKeyHeaderName",
  "voiceModelId",
  "voiceSpeechToTextModelId",
  "voiceRealtimeModelId",
  "voiceRealtimeTranscriptionModelId",
  "voiceSpeechOutputModelId",
  "voiceOutputVoiceId",
  "voiceProviderLocality",
  "voiceEndpointStyle",
  "voiceApiVersion",
  "voiceRealtimeAuthMode",
] as const;

const VOICE_CONNECTION_MUTATION_FIELDS = [
  "voiceBaseUrl",
  "voiceApiKey",
  "voiceApiKeyHeaderName",
  "voiceProviderLocality",
  // The endpoint PROTOCOL is part of the connection: submitted without a base URL or explicit
  // role targets it would spread onto every role template, writing e.g. an Azure deployment
  // protocol onto an OpenAI-compatible realtime endpoint (review finding on #3037).
  "voiceEndpointStyle",
  "voiceApiVersion",
  "voiceRealtimeAuthMode",
] as const;

// The endpoint-protocol wire values come from the contract seam — one compiler-checked source
// shared with the model gateway's parser and the UI upload parser (#3037 follow-up). One list
// for BOTH sections on purpose: an endpoint protocol is a property of the connection, not of
// voice. The former voice-prefixed name made a reviewer read the generic check added in #3046
// as a voice-only whitelist, so the shared names carry no section here.
const ENDPOINT_STYLE_VALUES = PROVIDER_ENDPOINT_STYLES;
const VOICE_REALTIME_AUTH_MODES = REALTIME_AUTH_MODES;

function parseEndpointEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): SetupParseResult<T | undefined> {
  if (value === undefined) {
    return acceptedSetupValue(undefined);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return acceptedSetupValue(undefined);
    if (allowed.includes(trimmed as T)) return acceptedSetupValue(trimmed as T);
  }
  return rejectedSetupValue({
    status: 400,
    body: errorBody("BAD_REQUEST", `${field} is not supported.`),
  });
}

// The submitted endpoint protocol wins over any inherited template: a caller that states how the
// endpoint speaks (e.g. an uploaded config with an Azure deployment-path voice endpoint) must not
// have that declaration silently replaced by a stored provider's shape — and a fresh setup has no
// template at all, so without these fields an Azure voice endpoint would be persisted as
// OpenAI-compatible and every audio call would take the wrong URL shape. The style/apiVersion
// pairing rule is enforced downstream by the parseGatewayConfig validation in
// validateVoiceProviderConnection, which fails the whole setup closed.
function submittedVoiceEndpointOptions(
  raw: Record<string, unknown>,
): SetupParseResult<VoiceProviderEndpointOptions | undefined> {
  const endpointStyle = parseEndpointEnum(
    raw.voiceEndpointStyle,
    "voiceEndpointStyle",
    ENDPOINT_STYLE_VALUES,
  );
  if (!endpointStyle.ok) return endpointStyle;
  const realtimeAuthMode = parseEndpointEnum(
    raw.voiceRealtimeAuthMode,
    "voiceRealtimeAuthMode",
    VOICE_REALTIME_AUTH_MODES,
  );
  if (!realtimeAuthMode.ok) return realtimeAuthMode;
  const apiVersion = optionalSetupSecret(raw.voiceApiVersion, "voiceApiVersion");
  if (!apiVersion.ok) return apiVersion;
  if (
    endpointStyle.value === undefined &&
    apiVersion.value === undefined &&
    realtimeAuthMode.value === undefined
  ) {
    return acceptedSetupValue(undefined);
  }
  return acceptedSetupValue({
    ...(endpointStyle.value === undefined ? {} : { endpointStyle: endpointStyle.value }),
    ...(apiVersion.value === undefined ? {} : { apiVersion: apiVersion.value }),
    ...(realtimeAuthMode.value === undefined ? {} : { realtimeAuthMode: realtimeAuthMode.value }),
  });
}

function hasVoiceProviderInput(raw: Record<string, unknown>): boolean {
  return (
    VOICE_PROVIDER_STRING_FIELDS.some((key) => hasNonBlankStringField(raw, key)) ||
    raw.voiceTimeoutMs !== undefined ||
    raw.voiceSupportsSemanticTurnDetection !== undefined ||
    raw.voiceSupportsSpeechSynthesisInstructions !== undefined
  );
}

function hasVoiceConnectionMutation(raw: Record<string, unknown>): boolean {
  return VOICE_CONNECTION_MUTATION_FIELDS.some((key) => hasNonBlankStringField(raw, key));
}

function validateVoiceStringFieldTypes(
  raw: Record<string, unknown>,
  correlationId: string | undefined,
): RouteResult | undefined {
  for (const key of VOICE_PROVIDER_STRING_FIELDS) {
    if (raw[key] !== undefined && typeof raw[key] !== "string") {
      return {
        status: 400,
        body: errorBody("BAD_REQUEST", `${key} must be a string.`, correlationId),
      };
    }
  }
  return undefined;
}

function validateSpeechInputAliasConsistency(
  raw: Record<string, unknown>,
  correlationId: string | undefined,
): RouteResult | undefined {
  const legacy = trimmedSubmittedString(raw, "voiceModelId");
  const explicit = trimmedSubmittedString(raw, "voiceSpeechToTextModelId");
  if (legacy === undefined || explicit === undefined || legacy === explicit) return undefined;
  return {
    status: 400,
    body: errorBody(
      "BAD_REQUEST",
      "voiceModelId and voiceSpeechToTextModelId must identify the same deployment when both are provided.",
      correlationId,
    ),
  };
}

function validateVoiceInputFields(
  raw: Record<string, unknown>,
  correlationId: string | undefined,
): RouteResult | undefined {
  return (
    validateVoiceStringFieldTypes(raw, correlationId) ??
    validateSpeechInputAliasConsistency(raw, correlationId)
  );
}

function shouldPreserveExisting(
  raw: Record<string, unknown>,
  current: GatewayConfig | undefined,
): boolean {
  return raw.preserveExisting === true && current !== undefined;
}

function currentSpeechInputProvider(
  current: GatewayConfig | undefined,
): ModelProviderConfig | undefined {
  if (current === undefined) {
    return undefined;
  }
  const modelId = selectSpeechToTextModel(current);
  if (modelId === undefined) {
    return undefined;
  }
  return current.providers.find((provider) => provider.modelId === modelId);
}

function firstCurrentVoiceProvider(
  current: GatewayConfig | undefined,
): ModelProviderConfig | undefined {
  return setupVoiceProvidersFromCurrent(current)[0] === undefined
    ? undefined
    : current?.providers.find(
        (provider) => provider.modelId === setupVoiceProvidersFromCurrent(current)[0]?.modelId,
      );
}

function currentVoiceCapability(
  current: GatewayConfig | undefined,
  modelId: string | undefined,
): ModelCapability | undefined {
  if (current === undefined || modelId === undefined) {
    return undefined;
  }
  return current.capabilities?.find(
    (capability) => capability.id === modelId && isVoiceCapability(capability),
  );
}

function trimmedSubmittedString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function submittedOrInheritedString(
  raw: Record<string, unknown>,
  key: string,
  inherited: string | undefined,
  preserveExisting: boolean,
): string {
  return trimmedSubmittedString(raw, key) ?? (preserveExisting ? (inherited ?? "") : "");
}

function setupApiKeyHeaderSource(
  raw: Record<string, unknown>,
  provider: ModelProviderConfig | undefined,
  preserveExisting: boolean,
): unknown {
  if (raw.apiKeyHeaderName !== undefined || !preserveExisting) {
    return raw.apiKeyHeaderName;
  }
  return provider?.apiKeyHeaderName ?? DEFAULT_API_KEY_HEADER_NAME;
}

function setupVoiceApiKeyHeaderSource(
  raw: Record<string, unknown>,
  provider: ModelProviderConfig | undefined,
  preserveExisting: boolean,
): unknown {
  if (raw.voiceApiKeyHeaderName !== undefined || !preserveExisting) {
    return raw.voiceApiKeyHeaderName;
  }
  return provider?.apiKeyHeaderName ?? DEFAULT_API_KEY_HEADER_NAME;
}

/**
 * A changed endpoint never inherits the stored secret: in update mode a submitted base URL that
 * differs from the stored one, with no fresh token beside it, would send the STORED token to the
 * NEW endpoint during verification — so a supplied configuration file (or a typo'd URL) could
 * exfiltrate it (review finding on #3031). Server-side so no client path can bypass it.
 */
function inheritedTokenForChangedEndpoint(
  raw: Record<string, unknown>,
  submittedKeys: { readonly baseUrl: string; readonly apiKey: string },
  storedBaseUrl: string | undefined,
  preserveExisting: boolean,
): boolean {
  const submittedBaseUrl = trimmedSubmittedString(raw, submittedKeys.baseUrl);
  return (
    preserveExisting &&
    submittedBaseUrl !== undefined &&
    storedBaseUrl !== undefined &&
    !sameBaseUrlIdentity(submittedBaseUrl, storedBaseUrl) &&
    trimmedSubmittedString(raw, submittedKeys.apiKey) === undefined
  );
}

function changedEndpointRequiresTokenError(): RouteResult {
  return {
    status: 400,
    body: errorBody(
      "GATEWAY_URL_CHANGE_REQUIRES_TOKEN",
      "A changed gateway URL requires a fresh API token.",
    ),
  };
}

function readSetupGatewayCredentials(
  raw: Record<string, unknown>,
  env: EnvSource,
  current: GatewayConfig | undefined,
  stored: GatewayConfig | undefined,
  preserveExisting: boolean,
): SetupGatewayCredentials | RouteResult {
  // The MAIN gateway connection, not position zero: array order is not a contract, and a valid
  // stored file may list a dedicated voice provider first. Reading the connection — URL, token,
  // header and endpoint protocol — off that provider inherited the voice endpoint's values for
  // the generic gateway; for the protocol it dropped a stored Azure declaration on an otherwise
  // unchanged rotation (review finding on #3046). Same selection the sharing classification
  // already uses (#3037).
  const provider = storedPrimaryGatewayProvider(current);
  if (
    inheritedTokenForChangedEndpoint(
      raw,
      { baseUrl: "baseUrl", apiKey: "apiKey" },
      provider?.baseUrl,
      preserveExisting,
    )
  ) {
    return changedEndpointRequiresTokenError();
  }
  const baseUrl = submittedOrInheritedString(raw, "baseUrl", provider?.baseUrl, preserveExisting);
  const apiKey = submittedOrInheritedString(raw, "apiKey", provider?.apiKey, preserveExisting);
  if (baseUrl.length === 0 || apiKey.length === 0) {
    return { status: 400, body: errorBody("BAD_REQUEST", "baseUrl and apiKey are required.") };
  }
  const apiKeyHeaderSource = setupApiKeyHeaderSource(raw, provider, preserveExisting);
  const apiKeyHeaderResult = normalizeSetupApiKeyHeaderName(apiKeyHeaderSource);
  if (!apiKeyHeaderResult.ok) {
    return apiKeyHeaderResult.routeError;
  }
  const apiKeyHeaderName = apiKeyHeaderResult.value;
  const protocol = durableSetupEndpointProtocol(
    raw,
    { stored, current },
    baseUrl,
    preserveExisting,
  );
  if ("status" in protocol) {
    return protocol;
  }
  // The probe carries the protocol the setup will actually persist. Validating a protocol-free
  // provider let the environment fill the gap: on a server that sets only
  // KEIKO_DEFAULT_ENDPOINT_STYLE, every probe became an Azure provider with no api version and
  // the canonical pairing rejected EVERY setup request, whatever the operator submitted
  // (found while pinning the env-completed tuple, review findings on #3046).
  const invalidConnection = validateSetupConnection(
    baseUrl,
    apiKey,
    apiKeyHeaderName,
    env,
    protocol,
  );
  if (invalidConnection !== undefined) {
    return invalidConnection;
  }
  return { baseUrl, apiKey, apiKeyHeaderName, ...protocol };
}

// Inheritance reads the DURABLE file, not the env-resolved view: a protocol that only exists
// because KEIKO_DEFAULT_* or a KEIKO_MODEL_* override is set was never declared in the file, and
// a rotation that inherited it would seal the transient value in — removing the override
// afterwards would no longer restore the file's own behavior (review finding on #3046, the same
// disk-vs-runtime rule the sharing classification draws). The connection fields stay on the
// runtime view: they are what the smoke test actually verifies.
function durableSetupEndpointProtocol(
  raw: Record<string, unknown>,
  views: {
    readonly stored: GatewayConfig | undefined;
    readonly current: GatewayConfig | undefined;
  },
  baseUrl: string,
  preserveExisting: boolean,
): Pick<SetupGatewayCredentials, "endpointStyle" | "apiVersion"> | RouteResult {
  const durable = views.stored ?? views.current;
  return setupEndpointProtocol(
    raw,
    storedPrimaryGatewayProvider(durable),
    baseUrl,
    preserveExisting,
  );
}

// See SetupGatewayCredentials: submitted protocol wins, absent inherits from the stored primary
// only on the SAME endpoint (a persisted style survives rotations, never travels to a moved
// endpoint), and everything else stays undefined so the runtime default layering is unchanged.
function setupEndpointProtocol(
  raw: Record<string, unknown>,
  provider: ModelProviderConfig | undefined,
  baseUrl: string,
  preserveExisting: boolean,
): Pick<SetupGatewayCredentials, "endpointStyle" | "apiVersion"> | RouteResult {
  const endpointStyle = parseEndpointEnum(
    raw.endpointStyle,
    "endpointStyle",
    ENDPOINT_STYLE_VALUES,
  );
  if (!endpointStyle.ok) return endpointStyle.routeError;
  const apiVersion = optionalSetupSecret(raw.apiVersion, "apiVersion");
  if (!apiVersion.ok) return apiVersion.routeError;
  // The submitted protocol is ATOMIC: stating a style replaces the whole protocol, so an
  // inherited api version can never pair with it — switching an Azure provider to
  // openai-compatible on the same URL would otherwise build a mixed protocol the canonical
  // parser refuses, failing the save instead of performing it (review finding on #3046).
  if (endpointStyle.value !== undefined) {
    return pairedEndpointProtocol(endpointStyle.value, apiVersion.value);
  }
  const inheritable =
    preserveExisting && provider !== undefined && sameBaseUrlIdentity(baseUrl, provider.baseUrl);
  return pairedEndpointProtocol(
    inheritable ? provider.endpointStyle : undefined,
    apiVersion.value ?? (inheritable ? provider.apiVersion : undefined),
  );
}

// The canonical pairing, checked on the EFFECTIVE protocol rather than on the submitted fields:
// an api version belongs to the Azure deployment path alone. Without this the config parser threw
// during verification and the operator got an opaque 502 "credentials could not be verified" for
// what is a request problem — a submitted version with no style at all, or a submitted version
// over an inherited openai-compatible style (review finding on #3046). Bumping the version of an
// endpoint whose stored style IS the deployment path stays legal: that is the same pair.
// The canonical api-version shape, mirroring the model gateway's own parser (ADR-0019 keeps the
// two packages apart, so the rule is mirrored and pinned on both sides rather than imported).
const SETUP_API_VERSION_RE = /^\d{4}-\d{2}-\d{2}(?:-preview)?$/u;

function pairedEndpointProtocol(
  endpointStyle: string | undefined,
  apiVersion: string | undefined,
): Pick<SetupGatewayCredentials, "endpointStyle" | "apiVersion"> | RouteResult {
  if (apiVersion !== undefined && endpointStyle !== "azure-openai-deployment") {
    return {
      status: 400,
      body: errorBody(
        "GATEWAY_API_VERSION_REQUIRES_AZURE_ENDPOINT",
        'apiVersion requires endpointStyle to be "azure-openai-deployment".',
      ),
    };
  }
  // The canonical SHAPE, checked here for the same reason as the pairing: a malformed version
  // threw inside the candidate loop and surfaced as an opaque 502 for what is a malformed
  // request (review finding on #3046).
  if (apiVersion !== undefined && !SETUP_API_VERSION_RE.test(apiVersion)) {
    return {
      status: 400,
      body: errorBody(
        "GATEWAY_API_VERSION_INVALID",
        "apiVersion must be YYYY-MM-DD or YYYY-MM-DD-preview.",
      ),
    };
  }
  // The other direction of the same canonical rule: the deployment path cannot be requested
  // without the version that builds its URL. Left unnamed it threw inside the candidate loop and
  // surfaced as the same misleading 502 (review finding on #3046).
  if (endpointStyle === "azure-openai-deployment" && apiVersion === undefined) {
    return {
      status: 400,
      body: errorBody(
        "GATEWAY_AZURE_ENDPOINT_REQUIRES_API_VERSION",
        'endpointStyle "azure-openai-deployment" requires an apiVersion.',
      ),
    };
  }
  return { endpointStyle, apiVersion };
}

function validateVoiceProviderConnection(
  provider: SetupVoiceProvider,
  env: EnvSource,
): RouteResult | undefined {
  const linkLocalError = validateLinkLocalGatewayBaseUrl(provider.baseUrl, env);
  if (linkLocalError !== undefined) return linkLocalError;
  try {
    parseGatewayConfig(
      {
        providers: [
          voiceProviderRaw(provider.modelId, provider.baseUrl, provider.apiKey, {
            apiKeyHeaderName: provider.apiKeyHeaderName,
            timeoutMs: provider.timeoutMs,
            maxRetries: provider.maxRetries,
            retryBaseDelayMs: provider.retryBaseDelayMs,
            endpointStyle: provider.endpointStyle,
            apiVersion: provider.apiVersion,
            realtimeAuthMode: provider.realtimeAuthMode,
            providerLocality: provider.providerLocality,
            capabilities: provider.capabilities,
            rawCapability: provider.rawCapability,
            ...(provider.voiceProfiles === undefined
              ? {}
              : { voiceProfiles: provider.voiceProfiles }),
            ...(provider.circuitBreaker === undefined
              ? {}
              : { circuitBreaker: provider.circuitBreaker }),
          }),
        ],
        circuitBreaker: DEFAULT_CIRCUIT_BREAKER_CONFIG,
      },
      env,
      linkLocalGatewayOverrideOptions(env),
    );
    return undefined;
  } catch (error) {
    if (error instanceof ConfigInvalidError) {
      return { status: 400, body: errorBody("BAD_REQUEST", error.message) };
    }
    throw error;
  }
}

function submittedVoiceModelId(
  raw: Record<string, unknown>,
  key: string,
  fallback?: string,
): SetupParseResult<string | undefined> {
  const modelId = trimmedSubmittedString(raw, key) ?? fallback;
  if (modelId === undefined) return acceptedSetupValue(undefined);
  if (!isUsableModelId(modelId)) {
    return rejectedSetupValue({
      status: 400,
      body: errorBody("BAD_REQUEST", `${key} is invalid.`),
    });
  }
  return acceptedSetupValue(modelId);
}

function setupVoiceConnection(
  raw: Record<string, unknown>,
  existing: ModelProviderConfig | undefined,
  preserveExisting: boolean,
): { readonly baseUrl: string; readonly apiKey: string } | RouteResult {
  const baseUrl = submittedOrInheritedString(
    raw,
    "voiceBaseUrl",
    existing?.baseUrl,
    preserveExisting,
  );
  const apiKey = submittedOrInheritedString(raw, "voiceApiKey", existing?.apiKey, preserveExisting);
  if (baseUrl.length === 0 || apiKey.length === 0) {
    return {
      status: 400,
      body: errorBody(
        "BAD_REQUEST",
        "Audio endpoint URL and credential are required when an audio model is selected.",
      ),
    };
  }
  return { baseUrl, apiKey };
}

function setupVoiceApiKeyHeaderName(
  raw: Record<string, unknown>,
  existing: ModelProviderConfig | undefined,
  preserveExisting: boolean,
): SetupParseResult<string> {
  return normalizeSetupApiKeyHeaderName(
    setupVoiceApiKeyHeaderSource(raw, existing, preserveExisting),
  );
}

function setupVoiceProviderLocality(
  raw: Record<string, unknown>,
  existingCapability: ModelCapability | undefined,
): SetupParseResult<VoiceProviderLocality> {
  return parseVoiceProviderLocality(
    raw.voiceProviderLocality,
    existingCapability?.voiceProviderLocality ?? "azure-foundry",
  );
}

function firstRouteResult(values: readonly unknown[]): RouteResult | undefined {
  return values.find(isRouteResult);
}

interface VoiceRoleModelIds {
  readonly speechInput?: string | undefined;
  readonly speechOutput?: string | undefined;
  readonly realtime?: string | undefined;
  readonly realtimeTranscription?: string | undefined;
}

type VoiceDeploymentRole = "speechInput" | "speechOutput" | "realtime";

interface ExplicitVoiceRoleTarget {
  readonly modelId: string;
  readonly role: VoiceDeploymentRole;
  readonly template: SetupVoiceProvider | undefined;
}

function existingVoiceRoleModelIds(current: GatewayConfig | undefined): VoiceRoleModelIds {
  if (current === undefined) return {};
  const realtime = selectRealtimeVoiceModel(current);
  const realtimeCapability = current.capabilities?.find((capability) => capability.id === realtime);
  return {
    speechInput: selectSpeechToTextModel(current),
    speechOutput: selectSpeechOutputModel(current),
    realtime,
    realtimeTranscription: realtimeCapability?.realtimeTranscriptionModel,
  };
}

function submittedVoiceRoleTargets(
  raw: Record<string, unknown>,
  current: GatewayConfig | undefined,
): readonly ExplicitVoiceRoleTarget[] {
  const existing = setupVoiceProvidersFromCurrent(current);
  const submitted: readonly (readonly [VoiceDeploymentRole, string | undefined])[] = [
    [
      "speechInput",
      trimmedSubmittedString(raw, "voiceSpeechToTextModelId") ??
        trimmedSubmittedString(raw, "voiceModelId"),
    ],
    ["speechOutput", trimmedSubmittedString(raw, "voiceSpeechOutputModelId")],
    ["realtime", trimmedSubmittedString(raw, "voiceRealtimeModelId")],
  ];
  return submitted.flatMap(([role, modelId]) => {
    if (modelId === undefined) return [];
    const capabilities = voiceRoleCapability(role);
    return [{ role, modelId, template: voiceProviderTemplate(modelId, capabilities, existing) }];
  });
}

function voiceRoleCapability(role: VoiceDeploymentRole): SetupVoiceCapabilities {
  return {
    speechInput: role === "speechInput",
    speechOutput: role === "speechOutput",
    realtime: role === "realtime",
  };
}

function selectedVoiceProviders(current: GatewayConfig | undefined): readonly SetupVoiceProvider[] {
  const roleIds = existingVoiceRoleModelIds(current);
  const selectedIds = new Set(
    [roleIds.speechInput, roleIds.speechOutput, roleIds.realtime].filter(
      (modelId): modelId is string => modelId !== undefined,
    ),
  );
  return setupVoiceProvidersFromCurrent(current).filter((provider) =>
    selectedIds.has(provider.modelId),
  );
}

function endpointMatchesEverySelectedProvider(
  submittedBaseUrl: string,
  current: GatewayConfig | undefined,
): boolean {
  const selected = selectedVoiceProviders(current);
  return (
    selected.length > 0 &&
    selected.every((provider) => sameBaseUrlIdentity(provider.baseUrl, submittedBaseUrl))
  );
}

function endpointMigrationTargets(
  submittedBaseUrl: string,
  targets: readonly ExplicitVoiceRoleTarget[],
): readonly ExplicitVoiceRoleTarget[] {
  return targets.filter(
    (target) =>
      target.template === undefined ||
      !sameBaseUrlIdentity(target.template.baseUrl, submittedBaseUrl),
  );
}

function leavesImplicitRoleOnMigratedProvider(
  target: ExplicitVoiceRoleTarget,
  replacements: ExplicitVoiceRoleReplacements,
): boolean {
  const existing = target.template;
  if (existing?.modelId !== target.modelId) return false;
  return (
    (existing.capabilities.speechInput && !replacements.speechInput) ||
    (existing.capabilities.speechOutput && !replacements.speechOutput) ||
    (existing.capabilities.realtime && !replacements.realtime)
  );
}

function endpointMigrationError(message: string, correlationId: string | undefined): RouteResult {
  return { status: 400, body: errorBody("BAD_REQUEST", message, correlationId) };
}

// A stored protocol may not be inherited across a base-URL change (it was declared for the old
// host), and dropping it silently degrades an Azure deployment-path endpoint to the
// OpenAI-compatible URL shape — a save that succeeds and breaks every audio call. The migration
// must RESTATE the protocol, exactly as it restates the credential, the locality and the roles
// (review finding on #3042). The realtime auth mode is stored protocol too and is NOT implied by
// the style: a provider can declare ephemeral-session with no style at all, and losing it sends
// Digital Voice down the plain API-key path instead of ephemeral-token negotiation (review
// finding on #3048).
function unrestatedMigrationProtocolError(
  raw: Record<string, unknown>,
  migrations: readonly ExplicitVoiceRoleTarget[],
  correlationId: string | undefined,
): RouteResult | undefined {
  const restatements = [
    {
      declared: (target: ExplicitVoiceRoleTarget): boolean =>
        target.template?.endpointStyle !== undefined,
      field: "voiceEndpointStyle",
      message: "Replacing an audio endpoint requires an explicit endpoint style for the new host.",
    },
    {
      // Only when a REALTIME role is actually moving: a stored provider that combines Realtime
      // with speech output declares the mode, but moving the speech-output role alone leaves
      // Realtime where it is, and demanding a restatement there refuses a move the mode has
      // nothing to do with (review finding on #3048).
      declared: (target: ExplicitVoiceRoleTarget): boolean =>
        target.role === "realtime" && target.template?.realtimeAuthMode !== undefined,
      field: "voiceRealtimeAuthMode",
      message:
        "Replacing an audio endpoint requires an explicit realtime auth mode for the new host.",
    },
  ];
  const missing = restatements.find(
    (rule) => migrations.some(rule.declared) && !hasNonBlankStringField(raw, rule.field),
  );
  return missing === undefined ? undefined : endpointMigrationError(missing.message, correlationId);
}

function explicitEndpointMigrationError(
  raw: Record<string, unknown>,
  migrations: readonly ExplicitVoiceRoleTarget[],
  correlationId: string | undefined,
): RouteResult | undefined {
  if (!hasNonBlankStringField(raw, "voiceApiKey")) {
    return endpointMigrationError(
      "Replacing an audio endpoint requires a fresh audio credential.",
      correlationId,
    );
  }
  if (!hasNonBlankStringField(raw, "voiceProviderLocality")) {
    return endpointMigrationError(
      "Replacing an audio endpoint requires an explicit provider locality.",
      correlationId,
    );
  }
  const unrestatedProtocol = unrestatedMigrationProtocolError(raw, migrations, correlationId);
  if (unrestatedProtocol !== undefined) return unrestatedProtocol;
  const replacements = explicitVoiceRoleReplacements(raw);
  if (migrations.some((target) => leavesImplicitRoleOnMigratedProvider(target, replacements))) {
    return endpointMigrationError(
      "Every role on a multi-role audio deployment must be explicitly resubmitted when its endpoint changes.",
      correlationId,
    );
  }
  if (
    migrations.some((target) => target.role === "speechOutput") &&
    !hasNonBlankStringField(raw, "voiceOutputVoiceId")
  ) {
    return endpointMigrationError(
      "Replacing a speech-output endpoint requires an explicit provider voice ID.",
      correlationId,
    );
  }
  return undefined;
}

// Every connection mutation except a plain base-URL move (which validateVoiceEndpointUpdate
// owns): credentials, header, locality, AND the endpoint protocol — an unscoped protocol change
// across heterogeneous connections must refuse exactly like an unscoped credential rotation
// (review finding on #3037).
function hasNonEndpointVoiceConnectionMutation(raw: Record<string, unknown>): boolean {
  return VOICE_CONNECTION_MUTATION_FIELDS.filter((key) => key !== "voiceBaseUrl").some((key) =>
    hasNonBlankStringField(raw, key),
  );
}

function sameVoiceConnection(left: SetupVoiceProvider, right: SetupVoiceProvider): boolean {
  return (
    sameBaseUrlIdentity(left.baseUrl, right.baseUrl) &&
    left.apiKey === right.apiKey &&
    left.apiKeyHeaderName === right.apiKeyHeaderName &&
    left.providerLocality === right.providerLocality &&
    left.endpointStyle === right.endpointStyle &&
    left.apiVersion === right.apiVersion &&
    left.realtimeAuthMode === right.realtimeAuthMode
  );
}

function selectedVoiceConnectionsAreHomogeneous(current: GatewayConfig | undefined): boolean {
  const [first, ...rest] = selectedVoiceProviders(current);
  return first === undefined || rest.every((provider) => sameVoiceConnection(provider, first));
}

function validateVoiceConnectionUpdate(
  raw: Record<string, unknown>,
  current: GatewayConfig | undefined,
  preserveExisting: boolean,
  correlationId: string | undefined,
): RouteResult | undefined {
  if (!preserveExisting || !hasVoiceConnectionMutation(raw)) return undefined;
  if (selectedVoiceProviders(current).length === 0) return undefined;
  const targets = submittedVoiceRoleTargets(raw, current);
  if (targets.length === 0) {
    if (!hasNonEndpointVoiceConnectionMutation(raw)) return undefined;
    if (selectedVoiceConnectionsAreHomogeneous(current)) return undefined;
    return endpointMigrationError(
      "Updating different audio connections requires explicit deployment roles.",
      correlationId,
    );
  }
  const replacements = explicitVoiceRoleReplacements(raw);
  if (targets.some((target) => leavesImplicitRoleOnMigratedProvider(target, replacements))) {
    return endpointMigrationError(
      "Every role on a multi-role audio deployment must be explicitly resubmitted when its connection changes.",
      correlationId,
    );
  }
  return undefined;
}

function validateVoiceEndpointUpdate(
  raw: Record<string, unknown>,
  current: GatewayConfig | undefined,
  preserveExisting: boolean,
  correlationId: string | undefined,
): RouteResult | undefined {
  const submittedBaseUrl = trimmedSubmittedString(raw, "voiceBaseUrl");
  if (!preserveExisting || submittedBaseUrl === undefined) return undefined;
  if (selectedVoiceProviders(current).length === 0) return undefined;
  const targets = submittedVoiceRoleTargets(raw, current);
  if (targets.length === 0) {
    if (endpointMatchesEverySelectedProvider(submittedBaseUrl, current)) return undefined;
    return endpointMigrationError(
      "Replacing an audio endpoint requires explicit deployment roles for that endpoint.",
      correlationId,
    );
  }
  const migrations = endpointMigrationTargets(submittedBaseUrl, targets);
  if (migrations.length === 0) return undefined;
  return explicitEndpointMigrationError(raw, migrations, correlationId);
}

function hasExplicitVoiceRoleReplacement(replacements: ExplicitVoiceRoleReplacements): boolean {
  return replacements.speechInput || replacements.speechOutput || replacements.realtime;
}

function scopedVoiceRoleFallback(
  existing: string | undefined,
  scopedConnectionUpdate: boolean,
  explicitlyReplaced: boolean,
): string | undefined {
  return scopedConnectionUpdate && !explicitlyReplaced ? undefined : existing;
}

function retainedRealtimeTranscription(
  existing: string | undefined,
  realtime: string | undefined,
  providerIdentityChanged: boolean,
): string | undefined {
  return realtime === undefined || providerIdentityChanged ? undefined : existing;
}

function voiceRoleFallbacks(
  raw: Record<string, unknown>,
  current: GatewayConfig | undefined,
): VoiceRoleModelIds {
  const existing = existingVoiceRoleModelIds(current);
  const replacements = explicitVoiceRoleReplacements(raw);
  const scopedConnectionUpdate =
    hasVoiceConnectionMutation(raw) && hasExplicitVoiceRoleReplacement(replacements);
  const realtime = scopedVoiceRoleFallback(
    existing.realtime,
    scopedConnectionUpdate,
    replacements.realtime,
  );
  return {
    speechInput: scopedVoiceRoleFallback(
      existing.speechInput,
      scopedConnectionUpdate,
      replacements.speechInput,
    ),
    speechOutput: scopedVoiceRoleFallback(
      existing.speechOutput,
      scopedConnectionUpdate,
      replacements.speechOutput,
    ),
    realtime,
    // The live-transcription deployment is a capability of the selected Realtime endpoint. Keep
    // it for unrelated updates, but never assume the old alias is accepted by a replacement.
    realtimeTranscription: retainedRealtimeTranscription(
      existing.realtimeTranscription,
      realtime,
      realtimeProviderIdentityChanged(raw, current),
    ),
  };
}

function voiceRoleModelIds(
  raw: Record<string, unknown>,
  current: GatewayConfig | undefined,
  preserveExisting: boolean,
  correlationId: string | undefined,
): VoiceRoleModelIds | RouteResult {
  const existing = preserveExisting ? setupVoiceProvidersFromCurrent(current) : [];
  const fallbacks = voiceRoleFallbacks(raw, current);
  const speechInput = submittedVoiceModelId(
    raw,
    "voiceSpeechToTextModelId",
    trimmedSubmittedString(raw, "voiceModelId") ?? fallbacks.speechInput,
  );
  const speechOutput = submittedVoiceModelId(
    raw,
    "voiceSpeechOutputModelId",
    fallbacks.speechOutput,
  );
  const realtime = submittedVoiceModelId(raw, "voiceRealtimeModelId", fallbacks.realtime);
  const realtimeTranscription = submittedVoiceModelId(
    raw,
    "voiceRealtimeTranscriptionModelId",
    fallbacks.realtimeTranscription,
  );
  if (!speechInput.ok) return speechInput.routeError;
  if (!speechOutput.ok) return speechOutput.routeError;
  if (!realtime.ok) return realtime.routeError;
  if (!realtimeTranscription.ok) return realtimeTranscription.routeError;
  const realtimeError = validateRealtimeRoleModelIds(
    raw,
    realtime.value,
    realtimeTranscription.value,
    correlationId,
  );
  if (realtimeError !== undefined) return realtimeError;
  const speechOutputError = validateSpeechOutputVoiceProfile(
    raw,
    speechOutput.value,
    existing,
    correlationId,
  );
  if (speechOutputError !== undefined) return speechOutputError;
  const roleIds = {
    speechInput: speechInput.value,
    speechOutput: speechOutput.value,
    realtime: realtime.value,
    realtimeTranscription: realtimeTranscription.value,
  };
  return validateExplicitVoiceRoles(raw, roleIds, correlationId) ?? roleIds;
}

function validateExplicitVoiceRoles(
  raw: Record<string, unknown>,
  roleIds: VoiceRoleModelIds,
  correlationId: string | undefined,
): RouteResult | undefined {
  if (
    roleIds.speechInput === undefined &&
    roleIds.speechOutput === undefined &&
    roleIds.realtime === undefined
  ) {
    return {
      status: 400,
      body: errorBody(
        "BAD_REQUEST",
        "At least one explicit voice deployment is required.",
        correlationId,
      ),
    };
  }
  if (raw.voiceSupportsSemanticTurnDetection === true && roleIds.realtime === undefined) {
    return {
      status: 400,
      body: errorBody(
        "BAD_REQUEST",
        "Semantic turn detection requires a Realtime voice deployment.",
        correlationId,
      ),
    };
  }
  // Same canonical relationship for the speech-output tier (review finding on #3037).
  if (raw.voiceSupportsSpeechSynthesisInstructions === true && roleIds.speechOutput === undefined) {
    return {
      status: 400,
      body: errorBody(
        "BAD_REQUEST",
        "Speech-synthesis instructions require a Speech output deployment.",
        correlationId,
      ),
    };
  }
  return undefined;
}

function validateRealtimeRoleModelIds(
  raw: Record<string, unknown>,
  realtime: string | undefined,
  realtimeTranscription: string | undefined,
  correlationId: string | undefined,
): RouteResult | undefined {
  if (hasNonBlankStringField(raw, "voiceRealtimeModelId") && realtimeTranscription === undefined) {
    return {
      status: 400,
      body: errorBody(
        "BAD_REQUEST",
        "voiceRealtimeTranscriptionModelId is required when voiceRealtimeModelId is configured or replaced.",
        correlationId,
      ),
    };
  }
  if (realtimeTranscription === undefined || realtime !== undefined) return undefined;
  return {
    status: 400,
    body: errorBody(
      "BAD_REQUEST",
      "voiceRealtimeTranscriptionModelId requires voiceRealtimeModelId.",
      correlationId,
    ),
  };
}

function validateSpeechOutputVoiceProfile(
  raw: Record<string, unknown>,
  speechOutput: string | undefined,
  existing: readonly SetupVoiceProvider[],
  correlationId: string | undefined,
): RouteResult | undefined {
  const submittedVoiceId = trimmedSubmittedString(raw, "voiceOutputVoiceId");
  if (submittedVoiceId !== undefined && speechOutput === undefined) {
    return {
      status: 400,
      body: errorBody(
        "BAD_REQUEST",
        "voiceOutputVoiceId requires a speech-output deployment.",
        correlationId,
      ),
    };
  }
  if (!hasNonBlankStringField(raw, "voiceSpeechOutputModelId")) return undefined;
  if (submittedVoiceId !== undefined) return undefined;
  const existingOutput = existing.find(
    (provider) => provider.modelId === speechOutput && provider.capabilities.speechOutput,
  );
  if ((existingOutput?.voiceProfiles?.length ?? 0) > 0) return undefined;
  return {
    status: 400,
    body: errorBody(
      "BAD_REQUEST",
      "voiceOutputVoiceId is required when a speech-output deployment is configured or replaced.",
      correlationId,
    ),
  };
}

function setupVoiceProfiles(
  raw: Record<string, unknown>,
  existing: SetupVoiceProvider | undefined,
): readonly VoicePersonaVoice[] | undefined {
  const submittedVoiceId = trimmedSubmittedString(raw, "voiceOutputVoiceId");
  if (submittedVoiceId !== undefined) {
    return [{ persona: "neutral", voiceId: submittedVoiceId }];
  }
  return existing?.voiceProfiles;
}

type SetupVoiceProviderDefaults = Omit<
  SetupVoiceProvider,
  "modelId" | "capabilities" | "rawCapability" | "voiceProfiles"
>;

interface VoiceProviderEndpointOptions {
  readonly endpointStyle?: ModelProviderConfig["endpointStyle"];
  readonly apiVersion?: string | undefined;
  readonly realtimeAuthMode?: ModelProviderConfig["realtimeAuthMode"];
}

function voiceProviderTemplate(
  modelId: string,
  capabilities: SetupVoiceCapabilities,
  existingProviders: readonly SetupVoiceProvider[],
): SetupVoiceProvider | undefined {
  const sameModel = existingProviders.find((provider) => provider.modelId === modelId);
  if (sameModel !== undefined) return sameModel;
  const configured = {
    providers: existingProviders,
    capabilities: existingProviders.flatMap((provider) =>
      provider.rawCapability === undefined ? [] : [provider.rawCapability],
    ),
  };
  if (capabilities.realtime) {
    const elected = selectRealtimeVoiceModel(configured);
    return (
      existingProviders.find((provider) => provider.modelId === elected) ??
      existingProviders.find((provider) => provider.capabilities.realtime)
    );
  }
  if (capabilities.speechOutput) {
    const elected = selectSpeechOutputModel(configured);
    return (
      existingProviders.find((provider) => provider.modelId === elected) ??
      existingProviders.find((provider) => provider.capabilities.speechOutput)
    );
  }
  const elected = selectSpeechToTextModel(configured);
  return (
    existingProviders.find((provider) => provider.modelId === elected) ??
    existingProviders.find((provider) => provider.capabilities.speechInput)
  );
}

function voiceProviderConnection(
  raw: Record<string, unknown>,
  defaults: SetupVoiceProviderDefaults,
  template: SetupVoiceProvider | undefined,
  submittedEndpoint: VoiceProviderEndpointOptions | undefined,
): SetupVoiceProviderDefaults {
  const baseUrl = submittedOrTemplateString(
    raw,
    "voiceBaseUrl",
    template?.baseUrl,
    defaults.baseUrl,
  );
  return {
    baseUrl,
    apiKey: submittedOrTemplateString(raw, "voiceApiKey", template?.apiKey, defaults.apiKey),
    apiKeyHeaderName: submittedOrTemplateValue(
      raw.voiceApiKeyHeaderName,
      template?.apiKeyHeaderName,
      defaults.apiKeyHeaderName,
    ),
    timeoutMs: submittedOrTemplateValue(
      raw.voiceTimeoutMs,
      template?.timeoutMs,
      defaults.timeoutMs,
    ),
    maxRetries: template?.maxRetries ?? defaults.maxRetries,
    retryBaseDelayMs: template?.retryBaseDelayMs ?? defaults.retryBaseDelayMs,
    ...voiceConnectionEndpointOptions(baseUrl, template, defaults, submittedEndpoint),
    providerLocality: submittedOrTemplateValue(
      raw.voiceProviderLocality,
      template?.providerLocality,
      defaults.providerLocality,
    ),
    // PR-review follow-up (Codex thread 3771542619): carry the per-provider circuitBreaker
    // through the rebuild too. Without this the fresh SetupVoiceProviderDefaults loses the
    // override, providerForVoiceRoles spreads a reduced object, and applyVoiceProviders
    // serializes no override — silently switching the provider back to the top-level
    // breaker policy on any unrelated voice/setup save.
    ...voiceConnectionCircuitBreakerFragment(template, defaults),
  };
}

function voiceConnectionCircuitBreakerFragment(
  template: SetupVoiceProvider | undefined,
  defaults: SetupVoiceProviderDefaults,
): Pick<SetupVoiceProvider, "circuitBreaker"> | Record<string, never> {
  const inherited = template?.circuitBreaker ?? defaults.circuitBreaker;
  return inherited === undefined ? {} : { circuitBreaker: inherited };
}

function voiceConnectionEndpointOptions(
  baseUrl: string,
  template: SetupVoiceProvider | undefined,
  defaults: SetupVoiceProviderDefaults,
  submitted: VoiceProviderEndpointOptions | undefined,
): VoiceProviderEndpointOptions {
  const inherited =
    template !== undefined && !sameBaseUrlIdentity(baseUrl, template.baseUrl)
      ? {}
      : voiceProviderTemplateEndpoint(template, defaults);
  // A submitted style that LEAVES the deployment path replaces the whole protocol: a spread merge
  // let a stored Azure api version survive a switch to openai-compatible, and the canonical
  // parser refuses that pair. Restating the SAME Azure style keeps the inherited version — it is
  // still the version that pair needs, and discarding it rejected the restatement for the
  // opposite reason (review findings on #3048).
  const base =
    submitted?.endpointStyle === undefined || submitted.endpointStyle === "azure-openai-deployment"
      ? inherited
      : withoutInheritedApiVersion(inherited);
  return { ...base, ...submitted };
}

function withoutInheritedApiVersion(
  options: VoiceProviderEndpointOptions,
): VoiceProviderEndpointOptions {
  return {
    ...(options.endpointStyle === undefined ? {} : { endpointStyle: options.endpointStyle }),
    ...(options.realtimeAuthMode === undefined
      ? {}
      : { realtimeAuthMode: options.realtimeAuthMode }),
  };
}

function submittedOrTemplateString(
  raw: Record<string, unknown>,
  key: string,
  template: string | undefined,
  fallback: string,
): string {
  return trimmedSubmittedString(raw, key) ?? template ?? fallback;
}

function submittedOrTemplateValue<T>(submitted: unknown, template: T | undefined, fallback: T): T {
  if (submitted !== undefined) return fallback;
  return template ?? fallback;
}

function voiceProviderTemplateEndpoint(
  template: VoiceProviderEndpointOptions | undefined,
  defaults: VoiceProviderEndpointOptions,
): VoiceProviderEndpointOptions {
  const endpoint = template ?? defaults;
  return {
    ...(endpoint.endpointStyle === undefined ? {} : { endpointStyle: endpoint.endpointStyle }),
    ...(endpoint.apiVersion === undefined ? {} : { apiVersion: endpoint.apiVersion }),
    ...(endpoint.realtimeAuthMode === undefined
      ? {}
      : { realtimeAuthMode: endpoint.realtimeAuthMode }),
  };
}

function configuredVoiceCapability(
  modelId: string,
  locality: VoiceProviderLocality,
  capabilities: SetupVoiceCapabilities,
  template: SetupVoiceProvider | undefined,
): ModelCapability | undefined {
  if (template?.rawCapability === undefined) return undefined;
  const capability = stripDerivedVoicePersonas(template.rawCapability);
  return {
    ...capability,
    id: modelId,
    streaming: capabilities.realtime || capability.streaming,
    supportsSpeechInput: undefined,
    supportsSpeechOutput: undefined,
    supportsSpeechSynthesisInstructions: undefined,
    supportsRealtimeVoice: undefined,
    supportsSemanticTurnDetection: undefined,
    realtimeTranscriptionModel: undefined,
    voiceProviderLocality: locality,
    ...configuredVoiceCapabilityFlags(capabilities, capability),
  };
}

function configuredVoiceCapabilityFlags(
  capabilities: SetupVoiceCapabilities,
  template: ModelCapability,
): Partial<ModelCapability> {
  return {
    ...(capabilities.speechInput ? { supportsSpeechInput: true } : {}),
    ...(capabilities.speechOutput ? { supportsSpeechOutput: true } : {}),
    ...(capabilities.speechOutput &&
    (capabilities.supportsSpeechSynthesisInstructions ??
      template.supportsSpeechSynthesisInstructions) === true
      ? { supportsSpeechSynthesisInstructions: true }
      : {}),
    ...(capabilities.realtime ? { supportsRealtimeVoice: true } : {}),
    ...semanticTurnDetectionCapability(capabilities),
    ...(capabilities.realtime && capabilities.realtimeTranscriptionModel !== undefined
      ? { realtimeTranscriptionModel: capabilities.realtimeTranscriptionModel }
      : {}),
  };
}

function voiceCapabilitiesByModel(
  roleIds: VoiceRoleModelIds,
): ReadonlyMap<string, SetupVoiceCapabilities> {
  const ids = new Map<string, SetupVoiceCapabilities>();
  const roles: readonly (readonly [keyof SetupVoiceCapabilities, string | undefined])[] = [
    ["speechInput", roleIds.speechInput],
    ["speechOutput", roleIds.speechOutput],
    ["realtime", roleIds.realtime],
  ];
  for (const [role, modelId] of roles) {
    if (modelId === undefined) continue;
    const current = ids.get(modelId) ?? {
      speechInput: false,
      speechOutput: false,
      realtime: false,
    };
    ids.set(modelId, { ...current, [role]: true });
  }
  if (roleIds.realtime !== undefined && roleIds.realtimeTranscription !== undefined) {
    const current = ids.get(roleIds.realtime);
    if (current !== undefined) {
      ids.set(roleIds.realtime, {
        ...current,
        realtimeTranscriptionModel: roleIds.realtimeTranscription,
      });
    }
  }
  return ids;
}

function configuredProviderVoiceProfiles(
  raw: Record<string, unknown>,
  capabilities: SetupVoiceCapabilities,
  existing: SetupVoiceProvider | undefined,
): Pick<SetupVoiceProvider, "voiceProfiles"> {
  // Realtime is input transport/VAD/transcription only (ADR-0154). A provider voice id is an
  // assistant speech-output credential and must never be copied onto a Realtime-only deployment.
  if (!capabilities.speechOutput) return {};
  const voiceProfiles = setupVoiceProfiles(raw, existing);
  return voiceProfiles === undefined ? {} : { voiceProfiles };
}

function providerForVoiceRoles(
  modelId: string,
  capabilities: SetupVoiceCapabilities,
  defaults: SetupVoiceProviderDefaults,
  raw: Record<string, unknown>,
  existingProviders: readonly SetupVoiceProvider[],
  submittedEndpoint: VoiceProviderEndpointOptions | undefined,
): SetupVoiceProvider {
  const existing = existingProviders.find((provider) => provider.modelId === modelId);
  const template = voiceProviderTemplate(modelId, capabilities, existingProviders);
  const connection = voiceProviderConnection(raw, defaults, template, submittedEndpoint);
  const capabilityTemplate =
    template !== undefined && sameBaseUrlIdentity(connection.baseUrl, template.baseUrl)
      ? template
      : undefined;
  const rawCapability = configuredVoiceCapability(
    modelId,
    connection.providerLocality,
    capabilities,
    capabilityTemplate,
  );
  return {
    ...connection,
    modelId,
    capabilities,
    ...(rawCapability === undefined ? {} : { rawCapability }),
    ...configuredProviderVoiceProfiles(raw, capabilities, existing),
  };
}

function providersForVoiceRoles(
  roleIds: VoiceRoleModelIds,
  defaults: SetupVoiceProviderDefaults,
  raw: Record<string, unknown>,
  options: VoiceSetupOptions,
  existingProviders: readonly SetupVoiceProvider[],
): readonly SetupVoiceProvider[] {
  return [...voiceCapabilitiesByModel(roleIds)].map(([modelId, capabilities]) =>
    providerForVoiceRoles(
      modelId,
      {
        ...capabilities,
        ...(capabilities.realtime && options.supportsSemanticTurnDetection
          ? { supportsSemanticTurnDetection: true }
          : {}),
        // The submitted tri-state travels to the speech-output deployment: true sets, false
        // clears, undefined lets the stored template decide (review finding on #3037).
        ...(capabilities.speechOutput && options.supportsSpeechSynthesisInstructions !== undefined
          ? { supportsSpeechSynthesisInstructions: options.supportsSpeechSynthesisInstructions }
          : {}),
      },
      defaults,
      raw,
      existingProviders,
      options.submittedEndpoint,
    ),
  );
}

interface ExplicitVoiceRoleReplacements {
  readonly speechInput: boolean;
  readonly speechOutput: boolean;
  readonly realtime: boolean;
}

function explicitVoiceRoleReplacements(
  raw: Record<string, unknown>,
): ExplicitVoiceRoleReplacements {
  return {
    speechInput:
      hasNonBlankStringField(raw, "voiceModelId") ||
      hasNonBlankStringField(raw, "voiceSpeechToTextModelId"),
    speechOutput: hasNonBlankStringField(raw, "voiceSpeechOutputModelId"),
    realtime: hasNonBlankStringField(raw, "voiceRealtimeModelId"),
  };
}

function retainedVoiceCapabilities(
  provider: SetupVoiceProvider,
  replacements: ExplicitVoiceRoleReplacements,
): SetupVoiceCapabilities {
  const realtime = provider.capabilities.realtime && !replacements.realtime;
  return {
    speechInput: provider.capabilities.speechInput && !replacements.speechInput,
    speechOutput: provider.capabilities.speechOutput && !replacements.speechOutput,
    realtime,
    ...(realtime && provider.capabilities.supportsSemanticTurnDetection === true
      ? { supportsSemanticTurnDetection: true }
      : {}),
    ...(realtime && provider.capabilities.realtimeTranscriptionModel !== undefined
      ? { realtimeTranscriptionModel: provider.capabilities.realtimeTranscriptionModel }
      : {}),
  };
}

function hasVoiceRole(capabilities: SetupVoiceCapabilities): boolean {
  return capabilities.speechInput || capabilities.speechOutput || capabilities.realtime;
}

function withRetainedVoiceCapabilities(
  provider: SetupVoiceProvider,
  capabilities: SetupVoiceCapabilities,
): SetupVoiceProvider {
  const rawCapability = configuredVoiceCapability(
    provider.modelId,
    provider.providerLocality,
    capabilities,
    provider,
  );
  return {
    ...provider,
    capabilities,
    rawCapability,
    voiceProfiles: capabilities.speechOutput ? provider.voiceProfiles : undefined,
  };
}

function mergedSemanticTurnDetection(
  generated: SetupVoiceProvider,
  existing: SetupVoiceProvider,
): boolean {
  if (generated.capabilities.realtime) {
    return generated.capabilities.supportsSemanticTurnDetection === true;
  }
  const realtimeEndpointChanged = !sameBaseUrlIdentity(generated.baseUrl, existing.baseUrl);
  return !realtimeEndpointChanged && existing.capabilities.supportsSemanticTurnDetection === true;
}

function mergeVoiceRole(
  generated: boolean,
  existing: boolean,
  explicitlyReplaced: boolean,
): boolean {
  return generated || (existing && !explicitlyReplaced);
}

function mergedGeneratedVoiceCapabilities(
  generated: SetupVoiceProvider,
  existing: SetupVoiceProvider,
  replacements: ExplicitVoiceRoleReplacements,
): SetupVoiceCapabilities {
  const realtime = mergeVoiceRole(
    generated.capabilities.realtime,
    existing.capabilities.realtime,
    replacements.realtime,
  );
  const supportsSemanticTurnDetection = mergedSemanticTurnDetection(generated, existing);
  const transcriptionSource = generated.capabilities.realtime
    ? generated.capabilities
    : existing.capabilities;
  const speechOutput = mergeVoiceRole(
    generated.capabilities.speechOutput,
    existing.capabilities.speechOutput,
    replacements.speechOutput,
  );
  // The submitted synthesis tri-state must survive the merge: generated carries it only when the
  // request stated it (true sets, false clears — false must keep overriding the stored template
  // downstream), otherwise the existing provider's stored value rides along (review finding on
  // #3041).
  const supportsSpeechSynthesisInstructions =
    generated.capabilities.supportsSpeechSynthesisInstructions ??
    existing.capabilities.supportsSpeechSynthesisInstructions;
  return {
    speechInput: mergeVoiceRole(
      generated.capabilities.speechInput,
      existing.capabilities.speechInput,
      replacements.speechInput,
    ),
    speechOutput,
    realtime,
    supportsSemanticTurnDetection: realtime && supportsSemanticTurnDetection ? true : undefined,
    ...(speechOutput && supportsSpeechSynthesisInstructions !== undefined
      ? { supportsSpeechSynthesisInstructions }
      : {}),
    realtimeTranscriptionModel: realtime
      ? transcriptionSource.realtimeTranscriptionModel
      : undefined,
  };
}

function mergeGeneratedVoiceProvider(
  generated: SetupVoiceProvider,
  existing: SetupVoiceProvider | undefined,
  replacements: ExplicitVoiceRoleReplacements,
): SetupVoiceProvider {
  if (existing === undefined) return generated;
  if (!sameBaseUrlIdentity(generated.baseUrl, existing.baseUrl)) return generated;
  const capabilities = mergedGeneratedVoiceCapabilities(generated, existing, replacements);
  const rawCapability = configuredVoiceCapability(
    generated.modelId,
    generated.providerLocality,
    capabilities,
    existing,
  );
  return {
    ...generated,
    capabilities,
    rawCapability,
    voiceProfiles: capabilities.speechOutput
      ? (generated.voiceProfiles ?? existing.voiceProfiles)
      : undefined,
  };
}

function mergeUntouchedVoiceProviders(
  generated: readonly SetupVoiceProvider[],
  existing: readonly SetupVoiceProvider[],
  raw: Record<string, unknown>,
): readonly SetupVoiceProvider[] {
  const generatedIds = new Set(generated.map((provider) => provider.modelId));
  const replacements = explicitVoiceRoleReplacements(raw);
  const mergedGenerated = generated.map((provider) =>
    mergeGeneratedVoiceProvider(
      provider,
      existing.find((candidate) => candidate.modelId === provider.modelId),
      replacements,
    ),
  );
  const retained = existing.flatMap((provider) => {
    if (generatedIds.has(provider.modelId)) return [];
    const capabilities = retainedVoiceCapabilities(provider, replacements);
    if (!hasVoiceRole(capabilities)) return [];
    if (
      capabilities.speechInput === provider.capabilities.speechInput &&
      capabilities.speechOutput === provider.capabilities.speechOutput &&
      capabilities.realtime === provider.capabilities.realtime
    ) {
      return [provider];
    }
    return [withRetainedVoiceCapabilities(provider, capabilities)];
  });
  return [...mergedGenerated, ...retained];
}

function inheritedSemanticTurnDetection(current: GatewayConfig | undefined): boolean {
  const electedRealtime = selectRealtimeVoiceModel(current ?? { providers: [] });
  return (
    current?.capabilities?.find((capability) => capability.id === electedRealtime)
      ?.supportsSemanticTurnDetection === true
  );
}

function realtimeProviderIdentityChanged(
  raw: Record<string, unknown>,
  current: GatewayConfig | undefined,
): boolean {
  const electedModelId = selectRealtimeVoiceModel(current ?? { providers: [] });
  const existing = current?.providers.find((provider) => provider.modelId === electedModelId);
  const submittedModelId = trimmedSubmittedString(raw, "voiceRealtimeModelId");
  if (submittedModelId !== undefined && submittedModelId !== existing?.modelId) return true;
  const submittedBaseUrl = trimmedSubmittedString(raw, "voiceBaseUrl");
  if (submittedBaseUrl === undefined) return false;
  return !sameBaseUrlIdentity(submittedBaseUrl, existing?.baseUrl ?? "");
}

function setupSemanticTurnDetection(
  raw: Record<string, unknown>,
  current: GatewayConfig | undefined,
  preserveExisting: boolean,
): SetupParseResult<boolean> {
  const submitted = optionalSetupBoolean(
    raw.voiceSupportsSemanticTurnDetection,
    "voiceSupportsSemanticTurnDetection",
  );
  if (!submitted.ok) return submitted;
  if (submitted.value !== undefined) return acceptedSetupValue(submitted.value);
  const replacesRealtime = realtimeProviderIdentityChanged(raw, current);
  return acceptedSetupValue(
    preserveExisting && !replacesRealtime ? inheritedSemanticTurnDetection(current) : false,
  );
}

function validateVoiceProviders(
  providers: readonly SetupVoiceProvider[],
  env: EnvSource,
): RouteResult | undefined {
  for (const provider of providers) {
    const invalidConnection = validateVoiceProviderConnection(provider, env);
    if (invalidConnection !== undefined) return invalidConnection;
  }
  return undefined;
}

function inheritedVoiceProvider(
  current: GatewayConfig | undefined,
  preserveExisting: boolean,
): ModelProviderConfig | undefined {
  if (!preserveExisting) return undefined;
  return currentSpeechInputProvider(current) ?? firstCurrentVoiceProvider(current);
}

function setupVoiceProviderDefaults(
  connection: { readonly baseUrl: string; readonly apiKey: string },
  apiKeyHeaderName: string,
  timeoutMs: number | undefined,
  providerLocality: VoiceProviderLocality,
  existing: ModelProviderConfig | undefined,
): SetupVoiceProviderDefaults {
  // The inherited provider's endpoint protocol (style, api version, realtime auth mode) is bound
  // to ITS base URL: it may seed the connection defaults only under the same URL-identity rule
  // the per-role template branch enforces. Without the guard, a preserve-mode move to a new host
  // (e.g. Azure -> LiteLLM) stamped the OLD provider's Azure protocol onto every role that had no
  // per-role template (LiteLLM production audit). Submitted endpoint fields still override these
  // defaults downstream (#3037).
  const inheritedEndpoint =
    existing !== undefined && sameBaseUrlIdentity(connection.baseUrl, existing.baseUrl)
      ? voiceProviderTemplateEndpoint(existing, {})
      : {};
  return {
    ...connection,
    apiKeyHeaderName,
    timeoutMs: timeoutMs ?? existing?.timeoutMs,
    maxRetries: existing?.maxRetries ?? 1,
    retryBaseDelayMs: existing?.retryBaseDelayMs ?? 500,
    ...inheritedEndpoint,
    providerLocality,
    ...inheritedCircuitBreakerFragment(existing),
  };
}

// KEIKO-0167 (PR-review follow-up, Codex thread 3769711637): inherit the per-provider
// circuit-breaker override from the stored voice provider so a regenerated
// SetupVoiceProvider on unrelated setup input keeps it. Extracted so the caller stays
// under the repo-wide cyclomatic-complexity ceiling.
function inheritedCircuitBreakerFragment(
  existing: ModelProviderConfig | undefined,
): Pick<SetupVoiceProvider, "circuitBreaker"> | Record<string, never> {
  return existing?.circuitBreaker === undefined ? {} : { circuitBreaker: existing.circuitBreaker };
}

function validatedVoiceProviders(
  providers: readonly SetupVoiceProvider[],
  env: EnvSource,
): readonly SetupVoiceProvider[] | RouteResult {
  return validateVoiceProviders(providers, env) ?? providers;
}

interface VoiceSetupOptions {
  readonly apiKeyHeaderName: string;
  readonly timeoutMs: number | undefined;
  readonly providerLocality: VoiceProviderLocality;
  readonly supportsSemanticTurnDetection: boolean;
  readonly supportsSpeechSynthesisInstructions: boolean | undefined;
  readonly submittedEndpoint: VoiceProviderEndpointOptions | undefined;
}

function parsedVoiceSetupOptions(
  raw: Record<string, unknown>,
  existing: ModelProviderConfig | undefined,
  existingCapability: ModelCapability | undefined,
  current: GatewayConfig | undefined,
  preserveExisting: boolean,
): VoiceSetupOptions | RouteResult {
  const apiKeyHeaderName = setupVoiceApiKeyHeaderName(raw, existing, preserveExisting);
  const timeoutMs = optionalSetupPositiveInt(raw.voiceTimeoutMs, "voiceTimeoutMs");
  const providerLocality = setupVoiceProviderLocality(raw, existingCapability);
  const supportsSemanticTurnDetection = setupSemanticTurnDetection(raw, current, preserveExisting);
  const speechSynthesisInstructions = optionalSetupBoolean(
    raw.voiceSupportsSpeechSynthesisInstructions,
    "voiceSupportsSpeechSynthesisInstructions",
  );
  const submittedEndpoint = submittedVoiceEndpointOptions(raw);
  if (!apiKeyHeaderName.ok) return apiKeyHeaderName.routeError;
  if (!timeoutMs.ok) return timeoutMs.routeError;
  if (!providerLocality.ok) return providerLocality.routeError;
  if (!supportsSemanticTurnDetection.ok) return supportsSemanticTurnDetection.routeError;
  if (!speechSynthesisInstructions.ok) return speechSynthesisInstructions.routeError;
  if (!submittedEndpoint.ok) return submittedEndpoint.routeError;
  return {
    apiKeyHeaderName: apiKeyHeaderName.value,
    timeoutMs: timeoutMs.value,
    providerLocality: providerLocality.value,
    supportsSemanticTurnDetection: supportsSemanticTurnDetection.value,
    supportsSpeechSynthesisInstructions: speechSynthesisInstructions.value,
    submittedEndpoint: submittedEndpoint.value,
  };
}

function readSetupVoiceProviders(
  raw: Record<string, unknown>,
  env: EnvSource,
  current: GatewayConfig | undefined,
  preserveExisting: boolean,
  correlationId: string | undefined,
): readonly SetupVoiceProvider[] | RouteResult {
  const inputFieldError = validateVoiceInputFields(raw, correlationId);
  if (inputFieldError !== undefined) return inputFieldError;
  if (!hasVoiceProviderInput(raw)) return [];
  const existingVoiceProviders = preserveExisting ? setupVoiceProvidersFromCurrent(current) : [];
  const existing = inheritedVoiceProvider(current, preserveExisting);
  const existingCapability = currentVoiceCapability(current, existing?.modelId);
  const roleIds = voiceRoleModelIds(raw, current, preserveExisting, correlationId);
  const connection = setupVoiceConnection(raw, existing, preserveExisting);
  const options = parsedVoiceSetupOptions(
    raw,
    existing,
    existingCapability,
    current,
    preserveExisting,
  );
  if (isRouteResult(options)) return options;
  const routeError = firstRouteResult([
    validateVoiceEndpointUpdate(raw, current, preserveExisting, correlationId),
    validateVoiceConnectionUpdate(raw, current, preserveExisting, correlationId),
    roleIds,
    connection,
  ]);
  if (routeError !== undefined) {
    return routeError;
  }
  const defaults = setupVoiceProviderDefaults(
    connection as { readonly baseUrl: string; readonly apiKey: string },
    options.apiKeyHeaderName,
    options.timeoutMs,
    options.providerLocality,
    existing,
  );
  const generatedProviders = providersForVoiceRoles(
    roleIds as VoiceRoleModelIds,
    defaults,
    raw,
    options,
    existingVoiceProviders,
  );
  const providers = mergeUntouchedVoiceProviders(generatedProviders, existingVoiceProviders, raw);
  return validatedVoiceProviders(providers, env);
}

interface ResolvedSetupModelLists {
  readonly deploymentNames: readonly string[];
  readonly imageInputModelIds: readonly string[];
  readonly workflowEligibleModelIds: readonly string[];
}

function resolveSetupModelLists(
  modelLists: SetupModelLists,
  current: GatewayConfig | undefined,
  preserveExisting: boolean,
): ResolvedSetupModelLists {
  const existing = preserveExisting ? current : undefined;
  return {
    deploymentNames:
      existing !== undefined && modelLists.deploymentNames.length === 0
        ? existing.providers.map((item) => item.modelId)
        : modelLists.deploymentNames,
    imageInputModelIds:
      modelLists.imageInputModelIds ??
      (existing === undefined ? [] : currentImageInputModelIds(existing)),
    workflowEligibleModelIds: modelLists.workflowEligibleModelIds,
  };
}

function currentNonVoiceModelIds(current: GatewayConfig | undefined): readonly string[] {
  if (current === undefined) return [];
  return current.providers
    .filter((provider) => {
      const capability = current.capabilities?.find((item) => item.id === provider.modelId);
      return capability === undefined || !isVoiceCapability(capability);
    })
    .map((provider) => provider.modelId);
}

function validateVoiceModelIdSeparation(
  voiceProviders: readonly SetupVoiceProvider[],
  modelLists: SetupModelLists,
  current: GatewayConfig | undefined,
  correlationId: string | undefined,
): RouteResult | undefined {
  const nonVoiceIds = new Set([...modelLists.deploymentNames, ...currentNonVoiceModelIds(current)]);
  const voiceIds = new Set([
    ...setupVoiceProvidersFromCurrent(current).map((provider) => provider.modelId),
    ...voiceProviders.map((provider) => provider.modelId),
  ]);
  if (![...voiceIds].some((modelId) => nonVoiceIds.has(modelId))) return undefined;
  return {
    status: 400,
    body: errorBody(
      "BAD_REQUEST",
      "Chat, embedding, and audio deployments must use distinct model IDs.",
      correlationId,
    ),
  };
}

/**
 * An image list needs the VERIFIED rebuild only when it claims a NEW image capability — those
 * ids must pass the vision probe. Clearing or shrinking to already-verified ids is a metadata
 * edit and patches the stored flags in place, exactly like workflow eligibility: routing it
 * through the rebuild let a transient smoke failure of an unrelated model delete that provider
 * during a flags-only edit (review findings on #3031/#3037).
 */
function imageListRequiresVerification(
  raw: Record<string, unknown>,
  modelLists: SetupModelLists,
  current: GatewayConfig | undefined,
): boolean {
  if (!hasListField(raw, "imageInputModelIds")) return false;
  const alreadyImageCapable = new Set(currentImageInputModelIds(current));
  return (modelLists.imageInputModelIds ?? []).some((id) => !alreadyImageCapable.has(id));
}

function setupRequiresGatewayVerification(
  raw: Record<string, unknown>,
  preserveExisting: boolean,
  modelLists: SetupModelLists,
  current: GatewayConfig | undefined,
): boolean {
  return (
    !preserveExisting ||
    hasNonBlankStringField(raw, "baseUrl") ||
    hasNonBlankStringField(raw, "apiKey") ||
    hasNonBlankStringField(raw, "apiKeyHeaderName") ||
    // The endpoint PROTOCOL only reaches the providers through the rebuild; without this the
    // settings-only path accepted a protocol change and dropped it (review finding on #3046).
    hasNonBlankStringField(raw, "endpointStyle") ||
    hasNonBlankStringField(raw, "apiVersion") ||
    hasNonEmptyListField(raw, "deploymentNames") ||
    imageListRequiresVerification(raw, modelLists, current)
  );
}

function setupObjectBodyRequiredResult(correlationId: string | undefined): RouteResult {
  return {
    status: 400,
    body: errorBody("BAD_REQUEST", "Request body must be a JSON object.", correlationId),
  };
}

interface SetupRequestAssembly {
  readonly correlationId: string | undefined;
  readonly credentials: SetupGatewayCredentials;
  readonly current: GatewayConfig | undefined;
  /** The durable stored view for restore classification — see {@link durableStoredGatewayConfig}. */
  readonly stored: GatewayConfig | undefined;
  readonly figmaAccessToken: string | undefined;
  readonly modelLists: SetupModelLists;
  readonly preserveExisting: boolean;
  readonly raw: Record<string, unknown>;
  readonly timeoutMs: number | undefined;
  readonly voiceProviders: readonly SetupVoiceProvider[];
}

// Verbatim restoration applies only to INHERITED deployments: an explicitly submitted
// deployment list is authoritative, and restoring an omitted provider would make it
// impossible to remove through the setup (review findings on #3031). Stored voice deployments
// never belong in the chat probe either: a succeeding probe would persist a DUPLICATE provider
// next to the restored voice entry.
function storedRestoreListsForSetup(
  input: SetupRequestAssembly,
): Pick<
  SetupRequest,
  | "storedEmbeddingModelIds"
  | "storedOcrModelIds"
  | "storedDedicatedEmbeddingModelIds"
  | "storedVoiceModelIds"
> {
  const inheritedDeployments =
    input.preserveExisting && !hasNonEmptyListField(input.raw, "deploymentNames");
  return {
    // Stored embedding kinds follow the same inherited-only rule as every other stored list: an
    // explicitly submitted deployment list is authoritative, and unioning the stored kinds over
    // it would make it impossible for a corrected upload to turn a mis-kinded embedding back
    // into a chat deployment (review finding on #3037). All four lists read the DURABLE stored
    // view: the dedicated-embedding list compares connection identities, which a transient
    // per-model env override must not skew (review finding on #3037).
    storedEmbeddingModelIds: inheritedDeployments ? currentEmbeddingModelIds(input.stored) : [],
    storedOcrModelIds: inheritedDeployments ? currentOcrModelIds(input.stored) : [],
    storedDedicatedEmbeddingModelIds: inheritedDeployments
      ? currentDedicatedEmbeddingModelIds(input.stored)
      : [],
    storedVoiceModelIds: inheritedDeployments ? currentVoiceModelIds(input.stored) : [],
  };
}

function assembleSetupRequest(input: SetupRequestAssembly): SetupRequest | RouteResult {
  const voiceModelIdError = validateVoiceModelIdSeparation(
    input.voiceProviders,
    input.modelLists,
    input.current,
    input.correlationId,
  );
  if (voiceModelIdError !== undefined) return voiceModelIdError;
  const resolved = resolveSetupModelLists(input.modelLists, input.current, input.preserveExisting);
  return {
    correlationId: input.correlationId,
    preserveExisting: input.preserveExisting,
    ...input.credentials,
    timeoutMs: input.timeoutMs,
    deploymentNames: resolved.deploymentNames,
    imageInputModelIds: resolved.imageInputModelIds,
    imageInputModelIdsProvided: hasListField(input.raw, "imageInputModelIds"),
    submittedEmbeddingModelIds: input.modelLists.embeddingModelIds ?? [],
    stored: input.stored,
    ...storedRestoreListsForSetup(input),
    workflowEligibleModelIds: resolved.workflowEligibleModelIds,
    workflowEligibleModelIdsConfigured: hasListField(input.raw, "workflowEligibleModelIds"),
    voiceProviders: input.voiceProviders,
    figmaAccessToken: input.figmaAccessToken ?? input.current?.figma?.accessToken,
    verifyGateway: setupRequiresGatewayVerification(
      input.raw,
      input.preserveExisting,
      input.modelLists,
      input.current,
    ),
    verifyFigmaCredential: input.figmaAccessToken !== undefined,
  };
}

function readSetupRequest(
  raw: unknown,
  env: EnvSource,
  current: GatewayConfig | undefined,
  stored: GatewayConfig | undefined,
  correlationId: string | undefined,
): SetupRequest | RouteResult {
  if (!isRecord(raw)) {
    return setupObjectBodyRequiredResult(correlationId);
  }
  const preserveExisting = shouldPreserveExisting(raw, current);
  const credentials = readSetupGatewayCredentials(raw, env, current, stored, preserveExisting);
  if (isRouteResult(credentials)) {
    return credentials;
  }
  const timeoutMs = optionalSetupPositiveInt(raw.timeoutMs, "timeoutMs");
  if (!timeoutMs.ok) {
    return timeoutMs.routeError;
  }
  const modelLists = readSetupModelLists(raw);
  if (isRouteResult(modelLists)) {
    return modelLists;
  }
  const figmaAccessToken = optionalSetupSecret(raw.figmaAccessToken, "figmaAccessToken");
  if (!figmaAccessToken.ok) {
    return figmaAccessToken.routeError;
  }
  const voiceProviders = readSetupVoiceProviders(
    raw,
    env,
    current,
    preserveExisting,
    correlationId,
  );
  if (isRouteResult(voiceProviders)) {
    return voiceProviders;
  }
  return assembleSetupRequest({
    raw,
    current,
    stored,
    correlationId,
    preserveExisting,
    credentials,
    timeoutMs: timeoutMs.value,
    modelLists,
    voiceProviders,
    figmaAccessToken: figmaAccessToken.value,
  });
}

function bodyFreeAuditStoreFailure(): string {
  return "Gateway setup audit could not be persisted.";
}

function bodyFreeVerificationFailure(): string {
  // Provider exceptions are outside Keiko's trust boundary and may embed response bodies, request
  // fragments, endpoints, or customer content. Secret-string replacement cannot make such an
  // arbitrary message safe, so the browser receives only this fixed diagnostic.
  return "Provider verification failed without exposing upstream response details.";
}

function reportSetupVerificationFailure(
  deps: UiHandlerDeps,
  error: unknown,
  correlationId: string | undefined,
  source:
    | "gateway.setup.figma-verify"
    | "gateway.setup.provider-verify"
    | "gateway.setup.tool-calling-probe",
): void {
  emitServerDiagnostic(
    deps.diagnostics,
    serverDiagnosticFromError({
      correlationId: correlationId ?? UNKNOWN_CORRELATION_ID,
      operation: "POST /api/gateway/setup",
      source,
      error,
      redact: bodyFreeVerificationFailure,
    }),
  );
}

interface VerifiedSetup {
  readonly rawConfig: Record<string, unknown>;
  readonly config: GatewayConfig;
  readonly testedModelIds: readonly string[];
  readonly skippedModelIds: readonly string[];
  /** Recognised models the gateway declared as a mode Keiko has no lane for. */
  readonly unsupportedModels?: readonly GatewayUnsupportedDiscoveredModel[];
  /** Explicitly asserted embedding models kept despite a failed setup probe — still configured. */
  readonly unverifiedEmbeddingModelIds?: readonly string[];
  /** Inferred embedding models removed because they could not answer an embedding request. */
  readonly droppedEmbeddingModelIds?: readonly string[];
  /** Chat deployments retained after a transient verification failure; tool calling remains false. */
  readonly unverifiedChatModelIds?: readonly string[];
}

interface SetupVerificationInput {
  readonly embeddingProbe: GatewayEmbeddingProbe;
  readonly preserveExisting: boolean;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly apiKeyHeaderName: string;
  /** Generic endpoint protocol — see {@link SetupGatewayCredentials} (#3042). */
  readonly endpointStyle: string | undefined;
  readonly apiVersion: string | undefined;
  readonly timeoutMs: number | undefined;
  readonly deploymentNames: readonly string[];
  readonly imageInputModelIds: readonly string[];
  /** True when the request stated the list explicitly — discovery must not re-add models then. */
  readonly imageInputModelIdsProvided: boolean;
  /** Stored embedding ids that override the name heuristic — see {@link SetupRequest}. */
  readonly storedEmbeddingModelIds: readonly string[];
  /** Client-asserted embedding ids — see {@link SetupRequest}. */
  readonly submittedEmbeddingModelIds: readonly string[];
  /** The durable stored view for restore classification — see {@link SetupRequest}. */
  readonly stored: GatewayConfig | undefined;
  /** Stored `ocr-vision` ids restored verbatim instead of probed — see {@link SetupRequest}. */
  readonly storedOcrModelIds: readonly string[];
  /** Dedicated-connection embedding ids restored verbatim — see {@link SetupRequest}. */
  readonly storedDedicatedEmbeddingModelIds: readonly string[];
  /** Stored voice ids excluded from the chat probe — see {@link SetupRequest}. */
  readonly storedVoiceModelIds: readonly string[];
  readonly workflowEligibleModelIds: readonly string[] | undefined;
  readonly voiceProviders: readonly SetupVoiceProvider[];
  readonly tester: GatewaySetupTester;
  readonly discovery: GatewayModelDiscovery;
  readonly env: EnvSource;
  readonly egress: GatewayEgressConfig | undefined;
  readonly figmaAccessToken: string | undefined;
  readonly current: GatewayConfig | undefined;
  /** Operator diagnostic sink; used to surface discovery truncation (KEIKO-0325). */
  readonly diagnostics?: ServerDiagnosticSink | undefined;
  // The request's own correlation id (ADR-0173 D5 g12), threaded through so a discovery-truncation
  // or unusable-models diagnostic for THIS setup attempt joins the same trace as the gateway.chat
  // probe lines `verifySetupCandidate` triggers, instead of minting a disconnected id. Falls back
  // to a fresh mint only when the request genuinely carried none.
  readonly correlationId: string | undefined;
}

interface SetupCandidateModels {
  readonly modelIds: readonly string[];
  readonly chatModelIds: readonly string[];
  readonly embeddingModelIds: readonly string[];
  readonly unsupportedModels?: readonly GatewayUnsupportedDiscoveredModel[];
  readonly imageInputModelIds: readonly string[];
  readonly modelMetadata: Readonly<Record<string, GatewayDiscoveredModelMetadata>>;
  // KEIKO-0325: true when the raw discovery payload contained more distinct model ids
  // than the caller (MAX_DISCOVERED_MODELS) admits, so the downstream setup pipeline can
  // surface the truncation instead of silently proceeding with the first 100 models.
  // Absent for legacy string-array discovery outputs and for payloads that fit within
  // the cap; consumers should treat missing as `false`.
  readonly truncated?: boolean;
}

function isGatewaySetupTestResult(
  result: readonly string[] | GatewaySetupTestResult,
): result is GatewaySetupTestResult {
  return "responseFormatModelIds" in result;
}

function normalizeSetupTestResult(
  result: readonly string[] | GatewaySetupTestResult,
): GatewaySetupTestResult {
  return isGatewaySetupTestResult(result)
    ? { ...result, toolCallingObservations: result.toolCallingObservations ?? [] }
    : { testedModelIds: result, responseFormatModelIds: [], toolCallingObservations: [] };
}

function assertImageInputModelsWereTested(
  imageInputModelIds: readonly string[],
  testedModelIds: readonly string[],
): void {
  if (imageInputModelIds.length === 0) return;
  const tested = new Set(testedModelIds);
  if (imageInputModelIds.some((modelId) => !tested.has(modelId))) {
    throw new Error("imageInputModelIds must match tested chat-callable model ids.");
  }
}

function testedImageInputModelIds(
  manualModelIds: readonly string[],
  discoveredModelIds: readonly string[],
  testedModelIds: readonly string[],
): readonly string[] {
  const tested = new Set(testedModelIds);
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const modelId of [...manualModelIds, ...discoveredModelIds]) {
    if (!tested.has(modelId) || seen.has(modelId)) {
      continue;
    }
    seen.add(modelId);
    merged.push(modelId);
  }
  return merged;
}

function validationConfigForSetup(input: SetupVerificationInput): GatewayConfig {
  const validationRawConfig = buildRawConfig(input.baseUrl, input.apiKey, ["setup-validation"], {
    apiKeyHeaderName: input.apiKeyHeaderName,
    endpointStyle: input.endpointStyle,
    apiVersion: input.apiVersion,
    imageInputModelIds: input.imageInputModelIds,
    timeoutMs: input.timeoutMs,
  });
  return parseGatewayConfig(
    withInheritedEgress(validationRawConfig, input.egress),
    input.env,
    linkLocalGatewayOverrideOptions(input.env),
  );
}

function normalizeLegacyDiscoveryResult(modelIds: readonly string[]): SetupCandidateModels {
  const embeddingModelIds = embeddingModelIdsFromDeployments(modelIds);
  const embeddingSet = new Set(embeddingModelIds);
  return {
    modelIds,
    chatModelIds: modelIds.filter((modelId) => !embeddingSet.has(modelId)),
    embeddingModelIds,
    imageInputModelIds: [],
    modelMetadata: {},
  };
}

function isStructuredDiscoveryResult(
  result: GatewayModelDiscoveryOutput,
): result is GatewayDiscoveredModels {
  if (Array.isArray(result)) {
    return false;
  }
  const candidate = result as Partial<GatewayDiscoveredModels>;
  return (
    Array.isArray(candidate.modelIds) &&
    Array.isArray(candidate.chatModelIds) &&
    Array.isArray(candidate.embeddingModelIds)
  );
}

function normalizeDiscoveryResult(result: GatewayModelDiscoveryOutput): SetupCandidateModels {
  if (isStructuredDiscoveryResult(result)) {
    return {
      modelIds: result.modelIds,
      chatModelIds: result.chatModelIds,
      embeddingModelIds: result.embeddingModelIds,
      imageInputModelIds: result.imageInputModelIds ?? [],
      modelMetadata: result.modelMetadata ?? {},
      // KEIKO-0325: propagate the discovery-truncation flag from parseModelDiscovery
      // so downstream setup can surface "N of M models discovered" instead of the
      // pre-fix silent drop past MAX_DISCOVERED_MODELS.
      ...(result.truncated === true ? { truncated: true } : {}),
      ...(result.unsupportedModels !== undefined
        ? { unsupportedModels: result.unsupportedModels }
        : {}),
    };
  }
  return normalizeLegacyDiscoveryResult(result);
}

function candidateModelsFromDeploymentNames(
  deploymentNames: readonly string[],
  storedEmbeddingModelIds: readonly string[],
  restoredVerbatimModelIds: readonly string[],
): SetupCandidateModels {
  // Stored kinds win over the name heuristic: a preserve-mode rebuild must not chat-probe a
  // verified embedding or OCR deployment out of the config (review findings on #3031). Stored
  // OCR and dedicated-endpoint embedding providers leave the candidate set entirely — they are
  // restored verbatim afterwards.
  const restoredSet = new Set(restoredVerbatimModelIds);
  const candidateNames = deploymentNames.filter((modelId) => !restoredSet.has(modelId));
  const storedEmbeddingSet = new Set(storedEmbeddingModelIds);
  const embeddingModelIds = candidateNames.filter(
    (modelId) => storedEmbeddingSet.has(modelId) || isLikelyEmbeddingModelId(modelId),
  );
  const embeddingSet = new Set(embeddingModelIds);
  return {
    modelIds: candidateNames,
    chatModelIds: candidateNames.filter((modelId) => !embeddingSet.has(modelId)),
    embeddingModelIds,
    imageInputModelIds: [],
    modelMetadata: {},
  };
}

async function candidateModelIdsForSetup(
  input: SetupVerificationInput,
  validationConfig: GatewayConfig,
): Promise<SetupCandidateModels> {
  if (input.deploymentNames.length > 0) {
    return candidateModelsFromDeploymentNames(
      input.deploymentNames,
      [...input.storedEmbeddingModelIds, ...input.submittedEmbeddingModelIds],
      [
        ...input.storedOcrModelIds,
        ...input.storedDedicatedEmbeddingModelIds,
        // Voice ids leave the candidate set too, but applyVoiceProviders restores them — they
        // must not join the verbatim-restore list below.
        ...input.storedVoiceModelIds,
      ],
    );
  }
  return normalizeDiscoveryResult(
    await input.discovery(
      input.baseUrl,
      input.apiKey,
      input.apiKeyHeaderName,
      validationConfig.egress,
    ),
  );
}

function finalRawConfigForSetup(
  input: SetupVerificationInput,
  testedModelIds: readonly string[],
  embeddingModelIds: readonly string[],
  imageInputModelIds: readonly string[],
  responseFormatModelIds: readonly string[],
  modelMetadata: Readonly<Record<string, GatewayDiscoveredModelMetadata>>,
): Record<string, unknown> {
  const configuredModelIds = mergeChatAndEmbeddingModelIds(testedModelIds, embeddingModelIds);
  const rawConfig = buildRawConfig(input.baseUrl, input.apiKey, configuredModelIds, {
    preserveExisting: input.preserveExisting,
    apiKeyHeaderName: input.apiKeyHeaderName,
    endpointStyle: input.endpointStyle,
    apiVersion: input.apiVersion,
    imageInputModelIds,
    responseFormatModelIds,
    embeddingModelIds,
    modelMetadata,
    current: input.current,
    stored: input.stored,
    workflowEligibleModelIds: input.workflowEligibleModelIds,
    timeoutMs: input.timeoutMs,
  });
  const rawConfigWithOptionalBlocks = {
    ...rawConfig,
    // Every top-level block the rebuild does not itself produce survives from the current
    // configuration — a reranker or egress topology must not vanish because an unrelated
    // capability was updated (review finding on #3031).
    ...(input.current?.grounding === undefined ? {} : { grounding: input.current.grounding }),
    ...(input.current?.reranker === undefined ? {} : { reranker: input.current.reranker }),
    ...(input.current?.egress === undefined ? {} : { egress: input.current.egress }),
    ...(input.figmaAccessToken === undefined
      ? {}
      : { figma: { accessToken: input.figmaAccessToken } }),
  };
  // Verbatim restoration reads the DURABLE stored view: restored values are what the FILE
  // holds, so a transient per-model env override neither hides a sharing relationship nor gets
  // baked into the rebuilt persisted config (review finding on #3037).
  return applyStoredDedicatedProviders(
    applyVoiceProviders(
      rawConfigWithOptionalBlocks,
      input.voiceProviders.length > 0
        ? input.voiceProviders
        : setupVoiceProvidersFromCurrent(input.stored),
    ),
    input.stored,
    [...input.storedOcrModelIds, ...input.storedDedicatedEmbeddingModelIds],
    {
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      apiKeyHeaderName: input.apiKeyHeaderName,
      endpointStyle: input.endpointStyle,
      apiVersion: input.apiVersion,
    },
  );
}

// The gateway connection a restored provider may follow: endpoint, credential, header AND the
// protocol spoken over it.
interface SetupGatewayConnection {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly apiKeyHeaderName: string;
  // The raw submitted value: this record is fed to the config parser, which is what validates
  // the protocol — the same path genericEndpointProtocolRaw already takes.
  readonly endpointStyle?: string | undefined;
  readonly apiVersion?: string | undefined;
}

// A provider that SHARED the stored gateway connection (same endpoint AND same credential)
// follows a credential rotation — the old token dies with the rotation, and the token must keep
// travelling in the header the rebuilt gateway providers now use, or the restored provider would
// send the fresh credential through the obsolete header (review finding on #3037). A provider
// with its own credential or endpoint keeps both: the freshly verified gateway connection details
// must never travel to a connection they were not tested against (review findings on #3031, same
// rule as the endpoint-change token guard).
function sharesStoredGatewayConnection(
  provider: ModelProviderConfig,
  storedPrimary: ModelProviderConfig | undefined,
): boolean {
  return (
    storedPrimary !== undefined &&
    sameBaseUrlIdentity(provider.baseUrl, storedPrimary.baseUrl) &&
    provider.apiKey === storedPrimary.apiKey &&
    (provider.apiKeyHeaderName ?? DEFAULT_API_KEY_HEADER_NAME) ===
      (storedPrimary.apiKeyHeaderName ?? DEFAULT_API_KEY_HEADER_NAME)
  );
}

// Only a provider that SPOKE the gateway's protocol follows it to a new one. One that
// deliberately used a different valid protocol over the same connection keeps its own: the new
// request shape was never verified for it (review finding on #3046).
function spokeStoredGatewayProtocol(
  provider: ModelProviderConfig,
  storedPrimary: ModelProviderConfig | undefined,
): boolean {
  return (
    storedPrimary !== undefined &&
    provider.endpointStyle === storedPrimary.endpointStyle &&
    provider.apiVersion === storedPrimary.apiVersion
  );
}

// The endpoint PROTOCOL is part of the connection, not a private property of the provider: a
// restored provider that follows the gateway's URL, token and header must speak the same way, or
// one shared connection ends up carrying two protocols and the restored provider keeps requesting
// the obsolete route (review finding on #3046).
function restoredProviderProtocolRaw(
  provider: ModelProviderConfig,
  gateway: SetupGatewayConnection,
  storedPrimary: ModelProviderConfig | undefined,
  sharedGatewayConnection: boolean,
): Record<string, unknown> {
  const follows = sharedGatewayConnection && spokeStoredGatewayProtocol(provider, storedPrimary);
  const endpointStyle = follows ? gateway.endpointStyle : provider.endpointStyle;
  const apiVersion = follows ? gateway.apiVersion : provider.apiVersion;
  return {
    ...(endpointStyle === undefined ? {} : { endpointStyle }),
    ...(apiVersion === undefined ? {} : { apiVersion }),
  };
}

function storedDedicatedProviderRaw(
  provider: ModelProviderConfig,
  capability: ModelCapability,
  gateway: SetupGatewayConnection,
  storedPrimary: ModelProviderConfig | undefined,
): Record<string, unknown> {
  // Sharing is judged against the STORED primary connection — a provider that rode the old
  // gateway follows it wherever the setup moves it (URL, credential, AND header), because the
  // old connection dies with the update; a provider with its own connection keeps every field
  // (review findings on #3031/#3037 — the newly verified details never travel to a connection
  // they were not tested against).
  const sharedGatewayConnection = sharesStoredGatewayConnection(provider, storedPrimary);
  const apiKeyHeaderName = sharedGatewayConnection
    ? gateway.apiKeyHeaderName
    : provider.apiKeyHeaderName;
  return {
    modelId: provider.modelId,
    baseUrl: sharedGatewayConnection ? gateway.baseUrl : provider.baseUrl,
    apiKey: sharedGatewayConnection ? gateway.apiKey : provider.apiKey,
    ...(apiKeyHeaderName === undefined ? {} : { apiKeyHeaderName }),
    ...restoredProviderProtocolRaw(provider, gateway, storedPrimary, sharedGatewayConnection),
    ...(provider.outputTokenParameter === undefined
      ? {}
      : { outputTokenParameter: provider.outputTokenParameter }),
    timeoutMs: provider.timeoutMs,
    maxRetries: provider.maxRetries,
    retryBaseDelayMs: provider.retryBaseDelayMs,
    // KEIKO-0167 (PR-review follow-up): the per-provider circuit-breaker override must
    // survive a dedicated-provider restore too, or an unrelated setup save (voice/ocr
    // deployment change) silently drops it and the runtime falls back to top-level policy.
    ...(provider.circuitBreaker === undefined ? {} : { circuitBreaker: provider.circuitBreaker }),
    capability,
  };
}

/**
 * A verified rebuild only re-derives chat and embedding providers onto the setup-wide
 * connection; stored `ocr-vision` providers (no probe, no setup field) and embedding providers
 * on a DIFFERENT endpoint would silently vanish or migrate. Exactly like voice, they are
 * restored verbatim from the current configuration (review findings on #3031).
 */
function applyStoredDedicatedProviders(
  rawConfig: Record<string, unknown>,
  current: GatewayConfig | undefined,
  restoredModelIds: readonly string[],
  gateway: SetupGatewayConnection,
): Record<string, unknown> {
  if (restoredModelIds.length === 0 || current === undefined) return rawConfig;
  const providers: unknown[] = Array.isArray(rawConfig.providers) ? rawConfig.providers : [];
  const presentIds = new Set(
    providers.flatMap((provider) =>
      isRecord(provider) && typeof provider.modelId === "string" ? [provider.modelId] : [],
    ),
  );
  const restored = restoredModelIds.flatMap((modelId) => {
    if (presentIds.has(modelId)) return [];
    const provider = current.providers.find((item) => item.modelId === modelId);
    const capability = current.capabilities?.find((item) => item.id === modelId);
    if (provider === undefined || capability === undefined) return [];
    return [
      storedDedicatedProviderRaw(
        provider,
        capability,
        gateway,
        storedPrimaryGatewayProvider(current),
      ),
    ];
  });
  if (restored.length === 0) return rawConfig;
  return { ...rawConfig, providers: [...providers, ...restored] };
}

function skippedModelIdsForSetup(
  candidateModelIds: readonly string[],
  testedModelIds: readonly string[],
  embeddingModelIds: readonly string[],
): readonly string[] {
  const acceptedModelIds = new Set([...testedModelIds, ...embeddingModelIds]);
  return candidateModelIds.filter((modelId) => !acceptedModelIds.has(modelId));
}

function finalRawConfigForTestedSetup(
  input: SetupVerificationInput,
  testResult: GatewaySetupTestResult,
  candidateModels: SetupCandidateModels,
  configuredChatModelIds = testResult.testedModelIds,
): Record<string, unknown> {
  const imageInputModelIds = testedImageInputModelIds(
    input.imageInputModelIds,
    // An explicitly provided list is authoritative: discovery and current-config candidates must
    // not re-add models the request just removed (review finding on #3031).
    input.imageInputModelIdsProvided ? [] : candidateModels.imageInputModelIds,
    configuredChatModelIds,
  );
  return finalRawConfigForSetup(
    input,
    configuredChatModelIds,
    candidateModels.embeddingModelIds,
    imageInputModelIds,
    testResult.responseFormatModelIds,
    candidateModels.modelMetadata,
  );
}

interface ChatAdmission {
  readonly testResult: GatewaySetupTestResult;
  readonly configuredModelIds: readonly string[];
  readonly unverifiedModelIds: readonly string[];
}

function temporaryChatAdmission(candidateModels: SetupCandidateModels): ChatAdmission {
  const checkedAt = new Date().toISOString();
  return {
    testResult: {
      testedModelIds: [],
      responseFormatModelIds: [],
      toolCallingObservations: candidateModels.chatModelIds.map((modelId) => ({
        modelId,
        status: "unverified",
        checkedAt,
      })),
    },
    configuredModelIds: candidateModels.chatModelIds,
    unverifiedModelIds: candidateModels.chatModelIds,
  };
}

function temporaryGatewaySetupFailure(error: unknown): boolean {
  const code = setupErrorCode(error);
  return (
    code === ERROR_CODES.RATE_LIMIT || (code !== undefined && TEMPORARY_SETUP_ERROR_CODES.has(code))
  );
}

function definitiveGatewaySetupFailure(error: unknown): boolean {
  const status = setupHttpStatus(error);
  return status === 401 || status === 403;
}

async function admitChatCandidates(
  input: SetupVerificationInput,
  candidateModels: SetupCandidateModels,
  candidateConfig: GatewayConfig,
): Promise<ChatAdmission> {
  const testResult = normalizeSetupTestResult(
    await input.tester(candidateConfig, candidateModels.chatModelIds),
  );
  return {
    testResult,
    configuredModelIds: testResult.testedModelIds,
    unverifiedModelIds: [],
  };
}

function toolCallingObservationMap(
  observations: readonly GatewaySetupToolCallingObservation[],
): ReadonlyMap<string, GatewaySetupToolCallingObservation> {
  return new Map(observations.map((observation) => [observation.modelId, observation]));
}

function withToolCallingProbeProvenance(
  rawConfig: Record<string, unknown>,
  config: GatewayConfig,
  observations: readonly GatewaySetupToolCallingObservation[],
): Record<string, unknown> {
  if (observations.length === 0 || !Array.isArray(rawConfig.providers)) return rawConfig;
  const byModelId = toolCallingObservationMap(observations);
  const rawProviders: readonly unknown[] = rawConfig.providers;
  const providers = rawProviders.map((rawProvider: unknown) => {
    if (!isRecord(rawProvider) || typeof rawProvider.modelId !== "string") return rawProvider;
    const observation = byModelId.get(rawProvider.modelId);
    const provider = config.providers.find(
      (candidate) => candidate.modelId === rawProvider.modelId,
    );
    if (observation === undefined || provider === undefined || !isRecord(rawProvider.capability)) {
      return rawProvider;
    }
    const capability = rawProvider.capability;
    if (capability.kind !== "chat") return rawProvider;
    return {
      ...rawProvider,
      capability: {
        ...capability,
        toolCalling: observation.status === "verified",
        toolCallingVerification: {
          status: observation.status,
          checkedAt: observation.checkedAt,
          probe: "gateway-tool-calling-v1",
          configurationFingerprint: toolCallingConfigurationFingerprint(provider),
        },
      },
    };
  });
  return { ...rawConfig, providers };
}

interface ParsedSetupConfig {
  readonly rawConfig: Record<string, unknown>;
  readonly config: GatewayConfig;
}

function parsedSetupConfigWithToolCallingProvenance(
  input: SetupVerificationInput,
  rawConfig: Record<string, unknown>,
  candidateConfig: GatewayConfig,
  observations: readonly GatewaySetupToolCallingObservation[],
): ParsedSetupConfig {
  const rawConfigWithProvenance = withToolCallingProbeProvenance(
    rawConfig,
    candidateConfig,
    observations,
  );
  return {
    rawConfig: rawConfigWithProvenance,
    config: parseGatewayConfig(
      withInheritedEgress(rawConfigWithProvenance, input.egress),
      input.env,
      linkLocalGatewayOverrideOptions(input.env),
    ),
  };
}

// One retry (not zero) so a single transient blip — 429 rate-limit, brief timeout, momentary
// content-filter — does not permanently exclude an otherwise-working model from the setup and
// brand it to the user as incompatible. Still bounded so setup latency stays predictable. The
// probe carries the submitted endpoint protocol so an Azure deployment path (or an explicit
// openai-compatible declaration under an env default) is exercised exactly as it will persist.
function candidateProbeOptions(
  input: SetupVerificationInput,
  smokeTimeoutMs: number,
): ProviderRawOptions {
  return {
    apiKeyHeaderName: input.apiKeyHeaderName,
    endpointStyle: input.endpointStyle,
    apiVersion: input.apiVersion,
    timeoutMs: smokeTimeoutMs,
    maxRetries: 1,
    imageInputModelIds: input.imageInputModelIds,
  };
}

// KEIKO-0325: discovery silently dropped everything past MAX_DISCOVERED_MODELS. The parser now
// raises `truncated`; this is the consumer that makes it operator-visible. Body-free by
// construction — a count and a code, never a model id or an endpoint.
function reportDiscoveryTruncation(
  diagnostics: ServerDiagnosticSink | undefined,
  correlationId: string | undefined,
  candidateModels: SetupCandidateModels,
): void {
  if (candidateModels.truncated !== true) return;
  emitServerDiagnostic(diagnostics, {
    correlationId: correlationId ?? randomUUID(),
    timestamp: new Date().toISOString(),
    operation: "POST /api/gateway/setup",
    source: "gateway-setup.discovery",
    errorClass: "GatewayDiscoveryTruncated",
    message:
      "Model discovery exceeded the discovery cap; setup continued with the retained models.",
    code: "GATEWAY_DISCOVERY_TRUNCATED",
    retainedModelCount: candidateModels.modelIds.length,
  });
}

interface EmbeddingAdmission {
  readonly admitted: readonly string[];
  /** Failed the probe but stays configured, because its role was explicitly asserted. */
  readonly retainedUnverified: readonly string[];
  /** Failed the probe and is NOT configured — Keiko had only inferred the role. */
  readonly droppedUnverified: readonly string[];
}

function probeConfigForModels(
  input: SetupVerificationInput,
  modelIds: readonly string[],
  smokeTimeoutMs: number,
): GatewayConfig {
  return parseGatewayConfig(
    withInheritedEgress(
      buildRawConfig(
        input.baseUrl,
        input.apiKey,
        modelIds,
        candidateProbeOptions(input, smokeTimeoutMs),
      ),
      input.egress,
    ),
    input.env,
    linkLocalGatewayOverrideOptions(input.env),
  );
}

// The candidate config carries only the chat models, so the probe needs its own provider view over
// the embedding candidates — same endpoint, credential, protocol and timeout.
function embeddingProbeConfigFor(
  input: SetupVerificationInput,
  candidateModels: SetupCandidateModels,
  smokeTimeoutMs: number,
  fallback: GatewayConfig,
): GatewayConfig {
  if (candidateModels.embeddingModelIds.length === 0) return fallback;
  return probeConfigForModels(input, candidateModels.embeddingModelIds, smokeTimeoutMs);
}

// Probe-gated embedding admission. A NEW candidate must answer a real embedding request before it
// is persisted as this gateway's embedding model. A STORED one that fails is RETAINED and reported
// unverified: a transient endpoint outage during a re-save must never unpin the embedding model of
// every working Knowledge Pod (that would be a worse failure than the one this closes).
async function admitEmbeddingCandidates(
  input: SetupVerificationInput,
  probeConfig: GatewayConfig,
  candidates: readonly string[],
): Promise<EmbeddingAdmission> {
  if (candidates.length === 0) {
    return { admitted: candidates, retainedUnverified: [], droppedUnverified: [] };
  }
  // Probe-gating applies to every model whose ROLE Keiko inferred. Only an explicit ROLE assertion
  // is exempt: a stored embedding capability, or an embedding id the client asserted. Deployment
  // NAMES are deliberately NOT exempt — naming a deployment states its identity, not its role; the
  // role there still comes from Keiko's own id heuristic, which is exactly what the probe corrects.
  const asserted = new Set([...input.storedEmbeddingModelIds, ...input.submittedEmbeddingModelIds]);
  const answered = new Set(await input.embeddingProbe(probeConfig, candidates));
  const admitted = candidates.filter((id) => answered.has(id) || asserted.has(id));
  // Split the failures: an asserted model stays configured and is flagged; an inferred one is gone.
  const failed = candidates.filter((id) => !answered.has(id));
  return {
    admitted,
    retainedUnverified: failed.filter((id) => asserted.has(id)),
    droppedUnverified: failed.filter((id) => !asserted.has(id)),
  };
}

// Body-free counterpart to reportDiscoveryTruncation: counts and reason codes only, never a model
// id or an endpoint. Ids belong in the setup RESPONSE, which the operator sees; the diagnostic
// channel stays free of gateway inventory.
function reportUnusableDiscoveredModels(
  diagnostics: ServerDiagnosticSink | undefined,
  correlationId: string | undefined,
  unsupported: readonly GatewayUnsupportedDiscoveredModel[],
  admission: EmbeddingAdmission,
): void {
  const retained = admission.retainedUnverified.length;
  const dropped = admission.droppedUnverified.length;
  if (unsupported.length === 0 && retained === 0 && dropped === 0) return;
  emitServerDiagnostic(diagnostics, {
    correlationId: correlationId ?? randomUUID(),
    timestamp: new Date().toISOString(),
    operation: "POST /api/gateway/setup",
    source: "gateway-setup.discovery",
    errorClass: "GatewayDiscoveryUnusableModels",
    message:
      "Setup skipped models the gateway declared as unsupported modes or that failed the embedding probe.",
    code: "GATEWAY_DISCOVERY_UNUSABLE_MODELS",
    unsupportedModelCount: unsupported.length,
    unsupportedReasons: [...new Set(unsupported.map((entry) => entry.reason))].sort((a, b) =>
      a.localeCompare(b),
    ),
    unverifiedEmbeddingModelCount: retained,
    droppedEmbeddingModelCount: dropped,
  });
}

async function verifySetupCandidate(input: SetupVerificationInput): Promise<VerifiedSetup> {
  // Defence-in-depth: never send the credential to a candidate URL that has not passed the same
  // scheme/credential/loopback validation as the originally submitted base URL.
  validateBaseUrl(input.baseUrl, "candidate", input.egress);
  const validationConfig = validationConfigForSetup(input);
  const candidateModels = await candidateModelIdsForSetup(input, validationConfig);
  reportDiscoveryTruncation(input.diagnostics, input.correlationId, candidateModels);
  const smokeTimeoutMs =
    input.deploymentNames.length > 0
      ? DEPLOYMENT_SMOKE_TIMEOUT_MS
      : DISCOVERED_MODEL_SMOKE_TIMEOUT_MS;
  const candidateConfig = probeConfigForModels(input, candidateModels.chatModelIds, smokeTimeoutMs);
  const embeddingAdmission = await admitEmbeddingCandidates(
    input,
    embeddingProbeConfigFor(input, candidateModels, smokeTimeoutMs, candidateConfig),
    candidateModels.embeddingModelIds,
  );
  const admittedModels: SetupCandidateModels = {
    ...candidateModels,
    embeddingModelIds: embeddingAdmission.admitted,
  };
  // Emitted BEFORE the chat smoke test: the tester throws on an all-rejected gateway, and the
  // record of what discovery refused is most valuable for exactly that failed attempt.
  reportUnusableDiscoveredModels(
    input.diagnostics,
    input.correlationId,
    candidateModels.unsupportedModels ?? [],
    embeddingAdmission,
  );
  let chatAdmission: ChatAdmission;
  try {
    chatAdmission = await admitChatCandidates(input, candidateModels, candidateConfig);
  } catch (error) {
    if (!temporaryGatewaySetupFailure(error)) throw error;
    throw new DeferredTemporaryChatAdmission(error, () =>
      verifiedSetupFromChatAdmission(
        input,
        candidateModels,
        admittedModels,
        candidateConfig,
        embeddingAdmission,
        temporaryChatAdmission(candidateModels),
      ),
    );
  }
  return verifiedSetupFromChatAdmission(
    input,
    candidateModels,
    admittedModels,
    candidateConfig,
    embeddingAdmission,
    chatAdmission,
  );
}

function verifiedSetupFromChatAdmission(
  input: SetupVerificationInput,
  candidateModels: SetupCandidateModels,
  admittedModels: SetupCandidateModels,
  candidateConfig: GatewayConfig,
  embeddingAdmission: EmbeddingAdmission,
  chatAdmission: ChatAdmission,
): VerifiedSetup {
  const { testResult } = chatAdmission;
  assertImageInputModelsWereTested(input.imageInputModelIds, chatAdmission.configuredModelIds);
  const rawConfigWithOptionalBlocks = finalRawConfigForTestedSetup(
    input,
    testResult,
    admittedModels,
    chatAdmission.configuredModelIds,
  );
  const parsedConfig = parsedSetupConfigWithToolCallingProvenance(
    input,
    rawConfigWithOptionalBlocks,
    candidateConfig,
    testResult.toolCallingObservations ?? [],
  );
  return verifiedSetupResult(
    parsedConfig.rawConfig,
    parsedConfig.config,
    testResult,
    candidateModels,
    embeddingAdmission,
    chatAdmission,
  );
}

function verifiedSetupResult(
  rawConfig: Record<string, unknown>,
  config: GatewayConfig,
  testResult: GatewaySetupTestResult,
  candidateModels: SetupCandidateModels,
  embeddingAdmission: EmbeddingAdmission,
  chatAdmission: ChatAdmission,
): VerifiedSetup {
  return {
    rawConfig,
    config,
    testedModelIds: testResult.testedModelIds,
    skippedModelIds: skippedModelIdsForSetup(
      candidateModels.modelIds,
      chatAdmission.configuredModelIds,
      embeddingAdmission.admitted,
    ),
    ...(candidateModels.unsupportedModels !== undefined
      ? { unsupportedModels: candidateModels.unsupportedModels }
      : {}),
    ...(embeddingAdmission.retainedUnverified.length > 0
      ? { unverifiedEmbeddingModelIds: embeddingAdmission.retainedUnverified }
      : {}),
    ...(embeddingAdmission.droppedUnverified.length > 0
      ? { droppedEmbeddingModelIds: embeddingAdmission.droppedUnverified }
      : {}),
    ...(chatAdmission.unverifiedModelIds.length > 0
      ? { unverifiedChatModelIds: chatAdmission.unverifiedModelIds }
      : {}),
  };
}

// KEIKO-0497 (#2901): configuring the gateway points the product at an outbound endpoint and can
// enable the private-network override, and until now that act left no evidence — the route returned
// 200 and wrote nothing an operator could audit afterwards. Both success paths now emit exactly one
// content-free record.
//
// The base URL is deliberately NOT recorded, only its host classification: the evidence must answer
// "did setup ever target a metadata or private-network address, and was the override on?" without
// itself becoming a store of endpoints. `classifyOutboundHost` returns nothing for a name that is
// not a literal IP, which is the ordinary public case, so an unclassified host records as `public`
// rather than dropping the record — a successful setup must never be missing from the trail.
export function gatewaySetupTargetClass(baseUrl: string): GatewaySetupTargetClass {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    // An unparseable base URL cannot reach a real host, but the setup still completed; record it
    // under the safest classification rather than losing the event.
    return "public";
  }
  // Strip a trailing FQDN dot: "localhost." resolves to loopback but classifyOutboundHost's
  // literal-string equality otherwise misses it, and the same applies to a dotted IPv4 literal
  // like "127.0.0.1." (Codex #3201). The trailing dot is a DNS root marker, not part of the
  // resolvable host identity.
  const normalized = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  // Non-literal names ("internal.example", "example.com") still record as `public`: this
  // classifier deliberately does NOT DNS-resolve the host — that would add a synchronous DNS
  // round-trip to the success path and duplicate the check gatewayFetch already runs against
  // the resolved address inside its egress policy. The record's `targetClass` documents the
  // classification of the submitted URL as a literal address; a hostname-only entry records
  // "was not a literal private/loopback/metadata address at submission time", not
  // "attests to a public destination". Operators reading a name-based `public` should
  // cross-reference the egress-policy diagnostics for the resolved-address vetting.
  return classifyOutboundHost(normalized) ?? "public";
}

function recordGatewaySetupAudit(
  deps: UiHandlerDeps,
  request: SetupRequest,
  config: GatewayConfig,
  outcome: GatewaySetupOutcomeKind,
): void {
  const record: GatewaySetupAuditRecord = {
    schemaVersion: GATEWAY_SETUP_AUDIT_SCHEMA_VERSION,
    outcome,
    timestamp: new Date().toISOString(),
    correlationId: request.correlationId ?? randomUUID(),
    targetClass: gatewaySetupTargetClass(request.baseUrl),
    // Any active outbound-egress override counts, not just the private-network one: a
    // link-local/metadata override under KEIKO_ALLOW_LINK_LOCAL_GATEWAY is exactly the more
    // sensitive case an operator needs to see (KEIKO-0497 review, Codex).
    privateNetworkOverrideActive:
      config.egress?.allowPrivateNetwork === true ||
      config.egress?.allowLinkLocalAndMetadata === true,
    providerCount: config.providers.length,
  };
  const validation = validateGatewaySetupAuditRecord(record);
  if (!validation.ok) {
    // Never a silent drop: a record this side built and cannot validate is a defect in this code,
    // and swallowing it would leave the same evidence gap the record exists to close. The reason is
    // a fixed validator string naming a field — it carries no value from the record. Issue #3245:
    // `message` is now the closed-vocabulary condition label; `validation.reason` (still bounded —
    // one of the validator's own fixed field-naming strings, never record content) moves to `code`,
    // which already carries exactly this "stable machine-readable code" shape elsewhere in this
    // file, so the generic `GATEWAY_SETUP_AUDIT_INVALID` marker (redundant with `errorClass`) is
    // replaced by the more specific reason rather than lost.
    emitServerDiagnostic(deps.diagnostics, {
      correlationId: record.correlationId,
      timestamp: record.timestamp,
      operation: "POST /api/gateway/setup",
      source: "gateway-setup.audit",
      errorClass: "GatewaySetupAuditInvalid",
      message: "gateway-setup-audit-validation-failed",
      code: validation.reason,
    });
    return;
  }
  // KEIKO-0497 review (Codex): the setup response has already been decided by the time this
  // runs — the gateway is persisted and activated. A failing evidenceStore.put must NOT escape
  // to the outer catch, or verifyAndSaveGatewaySetup would treat a full/read-only evidence
  // directory as a provider failure and hand the caller a 502 for a gateway that is already
  // live. Absorbed and surfaced as its own diagnostic (never body-free-swallowed).
  try {
    deps.evidenceStore.put(`gateway-setup-${randomUUID()}`, JSON.stringify(record));
  } catch (error) {
    // Body-free by construction (KEIKO-0497 review, Codex P1): a failing evidence store can throw
    // Errors whose message carries the absolute evidence path, injected store text, or PII —
    // interpolating error.message into a diagnostic would leak all of that. serverDiagnosticFromError
    // classifies the error content-free; the summary is a fixed allowlisted string, never derived
    // from the error.
    emitServerDiagnostic(
      deps.diagnostics,
      serverDiagnosticFromError({
        correlationId: record.correlationId,
        operation: "POST /api/gateway/setup",
        source: "gateway-setup.audit",
        error,
        redact: bodyFreeAuditStoreFailure,
      }),
    );
  }
}

interface SetupDiscoveryReport {
  readonly unsupportedModels?: readonly GatewayUnsupportedDiscoveredModel[];
  readonly unverifiedEmbeddingModelIds?: readonly string[];
  readonly droppedEmbeddingModelIds?: readonly string[];
  readonly unverifiedChatModelIds?: readonly string[];
}

function setupSuccessResult(
  config: GatewayConfig,
  testedModelIds: readonly string[],
  skippedModelIds: readonly string[],
  discoveryReport: SetupDiscoveryReport = {},
): RouteResult {
  const testedModelId = testedModelIds[0] ?? "unknown";
  return {
    status: 200,
    body: {
      ok: true,
      testedModelId,
      testedModelIds,
      skippedModelIds,
      // The operator learns which models the gateway offered that Keiko will not use, and why —
      // silence here is what made a misconfigured gateway undiagnosable in the field.
      ...(discoveryReport.unsupportedModels !== undefined
        ? { unsupportedModels: discoveryReport.unsupportedModels }
        : {}),
      ...(discoveryReport.unverifiedEmbeddingModelIds !== undefined
        ? { unverifiedEmbeddingModelIds: discoveryReport.unverifiedEmbeddingModelIds }
        : {}),
      ...(discoveryReport.droppedEmbeddingModelIds !== undefined
        ? { droppedEmbeddingModelIds: discoveryReport.droppedEmbeddingModelIds }
        : {}),
      ...(discoveryReport.unverifiedChatModelIds !== undefined
        ? { unverifiedChatModelIds: discoveryReport.unverifiedChatModelIds }
        : {}),
      providerCount: config.providers.length,
      models: listConfiguredCapabilities(config),
      config: toSafeObject(config),
    },
  };
}

function setupFailureResult(
  errors: readonly string[],
  correlationId: string | undefined,
): RouteResult {
  return {
    status: 502,
    body: errorBody(
      "GATEWAY_SETUP_FAILED",
      `Credentials could not be verified. ${errors.join(" ")}`,
      correlationId,
    ),
  };
}

const SETUP_CANDIDATE_NETWORK_FAILURE =
  "The local setup service could not reach the provider endpoint. Check internet access, VPN/proxy/firewall, and the base URL.";
const SETUP_CANDIDATE_AUTH_FAILURE =
  "The provider rejected the credential. Check the API key, endpoint URL, and project/model access.";
const SETUP_CANDIDATE_RATE_LIMIT_FAILURE =
  "The provider rate-limited setup verification. Wait briefly and retry.";
const SETUP_CANDIDATE_MODEL_FAILURE =
  "The provider endpoint responded, but no discovered model accepted the chat smoke test. Enter a chat-capable model or deployment name and retry.";

const SETUP_NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  "EACCES",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  ERROR_CODES.TRANSPORT,
  ERROR_CODES.TIMEOUT,
  ERROR_CODES.PROXY_UNREACHABLE,
  ERROR_CODES.PROXY_AUTH_REQUIRED,
  ERROR_CODES.PROXY_EGRESS_FAILED,
  ERROR_CODES.PROXY_BLOCKED_BY_POLICY,
  ERROR_CODES.TLS_CA_FAILURE,
]);

// Temporary admission activates an otherwise unverified configuration, so its classifier is
// intentionally narrower than the operator-facing "network failure" guidance above. DNS,
// access-control, refused-connection, proxy-policy, and TLS failures are actionable configuration
// faults and must fail closed rather than be silently persisted as an active gateway.
const TEMPORARY_SETUP_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  ERROR_CODES.TIMEOUT,
]);

function safeErrorProperty(error: unknown, property: string): unknown {
  if ((typeof error !== "object" || error === null) && typeof error !== "function") {
    return undefined;
  }
  try {
    return Reflect.get(error, property);
  } catch {
    return undefined;
  }
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function enqueueSetupError(value: unknown, pending: unknown[], seen: WeakSet<object>): void {
  if (!isObjectLike(value) || seen.has(value)) {
    return;
  }
  seen.add(value);
  pending.push(value);
}

function setupErrorValue<T>(
  error: unknown,
  property: string,
  accepts: (value: unknown) => value is T,
): T | undefined {
  const pending: unknown[] = [];
  const seen = new WeakSet();
  enqueueSetupError(error, pending, seen);
  for (const current of pending) {
    const value = safeErrorProperty(current, property);
    if (accepts(value)) return value;
    enqueueSetupError(safeErrorProperty(current, "cause"), pending, seen);
    const nested = safeErrorProperty(current, "errors");
    if (Array.isArray(nested)) {
      for (const item of nested) {
        enqueueSetupError(item, pending, seen);
      }
    }
  }
  return undefined;
}

function setupErrorCode(error: unknown): string | undefined {
  return setupErrorValue(error, "code", (value): value is string => typeof value === "string");
}

function setupHttpStatus(error: unknown): number | undefined {
  const isStatus = (value: unknown): value is number =>
    typeof value === "number" && Number.isInteger(value);
  return (
    setupErrorValue(error, "httpStatus", isStatus) ?? setupErrorValue(error, "status", isStatus)
  );
}

function figmaFailureStatus(code: FigmaConnectorErrorCode): number {
  switch (code) {
    case "FIGMA_TOKEN_INVALID":
    case "FIGMA_TOKEN_EXPIRED":
    case "FIGMA_TOKEN_REVOKED":
    case "FIGMA_INSUFFICIENT_SCOPE":
    case "FIGMA_CONSENT_REQUIRED":
      return 400;
    case "FIGMA_RATE_LIMITED":
      return 429;
    default:
      return 502;
  }
}

function figmaCredentialFailureResult(
  error: unknown,
  correlationId: string | undefined,
): RouteResult {
  if (error instanceof FigmaConnectorError) {
    return {
      status: figmaFailureStatus(error.code),
      body: errorBody(error.code, error.message, correlationId),
    };
  }
  return {
    status: 502,
    body: errorBody("FIGMA_EGRESS_FAILED", bodyFreeVerificationFailure(), correlationId),
  };
}

async function verifySubmittedFigmaCredential(
  request: SetupRequest,
  deps: UiHandlerDeps,
): Promise<RouteResult | undefined> {
  if (!request.verifyFigmaCredential || request.figmaAccessToken === undefined) {
    return undefined;
  }
  const tester: FigmaCredentialTester = deps.figmaCredentialTester ?? defaultFigmaCredentialTester;
  try {
    await tester(request.figmaAccessToken, currentGatewayEgressConfig(deps));
    return undefined;
  } catch (error) {
    if (!(error instanceof FigmaConnectorError)) {
      reportSetupVerificationFailure(
        deps,
        error,
        request.correlationId,
        "gateway.setup.figma-verify",
      );
    }
    return figmaCredentialFailureResult(error, request.correlationId);
  }
}

function deploymentNamesRequiredResult(): RouteResult {
  return {
    status: 400,
    body: errorBody(
      "GATEWAY_DEPLOYMENTS_REQUIRED",
      "Azure AI Foundry endpoints require deployment names from the Deployments tab.",
    ),
  };
}

interface ParsedSetupBody {
  readonly parsed: unknown;
}

async function readJsonSetupBody(ctx: RouteContext): Promise<ParsedSetupBody | RouteResult> {
  let bodyText: string;
  try {
    bodyText = await readBody(ctx.req);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return {
        status: 413,
        body: errorBody("PAYLOAD_TOO_LARGE", "Request body exceeds the size limit."),
      };
    }
    throw error;
  }
  try {
    return { parsed: JSON.parse(bodyText) as unknown };
  } catch {
    return { status: 400, body: errorBody("BAD_REQUEST", "Request body is not valid JSON.") };
  }
}

function gatewayUnavailableResult(): RouteResult {
  return {
    status: 500,
    body: errorBody("GATEWAY_SETUP_UNAVAILABLE", "Gateway setup is unavailable."),
  };
}

function finalizeVerifiedCandidate(
  verified: VerifiedSetup,
  current: GatewayConfig | undefined,
  deps: UiHandlerDeps,
  gatewayConfig: RuntimeGatewayConfig,
  request: SetupRequest,
): RouteResult {
  persistGatewayConfig(
    withDiskGatewayEgress(
      verified.rawConfig,
      gatewayConfig.storagePath,
      deps,
      current === undefined,
      request.correlationId,
    ),
    gatewayConfig.storagePath,
    deps,
  );
  gatewayConfig.set(verified.config, true);
  recordGatewaySetupAudit(deps, request, verified.config, "candidate-accepted");
  return setupSuccessResult(verified.config, verified.testedModelIds, verified.skippedModelIds, {
    ...(verified.unsupportedModels !== undefined
      ? { unsupportedModels: verified.unsupportedModels }
      : {}),
    ...(verified.unverifiedEmbeddingModelIds !== undefined
      ? { unverifiedEmbeddingModelIds: verified.unverifiedEmbeddingModelIds }
      : {}),
    ...(verified.droppedEmbeddingModelIds !== undefined
      ? { droppedEmbeddingModelIds: verified.droppedEmbeddingModelIds }
      : {}),
    ...(verified.unverifiedChatModelIds !== undefined
      ? { unverifiedChatModelIds: verified.unverifiedChatModelIds }
      : {}),
  });
}

/** The three injectable gateway seams, travelling together so the candidate loop stays readable. */
interface SetupSeams {
  readonly tester: GatewaySetupTester;
  readonly discovery: GatewayModelDiscovery;
  readonly embeddingProbe: GatewayEmbeddingProbe;
}

async function trySetupCandidate(
  baseUrl: string,
  request: SetupRequest,
  deps: UiHandlerDeps,
  gatewayConfig: RuntimeGatewayConfig,
  seams: SetupSeams,
  current: GatewayConfig | undefined,
): Promise<RouteResult> {
  const verified = await verifySetupCandidate({
    embeddingProbe: seams.embeddingProbe,
    preserveExisting: request.preserveExisting,
    baseUrl,
    apiKey: request.apiKey,
    apiKeyHeaderName: request.apiKeyHeaderName,
    endpointStyle: request.endpointStyle,
    apiVersion: request.apiVersion,
    timeoutMs: request.timeoutMs,
    deploymentNames: request.deploymentNames,
    imageInputModelIds: request.imageInputModelIds,
    imageInputModelIdsProvided: request.imageInputModelIdsProvided,
    storedEmbeddingModelIds: request.storedEmbeddingModelIds,
    submittedEmbeddingModelIds: request.submittedEmbeddingModelIds,
    storedOcrModelIds: request.storedOcrModelIds,
    storedDedicatedEmbeddingModelIds: request.storedDedicatedEmbeddingModelIds,
    storedVoiceModelIds: request.storedVoiceModelIds,
    stored: request.stored,
    workflowEligibleModelIds: request.workflowEligibleModelIdsConfigured
      ? request.workflowEligibleModelIds
      : undefined,
    voiceProviders: request.voiceProviders,
    tester: seams.tester,
    discovery: seams.discovery,
    env: deps.env,
    egress: egressForCandidateValidation(deps),
    figmaAccessToken: request.figmaAccessToken,
    current,
    diagnostics: deps.diagnostics,
    correlationId: request.correlationId,
  });
  const workflowEligibilityError = validateWorkflowEligibleModelIds(request, verified.config);
  if (workflowEligibilityError !== undefined) return workflowEligibilityError;
  return finalizeVerifiedCandidate(verified, current, deps, gatewayConfig, request);
}

// The runtime aggregate in `current.egress` can carry ENVIRONMENT-derived egress (proxy, CA
// bundle, private-network opt-in). On a preserve-mode rebuild only what the stored file itself
// declares may reach disk — persisting the aggregate would keep an env opt-in active from disk
// after the environment is cleared (review finding on #3037; the settings-only path draws the
// same distinction through withPersistedGatewayEgress). The same rule applies on a FRESH setup:
// its storage path may be the operator's bootstrap config file, so its file-declared egress must
// survive the first verified save while environment-derived egress remains transient. The runtime
// config handed to gatewayConfig.set keeps the full aggregate either way — behavior in the running
// process is unchanged.
function withDiskGatewayEgress(
  raw: Record<string, unknown>,
  storagePath: string,
  deps: UiHandlerDeps,
  ignoreInvalidStoredConfig = false,
  correlationId?: string,
): Record<string, unknown> {
  const withoutEgress = { ...raw };
  delete withoutEgress.egress;
  try {
    return withPersistedGatewayEgress(withoutEgress, storagePath, deps);
  } catch (error) {
    if (ignoreInvalidStoredConfig && error instanceof ConfigInvalidError) {
      emitServerDiagnostic(
        deps.diagnostics,
        serverDiagnosticFromError({
          correlationId: correlationId ?? UNKNOWN_CORRELATION_ID,
          operation: "POST /api/gateway/setup",
          source: "gateway-setup.egress",
          error,
          summary:
            "Stored gateway egress configuration was invalid; setup omitted it from the rewritten file.",
          redact: () =>
            "Stored gateway egress configuration was invalid; setup omitted it from the rewritten file.",
        }),
      );
      return withoutEgress;
    }
    throw error;
  }
}

// Per-model CONNECTION-IDENTITY overrides (base URL, api key, credential header) are the
// TRANSIENT operator state that can hide a durable file-level sharing relationship — exactly the
// three fields sharesStoredGatewayConnection compares. Only they are masked. Per-model PROTOCOL
// overrides (API version, endpoint style, ...) stay: they cannot skew connection identity, and a
// stored Azure provider whose apiVersion arrives only via env NEEDS them to parse at all —
// masking the whole namespace made the durable parse fail and silently fall back to the
// misclassified runtime view (review finding on #3040). Global fallbacks stay too: they apply to
// every provider uniformly and cannot make one stored connection diverge from another's.
const PER_MODEL_CONNECTION_OVERRIDE_RE =
  /^KEIKO_MODEL_.+_(?:BASE_URL|API_KEY|API_KEY_HEADER_NAME)$/u;

function withoutPerModelEnvOverrides(env: EnvSource): EnvSource {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !PER_MODEL_CONNECTION_OVERRIDE_RE.test(name)),
  );
}

// The DURABLE connection identities for preserve-mode classification: the persisted file at
// storagePath, vault references resolved, per-model env overrides masked. The runtime
// GatewayConfig folds those overrides in, so a transient KEIKO_MODEL_<ID>_BASE_URL or _API_KEY
// on one shared provider made the durable file-level sharing relationship invisible — a
// credential rotation then restored the other provider as "dedicated" with its already-dead
// token (review finding on #3037; the same disk-vs-runtime distinction withDiskGatewayEgress
// draws for egress). Falls back to the runtime view when nothing is stored yet or the stored
// file cannot be parsed — exactly the pre-existing behavior for those states.
function durableStoredGatewayConfig(
  current: GatewayConfig | undefined,
  storagePath: string,
  deps: UiHandlerDeps,
): GatewayConfig | undefined {
  if (current === undefined || !existsSync(storagePath)) return current;
  try {
    const parsed = loadConfigFromFile(storagePath, withoutPerModelEnvOverrides(deps.env), {
      ...linkLocalGatewayOverrideOptions(deps.env),
      secretResolver: createProviderSecretResolver({
        configPath: storagePath,
        env: deps.env,
        securityLogSink: processServerLogSink(),
      }),
    });
    // Inside the success path on purpose: on a fall-back the returned config is the RUNTIME one,
    // and rewriting it from a file the parser just rejected would apply records from an invalid
    // configuration to a valid view (review finding on #3046).
    return withFileDeclaredProtocol(parsed, storagePath);
  } catch (error) {
    if (error instanceof GatewayError) return current;
    throw error;
  }
}

// What the FILE itself declares as each provider's protocol. `durableStoredGatewayConfig` parses
// with the environment applied — deliberately, because a stored Azure provider whose api version
// arrives only through KEIKO_MODEL_<ID>_API_VERSION needs it to parse at all (#3040) — so the
// parsed protocol can be an env value the file never contained. Inheriting THAT on a rotation
// would seal a transient default into the sealed config, and removing the variable afterwards
// would no longer restore the file's own behavior (review finding on #3046). Correcting after
// the parse keeps the #3040 fix intact: nothing is masked, only the values the file does not
// declare are dropped from the durable view.
function withFileDeclaredProtocol(
  config: GatewayConfig | undefined,
  storagePath: string,
): GatewayConfig | undefined {
  if (config === undefined || !existsSync(storagePath)) return config;
  const declared = fileDeclaredProviderRecords(storagePath);
  if (declared === undefined) return config;
  return {
    ...config,
    providers: config.providers.map((provider) => {
      const raw = declared.get(provider.modelId);
      if (raw === undefined) return provider;
      // The FILE's own value wins over the resolved one: a KEIKO_MODEL_<ID>_API_VERSION that
      // overrides a DECLARED version would otherwise be sealed in by a rotation just as an
      // undeclared one would (review finding on #3046). An unrecognised declared style is left
      // as parsed — the parser is the authority on what a style may be.
      return { ...provider, ...fileDeclaredProtocol(raw, provider) };
    }),
  };
}

// The protocol the FILE declares, kept COHERENT. Each half falls back to the resolved value when
// the other half is declared and the canonical pairing needs it: a file that declares the Azure
// deployment path and takes its required version from KEIKO_MODEL_<ID>_API_VERSION is only valid
// with that version, and a file that declares the version while the style arrives through
// KEIKO_DEFAULT_ENDPOINT_STYLE is only valid with that style. Dropping the env half of either
// pair left the durable view incoherent, and inheritance then rejected a routine credential
// rotation with 400 (review findings on #3046 — the same coherence argument that stopped #3040
// from masking that namespace at parse time).
function fileDeclaredProtocol(
  raw: Record<string, unknown>,
  provider: ModelProviderConfig,
): Pick<ModelProviderConfig, "endpointStyle" | "apiVersion"> {
  const style = declaredEndpointStyle(raw.endpointStyle, provider.endpointStyle);
  const version = typeof raw.apiVersion === "string" ? raw.apiVersion : undefined;
  if (style === "azure-openai-deployment" && version === undefined) {
    return { endpointStyle: style, apiVersion: provider.apiVersion };
  }
  if (version !== undefined && style === undefined) {
    return { endpointStyle: provider.endpointStyle, apiVersion: version };
  }
  return { endpointStyle: style, apiVersion: version };
}

// An unrecognised declared style is left as parsed — the parser is the authority on what a style
// may be.
function declaredEndpointStyle(
  raw: unknown,
  resolved: ModelProviderConfig["endpointStyle"],
): ModelProviderConfig["endpointStyle"] {
  if (typeof raw !== "string") return undefined;
  const declared = PROVIDER_ENDPOINT_STYLES.find((style) => style === raw);
  return declared ?? resolved;
}

function fileDeclaredProviderRecords(
  storagePath: string,
): ReadonlyMap<string, Record<string, unknown>> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(storagePath, "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.providers)) return undefined;
    return new Map(
      parsed.providers.flatMap((entry) =>
        isRecord(entry) && typeof entry.modelId === "string"
          ? ([[entry.modelId, entry]] as const)
          : [],
      ),
    );
  } catch {
    // An unreadable or malformed file leaves the durable view exactly as parsed — the same
    // fall-back durableStoredGatewayConfig makes for that state.
    return undefined;
  }
}

function validateWorkflowEligibleModelIds(
  request: SetupRequest,
  config: GatewayConfig,
): RouteResult | undefined {
  if (!request.workflowEligibleModelIdsConfigured) return undefined;
  const chatModelIds = new Set(
    listConfiguredCapabilities(config)
      .filter((capability) => capability.kind === "chat")
      .map((capability) => capability.id),
  );
  if (request.workflowEligibleModelIds.every((modelId) => chatModelIds.has(modelId))) {
    return undefined;
  }
  return {
    status: 400,
    body: errorBody(
      "BAD_REQUEST",
      "workflowEligibleModelIds must reference configured chat models.",
      request.correlationId,
    ),
  };
}

function setupCandidateError(error: unknown): string {
  const code = setupErrorCode(error);
  if (code === ERROR_CODES.AUTHENTICATION) {
    return SETUP_CANDIDATE_AUTH_FAILURE;
  }
  if (code === ERROR_CODES.RATE_LIMIT) {
    return SETUP_CANDIDATE_RATE_LIMIT_FAILURE;
  }
  if (code === ERROR_CODES.UNKNOWN_MODEL) {
    return SETUP_CANDIDATE_MODEL_FAILURE;
  }
  if (code !== undefined && SETUP_NETWORK_ERROR_CODES.has(code)) {
    return SETUP_CANDIDATE_NETWORK_FAILURE;
  }
  const status = setupHttpStatus(error);
  if (status === 401 || status === 403) {
    return SETUP_CANDIDATE_AUTH_FAILURE;
  }
  if (status === 429) {
    return SETUP_CANDIDATE_RATE_LIMIT_FAILURE;
  }
  if (status === 404) {
    return SETUP_CANDIDATE_MODEL_FAILURE;
  }
  return bodyFreeVerificationFailure();
}

function withWorkflowEligibilityPatch(request: SetupRequest, config: GatewayConfig): GatewayConfig {
  if (!request.workflowEligibleModelIdsConfigured) return config;
  return {
    ...config,
    capabilities: listConfiguredCapabilities(config).map((capability) => ({
      ...capability,
      ...workflowCapabilityFields(
        capability.id,
        capability,
        capability,
        request.workflowEligibleModelIds,
      ),
    })),
  };
}

// Image flags patch in place for clears and shrinks — only NEW image claims take the verified
// rebuild (review findings on #3031/#3037). Same shape as the workflow-eligibility patch.
function withImageFlagPatch(request: SetupRequest, config: GatewayConfig): GatewayConfig {
  if (!request.imageInputModelIdsProvided) return config;
  return {
    ...config,
    capabilities: listConfiguredCapabilities(config).map((capability) => ({
      ...capability,
      ...(capability.kind === "chat"
        ? { supportsImageInput: request.imageInputModelIds.includes(capability.id) }
        : {}),
    })),
  };
}

function saveExistingConfigUpdate(
  request: SetupRequest,
  current: GatewayConfig,
  deps: UiHandlerDeps,
  gatewayConfig: RuntimeGatewayConfig,
): RouteResult {
  const workflowEligibilityError = validateWorkflowEligibleModelIds(request, current);
  if (workflowEligibilityError !== undefined) return workflowEligibilityError;
  const updatedCurrent = withImageFlagPatch(
    request,
    withWorkflowEligibilityPatch(request, current),
  );
  const rawConfig = applyVoiceProviders(
    rawConfigFromCurrent(updatedCurrent, request.figmaAccessToken, request.timeoutMs),
    request.voiceProviders,
  );
  const persistedRawConfig = withPersistedGatewayEgress(rawConfig, gatewayConfig.storagePath, deps);
  const config = parseGatewayConfig(
    withInheritedEgress(persistedRawConfig, currentGatewayEgressConfig(deps)),
    deps.env,
    linkLocalGatewayOverrideOptions(deps.env),
  );
  persistGatewayConfig(persistedRawConfig, gatewayConfig.storagePath, deps);
  gatewayConfig.set(config, true);
  recordGatewaySetupAudit(deps, request, config, "existing-config-updated");
  return setupSuccessResult(
    config,
    config.providers.map((provider) => provider.modelId),
    [],
  );
}

async function verifyAndSaveExistingConfigUpdate(
  request: SetupRequest,
  current: GatewayConfig,
  deps: UiHandlerDeps,
  gatewayConfig: RuntimeGatewayConfig,
): Promise<RouteResult> {
  const figmaFailure = await verifySubmittedFigmaCredential(request, deps);
  if (figmaFailure !== undefined) {
    return figmaFailure;
  }
  return saveExistingConfigUpdate(request, current, deps, gatewayConfig);
}

function shouldRequireDeploymentNames(
  request: SetupRequest,
  baseUrlCandidates: readonly string[],
  env: EnvSource,
): boolean {
  if (request.deploymentNames.length !== 0) return false;
  // The deployment path IS the requirement: a classic Azure OpenAI host on that path cannot be
  // discovered through generic /models, so without this it failed at discovery instead of naming
  // the missing deployments (review finding on #3046). The EFFECTIVE style decides — a request
  // that omits the field still lands on the deployment path when KEIKO_DEFAULT_ENDPOINT_STYLE
  // says so, and discovery would fail exactly the same way.
  const effectiveStyle = request.endpointStyle ?? env.KEIKO_DEFAULT_ENDPOINT_STYLE;
  if (effectiveStyle === "azure-openai-deployment") return true;
  return baseUrlCandidates.some((baseUrl) => isAzureFoundryBaseUrl(baseUrl));
}

async function verifyAndSaveGatewaySetup(
  request: SetupRequest,
  current: GatewayConfig | undefined,
  deps: UiHandlerDeps,
  gatewayConfig: RuntimeGatewayConfig,
): Promise<RouteResult> {
  const seams: SetupSeams = {
    tester: gatewaySetupTester(deps, request.correlationId),
    embeddingProbe: gatewayEmbeddingProbe(deps),
    discovery: deps.gatewayModelDiscovery ?? defaultGatewayModelDiscovery,
  };
  const figmaFailure = await verifySubmittedFigmaCredential(request, deps);
  if (figmaFailure !== undefined) {
    return figmaFailure;
  }
  const baseUrlCandidates = candidateBaseUrls(request.baseUrl);
  if (shouldRequireDeploymentNames(request, baseUrlCandidates, deps.env)) {
    return deploymentNamesRequiredResult();
  }
  const attempted = await attemptSetupCandidates(
    baseUrlCandidates,
    request,
    deps,
    gatewayConfig,
    seams,
    current,
  );
  if (attempted.result !== undefined) return attempted.result;
  return temporaryAdmissionOrFailure(attempted.failures, request, deps, gatewayConfig, current);
}

interface SetupCandidateFailure {
  readonly baseUrl: string;
  readonly error: unknown;
  readonly resumeTemporaryAdmission?: (() => VerifiedSetup) | undefined;
}

class DeferredTemporaryChatAdmission extends Error {
  public constructor(
    readonly original: unknown,
    readonly resume: () => VerifiedSetup,
  ) {
    super("Gateway setup chat admission was deferred after a temporary probe failure.");
  }
}

interface SetupCandidateAttempts {
  readonly failures: SetupCandidateFailure[];
  readonly result?: RouteResult | undefined;
}

async function attemptSetupCandidates(
  baseUrlCandidates: readonly string[],
  request: SetupRequest,
  deps: UiHandlerDeps,
  gatewayConfig: RuntimeGatewayConfig,
  seams: SetupSeams,
  current: GatewayConfig | undefined,
): Promise<SetupCandidateAttempts> {
  const failures: SetupCandidateFailure[] = [];
  for (const baseUrl of baseUrlCandidates) {
    try {
      const result = await trySetupCandidate(baseUrl, request, deps, gatewayConfig, seams, current);
      return { failures, result };
    } catch (error) {
      reportSetupVerificationFailure(
        deps,
        error,
        request.correlationId,
        "gateway.setup.provider-verify",
      );
      failures.push({
        baseUrl,
        error: error instanceof DeferredTemporaryChatAdmission ? error.original : error,
        ...(error instanceof DeferredTemporaryChatAdmission
          ? { resumeTemporaryAdmission: error.resume }
          : {}),
      });
    }
  }
  return { failures };
}

function temporaryAdmissionOrFailure(
  failures: SetupCandidateFailure[],
  request: SetupRequest,
  deps: UiHandlerDeps,
  gatewayConfig: RuntimeGatewayConfig,
  current: GatewayConfig | undefined,
): RouteResult {
  const temporary = failures.find(
    (failure) =>
      temporaryGatewaySetupFailure(failure.error) && failure.resumeTemporaryAdmission !== undefined,
  );
  const resume = temporary?.resumeTemporaryAdmission;
  if (
    resume !== undefined &&
    !failures.some((failure) => definitiveGatewaySetupFailure(failure.error))
  ) {
    try {
      return finalizeVerifiedCandidate(resume(), current, deps, gatewayConfig, request);
    } catch (error) {
      reportSetupVerificationFailure(
        deps,
        error,
        request.correlationId,
        "gateway.setup.provider-verify",
      );
      failures.push({ baseUrl: temporary?.baseUrl ?? request.baseUrl, error });
    }
  }
  return setupFailureResult(candidateFailureMessages(failures), request.correlationId);
}

function candidateFailureMessages(failures: readonly SetupCandidateFailure[]): readonly string[] {
  return failures.map(
    (failure, index) => `candidate ${String(index + 1)}: ${setupCandidateError(failure.error)}`,
  );
}

export async function handleGatewaySetup(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  if (deps.gatewayConfig === undefined) {
    return gatewayUnavailableResult();
  }
  const { gatewayConfig } = deps;
  const current = currentGatewayConfig(deps);
  const stored = durableStoredGatewayConfig(current, gatewayConfig.storagePath, deps);
  const bodyResult = await readJsonSetupBody(ctx);
  if ("status" in bodyResult) {
    return bodyResult;
  }
  const request = readSetupRequest(bodyResult.parsed, deps.env, current, stored, ctx.correlationId);
  if ("status" in request) {
    return request;
  }
  if (!request.verifyGateway && current !== undefined) {
    return verifyAndSaveExistingConfigUpdate(request, current, deps, gatewayConfig);
  }
  return verifyAndSaveGatewaySetup(request, current, deps, gatewayConfig);
}

const VERIFIED_CAPABILITY_FIELDS = new Set<keyof VerifiedModelCapabilityFields>([
  "streaming",
  "toolCalling",
  "structuredOutput",
  "supportsImageInput",
  "supportsDocumentInput",
]);

interface CapabilityApplyRequest {
  readonly fields: VerifiedModelCapabilityFields;
}

function verifiedFieldValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseCapabilityApplyRequest(value: unknown): CapabilityApplyRequest | RouteResult {
  if (!isRecord(value) || !isRecord(value.fields)) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "Verified capability fields are required."),
    };
  }
  const entries = Object.entries(value.fields);
  if (entries.length === 0) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "At least one verified field is required."),
    };
  }
  const fields: Record<string, boolean | number> = {};
  for (const [field, rawValue] of entries) {
    if (!VERIFIED_CAPABILITY_FIELDS.has(field as keyof VerifiedModelCapabilityFields)) {
      return {
        status: 400,
        body: errorBody("BAD_REQUEST", "An unsupported capability field was supplied."),
      };
    }
    const parsed = verifiedFieldValue(rawValue);
    if (parsed === undefined) {
      return { status: 400, body: errorBody("BAD_REQUEST", "A capability value is invalid.") };
    }
    fields[field] = parsed;
  }
  return { fields };
}

function decodeModelId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const decoded = decodeURIComponent(value).trim();
    return decoded.length > 0 && decoded.length <= MAX_MODEL_ID_LENGTH ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function fieldsMatchObservation(
  requested: VerifiedModelCapabilityFields,
  observed: VerifiedModelCapabilityFields,
): boolean {
  return Object.entries(requested).every(
    ([field, value]) => observed[field as keyof VerifiedModelCapabilityFields] === value,
  );
}

function replaceModelCapability(
  config: GatewayConfig,
  modelId: string,
  fields: VerifiedModelCapabilityFields,
  checkedAt = new Date().toISOString(),
  toolCallingStatus?: ToolCallingVerification["status"],
): GatewayConfig | undefined {
  const current = findConfiguredCapability(config, modelId);
  if (current === undefined) return undefined;
  const capabilities = [...(config.capabilities ?? [])];
  const explicitIndex = capabilities.findIndex((capability) => capability.id === modelId);
  const responseFormatFields = responseFormatCapabilityFields(fields);
  const toolCallingVerification = toolCallingVerificationFields(
    config,
    modelId,
    fields,
    checkedAt,
    toolCallingStatus,
  );
  const replacement = {
    ...current,
    ...fields,
    ...(fields.toolCalling === true
      ? {
          knownLimitations: current.knownLimitations.filter(
            (limitation) => limitation !== MISTRAL_TOOL_CALLING_LIMITATION,
          ),
        }
      : {}),
    ...responseFormatFields,
    ...toolCallingVerification,
  };
  if (explicitIndex === -1) capabilities.push(replacement);
  else capabilities[explicitIndex] = replacement;
  return {
    ...config,
    capabilities,
  };
}

function responseFormatCapabilityFields(
  fields: VerifiedModelCapabilityFields,
): Partial<ModelCapability> {
  // The json_schema readiness probe verifies the strict response_format request shape used by QI.
  // Keep the public structured-output field and the provider request-capability flag in lockstep.
  return fields.structuredOutput === undefined
    ? {}
    : { supportsResponseFormat: fields.structuredOutput };
}

function toolCallingVerificationFields(
  config: GatewayConfig,
  modelId: string,
  fields: VerifiedModelCapabilityFields,
  checkedAt: string,
  status: ToolCallingVerification["status"] | undefined,
): Partial<ModelCapability> {
  const provider = config.providers.find((candidate) => candidate.modelId === modelId);
  if (fields.toolCalling === undefined || provider === undefined) return {};
  return {
    toolCallingVerification: {
      status: status ?? (fields.toolCalling ? "verified" : "unsupported"),
      checkedAt,
      probe: "gateway-tool-calling-v1",
      configurationFingerprint: toolCallingConfigurationFingerprint(provider),
    },
  };
}

function staleCapabilityObservationResult(): RouteResult {
  return {
    status: 409,
    body: errorBody(
      "GATEWAY_CAPABILITY_OBSERVATION_STALE",
      "Run readiness again before applying verified capability values.",
    ),
  };
}

function capabilityObservationMatches(
  gatewayConfig: RuntimeGatewayConfig,
  modelId: string,
  fields: VerifiedModelCapabilityFields,
  generation: number,
  current: GatewayConfig,
): boolean {
  const observation = gatewayConfig.verifiedCapability(modelId);
  return (
    observation?.generation === generation &&
    fieldsMatchObservation(fields, observation.fields) &&
    gatewayConfig.generation() === generation &&
    gatewayConfig.current() === current
  );
}

function persistedGatewayEgress(storagePath: string): unknown {
  if (!existsSync(storagePath)) return undefined;
  let persisted: unknown;
  try {
    persisted = JSON.parse(readFileSync(storagePath, "utf8")) as unknown;
  } catch {
    throw new ConfigInvalidError("Stored gateway config cannot be safely updated.");
  }
  if (!isRecord(persisted)) {
    throw new ConfigInvalidError("Stored gateway config cannot be safely updated.");
  }
  return persisted.egress;
}

function withPersistedGatewayEgress(
  raw: Record<string, unknown>,
  storagePath: string,
  deps: UiHandlerDeps,
): Record<string, unknown> {
  const egress = persistedGatewayEgress(storagePath);
  if (egress === undefined) return raw;
  const withEgress = { ...raw, egress };
  parseGatewayConfig(withEgress, deps.env, linkLocalGatewayOverrideOptions(deps.env));
  return withEgress;
}

function rawConfigForVerifiedCapabilityUpdate(
  updated: GatewayConfig,
  storagePath: string,
  deps: UiHandlerDeps,
): Record<string, unknown> {
  const raw = rawConfigFromCurrent(updated, updated.figma?.accessToken);
  return withPersistedGatewayEgress(raw, storagePath, deps);
}

function persistVerifiedCapabilityUpdate(
  gatewayConfig: RuntimeGatewayConfig,
  deps: UiHandlerDeps,
  modelId: string,
  generation: number,
  updated: GatewayConfig,
  consumeObservation = true,
): RouteResult {
  const raw = rawConfigForVerifiedCapabilityUpdate(updated, gatewayConfig.storagePath, deps);
  try {
    persistGatewayConfig(raw, gatewayConfig.storagePath, deps);
  } catch (error) {
    // A live negative tool verdict must take effect even if its durable evidence cannot be saved.
    // Continuing to route tool calls on the old in-memory proof would widen authority exactly when
    // the latest provider observation says it is no longer justified.
    if (!consumeObservation) {
      applyVerifiedCapabilityUpdate(gatewayConfig, modelId, generation, updated, false);
    }
    throw error;
  }
  return applyVerifiedCapabilityUpdate(
    gatewayConfig,
    modelId,
    generation,
    updated,
    consumeObservation,
  );
}

function applyVerifiedCapabilityUpdate(
  gatewayConfig: RuntimeGatewayConfig,
  modelId: string,
  generation: number,
  updated: GatewayConfig,
  consumeObservation = true,
): RouteResult {
  // Persistence is synchronous, so no configuration mutation can interleave between the
  // generation check in the handler and this consumption. Keep the live observation available
  // when durable storage fails, allowing the operator to retry the exact verified update.
  // set() wipes EVERY model's verified-capability observation and bumps the generation —
  // correct for a credential/endpoint change, but THIS set applies values derived from a live
  // observation against unchanged connections. Config cannot carry conversationReady (it is
  // probe-only evidence), so preserve that one readiness fact across the wipe. Never replay
  // feature observations under a new generation: an unrelated apply must not re-stamp a model's
  // old tool proof as if the model had just been probed.
  const observations = updated.providers
    .map((provider) => ({
      modelId: provider.modelId,
      observation: gatewayConfig.verifiedCapability(provider.modelId),
    }))
    .filter((entry) => entry.observation !== undefined)
    .map((entry) => ({
      ...entry,
      fields: preservedVerifiedCapabilityFields(entry.observation?.fields ?? {}),
    }))
    .filter((entry) => Object.keys(entry.fields).length > 0);
  if (consumeObservation && !gatewayConfig.clearVerifiedCapability(modelId, generation)) {
    return staleCapabilityObservationResult();
  }
  gatewayConfig.set(updated, true);
  for (const entry of observations) {
    gatewayConfig.recordVerifiedCapability(
      entry.modelId,
      entry.fields,
      entry.observation?.checkedAt ?? new Date().toISOString(),
    );
  }
  return { status: 200, body: { ok: true, model: findConfiguredCapability(updated, modelId) } };
}

function preservedVerifiedCapabilityFields(
  fields: VerifiedModelCapabilityFields,
): VerifiedModelCapabilityFields {
  return fields.conversationReady === true ? { conversationReady: true } : {};
}

function toolCallingStatusFromReadiness(
  report: GatewayReadinessReport,
): "verified" | "unsupported" | undefined {
  const probe = report.probes.find((candidate) => candidate.name === "tool_calling");
  if (probe?.status === "passed") return "verified";
  if (probe?.status === "unsupported" && probe.capabilityObservation === false) {
    return "unsupported";
  }
  // A skipped, failed, or otherwise inconclusive probe is not evidence that a previously
  // verified deployment lost tool support. Keep the last proof until a real probe concludes.
  return undefined;
}

/** Persists the current readiness run's tool-calling conclusion without a second UI confirmation. */
export function reconcileGatewayToolCallingReadiness(
  deps: UiHandlerDeps,
  report: GatewayReadinessReport,
  observedGeneration: number | undefined,
  correlationId = UNKNOWN_CORRELATION_ID,
): void {
  const reconciliation = currentToolCallingReconciliation(deps, observedGeneration);
  if (reconciliation === undefined) return;
  if (!report.probes.some((probe) => probe.name === "tool_calling")) return;
  const status = toolCallingStatusFromReadiness(report);
  if (status === undefined) return;
  const updated = replaceModelCapability(
    reconciliation.current,
    report.modelId,
    { toolCalling: status === "verified" },
    report.checkedAt,
    status,
  );
  if (updated === undefined) return;
  logToolCallingVerification(
    reconciliation.current,
    report.modelId,
    status,
    correlationId,
    findConfiguredCapability(updated, report.modelId)?.toolCallingVerification
      ?.configurationFingerprint,
  );
  persistVerifiedCapabilityUpdate(
    reconciliation.gatewayConfig,
    deps,
    report.modelId,
    reconciliation.gatewayConfig.generation(),
    updated,
    false,
  );
}

function currentToolCallingReconciliation(
  deps: UiHandlerDeps,
  observedGeneration: number | undefined,
): { readonly gatewayConfig: RuntimeGatewayConfig; readonly current: GatewayConfig } | undefined {
  const gatewayConfig = deps.gatewayConfig;
  const current = gatewayConfig?.current();
  if (gatewayConfig === undefined || current === undefined) return undefined;
  return observedGeneration === undefined || gatewayConfig.generation() === observedGeneration
    ? { gatewayConfig, current }
    : undefined;
}

function logToolCallingVerification(
  config: GatewayConfig,
  modelId: string,
  status: ToolCallingVerification["status"],
  correlationId: string,
  configurationFingerprint?: string,
): void {
  const provider = config.providers.find((candidate) => candidate.modelId === modelId);
  const fingerprint =
    configurationFingerprint ??
    (provider === undefined ? undefined : toolCallingConfigurationFingerprint(provider));
  processServerLogSink().write({
    category: "gateway",
    op: "gateway.tool-calling.verification",
    correlationId,
    status: status === "verified" ? 200 : 503,
    ...(status === "verified" ? {} : { errorKind: status }),
    extra: {
      verificationStatus: status,
      ...(fingerprint === undefined ? {} : { configurationFingerprint: fingerprint }),
    },
  });
}

/** Applies only generation-current live observations after an explicit, human-confirmed request. */
export async function handleApplyGatewayVerifiedCapabilities(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const modelId = decodeModelId(ctx.params.modelId);
  const gatewayConfig = deps.gatewayConfig;
  if (modelId === undefined) {
    return { status: 400, body: errorBody("BAD_REQUEST", "A valid model id is required.") };
  }
  if (gatewayConfig === undefined) return gatewayUnavailableResult();
  const bodyResult = await readJsonSetupBody(ctx);
  if ("status" in bodyResult) return bodyResult;
  const request = parseCapabilityApplyRequest(bodyResult.parsed);
  if ("status" in request) return request;
  // Capture the configuration only after the asynchronous body read. From here through durable
  // persistence and the in-memory update the path is synchronous and generation-atomic.
  const current = gatewayConfig.current();
  const generation = gatewayConfig.generation();
  if (current === undefined) return gatewayUnavailableResult();
  const updated = replaceModelCapability(current, modelId, request.fields);
  if (updated === undefined) {
    return {
      status: 404,
      body: errorBody("MODEL_NOT_FOUND", "The configured model was not found."),
    };
  }
  if (!capabilityObservationMatches(gatewayConfig, modelId, request.fields, generation, current)) {
    return staleCapabilityObservationResult();
  }
  return persistVerifiedCapabilityUpdate(gatewayConfig, deps, modelId, generation, updated);
}
