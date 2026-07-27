// Clean-checkout demo runner for Issue #2634 (Epic #2556's Definition of Done). It drives the
// The acceptance CLI drives the REAL production retrieval/grounding path with configured
// providers. An explicitly labelled `hermetic-test` mode exists only for regression tests and is
// never acceptance-eligible:
//
//   1. A fresh encrypted in-memory knowledge store.
//   2. A repository pod seeded via `refreshRepositoryPod` over a small, real subset of this repo.
//   3. Grounded answers through the production conversation runner, verifying:
//        - the pipeline reports the verified shared USearch provider as available and exposes its
//          honest small-corpus exact crossover instead of pretending that HNSW ran;
//        - a provider-generated answer attaches citations across ≥ 2 files with line ranges;
//        - a deliberately evidence-free question abstains rather than fabricates;
//        - the provider-backed reranker and production answer generator run through their real
//          configured transports in acceptance mode.
//   4. Content-free evidence: counts, timings, statuses, and hashes; no excerpts, no answers, no
//      repository content — validated before it leaves the runner.
//
// The runner is invoked directly from `scripts/knowledge-m2-clean-checkout-demo.mjs` (the CLI
// wrapper). The heavy lifting is here so unit tests can drive the same journey without an extra
// process boundary.

import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ModelGatewayAnswerGenerator,
  createDefaultParserRegistry,
  createRepositoryPodShell,
  listRepositoryChunkLineRanges,
  openKnowledgeStore,
  readRepositoryFileFingerprints,
  refreshRepositoryPod,
  resolveVectorIndexOptions,
  runGroundedAnswer,
} from "@oscharko-dev/keiko-local-knowledge";
import {
  EMBEDDING_INSTRUCTION_VERSION,
  Gateway,
  findConfiguredCapability,
  requestOpenAIEmbedding,
  requestOpenAIEmbeddingBatch,
  verifyEmbeddingCapability,
} from "@oscharko-dev/keiko-model-gateway";
import { buildRedactor, rerankSelection } from "@oscharko-dev/keiko-server";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";

const REPO_ROOT_DEFAULT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EMBEDDING_MODEL_ID = "keiko-clean-checkout-embedding";
const RERANK_MODEL_ID = "keiko-clean-checkout-rerank";
const ANSWER_MODEL_ID = "keiko-clean-checkout-answer";
const DEMO_CAPSULE_ID = "clean-checkout-demo-capsule";
const DEMO_SOURCE_ID = "clean-checkout-demo-source";
const DEMO_TOP_K = 5;
const DEMO_TOP_N = 3;
// Strict retrieval floor for the deliberately evidence-free question. The unrelated query should
// fall beneath it for both the hermetic vector model and a suitable acceptance provider. If it
// does not, the AC turns red rather than silently papering over a generated response.
const DEMO_ABSTENTION_MIN_SCORE = 0.995;
const ANN_STATUS_AVAILABLE = "available";
const ANN_PROVIDER_USEARCH = "usearch";
const ANN_FORBIDDEN_STATUSES = Object.freeze([
  "disabled",
  "fallback-unavailable",
  "fallback-encrypted-store",
  "fallback-unsupported-metric",
  "fallback-incompatible-identity",
  "fallback-index-too-large",
  "fallback-query-error",
]);
export const CLEAN_CHECKOUT_EXECUTION_MODES = Object.freeze({
  acceptance: "acceptance",
  hermeticTest: "hermetic-test",
});
const EVIDENCE_SCHEMA_VERSION = "3";
const EVIDENCE_DEMO_ID = "knowledge-m2-clean-checkout";
const EVIDENCE_ISSUE_REF = "#2634";

// A small, real slice of this repository — chosen because these three files SHARE the
// vocabulary a multi-file grounded question needs (USearch loading, the shared vector port, and
// scoped retrieval), so a query about the provider resolves to chunks in ≥ 2 of them.
//
// The repository pod's `walkSource` recurses the whole `repositoryRoot`, so the pod's root is
// scoped to this directory — indexing the entire workspace would drag `node_modules` in. The
// tracked filenames stay relative to that root. The full paths are surfaced in the evidence for
// reader familiarity; they are display-only and never fed back into the retrieval APIs.
const DEMO_REPOSITORY_SUBDIR = "packages/keiko-local-knowledge/src/retrieval";
const DEMO_TRACKED_FILENAMES = Object.freeze([
  "vector-index.ts",
  "local-vector-index-port.ts",
  "scoped-vector-search.ts",
]);
export const DEMO_INDEXED_PATHS = Object.freeze(
  DEMO_TRACKED_FILENAMES.map((name) => `${DEMO_REPOSITORY_SUBDIR}/${name}`),
);

// Both queries live here so the CLI, the regression test, and the runbook all use the same text.
export const MULTI_FILE_QUERY =
  "Which files implement the USearch vector index provider, its port integration, and scoped retrieval? Cite at least two distinct files.";
export const ABSTENTION_QUERY = "What is the recipe for a properly extracted moka-pot espresso?";

export const ACCEPTANCE_CRITERIA = Object.freeze([
  {
    id: "clean-checkout",
    label: "Runs from a fresh clone with no build artifacts, no .keiko state, no pre-seeded store",
  },
  {
    id: "vector-index-active",
    label:
      "The verified USearch provider is available and reports the honest small-corpus exact crossover",
  },
  {
    id: "multi-file-citations",
    label: "The grounded question spans >1 file and citations resolve to file and line",
  },
  {
    id: "abstention",
    label: "A deliberately evidence-free question abstains, not fabricates",
  },
  {
    id: "reranker-toggle",
    label:
      "The reranker facade is exercised enabled and disabled; the answer path differs where policy says it should",
  },
  {
    id: "content-free-evidence",
    label: "Recorded evidence is content-free (counts, timings, statuses, hashes)",
  },
]);

