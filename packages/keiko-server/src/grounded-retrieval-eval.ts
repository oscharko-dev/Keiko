// Production semantic-retrieval + RRF-fusion + model-reranker eval harness (RB-5,
// GEN-AI-RELEASE-GATE-001 / GEN-AI-RETRIEVAL-006 / GEN-TEST-FIXTURE-002).
//
// `check:retrieval-quality` covers workspace search and Local Knowledge fixture scorecards. This
// harness covers the production semantic + reranker + RRF path by driving the REAL functions
// end-to-end over a distractor-dense corpus:
//
//   1. A real repository pod seeded through `refreshRepositoryPod`, then consumed through
//      `configuredRepoSemanticSearchProviderFor` with a scripted SEMANTIC embedding port (topic
//      vectors, not lexical overlap), so a paraphrased query matches the right persisted chunk.
//   2. `rerankAndSelect` (grounded-rerank) — the real RRF fusion of the lexical + semantic engines.
//   3. `rerankSelection` (grounded-rerank-facade) — the real model-reranker gate with a scripted
//      rerank port.
//
// Non-tautological by construction: the budget floors are < 1, and an injected ranking or reranker
// regression (`reranker-reversed`, `embedding-flat`) provably drops the metrics BELOW the floors —
// so the gate turns red on a real regression in this grounded-answer path.

