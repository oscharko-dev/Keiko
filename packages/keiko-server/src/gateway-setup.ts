import {
  logAliasIntersection,
  logRerankerSetupResolution,
  type DiscoveryAliasRole,
  type RerankerSetupResolution,
} from "./gateway-discovery-log.js";
import { gatewaySpendBudgetForEnv, reserveGatewaySpendForAttempt } from "./gateway-spend-budget.js";
// First-run gateway setup for non-technical UI users. The browser provides a base URL, API token,
// and optionally a Figma PAT; the loopback BFF builds the local provider config, performs a real
// chat-completions smoke call, stores the resulting config on disk with private permissions, and
// updates the in-memory runtime config without exposing credentials back to the browser.

import { randomUUID } from "node:crypto";
import { causeChain, keikoStackFrames } from "@oscharko-dev/keiko-activity-log";
import { createRequestCancellation } from "./request-cancellation.js";
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
  isCompleteRealtimeVoiceCapability,
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
  isLikelyRerankModelId,
  modelKindForDeclaredMode,
} from "@oscharko-dev/keiko-contracts/runtime/gateway";
import {
  GATEWAY_SETUP_AUDIT_SCHEMA_VERSION,
  validateGatewaySetupAuditRecord,
} from "@oscharko-dev/keiko-contracts/runtime/gateway-setup-audit";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type {
  GatewayModelUnsupportedReason,
  ActivityLogErrorKind,
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
  RerankerConfig,
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
import { correlationIdOrUnknown, UNKNOWN_CORRELATION_ID } from "./correlation.js";
import {
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticSink,
} from "./diagnostics-log.js";
import { CONVERSATION_SYSTEM_PROMPT } from "./conversation-prompt.js";
import type { ServerLogSink } from "./observability/index.js";
import { logAutomaticCatalog } from "./gateway-startup-activity.js";
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
import { bindSecurityLogCorrelation } from "@oscharko-dev/keiko-security";
import { probeGatewayToolCalling, transientGatewayStatus } from "./gateway-tool-calling-probe.js";
import { requestRerankerProbe, rerankerProbePassed } from "./gateway-reranker-probe.js";

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
// #3591: the field customer's LiteLLM/vLLM gateway can take well over 15s to answer at peak load;
// raised so first-run discovery does not mistake a slow but healthy candidate for a broken one.
// A candidate the smoke probe never gets an answer from is now KEPT unverified instead of dropped
// (see `admitChatSmokeCandidates`) — this floor bounds how long that patience costs per candidate.
// `Gateway.chat()`'s own attempt/retry floors run far longer end to end (several minutes), so this
// value only actually bounds a probe through the per-candidate `cancellationSignal`
// `defaultGatewaySetupTester` composes from it (PR #3602 review). Exported so tests can pin the
// exact value instead of restating it (Issue #144 precedent — see `MAX_DISCOVERED_MODELS`).
export const DISCOVERED_MODEL_SMOKE_TIMEOUT_MS = 120_000;
const DEPLOYMENT_SMOKE_TIMEOUT_MS = 30_000;
const DISCOVERY_TIMEOUT_MS = 30_000;
const DISCOVERY_FALLBACK_RESERVE_MS = 5_000;
// The whole discovery smoke ROUND's own patience budget — distinct from the per-candidate ceiling
// above. Past this deadline no further candidate probe is even started: the remaining candidates
// are retained unverified without being called, so a large discovery batch of temporarily-transient
// candidates (rate-limited, briefly unreachable) can never block first-run setup for an unbounded
// time. The setup POST has no UI deadline and the server awaits the handler end to end, so this
// round bound is what actually protects first-run setup (PR #3602 review).
export const CHAT_SMOKE_ROUND_DEADLINE_MS = 600_000;

const GATEWAY_TOOL_CALLING_VERIFICATION_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.tool-calling.verification",
  category: "gateway",
  owner: "keiko-server",
  emitter: "gateway-setup.logToolCallingVerification",
  fields: {
    verificationStatus: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["verified", "unsupported", "unverified"],
    },
    configurationFingerprint: {
      type: "string",
      dataClass: "digest",
      required: false,
      maxLength: 64,
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "capability",
  failureClasses: ["gateway-tool-calling-capability"],
  proofIds: ["gateway.tool-calling.verification.line"],
  releaseImpact: "patch",
});
const GATEWAY_VOICE_SETUP_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.voice.setup.resolved",
  category: "gateway",
  owner: "keiko-server",
  emitter: "gateway-setup.logVoiceSetupResolution",
  fields: {
    speechInputModels: { type: "integer", dataClass: "count", required: true },
    usableSpeechOutputModels: { type: "integer", dataClass: "count", required: true },
    incompleteSpeechOutputModels: { type: "integer", dataClass: "count", required: true },
    usableRealtimeModels: { type: "integer", dataClass: "count", required: true },
    incompleteRealtimeModels: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "capability",
  failureClasses: ["gateway-voice-configuration"],
  proofIds: ["gateway.voice.setup.resolved.line"],
  releaseImpact: "minor",
});
const DISCOVERY_ROUTE_OUTCOME_FIELD = {
  type: "string",
  dataClass: "closed-enum",
  required: true,
  values: [
    "not-attempted",
    "available",
    "timeout",
    "http-error",
    "unusable",
    "transport-error",
    "cancelled",
    "failed",
  ],
} as const;

type DiscoveryRouteOutcome = (typeof DISCOVERY_ROUTE_OUTCOME_FIELD.values)[number];
interface SetupDiscoveryTrace {
  discoverySource: "custom" | "model-info" | "model-group-info" | "model-list";
  modelInfoOutcome: DiscoveryRouteOutcome;
  modelGroupInfoOutcome: DiscoveryRouteOutcome;
  modelListOutcome: DiscoveryRouteOutcome;
}

function createSetupDiscoveryTrace(): SetupDiscoveryTrace {
  return {
    discoverySource: "custom",
    modelInfoOutcome: "not-attempted",
    modelGroupInfoOutcome: "not-attempted",
    modelListOutcome: "not-attempted",
  };
}

const GATEWAY_SETUP_METADATA_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.setup.metadata.resolved",
  category: "gateway",
  owner: "keiko-server",
  emitter: "gateway-setup.logSetupMetadataOutcome",
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["available", "unavailable", "cancelled", "failed"],
    },
    discoverySource: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["custom", "model-info", "model-group-info", "model-list"],
    },
    modelInfoOutcome: DISCOVERY_ROUTE_OUTCOME_FIELD,
    modelGroupInfoOutcome: DISCOVERY_ROUTE_OUTCOME_FIELD,
    modelListOutcome: DISCOVERY_ROUTE_OUTCOME_FIELD,
    elapsedMs: { type: "integer", dataClass: "duration", required: true },
    selectedModelCount: { type: "integer", dataClass: "count", required: false },
    metadataEnrichedModelCount: { type: "integer", dataClass: "count", required: false },
    roleMismatchModelCount: { type: "integer", dataClass: "count", required: false },
    notDiscoveredModelCount: { type: "integer", dataClass: "count", required: false },
    httpStatus: { type: "integer", dataClass: "count", required: false },
    frames: {
      type: "string-array",
      dataClass: "safe-platform-class",
      required: false,
      maxItems: 8,
      maxLength: 512,
    },
    causeChain: {
      type: "string-array",
      dataClass: "error-kind",
      required: false,
      maxItems: 5,
      maxLength: 128,
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["gateway-setup-metadata"],
  proofIds: ["gateway.setup.metadata.resolved.line"],
  releaseImpact: "patch",
});

interface SetupMetadataSelectionCounts {
  readonly selectedModelCount: number;
  readonly metadataEnrichedModelCount: number;
  readonly roleMismatchModelCount: number;
  readonly notDiscoveredModelCount: number;
}

interface SetupMetadataFailure {
  readonly errorKind: ActivityLogErrorKind;
  readonly evidence: {
    readonly httpStatus?: number;
    readonly frames: readonly string[];
    readonly causeChain: readonly string[];
  };
}

type SetupMetadataOutcome =
  | { readonly outcome: "available"; readonly selectionCounts?: SetupMetadataSelectionCounts }
  | {
      readonly outcome: "unavailable" | "cancelled" | "failed";
      readonly selectionCounts?: Pick<SetupMetadataSelectionCounts, "selectedModelCount">;
      readonly failure: SetupMetadataFailure;
    };

function logSetupMetadataOutcome(
  input: SetupMetadataOutcome,
  trace: SetupDiscoveryTrace,
  startedAt: number,
  correlationId: string | undefined,
  sink: ServerLogSink = processServerLogSink(),
): void {
  const failure = input.outcome === "available" ? undefined : input.failure;
  sink.write(
    activityLogEvent(
      GATEWAY_SETUP_METADATA_OPERATION,
      {
        correlationId: correlationIdOrUnknown(correlationId),
        ...(failure === undefined ? {} : { errorKind: failure.errorKind }),
      },
      {
        outcome: input.outcome,
        ...trace,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        completeness: "complete",
        loss: "none",
        ...input.selectionCounts,
        ...failure?.evidence,
      },
    ),
  );
}

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
/** Runs the live two-document rerank probe against the reranker the given config names. */
type GatewayRerankerProbe = (config: GatewayConfig) => Promise<boolean>;
type InjectedGatewayModelDiscovery = NonNullable<UiHandlerDeps["gatewayModelDiscovery"]>;
type GatewayModelDiscovery = (
  ...args: [...Parameters<InjectedGatewayModelDiscovery>, trace: SetupDiscoveryTrace]
) => ReturnType<InjectedGatewayModelDiscovery>;
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
  readonly explicitDeploymentNames?: readonly string[] | undefined;
  readonly catalogOrigin?: ModelProviderConfig["catalogOrigin"];
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
    ...(discovered?.maxInputTokens === undefined
      ? {}
      : { maxInputTokens: discovered.maxInputTokens }),
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

function declaresContextWindow(discovered: GatewayDiscoveredModelMetadata | undefined): boolean {
  return discovered?.contextWindow !== undefined && discovered.contextWindowUndeclared !== true;
}

// Only declared context geometry replaces a stored optional input ceiling; a degraded list preserves it.
function refreshedSetupCapability(
  existing: ModelCapability | undefined,
  discovered: GatewayDiscoveredModelMetadata | undefined,
): ModelCapability | undefined {
  if (existing === undefined || !declaresContextWindow(discovered)) return existing;
  const { maxInputTokens, ...retained } = existing;
  return retained;
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
  const discovered = options.modelMetadata?.[modelId];
  const existing = refreshedSetupCapability(
    rawExisting?.kind === baseCapability.kind ? rawExisting : undefined,
    discovered,
  );
  const capability: ModelCapability = withContextWindowProvenance(existing, discovered, {
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
  });
  return capability;
}

/** The capability without its window provenance flags (assumed / provider-reported). */
export function withoutAssumedContextWindow(capability: ModelCapability): ModelCapability {
  const { contextWindowAssumed, contextWindowReported, ...measured } = capability;
  return contextWindowAssumed === true || contextWindowReported === true ? measured : capability;
}

// A window is assumed only while nobody has stated it: a discovered declaration ends the
// assumption, a stored capability keeps its own provenance (a probed or provider-reported window
// survives a rediscovery that declares nothing), and a brand-new chat model starts assumed.
function withContextWindowProvenance(
  existing: ModelCapability | undefined,
  discovered: GatewayDiscoveredModelMetadata | undefined,
  capability: ModelCapability,
): ModelCapability {
  const measured = withoutAssumedContextWindow(capability);
  if (capability.kind !== "chat" || declaresContextWindow(discovered)) return measured;
  if (existing === undefined || existing.contextWindowAssumed === true) {
    return { ...measured, contextWindowAssumed: true };
  }
  return existing.contextWindowReported === true
    ? { ...measured, contextWindowReported: true }
    : measured;
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

function providerCatalogOrigin(
  modelId: string,
  options: ProviderRawOptions,
): Pick<ModelProviderConfig, "catalogOrigin"> {
  const existing = (options.stored ?? options.current)?.providers.find(
    (provider) => provider.modelId === modelId,
  );
  const origin =
    options.explicitDeploymentNames?.includes(modelId) === true
      ? "explicit"
      : existing === undefined
        ? options.catalogOrigin
        : existing.catalogOrigin;
  return origin === undefined ? {} : { catalogOrigin: origin };
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
    ...providerCatalogOrigin(modelId, options),
    ...modelTokenCounterMetadata(options, modelId),
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
  const values: number[] = [];
  for (const record of records) {
    for (const field of fields) {
      const value = record[field];
      if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) values.push(value);
    }
  }
  return values.length === 0 ? undefined : Math.min(...values);
}

function reasoningEffortsFromDiscoveryRecords(
  records: readonly Record<string, unknown>[],
): readonly ModelReasoningEffort[] | undefined {
  const fields = ["supported_reasoning_efforts", "reasoning_efforts"];
  const declared = records.some((record) =>
    fields.some((field) => Array.isArray(record[field]) || typeof record[field] === "string"),
  );
  return declared
    ? [...new Set(stringListFieldFromRecords(records, fields).filter(isModelReasoningEffort))]
    : undefined;
}

// Explicit total-window declarations are distinct from LiteLLM's prompt-input ceiling.
// All declarations of the same constraint intersect; replicas cannot widen a smaller bound.
const DECLARED_CONTEXT_WINDOW_FIELDS: readonly string[] = [
  "max_model_len",
  "context_length",
  "context_window",
];

function declaredContextWindow(records: readonly Record<string, unknown>[]): number | undefined {
  return (
    numberFieldFromRecords(records, DECLARED_CONTEXT_WINDOW_FIELDS) ??
    numberFieldFromRecords(records, ["max_input_tokens"])
  );
}

