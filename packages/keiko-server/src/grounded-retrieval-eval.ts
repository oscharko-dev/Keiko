// Production semantic-retrieval + RRF-fusion + model-reranker eval harness (RB-5,
// GEN-AI-RELEASE-GATE-001 / GEN-AI-RETRIEVAL-006 / GEN-TEST-FIXTURE-002).
//
// `check:retrieval-quality` covers workspace search and Local Knowledge fixture scorecards. This
// harness covers the production semantic + reranker + RRF path by driving the REAL functions
// end-to-end over a distractor-dense corpus:
//
//   1. `configuredRepoSemanticSearchProviderFor` (grounded-repo-semantic-search) with a scripted but
//      SEMANTIC embedding port (topic vectors, not lexical overlap), so a paraphrased query matches
//      the right file WITHOUT sharing its words.
//   2. `rerankAndSelect` (grounded-rerank) — the real RRF fusion of the lexical + semantic engines.
//   3. `requestConfiguredRerank` + `applyModelRerankResults` (grounded-model-reranker) — the real
//      model-reranker gate with a scripted rerank port.
//
// Non-tautological by construction: the budget floors are < 1, and an injected ranking or reranker
// regression (`reranker-reversed`, `embedding-flat`) provably drops the metrics BELOW the floors —
// so the gate turns red on a real regression in this grounded-answer path.

import type {
  GatewayConfig,
  OpenAIEmbeddingOutcome,
  OpenAIEmbeddingRequest,
  RerankOutcome,
  LiteLLMRerankRequest,
} from "@oscharko-dev/keiko-model-gateway";
import type { WorkspaceFs, WorkspaceDirEntry } from "@oscharko-dev/keiko-workspace";

import type { UiHandlerDeps } from "./deps.js";
import { buildRedactor } from "./deps.js";
import { createRunRegistry } from "./runs.js";
import { createInMemoryUiStore } from "./store/index.js";
import { configuredRepoSemanticSearchProviderFor } from "./grounded-repo-semantic-search.js";
import {
  applyModelRerankResults,
  rerankAndSelect,
  selectTopPromptCandidates,
  type RerankInput,
  type SelectedCandidate,
} from "./grounded-rerank.js";
import { requestConfiguredRerank } from "./grounded-model-reranker.js";

const EMBEDDING_MODEL = "eval-embedding";
const RERANK_MODEL = "eval-reranker";
const EVAL_K = 3;
const TOP_N = 4;

export type GroundedRetrievalEvalMode =
  "baseline" | "reranker-off" | "reranker-reversed" | "embedding-flat";

// ─── Concept (semantic) embedding ─────────────────────────────────────────────
// Per concept: a scopePath, plus DISJOINT document vs query vocabularies. A document and its query
// share NO literal words except the weak shared `service` token — so lexical overlap can never
// discriminate the target from the distractors, and ONLY the semantic concept vector can. This is
// what makes the harness a genuine SEMANTIC retrieval test rather than a lexical substring test.

interface ConceptModel {
  readonly id: string;
  readonly scopePath: string;
  readonly docWords: readonly string[];
  readonly queryWords: readonly string[];
}

const SYSTEM_WORD = "service";

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
  map.set(SYSTEM_WORD, SYSTEM_DIM);
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
// carries the shared `service` token, so all ten are returned for EVERY query with a non-zero cosine
// — a genuine distractor-dense set where RANKING (not presence) decides the winner.
const CORPUS: readonly EvalDocument[] = CONCEPT_MODEL.map((concept) => ({
  scopePath: concept.scopePath,
  text: `${SYSTEM_WORD} ${concept.docWords.join(" ")}`,
}));

const CASES: readonly EvalCase[] = CONCEPT_MODEL.map((concept) => ({
  id: concept.id,
  query: `In the ${SYSTEM_WORD}, which module handles ${concept.queryWords.join(" ")}?`,
  relevantPath: concept.scopePath,
}));

// ─── Scripted ports (embedding + reranker), regression-aware ──────────────────

