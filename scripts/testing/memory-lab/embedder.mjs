// With or without an embedding model (#4207). Memory recall has a lexical path and a semantic one,
// and a run that does not say which it measured cannot be compared with one that did. The lab
// therefore decides it per run: `--no-embedder` removes every embedding provider from the gateway
// configuration the instances are handed, `--embedder` adds the scripted one to an offline run, and
// the manifest records the outcome (`embedder`, `embeddingModelIds`), which `compare` refuses to mix.
import { EMBEDDER_MODEL_ID } from "./scripted-model.mjs";

export const EMBEDDER_MODES = Object.freeze(["default", "on", "off"]);
/** What a run measured: no embedding model, the scripted one, or the configuration's own. */
export const EMBEDDER_KINDS = Object.freeze(["none", "scripted", "configured"]);

function isEmbeddingCapability(capability) {
  return capability?.kind === "embedding";
}

/** The model ids of the embedding providers a raw gateway configuration names, sorted. */
export function embeddingModelIds(config) {
  const declared = (config?.capabilities ?? [])
    .filter(isEmbeddingCapability)
    .map((capability) => capability.id);
  const inline = (config?.providers ?? [])
    .filter((provider) => isEmbeddingCapability(provider?.capability))
    .map((provider) => provider.modelId);
  return [...new Set([...declared, ...inline])].filter((id) => typeof id === "string").toSorted();
}

/** The configuration without any embedding provider or embedding capability record. */
export function withoutEmbedders(config) {
  const embedding = new Set(embeddingModelIds(config));
  return {
    ...config,
    providers: config.providers.filter((provider) => !embedding.has(provider?.modelId)),
    ...(Array.isArray(config.capabilities)
      ? { capabilities: config.capabilities.filter((entry) => !embedding.has(entry?.id)) }
      : {}),
  };
}

function embeddingCapability() {
  return {
    kind: "embedding",
    contextWindow: 8192,
    maxInputTokens: 8192,
    maxOutputTokens: 0,
    toolCalling: false,
    structuredOutput: false,
    streaming: false,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: false,
    costClass: "low",
    latencyClass: "fast",
    knownLimitations: [],
  };
}

/** The provider entry that points the scripted embedder id at the scripted model server. */
export function scriptedEmbedderProvider(baseUrl) {
  return {
    modelId: EMBEDDER_MODEL_ID,
    baseUrl,
    timeoutMs: 60000,
    maxRetries: 0,
    retryBaseDelayMs: 100,
    capability: embeddingCapability(),
  };
}

/**
 * The kind of embedding a run measures. Offline there is none unless asked for (`on` adds the
 * scripted one), so an existing offline baseline keeps measuring what it always did. Live, the
 * configuration's own embedding provider stays unless `off` removes it; `on` is the same as the
 * default and fails when the configuration has none, so a run cannot claim an embedding it lacks.
 */
export function resolveEmbedder({ mode, embedder, configuredIds = [] }) {
  if (mode === "offline") return embedder === "on" ? "scripted" : "none";
  if (embedder === "off") return "none";
  if (configuredIds.length > 0) return "configured";
  if (embedder === "on")
    throw new RangeError("--embedder needs an embedding provider in the gateway configuration");
  return "none";
}
