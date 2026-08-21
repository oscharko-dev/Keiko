import type { GroundedRerankerDiagnostics } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  requestLiteLLMRerank,
  resolveOutboundHttpEgressConfig,
  type GatewayConfig,
  type LiteLLMRerankRequest,
  type OutboundHttpEgressConfig,
  type RerankErrorKind,
  type RerankOutcome,
  type RerankResult,
  type RerankerConfig,
} from "@oscharko-dev/keiko-model-gateway";

import type { UiHandlerDeps } from "./deps.js";
import { currentGatewayConfig } from "./deps.js";
import { getServerLogger, startLogTimer } from "./observability/index.js";

export type RerankFallbackMode = "slice-topN" | "identity";

export interface RerankSelectionPolicy {
  readonly externalReranking: "allow" | "deny";
  /** Reserved for the future bundled local reranker; intentionally unenforced today. */
  readonly localReranking: "allow" | "deny";
}

export interface RerankSelectionInput<T> {
  readonly deps: UiHandlerDeps;
  readonly query: string;
  readonly candidates: readonly T[];
  /**
   * Optional provider-visible subset when a caller's fallback/diagnostic pool is wider than the
   * documents it is allowed to send. Provider indices are resolved against this subset.
   */
  readonly providerCandidates?: readonly T[] | undefined;
  readonly documentFor: (candidate: T) => string;
  readonly topN: number;
  readonly signal?: AbortSignal | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly policy?: RerankSelectionPolicy | undefined;
  readonly applyScore?: ((candidate: T, result: RerankResult) => T) | undefined;
  readonly fallbackMode: RerankFallbackMode;
  /**
   * Pins the gateway-config generation this call reports against. `currentGatewayConfig` is a live
   * accessor whose backing closure is replaced by the gateway-setup save route, so a caller that
   * already captured a config snapshot (the readiness probe, which runs its probes concurrently
   * against one selection) must pass it here. Omitted by request-scoped callers, which correctly
   * want the current generation.
   */
  // `null` pins an observed absence; `undefined` asks the facade to capture the live generation.
  readonly gatewayConfig?: GatewayConfig | null | undefined;
}

export interface RerankSelection<T> {
  readonly selected: readonly T[];
  readonly diagnostics: GroundedRerankerDiagnostics;
}

interface MaterializedRerankInput {
  readonly deps: UiHandlerDeps;
  readonly query: string;
  readonly documents: readonly string[];
  readonly topN: number;
  readonly signal?: AbortSignal | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly gatewayConfig?: GatewayConfig | undefined;
}

interface SafeRerankTransportResult {
  readonly outcome?: RerankOutcome | undefined;
  readonly thrownKind?: RerankErrorKind | undefined;
  readonly latencyMs: number;
}

export function fallbackRerankSelection<T>(
  candidates: readonly T[],
  topN: number,
  mode: RerankFallbackMode,
): readonly T[] {
  if (mode === "identity") return candidates;
  return topN <= 0 ? [] : candidates.slice(0, topN);
}

export function applyRerankMapping<T>(
  candidates: readonly T[],
  results: readonly RerankResult[],
  topN: number,
  applyScore?: (candidate: T, result: RerankResult) => T,
): readonly T[] | undefined {
  if (candidates.length === 0) return [];
  if (results.length === 0 || topN <= 0) return undefined;
  const used = new Set<number>();
  const selected: T[] = [];
  for (const result of results) {
    const candidate = mappedCandidateFor(candidates, result.index, used);
    if (candidate === undefined) return undefined;
    selected.push(applyScore?.(candidate, result) ?? candidate);
  }
  return selected.slice(0, topN);
}

function mappedCandidateFor<T>(
  candidates: readonly T[],
  index: number,
  used: Set<number>,
): T | undefined {
  if (!Number.isInteger(index) || index < 0 || index >= candidates.length || used.has(index)) {
    return undefined;
  }
  const candidate = candidates[index];
  if (candidate === undefined) return undefined;
  used.add(index);
  return candidate;
}

function policyDeniedDiagnostics(
  candidateCount: number,
  keptCount: number,
): GroundedRerankerDiagnostics {
  return {
    status: "denied",
    mode: "local-only",
    candidateCount,
    documentCount: 0,
    keptCount,
    failureKind: "policy-denied",
    latencyMs: 0,
  };
}

function disabledDiagnostics(
  candidateCount: number,
  keptCount: number,
  failureKind?: "not-configured",
): GroundedRerankerDiagnostics {
  return {
    status: "disabled",
    mode: "none",
    candidateCount,
    documentCount: 0,
    keptCount,
    ...(failureKind === undefined ? {} : { failureKind }),
    latencyMs: 0,
  };
}