function scriptedEmbeddingPort(
  mode: GroundedRetrievalEvalMode,
): (request: OpenAIEmbeddingRequest) => Promise<OpenAIEmbeddingOutcome> {
  return (request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> => {
    // `embedding-flat`: a broken embedding that maps everything to the same vector. Semantic ranking
    // collapses to arbitrary tie-breaks, so retrieval can no longer surface the relevant document.
    const vector =
      mode === "embedding-flat"
        ? new Float32Array(NUM_DIMS).fill(1 / Math.sqrt(NUM_DIMS))
        : conceptVector(request.input);
    return Promise.resolve({ ok: true, value: { vector, modelId: request.modelId } });
  };
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
    // `reranker-reversed`: a defective reranker that returns worst-first. applyModelRerankResults
    // trusts the order, so the least-relevant candidate is promoted to the top.
    const results = mode === "reranker-reversed" ? [...scored].reverse() : scored;
    return Promise.resolve({ ok: true, value: { modelId: RERANK_MODEL, results } });
  };
}

// ─── Deps construction (in-memory) ────────────────────────────────────────────

function inMemoryFs(): WorkspaceFs {
  const empty = new Uint8Array(0);
  const dir = (): WorkspaceDirEntry[] => [];
  return {
    readFileUtf8: () => "",
    stat: () => ({ size: 0, isFile: false, isDirectory: true, isSymbolicLink: false }),
    readDir: dir,
    realPath: (abs: string): string => abs,
    exists: (): boolean => true,
    readFileBytes: (): Promise<Uint8Array> => Promise.resolve(empty),
  };
}

function evalGatewayConfig(): GatewayConfig {
  return {
    providers: [
      {
        modelId: EMBEDDING_MODEL,
        baseUrl: "https://eval.embedding.local/v1",
        apiKey: "eval-embedding-key",
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
      baseUrl: "https://eval.reranker.local/v1",
      apiKey: "eval-reranker-key",
      timeoutMs: 30_000,
    },
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
  };
}

function evalDeps(mode: GroundedRetrievalEvalMode): UiHandlerDeps {
  const config = evalGatewayConfig();
  const env: Record<string, string> = {};
  return {
    config,
    configPresent: true,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env,
    redactor: buildRedactor(env, config),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    localKnowledgeEmbeddingRequest: scriptedEmbeddingPort(mode),
    rerankRequest: scriptedRerankPort(mode),
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
  evalCase: EvalCase,
): Promise<readonly SelectedCandidate<CasePayload>[]> {
  const provider = configuredRepoSemanticSearchProviderFor(deps, undefined, {
    fs: inMemoryFs(),
    maxCandidates: CORPUS.length,
  });
  if (provider === undefined) {
    throw new Error("expected a configured semantic search provider");
  }
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
  const attempt = await requestConfiguredRerank({
    deps,
    query,
    documents: fused.map((candidate) => candidate.redactedText),
    topN: TOP_N,
  });
  if (attempt.outcome === undefined) {
    return selectTopPromptCandidates(fused, TOP_N);
  }
  const reranked = applyModelRerankResults(fused, attempt.outcome.value.results, TOP_N);
  return reranked ?? selectTopPromptCandidates(fused, TOP_N);
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

export interface GroundedRetrievalScorecard {
  readonly mode: GroundedRetrievalEvalMode;
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

export async function runGroundedRetrievalQualityEval(
  mode: GroundedRetrievalEvalMode = "baseline",
): Promise<GroundedRetrievalScorecard> {
  const deps = evalDeps(mode);
  const perCase = await Promise.all(
    CASES.map(async (evalCase) => {
      const paths = rankedPaths(await rankCase(deps, evalCase));
      const top1 = paths[0] === evalCase.relevantPath ? 1 : 0;
      const recall = paths.slice(0, EVAL_K).includes(evalCase.relevantPath) ? 1 : 0;
      return {
        id: evalCase.id,
        top1,
        recall,
        ndcg: ndcgAtK(paths, evalCase.relevantPath, EVAL_K),
        // Citation-support: the answer would cite the top-ranked evidence, so support == top1 here.
        citationSupport: top1,
      };
    }),
  );
  return {
    mode,
    cases: perCase.length,
    top1Rate: average(perCase.map((c) => c.top1)),
    recallAtK: average(perCase.map((c) => c.recall)),
    ndcgAtK: average(perCase.map((c) => c.ndcg)),
    citationSupport: average(perCase.map((c) => c.citationSupport)),
    failedCases: perCase.filter((c) => c.top1 === 0).map((c) => c.id),
  };
}

// ─── Budget evaluation ────────────────────────────────────────────────────────

export interface GroundedRetrievalBudget {
  readonly minTop1Rate: number;
  readonly minRecallAtK: number;
  readonly minNdcgAtK: number;
  readonly minCitationSupport: number;
}

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
): { readonly ok: boolean; readonly failures: readonly string[] } {
  const failures: string[] = [];
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
