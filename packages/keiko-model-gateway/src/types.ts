// Re-export shim: wire-safe gateway contract types live in @oscharko-dev/keiko-contracts
// (issue #158). Credential-bearing / port shapes (ModelProviderConfig, GatewayConfig,
// CircuitBreakerConfig, ProviderAdapter, Clock, CircuitState, CircuitBreakerStatus) STAY here
// so contracts never carries an apiKey-shaped surface (ADR-0019 direction 1 contracts-leaf).
// `verbatimModuleSyntax` is on, so type-only names use `export type`.

import type {
  CostClass,
  GatewayRequest,
  ModelCapability,
  NormalizedResponse,
  ProviderType,
  ProviderValidationState,
} from "@oscharko-dev/keiko-contracts";
import type { GroundingLimits } from "@oscharko-dev/keiko-contracts/bff-wire";

export type {
  ModelKind,
  CostClass,
  LatencyClass,
  ModelCapability,
  ChatMessage,
  ToolDefinition,
  ResponseFormat,
  GatewayRequest,
  NormalizedToolCall,
  UsageMetadata,
  NormalizedResponse,
  FinishReason,
  StreamDelta,
  StreamEvent,
} from "@oscharko-dev/keiko-contracts";
export { CONVERSATION_CAPABILITY_CONTRACT_VERSION } from "@oscharko-dev/keiko-contracts";

// ─── Provider configuration (credential-bearing — STAYS local) ────────────────

interface ProviderConfigBase {
  readonly modelId: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly retryBaseDelayMs: number;
}

export interface GatewayOpenAiCompatibleProviderConfig extends ProviderConfigBase {
  readonly providerType?: "gateway-openai-compatible" | undefined;
  readonly modelId: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly apiKeyHeaderName?: string | undefined;
  readonly egress?: OutboundHttpEgressConfig | undefined;
}

export interface CodexCliCredentialResolverConfig {
  readonly kind: "codex-cli";
  readonly command?: string | undefined;
}

export interface OpenAiCodexLocalSessionProviderConfig extends ProviderConfigBase {
  readonly providerType: "openai-codex-local-session";
  readonly credentialResolver: CodexCliCredentialResolverConfig;
  readonly validationState?: ProviderValidationState | undefined;
}

export type ModelProviderConfig =
  | GatewayOpenAiCompatibleProviderConfig
  | OpenAiCodexLocalSessionProviderConfig;

export function isGatewayOpenAiCompatibleProviderConfig(
  provider: ModelProviderConfig,
): provider is GatewayOpenAiCompatibleProviderConfig {
  return provider.providerType === undefined || provider.providerType === "gateway-openai-compatible";
}

export function isOpenAiCodexLocalSessionProviderConfig(
  provider: ModelProviderConfig,
): provider is OpenAiCodexLocalSessionProviderConfig {
  return provider.providerType === "openai-codex-local-session";
}

export interface OutboundHttpEgressConfig {
  readonly httpProxy?: string | undefined;
  readonly httpsProxy?: string | undefined;
  readonly noProxy?: readonly string[] | undefined;
  readonly caBundlePath?: string | undefined;
}

export interface CircuitBreakerConfig {
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  readonly halfOpenProbes: number;
}

export interface GatewayConfig {
  readonly providers: readonly ModelProviderConfig[];
  readonly circuitBreaker: CircuitBreakerConfig;
  readonly capabilities?: readonly ModelCapability[] | undefined;
  readonly grounding?: GroundingLimits | undefined;
  readonly egress?: OutboundHttpEgressConfig | undefined;
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
  readonly providerType?: ProviderType | undefined;
  readonly validateConfig?:
    | ((config: ModelProviderConfig) => void)
    | undefined;
  readonly discoverModels?:
    | ((config: ModelProviderConfig) => Promise<readonly string[]>)
    | undefined;
  readonly probeCapabilities?:
    | ((config: ModelProviderConfig) => Promise<readonly ModelCapability[]>)
    | undefined;
  readonly normalizeError?:
    | ((error: unknown, config: ModelProviderConfig, operation: ProviderRuntimeOperation) => Error)
    | undefined;
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

export type ProviderRuntimeOperation =
  | "validate-config"
  | "discover-models"
  | "probe-capabilities"
  | "call"
  | "call-stream";

export interface ProviderAdapterFactoryContext {
  readonly requestId: string;
  readonly costClass: CostClass;
  readonly now?: (() => number) | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

export type ProviderAdapterFactory = (
  context: ProviderAdapterFactoryContext,
) => ProviderAdapter;

export interface ProviderRegistry {
  readonly resolve: (
    config: ModelProviderConfig,
    context: ProviderAdapterFactoryContext,
  ) => ProviderAdapter;
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