function unavailableStatus(kind: RerankErrorKind): GroundedRerankerDiagnostics["status"] {
  if (kind === "disabled" || kind === "not-configured") return "disabled";
  if (kind === "invalid-response") return "invalid-response";
  return "unavailable";
}

function failedDiagnostics(
  input: MaterializedRerankInput,
  fallbackCount: number,
  kind: RerankErrorKind,
  latencyMs: number,
): GroundedRerankerDiagnostics {
  return {
    status: unavailableStatus(kind),
    mode: "provider-backed",
    candidateCount: input.documents.length,
    documentCount: input.documents.length,
    keptCount: fallbackCount,
    failureKind: kind === "disabled" ? "not-configured" : kind,
    latencyMs,
  };
}

function appliedDiagnostics(
  input: MaterializedRerankInput,
  outcome: Extract<RerankOutcome, { readonly ok: true }>,
  latencyMs: number,
): GroundedRerankerDiagnostics {
  return {
    status: "applied",
    mode: "provider-backed",
    candidateCount: input.documents.length,
    documentCount: input.documents.length,
    keptCount: Math.min(outcome.value.results.length, input.topN),
    latencyMs,
  };
}

function buildRerankRequest(
  input: MaterializedRerankInput,
  reranker: RerankerConfig,
  egress: OutboundHttpEgressConfig | undefined,
): LiteLLMRerankRequest {
  return {
    endpoint: reranker.baseUrl,
    apiKey: reranker.apiKey,
    ...(reranker.apiKeyHeaderName === undefined
      ? {}
      : { apiKeyHeaderName: reranker.apiKeyHeaderName }),
    modelId: reranker.modelId,
    query: input.query,
    documents: input.documents,
    topN: input.topN,
    timeoutMs: reranker.timeoutMs,
    ...(egress === undefined ? {} : { egress }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  };
}

function thrownRerankKind(input: MaterializedRerankInput): RerankErrorKind {
  return input.signal?.aborted === true ? "cancelled" : "transport";
}

// Egress resolution follows the pinned config generation first when the caller supplied one, so a
// pinned call cannot pick up a concurrently saved gateway config through the live accessor.
function rerankEgress(
  input: MaterializedRerankInput,
  reranker: RerankerConfig,
): OutboundHttpEgressConfig | undefined {
  return (
    reranker.egress ??
    input.gatewayConfig?.egress ??
    input.deps.egress ??
    input.deps.config?.egress ??
    resolveOutboundHttpEgressConfig(undefined, input.deps.env)
  );
}

async function requestRerankTransport(
  input: MaterializedRerankInput,
  reranker: RerankerConfig,
): Promise<SafeRerankTransportResult> {
  const startedAt = Date.now();
  const request = input.deps.rerankRequest ?? requestLiteLLMRerank;
  const egress = rerankEgress(input, reranker);
  try {
    return {
      outcome: await request(buildRerankRequest(input, reranker, egress)),
      latencyMs: Math.max(0, Date.now() - startedAt),
    };
  } catch {
    return {
      thrownKind: thrownRerankKind(input),
      latencyMs: Math.max(0, Date.now() - startedAt),
    };
  }
}

function withKeptCount(
  diagnostics: GroundedRerankerDiagnostics,
  keptCount: number,
): GroundedRerankerDiagnostics {
  return { ...diagnostics, keptCount };
}

function invalidMappingDiagnostics(
  diagnostics: GroundedRerankerDiagnostics,
  keptCount: number,
): GroundedRerankerDiagnostics {
  return {
    ...diagnostics,
    status: "invalid-response",
    failureKind: "invalid-response",
    keptCount,
  };
}

function captureGatewayConfig<T>(input: RerankSelectionInput<T>): GatewayConfig | undefined {
  const current =
    input.gatewayConfig === undefined
      ? currentGatewayConfig(input.deps)
      : (input.gatewayConfig ?? undefined);
  return current === undefined ? undefined : structuredClone(current);
}

async function configuredSelection<T>(
  input: RerankSelectionInput<T>,
  providerCandidates: readonly T[],
  fallback: readonly T[],
  reranker: RerankerConfig,
  gatewayConfig: GatewayConfig,
): Promise<RerankSelection<T>> {
  const requestInput: MaterializedRerankInput = {
    deps: input.deps,
    query: input.query,
    documents: providerCandidates.map(input.documentFor),
    topN: input.topN,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    gatewayConfig,
  };
  const transport = await requestRerankTransport(requestInput, reranker);
  if (transport.outcome?.ok !== true) {
    const kind = transport.outcome?.kind ?? transport.thrownKind ?? "transport";
    return {
      selected: fallback,
      diagnostics: failedDiagnostics(requestInput, fallback.length, kind, transport.latencyMs),
    };
  }
  const diagnostics = appliedDiagnostics(requestInput, transport.outcome, transport.latencyMs);
  const selected = applyRerankMapping(
    providerCandidates,
    transport.outcome.value.results,
    input.topN,
    input.applyScore,
  );
  return selected === undefined
    ? { selected: fallback, diagnostics: invalidMappingDiagnostics(diagnostics, fallback.length) }
    : { selected, diagnostics: withKeptCount(diagnostics, selected.length) };
}

// Every non-applied outcome below is a SILENT degradation from the caller's point of view: the
// caller still receives a usable selection, so nothing upstream can tell that the provider was
// never asked, refused, timed out, or answered with an unusable mapping. The activity row carries
// the diagnostics for one query in the UI; this line is the same decision in the operator's log.
// `denied`, `unavailable` and `invalid-response` warn — those are a policy rejection and two
// provider faults. `applied` and `disabled` stay at debug: the first is the happy path and the
// second is the steady state of a default install with no reranker configured.
function rerankLogLevel(diagnostics: GroundedRerankerDiagnostics): "debug" | "warn" {
  return diagnostics.status === "applied" || diagnostics.status === "disabled" ? "debug" : "warn";
}

function logRerankOutcome(
  diagnostics: GroundedRerankerDiagnostics,
  fallbackMode: RerankFallbackMode,
  topN: number,
  durationMs: number,
): void {
  getServerLogger().log(rerankLogLevel(diagnostics), {
    category: "search",
    op: "search.rerank.completed",
    durationMs,
    ...(diagnostics.failureKind === undefined ? {} : { errorKind: diagnostics.failureKind }),
    extra: {
      // `outcome`, not `status`: the envelope's `status` is an HTTP code, and the reranker's is a
      // word. Sharing the name would put a string where every operator query expects a number.
      outcome: diagnostics.status,
      mode: diagnostics.mode,
      candidateCount: diagnostics.candidateCount,
      documentCount: diagnostics.documentCount,
      keptCount: diagnostics.keptCount,
      transportLatencyMs: diagnostics.latencyMs,
      fallbackMode,
      topN,
    },
  });
}

export async function rerankSelection<T>(
  input: RerankSelectionInput<T>,
): Promise<RerankSelection<T>> {
  const elapsed = startLogTimer();
  const selection = await resolveRerankSelection(input);
  logRerankOutcome(selection.diagnostics, input.fallbackMode, input.topN, elapsed());
  return selection;
}

async function resolveRerankSelection<T>(
  input: RerankSelectionInput<T>,
): Promise<RerankSelection<T>> {
  const fallback = fallbackRerankSelection(input.candidates, input.topN, input.fallbackMode);
  if (input.policy?.externalReranking === "deny") {
    return {
      selected: fallback,
      diagnostics: policyDeniedDiagnostics(input.candidates.length, fallback.length),
    };
  }
  // Guard order is deliberate and load-bearing (issue #2567 D5). The two pre-facade implementations
  // this consolidates DISAGREED on the empty-pool-and-unconfigured intersection: the hybrid path
  // (`requestConfiguredRerank`) guarded the empty pool first and reported a bare "disabled", while
  // the single-scope path decided the unconfigured case upstream (`createNotConfiguredReranker`) and
  // always reported "disabled" + "not-configured" regardless of pool size. One shared facade cannot
  // reproduce both, so the configuration check runs FIRST: "the reranker was never configured" is the
  // stable, true reason, whereas an empty pool is incidental to it. This also keeps the default
  // install suppressible by `rerankerForRetrievalActivity`, which recognises the default state only
  // by the "disabled" + "not-configured" pair — a bare "disabled" would leak into the activity row.
  // Capture the live accessor exactly once. Runtime setup replaces its backing reference, so this
  // immutable request-local reference keeps reranker credentials, endpoint, and shared egress on
  // one generation even if a save lands while documents are materialized or transport is awaited.
  const gatewayConfigSnapshot = captureGatewayConfig(input);
  if (gatewayConfigSnapshot?.reranker === undefined) {
    return {
      selected: fallback,
      diagnostics: disabledDiagnostics(input.candidates.length, fallback.length, "not-configured"),
    };
  }
  const providerCandidates = input.providerCandidates ?? input.candidates;
  if (providerCandidates.length === 0 || input.topN <= 0) {
    return {
      selected: fallback,
      diagnostics: disabledDiagnostics(providerCandidates.length, fallback.length),
    };
  }
  return configuredSelection(
    input,
    providerCandidates,
    fallback,
    gatewayConfigSnapshot.reranker,
    gatewayConfigSnapshot,
  );
}
