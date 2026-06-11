// Memory embeddings — the model/IO boundary for semantic memory (#204).
//
// Mirrors the proven Local Knowledge embedding pipeline (selectEmbeddingModelId +
// createEmbeddingAdapter + requestOpenAIEmbedding) but for governed memory records. Two public
// surfaces:
//   embedMemoryText(deps, text)        — embed an arbitrary string, returning a vault-ready
//                                        MemoryEmbeddingInput or null. NEVER throws.
//   embedAndStoreMemory(deps, vault,…) — best-effort embed-on-capture: store the embedding if it
//                                        and the vault accept it; swallow every failure so the
//                                        capture path is never broken.
//   cosineSimilarity(a, b)             — pure cosine in [0,1] over two Float32Array vectors.
//
// Graceful degradation is the contract: when no embedding-capable model is configured, every
// function is inert (embedMemoryText -> null, embedAndStoreMemory -> no-op) and the caller keeps
// its pre-semantic behaviour byte-for-byte.

import {
  isGatewayOpenAiCompatibleProviderConfig,
  requestOpenAIEmbedding,
  type GatewayConfig,
  type ModelProviderConfig,
  type OpenAIEmbeddingAdapter,
  type OpenAIEmbeddingOutcome,
  type OpenAIEmbeddingRequest,
} from "@oscharko-dev/keiko-model-gateway";
import type { MemoryId } from "@oscharko-dev/keiko-contracts/memory";
import type { MemoryEmbeddingInput, MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import { currentGatewayConfig, type UiHandlerDeps } from "./deps.js";
import { selectEmbeddingModelId } from "./local-knowledge-handlers.js";

const MEMORY_VECTOR_METRIC = "cosine" as const;
export function selectMemoryEmbeddingModelId(
  config: GatewayConfig | undefined,
): string | undefined {
  return selectEmbeddingModelId(config);
}

function providerForModel(
  config: GatewayConfig | undefined,
  modelId: string,
): ModelProviderConfig | undefined {
  return config?.providers.find((provider) => provider.modelId === modelId);
}

function requestEmbeddingImpl(
  deps: UiHandlerDeps,
): (request: OpenAIEmbeddingRequest) => Promise<OpenAIEmbeddingOutcome> {
  // Reuses the same gateway seam as Local Knowledge so a single injected adapter drives both.
  return deps.localKnowledgeEmbeddingRequest ?? requestOpenAIEmbedding;
}

function buildAdapter(
  provider: ModelProviderConfig,
  requestImpl: (request: OpenAIEmbeddingRequest) => Promise<OpenAIEmbeddingOutcome>,
): OpenAIEmbeddingAdapter {
  if (!isGatewayOpenAiCompatibleProviderConfig(provider)) {
    throw new Error(
      `memory embedding requires a gateway-openai-compatible provider for '${provider.modelId}'`,
    );
  }
  return {
    endpoint: provider.baseUrl,
    apiKey: provider.apiKey,
    ...(provider.apiKeyHeaderName !== undefined
      ? { apiKeyHeaderName: provider.apiKeyHeaderName }
      : {}),
    ...(provider.egress !== undefined ? { egress: provider.egress } : {}),
    request: (request) =>
      requestImpl({
        ...request,
        endpoint: provider.baseUrl,
        apiKey: provider.apiKey,
        ...(provider.apiKeyHeaderName !== undefined
          ? { apiKeyHeaderName: provider.apiKeyHeaderName }
          : {}),
        ...(provider.egress !== undefined ? { egress: provider.egress } : {}),
      }),
  };
}

function toEmbeddingInput(
  provider: string,
  outcome: Extract<OpenAIEmbeddingOutcome, { ok: true }>,
): MemoryEmbeddingInput {
  return {
    provider,
    modelId: outcome.value.modelId,
    ...(outcome.value.modelRevision !== undefined
      ? { modelRevision: outcome.value.modelRevision }
      : {}),
    metric: MEMORY_VECTOR_METRIC,
    vector: outcome.value.vector,
  };
}

// A bound embedder: embeds an arbitrary string against a fixed model/provider, returning a
// vault-ready input or null on any failure. Never throws.
export type MemoryEmbedder = (text: string) => Promise<MemoryEmbeddingInput | null>;

// Builds an embedder from a gateway config, or returns null when no embedding-capable model is
// configured (or its provider is absent). The CLI backfill and the conversation paths both compose
// through this single factory so capability-aware model selection lives in one place.
export function createMemoryEmbedder(
  config: GatewayConfig | undefined,
  requestImpl: (request: OpenAIEmbeddingRequest) => Promise<OpenAIEmbeddingOutcome>,
): MemoryEmbedder | null {
  const modelId = selectMemoryEmbeddingModelId(config);
  if (modelId === undefined) return null;
  const provider = providerForModel(config, modelId);
  if (provider === undefined) return null;
  if (!isGatewayOpenAiCompatibleProviderConfig(provider)) return null;
  const adapter = buildAdapter(provider, requestImpl);
  return async (text: string): Promise<MemoryEmbeddingInput | null> => {
    if (text.length === 0) return null;
    try {
      const outcome = await adapter.request({
        endpoint: provider.baseUrl,
        apiKey: provider.apiKey,
        modelId,
        input: text,
        ...(provider.egress !== undefined ? { egress: provider.egress } : {}),
      });
      if (!outcome.ok) return null;
      return toEmbeddingInput("openai", outcome);
    } catch {
      // Model/transport boundary: a thrown adapter must degrade to "no embedding", never crash.
      return null;
    }
  };
}

// Embeds `text` against the configured embedding model. Returns null when no embedding-capable
// model is configured, when the matching provider is absent, or on any request failure. The whole
// IO body is guarded so this NEVER throws into the capture/retrieval path.
export async function embedMemoryText(
  deps: UiHandlerDeps,
  text: string,
): Promise<MemoryEmbeddingInput | null> {
  const embedder = createMemoryEmbedder(currentGatewayConfig(deps), requestEmbeddingImpl(deps));
  if (embedder === null) return null;
  return embedder(text);
}

// Best-effort embed-on-capture. Embeds the memory body and upserts the vector. A null embedding
// (no model / failure) is a no-op; a vault rejection (e.g. gateEmbeddingInput dimension/contract
// guard) is swallowed so a malformed vector can never break the capture that already succeeded.
export async function embedAndStoreMemory(
  deps: UiHandlerDeps,
  vault: MemoryVaultStore,
  memoryId: MemoryId,
  text: string,
): Promise<void> {
  const input = await embedMemoryText(deps, text);
  if (input === null) return;
  try {
    vault.upsertEmbedding(memoryId, input);
  } catch {
    // gateEmbeddingInput / storage rejection — capture already succeeded; drop the embedding.
  }
}

// Pure cosine similarity in [0,1]. Returns 0 when the vectors differ in length or either has zero
// magnitude, and clamps a negative cosine to 0 so the ranker only ever sees a non-negative signal
// (mirrors Local Knowledge's cosine metric semantics).
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  const cosine = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  if (cosine <= 0) return 0;
  return cosine > 1 ? 1 : cosine;
}