function sha256Hex(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    const pairs = entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
    return `{${pairs.join(",")}}`;
  }
  return JSON.stringify(value);
}

function requireConfiguredProvider(gatewayConfig, modelId, expectedKind) {
  const capability = findConfiguredCapability(gatewayConfig, modelId);
  if (capability?.kind !== expectedKind) {
    throw new Error(
      `clean-checkout demo: model '${modelId}' must have kind '${expectedKind}' in the configured gateway`,
    );
  }
  const provider = gatewayConfig.providers.find((entry) => entry.modelId === modelId);
  if (provider === undefined) {
    throw new Error(`clean-checkout demo: provider '${modelId}' is not configured`);
  }
  return provider;
}

// Uses the same OpenAI-compatible scalar and batch transports as production indexing. Acceptance
// mode supplies a parsed operator configuration; hermetic tests supply an explicitly labelled
// loopback configuration and never become acceptance-eligible evidence.
function buildDemoEmbeddingAdapter({ gatewayConfig, modelId, dimensions }) {
  const provider = requireConfiguredProvider(gatewayConfig, modelId, "embedding");
  return {
    modelId,
    endpoint: provider.baseUrl,
    apiKey: provider.apiKey,
    ...(provider.apiKeyHeaderName === undefined
      ? {}
      : { apiKeyHeaderName: provider.apiKeyHeaderName }),
    ...((provider.egress ?? gatewayConfig.egress) === undefined
      ? {}
      : { egress: provider.egress ?? gatewayConfig.egress }),
    request: (input) => requestOpenAIEmbedding(input),
    requestBatch: (input) => requestOpenAIEmbeddingBatch(input),
    dimensions,
  };
}

function embeddingProbeInput(dimensions, modelId) {
  return {
    modelId,
    provider: "openai",
    vectorMetric: "cosine",
    expectedDimensions: dimensions,
    normalization: "l2",
    instructionVersion: EMBEDDING_INSTRUCTION_VERSION,
    includeSpaceFingerprint: true,
  };
}

