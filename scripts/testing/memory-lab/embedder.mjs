// With or without an embedding model (#4207). Memory recall has a lexical path and a semantic one,
// and a run that does not say which it measured cannot be compared with one that did. The lab
// therefore decides it per run: `--no-embedder` removes every embedding provider from the gateway
// configuration the instances are handed, `--embedder` adds the scripted one to an offline run, and
// the manifest records the outcome (`embedder`, `embeddingModelIds`), which `compare` refuses to mix.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "../coding-workbench-lab/lab-common.mjs";
import { EMBEDDER_MODEL_ID } from "./scripted-model.mjs";

export const EMBEDDER_MODES = Object.freeze(["default", "on", "off"]);
// What a run measured is one of three closed kinds: "none" (no embedding model), "scripted" (the
// lab's own) or "configured" (the configuration's own); `resolveEmbedder` is the one place that
// decides it.

// What the product calls an embedding provider is not what a configuration declares: it also falls
// back to its catalogue and to the shape of the model id (`findConfiguredCapability`), so a provider
// entry with only `modelId` and `baseUrl` can be an embedder for it and invisible to a reader of the
// raw file. The lab therefore never decides this itself: it asks the built model-gateway package of
// the SUBJECT it measures, with the function the product uses (`parseGatewayConfig`, which merges the
// inline and the top-level capability records, then `listConfiguredCapabilities`).
export async function loadSubjectGateway(subjectRoot) {
  const file = join(
    subjectRoot ?? REPO_ROOT,
    "packages",
    "keiko-model-gateway",
    "dist",
    "index.js",
  );
  try {
    return await import(pathToFileURL(file).href);
  } catch (error) {
    throw new Error(
      "cannot load the subject's built model-gateway package; build the subject first",
      { cause: error },
    );
  }
}

// A key is needed to parse a provider, never to find out what it is: every credential name reads as a
// placeholder, every other name as unset, so the product's resolver sees the configuration only.
const PARSE_ENV = new Proxy(
  {},
  {
    get: (_target, name) =>
      typeof name === "string" && name.endsWith("_API_KEY") ? "lab" : undefined,
  },
);

/**
 * The model ids of the embedding providers a raw gateway configuration holds, sorted, as the
 * SUBJECT's own resolver finds them (`gateway` from `loadSubjectGateway`). A configuration the
 * product would not accept throws: a run never measures one it cannot classify.
 */
export function embeddingModelIds(config, gateway) {
  const parsed = gateway.parseGatewayConfig(config, PARSE_ENV);
  return gateway
    .listConfiguredCapabilities(parsed)
    .filter((capability) => capability.kind === "embedding")
    .map((capability) => capability.id)
    .toSorted();
}

/**
 * The configuration without any embedding provider or embedding capability record, verified: the
 * product's resolver must find no embedding provider in what is returned, or this throws and the unit
 * fails closed instead of measuring semantic recall under a `none` label.
 */
export function withoutEmbedders(config, gateway) {
  const embedding = new Set(embeddingModelIds(config, gateway));
  const stripped = {
    ...config,
    providers: config.providers.filter((provider) => !embedding.has(provider?.modelId)),
    ...(Array.isArray(config.capabilities)
      ? { capabilities: config.capabilities.filter((entry) => !embedding.has(entry?.id)) }
      : {}),
  };
  assertNoEmbedder(stripped, gateway);
  return stripped;
}

/** Throws unless the subject's resolver finds no embedding provider in the configuration. */
function assertNoEmbedder(config, gateway) {
  const remaining = embeddingModelIds(config, gateway);
  if (remaining.length > 0)
    throw new Error(
      `the product still resolves ${String(remaining.length)} embedding provider(s) from the configuration after they were removed`,
    );
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