import {
  EMBEDDING_INSTRUCTION_VERSION,
  verifyEmbeddingCapability,
  type GatewayConfig,
  type LiteLLMRerankRequest,
  type OpenAIEmbeddingOutcome,
  type OpenAIEmbeddingRequest,
  type RerankOutcome,
} from "@oscharko-dev/keiko-model-gateway";
import type {
  EvalBudget,
  EvalFloorResult,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import {
  createDefaultParserRegistry,
  createRepositoryPodShell,
  listRepositoryChunkLineRanges,
  openKnowledgeStore,
  readRepositoryFileFingerprints,
  refreshRepositoryPod,
  type KnowledgeStore,
} from "@oscharko-dev/keiko-local-knowledge";
import type {
  SemanticSearchProvider,
  WorkspaceDirEntry,
  WorkspaceFs,
  WorkspaceStat,
} from "@oscharko-dev/keiko-workspace";

import type { UiHandlerDeps } from "./deps.js";
import { buildRedactor } from "./deps.js";
import { createRunRegistry } from "./runs.js";
import { createInMemoryUiStore } from "./store/index.js";
import {
  configuredRepoSemanticSearchProviderFor,
  type RepositoryPodRetrievalObservation,
} from "./grounded-repo-semantic-search.js";
import {
  rerankAndSelect,
  withFinalMarkers,
  withModelRerankScore,
  type RerankInput,
  type SelectedCandidate,
} from "./grounded-rerank.js";
import { rerankSelection } from "./grounded-rerank-facade.js";
import { localKnowledgeEmbeddingAdapterForProvider } from "./local-knowledge-handlers.js";

const EMBEDDING_MODEL = "eval-embedding";
const RERANK_MODEL = "eval-reranker";
const EVAL_K = 3;
const TOP_N = 4;
const EVAL_REPOSITORY_ROOT = "/eval-repository";
const EVAL_CAPSULE_ID = "grounded-retrieval-eval" as KnowledgeCapsuleId;
const EVAL_SOURCE_ID = "grounded-retrieval-eval-source" as KnowledgeSourceId;

export type GroundedRetrievalEvalMode =
  "baseline" | "reranker-off" | "reranker-reversed" | "embedding-flat";

// ─── Concept (semantic) embedding ─────────────────────────────────────────────
// Per concept: a scopePath, plus DISJOINT document vs query vocabularies. A document and its query
// share NO literal words; the document-side `service` and query-side `system` tokens map to the
// same weak embedding dimension. Lexical overlap therefore cannot discriminate the target from the
// distractors, and ONLY the semantic concept vector can. This makes the harness a genuine SEMANTIC
// retrieval test rather than a lexical substring test.

interface ConceptModel {
  readonly id: string;
  readonly scopePath: string;
  readonly docWords: readonly string[];
  readonly queryWords: readonly string[];
}

const DOCUMENT_SYSTEM_WORD = "service";
const QUERY_SYSTEM_WORD = "system";

const CONCEPT_MODEL: readonly ConceptModel[] = [
  {
    id: "auth",
    scopePath: "src/auth/session.ts",
    docWords: ["session", "credential", "identity"],
    queryWords: ["authentication", "login", "signin"],
  },
  {
    id: "payments",
    scopePath: "src/payments/ledger.ts",
    docWords: ["invoice", "ledger", "settlement"],
    queryWords: ["billing", "refund", "charge"],
  },
  {
    id: "retry",
    scopePath: "src/net/resilience.ts",
    docWords: ["resilience", "reattempt", "failover"],
    queryWords: ["retry", "backoff", "redelivery"],
  },
  {
    id: "cache",
    scopePath: "src/cache/store.ts",
    docWords: ["eviction", "invalidation", "memoize"],
    queryWords: ["caching", "ttl", "warmup"],
  },
  {
    id: "search",
    scopePath: "src/search/rank.ts",
    docWords: ["retrieval", "relevance", "index"],
    queryWords: ["ranking", "lookup", "querying"],
  },
  {
    id: "config",
    scopePath: "src/config/flags.ts",
    docWords: ["configuration", "setting", "environment"],
    queryWords: ["toggle", "flag", "preference"],
  },
  {
    id: "routing",
    scopePath: "src/http/dispatch.ts",
    docWords: ["endpoint", "handler", "dispatch"],
    queryWords: ["routing", "route", "controller"],
  },
  {
    id: "encryption",
    scopePath: "src/crypto/seal.ts",
    docWords: ["cipher", "sealed", "cryptography"],
    queryWords: ["encrypt", "decrypt", "encryption"],
  },
  {
    id: "logging",
    scopePath: "src/obs/trace.ts",
    docWords: ["telemetry", "diagnostic", "observability"],
    queryWords: ["audit", "tracing", "logging"],
  },
  {
    id: "scheduling",
    scopePath: "src/jobs/timer.ts",
    docWords: ["scheduler", "cron", "interval"],
    queryWords: ["schedule", "timer", "recurring"],
  },
];

// Dimensions: one per concept + a trailing shared `system` dimension carried by every doc + query.
const SYSTEM_DIM = CONCEPT_MODEL.length;
const NUM_DIMS = CONCEPT_MODEL.length + 1;

function buildSynonymMap(): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  CONCEPT_MODEL.forEach((concept, index) => {
    for (const word of [...concept.docWords, ...concept.queryWords]) map.set(word, index);
  });
  map.set(DOCUMENT_SYSTEM_WORD, SYSTEM_DIM);
  map.set(QUERY_SYSTEM_WORD, SYSTEM_DIM);
  return map;
}

const SYNONYM_TO_CONCEPT = buildSynonymMap();

function tokenize(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0);
}