function metadataFromDiscoveryItem(item: Record<string, unknown>): GatewayDiscoveredModelMetadata {
  const records = discoveryRecords(item);
  const contextWindow = declaredContextWindow(records);
  const maxInputTokens = numberFieldFromRecords(records, ["max_input_tokens"]);
  const maxOutputTokens = numberFieldFromRecords(records, ["max_output_tokens", "max_tokens"]);
  const toolCalling = optionalBooleanFieldFromRecords(records, [
    "supports_function_calling",
    "supportsFunctionCalling",
  ]);
  const reasoningEfforts = reasoningEffortsFromDiscoveryRecords(records);
  // An affirmative chat-compatible `mode` declaration ranks the model ahead of mode-less
  // entries as the conversation default (keiko-contracts conversationDefaultRank). Only ever
  // true — declared NON-chat modes never reach the chat list, and "no mode" is no signal.
  const mode = modelModeFromDiscoveryItem(item);
  const chatModeDeclared = declaresChatCompatibleMode(mode);
  return {
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(toolCalling === undefined ? {} : { toolCalling }),
    ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
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
function storedCatalogOrigin(
  provider: ModelProviderConfig,
): Pick<ModelProviderConfig, "catalogOrigin"> {
  return provider.catalogOrigin === undefined ? {} : { catalogOrigin: provider.catalogOrigin };
}

function rawProviderFromCurrent(
  provider: ModelProviderConfig,
  capability: ModelCapability | undefined,
  timeoutMs: number | undefined,
): Record<string, unknown> {
  return {
    modelId: provider.modelId,
    baseUrl: provider.baseUrl,
    ...rawProviderCredential(provider),
    apiKeyHeaderName: provider.apiKeyHeaderName ?? DEFAULT_API_KEY_HEADER_NAME,
    ...storedCatalogOrigin(provider),
    ...(provider.endpointStyle === undefined ? {} : { endpointStyle: provider.endpointStyle }),
    ...(provider.apiVersion === undefined ? {} : { apiVersion: provider.apiVersion }),
    ...(provider.outputTokenParameter === undefined
      ? {}
      : { outputTokenParameter: provider.outputTokenParameter }),
    ...tokenCounterMetadata(provider.tokenCounter),
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

function rawProviderCredential(provider: ModelProviderConfig): Record<string, unknown> {
  return provider.apiKeySourceModelId === undefined
    ? {
        apiKey: provider.apiKey,
        ...(provider.apiKeySecretRef === undefined
          ? {}
          : { apiKeySecretRef: provider.apiKeySecretRef }),
      }
    : { apiKeySourceModelId: provider.apiKeySourceModelId };
}

// The operator's coding opt-outs (owner decision 2026-10-06: live streaming and the model
// reasoning display are on unless switched off) are operator blocks no setup step produces: a
// setup save keeps them verbatim, or an unrelated credential or capability update would silently
// switch an operator back to the default.
function codingOperatorSwitches(config: GatewayConfig | undefined): Record<string, unknown> {
  return {
    ...(config?.codingStreaming === undefined ? {} : { codingStreaming: config.codingStreaming }),
    ...(config?.codingReasoningDisplay === undefined
      ? {}
      : { codingReasoningDisplay: config.codingReasoningDisplay }),
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
    ...operatorPolicyBlocks(config),
    ...codingOperatorSwitches(config),
  };
}

// Operator-declared blocks no setup step produces: they survive every rebuild verbatim, so a
// capability update never drops the grounded-answer policy, the PR branding (PR #3678) or the
// coding outage window (#3873). Present-only, never truthy: an explicit `codingOutageWindowMs: 0`
// is the operator's fail-fast opt-out and must survive a save as well.
function operatorPolicyBlocks(config: GatewayConfig | undefined): Record<string, unknown> {
  return {
    ...(config?.groundedAnswers === undefined ? {} : { groundedAnswers: config.groundedAnswers }),
    ...(config?.branding === undefined ? {} : { branding: config.branding }),
    ...(config?.codingOutageWindowMs === undefined
      ? {}
      : { codingOutageWindowMs: config.codingOutageWindowMs }),
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
  return [`${normalized}/model/info`, `${normalized}/model_group/info`];
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
  for (const field of [
    "id",
    "model_name",
    "model_group",
    "model",
    "deployment_name",
    "deploymentName",
  ]) {
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
type DiscoveryModelKind = "chat" | "embedding" | "voice" | "unsupported";
type DiscoveryVoiceRole = "speech-input" | "speech-output" | "realtime";

interface ClassifiedDiscoveryModel {
  readonly deploymentCount?: number;
  readonly undeclaredContext?: boolean;
  readonly deploymentConflict?: boolean;
  readonly declaredNonChat?: boolean;
  /** The gateway stated this embedding role in a `mode`; absent when only the id implied it. */
  readonly declaredRole?: boolean;
  readonly id: string;
  readonly kind: DiscoveryModelKind;
  readonly voiceRole?: DiscoveryVoiceRole;
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

// A rerank engine is recognised and REPORTED here, never configured as chat or embedding. Setup
// wires it as the retrieval reranker afterwards, and only when a live probe answers — the entry
// stays in the unsupported list until then, and after it whenever the operator already owns one.
function rerankDiscoveryModel(
  id: string,
  metadata: GatewayDiscoveredModelMetadata,
  declared: boolean,
): ClassifiedDiscoveryModel {
  return {
    id,
    kind: "unsupported",
    ...(declared ? { declaredNonChat: true } : {}),
    supportsImageInput: false,
    metadata,
    reason: "rerank",
  };
}

// Classification WITHOUT a declaration: the id heuristic is all a `/models`-only gateway gives us.
// A name that says "reranker" is decided FIRST — "bge-reranker-v2-m3" carries the "bge" embedding
// family prefix and must never be claimed as an embedding model. `capabilities.chat_completion ===
// false` states what the model is NOT, which is not a role: an embedding model legitimately carries
// it, so the id heuristic still decides and cannot fall through to "chat".
function classifyUndeclaredDiscoveryItem(
  item: Record<string, unknown>,
  id: string,
  metadata: GatewayDiscoveredModelMetadata,
): ClassifiedDiscoveryModel {
  if (isLikelyRerankModelId(id)) return rerankDiscoveryModel(id, metadata, false);
  if (isLikelyEmbeddingModelId(id)) {
    return { id, kind: "embedding", supportsImageInput: false, metadata };
  }
  if (isExplicitlyNonChatModel(item)) {
    return {
      id,
      kind: "unsupported",
      supportsImageInput: false,
      metadata,
      reason: "not-chat-capable",
      declaredNonChat: true,
    };
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
  if (!isRecord(item)) return undefined;
  const id = modelIdFromKnownFields(item);
  if (id === undefined) {
    return undefined;
  }
  const metadata = metadataFromDiscoveryItem(item);
  const declaredMode = modelModeFromDiscoveryItem(item);
  if (declaredMode === undefined) return classifyUndeclaredDiscoveryItem(item, id, metadata);
  const voiceRole = voiceRoleForDeclaredMode(declaredMode);
  if (voiceRole !== undefined) {
    return { id, kind: "voice", voiceRole, supportsImageInput: false, metadata };
  }
  const role = modelKindForDeclaredMode(declaredMode);
  if (role === "rerank") return rerankDiscoveryModel(id, metadata, true);
  if (role === "unsupported") {
    // The reason is drawn from a CLOSED vocabulary. A declared mode is gateway-controlled text of
    // unbounded shape; echoing it verbatim would put foreign strings into the diagnostic channel
    // and the setup response, which the redaction rules forbid.
    const reason = boundedUnsupportedReason(declaredMode);
    return {
      id,
      kind: "unsupported",
      declaredNonChat: true,
      supportsImageInput: false,
      metadata,
      reason,
    };
  }
  if (role === "embedding") {
    return { id, kind: "embedding", declaredRole: true, supportsImageInput: false, metadata };
  }
  return {
    id,
    kind: "chat",
    supportsImageInput: supportsImageInputFromDiscoveryItem(item, id),
    metadata,
  };
}

function voiceRoleForDeclaredMode(mode: string): DiscoveryVoiceRole | undefined {
  if (mode === "audio_transcription") return "speech-input";
  if (mode === "audio_speech") return "speech-output";
  if (mode === "realtime") return "realtime";
  return undefined;
}

// Issue #144: exported as part of the discovery-normalization seam. Gateway setup now returns
// embedding-capable records so setup can persist them for Local Knowledge while keeping them out of
// chat.
// Returns undefined for unknown/non-record/unsupported/malformed input so
// callers can drop the entry silently and keep healthy peers.
export function modelIdFromDiscoveryItem(item: unknown): string | undefined {
  const classified = classifyDiscoveryItem(item);
  return classified === undefined ||
    classified.kind === "unsupported" ||
    classified.kind === "voice"
    ? undefined
    : classified.id;
}

// Setup remains strict on empty discovery. Runtime refresh admits a complete empty listing,
// but rejects malformed entries so a partial response cannot remove active models.
export function parseModelDiscovery(
  payload: unknown,
  correlationId?: string,
  options?: { readonly allowEmpty: boolean },
): GatewayDiscoveredModels {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error("model discovery response must contain a data array");
  }
  // An alias may route to any deployment. Its usable geometry is their intersection; list order
  // must never grant the largest deployment's capabilities to its smaller peers.
  const entries = discoveryEntries(payload.data, options?.allowEmpty === true);
  // LiteLLM declares audio roles in /model/info. Preserve the existing chat/embedding discovery
  // contract while routing these declarations to Voice setup; a Whisper alias is never a chat model.
  const voiceEntries = entries.filter((entry) => entry.kind === "voice");
  // KEIKO-0325: raise a truncation flag alongside the limited slice so callers can
  // surface "N of M models discovered; add the rest by deployment name" instead of the
  // pre-fix silent drop. Kept optional-and-off-by-default so a fitting-within-cap
  // discovery does not carry a redundant `truncated: false` on the wire.
  // Recognised-but-unusable models are reported, never configured: they get no provider entry and
  // no slot in any selection list, but the operator learns they exist and why they were skipped.
  // They are partitioned BEFORE the cap — a gateway listing 60 audio endpoints ahead of its chat
  // aliases must not push the chat models past MAX_DISCOVERED_MODELS.
  const unsupported = entries.filter(isUnsupportedEntry);
  const usableEntries = entries.filter(
    (entry) => entry.kind === "chat" || entry.kind === "embedding",
  );
  const wasTruncated =
    usableEntries.length > MAX_DISCOVERED_MODELS || voiceEntries.length > MAX_DISCOVERED_MODELS;
  const usable = usableEntries.slice(0, MAX_DISCOVERED_MODELS);
  const boundedVoice = voiceEntries.slice(0, MAX_DISCOVERED_MODELS);
  for (const entry of [...usable, ...boundedVoice, ...unsupported.slice(0, MAX_DISCOVERED_MODELS)])
    logDiscoveryMerge(entry, correlationId);
  if (options?.allowEmpty !== true)
    assertDiscoveryYieldedUsableModels([...usable, ...boundedVoice], unsupported);
  return discoveredModelLists(usable, boundedVoice, unsupported, wasTruncated);
}

function discoveryEntries(data: readonly unknown[], runtime: boolean): ClassifiedDiscoveryModel[] {
  const byId = new Map<string, ClassifiedDiscoveryModel>();
  for (const item of data) {
    const classified = classifyDiscoveryItem(item);
    if (classified === undefined) {
      if (runtime) throw new Error("runtime model catalog contains an invalid entry");
      continue;
    }
    collectDiscoveryDeployment(byId, classified);
  }
  return [...byId.values()];
}

function collectDiscoveryDeployment(
  byId: Map<string, ClassifiedDiscoveryModel>,
  incoming: ClassifiedDiscoveryModel,
): void {
  const existing = byId.get(incoming.id);
  byId.set(incoming.id, {
    ...mergeDiscoveryDeployment(existing, incoming),
    deploymentCount: (existing?.deploymentCount ?? 0) + 1,
    undeclaredContext:
      existing?.undeclaredContext === true || incoming.metadata.contextWindow === undefined,
  });
}

function mergeDiscoveryDeployment(
  existing: ClassifiedDiscoveryModel | undefined,
  incoming: ClassifiedDiscoveryModel,
): ClassifiedDiscoveryModel {
  if (existing === undefined) return incoming;
  if (existing.deploymentConflict === true) return existing;
  // Load-balanced replicas of one declared non-chat role (two `mode: "rerank"` entries of one
  // alias) are one engine; only an alias that MIXES roles is a conflict.
  if (isSameRoleUnsupportedReplica(existing, incoming)) return mergedReplica(existing, incoming);
  if (hasDeclaredNonChatDeployment(existing, incoming)) return conflictingDeployment(existing);
  if (existing.kind === "unsupported") return incoming;
  if (incoming.kind === "unsupported") return existing;
  if (existing.kind !== incoming.kind || existing.voiceRole !== incoming.voiceRole) {
    return conflictingDeployment(existing);
  }
  return mergedReplica(existing, incoming);
}

function isSameRoleUnsupportedReplica(
  existing: ClassifiedDiscoveryModel,
  incoming: ClassifiedDiscoveryModel,
): boolean {
  return (
    existing.kind === "unsupported" &&
    incoming.kind === "unsupported" &&
    existing.reason === incoming.reason
  );
}

function mergedReplica(
  existing: ClassifiedDiscoveryModel,
  incoming: ClassifiedDiscoveryModel,
): ClassifiedDiscoveryModel {
  return {
    ...existing,
    ...(existing.declaredNonChat === true || incoming.declaredNonChat === true
      ? { declaredNonChat: true }
      : {}),
    // One declared replica is a declaration for the alias, whichever the gateway listed first.
    ...(existing.declaredRole === true || incoming.declaredRole === true
      ? { declaredRole: true }
      : {}),
    supportsImageInput: existing.supportsImageInput && incoming.supportsImageInput,
    metadata: intersectDeploymentMetadata(existing.metadata, incoming.metadata),
  };
}

function conflictingDeployment(existing: ClassifiedDiscoveryModel): ClassifiedDiscoveryModel {
  return {
    ...existing,
    kind: "unsupported",
    deploymentConflict: true,
    reason: "not-chat-capable",
  };
}

function hasDeclaredNonChatDeployment(
  left: ClassifiedDiscoveryModel,
  right: ClassifiedDiscoveryModel,
): boolean {
  return left.declaredNonChat === true || right.declaredNonChat === true;
}

function intersectDeploymentMetadata(
  left: GatewayDiscoveredModelMetadata,
  right: GatewayDiscoveredModelMetadata,
): GatewayDiscoveredModelMetadata {
  return {
    ...intersectContextWindow(left, right),
    ...intersectInputLimit(left, right),
    ...commonTokenCounter(left, right),
    maxOutputTokens: Math.min(left.maxOutputTokens ?? 0, right.maxOutputTokens ?? 0),
    toolCalling: left.toolCalling === true && right.toolCalling === true,
    ...intersectReasoningEfforts(left, right),
    ...(left.chatModeDeclared === true && right.chatModeDeclared === true
      ? { chatModeDeclared: true }
      : {}),
  };
}

function intersectInputLimit(
  left: GatewayDiscoveredModelMetadata,
  right: GatewayDiscoveredModelMetadata,
): Pick<GatewayDiscoveredModelMetadata, "maxInputTokens"> {
  const limits = [left.maxInputTokens, right.maxInputTokens].filter(
    (limit): limit is number => limit !== undefined,
  );
  return limits.length === 0 ? {} : { maxInputTokens: Math.min(...limits) };
}

function intersectContextWindow(
  left: GatewayDiscoveredModelMetadata,
  right: GatewayDiscoveredModelMetadata,
): Pick<GatewayDiscoveredModelMetadata, "contextWindow"> {
  if (left.contextWindow === undefined && right.contextWindow === undefined) return {};
  return { contextWindow: Math.min(left.contextWindow ?? 4_096, right.contextWindow ?? 4_096) };
}

function intersectReasoningEfforts(
  left: GatewayDiscoveredModelMetadata,
  right: GatewayDiscoveredModelMetadata,
): Pick<GatewayDiscoveredModelMetadata, "reasoningEfforts"> {
  if (left.reasoningEfforts === undefined && right.reasoningEfforts === undefined) return {};
  return {
    reasoningEfforts: (left.reasoningEfforts ?? [])
      .filter((effort) => right.reasoningEfforts?.includes(effort))
      .sort((left, right) => left.localeCompare(right, "en")),
  };
}

function discoveredModelLists(
  usable: readonly ClassifiedDiscoveryModel[],
  boundedVoice: readonly ClassifiedDiscoveryModel[],
  unsupported: readonly UnsupportedDiscoveryModel[],
  wasTruncated: boolean,
): GatewayDiscoveredModels {
  return {
    modelIds: usable.map((entry) => entry.id),
    chatModelIds: usable.filter((entry) => entry.kind === "chat").map((entry) => entry.id),
    embeddingModelIds: declaredThenIdOrder(usable.filter((entry) => entry.kind === "embedding")),
    voiceSpeechInputModelIds: boundedVoice
      .filter((entry) => entry.voiceRole === "speech-input")
      .map((entry) => entry.id),
    voiceSpeechOutputModelIds: boundedVoice
      .filter((entry) => entry.voiceRole === "speech-output")
      .map((entry) => entry.id),
    voiceRealtimeModelIds: boundedVoice
      .filter((entry) => entry.voiceRole === "realtime")
      .map((entry) => entry.id),
    imageInputModelIds: usable
      .filter((entry) => entry.kind === "chat" && entry.supportsImageInput)
      .map((entry) => entry.id),
    modelMetadata: Object.fromEntries(usable.map((entry) => [entry.id, discoveredMetadata(entry)])),
    ...(unsupported.length > 0
      ? {
          unsupportedModels: unsupported.map((entry) => ({
            id: entry.id,
            reason: entry.reason,
          })),
        }
      : {}),
    ...rerankCandidateList(unsupported),
    ...(wasTruncated ? { truncated: true } : {}),
  };
}

// A replica set in which one deployment declared no window merges to the conservative fallback;
// the metadata says so, so setup keeps that window assumed instead of treating 4,096 as declared.
function discoveredMetadata(entry: ClassifiedDiscoveryModel): GatewayDiscoveredModelMetadata {
  return entry.undeclaredContext === true && entry.metadata.contextWindow !== undefined
    ? { ...entry.metadata, contextWindowUndeclared: true }
    : entry.metadata;
}

// Declared before name-inferred, then by id. Two lanes are ORDERED, not merely listed — the rerank
// candidates (setup probes only the first few) and the embedding candidates (the first one becomes
// the default new Knowledge Pods bind) — and neither may depend on how the gateway happens to list
// its models: a restart that lists them in another order must not change what is probed or bound.
// A role the gateway stated in a `mode` outranks one Keiko only inferred from the id.
function declaredThenIdOrder(entries: readonly ClassifiedDiscoveryModel[]): readonly string[] {
  const declared = (entry: ClassifiedDiscoveryModel): number =>
    Number(entry.declaredNonChat === true || entry.declaredRole === true);
  return [...entries]
    .sort(
      (left, right) => declared(right) - declared(left) || left.id.localeCompare(right.id, "en"),
    )
    .map((entry) => entry.id);
}

// The rerank engines among the recognised-but-unconfigured models. They are partitioned out of the
// same pre-cap entry list as every other role, so a gateway listing dozens of chat aliases ahead of
// its reranker cannot push the reranker out of reach.
function rerankCandidateList(
  unsupported: readonly UnsupportedDiscoveryModel[],
): Pick<GatewayDiscoveredModels, "rerankModelIds"> {
  const rerankModelIds = declaredThenIdOrder(
    unsupported.filter((entry) => entry.reason === "rerank"),
  );
  return rerankModelIds.length === 0 ? {} : { rerankModelIds };
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
  signal: AbortSignal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
): Promise<unknown> {
  signal.throwIfAborted();
  const response = await fetchDiscoveryResponse(url, apiKey, apiKeyHeaderName, egress, signal);
  if (!response.ok) {
    throw Object.assign(new Error("model discovery returned an error status"), {
      httpStatus: response.status,
    });
  }
  try {
    return await readJsonCapped(response);
  } catch {
    signal.throwIfAborted();
    throw discoveryTerminal(
      "model discovery response was not readable JSON",
      "DISCOVERY_INVALID_RESPONSE",
    );
  }
}

async function fetchDiscoveryResponse(
  url: string,
  apiKey: string,
  apiKeyHeaderName: string,
  egress: GatewayEgressConfig | undefined,
  signal: AbortSignal,
): Promise<Response> {
  try {
    return await gatewayFetch(url, {
      method: "GET",
      headers: apiKeyHeaders(apiKey, apiKeyHeaderName),
      signal,
      ...(egress !== undefined ? { egress } : {}),
    });
  } catch (cause) {
    signal.throwIfAborted();
    if (cause instanceof TypeError)
      throw new Error("Model metadata transport was unavailable.", { cause });
    throw cause;
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

interface LiteLlmModelInformation {
  readonly models: GatewayDiscoveredModels;
  readonly payload: unknown;
}

async function discoverLiteLlmModelInfo(
  baseUrl: string,
  apiKey: string,
  apiKeyHeaderName: string,
  egress: GatewayEgressConfig | undefined,
  correlationId: string | undefined,
  {
    signal,
    deadlineAt,
    trace,
  }: {
    readonly signal: AbortSignal;
    readonly deadlineAt: number;
    readonly trace: SetupDiscoveryTrace;
  },
): Promise<LiteLlmModelInformation | undefined> {
  const endpoints = modelInfoEndpointCandidates(baseUrl);
  for (const [index, endpoint] of endpoints.entries()) {
    trace.discoverySource = index === 0 ? "model-info" : "model-group-info";
    const outcomeKey = index === 0 ? "modelInfoOutcome" : "modelGroupInfoOutcome";
    try {
      const payload = await fetchDiscoveryJson(
        endpoint,
        apiKey,
        apiKeyHeaderName,
        egress,
        discoveryManagementSignal(signal, deadlineAt, endpoints.length - index),
      );
      const discovered = parseModelDiscovery(payload, correlationId);
      trace[outcomeKey] = "available";
      return {
        payload,
        models: withLiteLlmTokenCounter(discovered),
      };
    } catch (cause) {
      trace[outcomeKey] = discoveryRouteOutcome(cause, signal);
      signal.throwIfAborted();
      if (discoveryProgrammingFailure(cause)) throw cause;
      if (modelInfoAnswerIsUnusable(cause) && cause instanceof Error) throw cause;
    }
  }
  return undefined;
}

// Let the primary management route use the shared budget while retaining a short fallback window.
function discoveryManagementSignal(
  signal: AbortSignal,
  deadlineAt: number,
  routesLeft: number,
): AbortSignal {
  signal.throwIfAborted();
  const remaining = Math.max(1, deadlineAt - Date.now());
  return AbortSignal.any([
    signal,
    AbortSignal.timeout(Math.max(1, remaining - routesLeft * DISCOVERY_FALLBACK_RESERVE_MS)),
  ]);
}

async function defaultGatewayModelDiscovery(
  baseUrl: string,
  apiKey: string,
  requestedApiKeyHeaderName: string | undefined,
  egress: GatewayEgressConfig | undefined,
  correlationId: string | undefined,
  trace: SetupDiscoveryTrace,
  callerSignal?: AbortSignal,
  metadataOnly = false,
  allowEmpty = false,
): Promise<GatewayDiscoveredModels> {
  const apiKeyHeaderName = requestedApiKeyHeaderName ?? DEFAULT_API_KEY_HEADER_NAME;
  // One existing discovery budget covers the management fallbacks and model list together.
  const deadlineAt = Date.now() + DISCOVERY_TIMEOUT_MS;
  const signal = AbortSignal.any([
    AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    ...(callerSignal === undefined ? [] : [callerSignal]),
  ]);
  const litellmModels = await discoverLiteLlmModelInfo(
    baseUrl,
    apiKey,
    apiKeyHeaderName,
    egress,
    correlationId,
    { signal, deadlineAt, trace },
  );
  // Explicit human deployment names remain authoritative on gateways without a models route.
  if (litellmModels !== undefined && metadataOnly) return litellmModels.models;
  if (litellmModels === undefined) trace.discoverySource = "model-list";
  try {
    const payload = await fetchDiscoveryJson(
      modelsEndpoint(baseUrl),
      apiKey,
      apiKeyHeaderName,
      egress,
      signal,
    );
    const discovered = listedDiscoveryResult(payload, litellmModels, correlationId, allowEmpty);
    trace.modelListOutcome = "available";
    return litellmModels === undefined ? discovered : withLiteLlmTokenCounter(discovered);
  } catch (cause) {
    trace.modelListOutcome = discoveryRouteOutcome(cause, signal);
    throw cause;
  }
}

function withLiteLlmTokenCounter(discovered: GatewayDiscoveredModels): GatewayDiscoveredModels {
  return {
    ...discovered,
    modelMetadata: Object.fromEntries(
      discovered.modelIds.map((id) => [
        id,
        { ...discovered.modelMetadata?.[id], tokenCounter: "litellm" as const },
      ]),
    ),
  };
}

function listedDiscoveryResult(
  payload: unknown,
  metadata: Awaited<ReturnType<typeof discoverLiteLlmModelInfo>>,
  correlationId: string | undefined,
  allowEmpty: boolean,
): GatewayDiscoveredModels {
  if (allowEmpty) assertRuntimeListingComplete(payload);
  return parseModelDiscovery(
    metadata === undefined ? payload : listedCatalogWithMetadata(payload, metadata.payload),
    correlationId,
    { allowEmpty },
  );
}

function assertRuntimeListingComplete(payload: unknown): void {
  if (discoveryData(payload).some((entry) => classifyDiscoveryItem(entry) === undefined))
    throw new Error("runtime model catalog contains an invalid entry");
}

/** Management records enrich exact listed IDs; listing alone is not a live health proof. */
function listedCatalogWithMetadata(serving: unknown, metadata: unknown): { data: unknown[] } {
  const servingEntries = discoveryData(serving);
  const byId = new Map<string, unknown[]>();
  for (const entry of discoveryData(metadata)) {
    const id = isRecord(entry) ? modelIdFromKnownFields(entry) : undefined;
    if (id === undefined) continue;
    const group = byId.get(id);
    if (group === undefined) byId.set(id, [entry]);
    else group.push(entry);
  }
  const seen = new Set<string>();
  const data: unknown[] = [];
  for (const entry of servingEntries) {
    const id = isRecord(entry) ? modelIdFromKnownFields(entry) : undefined;
    if (id === undefined) continue;
    const group = byId.get(id);
    if (group === undefined) data.push(entry);
    else if (!seen.has(id)) data.push(...group);
    seen.add(id);
  }
  return { data };
}

function discoveryData(payload: unknown): readonly unknown[] {
  if (!isRecord(payload) || !Array.isArray(payload.data))
    throw new Error("model discovery response must contain a data array");
  return payload.data;
}

/** Refresh the active LiteLLM catalog using the same bounded, egress-checked discovery as setup. */
export function liteLlmDiscoveryConnections(config: GatewayConfig): readonly ModelProviderConfig[] {
  return config.providers.filter(
    (provider, index, providers) =>
      provider.tokenCounter === "litellm" &&
      !providers
        .slice(0, index)
        .some(
          (previous) =>
            previous.tokenCounter === "litellm" && catalogConnectionMatches(provider, previous),
        ),
  );
}

interface StartupCatalogResult {
  readonly succeeded: boolean;
  readonly retryable: boolean;
}
type StartupCatalogRecorder = (
  outcome: "applied" | "unchanged" | "stale" | "cancelled" | "failed",
  updatedModelCount: number,
  retryable: boolean,
  errorKind?: ActivityLogErrorKind,
) => void;
const CONCLUSIVE_CATALOG_HTTP_STATUSES: ReadonlySet<number> = new Set([400, 404]);

function startupCatalogLogger(
  deps: UiHandlerDeps,
  provider: ModelProviderConfig,
  config: GatewayConfig,
  correlationId: string,
  startedAt: number,
): StartupCatalogRecorder {
  const configuredModelCount = config.providers.filter((candidate) =>
    catalogConnectionMatches(candidate, provider),
  ).length;
  return (outcome, updatedModelCount, retryable, errorKind): void => {
    logAutomaticCatalog(deps, {
      correlationId,
      outcome,
      configuredModelCount,
      updatedModelCount,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      retryable,
      ...(errorKind === undefined ? {} : { errorKind }),
    });
  };
}

export async function refreshLiteLlmGatewayCatalog(
  deps: UiHandlerDeps,
  provider: ModelProviderConfig,
  signal: AbortSignal,
  correlationId: string,
): Promise<StartupCatalogResult> {
  const holder = deps.gatewayConfig;
  const config = holder?.configured?.() ?? holder?.current();
  if (config === undefined || holder === undefined) return { succeeded: false, retryable: false };
  const generation = holder.generation();
  const trace = createSetupDiscoveryTrace();
  const startedAt = Date.now();
  const log = startupCatalogLogger(deps, provider, config, correlationId, startedAt);
  try {
    const result = await discoverConfiguredGatewayCatalog(
      deps,
      provider,
      config.egress,
      signal,
      trace,
      correlationId,
    );
    signal.throwIfAborted();
    const outcome = applyStartupCatalog(holder, generation, provider, result, correlationId, log);
    logSetupMetadataOutcome(
      { outcome: "available" },
      trace,
      startedAt,
      correlationId,
      deps.activityLog,
    );
    return outcome;
  } catch (cause) {
    const outcome = metadataFailureOutcome(cause, signal);
    const failure = discoveryFailureDetail(cause, outcome === "cancelled");
    logSetupMetadataOutcome(
      { outcome, failure },
      trace,
      startedAt,
      correlationId,
      deps.activityLog,
    );
    const retryable = catalogFailureRetryable(outcome, failure);
    log(outcome === "cancelled" ? "cancelled" : "failed", 0, retryable, failure.errorKind);
    return { succeeded: false, retryable };
  }
}

function catalogFailureRetryable(outcome: string, failure: SetupMetadataFailure): boolean {
  return (
    outcome !== "cancelled" &&
    failure.errorKind !== "permission-denied" &&
    failure.errorKind !== "validation-failed" &&
    !CONCLUSIVE_CATALOG_HTTP_STATUSES.has(failure.evidence.httpStatus ?? 0)
  );
}

function catalogChangeCount(before: GatewayConfig, after: GatewayConfig): number {
  const previous = new Map(listConfiguredCapabilities(before).map((model) => [model.id, model]));
  const next = new Map(listConfiguredCapabilities(after).map((model) => [model.id, model]));
  return [...new Set([...previous.keys(), ...next.keys()])].filter(
    (id) => JSON.stringify(previous.get(id)) !== JSON.stringify(next.get(id)),
  ).length;
}

function currentCatalogConnection(
  holder: RuntimeGatewayConfig,
  generation: number,
  provider: ModelProviderConfig,
): GatewayConfig | undefined {
  const configured = holder.configured?.() ?? holder.current();
  return holder.generation() === generation &&
    configured?.providers.some((candidate) => catalogConnectionMatches(candidate, provider)) ===
      true
    ? configured
    : undefined;
}

function commitStartupCatalog(
  holder: RuntimeGatewayConfig,
  current: GatewayConfig,
  updated: GatewayConfig,
  generation: number,
  correlationId: string,
): boolean {
  if (updated === current) return true;
  const inventoryChanged = JSON.stringify(updated.providers) !== JSON.stringify(current.providers);
  if (inventoryChanged) return holder.replaceCatalog?.(updated, generation, correlationId) ?? false;
  if (holder.refine === undefined) return false;
  holder.refine(updated, correlationId);
  return true;
}

function applyStartupCatalog(
  holder: RuntimeGatewayConfig,
  generation: number,
  provider: ModelProviderConfig,
  result: GatewayModelDiscoveryOutput,
  correlationId: string,
  log: StartupCatalogRecorder,
): StartupCatalogResult {
  const current = holder.current();
  const configured = currentCatalogConnection(holder, generation, provider);
  if (current === undefined || configured === undefined) {
    log("stale", 0, true);
    return { succeeded: false, retryable: true };
  }
  const updated = refreshedLiteLlmCatalog(
    current,
    configured,
    provider,
    normalizeDiscoveryResult(result),
  );
  if (!commitStartupCatalog(holder, current, updated, generation, correlationId)) {
    log("stale", 0, true);
    return { succeeded: false, retryable: true };
  }
  log(updated === current ? "unchanged" : "applied", catalogChangeCount(current, updated), false);
  return { succeeded: true, retryable: false };
}

function discoverConfiguredGatewayCatalog(
  deps: UiHandlerDeps,
  provider: ModelProviderConfig,
  egress: GatewayEgressConfig | undefined,
  signal: AbortSignal,
  trace: SetupDiscoveryTrace,
  correlationId: string,
): Promise<GatewayModelDiscoveryOutput> {
  if (deps.gatewayModelDiscovery === undefined)
    return defaultGatewayModelDiscovery(
      provider.baseUrl,
      provider.apiKey,
      provider.apiKeyHeaderName,
      egress,
      correlationId,
      trace,
      signal,
      false,
      true,
    );
  return awaitSetupOperation(
    deps.gatewayModelDiscovery(
      provider.baseUrl,
      provider.apiKey,
      provider.apiKeyHeaderName,
      egress,
      correlationId,
    ),
    signal,
  );
}

export function catalogConnectionMatches(
  candidate: ModelProviderConfig,
  connection: ModelProviderConfig,
): boolean {
  return (
    sharesStoredGatewayConnection(candidate, connection) &&
    effectiveEndpointStyle(candidate.endpointStyle) ===
      effectiveEndpointStyle(connection.endpointStyle) &&
    candidate.apiVersion === connection.apiVersion
  );
}

function discoveredProviderConfig(
  config: GatewayConfig,
  connection: ModelProviderConfig,
  id: string,
  discovery: SetupCandidateModels,
): GatewayConfig {
  const provider = providerRaw(id, connection.baseUrl, connection.apiKey, {
    catalogOrigin: "discovered",
    current: config,
    apiKeyHeaderName: connection.apiKeyHeaderName,
    endpointStyle: connection.endpointStyle,
    apiVersion: connection.apiVersion,
    timeoutMs: connection.timeoutMs,
    maxRetries: connection.maxRetries,
    retryBaseDelayMs: connection.retryBaseDelayMs,
    embeddingModelIds: discovery.embeddingModelIds,
    imageInputModelIds: discovery.imageInputModelIds,
    modelMetadata: { [id]: { ...discovery.modelMetadata[id], tokenCounter: "litellm" } },
  });
  const produced = parseGatewayConfig({
    providers: [
      {
        ...provider,
        ...(connection.circuitBreaker === undefined
          ? {}
          : { circuitBreaker: connection.circuitBreaker }),
        ...(connection.outputTokenParameter === undefined
          ? {}
          : { outputTokenParameter: connection.outputTokenParameter }),
      },
    ],
    circuitBreaker: config.circuitBreaker,
    ...(config.egress === undefined ? {} : { egress: config.egress }),
  });
  const sourceId = connection.apiKeySourceModelId ?? connection.modelId;
  return id === sourceId
    ? produced
    : {
        ...produced,
        providers: produced.providers.map((candidate) => ({
          ...candidate,
          apiKeySourceModelId: sourceId,
        })),
      };
}

function reconcileCatalogInventory(
  active: GatewayConfig,
  configured: GatewayConfig,
  connection: ModelProviderConfig,
  discovery: SetupCandidateModels,
): GatewayConfig {
  const listed = new Set(discovery.modelIds);
  const providers = active.providers.filter(
    (provider) =>
      provider.catalogOrigin !== "discovered" ||
      !catalogConnectionMatches(provider, connection) ||
      listed.has(provider.modelId) ||
      discovery.truncated === true,
  );
  const capabilities = listConfiguredCapabilities(active).filter((model) =>
    providers.some((provider) => provider.modelId === model.id),
  );
  const automatic = configured.providers.some(
    (provider) =>
      provider.catalogOrigin === "discovered" && catalogConnectionMatches(provider, connection),
  );
  for (const id of automatic ? discovery.modelIds : []) {
    if (providers.some((provider) => provider.modelId === id)) continue;
    const stored = configured.providers.find((provider) => provider.modelId === id);
    if (stored !== undefined && !catalogConnectionMatches(stored, connection)) continue;
    const produced = discoveredProviderConfig(configured, connection, id, discovery);
    providers.push(...produced.providers);
    capabilities.push(
      ...listConfiguredCapabilities(produced).map((model) => {
        const retained =
          stored === undefined ? undefined : findConfiguredCapability(configured, model.id);
        return retained?.kind === model.kind ? retained : model;
      }),
    );
  }
  return { ...active, providers, capabilities };
}

function refreshedLiteLlmCatalog(
  config: GatewayConfig,
  configured: GatewayConfig,
  connection: ModelProviderConfig,
  discovery: SetupCandidateModels,
): GatewayConfig {
  const inventory = reconcileCatalogInventory(config, configured, connection, discovery);
  const refreshed = listConfiguredCapabilities(inventory).reduce((updated, model) => {
    const provider = inventory.providers.find((candidate) => candidate.modelId === model.id);
    const metadata = discovery.modelMetadata[model.id];
    if (
      model.kind !== "chat" ||
      provider === undefined ||
      !catalogConnectionMatches(provider, connection) ||
      metadata === undefined
    )
      return updated;
    const replacement = catalogDeclaredCapability(model, metadata);
    return {
      ...updated,
      capabilities: listConfiguredCapabilities(updated).map((existing) =>
        existing.id === model.id ? replacement : existing,
      ),
    };
  }, inventory);
  return JSON.stringify(refreshed) === JSON.stringify(config) ? config : refreshed;
}

function catalogDeclaredLimit(
  stored: number | undefined,
  declared: number | undefined,
): number | undefined {
  if (declared === undefined || declared <= 0) return stored;
  return stored === undefined || stored === 0 ? declared : Math.min(stored, declared);
}

function catalogDeclaredCapability(
  model: ModelCapability,
  metadata: GatewayDiscoveredModelMetadata,
): ModelCapability {
  const window = declaresContextWindow(metadata) ? metadata.contextWindow : undefined;
  const contextWindow =
    window === undefined
      ? model.contextWindow
      : model.contextWindowAssumed === true
        ? window
        : Math.min(model.contextWindow, window);
  const maxInputTokens = catalogDeclaredLimit(model.maxInputTokens, metadata.maxInputTokens);
  // A catalog declaration establishes a ceiling; retain smaller accepted or live learned limits.
  return {
    ...withContextWindowProvenance(model, metadata, { ...model, contextWindow }),
    ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
    maxOutputTokens:
      catalogDeclaredLimit(model.maxOutputTokens, metadata.maxOutputTokens) ??
      model.maxOutputTokens,
  };
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
  // A candidate's own smoke deadline surfaces as CANCELLED when it fires while the gateway sleeps
  // before a retry: the same "never answered" fact as a TIMEOUT, ranked the same (PR #3602 review).
  if (
    code !== undefined &&
    (SETUP_NETWORK_ERROR_CODES.has(code) || code === ERROR_CODES.CANCELLED)
  ) {
    return 2;
  }
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

async function runBoundedWorkers<T>(
  items: readonly T[],
  concurrency: number,
  process: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    signal?.throwIfAborted();
    const index = next;
    next += 1;
    if (index >= items.length) return;
    const item = items[index];
    if (item !== undefined) await process(item, index);
    // Yield before recursion so sparse input cannot grow the call stack.
    await Promise.resolve();
    await worker();
  }
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

async function passingCandidates(
  candidates: readonly string[],
  probe: (modelId: string) => Promise<void>,
  concurrency: number,
  failures?: ProbeFailureEvidence[],
  signal?: AbortSignal,
): Promise<readonly string[]> {
  const tested = new Array<string | undefined>(candidates.length).fill(undefined);
  async function worker(modelId: string, index: number): Promise<void> {
    try {
      await probe(modelId);
      signal?.throwIfAborted();
      tested[index] = modelId;
    } catch (error) {
      signal?.throwIfAborted();
      // Probe rejection is the documented signal that this candidate is not
      // chat-callable. We drop it silently so healthy peers still surface — capturing only
      // the classification code/status as evidence for the all-rejected aggregate.
      failures?.push({ code: setupErrorCode(error), httpStatus: setupHttpStatus(error) });
    }
  }
  await runBoundedWorkers(candidates, concurrency, worker, signal);
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

interface ChatSmokeAdmission {
  /** Answered the smoke probe successfully. */
  readonly tested: readonly string[];
  /** The probe never got an answer (timeout, abort, transport/proxy/TLS failure), the gateway
   *  answered with a transient failure (rate limit or an overloaded-gateway status — 408/429/5xx
   *  except 501, `transientGatewayStatus`), or the round's own patience budget ran out before this
   *  candidate's probe was even started (`CHAT_SMOKE_ROUND_DEADLINE_MS`) — KEPT, unverified: a
   *  slow or momentarily overloaded gateway is not a broken one (#3591). */
  readonly unverifiedKept: readonly string[];
  /** The gateway ANSWERED and rejected the candidate (4xx/5xx, or a malformed/unusable answer) —
   *  real evidence the candidate does not work, so it is dropped. */
  readonly droppedRejected: readonly string[];
  /** Classification evidence for EVERY failed candidate (both buckets above), for
   *  `allProbesFailedError` — used only when NOTHING was tested (see `defaultGatewaySetupTester`). */
  readonly allFailures: readonly ProbeFailureEvidence[];
  /** The candidates in `unverifiedKept` the round deadline skipped without probing them. */
  readonly skippedByDeadline: readonly string[];
}

// A per-candidate smoke failure that must be KEPT unverified rather than dropped (PR #3602
// review): a rate limit, any existing `SETUP_NETWORK_ERROR_CODES` network-failure code (this
// candidate's own `AbortSignal.timeout` deadline below can legitimately surface as either
// `TimeoutError` or `CancelledError` — `Gateway.chat()`'s retry loop notices an already-fired
// caller signal at the top of its backoff sleep and reports cancellation even though the deadline,
// not a real cancel, is what fired it — both codes are already covered by that set), or a transient
// HTTP status an intermediating proxy (e.g. the field customer's LiteLLM) answers with under load.
// Reuses `transientGatewayStatus` — the SAME "gateway is overloaded, not broken" policy the
// tool-calling probe already classifies by — instead of a second private status list. Anything else
// is real evidence the candidate does not work and stays dropped.
function isUnverifiedSmokeFailure(evidence: ProbeFailureEvidence): boolean {
  const { code, httpStatus } = evidence;
  if (code === ERROR_CODES.RATE_LIMIT || code === ERROR_CODES.CANCELLED) return true;
  if (code !== undefined && SETUP_NETWORK_ERROR_CODES.has(code)) return true;
  return httpStatus !== undefined && transientGatewayStatus(httpStatus);
}

// The mutable accumulators `admitChatSmokeCandidates`'s workers share, bundled so the per-failure
// classification below can be its own function (repository per-function line ceiling, AGENTS.md §6)
// without a long parameter list.
interface ChatSmokeAccumulators {
  readonly unverifiedKept: string[];
  readonly droppedRejected: string[];
  readonly allFailures: ProbeFailureEvidence[];
  // The subset of `unverifiedKept` the round's deadline skipped before their probe ever started;
  // recorded so the admission diagnostic can tell them from candidates that were tried.
  readonly skippedByDeadline: string[];
}

// One failed candidate's classification: on record in `allFailures` regardless of bucket (the same
// body-free pattern `setupToolCallingObservations` already uses for its own per-model probe
// failures), then sorted into kept-unverified or dropped-rejected by `isUnverifiedSmokeFailure`.
function recordChatSmokeFailure(
  modelId: string,
  error: unknown,
  deps: UiHandlerDeps,
  correlationId: string | undefined,
  accumulators: ChatSmokeAccumulators,
): void {
  reportSetupVerificationFailure(deps, error, correlationId, "gateway.setup.chat-smoke-probe");
  const evidence: ProbeFailureEvidence = {
    code: setupErrorCode(error),
    httpStatus: setupHttpStatus(error),
  };
  accumulators.allFailures.push(evidence);
  if (isUnverifiedSmokeFailure(evidence)) {
    accumulators.unverifiedKept.push(modelId);
  } else {
    accumulators.droppedRejected.push(modelId);
  }
}

// Companion to `passingCandidates` for the discovery smoke test specifically (#3591): tells a
// candidate the smoke probe timed out or was rate-limited/overloaded on (`isUnverifiedSmokeFailure`)
// apart from one the gateway actually rejected. Mirrors `admitEmbeddingCandidates`'s
// retained/dropped shape, but on a different axis: THAT function splits by whether the model's ROLE
// was asserted; this one splits by whether the PROBE was ever answered.
//
// `now` bounds the ROUND, not one candidate: past `CHAT_SMOKE_ROUND_DEADLINE_MS` from the first
// call, no further candidate probe is even started — the remaining candidates are retained
// unverified untouched, so a large discovery batch can never block first-run setup for an unbounded
// time. Defaults to `Date.now` and is a parameter only so tests can control it deterministically.
//
// Every failure is ALSO recorded into `allFailures`, independent of its bucket: when NOTHING is
// tested, `defaultGatewaySetupTester` still throws exactly as `smokeTestCandidates` always did —
// `verifyAndSaveGatewaySetup`'s multi-base-URL fallback (`attemptSetupCandidates`) and the
// whole-gateway `temporaryChatAdmission` deferral both depend on that throw to try the next
// candidate base URL or defer the whole probe round; this function only widens what happens on a
// PARTIAL failure, never removes the total-failure signal those two callers already rely on.
// Exported for direct unit testing (Issue #144 precedent — see `smokeTestCandidates`): the
// classification (`isUnverifiedSmokeFailure`) and round-deadline logic below are pure decision
// rules over an injected `probe`/`now`, and exercising them through the full HTTP-mocked
// `handleGatewaySetup` route would need either a real multi-minute wait or an intrusive global
// `AbortSignal.timeout`/clock stub for every scenario (PR #3602 review).
export async function admitChatSmokeCandidates(
  candidates: readonly string[],
  probe: (modelId: string) => Promise<void>,
  concurrency: number,
  deps: UiHandlerDeps,
  correlationId: string | undefined,
  now: () => number = Date.now,
  signal?: AbortSignal,
): Promise<ChatSmokeAdmission> {
  const tested = new Array<string | undefined>(candidates.length).fill(undefined);
  const accumulators: ChatSmokeAccumulators = {
    unverifiedKept: [],
    droppedRejected: [],
    allFailures: [],
    skippedByDeadline: [],
  };
  const roundDeadlineAt = now() + CHAT_SMOKE_ROUND_DEADLINE_MS;
  await runBoundedWorkers(
    candidates,
    concurrency,
    async (modelId, index) => {
      if (now() >= roundDeadlineAt) {
        accumulators.unverifiedKept.push(modelId);
        accumulators.skippedByDeadline.push(modelId);
        return;
      }
      try {
        await probe(modelId);
        signal?.throwIfAborted();
        tested[index] = modelId;
      } catch (error) {
        signal?.throwIfAborted();
        recordChatSmokeFailure(modelId, error, deps, correlationId, accumulators);
      }
    },
    signal,
  );
  return {
    tested: tested.filter((modelId): modelId is string => modelId !== undefined),
    ...accumulators,
  };
}

// The response-format and tool-calling verification rounds, run only over VERIFIED candidates
// (`chatSmoke.tested`) — extracted so `defaultGatewaySetupTester` stays under the repository's
// per-function line ceiling (AGENTS.md §6).
async function verifyTestedChatCandidates(
  gateway: Gateway,
  config: GatewayConfig,
  testedModelIds: readonly string[],
  correlationId: string | undefined,
  deps: UiHandlerDeps,
  signal?: AbortSignal,
): Promise<Pick<GatewaySetupTestResult, "responseFormatModelIds" | "toolCallingObservations">> {
  const responseFormatModelIds = await passingCandidates(
    testedModelIds,
    async (modelId) => {
      const response = await gateway.chat({
        ...buildQiJudgePreflightRequest(modelId),
        logContext: { correlationId },
        cancellationSignal: candidateSmokeCancellationSignal(config, modelId, signal),
      });
      if (tryParseJudgeVerdict(response.content) === null) {
        throw new Error("response format unsupported");
      }
    },
    SETUP_SMOKE_CONCURRENCY,
    undefined,
    signal,
  );
  // Both probe rounds independently use the endpoint-wide concurrency budget. Keep them
  // sequential so setup never doubles the operator-approved in-flight request ceiling.
  const toolCallingObservations = await setupToolCallingObservations(
    config,
    testedModelIds,
    correlationId,
    deps,
    signal,
  );
  return { responseFormatModelIds, toolCallingObservations };
}

// The deadline that actually bounds ONE candidate's smoke call (PR #3602 review): `Gateway.chat()`
// floors every attempt at the interactive silence floor (several minutes) and retries once, so the
// candidate's configured `timeoutMs` alone no longer bounds anything — this caller-owned
// `AbortSignal.timeout` does. Reads the SAME `timeoutMs` `probeConfigForModels` gave this exact
// candidate's provider entry (`DISCOVERED_MODEL_SMOKE_TIMEOUT_MS` for discovery,
// `DEPLOYMENT_SMOKE_TIMEOUT_MS` for a manually entered deployment) rather than a hardcoded literal,
// so both smoke paths stay bounded at the timeout each already advertises; the discovery constant
// is only the defensive fallback for a candidate somehow missing its own provider entry.
function candidateSmokeCancellationSignal(
  config: GatewayConfig,
  modelId: string,
  signal?: AbortSignal,
): AbortSignal {
  const deadline = AbortSignal.timeout(candidateSmokeDeadlineMs(config, modelId));
  return signal === undefined ? deadline : AbortSignal.any([deadline, signal]);
}

// Never below the discovery smoke floor: a manually entered deployment keeps its shorter configured
// timeout for later calls, but a setup probe that gave up at 30 s on a gateway that answers in 45 s
// would leave a working model unverified (PR #3602 review). Exported for direct unit testing.
export function candidateSmokeDeadlineMs(config: GatewayConfig, modelId: string): number {
  const provider = config.providers.find((candidate) => candidate.modelId === modelId);
  return Math.max(provider?.timeoutMs ?? 0, DISCOVERED_MODEL_SMOKE_TIMEOUT_MS);
}

// Extracted so `defaultGatewaySetupTester` stays under the repository's per-function line ceiling
// (AGENTS.md §6) — the probe itself is the one line that matters: a fixed "reply OK" chat call,
// bounded by this candidate's own smoke deadline.
function chatSmokeProbe(
  gateway: Gateway,
  config: GatewayConfig,
  correlationId: string | undefined,
  signal?: AbortSignal,
): (modelId: string) => Promise<void> {
  return async (modelId) => {
    await gateway.chat({
      modelId,
      messages: [
        { role: "system", content: CONVERSATION_SYSTEM_PROMPT },
        { role: "user", content: "Reply with exactly: OK" },
      ],
      logContext: { correlationId },
      cancellationSignal: candidateSmokeCancellationSignal(config, modelId, signal),
    });
  };
}

async function defaultGatewaySetupTester(
  config: GatewayConfig,
  candidateModelIds: readonly string[],
  correlationId: string | undefined,
  deps: UiHandlerDeps,
  signal?: AbortSignal,
): Promise<GatewaySetupTestResult> {
  // Wired to the process activity log: first-run setup is where an operator's endpoint is wrong
  // in a way no UI message can name (a proxy that blocks CONNECT, a provider that answers 404 for
  // every model). Without the sink the smoke loop's retries and rejections are invisible.
  const gateway = new Gateway(config, {
    log: processServerLogSink(),
    spendBudget: gatewaySpendBudgetForEnv(deps.env),
  });
  const chatSmoke = await admitChatSmokeCandidates(
    candidateModelIds,
    chatSmokeProbe(gateway, config, correlationId, signal),
    SETUP_SMOKE_CONCURRENCY,
    deps,
    correlationId,
    Date.now,
    signal,
  );
  // Nothing was verified: the historic "no discovered model accepted the chat-completions smoke
  // test" case, thrown exactly as `smokeTestCandidates` always did — even when some candidates were
  // merely kept unverified rather than dropped, because `verifyAndSaveGatewaySetup`'s multi-base-URL
  // fallback and the whole-gateway `temporaryChatAdmission` deferral both need this throw to try the
  // next base URL / defer the round; only reached with zero survivors does the caller ever see it.
  // Once at least ONE candidate is genuinely tested, the base URL is known-reachable and a peer
  // candidate that merely timed out is kept unverified instead of dropped (#3591) — see below.
  if (chatSmoke.tested.length === 0) {
    throw allProbesFailedError(chatSmoke.allFailures);
  }
  const testedModelIds = chatSmoke.tested;
  const { responseFormatModelIds, toolCallingObservations } = await verifyTestedChatCandidates(
    gateway,
    config,
    testedModelIds,
    correlationId,
    deps,
    signal,
  );
  return {
    testedModelIds,
    responseFormatModelIds,
    toolCallingObservations: [
      ...(toolCallingObservations ?? []),
      ...unverifiedKeptToolCallingObservations(config, chatSmoke.unverifiedKept, correlationId),
    ],
    ...(chatSmoke.unverifiedKept.length > 0
      ? { unverifiedModelIds: chatSmoke.unverifiedKept }
      : {}),
    ...(chatSmoke.skippedByDeadline.length > 0
      ? { skippedModelIds: chatSmoke.skippedByDeadline }
      : {}),
    ...(chatSmoke.droppedRejected.length > 0 ? { droppedModelIds: chatSmoke.droppedRejected } : {}),
  };
}

// A candidate the smoke probe never got an answer from is kept but was never actually chat-probed,
// so its tool-calling status is "unverified" by definition — the SAME record and the SAME closed
// vocabulary `temporaryChatAdmission` already uses when the whole gateway defers, just per-candidate
// instead of gateway-wide (#3591).
function unverifiedKeptToolCallingObservations(
  config: GatewayConfig,
  unverifiedKept: readonly string[],
  correlationId: string | undefined,
): readonly GatewaySetupToolCallingObservation[] {
  const checkedAt = new Date().toISOString();
  return unverifiedKept.map((modelId) => {
    logToolCallingVerification(
      config,
      modelId,
      "unverified",
      correlationId ?? UNKNOWN_CORRELATION_ID,
    );
    return { modelId, status: "unverified", checkedAt };
  });
}

async function setupToolCallingObservations(
  config: GatewayConfig,
  testedModelIds: readonly string[],
  correlationId: string | undefined,
  deps: UiHandlerDeps,
  signal?: AbortSignal,
): Promise<readonly GatewaySetupToolCallingObservation[]> {
  const checkedAt = new Date().toISOString();
  const observations = new Array<GatewaySetupToolCallingObservation>(testedModelIds.length);
  await runBoundedWorkers(
    testedModelIds,
    SETUP_SMOKE_CONCURRENCY,
    async (modelId, index) => {
      const provider = config.providers.find((candidate) => candidate.modelId === modelId);
      // A model without a provider stays unverified; that conclusion takes the same log line below
      // as every probe result instead of being recorded silently.
      const probeStatus =
        provider === undefined
          ? "unverified"
          : await probeGatewayToolCalling(
              config,
              provider,
              undefined,
              (error) => {
                signal?.throwIfAborted();
                reportSetupVerificationFailure(
                  deps,
                  error,
                  correlationId,
                  "gateway.setup.tool-calling-probe",
                );
              },
              {
                env: deps.env,
                capability: findConfiguredCapability(config, modelId),
                correlationId: correlationId ?? UNKNOWN_CORRELATION_ID,
              },
              signal,
            );
      // A `transient` probe answer (408/429/5xx-except-501, `transientGatewayStatus`) proves
      // nothing about the model either way and must never be stored or logged as a verdict: the
      // closed status vocabulary here and on the `gateway.tool-calling.verification` activity-log
      // line stays exactly "verified" | "unsupported" | "unverified" (PR #3602 review).
      signal?.throwIfAborted();
      const status = probeStatus === "transient" ? "unverified" : probeStatus;
      observations[index] = { modelId, status, checkedAt };
      logToolCallingVerification(config, modelId, status, correlationId ?? UNKNOWN_CORRELATION_ID);
    },
    signal,
  );
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
  config: GatewayConfig,
  provider: ModelProviderConfig,
  modelId: string,
  env: EnvSource,
  correlationId: string,
  signal?: AbortSignal,
): Promise<OpenAIEmbeddingOutcome> {
  signal?.throwIfAborted();
  const reservation = reserveGatewaySpendForAttempt(
    env,
    findConfiguredCapability(config, modelId),
    {
      modelId,
      messages: [{ role: "user", content: "Gateway embedding setup probe." }],
      maxOutputTokens: 0,
    },
    correlationId,
  );
  try {
    return await requestOpenAIEmbedding({
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
      ...(signal === undefined ? {} : { signal }),
      // The probe exists because an embedding model used to be persisted on a classification alone.
      // The sink is what turns a rejected probe into a line naming the status and the error kind,
      // rather than a model that silently fails to make the candidate list.
      log: processServerLogSink(),
    });
  } finally {
    reservation?.settle(undefined);
  }
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

export async function defaultGatewayEmbeddingProbe(
  config: GatewayConfig,
  candidateModelIds: readonly string[],
  env: EnvSource,
  correlationId: string,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  return passingCandidates(
    candidateModelIds,
    async (modelId) => {
      const provider = config.providers.find((entry) => entry.modelId === modelId);
      if (provider === undefined) throw new Error("embedding candidate has no provider entry");
      let outcome = await embedOnceForProbe(config, provider, modelId, env, correlationId, signal);
      signal?.throwIfAborted();
      if (!outcome.ok && RETRYABLE_PROBE_KINDS.has(outcome.kind)) {
        await awaitSetupOperation(
          new Promise<void>((resolve) => setTimeout(resolve, EMBEDDING_PROBE_RETRY_DELAY_MS)),
          signal,
        );
        outcome = await embedOnceForProbe(config, provider, modelId, env, correlationId, signal);
      }
      // The per-model verdict is what the operator acts on, and it travels in
      // droppedEmbeddingModelIds / unverifiedEmbeddingModelIds. passingCandidates drops the
      // rejection, which is the intended contract here: a failed candidate is not admitted.
      if (!outcome.ok || outcome.value.vector.length === 0) {
        throw new Error("embedding probe returned no usable vector");
      }
    },
    SETUP_SMOKE_CONCURRENCY,
    undefined,
    signal,
  );
}

function gatewayEmbeddingProbe(
  deps: UiHandlerDeps,
  correlationId: string | undefined,
  signal?: AbortSignal,
): GatewayEmbeddingProbe {
  const override = deps.gatewayEmbeddingProbe;
  if (override !== undefined) return override;
  return (config, candidateModelIds) =>
    defaultGatewayEmbeddingProbe(
      config,
      candidateModelIds,
      deps.env,
      correlationId ?? UNKNOWN_CORRELATION_ID,
      signal,
    );
}

// A rerank probe answers two short documents; a healthy engine takes a moment, an unreachable one
// must not hold the setup response for the adapter's multi-minute retrieval floor. The caller
// signal is what bounds it (the adapter takes the SHORTER of its own deadline and the signal).
const RERANKER_SETUP_PROBE_DEADLINE_MS = 30_000;
// ...and one setup request has ONE budget for all of them. Per-probe deadlines alone stack: a
// gateway listing several rerank aliases behind an unreachable route held the response for
// 3 x 30 s per candidate URL, and the candidate-URL loop repeats the whole sequence. The budget
// starts at the first probe of the request and is shared by every engine and every candidate URL.
const RERANKER_SETUP_TOTAL_BUDGET_MS = 45_000;
// The reranker block's own default when the request states no provider timeout (the config parser
// applies the same value to a stored block that omits it).
const DEFAULT_RERANKER_TIMEOUT_MS = 120_000;

// The same two-document probe gateway readiness runs, over the request's own dependencies: the
// egress policy, spend guard and activity-log line all apply to a discovered engine exactly as
// they do to a configured one. Any failure — a refused request, a wrong ranking, a thrown
// transport error, an exhausted request budget — is "not admitted", never a failed setup.
function gatewayRerankerProbe(
  deps: UiHandlerDeps,
  correlationId: string | undefined,
  signal?: AbortSignal,
): GatewayRerankerProbe {
  let budgetEndsAt: number | undefined;
  return async (config) => {
    signal?.throwIfAborted();
    budgetEndsAt ??= Date.now() + RERANKER_SETUP_TOTAL_BUDGET_MS;
    const remainingMs = budgetEndsAt - Date.now();
    if (remainingMs <= 0) return false;
    try {
      const selection = await requestRerankerProbe({
        deps,
        config,
        correlationId: correlationId ?? UNKNOWN_CORRELATION_ID,
        signal: AbortSignal.any([
          AbortSignal.timeout(Math.min(RERANKER_SETUP_PROBE_DEADLINE_MS, remainingMs)),
          ...(signal === undefined ? [] : [signal]),
        ]),
      });
      return rerankerProbePassed(selection);
    } catch (error) {
      signal?.throwIfAborted();
      reportSetupVerificationFailure(deps, error, correlationId, "gateway.setup.reranker-probe");
      return false;
    }
  };
}

// The seam type (UiHandlerDeps["gatewaySetupTester"]) is a fixed 2-arg shape shared by every
// test override, so the request-scoped correlation id is closed over here rather than added as a
// 3rd seam parameter — the override contract stays untouched while the real tester still stamps
// GatewayCallRequest.logContext (ADR-0173 D5).
function gatewaySetupTester(
  deps: UiHandlerDeps,
  correlationId: string | undefined,
  signal?: AbortSignal,
): GatewaySetupTester {
  const override = deps.gatewaySetupTester;
  if (override !== undefined) return override;
  return (config, candidateModelIds) =>
    defaultGatewaySetupTester(config, candidateModelIds, correlationId, deps, signal);
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
  correlationId: string | undefined = UNKNOWN_CORRELATION_ID,
): void {
  persistSealedGatewayConfig(
    { ...raw, schemaVersion: GATEWAY_CONFIG_SCHEMA_VERSION },
    {
      env: deps.env,
      storagePath,
      evidenceDir: resolveEvidenceDir(deps.evidenceDir, deps.env),
      securityLogSink: bindSecurityLogCorrelation(processServerLogSink(), correlationId),
    },
  );
}

interface SetupRequest {
  readonly signal?: AbortSignal;
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
  readonly explicitDeploymentNames: readonly string[];
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
  /** Setup-only provenance: rebase this connection onto the verified primary URL candidate. */
  readonly followsSetupGateway?: boolean | undefined;
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
  gateway: SetupGatewayCredentials,
): { readonly baseUrl: string; readonly apiKey: string } | RouteResult {
  if (sharesPrimaryGatewayForVoice(raw, existing)) {
    return { baseUrl: gateway.baseUrl, apiKey: gateway.apiKey };
  }
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

function sharesPrimaryGatewayForVoice(
  raw: Record<string, unknown>,
  existing: ModelProviderConfig | undefined,
): boolean {
  return (
    existing === undefined &&
    !hasNonBlankStringField(raw, "voiceBaseUrl") &&
    !hasNonBlankStringField(raw, "voiceApiKey")
  );
}

function setupVoiceApiKeyHeaderName(
  raw: Record<string, unknown>,
  existing: ModelProviderConfig | undefined,
  preserveExisting: boolean,
  sharedGatewayHeader: string | undefined,
): SetupParseResult<string> {
  return normalizeSetupApiKeyHeaderName(
    raw.voiceApiKeyHeaderName ??
      sharedGatewayHeader ??
      setupVoiceApiKeyHeaderSource(raw, existing, preserveExisting),
  );
}

function setupVoiceProviderLocality(
  raw: Record<string, unknown>,
  existingCapability: ModelCapability | undefined,
  defaultLocality: VoiceProviderLocality,
): SetupParseResult<VoiceProviderLocality> {
  return parseVoiceProviderLocality(
    raw.voiceProviderLocality,
    existingCapability?.voiceProviderLocality ?? defaultLocality,
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
    ...sharedGatewayProvenance(defaults.followsSetupGateway === true),
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

function sharedGatewayProvenance(
  followsSetupGateway: boolean,
): Pick<SetupVoiceProvider, "followsSetupGateway"> | Record<string, never> {
  return followsSetupGateway ? { followsSetupGateway: true } : {};
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
  gateway: SetupGatewayCredentials,
  sharedGateway: boolean,
): SetupVoiceProviderDefaults {
  return {
    ...connection,
    ...sharedGatewayProvenance(sharedGateway),
    apiKeyHeaderName,
    timeoutMs: timeoutMs ?? existing?.timeoutMs,
    maxRetries: existing?.maxRetries ?? 1,
    retryBaseDelayMs: existing?.retryBaseDelayMs ?? 500,
    ...inheritedVoiceEndpoint(connection.baseUrl, existing, gateway, sharedGateway),
    providerLocality,
    ...inheritedCircuitBreakerFragment(existing),
  };
}

function inheritedVoiceEndpoint(
  baseUrl: string,
  existing: ModelProviderConfig | undefined,
  gateway: SetupGatewayCredentials,
  sharedGateway: boolean,
): VoiceProviderEndpointOptions {
  // The inherited provider's endpoint protocol (style, api version, realtime auth mode) is bound
  // to ITS base URL: it may seed the connection defaults only under the same URL-identity rule
  // the per-role template branch enforces. Without the guard, a preserve-mode move to a new host
  // (e.g. Azure -> LiteLLM) stamped the OLD provider's Azure protocol onto every role that had no
  // per-role template (LiteLLM production audit). Submitted endpoint fields still override these
  // defaults downstream (#3037).
  if (existing !== undefined && sameBaseUrlIdentity(baseUrl, existing.baseUrl)) {
    return voiceProviderTemplateEndpoint(existing, {});
  }
  return sharedGateway ? sharedGatewayVoiceEndpoint(gateway) : {};
}

function sharedGatewayVoiceEndpoint(
  gateway: SetupGatewayCredentials,
): VoiceProviderEndpointOptions {
  const endpointStyle = PROVIDER_ENDPOINT_STYLES.find((style) => style === gateway.endpointStyle);
  return {
    ...(endpointStyle === undefined ? {} : { endpointStyle }),
    ...(gateway.apiVersion === undefined ? {} : { apiVersion: gateway.apiVersion }),
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

function defaultVoiceProviderLocality(
  submittedEndpoint: SetupParseResult<VoiceProviderEndpointOptions | undefined>,
  gateway: SetupGatewayCredentials,
  sharedGateway: boolean,
): VoiceProviderLocality {
  const declaredStyle = submittedEndpoint.ok ? submittedEndpoint.value?.endpointStyle : undefined;
  return declaredStyle === "azure-openai-deployment" ||
    (sharedGateway && gateway.endpointStyle === "azure-openai-deployment")
    ? "azure-foundry"
    : "gateway-managed";
}

function parsedVoiceSetupOptions(
  raw: Record<string, unknown>,
  existing: ModelProviderConfig | undefined,
  existingCapability: ModelCapability | undefined,
  current: GatewayConfig | undefined,
  preserveExisting: boolean,
  gateway: SetupGatewayCredentials,
  sharedGateway: boolean,
): VoiceSetupOptions | RouteResult {
  const apiKeyHeaderName = setupVoiceApiKeyHeaderName(
    raw,
    existing,
    preserveExisting,
    sharedGateway ? gateway.apiKeyHeaderName : undefined,
  );
  const timeoutMs = optionalSetupPositiveInt(raw.voiceTimeoutMs, "voiceTimeoutMs");
  const submittedEndpoint = submittedVoiceEndpointOptions(raw);
  const providerLocality = setupVoiceProviderLocality(
    raw,
    existingCapability,
    defaultVoiceProviderLocality(submittedEndpoint, gateway, sharedGateway),
  );
  const supportsSemanticTurnDetection = setupSemanticTurnDetection(raw, current, preserveExisting);
  const speechSynthesisInstructions = optionalSetupBoolean(
    raw.voiceSupportsSpeechSynthesisInstructions,
    "voiceSupportsSpeechSynthesisInstructions",
  );
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
  gateway: SetupGatewayCredentials,
): readonly SetupVoiceProvider[] | RouteResult {
  const inputFieldError = validateVoiceInputFields(raw, correlationId);
  if (inputFieldError !== undefined) return inputFieldError;
  if (!hasVoiceProviderInput(raw)) return [];
  const existingVoiceProviders = preserveExisting ? setupVoiceProvidersFromCurrent(current) : [];
  const existing = inheritedVoiceProvider(current, preserveExisting);
  const sharedGateway = sharesPrimaryGatewayForVoice(raw, existing);
  const existingCapability = currentVoiceCapability(current, existing?.modelId);
  const roleIds = voiceRoleModelIds(raw, current, preserveExisting, correlationId);
  const connection = setupVoiceConnection(raw, existing, preserveExisting, gateway);
  const options = parsedVoiceSetupOptions(
    raw,
    existing,
    existingCapability,
    current,
    preserveExisting,
    gateway,
    sharedGateway,
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
  return assembleVoiceProvidersForSetup({
    connection: connection as { readonly baseUrl: string; readonly apiKey: string },
    options,
    existing,
    gateway,
    sharedGateway,
    roleIds: roleIds as VoiceRoleModelIds,
    raw,
    existingVoiceProviders,
    env,
  });
}

interface VoiceProviderAssembly {
  readonly connection: { readonly baseUrl: string; readonly apiKey: string };
  readonly options: VoiceSetupOptions;
  readonly existing: ModelProviderConfig | undefined;
  readonly gateway: SetupGatewayCredentials;
  readonly sharedGateway: boolean;
  readonly roleIds: VoiceRoleModelIds;
  readonly raw: Record<string, unknown>;
  readonly existingVoiceProviders: readonly SetupVoiceProvider[];
  readonly env: EnvSource;
}

function assembleVoiceProvidersForSetup(
  input: VoiceProviderAssembly,
): readonly SetupVoiceProvider[] | RouteResult {
  const defaults = setupVoiceProviderDefaults(
    input.connection,
    input.options.apiKeyHeaderName,
    input.options.timeoutMs,
    input.options.providerLocality,
    input.existing,
    input.gateway,
    input.sharedGateway,
  );
  const generated = providersForVoiceRoles(
    input.roleIds,
    defaults,
    input.raw,
    input.options,
    input.existingVoiceProviders,
  );
  const providers = mergeUntouchedVoiceProviders(
    generated,
    input.existingVoiceProviders,
    input.raw,
  );
  return validatedVoiceProviders(providers, input.env);
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
    explicitDeploymentNames: input.modelLists.deploymentNames,
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
    credentials,
  );
  if (isRouteResult(voiceProviders)) return voiceProviders;
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
    | "gateway.setup.tool-calling-probe"
    | "gateway.setup.reranker-probe"
    | "gateway.setup.chat-smoke-probe",
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
  /** Chat candidates the gateway answered and rejected — not configured (#3591). */
  readonly droppedChatModelIds?: readonly string[];
  /**
   * How setup resolved the retrieval reranker. It is logged when the setup COMMITS, once per
   * request — a candidate URL that is later refused, or a temporary admission that never persists,
   * must not leave a line claiming a reranker that was never wired.
   */
  readonly rerankerResolution?: RerankerSetupResolution;
}

interface SetupVerificationInput {
  readonly signal?: AbortSignal;
  readonly embeddingProbe: GatewayEmbeddingProbe;
  readonly rerankerProbe: GatewayRerankerProbe;
  readonly preserveExisting: boolean;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly apiKeyHeaderName: string;
  /** Generic endpoint protocol — see {@link SetupGatewayCredentials} (#3042). */
  readonly endpointStyle: string | undefined;
  readonly apiVersion: string | undefined;
  readonly timeoutMs: number | undefined;
  readonly deploymentNames: readonly string[];
  readonly explicitDeploymentNames: readonly string[];
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
  readonly voiceSpeechInputModelIds?: readonly string[];
  readonly voiceSpeechOutputModelIds?: readonly string[];
  readonly voiceRealtimeModelIds?: readonly string[];
  readonly unsupportedModels?: readonly GatewayUnsupportedDiscoveredModel[];
  // Rerank engines discovery recognised, in probe order (declared before name-inferred, then by id).
  // The admitted view drops the list and carries the decision instead: `reranker`.
  readonly rerankModelIds?: readonly string[];
  /** Admitted view only: the reranker block the rebuild persists (owned, or a probed engine). */
  readonly reranker?: RerankerConfig;
  /** Admitted view only: how the reranker was resolved — see {@link VerifiedSetup}. */
  readonly rerankerResolution?: RerankerSetupResolution;
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
      voiceSpeechInputModelIds: result.voiceSpeechInputModelIds ?? [],
      voiceSpeechOutputModelIds: result.voiceSpeechOutputModelIds ?? [],
      voiceRealtimeModelIds: result.voiceRealtimeModelIds ?? [],
      imageInputModelIds: result.imageInputModelIds ?? [],
      modelMetadata: result.modelMetadata ?? {},
      // KEIKO-0325: propagate the discovery-truncation flag from parseModelDiscovery
      // so downstream setup can surface "N of M models discovered" instead of the
      // pre-fix silent drop past MAX_DISCOVERED_MODELS.
      ...(result.truncated === true ? { truncated: true } : {}),
      ...(result.unsupportedModels !== undefined
        ? { unsupportedModels: result.unsupportedModels }
        : {}),
      ...(result.rerankModelIds !== undefined ? { rerankModelIds: result.rerankModelIds } : {}),
    };
  }
  return normalizeLegacyDiscoveryResult(result);
}

interface DeploymentNameRoles {
  readonly storedEmbeddingModelIds: readonly string[];
  /** Embedding ids the client itself asserted: an explicit role, unlike a stored one. */
  readonly submittedEmbeddingModelIds: readonly string[];
  readonly restoredVerbatimModelIds: readonly string[];
}

function candidateModelsFromDeploymentNames(
  deploymentNames: readonly string[],
  roles: DeploymentNameRoles,
): SetupCandidateModels {
  // Stored kinds win over the name heuristic: a preserve-mode rebuild must not chat-probe a
  // verified embedding or OCR deployment out of the config (review findings on #3031). Stored
  // OCR and dedicated-endpoint embedding providers leave the candidate set entirely — they are
  // restored verbatim afterwards.
  const restoredSet = new Set(roles.restoredVerbatimModelIds);
  const candidateNames = deploymentNames.filter((modelId) => !restoredSet.has(modelId));
  const storedEmbeddingSet = new Set(roles.storedEmbeddingModelIds);
  const submittedEmbeddingSet = new Set(roles.submittedEmbeddingModelIds);
  // A STORED embedding id that names a rerank engine is not an asserted role: field incident
  // (LiteLLM customer, 2026-08) — a declared `rerank` endpoint was filed as the gateway's embedding
  // model, and treating every stored id as asserted kept it there through every later save. It is
  // re-classified as a rerank candidate (probed, and wired only when nobody owns a reranker). A
  // client-submitted embedding id stays an explicit assertion.
  const rerankModelIds = candidateNames.filter(
    (modelId) =>
      storedEmbeddingSet.has(modelId) &&
      !submittedEmbeddingSet.has(modelId) &&
      isLikelyRerankModelId(modelId),
  );
  const rerankSet = new Set(rerankModelIds);
  const modelIds = candidateNames.filter((modelId) => !rerankSet.has(modelId));
  const embeddingModelIds = modelIds.filter(
    (modelId) =>
      storedEmbeddingSet.has(modelId) ||
      submittedEmbeddingSet.has(modelId) ||
      isLikelyEmbeddingModelId(modelId),
  );
  const embeddingSet = new Set(embeddingModelIds);
  return {
    modelIds,
    chatModelIds: modelIds.filter((modelId) => !embeddingSet.has(modelId)),
    embeddingModelIds,
    imageInputModelIds: [],
    modelMetadata: {},
    ...(rerankModelIds.length === 0
      ? {}
      : {
          rerankModelIds,
          unsupportedModels: rerankModelIds.map((id) => ({ id, reason: "rerank" as const })),
        }),
  };
}

// The embedding a previous configuration led with stays first: the default new Knowledge Pods bind
// is the first embedding provider, and a re-discovery — a key rotation, a gateway that now lists
// another engine ahead of it — must not rebind them silently. Everything new follows in discovery's
// own order (declared before name-inferred, then by id).
function withStoredEmbeddingOrder(
  discovered: SetupCandidateModels,
  stored: GatewayConfig | undefined,
): SetupCandidateModels {
  const present = new Set(discovered.embeddingModelIds);
  const kept = currentEmbeddingModelIds(stored).filter((modelId) => present.has(modelId));
  if (kept.length === 0) return discovered;
  const keptSet = new Set(kept);
  return {
    ...discovered,
    embeddingModelIds: [
      ...kept,
      ...discovered.embeddingModelIds.filter((modelId) => !keptSet.has(modelId)),
    ],
  };
}

async function candidateModelIdsForSetup(
  input: SetupVerificationInput,
  validationConfig: GatewayConfig,
): Promise<SetupCandidateModels> {
  if (input.deploymentNames.length > 0) {
    const selected = candidateModelsFromDeploymentNames(input.deploymentNames, {
      storedEmbeddingModelIds: input.storedEmbeddingModelIds,
      submittedEmbeddingModelIds: input.submittedEmbeddingModelIds,
      restoredVerbatimModelIds: [
        ...input.storedOcrModelIds,
        ...input.storedDedicatedEmbeddingModelIds,
        // Voice ids leave the candidate set too, but applyVoiceProviders restores them — they
        // must not join the verbatim-restore list below.
        ...input.storedVoiceModelIds,
      ],
    });
    return enrichSelectedDeploymentMetadata(input, validationConfig, selected);
  }
  return withStoredEmbeddingOrder(await discoverSetupModels(input, validationConfig), input.stored);
}

async function awaitSetupOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return operation;
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => {
      reject(new DOMException("Gateway setup cancelled.", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

function discoveryProgrammingFailure(cause: unknown): boolean {
  return (
    cause instanceof TypeError || cause instanceof ReferenceError || cause instanceof RangeError
  );
}

function discoveryHttpStatus(cause: unknown): number | undefined {
  const value =
    cause !== null && typeof cause === "object" && "httpStatus" in cause
      ? cause.httpStatus
      : undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

function discoveryTimedOut(cause: unknown): boolean {
  return (
    (cause instanceof Error && cause.name === "TimeoutError") ||
    (cause instanceof GatewayError && cause.code === ERROR_CODES.TIMEOUT)
  );
}

function discoveryAnswerIsUnusable(cause: unknown): boolean {
  if (cause === null || typeof cause !== "object" || !("discoveryCode" in cause)) return false;
  return (
    cause.discoveryCode === "DISCOVERY_EMPTY" ||
    cause.discoveryCode === "DISCOVERY_ALL_ENTRIES_UNSUPPORTED" ||
    cause.discoveryCode === "DISCOVERY_INVALID_RESPONSE"
  );
}

function discoveryRouteOutcome(cause: unknown, signal: AbortSignal): DiscoveryRouteOutcome {
  if (discoveryTimedOut(cause)) return "timeout";
  if (signal.aborted) return "cancelled";
  if (discoveryHttpStatus(cause) !== undefined) return "http-error";
  if (discoveryAnswerIsUnusable(cause)) return "unusable";
  return discoveryProgrammingFailure(cause) ? "failed" : "transport-error";
}

function discoveryFailureKind(cause: unknown, status: number | undefined): ActivityLogErrorKind {
  if (discoveryAnswerIsUnusable(cause)) return "validation-failed";
  if (status === 401 || status === 403) return "permission-denied";
  if (status === 429) return "rate-limited";
  if (discoveryTimedOut(cause)) return "timeout";
  return discoveryProgrammingFailure(cause) ? "internal" : "unavailable";
}

function discoveryFailureDetail(cause: unknown, cancelled: boolean): SetupMetadataFailure {
  const httpStatus = discoveryHttpStatus(cause);
  return {
    errorKind: cancelled ? "cancelled" : discoveryFailureKind(cause, httpStatus),
    evidence: {
      ...(httpStatus === undefined ? {} : { httpStatus }),
      frames: keikoStackFrames(cause),
      causeChain: causeChain(cause),
    },
  };
}

function metadataFailureOutcome(
  cause: unknown,
  signal: AbortSignal | undefined,
): "cancelled" | "failed" | "unavailable" {
  if (signal?.aborted === true) return "cancelled";
  return discoveryProgrammingFailure(cause) ? "failed" : "unavailable";
}

async function discoverSetupModels(
  input: SetupVerificationInput,
  validationConfig: GatewayConfig,
  selected?: SetupCandidateModels,
): Promise<SetupCandidateModels> {
  const startedAt = Date.now();
  const trace = createSetupDiscoveryTrace();
  const selectedModelCount = selectedModelCountOf(selected);
  try {
    input.signal?.throwIfAborted();
    const result = await awaitSetupOperation(
      input.discovery(
        input.baseUrl,
        input.apiKey,
        input.apiKeyHeaderName,
        validationConfig.egress,
        input.correlationId,
        trace,
      ),
      input.signal,
    );
    input.signal?.throwIfAborted();
    const normalized = normalizeDiscoveryResult(result);
    logSetupMetadataOutcome(
      {
        outcome: "available",
        ...(selected === undefined
          ? {}
          : { selectionCounts: selectedMetadataCounts(selected, normalized) }),
      },
      trace,
      startedAt,
      input.correlationId,
    );
    return normalized;
  } catch (cause) {
    const outcome = metadataFailureOutcome(cause, input.signal);
    logSetupMetadataOutcome(
      {
        outcome,
        ...(selectedModelCount === undefined ? {} : { selectionCounts: { selectedModelCount } }),
        failure: discoveryFailureDetail(cause, outcome === "cancelled"),
      },
      trace,
      startedAt,
      input.correlationId,
    );
    throw cause;
  }
}

function selectedDeploymentMetadata(
  selected: SetupCandidateModels,
  discovered: SetupCandidateModels,
): Readonly<Record<string, GatewayDiscoveredModelMetadata>> {
  const chat = new Set(discovered.chatModelIds);
  const embedding = new Set(discovered.embeddingModelIds);
  const compatible = [
    ...selected.chatModelIds.filter((id) => chat.has(id)),
    ...selected.embeddingModelIds.filter((id) => embedding.has(id)),
  ];
  return Object.fromEntries(
    compatible.flatMap((id) => {
      const metadata = discovered.modelMetadata[id];
      return metadata === undefined ? [] : [[id, metadata]];
    }),
  );
}

function selectedModelCountOf(selected: SetupCandidateModels): number;
function selectedModelCountOf(selected: SetupCandidateModels | undefined): number | undefined;
function selectedModelCountOf(selected: SetupCandidateModels | undefined): number | undefined {
  return selected === undefined
    ? undefined
    : selected.chatModelIds.length + selected.embeddingModelIds.length;
}

function selectedMetadataCounts(
  selected: SetupCandidateModels,
  discovered: SetupCandidateModels,
): SetupMetadataSelectionCounts {
  const allDiscovered = new Set(discovered.modelIds);
  let metadataEnrichedModelCount = 0;
  let roleMismatchModelCount = 0;
  let notDiscoveredModelCount = 0;
  const groups = [
    [selected.chatModelIds, discovered.chatModelIds],
    [selected.embeddingModelIds, discovered.embeddingModelIds],
  ] as const;
  for (const [selectedIds, discoveredIds] of groups) {
    const compatible = new Set(discoveredIds);
    for (const id of selectedIds) {
      if (!allDiscovered.has(id)) notDiscoveredModelCount++;
      else if (!compatible.has(id)) roleMismatchModelCount++;
      else if (Object.keys(discovered.modelMetadata[id] ?? {}).length > 0)
        metadataEnrichedModelCount++;
    }
  }
  return {
    selectedModelCount: selectedModelCountOf(selected),
    metadataEnrichedModelCount,
    roleMismatchModelCount,
    notDiscoveredModelCount,
  };
}

async function enrichSelectedDeploymentMetadata(
  input: SetupVerificationInput,
  validationConfig: GatewayConfig,
  selected: SetupCandidateModels,
): Promise<SetupCandidateModels> {
  try {
    const discovered = await discoverSetupModels(input, validationConfig, selected);
    reportDiscoveryTruncation(input.diagnostics, input.correlationId, discovered);
    return { ...selected, modelMetadata: selectedDeploymentMetadata(selected, discovered) };
  } catch (cause) {
    input.signal?.throwIfAborted();
    if (discoveryProgrammingFailure(cause)) throw cause;
    // Explicit deployments remain usable on gateways without a discovery endpoint. Their
    // existing smoke probes validate credentials and callable roles; discovery cannot add ids.
    return selected;
  }
}

function setupCatalogOriginOptions(input: SetupVerificationInput): ProviderRawOptions {
  return { explicitDeploymentNames: input.explicitDeploymentNames, catalogOrigin: "discovered" };
}

function finalRawConfigForSetup(
  input: SetupVerificationInput,
  testedModelIds: readonly string[],
  embeddingModelIds: readonly string[],
  imageInputModelIds: readonly string[],
  responseFormatModelIds: readonly string[],
  modelMetadata: Readonly<Record<string, GatewayDiscoveredModelMetadata>>,
  admittedModels: SetupCandidateModels,
): Record<string, unknown> {
  const configuredModelIds = mergeChatAndEmbeddingModelIds(testedModelIds, embeddingModelIds);
  const rawConfig = buildRawConfig(input.baseUrl, input.apiKey, configuredModelIds, {
    preserveExisting: input.preserveExisting,
    ...setupCatalogOriginOptions(input),
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
    ...rerankerBlockForSetup(admittedModels),
    ...(input.current?.egress === undefined ? {} : { egress: input.current.egress }),
    ...(input.figmaAccessToken === undefined
      ? {}
      : { figma: { accessToken: input.figmaAccessToken } }),
    ...operatorPolicyBlocks(input.current),
    ...codingOperatorSwitches(input.current),
  };
  // Verbatim restoration reads the DURABLE stored view: restored values are what the FILE
  // holds, so a transient per-model env override neither hides a sharing relationship nor gets
  // baked into the rebuilt persisted config (review finding on #3037).
  const voiceProviders = discoveredVoiceProvidersForSetup(input, admittedModels);
  return applyStoredDedicatedProviders(
    applyVoiceProviders(rawConfigWithOptionalBlocks, voiceProviders),
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

// The rebuild's reranker block is whatever `admitRerankerCandidates` decided: the reranker an
// operator (or an earlier setup) owns — rebased onto the setup connection when it rode the gateway,
// and verified there first when that connection moved to a new endpoint — or, only when nobody owns
// one, a discovered engine that passed its live probe. The plaintext key here is sealed into the
// credential vault by the same persistence step that seals every provider key; it never reaches the
// file or the response.
function rerankerBlockForSetup(admittedModels: SetupCandidateModels): {
  readonly reranker?: RerankerConfig;
} {
  return admittedModels.reranker === undefined ? {} : { reranker: admittedModels.reranker };
}

function discoveredVoiceProvidersForSetup(
  input: SetupVerificationInput,
  discovered: SetupCandidateModels,
): readonly SetupVoiceProvider[] {
  const configured =
    input.voiceProviders.length > 0
      ? input.voiceProviders
      : setupVoiceProvidersFromCurrent(input.stored);
  const voiceProviders = configured.map((provider) => rebaseSharedVoiceProvider(provider, input));
  const presentIds = new Set(configured.map((provider) => provider.modelId));
  const roles: readonly (readonly [VoiceDeploymentRole, readonly string[]])[] = [
    ["speechInput", discovered.voiceSpeechInputModelIds ?? []],
    ["speechOutput", discovered.voiceSpeechOutputModelIds ?? []],
    ["realtime", discovered.voiceRealtimeModelIds ?? []],
  ];
  for (const [role, modelIds] of roles) {
    for (const modelId of modelIds) {
      if (presentIds.has(modelId)) continue;
      presentIds.add(modelId);
      voiceProviders.push(discoveredVoiceProvider(input, modelId, role));
    }
  }
  return voiceProviders;
}

function rebaseSharedVoiceProvider(
  provider: SetupVoiceProvider,
  gateway: SetupVerificationInput,
): SetupVoiceProvider {
  const storedPrimary = storedPrimaryGatewayProvider(gateway.stored);
  if (!sharesStoredGatewayConnection(provider, storedPrimary)) return provider;
  const followsProtocol = spokeStoredGatewayProtocol(provider, storedPrimary);
  const endpointStyle = PROVIDER_ENDPOINT_STYLES.find((style) => style === gateway.endpointStyle);
  return {
    ...provider,
    baseUrl: gateway.baseUrl,
    apiKey: gateway.apiKey,
    apiKeyHeaderName: gateway.apiKeyHeaderName,
    endpointStyle: followsProtocol ? endpointStyle : provider.endpointStyle,
    apiVersion: followsProtocol ? gateway.apiVersion : provider.apiVersion,
  };
}

function discoveredVoiceProvider(
  input: SetupVerificationInput,
  modelId: string,
  role: VoiceDeploymentRole,
): SetupVoiceProvider {
  const endpointStyle = PROVIDER_ENDPOINT_STYLES.find((style) => style === input.endpointStyle);
  return {
    modelId,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    apiKeyHeaderName: input.apiKeyHeaderName,
    timeoutMs: input.timeoutMs,
    maxRetries: 1,
    retryBaseDelayMs: 500,
    ...(endpointStyle === undefined ? {} : { endpointStyle }),
    ...(input.apiVersion === undefined ? {} : { apiVersion: input.apiVersion }),
    // LiteLLM describes the role but not its upstream residency. A gateway-managed locality
    // states that limitation honestly instead of guessing from the gateway URL.
    providerLocality: "gateway-managed",
    capabilities: voiceRoleCapability(role),
  };
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
  provider: Pick<ModelProviderConfig, "baseUrl" | "apiKey" | "apiKeyHeaderName">,
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
  provider: Pick<ModelProviderConfig, "endpointStyle" | "apiVersion">,
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
    candidateModels,
  );
}

interface ChatAdmission {
  readonly testResult: GatewaySetupTestResult;
  readonly configuredModelIds: readonly string[];
  readonly unverifiedModelIds: readonly string[];
  /** The unverified candidates the smoke round's deadline never tried (PR #3602 review). */
  readonly skippedModelIds: readonly string[];
  /** Candidates the gateway answered and rejected — not configured (#3591). */
  readonly droppedModelIds: readonly string[];
}

function temporaryChatAdmission(
  input: SetupVerificationInput,
  candidateModels: SetupCandidateModels,
  candidateConfig: GatewayConfig,
): ChatAdmission {
  const checkedAt = new Date().toISOString();
  // The persisted "unverified" proof is a tool-calling conclusion like any probe result, so it
  // leaves the same activity-log line the probe path writes.
  for (const modelId of candidateModels.chatModelIds) {
    logToolCallingVerification(
      candidateConfig,
      modelId,
      "unverified",
      input.correlationId ?? UNKNOWN_CORRELATION_ID,
    );
  }
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
    skippedModelIds: [],
    droppedModelIds: [],
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
  const unverifiedModelIds = testResult.unverifiedModelIds ?? [];
  return {
    testResult,
    // A candidate kept unverified (timeout/transport) is still CONFIGURED, exactly like an
    // asserted embedding model that failed its probe (#3591).
    configuredModelIds: [...testResult.testedModelIds, ...unverifiedModelIds],
    unverifiedModelIds,
    skippedModelIds: testResult.skippedModelIds ?? [],
    droppedModelIds: testResult.droppedModelIds ?? [],
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
    correlationId: correlationId ?? UNKNOWN_CORRELATION_ID,
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

// A discovered rerank engine becomes the retrieval reranker only when nobody owns one and a live
// two-document probe answers — the same gate embedding candidates pass. A model the gateway DECLARED
// as `rerank` is still verified: a declaration says what the model is, not that its route works.
// Probing is bounded (a handful of candidates, sequentially, in discovery's declared-first order,
// inside one request-wide time budget) so a gateway that lists many rerank aliases cannot stretch
// setup, and the first engine that ranks wins.
const MAX_RERANKER_PROBES = 3;

interface RerankerAdmission {
  /** The reranker block the rebuild persists; absent when there is none. */
  readonly reranker?: RerankerConfig;
  /** The discovered engine that was wired; it leaves the "unsupported" report. */
  readonly admittedModelId?: string;
  /**
   * How setup resolved the reranker; drives the one body-free activity line, which is emitted at
   * commit. Absent when there was nothing to resolve.
   */
  readonly resolution?: RerankerSetupResolution;
}

// Stored or current: either view means an operator (or an earlier setup) already chose a reranker,
// and a discovered engine must never displace that choice. The runtime view wins; a reranker only
// the durable file names still survives the rewrite.
function ownedReranker(input: SetupVerificationInput): RerankerConfig | undefined {
  return input.current?.reranker ?? input.stored?.reranker;
}

// A reranker that rode the stored gateway connection (same endpoint AND credential — exactly what a
// discovered one does) follows a credential rotation or endpoint move like every other provider
// that shared it: left behind, it would keep sending a dead token and silently degrade retrieval.
// One with its own endpoint or credential keeps both — the freshly verified connection details
// never travel to a connection they were not tested against.
function rebasedReranker(input: SetupVerificationInput, reranker: RerankerConfig): RerankerConfig {
  if (!sharesStoredGatewayConnection(reranker, storedPrimaryGatewayProvider(input.stored))) {
    return reranker;
  }
  return {
    ...reranker,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    apiKeyHeaderName: input.apiKeyHeaderName,
  };
}

// The reranker block a discovered engine persists: the verified setup connection, nothing else.
function discoveredRerankerBlockFor(
  input: SetupVerificationInput,
  modelId: string,
): RerankerConfig {
  return {
    modelId,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    apiKeyHeaderName: input.apiKeyHeaderName,
    timeoutMs: input.timeoutMs ?? DEFAULT_RERANKER_TIMEOUT_MS,
  };
}

// The config a reranker is probed under: its own block on the verified setup connection, and the
// egress policy the request validated under unless the block states its own.
function withProbeEgress(input: SetupVerificationInput, reranker: RerankerConfig): RerankerConfig {
  return reranker.egress === undefined && input.egress !== undefined
    ? { ...reranker, egress: input.egress }
    : reranker;
}

function probeRerankerOn(
  input: SetupVerificationInput,
  validationConfig: GatewayConfig,
  reranker: RerankerConfig,
): Promise<boolean> {
  return input.rerankerProbe({ ...validationConfig, reranker: withProbeEgress(input, reranker) });
}

async function admitRerankerCandidates(
  input: SetupVerificationInput,
  validationConfig: GatewayConfig,
  candidates: readonly string[],
): Promise<RerankerAdmission> {
  const owned = ownedReranker(input);
  if (owned === undefined) return admitDiscoveredRerankers(input, validationConfig, candidates, 0);
  const carried = rebasedReranker(input, owned);
  const candidateCount = candidates.length;
  if (sameBaseUrlIdentity(owned.baseUrl, carried.baseUrl)) {
    // Its own connection, or the gateway's endpoint unchanged (a credential rotation): nothing new
    // to verify — the model is hosted where it always was.
    return {
      reranker: carried,
      ...(candidateCount === 0
        ? {}
        : { resolution: { outcome: "kept-existing", candidateCount, probedCount: 0 } }),
    };
  }
  // It rode the gateway to a NEW endpoint. Nothing says that gateway hosts this model, so it is
  // verified there before it is repointed; when it does not answer it is no longer owned, and
  // discovery on the new gateway decides.
  if (await probeRerankerOn(input, validationConfig, carried)) {
    return {
      reranker: carried,
      resolution: { outcome: "kept-existing", candidateCount, probedCount: 1 },
    };
  }
  return admitDiscoveredRerankers(input, validationConfig, candidates, 1);
}

async function admitDiscoveredRerankers(
  input: SetupVerificationInput,
  validationConfig: GatewayConfig,
  candidates: readonly string[],
  alreadyProbed: number,
): Promise<RerankerAdmission> {
  const candidateCount = candidates.length;
  if (candidateCount === 0 && alreadyProbed === 0) return {};
  let probedCount = alreadyProbed;
  for (const modelId of candidates.slice(0, MAX_RERANKER_PROBES)) {
    probedCount += 1;
    const block = discoveredRerankerBlockFor(input, modelId);
    if (await probeRerankerOn(input, validationConfig, block)) {
      return {
        reranker: block,
        admittedModelId: modelId,
        resolution: { outcome: "wired", wiredModelId: modelId, candidateCount, probedCount },
      };
    }
  }
  return { resolution: { outcome: "probe-failed", candidateCount, probedCount } };
}

// The admitted view of the candidates: the reranker decision travels with it, and the engine that
// passed its probe leaves the "unsupported" report — the operator sees what Keiko did NOT configure.
function withRerankerAdmission(
  candidateModels: SetupCandidateModels,
  admission: RerankerAdmission,
): SetupCandidateModels {
  const { admittedModelId } = admission;
  const { unsupportedModels, rerankModelIds: _candidates, ...admitted } = candidateModels;
  const stillUnsupported = (unsupportedModels ?? []).filter(
    (entry) => entry.id !== admittedModelId,
  );
  return {
    ...admitted,
    ...(admission.reranker === undefined ? {} : { reranker: admission.reranker }),
    ...(admission.resolution === undefined ? {} : { rerankerResolution: admission.resolution }),
    ...(stillUnsupported.length === 0 ? {} : { unsupportedModels: stillUnsupported }),
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
    correlationId: correlationId ?? UNKNOWN_CORRELATION_ID,
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

// Chat counterpart of `reportUnusableDiscoveredModels`, emitted separately because the chat smoke
// test itself decides whether setup fails closed (an all-rejected gateway throws before this point
// is ever reached) — see `verifySetupCandidate`. Body-free: counts only, never a model id (#3591).
function reportChatSmokeAdmission(
  diagnostics: ServerDiagnosticSink | undefined,
  correlationId: string | undefined,
  chatAdmission: ChatAdmission,
): void {
  const unverified = chatAdmission.unverifiedModelIds.length;
  const dropped = chatAdmission.droppedModelIds.length;
  if (unverified === 0 && dropped === 0) return;
  emitServerDiagnostic(diagnostics, {
    correlationId: correlationId ?? UNKNOWN_CORRELATION_ID,
    timestamp: new Date().toISOString(),
    operation: "POST /api/gateway/setup",
    source: "gateway-setup.discovery",
    errorClass: "GatewayDiscoveryUnusableModels",
    message:
      "Setup kept chat candidates the smoke test never got an answer from and dropped candidates the gateway answered and rejected.",
    code: "GATEWAY_DISCOVERY_UNUSABLE_MODELS",
    unverifiedChatModelCount: unverified,
    droppedChatModelCount: dropped,
    // How many of the unverified candidates the round's deadline never tried, and the deadline
    // that applied, so a skipped model is not mistaken for one that timed out (PR #3602 review).
    skippedChatModelCount: chatAdmission.skippedModelIds.length,
    chatSmokeRoundDeadlineMs: CHAT_SMOKE_ROUND_DEADLINE_MS,
  });
}

// KEIKO-0884 (#3333): every non-public egress target class (private, link-local, metadata)
// requires an explicit env opt-in to be accepted by Gateway Setup; loopback is the only class
// silently accepted with no configuration signal, no log line, and no opt-in trail — a deliberate
// product choice (local sidecar providers, Ollama-style, #2387 research egress), not a defect. The
// gap is purely observability: an operator investigating an unexpected Gateway Setup acceptance had
// no record that a loopback target was the one silently let through. Body-free by construction, the
// same pattern as `reportDiscoveryTruncation` above — a fixed code, never the raw baseUrl/host/port.
function reportLoopbackTargetAccepted(
  diagnostics: ServerDiagnosticSink | undefined,
  correlationId: string | undefined,
  baseUrl: string,
): void {
  if (gatewaySetupTargetClass(baseUrl) !== "loopback") return;
  emitServerDiagnostic(diagnostics, {
    correlationId: correlationId ?? UNKNOWN_CORRELATION_ID,
    timestamp: new Date().toISOString(),
    operation: "POST /api/gateway/setup",
    source: "gateway-setup.candidate",
    errorClass: "GatewaySetupLoopbackTargetAccepted",
    message: "Gateway Setup accepted a loopback candidate target.",
    code: "GATEWAY_SETUP_LOOPBACK_TARGET_ACCEPTED",
  });
}

// Isolates the chat-smoke-test call from verifySetupCandidate: on a temporary gateway failure,
// the caller must defer to a retry rather than fail the setup outright, replaying the exact
// verified-setup construction it would have used had the smoke test itself succeeded.
async function admitChatCandidatesOrDefer(
  input: SetupVerificationInput,
  candidateModels: SetupCandidateModels,
  admittedModels: SetupCandidateModels,
  candidateConfig: ReturnType<typeof probeConfigForModels>,
  embeddingAdmission: EmbeddingAdmission,
): Promise<ChatAdmission> {
  try {
    return await admitChatCandidates(input, candidateModels, candidateConfig);
  } catch (error) {
    if (!temporaryGatewaySetupFailure(error)) throw error;
    throw new DeferredTemporaryChatAdmission(error, () =>
      verifiedSetupFromChatAdmission(
        input,
        admittedModels,
        candidateConfig,
        embeddingAdmission,
        temporaryChatAdmission(input, candidateModels, candidateConfig),
      ),
    );
  }
}

async function verifySetupCandidate(input: SetupVerificationInput): Promise<VerifiedSetup> {
  // Defence-in-depth: never send the credential to a candidate URL that has not passed the same
  // scheme/credential/loopback validation as the originally submitted base URL.
  validateBaseUrl(input.baseUrl, "candidate", input.egress);
  reportLoopbackTargetAccepted(input.diagnostics, input.correlationId, input.baseUrl);
  const validationConfig = validationConfigForSetup(input);
  const candidateModels = await candidateModelIdsForSetup(input, validationConfig);
  input.signal?.throwIfAborted();
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
  input.signal?.throwIfAborted();
  const rerankerAdmission = await admitRerankerCandidates(
    input,
    validationConfig,
    candidateModels.rerankModelIds ?? [],
  );
  const admittedModels = withRerankerAdmission(
    { ...candidateModels, embeddingModelIds: embeddingAdmission.admitted },
    rerankerAdmission,
  );
  // Emitted BEFORE the chat smoke test: the tester throws on an all-rejected gateway, and the
  // record of what discovery refused is most valuable for exactly that failed attempt.
  reportUnusableDiscoveredModels(
    input.diagnostics,
    input.correlationId,
    admittedModels.unsupportedModels ?? [],
    embeddingAdmission,
  );
  input.signal?.throwIfAborted();
  const chatAdmission = await admitChatCandidatesOrDefer(
    input,
    candidateModels,
    admittedModels,
    candidateConfig,
    embeddingAdmission,
  );
  reportChatSmokeAdmission(input.diagnostics, input.correlationId, chatAdmission);
  return verifiedSetupFromChatAdmission(
    input,
    admittedModels,
    candidateConfig,
    embeddingAdmission,
    chatAdmission,
  );
}

function verifiedSetupFromChatAdmission(
  input: SetupVerificationInput,
  admittedModels: SetupCandidateModels,
  candidateConfig: GatewayConfig,
  embeddingAdmission: EmbeddingAdmission,
  chatAdmission: ChatAdmission,
): VerifiedSetup {
  const { testResult } = chatAdmission;
  if (input.imageInputModelIdsProvided) {
    assertImageInputModelsWereTested(input.imageInputModelIds, chatAdmission.configuredModelIds);
  }
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
    admittedModels,
    embeddingAdmission,
    chatAdmission,
  );
}

function verifiedSetupResult(
  rawConfig: Record<string, unknown>,
  config: GatewayConfig,
  testResult: GatewaySetupTestResult,
  admittedModels: SetupCandidateModels,
  embeddingAdmission: EmbeddingAdmission,
  chatAdmission: ChatAdmission,
): VerifiedSetup {
  return {
    rawConfig,
    config,
    testedModelIds: testResult.testedModelIds,
    skippedModelIds: skippedModelIdsForSetup(
      admittedModels.modelIds,
      chatAdmission.configuredModelIds,
      embeddingAdmission.admitted,
    ),
    ...(admittedModels.unsupportedModels !== undefined
      ? { unsupportedModels: admittedModels.unsupportedModels }
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
    ...(chatAdmission.droppedModelIds.length > 0
      ? { droppedChatModelIds: chatAdmission.droppedModelIds }
      : {}),
    ...(admittedModels.rerankerResolution !== undefined
      ? { rerankerResolution: admittedModels.rerankerResolution }
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
    // The sanctioned fallback, not a fresh mint (AGENTS.md §8). `record.correlationId` is reused
    // by both diagnostics below, so a minted UUID here would key the persisted audit evidence and
    // its failure diagnostics to a different identity than the loopback/discovery diagnostics this
    // same request emits under UNKNOWN_CORRELATION_ID — one request, two correlation identities,
    // unjoinable in a support report. (The randomUUID below is an evidence-store KEY, not a
    // correlation id, and is correct.)
    correlationId: request.correlationId ?? UNKNOWN_CORRELATION_ID,
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
  readonly droppedChatModelIds?: readonly string[];
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
      ...(discoveryReport.droppedChatModelIds !== undefined
        ? { droppedChatModelIds: discoveryReport.droppedChatModelIds }
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
  // The per-candidate smoke deadline firing during the gateway's retry backoff (PR #3602 review):
  // a whole round that ends this way is deferred exactly like one that timed out.
  ERROR_CODES.CANCELLED,
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

// One resolution per committed setup request. A probe that failed leaves reranking off with nothing
// else on screen, so besides the (warn-level) resolution line it leaves one body-free diagnostic:
// a fixed code, never a model id, an endpoint or a credential — the engine is named in the setup
// response the operator reads.
function reportRerankerResolution(
  deps: UiHandlerDeps,
  resolution: RerankerSetupResolution | undefined,
  correlationId: string | undefined,
): void {
  if (resolution === undefined) return;
  logRerankerSetupResolution(resolution, correlationId);
  if (resolution.outcome !== "probe-failed") return;
  emitServerDiagnostic(deps.diagnostics, {
    correlationId: correlationId ?? UNKNOWN_CORRELATION_ID,
    timestamp: new Date().toISOString(),
    operation: "POST /api/gateway/setup",
    source: "gateway.setup.reranker-probe",
    errorClass: "GatewayRerankerProbeFailed",
    message: "Provider verification failed without exposing upstream response details.",
    code: "GATEWAY_RERANKER_PROBE_FAILED",
  });
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
    request.correlationId,
  );
  gatewayConfig.set(verified.config, true, request.correlationId);
  for (const modelId of verified.testedModelIds) {
    gatewayConfig.recordVerifiedCapability(
      modelId,
      { conversationReady: true },
      new Date().toISOString(),
      gatewayConfig.generation(),
    );
  }
  logVoiceSetupResolution(verified.config, request.correlationId);
  reportRerankerResolution(deps, verified.rerankerResolution, request.correlationId);
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
    ...(verified.droppedChatModelIds !== undefined
      ? { droppedChatModelIds: verified.droppedChatModelIds }
      : {}),
  });
}

/** The three injectable gateway seams, travelling together so the candidate loop stays readable. */
interface SetupSeams {
  readonly tester: GatewaySetupTester;
  readonly discovery: GatewayModelDiscovery;
  readonly embeddingProbe: GatewayEmbeddingProbe;
  readonly rerankerProbe: GatewayRerankerProbe;
}

async function trySetupCandidate(
  baseUrl: string,
  request: SetupRequest,
  deps: UiHandlerDeps,
  gatewayConfig: RuntimeGatewayConfig,
  seams: SetupSeams,
  current: GatewayConfig | undefined,
): Promise<RouteResult> {
  request.signal?.throwIfAborted();
  const verified = await verifySetupCandidate({
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    embeddingProbe: seams.embeddingProbe,
    rerankerProbe: seams.rerankerProbe,
    preserveExisting: request.preserveExisting,
    baseUrl,
    apiKey: request.apiKey,
    apiKeyHeaderName: request.apiKeyHeaderName,
    endpointStyle: request.endpointStyle,
    apiVersion: request.apiVersion,
    timeoutMs: request.timeoutMs,
    deploymentNames: request.deploymentNames,
    explicitDeploymentNames: request.explicitDeploymentNames,
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
    voiceProviders: request.voiceProviders.map((provider) =>
      provider.followsSetupGateway === true ? { ...provider, baseUrl } : provider,
    ),
    tester: seams.tester,
    discovery: seams.discovery,
    env: deps.env,
    egress: egressForCandidateValidation(deps),
    figmaAccessToken: request.figmaAccessToken,
    current,
    diagnostics: deps.diagnostics,
    correlationId: request.correlationId,
  });
  request.signal?.throwIfAborted();
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
  correlationId: string | undefined,
): GatewayConfig | undefined {
  if (current === undefined || !existsSync(storagePath)) return current;
  try {
    const parsed = loadConfigFromFile(storagePath, withoutPerModelEnvOverrides(deps.env), {
      ...linkLocalGatewayOverrideOptions(deps.env),
      secretResolver: createProviderSecretResolver({
        configPath: storagePath,
        env: deps.env,
        securityLogSink: bindSecurityLogCorrelation(
          processServerLogSink(),
          correlationId ?? UNKNOWN_CORRELATION_ID,
        ),
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
  persistGatewayConfig(persistedRawConfig, gatewayConfig.storagePath, deps, request.correlationId);
  if (gatewayConfig.replaceConfigured === undefined)
    gatewayConfig.set(config, true, request.correlationId);
  else gatewayConfig.replaceConfigured(config, request.correlationId);
  logVoiceSetupResolution(config, request.correlationId);
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
  request.signal?.throwIfAborted();
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
    tester: gatewaySetupTester(deps, request.correlationId, request.signal),
    embeddingProbe: gatewayEmbeddingProbe(deps, request.correlationId, request.signal),
    rerankerProbe: gatewayRerankerProbe(deps, request.correlationId, request.signal),
    discovery:
      deps.gatewayModelDiscovery ??
      ((...args): Promise<GatewayModelDiscoveryOutput> =>
        defaultGatewayModelDiscovery(...args, request.signal, request.deploymentNames.length > 0)),
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

function originalSetupVerificationError(error: unknown): unknown {
  return error instanceof DeferredTemporaryChatAdmission ? error.original : error;
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
      if (request.signal?.aborted === true) return { failures: [...failures, { baseUrl, error }] };
      reportSetupVerificationFailure(
        deps,
        originalSetupVerificationError(error),
        request.correlationId,
        "gateway.setup.provider-verify",
      );
      failures.push({
        baseUrl,
        error: originalSetupVerificationError(error),
        ...(error instanceof DeferredTemporaryChatAdmission
          ? { resumeTemporaryAdmission: error.resume }
          : {}),
      });
      if (discoveryProgrammingFailure(error)) return { failures };
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
  if (request.signal?.aborted === true)
    return setupFailureResult(candidateFailureMessages(failures), request.correlationId);
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
      const verified = resume();
      const workflowEligibilityError = validateWorkflowEligibleModelIds(request, verified.config);
      if (workflowEligibilityError !== undefined) return workflowEligibilityError;
      return finalizeVerifiedCandidate(verified, current, deps, gatewayConfig, request);
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
  const current = gatewayConfig.configured?.() ?? currentGatewayConfig(deps);
  const stored = durableStoredGatewayConfig(
    current,
    gatewayConfig.storagePath,
    deps,
    ctx.correlationId,
  );
  const bodyResult = await readJsonSetupBody(ctx);
  if ("status" in bodyResult) {
    return bodyResult;
  }
  const request = readSetupRequest(bodyResult.parsed, deps.env, current, stored, ctx.correlationId);
  if ("status" in request) {
    return request;
  }
  const cancellation = createRequestCancellation(ctx, "Gateway setup client disconnected.");
  const cancellableRequest = { ...request, signal: cancellation.signal };
  try {
    if (!request.verifyGateway && current !== undefined) {
      return await verifyAndSaveExistingConfigUpdate(
        cancellableRequest,
        current,
        deps,
        gatewayConfig,
      );
    }
    return await verifyAndSaveGatewaySetup(cancellableRequest, current, deps, gatewayConfig);
  } finally {
    cancellation.dispose();
  }
}

const VERIFIED_CAPABILITY_FIELDS = new Set<keyof VerifiedModelCapabilityFields>([
  "streaming",
  "toolCalling",
  "structuredOutput",
  "supportsImageInput",
  "supportsDocumentInput",
  "contextWindow",
]);

// The readiness long-context probe never tests more than 128,000 tokens, so a larger submitted
// value cannot match any recorded observation and is rejected before that comparison.
const MAX_VERIFIED_CONTEXT_WINDOW = 128_000;

interface CapabilityApplyRequest {
  readonly fields: VerifiedModelCapabilityFields;
}

function verifiedFieldValue(field: string, value: unknown): boolean | number | undefined {
  if (field !== "contextWindow") return typeof value === "boolean" ? value : undefined;
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_VERIFIED_CONTEXT_WINDOW
    ? value
    : undefined;
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
    const parsed = verifiedFieldValue(field, rawValue);
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
    // The long-context probe proves a lower bound, so it may raise a stored window, never shrink
    // it. It does not end an assumed or provider-reported window: only the provider's own
    // statement does (gateway-context-window.ts), so conversations keep planning the assumption and
    // the window probe keeps running, while the Coding Workbench reads the proven floor.
    ...(fields.contextWindow === undefined
      ? {}
      : { contextWindow: Math.max(current.contextWindow, fields.contextWindow) }),
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
  const configured = deps.gatewayConfig?.forPersistence?.(updated) ?? updated;
  const raw = rawConfigFromCurrent(configured, configured.figma?.accessToken);
  return withPersistedGatewayEgress(raw, storagePath, deps);
}

function persistVerifiedCapabilityUpdate(
  gatewayConfig: RuntimeGatewayConfig,
  deps: UiHandlerDeps,
  modelId: string,
  generation: number,
  updated: GatewayConfig,
  consumeObservation = true,
  correlationId: string | undefined = UNKNOWN_CORRELATION_ID,
): RouteResult {
  const raw = rawConfigForVerifiedCapabilityUpdate(updated, gatewayConfig.storagePath, deps);
  try {
    persistGatewayConfig(raw, gatewayConfig.storagePath, deps, correlationId);
  } catch (error) {
    // A live negative tool verdict must take effect even if its durable evidence cannot be saved.
    // Continuing to route tool calls on the old in-memory proof would widen authority exactly when
    // the latest provider observation says it is no longer justified.
    if (!consumeObservation) {
      applyVerifiedCapabilityUpdate(
        gatewayConfig,
        modelId,
        generation,
        updated,
        false,
        correlationId,
      );
    }
    throw error;
  }
  return applyVerifiedCapabilityUpdate(
    gatewayConfig,
    modelId,
    generation,
    updated,
    consumeObservation,
    correlationId,
  );
}

function applyVerifiedCapabilityUpdate(
  gatewayConfig: RuntimeGatewayConfig,
  modelId: string,
  generation: number,
  updated: GatewayConfig,
  consumeObservation = true,
  correlationId?: string,
): RouteResult {
  // Persistence is synchronous, so no configuration mutation can interleave between the
  // generation check in the handler and this consumption. Keep the live observation available
  // when durable storage fails, allowing the operator to retry the exact verified update.
  // Applying feature evidence consumes it. Preserve conversation readiness at its original
  // checkedAt on unchanged active connections; never re-stamp an unrelated model's old tool proof.
  // The source-retaining catalog facet also keeps inactive credentials out of the active inventory.
  const observations = updated.providers
    .map((provider) => ({
      modelId: provider.modelId,
      observation: gatewayConfig.verifiedCapability(provider.modelId),
    }))
    .filter((entry) => entry.observation !== undefined)
    .map((entry) => ({
      ...entry,
      fields:
        !consumeObservation && entry.modelId === modelId
          ? (entry.observation?.fields ?? {})
          : preservedVerifiedCapabilityFields(entry.observation?.fields ?? {}),
    }))
    .filter((entry) => Object.keys(entry.fields).length > 0);
  if (consumeObservation && !gatewayConfig.clearVerifiedCapability(modelId, generation)) {
    return staleCapabilityObservationResult();
  }
  if (gatewayConfig.replaceCatalog === undefined) gatewayConfig.set(updated, true, correlationId);
  else if (!gatewayConfig.replaceCatalog(updated, generation, correlationId))
    return staleCapabilityObservationResult();
  clearAppliedCapabilityObservations(gatewayConfig, updated);
  for (const entry of observations) {
    gatewayConfig.recordVerifiedCapability(
      entry.modelId,
      entry.fields,
      entry.observation?.checkedAt ?? new Date().toISOString(),
      undefined,
      entry.observation?.conversationCheckedAt,
    );
  }
  return { status: 200, body: { ok: true, model: findConfiguredCapability(updated, modelId) } };
}

function clearAppliedCapabilityObservations(
  holder: RuntimeGatewayConfig,
  updated: GatewayConfig,
): void {
  for (const provider of updated.providers) holder.clearVerifiedCapability(provider.modelId);
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
    correlationId,
  );
}

/**
 * Raises a stored context window to the token count the long-context probe just proved, without a
 * UI confirmation — the standing the tool-calling conclusion already has. A proven count is a lower
 * bound, so this only ever raises. Customer report on 1.1.0: a gateway that declares no token
 * limits left the 4,096 setup placeholder in place and the Coding Workbench refused every model;
 * what Keiko can determine itself must not be left for the operator to copy by hand.
 */
export function reconcileGatewayContextWindowReadiness(
  deps: UiHandlerDeps,
  report: GatewayReadinessReport,
  observedGeneration: number | undefined,
  correlationId = UNKNOWN_CORRELATION_ID,
): void {
  const verified = report.verifiedCapabilities.testedContextTokens;
  if (verified === undefined || verified > MAX_VERIFIED_CONTEXT_WINDOW) return;
  const reconciliation = currentToolCallingReconciliation(deps, observedGeneration);
  if (reconciliation === undefined) return;
  const stored = findConfiguredCapability(reconciliation.current, report.modelId);
  if (stored?.kind !== "chat") return;
  if (stored.contextWindowAssumed !== true && stored.contextWindow >= verified) return;
  const updated = replaceModelCapability(
    reconciliation.current,
    report.modelId,
    { contextWindow: verified },
    report.checkedAt,
  );
  if (updated === undefined) return;
  persistVerifiedCapabilityUpdate(
    reconciliation.gatewayConfig,
    deps,
    report.modelId,
    reconciliation.gatewayConfig.generation(),
    updated,
    false,
    correlationId,
  );
}

export type AdoptedContextWindowOutcome =
  | {
      readonly state: "adopted";
      readonly previousContextWindow: number;
      readonly wasAssumed: boolean;
    }
  | { readonly state: "unchanged" | "not-chat" | "unconfigured" };

// A window the operator declared is the operator's cap: the provider may lower it (the deployment
// cannot take more than it says) but never raise it. An assumed window and one a provider already
// reported are learned values and follow the provider in either direction.
function providerStatementLeavesWindow(stored: ModelCapability, tokens: number): boolean {
  if (stored.contextWindowAssumed === true) return false;
  if (stored.contextWindow === tokens) return true;
  return stored.contextWindowReported !== true && tokens > stored.contextWindow;
}

/**
 * Adopts the total context window a provider stated itself — in its overflow answer or in answer to
 * the startup context-window probe. Unlike the long-context probe's lower bound this is the
 * deployment's exact limit, so it ends an assumed window and replaces a learned one in either
 * direction; a declared window is only ever lowered. It is applied as a refinement: the
 * configuration generation stays, so a turn already admitted (the one whose overflow reported the
 * window) can re-plan and retry, while every later lookup plans the model with the real window. The
 * refinement is applied before the durable write, so an unwritable configuration file never keeps
 * the window unlearned: the write failure is reported as a diagnostic and the window applies in
 * memory until the next restart.
 */
export function persistAdoptedContextWindow(
  deps: UiHandlerDeps,
  modelId: string,
  contextWindowTokens: number,
  correlationId: string,
): AdoptedContextWindowOutcome {
  const reconciliation = currentToolCallingReconciliation(deps, undefined);
  if (reconciliation === undefined) return { state: "unconfigured" };
  const stored = findConfiguredCapability(reconciliation.current, modelId);
  if (stored?.kind !== "chat") return { state: "not-chat" };
  if (providerStatementLeavesWindow(stored, contextWindowTokens)) return { state: "unchanged" };
  const updated = replaceCapabilityContextWindow(
    reconciliation.current,
    stored,
    contextWindowTokens,
  );
  applyContextWindowRefinement(reconciliation.gatewayConfig, deps, modelId, updated, correlationId);
  return {
    state: "adopted",
    previousContextWindow: stored.contextWindow,
    wasAssumed: stored.contextWindowAssumed === true,
  };
}

function applyContextWindowRefinement(
  gatewayConfig: RuntimeGatewayConfig,
  deps: UiHandlerDeps,
  modelId: string,
  updated: GatewayConfig,
  correlationId: string,
): void {
  try {
    if (gatewayConfig.refine === undefined) {
      // Applies in memory even when the durable write fails, then rethrows the write failure.
      persistVerifiedCapabilityUpdate(
        gatewayConfig,
        deps,
        modelId,
        gatewayConfig.generation(),
        updated,
        false,
        correlationId,
      );
      return;
    }
    gatewayConfig.refine(updated, correlationId);
    const raw = rawConfigForVerifiedCapabilityUpdate(updated, gatewayConfig.storagePath, deps);
    persistGatewayConfig(raw, gatewayConfig.storagePath, deps, correlationId);
  } catch (error) {
    emitServerDiagnostic(
      deps.diagnostics,
      serverDiagnosticFromError({
        correlationId,
        operation: "gateway.context-window",
        source: "gateway-setup.adopted-context-window",
        error,
        summary: "The verified gateway context window could not be persisted.",
        redact: (message): string => String(deps.redactor(message)),
      }),
    );
  }
}

// A declared window the provider lowered stays declared: the lowered value is the operator's cap
// from now on, so a later statement can lower it further but never raise it past the ceiling the
// operator set — not in this process and not after a restart (PR #3678 review, P1). Only an assumed
// or already learned window becomes a reported one that follows the provider either way.
function replaceCapabilityContextWindow(
  config: GatewayConfig,
  stored: ModelCapability,
  contextWindow: number,
): GatewayConfig {
  const declared = stored.contextWindowAssumed !== true && stored.contextWindowReported !== true;
  const replacement = {
    ...withoutAssumedContextWindow(stored),
    contextWindow,
    ...(declared ? {} : { contextWindowReported: true }),
  };
  const capabilities = [...(config.capabilities ?? [])];
  const index = capabilities.findIndex((capability) => capability.id === stored.id);
  if (index === -1) capabilities.push(replacement);
  else capabilities[index] = replacement;
  return { ...config, capabilities };
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
  processServerLogSink().write(
    activityLogEvent(
      GATEWAY_TOOL_CALLING_VERIFICATION_OPERATION,
      {
        correlationId: correlationIdOrUnknown(correlationId),
        status: status === "unverified" ? 503 : 200,
        ...(status === "unverified" ? { errorKind: "unavailable" as const } : {}),
      },
      {
        verificationStatus: status,
        ...(fingerprint === undefined ? {} : { configurationFingerprint: fingerprint }),
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}

function logVoiceSetupResolution(config: GatewayConfig, correlationId: string | undefined): void {
  const models = listConfiguredCapabilities(config).filter(isVoiceCapability);
  const speechOutput = models.filter(modelSupportsSpeechOutput);
  const realtime = models.filter(modelSupportsRealtimeVoice);
  processServerLogSink().write(
    activityLogEvent(
      GATEWAY_VOICE_SETUP_OPERATION,
      { correlationId: correlationIdOrUnknown(correlationId), status: 200 },
      {
        speechInputModels: models.filter(modelSupportsSpeechInput).length,
        usableSpeechOutputModels: speechOutput.filter(
          (model) => (model.supportedVoicePersonas?.length ?? 0) > 0,
        ).length,
        incompleteSpeechOutputModels: speechOutput.filter(
          (model) => (model.supportedVoicePersonas?.length ?? 0) === 0,
        ).length,
        usableRealtimeModels: realtime.filter(isCompleteRealtimeVoiceCapability).length,
        incompleteRealtimeModels: realtime.filter(
          (model) => !isCompleteRealtimeVoiceCapability(model),
        ).length,
        completeness: "complete",
        loss: "none",
      },
    ),
  );
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
  return persistVerifiedCapabilityUpdate(
    gatewayConfig,
    deps,
    modelId,
    generation,
    updated,
    true,
    ctx.correlationId,
  );
}

function tokenCounterMetadata(
  tokenCounter: "litellm" | undefined,
): Pick<GatewayDiscoveredModelMetadata, "tokenCounter"> {
  return tokenCounter === undefined ? {} : { tokenCounter };
}
function commonTokenCounter(
  left: GatewayDiscoveredModelMetadata,
  right: GatewayDiscoveredModelMetadata,
): Pick<GatewayDiscoveredModelMetadata, "tokenCounter"> {
  return tokenCounterMetadata(
    left.tokenCounter === right.tokenCounter ? left.tokenCounter : undefined,
  );
}

function modelTokenCounterMetadata(
  options: ProviderRawOptions,
  modelId: string,
): Pick<GatewayDiscoveredModelMetadata, "tokenCounter"> {
  return tokenCounterMetadata(options.modelMetadata?.[modelId]?.tokenCounter);
}

function logDiscoveryMerge(
  merged: ClassifiedDiscoveryModel,
  correlationId: string | undefined,
): void {
  logAliasIntersection(
    {
      alias: merged.id,
      role: discoveryRoleOf(merged),
      contextWindow: merged.metadata.contextWindow ?? 0,
      undeclaredLimit: merged.undeclaredContext === true,
      deploymentCount: merged.deploymentCount ?? 1,
      state: discoveryMergeState(merged),
      maxOutputTokens: merged.metadata.maxOutputTokens ?? 0,
      undeclaredOutputLimit: (merged.metadata.maxOutputTokens ?? 0) === 0,
      reasoningOptionCount: merged.metadata.reasoningEfforts?.length ?? 0,
    },
    correlationId,
  );
}

// The rerank engines travel as `unsupported` entries with the reason "rerank" until setup admits one,
// but their role is "rerank": that is what an operator reading the log needs to see.
function discoveryRoleOf(merged: ClassifiedDiscoveryModel): DiscoveryAliasRole {
  return merged.kind === "unsupported" && merged.reason === "rerank" ? "rerank" : merged.kind;
}

function discoveryMergeState(
  merged: ClassifiedDiscoveryModel,
): "normalized" | "intersected" | "conflicting" {
  if (merged.deploymentConflict === true) return "conflicting";
  return (merged.deploymentCount ?? 1) === 1 ? "normalized" : "intersected";
}
