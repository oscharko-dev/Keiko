// Re-export shim: wire-safe gateway contract types live in @oscharko-dev/keiko-contracts
// (issue #158). Credential-bearing / port shapes (ModelProviderConfig, GatewayConfig,
// CircuitBreakerConfig, ProviderAdapter, Clock, CircuitState, CircuitBreakerStatus) STAY here
// so contracts never carries an apiKey-shaped surface (ADR-0019 direction 1 contracts-leaf).
// `verbatimModuleSyntax` is on, so type-only names use `export type`.

import type {
  ModelCapability,
  NormalizedResponse,
  GatewayRequest,
  ProviderEndpointStyle,
  RealtimeAuthMode,
  VoicePersona,
} from "@oscharko-dev/keiko-contracts";
import type { GroundingLimits } from "@oscharko-dev/keiko-contracts/bff-wire";

export type {
  ModelKind,
  CostClass,
  LatencyClass,
  ModelTokenAccountingSource,
  ModelTokenAccounting,
  ModelReasoningEffort,
  InfillingAlignment,
  ModelCapability,
  CompletionInteractionMode,
  CompletionDegradeReason,
  CompletionModelSelection,
  ChatMessage,
  ChatMessageContentPart,
  ChatMessageImageUrlContentPart,
  ChatMessageTextContentPart,
  ToolDefinition,
  ResponseFormat,
  GatewayRequest,
  GatewaySamplingParameterIssue,
  GatewaySamplingParameterName,
  GatewaySamplingParameters,
  NormalizedToolCall,
  UsageMetadata,
  NormalizedResponse,
  FinishReason,
  StreamDelta,
  StreamEvent,
  VoiceProviderLocality,
  VoicePersona,
  VoiceProfile,
  VoiceUnavailableReason,
  VoiceTransportPosture,
  VoiceCapabilityResolution,
  VoiceProviderAvailability,
} from "@oscharko-dev/keiko-contracts";
export {
  CONVERSATION_CAPABILITY_CONTRACT_VERSION,
  MODEL_REASONING_EFFORTS,
  isCodingWorkbenchModel,
  GATEWAY_TEMPERATURE_RANGE,
  GATEWAY_TOP_P_RANGE,
  VOICE_PROVIDER_LOCALITIES,
  VOICE_PERSONAS,
  assertValidGatewaySamplingParameters,
  isValidGatewaySamplingParameters,
  isValidGatewayTemperature,
  isValidGatewayTopP,
  isConfiguredVoiceProvider,
  describeVoiceProviderAvailability,
  listVoicePersonas,
  validateGatewaySamplingParameters,
} from "@oscharko-dev/keiko-contracts/runtime/gateway";

// ─── Provider configuration (credential-bearing — STAYS local) ────────────────

// The sensitive persona → provider-voice-id mapping (Issue #1557, ADR-0094 D2). `voiceId` is a
// provider-sensitive string (ADR-0100 D6 treats provider voice identifiers as sensitive metadata),
// so it sits beside `apiKey` on the credential tier and NEVER crosses to contracts. The browser only
// ever learns which personas exist (the content-free `ModelCapability.supportedVoicePersonas` enum
// derived from this mapping at parse time), never the voice id behind a persona.
export interface VoicePersonaVoice {
  readonly persona: VoicePersona;
  readonly voiceId: string;
}

// The endpoint-protocol unions moved to the contract seam so the UI upload parser and the server
// setup route validate against the same wire values without importing this package (#3037
// follow-up; ADR-0019 keeps keiko-ui off the gateway package). Re-exported here so every
// existing consumer keeps its import path.
export type { ProviderEndpointStyle, RealtimeAuthMode };
export type OutputTokenParameter = "max_tokens" | "max_completion_tokens";

export interface ModelProviderConfig {
  readonly modelId: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly apiKeyHeaderName?: string | undefined;
  readonly endpointStyle?: ProviderEndpointStyle | undefined;
  readonly apiVersion?: string | undefined;
  readonly realtimeAuthMode?: RealtimeAuthMode | undefined;
  readonly outputTokenParameter?: OutputTokenParameter | undefined;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly retryBaseDelayMs: number;
  readonly egress?: OutboundHttpEgressConfig | undefined;
  // Persona → provider voice-id mapping for this voice provider (Issue #1557, ADR-0094 D2). Present
  // only on voice providers that advertise speech output or realtime voice. Credential-tier: dropped
  // by omission from `toSafeObject`'s allowlist and never serialised to the browser.
  readonly voiceProfiles?: readonly VoicePersonaVoice[] | undefined;
  // Per-provider circuitBreaker override (audit KEIKO-0167). Optional and present-only: when
  // undefined the gateway constructs the provider's CircuitBreaker with the top-level
  // GatewayConfig.circuitBreaker policy, so every existing config keeps parsing and behaving
  // unchanged. Operators can single out a flaky provider (e.g. a LiteLLM proxy) with a more
  // forgiving threshold/cooldown, or tighten a latency-sensitive provider, without changing the
  // shared default for the rest.
  readonly circuitBreaker?: CircuitBreakerConfig | undefined;
}