function conceptVector(text: string): Float32Array {
  const vector = new Float32Array(NUM_DIMS);
  for (const token of tokenize(text)) {
    const dim = SYNONYM_TO_CONCEPT.get(token);
    if (dim !== undefined) {
      vector[dim] = (vector[dim] ?? 0) + 1;
    }
  }
  let magnitude = 0;
  for (const value of vector) magnitude += value * value;
  magnitude = Math.sqrt(magnitude);
  if (magnitude > 0) {
    for (let i = 0; i < vector.length; i += 1) vector[i] = (vector[i] ?? 0) / magnitude;
  }
  return vector;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

// ─── Distractor-dense corpus + labeled queries ────────────────────────────────

interface EvalDocument {
  readonly scopePath: string;
  readonly text: string;
}

interface EvalCase {
  readonly id: string;
  readonly query: string;
  readonly relevantPath: string;
}

// Generated from CONCEPT_MODEL so the doc/query vocabularies stay provably disjoint. Every document
// carries the embedding-synonymous `service`/`system` concept, so all ten are returned for EVERY
// query with a non-zero cosine while lexical overlap remains zero — a genuine distractor-dense set
// where SEMANTIC RANKING (not presence or lexical fallback) decides the winner.
const CORPUS: readonly EvalDocument[] = CONCEPT_MODEL.map((concept) => ({
  scopePath: concept.scopePath,
  text: `export const ${concept.id}Signals = ["${DOCUMENT_SYSTEM_WORD}", ${concept.docWords
    .map((word) => `"${word}"`)
    .join(", ")}];`,
}));

const CASES: readonly EvalCase[] = CONCEPT_MODEL.map((concept) => ({
  id: concept.id,
  query: `In the ${QUERY_SYSTEM_WORD}, which module handles ${concept.queryWords.join(" ")}?`,
  relevantPath: concept.scopePath,
}));

// ─── Scripted ports (embedding + reranker), regression-aware ──────────────────

function scriptedEmbeddingPort(
  mode: GroundedRetrievalEvalMode,
  audit: EmbeddingAudit,
): (request: OpenAIEmbeddingRequest) => Promise<OpenAIEmbeddingOutcome> {
  return (request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> => {
    if (audit.askPhase && request.input.startsWith("Path:")) {
      audit.askTimeDocumentEmbeddingCount += 1;
    }
    // `embedding-flat`: a broken embedding that maps everything to the same vector. Semantic ranking
    // collapses to arbitrary tie-breaks, so retrieval can no longer surface the relevant document.
    const vector = scriptedVector(mode, request.input);
    return Promise.resolve({ ok: true, value: { vector, modelId: request.modelId } });
  };
}

function scriptedVector(mode: GroundedRetrievalEvalMode, input: string): Float32Array {
  if (mode === "embedding-flat") {
    return new Float32Array(NUM_DIMS).fill(1 / Math.sqrt(NUM_DIMS));
  }
  const vector = conceptVector(input);
  if (vector.every((value) => value === 0)) vector[SYSTEM_DIM] = 1;
  return vector;
}

function scriptedRerankPort(
  mode: GroundedRetrievalEvalMode,
): (request: LiteLLMRerankRequest) => Promise<RerankOutcome> {
  return (request: LiteLLMRerankRequest): Promise<RerankOutcome> => {
    // `reranker-off` / `embedding-flat`: the model reranker is unavailable, so the pipeline falls
    // back to the semantic + RRF retrieval order. `reranker-off` proves that fallback ranks
    // correctly on its own; `embedding-flat` breaks the retrieval embedding underneath it so the
    // fallback has nothing to rank on — isolating the semantic path as load-bearing.
    if (mode === "reranker-off" || mode === "embedding-flat") {
      return Promise.resolve({ ok: false, kind: "transport" });
    }
    const queryVector = conceptVector(request.query);
    const scored = request.documents.map((document, index) => ({
      index,
      relevanceScore: cosine(queryVector, conceptVector(document)),
    }));
    scored.sort((a, b) => b.relevanceScore - a.relevanceScore || a.index - b.index);
    // `reranker-reversed`: a defective reranker that returns worst-first. The facade trusts the
    // order, so the least-relevant candidate is promoted to the top.
    const results = mode === "reranker-reversed" ? [...scored].reverse() : scored;
    return Promise.resolve({ ok: true, value: { modelId: RERANK_MODEL, results } });
  };
}

// ─── Deps construction (in-memory) ────────────────────────────────────────────

function evalFileMap(): Readonly<Record<string, string>> {
  return Object.fromEntries(CORPUS.map((document) => [document.scopePath, document.text]));
}

function evalRelativePath(absolutePath: string): string {
  if (absolutePath === EVAL_REPOSITORY_ROOT) return "";
  return absolutePath.startsWith(`${EVAL_REPOSITORY_ROOT}/`)
    ? absolutePath.slice(EVAL_REPOSITORY_ROOT.length + 1)
    : absolutePath;
}

function evalDirectoryEntries(
  files: Readonly<Record<string, string>>,
  absolutePath: string,
): readonly WorkspaceDirEntry[] {
  const prefix = evalRelativePath(absolutePath);
  const childPrefix = prefix.length === 0 ? "" : `${prefix}/`;
  const directories = new Set<string>();
  const leaves = new Set<string>();
  for (const path of Object.keys(files)) {
    if (!path.startsWith(childPrefix)) continue;
    const remainder = path.slice(childPrefix.length);
    const separator = remainder.indexOf("/");
    if (separator < 0) leaves.add(remainder);
    else directories.add(remainder.slice(0, separator));
  }
  return [
    ...[...directories].map((name) => ({
      name,
      isDirectory: true,
      isFile: false,
      isSymbolicLink: false,
    })),
    ...[...leaves].map((name) => ({
      name,
      isDirectory: false,
      isFile: true,
      isSymbolicLink: false,
    })),
  ];
}

function evalWorkspaceFs(): WorkspaceFs {
  const files = evalFileMap();
  return {
    readFileUtf8: (absolutePath): string => files[evalRelativePath(absolutePath)] ?? "",
    stat: (absolutePath): WorkspaceStat => {
      const text = files[evalRelativePath(absolutePath)];
      return text === undefined
        ? { size: 0, isFile: false, isDirectory: true, isSymbolicLink: false }
        : {
            size: Buffer.byteLength(text, "utf8"),
            isFile: true,
            isDirectory: false,
            isSymbolicLink: false,
          };
    },
    readDir: (absolutePath): readonly WorkspaceDirEntry[] =>
      evalDirectoryEntries(files, absolutePath),
    realPath: (absolutePath): string => absolutePath,
    exists: (absolutePath): boolean =>
      absolutePath === EVAL_REPOSITORY_ROOT || files[evalRelativePath(absolutePath)] !== undefined,
    readFileBytes: (absolutePath, maxBytes): Promise<Uint8Array> => {
      const bytes = new TextEncoder().encode(files[evalRelativePath(absolutePath)] ?? "");
      return Promise.resolve(bytes.subarray(0, Math.min(bytes.byteLength, maxBytes)));
    },
  };
}

function evalGatewayConfig(): GatewayConfig {
  return {
    providers: [
      {
        modelId: EMBEDDING_MODEL,
        baseUrl: "https://redacted.invalid/v1",
        apiKey: "redacted-eval-key",
        apiKeyHeaderName: "x-api-key",
        timeoutMs: 30_000,
        maxRetries: 0,
        retryBaseDelayMs: 1,
      },
    ],
    capabilities: [
      {
        id: EMBEDDING_MODEL,
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
        throughputHint: "eval",
        preferredUseCases: ["Embeddings"],
        knownLimitations: [],
      },
    ],
    reranker: {
      modelId: RERANK_MODEL,
      baseUrl: "https://redacted.invalid/v1",
      apiKey: "redacted-eval-rerank-key",
      timeoutMs: 30_000,
    },
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
  };
}

interface EmbeddingAudit {
  askPhase: boolean;
  askTimeDocumentEmbeddingCount: number;
  readonly retrievalModeCounts: Map<string, number>;
}

interface EvalRuntime {
  readonly deps: UiHandlerDeps;
  readonly audit: EmbeddingAudit;
}

function evalRuntime(mode: GroundedRetrievalEvalMode): EvalRuntime {
  const config = evalGatewayConfig();
  const env: Record<string, string> = {};
  const audit: EmbeddingAudit = {
    askPhase: false,
    askTimeDocumentEmbeddingCount: 0,
    retrievalModeCounts: new Map(),
  };
  const deps: UiHandlerDeps = {
    config,
    configPresent: true,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env,
    redactor: buildRedactor(env, config),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    localKnowledgeEmbeddingRequest: scriptedEmbeddingPort(mode, audit),
    rerankRequest: scriptedRerankPort(mode),
  };
  return { deps, audit };
}

interface EvalRepositoryPod {
  readonly store: KnowledgeStore;
  readonly fs: WorkspaceFs;
  readonly fingerprintCount: number;
  readonly indexedPathCount: number;
  readonly alignedVectorCount: number;
}

interface StoredEvalVector {
  readonly document_path: string;
  readonly embedding: Uint8Array;
}

function alignedVectorCount(store: KnowledgeStore): number {
  const rows = store._internal.db
    .prepare(
      "SELECT d.document_path, v.embedding FROM vectors v JOIN documents d ON d.id = v.document_id",
    )
    .all() as unknown as readonly StoredEvalVector[];
  return rows.filter((row) => {
    const conceptIndex = CONCEPT_MODEL.findIndex(
      (concept) => concept.scopePath === row.document_path,
    );
    const bytes = row.embedding;
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const vector = new Float32Array(buffer);
    return conceptIndex >= 0 && (vector[conceptIndex] ?? 0) > 0.5;
  }).length;
}

async function seedEvalRepositoryPod(deps: UiHandlerDeps): Promise<EvalRepositoryPod> {
  const provider = evalGatewayConfig().providers[0];
  if (provider === undefined) throw new Error("expected eval embedding provider");
  const store = openKnowledgeStore({ dbPath: ":memory:" });
  const fs = evalWorkspaceFs();
  const embeddingAdapter = localKnowledgeEmbeddingAdapterForProvider(deps, provider);
  const verified = await verifyEmbeddingCapability(embeddingAdapter, {
    modelId: EMBEDDING_MODEL,
    provider: "openai",
    vectorMetric: "cosine",
    expectedDimensions: NUM_DIMS,
    normalization: "l2",
    instructionVersion: EMBEDDING_INSTRUCTION_VERSION,
    includeSpaceFingerprint: true,
  });
  if (!verified.ok) throw new Error(`eval embedding verification failed: ${verified.reason}`);
  createRepositoryPodShell(
    { store, capsuleId: EVAL_CAPSULE_ID, sourceId: EVAL_SOURCE_ID },
    {
      displayName: "Grounded retrieval evaluation",
      repositoryRoot: EVAL_REPOSITORY_ROOT,
      embeddingModelIdentity: verified.identity,
    },
  );
  await refreshRepositoryPod(
    {
      store,
      capsuleId: EVAL_CAPSULE_ID,
      sourceId: EVAL_SOURCE_ID,
      parserRegistry: createDefaultParserRegistry(),
      embeddingAdapter,
      workspaceFs: fs,
      trackedPaths: new Set(CORPUS.map((document) => document.scopePath)),
    },
    { runId: "grounded-retrieval-eval-index" },
  );
  const fingerprints = readRepositoryFileFingerprints(store, EVAL_CAPSULE_ID, EVAL_SOURCE_ID);
  const indexedPaths = new Set(
    listRepositoryChunkLineRanges(store, EVAL_CAPSULE_ID).map((range) => range.relativePath),
  );
  return {
    store,
    fs,
    fingerprintCount: fingerprints.size,
    indexedPathCount: indexedPaths.size,
    alignedVectorCount: alignedVectorCount(store),
  };
}

// ─── Pipeline drive: semantic → RRF → model rerank ────────────────────────────

interface CasePayload {
  readonly scopePath: string;
}

// Cheap lexical-overlap engine score (whole-token intersection). Models the FOLDER (lexical) engine
// that RRF fuses with the semantic engine — deliberately weak here so semantic ranking must carry.
function lexicalScore(query: string, text: string): number {
  const queryTokens = new Set(tokenize(query));
  let overlap = 0;
  for (const token of new Set(tokenize(text))) {
    if (queryTokens.has(token)) overlap += 1;
  }
  return overlap;
}

async function rankCase(
  deps: UiHandlerDeps,
  provider: SemanticSearchProvider,
  evalCase: EvalCase,
): Promise<readonly SelectedCandidate<CasePayload>[]> {
  const matches = await provider.search({
    query: {
      kind: "natural-language",
      text: evalCase.query,
      caseSensitive: false,
      maxResults: CORPUS.length,
      emittedAtMs: 0,
    },
    documents: CORPUS.map((doc) => ({ scopePath: doc.scopePath, text: doc.text })),
  });
  const semanticInputs: readonly RerankInput<CasePayload>[] = matches.map(
    (match): RerankInput<CasePayload> => ({
      kind: "connector",
      redactedText: CORPUS.find((doc) => doc.scopePath === match.scopePath)?.text ?? "",
      engineScore: match.score,
      sourceLabel: match.scopePath,
      tieKey: match.scopePath,
      payload: { scopePath: match.scopePath },
    }),
  );
  const lexicalInputs: readonly RerankInput<CasePayload>[] = CORPUS.map(
    (doc): RerankInput<CasePayload> => ({
      kind: "folder",
      redactedText: doc.text,
      engineScore: lexicalScore(evalCase.query, doc.text),
      sourceLabel: doc.scopePath,
      tieKey: doc.scopePath,
      payload: { scopePath: doc.scopePath },
    }),
  ).filter((input) => input.engineScore > 0);
  const fused = rerankAndSelect([...semanticInputs, ...lexicalInputs], {
    maxCandidates: CORPUS.length,
    maxExcerptBytes: 1_000_000,
  });
  return applyModelRerank(deps, evalCase.query, fused);
}

async function applyModelRerank(
  deps: UiHandlerDeps,
  query: string,
  fused: readonly SelectedCandidate<CasePayload>[],
): Promise<readonly SelectedCandidate<CasePayload>[]> {
  const result = await rerankSelection({
    deps,
    query,
    candidates: fused,
    documentFor: (candidate) => candidate.redactedText,
    topN: TOP_N,
    applyScore: withModelRerankScore,
    fallbackMode: "slice-topN",
  });
  return withFinalMarkers(result.selected);
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

export interface GroundedRetrievalScorecard {
  readonly mode: GroundedRetrievalEvalMode;
  readonly semanticProviderName: string;
  readonly askTimeDocumentEmbeddingCount: number;
  readonly fingerprintCount: number;
  readonly indexedPathCount: number;
  readonly alignedVectorCount: number;
  readonly retrievalModeCounts: Readonly<Record<string, number>>;
  readonly cases: number;
  readonly top1Rate: number;
  readonly recallAtK: number;
  readonly ndcgAtK: number;
  readonly citationSupport: number;
  readonly failedCases: readonly string[];
}

function rankedPaths(candidates: readonly SelectedCandidate<CasePayload>[]): readonly string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const candidate of candidates) {
    const path = candidate.payload.scopePath;
    if (!seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

function ndcgAtK(paths: readonly string[], relevantPath: string, k: number): number {
  const index = paths.slice(0, k).indexOf(relevantPath);
  return index < 0 ? 0 : 1 / Math.log2(index + 2);
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function observeEvalRetrieval(
  audit: EmbeddingAudit,
): (observation: RepositoryPodRetrievalObservation) => void {
  return ({ mode, denseCandidateCount, lexicalCandidateCount, lexicalOrFallbackUsed }): void => {
    const key = `${mode}:d${String(denseCandidateCount)}:l${String(
      lexicalCandidateCount,
    )}:f${lexicalOrFallbackUsed ? "1" : "0"}`;
    audit.retrievalModeCounts.set(key, (audit.retrievalModeCounts.get(key) ?? 0) + 1);
  };
}

export async function runGroundedRetrievalQualityEval(
  mode: GroundedRetrievalEvalMode = "baseline",
): Promise<GroundedRetrievalScorecard> {
  const runtime = evalRuntime(mode);
  const { deps } = runtime;
  const pod = await seedEvalRepositoryPod(deps);
  try {
    const provider = configuredRepoSemanticSearchProviderFor(deps, undefined, {
      fs: pod.fs,
      maxCandidates: CORPUS.length,
      repositoryPod: { store: pod.store, repositoryRoot: EVAL_REPOSITORY_ROOT },
      observePodRetrieval: observeEvalRetrieval(runtime.audit),
    });
    if (provider === undefined) throw new Error("expected a configured semantic search provider");
    runtime.audit.askPhase = true;
    const perCase = await Promise.all(
      CASES.map(async (evalCase) => {
        const paths = rankedPaths(await rankCase(deps, provider, evalCase));
        const top1 = paths[0] === evalCase.relevantPath ? 1 : 0;
        const recall = paths.slice(0, EVAL_K).includes(evalCase.relevantPath) ? 1 : 0;
        return {
          id: evalCase.id,
          top1,
          recall,
          ndcg: ndcgAtK(paths, evalCase.relevantPath, EVAL_K),
          citationSupport: top1,
        };
      }),
    );
    return {
      ...scorecardFor(mode, perCase),
      semanticProviderName: provider.name,
      askTimeDocumentEmbeddingCount: runtime.audit.askTimeDocumentEmbeddingCount,
      fingerprintCount: pod.fingerprintCount,
      indexedPathCount: pod.indexedPathCount,
      alignedVectorCount: pod.alignedVectorCount,
      retrievalModeCounts: Object.fromEntries(runtime.audit.retrievalModeCounts),
    };
  } finally {
    pod.store.close();
    deps.store.close();
  }
}

interface EvalCaseScore {
  readonly id: string;
  readonly top1: number;
  readonly recall: number;
  readonly ndcg: number;
  readonly citationSupport: number;
}

function scorecardFor(
  mode: GroundedRetrievalEvalMode,
  perCase: readonly EvalCaseScore[],
): Omit<
  GroundedRetrievalScorecard,
  | "semanticProviderName"
  | "askTimeDocumentEmbeddingCount"
  | "fingerprintCount"
  | "indexedPathCount"
  | "alignedVectorCount"
  | "retrievalModeCounts"
> {
  return {
    mode,
    cases: perCase.length,
    top1Rate: average(perCase.map((item) => item.top1)),
    recallAtK: average(perCase.map((item) => item.recall)),
    ndcgAtK: average(perCase.map((item) => item.ndcg)),
    citationSupport: average(perCase.map((item) => item.citationSupport)),
    failedCases: perCase.filter((item) => item.top1 === 0).map((item) => item.id),
  };
}

// ─── Budget evaluation ────────────────────────────────────────────────────────

type GroundedRetrievalBudgetMetric =
  "minTop1Rate" | "minRecallAtK" | "minNdcgAtK" | "minCitationSupport";

export type GroundedRetrievalBudget = EvalBudget<GroundedRetrievalBudgetMetric>;

type GroundedRetrievalMetric = "top1Rate" | "recallAtK" | "ndcgAtK" | "citationSupport";

// NON-TAUTOLOGICAL floors: all < 1. The baseline pipeline clears them; the injected regressions do
// not (proven by grounded-retrieval-eval.test.ts and the check:grounded-retrieval-quality gate).
export const DEFAULT_GROUNDED_RETRIEVAL_BUDGET: GroundedRetrievalBudget = {
  minTop1Rate: 0.8,
  minRecallAtK: 0.9,
  minNdcgAtK: 0.85,
  minCitationSupport: 0.8,
};

export function evaluateGroundedRetrievalBudget(
  scorecard: GroundedRetrievalScorecard,
  budget: GroundedRetrievalBudget = DEFAULT_GROUNDED_RETRIEVAL_BUDGET,
): EvalFloorResult<GroundedRetrievalMetric> {
  const failures: GroundedRetrievalMetric[] = [];
  if (scorecard.top1Rate < budget.minTop1Rate) failures.push("top1Rate");
  if (scorecard.recallAtK < budget.minRecallAtK) failures.push("recallAtK");
  if (scorecard.ndcgAtK < budget.minNdcgAtK) failures.push("ndcgAtK");
  if (scorecard.citationSupport < budget.minCitationSupport) failures.push("citationSupport");
  return { ok: failures.length === 0, failures };
}

export const GROUNDED_RETRIEVAL_REGRESSION_MODES: readonly GroundedRetrievalEvalMode[] = [
  "reranker-reversed",
  "embedding-flat",
];