// Resolve only a provisioned USearch binary. The acceptance CLI verifies its pinned digest before
// calling the runner; the native provider repeats verification whenever HNSW loads it.
export function resolveProvisionedUsearchPath({
  repoRoot = REPO_ROOT_DEFAULT,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const configured = env.KEIKO_USEARCH_BINARY_PATH;
  if (typeof configured === "string" && configured.length > 0 && existsSync(configured)) {
    return configured;
  }
  const target = `${platform}-${arch}`;
  const candidate = join(repoRoot, ".usearch", "2.26.0", target, "usearch.node");
  return existsSync(candidate) ? candidate : undefined;
}

function resolveDemoVectorIndex(usearchBinaryPath) {
  return resolveVectorIndexOptions(undefined, {
    KEIKO_LOCAL_KNOWLEDGE_VECTOR_INDEX: "usearch",
    ...(usearchBinaryPath === undefined ? {} : { KEIKO_USEARCH_BINARY_PATH: usearchBinaryPath }),
  });
}

// Encryption is on (ADR-0153 D1): the SQLite store is in memory and decrypted vectors are handed
// only to the bounded in-process USearch engine. This runner exposes no index serialization path.
// Key material is generated per invocation rather than hard-coded, and two runs use distinct keys.
function openDemoStore(vectorIndex, encryptionKey) {
  return openKnowledgeStore({
    dbPath: ":memory:",
    vectorIndex,
    protection: {
      mode: "encrypted-key-provider",
      keyProvider: {
        providerId: "clean-checkout-demo",
        resolveKey: () => encryptionKey,
      },
    },
  });
}

function buildHermeticGatewayConfig(mockOrigin, secrets) {
  return {
    providers: [
      {
        modelId: EMBEDDING_MODEL_ID,
        baseUrl: `${mockOrigin}/v1`,
        apiKey: secrets.embeddingApiKey,
        apiKeyHeaderName: "authorization",
        timeoutMs: 30_000,
        maxRetries: 0,
        retryBaseDelayMs: 1,
      },
    ],
    capabilities: [
      {
        id: EMBEDDING_MODEL_ID,
        kind: "embedding",
        contextWindow: 8_191,
        maxOutputTokens: 0,
        toolCalling: false,
        structuredOutput: false,
        streaming: false,
        supportsImageInput: false,
        supportsDocumentInput: false,
        workflowEligible: false,
        costClass: "low",
        latencyClass: "fast",
        throughputHint: "Loopback deterministic embedding for clean-checkout demo.",
        preferredUseCases: ["clean-checkout-demo"],
        knownLimitations: ["deterministic, not a real embedding model"],
      },
    ],
    reranker: {
      modelId: RERANK_MODEL_ID,
      baseUrl: `${mockOrigin}/v1`,
      apiKey: secrets.rerankerApiKey,
      timeoutMs: 30_000,
    },
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
  };
}

// Per-run credentials so nothing in this file matches a secret-scanner rule for a hard-coded
// token, and so two consecutive runs never share a "key". The mock server accepts any bearer, so
// the values are safe to be ephemeral.
function generateDemoSecrets() {
  return {
    storeEncryptionKey: randomBytes(32),
    embeddingApiKey: randomBytes(24).toString("hex"),
    rerankerApiKey: randomBytes(24).toString("hex"),
  };
}

// A minimal `UiHandlerDeps`-shaped record — enough for `rerankSelection`. The facade only reads
// `deps.env`, `deps.config`, `deps.redactor`, and the optional `deps.rerankRequest`, which we leave
// as the default so the transport runs against the configured rerank endpoint.
//
// The redactor is the standard `buildRedactor(env, config)` used across the server so this demo
// exercises the same audit-redaction path as production, not a permissive string-cast. Nothing
// Only citation-safe display names enter the rerank documents, but a future refactor that routed
// sensitive text through this path would still find the standard redactor rather than a permissive
// pass-through.
function buildMinimalRerankDeps(gatewayConfig, env) {
  // Only the four fields `rerankSelection` actually reads: config, configPresent, env, egress,
  // redactor. `rerankRequest` deliberately left off so the facade uses the default
  // `requestLiteLLMRerank` transport (the production path we want the demo to exercise). No
  // defensive stubs for fields the facade never touches — they were dead-code by construction.
  return {
    config: gatewayConfig,
    configPresent: true,
    env,
    egress: undefined,
    redactor: buildRedactor(env, gatewayConfig),
  };
}

async function indexDemoRepositoryPod({ store, embeddingAdapter, repoRoot, signal }) {
  const identity = await verifyEmbeddingCapability(
    embeddingAdapter,
    embeddingProbeInput(embeddingAdapter.dimensions, embeddingAdapter.modelId),
  );
  if (!identity.ok) {
    throw new Error(`clean-checkout demo: embedding verification failed: ${identity.reason}`);
  }
  const podRepositoryRoot = resolve(repoRoot, DEMO_REPOSITORY_SUBDIR);
  createRepositoryPodShell(
    { store, capsuleId: DEMO_CAPSULE_ID, sourceId: DEMO_SOURCE_ID },
    {
      displayName: "Knowledge M2 clean-checkout demo",
      repositoryRoot: podRepositoryRoot,
      // Pin the scope to the exact three files the demo intends. Without this the walk picks up
      // every file under the retrieval directory (23 today, including `_support.ts`, `index.ts`
      // and every `.test.ts`), which the AC would still satisfy, but the reader loses the "small
      // real slice" the runbook advertises and re-runs re-embed 20× more content than needed.
      includeGlobs: [...DEMO_TRACKED_FILENAMES],
      embeddingModelIdentity: identity.identity,
    },
  );
  const refresh = await refreshRepositoryPod(
    {
      store,
      capsuleId: DEMO_CAPSULE_ID,
      sourceId: DEMO_SOURCE_ID,
      parserRegistry: createDefaultParserRegistry(),
      embeddingAdapter,
      workspaceFs: nodeWorkspaceFs,
      trackedPaths: new Set(DEMO_TRACKED_FILENAMES),
      ...(signal === undefined ? {} : { signal }),
    },
    { runId: "clean-checkout-demo-index" },
  );
  const fingerprints = readRepositoryFileFingerprints(store, DEMO_CAPSULE_ID, DEMO_SOURCE_ID);
  const chunkLineRanges = listRepositoryChunkLineRanges(store, DEMO_CAPSULE_ID);
  return {
    fingerprintCount: fingerprints.size,
    chunkLineRanges,
    indexedPathCount: new Set(chunkLineRanges.map((entry) => entry.relativePath)).size,
    refreshOutcome: refresh.run.outcome,
  };
}

// The retrieval APIs return chunk paths relative to the pod's `repositoryRoot`. The evidence and
// the runbook prefer full workspace-relative display names so a reader can jump from an evidence
// row to the source file without knowing the pod's subdir. This is a display transform only.
function toWorkspaceRelativePath(relativePath) {
  return `${DEMO_REPOSITORY_SUBDIR}/${relativePath}`;
}

function lineRangesForAttachedCitations(citations, chunkLineRanges) {
  const byChunkId = new Map(chunkLineRanges.map((entry) => [entry.chunkId, entry]));
  return citations
    .map((entry) => byChunkId.get(entry.reference.citation.chunkId))
    .filter((entry) => entry !== undefined);
}

function instrumentAnswerGenerator(answerGenerator) {
  let calls = 0;
  return {
    generator: {
      generate: async (input) => {
        calls += 1;
        return answerGenerator.generate(input);
      },
    },
    calls: () => calls,
  };
}

function buildReferenceReranker({ gatewayConfig, env, policy }) {
  return {
    rerank: async (input) => {
      const outcome = await rerankSelection({
        deps: buildMinimalRerankDeps(gatewayConfig, env),
        query: input.query.text,
        candidates: input.references,
        documentFor: (reference) => reference.citation.safeDisplayName,
        topN: Math.min(DEMO_TOP_N, input.references.length),
        fallbackMode: "slice-topN",
        policy,
        gatewayConfig,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      return { references: outcome.selected, diagnostics: outcome.diagnostics };
    },
  };
}

async function runDemoGroundedAnswer({
  store,
  embeddingAdapter,
  vectorIndex,
  answerGenerator,
  referenceReranker,
  query,
  minScore,
}) {
  return runGroundedAnswer(
    {
      retrieval: { store, embeddingAdapter, vectorIndex },
      answerGenerator,
      ...(referenceReranker === undefined ? {} : { referenceReranker }),
    },
    {
      conversationId: "clean-checkout-demo",
      text: query,
      capsuleId: DEMO_CAPSULE_ID,
      topK: DEMO_TOP_K,
      ...(minScore === undefined ? {} : { minScore }),
    },
  );
}

// Deterministic byte-order string comparator used to keep the evidence's `citationFiles` list in
// the same order on every host. The named helper replaces an inline nested ternary Sonar's
// `sonarjs:javascript:S3358` flagged (nested ternaries hurt readability); a single named function
// spells the intent out and lets the sort's arrow simply reference it.
function byteOrderCompare(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function fileLineHashForCitations(citations) {
  return sha256Hex(
    stableStringify(
      citations.map((entry) => ({
        path: entry.relativePath,
        startLine: entry.startLine,
        endLine: entry.endLine,
      })),
    ),
  );
}

function rerankerSummary(result) {
  const diagnostics = result.reranker;
  return {
    diagnosticStatus: diagnostics?.status ?? "missing",
    diagnosticFailureKind: diagnostics?.failureKind,
    candidateCount: diagnostics?.candidateCount ?? 0,
    documentCount: diagnostics?.documentCount ?? 0,
    keptCount: diagnostics?.keptCount ?? 0,
    selectedOrderHash: sha256Hex(
      stableStringify(result.references.map((reference) => reference.chunkId)),
    ),
  };
}

function checkoutHygieneSummary(repoRoot) {
  return {
    workspaceRootExists: existsSync(repoRoot),
    // The demo runs against `:memory:` and never touches the real store, but a reviewer's checkout
    // must be reasonably clean for the DoD to hold. We report whether a `.keiko` state directory
    // exists at the repo root; a hostile checkout with pre-seeded state would set this to true.
    keikoStatePresentAtStart: existsSync(join(repoRoot, ".keiko")),
    buildArtifactsPresentAtStart: existsSync(join(repoRoot, "dist")),
  };
}

function definedFields(record) {
  return Object.fromEntries(Object.entries(record).filter((entry) => entry[1] !== undefined));
}

// The clean-demo corpus is intentionally below the USearch HNSW crossover. The provider must be
// verified and available, while `searchMode=exact` truthfully records that the shared engine chose
// its bounded exact lane. The separate >20k closeout proof certifies real HNSW execution.
function extractVectorIndexDiagnostic(groundedResult) {
  const vectorIndex = groundedResult.retrievalDiagnostics?.vectorIndex ?? {};
  return {
    provider: vectorIndex.provider ?? "unknown",
    status: vectorIndex.status ?? "unknown",
    ...definedFields({
      reason: vectorIndex.reason,
      indexName: vectorIndex.indexName,
      vectorCount: vectorIndex.vectorCount,
      searchMode: vectorIndex.searchMode,
      examinedCandidateCount: vectorIndex.examinedCandidateCount,
      estimatedIndexBytes: vectorIndex.estimatedIndexBytes,
    }),
  };
}

function abstentionSummary(groundedResult) {
  return {
    references: groundedResult.references.length,
    citations: groundedResult.citations.length,
    generatedCharacters: groundedResult.answer.length,
    noEvidence: groundedResult.noEvidence === true,
    reason: groundedResult.reason,
  };
}

function requireDemoOptions({
  executionMode,
  gatewayConfig,
  embeddingModelId,
  answerModelId,
  embeddingDimensions,
  testAnswerGenerator,
  usearchBinaryPath,
}) {
  if (!Object.values(CLEAN_CHECKOUT_EXECUTION_MODES).includes(executionMode)) {
    throw new Error(`clean-checkout demo: unsupported execution mode '${String(executionMode)}'`);
  }
  if (embeddingDimensions === undefined) {
    throw new Error("clean-checkout demo: embeddingDimensions is required");
  }
  if (gatewayConfig === undefined) {
    throw new Error("clean-checkout demo: a parsed gateway configuration is required");
  }
  if (usearchBinaryPath === undefined) {
    throw new Error(
      "clean-checkout demo: verified USearch runtime is required; run npm run provision:usearch",
    );
  }
  requireConfiguredProvider(gatewayConfig, embeddingModelId, "embedding");
  if (gatewayConfig.reranker === undefined) {
    throw new Error("clean-checkout demo: a configured provider-backed reranker is required");
  }
  if (executionMode === CLEAN_CHECKOUT_EXECUTION_MODES.acceptance) {
    if (testAnswerGenerator !== undefined) {
      throw new Error("clean-checkout demo: acceptance mode refuses an injected answer adapter");
    }
    requireConfiguredProvider(gatewayConfig, answerModelId, "chat");
    return;
  }
  if (testAnswerGenerator === undefined) {
    throw new Error("clean-checkout demo: hermetic-test mode requires an injected answer adapter");
  }
}

function answerGeneratorFor({ executionMode, gatewayConfig, answerModelId, testAnswerGenerator }) {
  if (executionMode === CLEAN_CHECKOUT_EXECUTION_MODES.hermeticTest) {
    return testAnswerGenerator;
  }
  return new ModelGatewayAnswerGenerator({
    chatGateway: new Gateway(gatewayConfig),
    modelId: answerModelId,
    policy: "require-citations-or-state-no-evidence",
  });
}

async function runMultiFileAnswers({
  store,
  embeddingAdapter,
  vectorIndex,
  answerGenerator,
  gatewayConfig,
  env,
}) {
  const shared = { store, embeddingAdapter, vectorIndex, answerGenerator, query: MULTI_FILE_QUERY };
  const enabled = await runDemoGroundedAnswer({
    ...shared,
    referenceReranker: buildReferenceReranker({
      gatewayConfig,
      env,
      policy: { externalReranking: "allow", localReranking: "deny" },
    }),
  });
  const disabled = await runDemoGroundedAnswer({
    ...shared,
    referenceReranker: buildReferenceReranker({
      gatewayConfig,
      env,
      policy: { externalReranking: "deny", localReranking: "deny" },
    }),
  });
  return { enabled, disabled };
}

async function runDemoQueriesAndFacade({
  store,
  embeddingAdapter,
  vectorIndex,
  gatewayConfig,
  env,
  index,
  answerGenerator,
}) {
  const instrumented = instrumentAnswerGenerator(answerGenerator);
  const { enabled, disabled } = await runMultiFileAnswers({
    store,
    embeddingAdapter,
    vectorIndex,
    answerGenerator: instrumented.generator,
    gatewayConfig,
    env,
  });
  const beforeAbstention = instrumented.calls();
  const abstention = await runDemoGroundedAnswer({
    store,
    embeddingAdapter,
    vectorIndex,
    answerGenerator: instrumented.generator,
    query: ABSTENTION_QUERY,
    minScore: DEMO_ABSTENTION_MIN_SCORE,
  });
  return {
    multiFile: {
      result: enabled,
      citations: lineRangesForAttachedCitations(enabled.citations, index.chunkLineRanges),
    },
    abstention: {
      result: abstention,
      generationCalls: instrumented.calls() - beforeAbstention,
    },
    rerankerEnabled: rerankerSummary(enabled),
    rerankerDisabled: rerankerSummary(disabled),
  };
}

function buildVectorIndexEvidence(vectorIndex) {
  return {
    provider: vectorIndex.provider,
    status: vectorIndex.status,
    ...(vectorIndex.reason === undefined ? {} : { reason: vectorIndex.reason }),
    ...(vectorIndex.indexName === undefined
      ? {}
      : { indexIdentityHash: sha256Hex(vectorIndex.indexName) }),
    ...(vectorIndex.vectorCount === undefined ? {} : { vectorCount: vectorIndex.vectorCount }),
    ...(vectorIndex.searchMode === undefined ? {} : { searchMode: vectorIndex.searchMode }),
    ...(vectorIndex.examinedCandidateCount === undefined
      ? {}
      : { examinedCandidateCount: vectorIndex.examinedCandidateCount }),
    ...(vectorIndex.estimatedIndexBytes === undefined
      ? {}
      : { estimatedIndexBytes: vectorIndex.estimatedIndexBytes }),
    forbiddenStatusesAvoided: ANN_FORBIDDEN_STATUSES,
    providerAvailable:
      vectorIndex.provider === ANN_PROVIDER_USEARCH &&
      vectorIndex.status === ANN_STATUS_AVAILABLE &&
      vectorIndex.searchMode === "exact",
    hnswQualifiedBy: "npm run check:knowledge-m2-closeout",
  };
}

function buildMultiFileEvidence(multiFile) {
  const distinctFiles = new Set(
    multiFile.citations.map((entry) => toWorkspaceRelativePath(entry.relativePath)),
  );
  return {
    queryHash: sha256Hex(MULTI_FILE_QUERY),
    referenceCount: multiFile.result.references.length,
    attachedCitationCount: multiFile.result.citations.length,
    citationCount: multiFile.citations.length,
    generatedCharacters: multiFile.result.answer.length,
    generationHash: sha256Hex(multiFile.result.answer),
    noEvidence: multiFile.result.noEvidence,
    distinctFileCount: distinctFiles.size,
    spansMultipleFiles: distinctFiles.size >= 2,
    // Byte-order comparator (see `byteOrderCompare` below) for a deterministic list across
    // every host. Sorting with the default `.sort()` uses the runtime's locale-aware string
    // ordering, so the recorded evidence would differ on hosts with a non-C locale.
    citationFiles: [...distinctFiles].sort(byteOrderCompare),
    citationLinesResolved:
      multiFile.citations.length === multiFile.result.citations.length &&
      multiFile.citations.every((entry) => entry.startLine > 0 && entry.endLine >= entry.startLine),
    fileLineHash: fileLineHashForCitations(multiFile.citations),
  };
}

function buildAbstentionEvidence(abstention) {
  return {
    queryHash: sha256Hex(ABSTENTION_QUERY),
    ...abstentionSummary(abstention.result),
    generationCalls: abstention.generationCalls,
    abstained:
      abstention.result.noEvidence === true &&
      abstention.result.references.length === 0 &&
      abstention.result.citations.length === 0 &&
      abstention.result.answer.length === 0 &&
      abstention.generationCalls === 0,
  };
}

function buildRerankerEvidence(rerankerEnabled, rerankerDisabled) {
  return {
    enabled: {
      policyExternalReranking: "allow",
      diagnosticStatus: rerankerEnabled.diagnosticStatus,
      diagnosticFailureKind: rerankerEnabled.diagnosticFailureKind,
      selectedOrderHash: rerankerEnabled.selectedOrderHash,
      candidateCount: rerankerEnabled.candidateCount,
      documentCount: rerankerEnabled.documentCount,
      keptCount: rerankerEnabled.keptCount,
    },
    disabled: {
      policyExternalReranking: "deny",
      diagnosticStatus: rerankerDisabled.diagnosticStatus,
      diagnosticFailureKind: rerankerDisabled.diagnosticFailureKind,
      selectedOrderHash: rerankerDisabled.selectedOrderHash,
      candidateCount: rerankerDisabled.candidateCount,
      documentCount: rerankerDisabled.documentCount,
      keptCount: rerankerDisabled.keptCount,
    },
    // With external reranking allowed, the configured transport must produce an applied ordering;
    // with it denied, the facade returns the governed fallback. Different hashes prove that the
    // selected reference path—not merely a diagnostic label—changed.
    answerPathDiffers: rerankerEnabled.selectedOrderHash !== rerankerDisabled.selectedOrderHash,
  };
}

function assembleEvidence({ executionMode, hygieneAtStart, index, queries, elapsedMs }) {
  const vectorIndex = extractVectorIndexDiagnostic(queries.multiFile.result);
  return {
    demo: EVIDENCE_DEMO_ID,
    issue: EVIDENCE_ISSUE_REF,
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    executionMode,
    acceptanceEligible: executionMode === CLEAN_CHECKOUT_EXECUTION_MODES.acceptance,
    cleanCheckout: {
      ...hygieneAtStart,
      indexedPathsRequested: DEMO_INDEXED_PATHS.length,
      indexedPathsResolved: index.indexedPathCount,
      fingerprintCount: index.fingerprintCount,
    },
    vectorIndex: buildVectorIndexEvidence(vectorIndex),
    multiFileQuery: buildMultiFileEvidence(queries.multiFile),
    abstention: buildAbstentionEvidence(queries.abstention),
    reranker: buildRerankerEvidence(queries.rerankerEnabled, queries.rerankerDisabled),
    toolchain: {
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
    elapsedMs,
  };
}

function resolveDemoGatewayConfig({ gatewayConfig, executionMode, mockOrigin }, secrets) {
  if (gatewayConfig !== undefined) return gatewayConfig;
  if (
    executionMode !== CLEAN_CHECKOUT_EXECUTION_MODES.hermeticTest ||
    typeof mockOrigin !== "string" ||
    mockOrigin.length === 0
  ) {
    return undefined;
  }
  return buildHermeticGatewayConfig(mockOrigin, secrets);
}

async function executeCleanCheckoutDemo({
  repoRoot,
  runtime,
  usearchBinaryPath,
  env,
  now,
  signal,
  secrets,
  startedAtMs,
  hygieneAtStart,
}) {
  const vectorIndex = resolveDemoVectorIndex(usearchBinaryPath);
  const store = openDemoStore(vectorIndex, secrets.storeEncryptionKey);
  try {
    const embeddingAdapter = buildDemoEmbeddingAdapter({
      gatewayConfig: runtime.gatewayConfig,
      modelId: runtime.embeddingModelId,
      dimensions: runtime.embeddingDimensions,
    });
    const index = await indexDemoRepositoryPod({ store, embeddingAdapter, repoRoot, signal });
    const answerGenerator = answerGeneratorFor({
      executionMode: runtime.executionMode,
      gatewayConfig: runtime.gatewayConfig,
      answerModelId: runtime.answerModelId,
      testAnswerGenerator: runtime.testAnswerGenerator,
    });
    const queries = await runDemoQueriesAndFacade({
      store,
      embeddingAdapter,
      vectorIndex,
      gatewayConfig: runtime.gatewayConfig,
      env,
      index,
      answerGenerator,
    });
    return assembleEvidence({
      executionMode: runtime.executionMode,
      hygieneAtStart,
      index,
      queries,
      elapsedMs: now() - startedAtMs,
    });
  } finally {
    store.close();
  }
}

export async function runCleanCheckoutDemo({
  repoRoot = REPO_ROOT_DEFAULT,
  executionMode = CLEAN_CHECKOUT_EXECUTION_MODES.acceptance,
  mockOrigin,
  gatewayConfig,
  embeddingModelId = EMBEDDING_MODEL_ID,
  answerModelId = ANSWER_MODEL_ID,
  embeddingDimensions,
  testAnswerGenerator,
  usearchBinaryPath = resolveProvisionedUsearchPath({ repoRoot }),
  env = process.env,
  now = () => Date.now(),
  signal,
} = {}) {
  const secrets = generateDemoSecrets();
  const resolvedGatewayConfig = resolveDemoGatewayConfig(
    { gatewayConfig, executionMode, mockOrigin },
    secrets,
  );
  requireDemoOptions({
    executionMode,
    gatewayConfig: resolvedGatewayConfig,
    embeddingModelId,
    answerModelId,
    embeddingDimensions,
    testAnswerGenerator,
    usearchBinaryPath,
  });
  const startedAtMs = now();
  const hygieneAtStart = checkoutHygieneSummary(repoRoot);
  return executeCleanCheckoutDemo({
    repoRoot,
    runtime: {
      executionMode,
      gatewayConfig: resolvedGatewayConfig,
      embeddingModelId,
      answerModelId,
      embeddingDimensions,
      testAnswerGenerator,
    },
    usearchBinaryPath,
    env,
    now,
    signal,
    secrets,
    startedAtMs,
    hygieneAtStart,
  });
}

// ─── Evidence contract (validated before the runner returns / before the CLI prints) ─────────

// Content-free redaction — the recorded evidence must be safe to attach to a PR body. A field
// carrying a URL, credential label, or excerpt phrase is a leak.
export function evidenceRedactionFailures(evidence) {
  const failures = [];
  const serialized = JSON.stringify(evidence);
  if (/https?:\/\//iu.test(serialized)) failures.push("endpoint");
  if (/\b(?:api[_-]?key|secret|token)\b/iu.test(serialized)) failures.push("credential-label");
  if (/\b(?:excerpt|answer|body|response text|raw text)\b/iu.test(serialized))
    failures.push("body-material");
  return failures;
}

export function evaluateAcceptanceCriteria(evidence) {
  const results = ACCEPTANCE_CRITERIA.map((criterion) => {
    const failures = failuresForCriterion(criterion.id, evidence);
    return { id: criterion.id, label: criterion.label, ok: failures.length === 0, failures };
  });
  return { ok: results.every((entry) => entry.ok), results };
}

function failuresForCriterion(id, evidence) {
  switch (id) {
    case "clean-checkout":
      return failuresCleanCheckout(evidence);
    case "vector-index-active":
      return failuresVectorIndexActive(evidence);
    case "multi-file-citations":
      return failuresMultiFileCitations(evidence);
    case "abstention":
      return failuresAbstention(evidence);
    case "reranker-toggle":
      return failuresRerankerToggle(evidence);
    case "content-free-evidence":
      return failuresContentFree(evidence);
    default:
      return [`unknown-criterion:${id}`];
  }
}

function failuresCleanCheckout(evidence) {
  const failures = [];
  const record = evidence.cleanCheckout;
  if (record === undefined) return ["missing:cleanCheckout"];
  if (record.workspaceRootExists !== true) failures.push("workspace-root-missing");
  if (record.indexedPathsResolved <= 0) failures.push("no-paths-indexed");
  if (record.fingerprintCount <= 0) failures.push("no-fingerprints-recorded");
  // Partial indexing is a silent DoD failure: if the walk found only two of the three tracked
  // files, the pod is still queryable and the multi-file AC would still turn green — but the
  // "small real slice" the runbook advertises no longer holds. Every requested path must be
  // resolved before the clean-checkout bullet passes.
  if (record.indexedPathsRequested !== record.indexedPathsResolved) {
    failures.push(
      `partial-indexing:${String(record.indexedPathsResolved)}/${String(record.indexedPathsRequested)}`,
    );
  }
  // The DoD wording asks the demo to run "from a clone with no .keiko state and no build
  // artifacts". The demo's OWN state is guaranteed clean (`:memory:` store, no fixtures on disk)
  // — these two fields report the caller's checkout state, so the reader can see whether the run
  // matched the DoD's fresh-clone scenario. They are enforced when they can be honoured: on CI
  // (a fresh clone) and inside the container-based runbook, both should be false; on a
  // developer's dev-tree they may legitimately be true, so the runner sets
  // `KEIKO_CLEAN_CHECKOUT_DEMO_ALLOW_DIRTY_HOST=1` to record-only rather than enforce. The
  // default is enforcement, because the DoD signature happens on a clean host and a permissive
  // default would let a dev-tree run silently claim it.
  if (
    process.env.KEIKO_CLEAN_CHECKOUT_DEMO_ALLOW_DIRTY_HOST !== "1" &&
    record.keikoStatePresentAtStart === true
  ) {
    failures.push("keiko-state-present-at-start");
  }
  if (
    process.env.KEIKO_CLEAN_CHECKOUT_DEMO_ALLOW_DIRTY_HOST !== "1" &&
    record.buildArtifactsPresentAtStart === true
  ) {
    failures.push("build-artifacts-present-at-start");
  }
  return failures;
}

function addFailureWhen(failures, condition, message) {
  if (condition) failures.push(message);
}

function failuresVectorIndexActive(evidence) {
  const failures = [];
  const record = evidence.vectorIndex;
  if (record === undefined) return ["missing:vectorIndex"];
  addFailureWhen(
    failures,
    record.providerAvailable !== true,
    `vector-index-not-available:${record.status ?? "unknown"}`,
  );
  addFailureWhen(
    failures,
    record.provider !== ANN_PROVIDER_USEARCH,
    `unexpected-provider:${record.provider ?? "unknown"}`,
  );
  addFailureWhen(
    failures,
    record.status !== ANN_STATUS_AVAILABLE,
    `provider-not-available:${record.status ?? "unknown"}`,
  );
  addFailureWhen(
    failures,
    record.searchMode !== "exact",
    `unexpected-small-corpus-search-mode:${record.searchMode ?? "unknown"}`,
  );
  addFailureWhen(
    failures,
    record.hnswQualifiedBy !== "npm run check:knowledge-m2-closeout",
    "missing-hnsw-qualification-reference",
  );
  addFailureWhen(
    failures,
    stableStringify(record.forbiddenStatusesAvoided) !== stableStringify(ANN_FORBIDDEN_STATUSES),
    "forbidden-status-set-mismatch",
  );
  for (const forbidden of ANN_FORBIDDEN_STATUSES) {
    addFailureWhen(failures, record.status === forbidden, `forbidden-status:${forbidden}`);
  }
  return failures;
}

function failuresMultiFileCitations(evidence) {
  const failures = [];
  const record = evidence.multiFileQuery;
  if (record === undefined) return ["missing:multiFileQuery"];
  addFailureWhen(failures, record.generatedCharacters <= 0, "no-generated-text");
  addFailureWhen(
    failures,
    !/^[0-9a-f]{64}$/u.test(record.generationHash ?? ""),
    "invalid-generation-hash",
  );
  addFailureWhen(failures, record.noEvidence !== false, "generation-reported-no-evidence");
  addFailureWhen(failures, record.attachedCitationCount <= 0, "no-attached-citations");
  addFailureWhen(failures, record.citationCount <= 0, "no-citations");
  addFailureWhen(
    failures,
    record.distinctFileCount < 2,
    `single-file-only:${String(record.distinctFileCount)}`,
  );
  addFailureWhen(failures, record.spansMultipleFiles !== true, "does-not-span-multiple-files");
  addFailureWhen(failures, record.citationLinesResolved !== true, "lines-unresolved");
  return failures;
}

function failuresAbstention(evidence) {
  const failures = [];
  const record = evidence.abstention;
  if (record === undefined) return ["missing:abstention"];
  if (record.abstained !== true) failures.push("did-not-abstain");
  if (record.references > 0) failures.push(`references-emitted:${String(record.references)}`);
  if (record.citations > 0) failures.push(`citations-emitted:${String(record.citations)}`);
  if (record.generatedCharacters > 0)
    failures.push(`generated-characters:${String(record.generatedCharacters)}`);
  if (record.generationCalls > 0)
    failures.push(`generation-calls:${String(record.generationCalls)}`);
  if (record.noEvidence !== true) failures.push("no-evidence-not-stated");
  return failures;
}

function failuresRerankerToggle(evidence) {
  const failures = [];
  const record = evidence.reranker;
  if (record === undefined) return ["missing:reranker"];
  const enabled = record.enabled ?? {};
  const disabled = record.disabled ?? {};
  addFailureWhen(failures, enabled.policyExternalReranking !== "allow", "enabled-policy-not-allow");
  addFailureWhen(failures, disabled.policyExternalReranking !== "deny", "disabled-policy-not-deny");
  addFailureWhen(
    failures,
    enabled.diagnosticStatus !== "applied",
    `enabled-reranker-not-applied:${enabled.diagnosticStatus ?? "missing"}`,
  );
  addFailureWhen(
    failures,
    disabled.diagnosticStatus !== "denied",
    `disabled-reranker-not-denied:${disabled.diagnosticStatus ?? "missing"}`,
  );
  addFailureWhen(
    failures,
    disabled.diagnosticFailureKind !== "policy-denied",
    "disabled-reranker-failure-kind",
  );
  addFailureWhen(failures, record.answerPathDiffers !== true, "answer-path-does-not-differ");
  addFailureWhen(
    failures,
    enabled.selectedOrderHash === disabled.selectedOrderHash,
    "order-hashes-identical",
  );
  return failures;
}

function failuresContentFree(evidence) {
  return evidenceRedactionFailures(evidence).map((kind) => `redaction:${kind}`);
}

function envelopeFailures(evidence) {
  const failures = [];
  if (evidence.demo !== EVIDENCE_DEMO_ID) failures.push(`demo-id:${String(evidence.demo)}`);
  if (evidence.issue !== EVIDENCE_ISSUE_REF) failures.push(`issue-ref:${String(evidence.issue)}`);
  if (evidence.schemaVersion !== EVIDENCE_SCHEMA_VERSION)
    failures.push(`schema-version:${String(evidence.schemaVersion)}`);
  if (!Object.values(CLEAN_CHECKOUT_EXECUTION_MODES).includes(evidence.executionMode)) {
    failures.push(`execution-mode:${String(evidence.executionMode)}`);
  }
  const eligible = evidence.executionMode === CLEAN_CHECKOUT_EXECUTION_MODES.acceptance;
  if (evidence.acceptanceEligible !== eligible) failures.push("acceptance-eligibility");
  if (typeof evidence.elapsedMs !== "number" || evidence.elapsedMs < 0) failures.push("elapsed-ms");
  return failures;
}

function acceptanceFailures(evidence) {
  const acceptance = evaluateAcceptanceCriteria(evidence);
  if (acceptance.ok) return [];
  return acceptance.results
    .filter((result) => !result.ok)
    .map((result) => `acceptance:${result.id}:${result.failures.join("|")}`);
}

export function validateEvidenceContract(evidence) {
  if (evidence === null || typeof evidence !== "object") return ["not-an-object"];
  return [...envelopeFailures(evidence), ...acceptanceFailures(evidence)];
}

// Convenience for the CLI to render an acceptance summary alongside the evidence, without adding
// extra keys to the evidence object itself.
function acceptanceReportLine(result) {
  const status = result.ok ? "PASS" : "FAIL";
  const suffix = result.ok ? "" : ` — ${result.failures.join(", ")}`;
  return `${status} ${result.id}${suffix}`;
}

export function renderAcceptanceReport(evidence) {
  const acceptance = evaluateAcceptanceCriteria(evidence);
  return acceptance.results.map(acceptanceReportLine);
}

// Direct invocation (`node scripts/lib/clean-checkout-demo.mjs`) is not the supported entry point
// — the CLI wrapper handles process orchestration. This guard keeps a stray `node lib/...` from
// silently doing nothing.
const invokedDirectly = (() => {
  const entryPoint = process.argv[1];
  return entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href;
})();
if (invokedDirectly) {
  console.error(
    "clean-checkout-demo library is not runnable directly; use scripts/knowledge-m2-clean-checkout-demo.mjs.",
  );
  process.exit(2);
}