export interface RerankerConfig {
  readonly modelId: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly apiKeyHeaderName?: string | undefined;
  readonly timeoutMs: number;
  readonly egress?: OutboundHttpEgressConfig | undefined;
}

export interface OutboundHttpEgressConfig {
  readonly httpProxy?: string | undefined;
  readonly httpsProxy?: string | undefined;
  readonly noProxy?: readonly string[] | undefined;
  readonly caBundlePath?: string | undefined;
  readonly allowPrivateNetwork?: boolean | undefined;
  // Narrow, non-config-file, non-env-mapped opt-in set ONLY by the model-gateway setup route
  // after its own dedicated KEIKO_ALLOW_LINK_LOCAL_GATEWAY-gated check has already approved the
  // exact submitted baseUrl (AUDIT-SEC-002 follow-up). Unlike `allowPrivateNetwork`, this may
  // re-permit the "metadata"/"link-local" target classes -- never "multicast", and never via a
  // generic env var, so it cannot silently widen the crawler/manual-fetcher SSRF surface.
  readonly allowLinkLocalAndMetadata?: boolean | undefined;
  // Set ONLY by the #2387 research-egress config. "loopback" is permitted by default because
  // gatewayFetch also serves loopback sidecar traffic; research egress opts into the stricter
  // posture where a loopback target is blocked, so a public research fetch can never be steered
  // at a local service. It only tightens (never widens) the SSRF surface.
  readonly denyLoopback?: boolean | undefined;
  // Opt-in, off by default (ADR-0038 D6). When a forward proxy is configured for this request,
  // gatewayFetch normally cannot apply its DNS-based address policy (enforceOutboundTargetPolicy's
  // dnsLookup step): the proxy resolves the target hostname independently at its own connect time,
  // so a pre-proxy lookup cannot be trusted as rebinding protection (see
  // refuseUnpinnableResearchEgress's doc comment in http.ts) and is skipped rather than pretending
  // to guard something it cannot. Setting this flag makes gatewayFetch resolve and vet the target's
  // DNS itself, the same way it already does for the unproxied path (AUDIT-SEC-001), and then pin
  // the proxy's own CONNECT tunnel (or, for a plain-HTTP target, the forwarded absolute-URI) to
  // that exact vetted address — closing the gap instead of masking it. Like `denyLoopback`, this
  // only tightens the SSRF surface and is never config-file/env-mapped; a caller must construct it
  // explicitly, because a proxy that filters CONNECT/forwarded requests by hostname (a legitimate,
  // common corporate-proxy pattern) would see an IP-literal target instead and could reject it —
  // an operator must confirm their proxy tolerates that before opting in.
  readonly pinProxiedConnectTarget?: boolean | undefined;
}

export interface CircuitBreakerConfig {
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  readonly halfOpenProbes: number;
}

export interface FigmaConnectorConfig {
  readonly accessToken?: string | undefined;
}

export interface GatewayConfig {
  readonly providers: readonly ModelProviderConfig[];
  readonly circuitBreaker: CircuitBreakerConfig;
  readonly capabilities?: readonly ModelCapability[] | undefined;
  readonly grounding?: Partial<GroundingLimits> | undefined;
  readonly reranker?: RerankerConfig | undefined;
  readonly egress?: OutboundHttpEgressConfig | undefined;
  readonly figma?: FigmaConnectorConfig | undefined;
}

// ─── Provider adapter interface (runtime port — STAYS local) ──────────────────

// A single chunk emitted by the streaming chat path. Content deltas arrive as
// `delta` chunks (one per provider token group); a terminal `done` chunk carries the
// fully assembled, redacted NormalizedResponse. Tool-call streaming is out of scope
// for Layer 1 — only content deltas are surfaced.
export type GatewayStreamChunk =
  | { readonly type: "delta"; readonly token: string }
  | { readonly type: "done"; readonly response: NormalizedResponse };

export interface ProviderAdapter {
  readonly call: (
    request: GatewayRequest,
    config: ModelProviderConfig,
  ) => Promise<NormalizedResponse>;
  // Optional streaming variant. Absent on adapters that only support buffered calls;
  // the Gateway synthesises a single delta+done from `call` in that case.
  readonly callStream?: (
    request: GatewayRequest,
    config: ModelProviderConfig,
  ) => AsyncIterable<GatewayStreamChunk>;
}

// ─── Clock interface (injectable for deterministic tests — STAYS local) ───────

export interface Clock {
  readonly now: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

// ─── Circuit-breaker observable state (STAYS local) ──────────────────────────

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerStatus {
  readonly modelId: string;
  readonly state: CircuitState;
  readonly consecutiveFailures: number;
  readonly openedAt: number | null;
}
