import {
  requestLiteLLMRerank,
  type LiteLLMRerankRequest,
  type OutboundHttpEgressConfig,
  type RerankErrorKind,
  type RerankOutcome,
  type RerankerConfig,
} from "@oscharko-dev/keiko-model-gateway";
import type { GroundedRerankerDiagnostics } from "@oscharko-dev/keiko-contracts/bff-wire";

import type { UiHandlerDeps } from "./deps.js";
import { currentGatewayConfig, currentGatewayEgressConfig } from "./deps.js";

export interface ConfiguredRerankAttempt {
  readonly outcome?: Extract<RerankOutcome, { readonly ok: true }> | undefined;
  readonly diagnostics: GroundedRerankerDiagnostics;
}

export interface ConfiguredRerankInput {
  readonly deps: UiHandlerDeps;
  readonly query: string;
  readonly documents: readonly string[];
  readonly topN: number;
  readonly signal?: AbortSignal | undefined;
}

function fallbackKeptCount(documents: readonly string[], topN: number): number {
  return Math.max(0, Math.min(documents.length, topN));
}

function unavailableStatus(kind: RerankErrorKind): GroundedRerankerDiagnostics["status"] {
  if (kind === "disabled" || kind === "not-configured") return "disabled";
  if (kind === "invalid-response") return "invalid-response";
  return "unavailable";
}

function disabledDiagnostics(input: ConfiguredRerankInput): GroundedRerankerDiagnostics {
  return {
    status: "disabled",
    candidateCount: input.documents.length,
    documentCount: 0,
    keptCount: fallbackKeptCount(input.documents, input.topN),
    failureKind: "not-configured",
    latencyMs: 0,
  };
}

function failedDiagnostics(
  input: ConfiguredRerankInput,
  kind: RerankErrorKind,
  latencyMs: number,
): GroundedRerankerDiagnostics {
  return {
    status: unavailableStatus(kind),
    candidateCount: input.documents.length,
    documentCount: input.documents.length,
    keptCount: fallbackKeptCount(input.documents, input.topN),
    failureKind: kind,
    latencyMs,
  };
}

function appliedDiagnostics(
  input: ConfiguredRerankInput,
  outcome: Extract<RerankOutcome, { readonly ok: true }>,
  latencyMs: number,
): GroundedRerankerDiagnostics {
  return {
    status: "applied",
    candidateCount: input.documents.length,
    documentCount: input.documents.length,
    keptCount: Math.min(outcome.value.results.length, input.topN),
    latencyMs,
  };
}

function buildRerankRequest(
  input: ConfiguredRerankInput,
  reranker: RerankerConfig,
  egress: OutboundHttpEgressConfig | undefined,
): LiteLLMRerankRequest {
  return {
    endpoint: reranker.baseUrl,
    apiKey: reranker.apiKey,
    ...(reranker.apiKeyHeaderName !== undefined
      ? { apiKeyHeaderName: reranker.apiKeyHeaderName }
      : {}),
    modelId: reranker.modelId,
    query: input.query,
    documents: input.documents,
    topN: input.topN,
    timeoutMs: reranker.timeoutMs,
    ...(egress !== undefined ? { egress } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  };
}

export async function requestConfiguredRerank(
  input: ConfiguredRerankInput,
): Promise<ConfiguredRerankAttempt> {
  if (input.documents.length === 0 || input.topN <= 0) {
    return { diagnostics: disabledDiagnostics(input) };
  }
  const reranker = currentGatewayConfig(input.deps)?.reranker;
  if (reranker === undefined) {
    return { diagnostics: disabledDiagnostics(input) };
  }
  const startedAt = Date.now();
  const request = input.deps.rerankRequest ?? requestLiteLLMRerank;
  const egress = reranker.egress ?? currentGatewayEgressConfig(input.deps);
  const outcome = await request(buildRerankRequest(input, reranker, egress));
  const latencyMs = Math.max(0, Date.now() - startedAt);
  if (!outcome.ok) {
    return { diagnostics: failedDiagnostics(input, outcome.kind, latencyMs) };
  }
  return { outcome, diagnostics: appliedDiagnostics(input, outcome, latencyMs) };
}
