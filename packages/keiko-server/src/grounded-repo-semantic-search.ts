import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

import {
  maxUtf8BytesForTokenBudget,
  stripUnsafeFormatChars,
  type KnowledgeCapsule,
  type KnowledgeSource,
  type RetrievalReference,
} from "@oscharko-dev/keiko-contracts";
import {
  listCapsuleSources,
  listCapsules,
  listRepositoryChunkLineRanges,
  readRepositoryFileFingerprints,
  searchVectorsForScope,
  type KnowledgeStore,
  type RepositoryChunkLineRange,
  type RepositoryFileFingerprint,
  type VectorIndexOptions,
} from "@oscharko-dev/keiko-local-knowledge";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import {
  requestOpenAIEmbedding,
  requestOpenAIEmbeddingBatch,
  type ModelProviderConfig,
  type OpenAIEmbeddingAdapter,
  type OpenAIEmbeddingBatchOutcome,
  type OpenAIEmbeddingBatchRequest,
  type OpenAIEmbeddingOutcome,
  type OpenAIEmbeddingRequest,
} from "@oscharko-dev/keiko-model-gateway";
import {
  type SemanticSearchInput,
  type SemanticSearchMatch,
  type SemanticSearchProvider,
  type WorkspaceFs,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { currentGatewayConfig, currentGatewayEgressConfig, type UiHandlerDeps } from "./deps.js";
import {
  configuredEmbeddingProviders,
  localKnowledgeEmbeddingAdapterForProvider,
} from "./local-knowledge-handlers.js";
import { openKnowledgeStoreForDeps } from "./local-knowledge-store-open.js";

const MAX_SEMANTIC_CANDIDATES = 32;
const SEMANTIC_CANDIDATE_RESULT_MULTIPLIER = 4;
const SEMANTIC_EXCERPT_BYTES = 16_384;
export const SEMANTIC_VECTOR_CACHE_SCHEMA_VERSION = 2;
const EMBEDDING_INPUT_SAFETY_TOKENS = 16;
const POD_EMBEDDING_CACHE_MAX = 64;

interface ProviderCredentials {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly apiKeyHeaderName?: string;
  readonly egress?: NonNullable<ModelProviderConfig["egress"]>;
  readonly timeoutMs: number;
  // GEN-AI-GATEWAY-002 (RB-4): forward Azure deployment routing to the embedding adapter so an
  // Azure-configured embedding provider is dispatched to its deployment URL, not silently misrouted.
  readonly endpointStyle?: ModelProviderConfig["endpointStyle"];
  readonly apiVersion?: string;
}

interface EmbeddingContext {
  readonly deps: UiHandlerDeps;
  readonly provider: ModelProviderConfig;
  readonly credentials: ProviderCredentials;
  readonly request: (request: OpenAIEmbeddingRequest) => Promise<OpenAIEmbeddingOutcome>;
  readonly batchRequest?:
    ((request: OpenAIEmbeddingBatchRequest) => Promise<OpenAIEmbeddingBatchOutcome>) | undefined;
  readonly fs: WorkspaceFs;
  readonly signal?: AbortSignal | undefined;
  readonly maxCandidates: number;
  readonly maxEmbeddingInputBytes: number;
  readonly documentVectorCache: Map<string, Float32Array>;
  readonly localKnowledgeEmbeddingAdapter: OpenAIEmbeddingAdapter;
  readonly podEmbeddingVectorCache: Map<string, Float32Array>;
  readonly repositoryPod: RepositoryPodResolution;
  readonly observePodRetrieval?:
    ((observation: RepositoryPodRetrievalObservation) => void) | undefined;
}

interface CandidateDocument {
  readonly scopePath: string;
  readonly text: string;
  // GEN-AI-GROUNDING-006 (RB-4): the ORIGINAL (pre-embedding-normalization, un-prefixed) source text
  // is kept so a whole-file semantic hit can be localized to the matched passage's line rather than
  // emitting a fixed line:1 the citation layer would trust.
  readonly sourceText: string;
  readonly order: number;
}

interface ResolvedRepositoryPod {
  readonly context: RepositoryPodSemanticSearchContext;
  readonly capsule: KnowledgeCapsule;
  readonly source: KnowledgeSource;
  readonly fingerprints: ReadonlyMap<string, RepositoryFileFingerprint>;
  readonly lineRangeByChunk: ReadonlyMap<string, RepositoryChunkLineRange>;
  readonly indexedPaths: ReadonlySet<string>;
}

type RepositoryPodResolution =
  | { readonly kind: "absent" }
  | { readonly kind: "failed" }
  | { readonly kind: "ready"; readonly pod: ResolvedRepositoryPod };

export interface ConfiguredRepoSemanticSearchOptions {
  readonly fs?: WorkspaceFs | undefined;
  readonly maxCandidates?: number | undefined;
  readonly repositoryPod?: RepositoryPodSemanticSearchContext | undefined;
  readonly observePodRetrieval?:
    ((observation: RepositoryPodRetrievalObservation) => void) | undefined;
}

export interface RepositoryPodRetrievalObservation {
  readonly mode: string;
  readonly referenceCount: number;
  readonly denseCandidateCount: number;
  readonly lexicalCandidateCount: number;
  readonly lexicalOrFallbackUsed: boolean;
}

export interface RepositoryPodSemanticSearchContext {
  readonly store: KnowledgeStore;
  readonly repositoryRoot: string;
  readonly vectorIndex?: VectorIndexOptions | undefined;
}

export interface ConfiguredRepoSemanticSearchProviderLease {
  readonly provider: SemanticSearchProvider | undefined;
  close(): void;
}

function canonicalRoot(fs: WorkspaceFs, root: string): string {
  try {
    return fs.realPath(root);
  } catch {
    return resolve(root);
  }
}

function matchingRepositorySources(
  store: KnowledgeStore,
  fs: WorkspaceFs,
  repositoryRoot: string,
  modelId: string,
): readonly { readonly capsule: KnowledgeCapsule; readonly source: KnowledgeSource }[] {
  const expectedRoot = canonicalRoot(fs, repositoryRoot);
  const matches: { capsule: KnowledgeCapsule; source: KnowledgeSource }[] = [];
  for (const capsule of listCapsules(store)) {
    if (capsule.embeddingModelIdentity.modelId !== modelId) continue;
    for (const source of listCapsuleSources(store, capsule.id)) {
      if (
        source.scope.kind === "repository" &&
        canonicalRoot(fs, source.scope.repositoryRoot) === expectedRoot
      ) {
        matches.push({ capsule, source });
      }
    }
  }
  return matches.sort(
    (left, right) =>
      String(left.capsule.id).localeCompare(String(right.capsule.id)) ||
      String(left.source.id).localeCompare(String(right.source.id)),
  );
}

function resolveRepositoryPod(
  context: RepositoryPodSemanticSearchContext | undefined,
  fs: WorkspaceFs,
  modelId: string,
): RepositoryPodResolution {
  if (context === undefined) return { kind: "absent" };
  try {
    const match = matchingRepositorySources(context.store, fs, context.repositoryRoot, modelId)[0];
    if (match === undefined) return { kind: "absent" };
    const fingerprints = readRepositoryFileFingerprints(
      context.store,
      match.capsule.id,
      match.source.id,
    );
    const lineRanges = listRepositoryChunkLineRanges(context.store, match.capsule.id);
    return {
      kind: "ready",
      pod: {
        context,
        capsule: match.capsule,
        source: match.source,
        fingerprints,
        lineRangeByChunk: new Map(lineRanges.map((range) => [String(range.chunkId), range])),
        indexedPaths: new Set(lineRanges.map((range) => range.relativePath)),
      },
    };
  } catch {
    return { kind: "failed" };
  }
}

function requestEmbeddingImpl(
  deps: UiHandlerDeps,
): (request: OpenAIEmbeddingRequest) => Promise<OpenAIEmbeddingOutcome> {
  return deps.localKnowledgeEmbeddingRequest ?? requestOpenAIEmbedding;
}

function requestEmbeddingBatchImpl(
  deps: UiHandlerDeps,
): ((request: OpenAIEmbeddingBatchRequest) => Promise<OpenAIEmbeddingBatchOutcome>) | undefined {
  if (deps.localKnowledgeEmbeddingRequest !== undefined) {
    return deps.localKnowledgeEmbeddingBatchRequest;
  }
  return requestOpenAIEmbeddingBatch;
}

function podEmbeddingCacheKey(modelId: string, input: string): string {
  return `${modelId}\0${input}`;
}

function trackedLocalKnowledgeEmbeddingAdapter(
  deps: UiHandlerDeps,
  provider: ModelProviderConfig,
  cache: Map<string, Float32Array>,
): OpenAIEmbeddingAdapter {
  const adapter = localKnowledgeEmbeddingAdapterForProvider(deps, provider);
  return {
    ...adapter,
    request: async (request): Promise<OpenAIEmbeddingOutcome> => {
      const outcome = await adapter.request(request);
      if (outcome.ok) {
        if (cache.size >= POD_EMBEDDING_CACHE_MAX) cache.clear();
        cache.set(podEmbeddingCacheKey(request.modelId, request.input), outcome.value.vector);
      }
      return outcome;
    },
  };
}

function providerCredentials(
  provider: ModelProviderConfig,
  fallbackEgress: ModelProviderConfig["egress"],
): ProviderCredentials {
  const egress = provider.egress ?? fallbackEgress;
  return {
    endpoint: provider.baseUrl,
    apiKey: provider.apiKey,
    timeoutMs: provider.timeoutMs,
    ...(provider.apiKeyHeaderName !== undefined
      ? { apiKeyHeaderName: provider.apiKeyHeaderName }
      : {}),
    ...(egress !== undefined ? { egress } : {}),
    ...(provider.endpointStyle !== undefined ? { endpointStyle: provider.endpointStyle } : {}),
    ...(provider.apiVersion !== undefined ? { apiVersion: provider.apiVersion } : {}),
  };
}

function candidateLimit(request: SemanticSearchInput, configuredLimit: number): number {
  return Math.max(
    0,
    Math.min(
      request.documents.length,
      configuredLimit,
      Math.max(
        request.query.maxResults,
        request.query.maxResults * SEMANTIC_CANDIDATE_RESULT_MULTIPLIER,
      ),
    ),
  );
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function clampUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  const encoded = new TextEncoder().encode(value);
  if (encoded.length <= maxBytes) {
    return value;
  }
  return new TextDecoder("utf-8", { fatal: false })
    .decode(encoded.subarray(0, maxBytes))
    .replace(/\uFFFD$/u, "");
}

function embeddingText(ctx: EmbeddingContext, value: string): string {
  const safe = stripUnsafeFormatChars(value);
  const redacted = ctx.deps.redactor(safe);
  return clampUtf8(typeof redacted === "string" ? redacted : safe, ctx.maxEmbeddingInputBytes);
}

function embeddingInputByteLimit(
  config: ReturnType<typeof currentGatewayConfig>,
  provider: ModelProviderConfig,
): number {
  const capability = config?.capabilities?.find(
    (candidate) => candidate.id === provider.modelId && candidate.kind === "embedding",
  );
  if (capability === undefined || capability.contextWindow <= 0) {
    return SEMANTIC_EXCERPT_BYTES;
  }
  return maxUtf8BytesForTokenBudget(
    Math.max(0, capability.contextWindow - EMBEDDING_INPUT_SAFETY_TOKENS),
  );
}

export function semanticVectorCacheKeyFor(
  schemaVersion: number,
  providerEndpoint: string,
  modelId: string,
  scopePath: string,
  text: string,
): string {
  return sha256Hex(
    JSON.stringify({
      schemaVersion,
      providerEndpoint,
      modelId,
      scopePath,
      textHash: sha256Hex(text),
    }),
  );
}

function semanticCacheKey(ctx: EmbeddingContext, document: CandidateDocument): string {
  return semanticVectorCacheKeyFor(
    SEMANTIC_VECTOR_CACHE_SCHEMA_VERSION,
    ctx.provider.baseUrl,
    ctx.provider.modelId,
    document.scopePath,
    document.text,
  );
}

function cachedDocumentVector(
  ctx: EmbeddingContext,
  document: CandidateDocument,
): { readonly key: string; readonly vector?: Float32Array | undefined } {
  const key = semanticCacheKey(ctx, document);
  const memory = ctx.documentVectorCache.get(key);
  if (memory !== undefined) {
    return { key, vector: memory };
  }
  return { key };
}

async function embedOne(
  ctx: EmbeddingContext,
  input: string,
  signal: AbortSignal | undefined,
): Promise<Float32Array | undefined> {
  try {
    const outcome = await ctx.request({
      ...ctx.credentials,
      modelId: ctx.provider.modelId,
      input,
      ...(signal !== undefined ? { signal } : {}),
    });
    return outcome.ok ? outcome.value.vector : undefined;
  } catch {
    return undefined;
  }
}

async function embedBatch(
  ctx: EmbeddingContext,
  inputs: readonly string[],
  signal: AbortSignal | undefined,
): Promise<readonly (Float32Array | undefined)[] | undefined> {
  if (ctx.batchRequest === undefined || inputs.length === 0) {
    return undefined;
  }
  try {
    const outcome = await ctx.batchRequest({
      ...ctx.credentials,
      modelId: ctx.provider.modelId,
      inputs,
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!outcome.ok || outcome.value.length !== inputs.length) {
      return undefined;
    }
    return outcome.value.map((value) => value.vector);
  } catch {
    return undefined;
  }
}

async function embedDocuments(
  ctx: EmbeddingContext,
  documents: readonly CandidateDocument[],
  signal: AbortSignal | undefined,
): Promise<readonly (Float32Array | undefined)[]> {
  const vectors = new Array<Float32Array | undefined>(documents.length).fill(undefined);
  const missingDocuments: CandidateDocument[] = [];
  const missingKeys: string[] = [];
  const missingIndexes: number[] = [];
  for (let index = 0; index < documents.length; index += 1) {
    const document = documents[index];
    if (document === undefined) {
      continue;
    }
    const cached = cachedDocumentVector(ctx, document);
    if (cached.vector !== undefined) {
      vectors[index] = cached.vector;
      continue;
    }
    missingDocuments.push(document);
    missingKeys.push(cached.key);
    missingIndexes.push(index);
  }
  const embedded = await embedDocumentMisses(ctx, missingDocuments, signal);
  for (let index = 0; index < embedded.length; index += 1) {
    const vector = embedded[index];
    const originalIndex = missingIndexes[index];
    const key = missingKeys[index];
    if (vector === undefined || originalIndex === undefined || key === undefined) {
      continue;
    }
    ctx.documentVectorCache.set(key, vector);
    vectors[originalIndex] = vector;
  }
  return vectors;
}

async function embedDocumentMisses(
  ctx: EmbeddingContext,
  documents: readonly CandidateDocument[],
  signal: AbortSignal | undefined,
): Promise<readonly (Float32Array | undefined)[]> {
  const batch = await embedBatch(
    ctx,
    documents.map((document) => document.text),
    signal,
  );
  if (batch !== undefined) {
    return batch;
  }
  const vectors: (Float32Array | undefined)[] = [];
  for (const document of documents) {
    if (isAborted(signal)) {
      break;
    }
    vectors.push(await embedOne(ctx, document.text, signal));
  }
  return vectors;
}

function cosineScore(a: Float32Array, b: Float32Array): number | undefined {
  if (a.length === 0 || a.length !== b.length) {
    return undefined;
  }
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let index = 0; index < a.length; index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    dot += av * bv;
    aNorm += av * av;
    bNorm += bv * bv;
  }
  if (aNorm <= 0 || bNorm <= 0) {
    return undefined;
  }
  return Math.max(0, dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm)));
}

function hitOrderMap(documents: readonly CandidateDocument[]): ReadonlyMap<string, number> {
  return new Map(documents.map((document) => [document.scopePath, document.order]));
}

function compareHits(
  orderByPath: ReadonlyMap<string, number>,
  a: SemanticSearchMatch,
  b: SemanticSearchMatch,
): number {
  const scoreDelta = b.score - a.score;
  if (scoreDelta !== 0) return scoreDelta;
  return (
    (orderByPath.get(a.scopePath) ?? 0) - (orderByPath.get(b.scopePath) ?? 0) ||
    a.scopePath.localeCompare(b.scopePath)
  );
}

function rankHits(
  hits: readonly SemanticSearchMatch[],
  documents: readonly CandidateDocument[],
  maxResults: number,
): readonly SemanticSearchMatch[] {
  const orderByPath = hitOrderMap(documents);
  return [...hits].sort((a, b) => compareHits(orderByPath, a, b)).slice(0, maxResults);
}

// GEN-AI-GROUNDING-006 (RB-4): a whole-file embedding hit carries no line span. Rather than emit a
// fixed line:1 the citation layer trusts, run a cheap deterministic second-pass localization: pick
// the source line that shares the most distinct query terms. Falls back to line 1 only when no line
// overlaps any query term (or the query has no usable terms).
const LOCALIZE_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "which",
  "what",
  "where",
  "does",
  "this",
  "that",
  "from",
  "into",
  "how",
  "are",
  "was",
  "use",
  "uses",
]);

function localizeQueryTerms(queryText: string): readonly string[] {
  const terms = new Set<string>();
  for (const raw of queryText.toLowerCase().split(/[^a-z0-9_./]+/u)) {
    if (raw.length >= 3 && !LOCALIZE_STOPWORDS.has(raw)) {
      terms.add(raw);
    }
  }
  return [...terms];
}

export function localizeMatchLine(sourceText: string, queryTerms: readonly string[]): number {
  if (queryTerms.length === 0 || sourceText.length === 0) {
    return 1;
  }
  const lines = sourceText.split("\n");
  let bestLine = 1;
  let bestScore = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const lower = (lines[index] ?? "").toLowerCase();
    if (lower.trim().length === 0) {
      continue;
    }
    let matched = 0;
    for (const term of queryTerms) {
      if (lower.includes(term)) {
        matched += 1;
      }
    }
    if (matched > bestScore) {
      bestScore = matched;
      bestLine = index + 1;
    }
  }
  return bestLine;
}

function hitForDocument(
  document: CandidateDocument,
  vector: Float32Array | undefined,
  queryVector: Float32Array,
  queryTerms: readonly string[],
): SemanticSearchMatch | undefined {
  if (vector === undefined) {
    return undefined;
  }
  const score = cosineScore(queryVector, vector);
  if (score === undefined || score <= 0) {
    return undefined;
  }
  return {
    scopePath: document.scopePath,
    line: localizeMatchLine(document.sourceText, queryTerms),
    score,
  };
}

function hitsFromVectors(
  documents: readonly CandidateDocument[],
  vectors: readonly (Float32Array | undefined)[],
  queryVector: Float32Array,
  queryTerms: readonly string[],
): readonly SemanticSearchMatch[] {
  const hits: SemanticSearchMatch[] = [];
  for (let index = 0; index < documents.length; index += 1) {
    const document = documents[index];
    if (document === undefined) {
      continue;
    }
    const hit = hitForDocument(document, vectors[index], queryVector, queryTerms);
    if (hit !== undefined) {
      hits.push(hit);
    }
  }
  return hits;
}

function candidateDocuments(
  ctx: EmbeddingContext,
  request: SemanticSearchInput,
  signal: AbortSignal | undefined,
): readonly CandidateDocument[] {
  const limit = candidateLimit(request, ctx.maxCandidates);
  const documents: CandidateDocument[] = [];
  for (let index = 0; index < limit; index += 1) {
    const source = request.documents[index];
    if (source === undefined || isAborted(signal)) {
      break;
    }
    const text = embeddingText(ctx, `Path: ${source.scopePath}\n${source.text}`).trim();
    if (text.length > 0) {
      documents.push({ scopePath: source.scopePath, text, sourceText: source.text, order: index });
    }
  }
  return documents;
}

function containedDocumentPath(repositoryRoot: string, scopePath: string): string | undefined {
  const root = resolve(repositoryRoot);
  const candidate = resolve(root, scopePath);
  const fromRoot = relative(root, candidate);
  if (fromRoot.length === 0 || fromRoot.startsWith("..") || isAbsolute(fromRoot)) return undefined;
  return candidate;
}

function gitBlobFingerprint(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return createHash("sha1")
    .update(`blob ${String(bytes.byteLength)}\0`, "utf8")
    .update(bytes)
    .digest("hex");
}

function gitFingerprintIsFresh(
  document: CandidateDocument,
  fingerprint: RepositoryFileFingerprint,
): boolean {
  return (
    new TextEncoder().encode(document.sourceText).byteLength === fingerprint.byteLength &&
    gitBlobFingerprint(document.sourceText) === fingerprint.contentFingerprint
  );
}

function fileStateFingerprintIsFresh(
  ctx: EmbeddingContext,
  pod: ResolvedRepositoryPod,
  document: CandidateDocument,
  fingerprint: RepositoryFileFingerprint,
): boolean {
  const absolutePath = containedDocumentPath(pod.context.repositoryRoot, document.scopePath);
  if (absolutePath === undefined) return false;
  try {
    const stat = ctx.fs.stat(absolutePath);
    return (
      stat.isFile &&
      !stat.isSymbolicLink &&
      stat.size === fingerprint.byteLength &&
      stat.mtimeMs === fingerprint.mtimeMs
    );
  } catch {
    return false;
  }
}

function podDocumentIsFresh(
  ctx: EmbeddingContext,
  pod: ResolvedRepositoryPod,
  document: CandidateDocument,
): boolean {
  if (!pod.indexedPaths.has(document.scopePath)) return false;
  const fingerprint = pod.fingerprints.get(document.scopePath);
  if (fingerprint === undefined) return false;
  return fingerprint.fingerprintKind === "git-blob-sha1"
    ? gitFingerprintIsFresh(document, fingerprint)
    : fileStateFingerprintIsFresh(ctx, pod, document, fingerprint);
}

interface PodDocumentPartition {
  readonly indexed: readonly CandidateDocument[];
  readonly fallback: readonly CandidateDocument[];
}

function partitionPodDocuments(
  ctx: EmbeddingContext,
  pod: ResolvedRepositoryPod,
  documents: readonly CandidateDocument[],
): PodDocumentPartition {
  const indexed: CandidateDocument[] = [];
  const fallback: CandidateDocument[] = [];
  for (const document of documents) {
    (podDocumentIsFresh(ctx, pod, document) ? indexed : fallback).push(document);
  }
  return { indexed, fallback };
}

async function legacyHits(
  ctx: EmbeddingContext,
  documents: readonly CandidateDocument[],
  queryText: string,
  queryTerms: readonly string[],
  signal: AbortSignal | undefined,
  sharedQueryVector?: Float32Array,
): Promise<readonly SemanticSearchMatch[]> {
  if (documents.length === 0) return [];
  const queryVector = sharedQueryVector ?? (await embedOne(ctx, queryText, signal));
  if (queryVector === undefined || isAborted(signal)) return [];
  const vectors = await embedDocuments(ctx, documents, signal);
  return hitsFromVectors(documents, vectors, queryVector, queryTerms);
}

async function legacyRankedHits(
  ctx: EmbeddingContext,
  documents: readonly CandidateDocument[],
  queryText: string,
  queryTerms: readonly string[],
  signal: AbortSignal | undefined,
  maxResults: number,
): Promise<readonly SemanticSearchMatch[]> {
  return rankHits(
    await legacyHits(ctx, documents, queryText, queryTerms, signal),
    documents,
    maxResults,
  );
}

function chunkAnchoredLine(
  document: CandidateDocument,
  range: RepositoryChunkLineRange,
  queryTerms: readonly string[],
): number {
  const chunkText = document.sourceText
    .split("\n")
    .slice(range.startLine - 1, range.endLine)
    .join("\n");
  const refined = range.startLine + localizeMatchLine(chunkText, queryTerms) - 1;
  return Math.max(range.startLine, Math.min(range.endLine, refined));
}

function repositoryPodMatch(
  reference: RetrievalReference,
  pod: ResolvedRepositoryPod,
  documentsByPath: ReadonlyMap<string, CandidateDocument>,
  queryTerms: readonly string[],
  maxScore: number,
): SemanticSearchMatch | undefined {
  const range = pod.lineRangeByChunk.get(String(reference.chunkId));
  const document = range === undefined ? undefined : documentsByPath.get(range.relativePath);
  if (range === undefined || document === undefined || reference.score <= 0) return undefined;
  return {
    scopePath: range.relativePath,
    line: chunkAnchoredLine(document, range, queryTerms),
    score: reference.score / maxScore,
  };
}

interface RepositoryPodHitOutcome {
  readonly matches: readonly SemanticSearchMatch[];
  // Every candidate path the pod query returned at least one reference for. A candidate that is
  // absent here received NO pod signal at all — it lost the pod-wide topK race rather than being
  // judged dissimilar — and must be handed to the legacy leg, or it is scored by neither leg and
  // vanishes from the result (ADR-0152 D3: no adapter may turn a partition mismatch into an empty
  // successful result). A candidate that IS referenced but scores zero was genuinely evaluated and
  // found dissimilar; that is a real "no match", identical to the legacy path's score<=0 filter,
  // and is deliberately not re-embedded.
  readonly referencedPaths: ReadonlySet<string>;
}

function repositoryPodMatches(
  references: readonly RetrievalReference[],
  pod: ResolvedRepositoryPod,
  documents: readonly CandidateDocument[],
  queryTerms: readonly string[],
): RepositoryPodHitOutcome {
  const documentsByPath = new Map(documents.map((document) => [document.scopePath, document]));
  const referencedPaths = new Set<string>();
  const intersected = references.filter((reference) => {
    const range = pod.lineRangeByChunk.get(String(reference.chunkId));
    if (range === undefined || !documentsByPath.has(range.relativePath)) return false;
    referencedPaths.add(range.relativePath);
    return true;
  });
  const maxScore = intersected.reduce(
    (current, reference) =>
      Math.max(current, Number.isFinite(reference.score) ? reference.score : 0),
    0,
  );
  if (maxScore <= 0) return { matches: [], referencedPaths };
  const bestByPath = new Map<string, SemanticSearchMatch>();
  for (const reference of intersected) {
    const match = repositoryPodMatch(reference, pod, documentsByPath, queryTerms, maxScore);
    const prior = match === undefined ? undefined : bestByPath.get(match.scopePath);
    if (match !== undefined && (prior === undefined || match.score > prior.score)) {
      bestByPath.set(match.scopePath, match);
    }
  }
  return { matches: [...bestByPath.values()], referencedPaths };
}

// `searchVectorsForScope` has no path filter, so the requested topK is a race across EVERY chunk in
// the pod — not just the candidates'. Sizing that budget from the candidate count (as this once did)
// therefore let a handful of large or lexically dominant files monopolise it and return zero
// references for a candidate the caller explicitly asked about. The budget is instead sized against
// the pod's own indexed reference population, so every indexed chunk can in principle surface, and
// clamped only by a ceiling that keeps a very large pod from turning one search into an unbounded
// reference set. The ceiling is a cost bound, NOT a correctness bound: a pod larger than it can
// still starve a candidate, and that residue is covered by routing unreferenced candidates back
// into the legacy leg — never by silence. Its value is the widest set the intersection can ever
// use: at most `MAX_SEMANTIC_CANDIDATES` documents survive, each keeping its single best chunk, so
// asking for more than the same result multiplier applied to that cap buys no additional coverage
// while making the pod query measurably more expensive.
const POD_RETRIEVAL_TOPK_CEILING = MAX_SEMANTIC_CANDIDATES * SEMANTIC_CANDIDATE_RESULT_MULTIPLIER;

function podRetrievalTopK(pod: ResolvedRepositoryPod, maxResults: number): number {
  return Math.max(maxResults, Math.min(pod.lineRangeByChunk.size, POD_RETRIEVAL_TOPK_CEILING));
}

async function repositoryPodHits(
  ctx: EmbeddingContext,
  pod: ResolvedRepositoryPod,
  documents: readonly CandidateDocument[],
  queryText: string,
  queryTerms: readonly string[],
  signal: AbortSignal | undefined,
  maxResults: number,
): Promise<RepositoryPodHitOutcome> {
  const topK = podRetrievalTopK(pod, maxResults);
  const outcome = await searchVectorsForScope(
    pod.context.store,
    ctx.localKnowledgeEmbeddingAdapter,
    {
      capsuleIds: [pod.capsule.id],
      sourceFilter: [pod.source.id],
      capsules: [pod.capsule],
    },
    queryText,
    {
      topK,
      ...(signal === undefined ? {} : { signal }),
      ...(pod.context.vectorIndex === undefined ? {} : { vectorIndex: pod.context.vectorIndex }),
    },
  );
  ctx.observePodRetrieval?.({
    mode: outcome.diagnostics.mode,
    referenceCount: outcome.references.length,
    denseCandidateCount: outcome.diagnostics.denseCandidateCount,
    lexicalCandidateCount: outcome.diagnostics.lexicalCandidateCount,
    lexicalOrFallbackUsed: outcome.diagnostics.lexicalOrFallbackUsed,
  });
  return repositoryPodMatches(outcome.references, pod, documents, queryTerms);
}

interface PreparedSemanticSearch {
  readonly signal: AbortSignal | undefined;
  readonly maxResults: number;
  readonly documents: readonly CandidateDocument[];
  readonly queryText: string;
  readonly queryTerms: readonly string[];
}

function prepareSemanticSearch(
  ctx: EmbeddingContext,
  request: SemanticSearchInput,
): PreparedSemanticSearch | undefined {
  const signal = request.signal ?? ctx.signal;
  const maxResults = Math.max(0, Math.min(request.query.maxResults, ctx.maxCandidates));
  if (maxResults <= 0 || request.query.text.trim().length === 0 || isAborted(signal))
    return undefined;
  const documents = candidateDocuments(ctx, request, signal);
  if (documents.length === 0 || isAborted(signal)) return undefined;
  const queryText = embeddingText(ctx, request.query.text).trim();
  if (queryText.length === 0) return undefined;
  return {
    signal,
    maxResults,
    documents,
    queryText,
    queryTerms: localizeQueryTerms(request.query.text),
  };
}

// A pod that is unreadable or fails mid-query stays fail-closed on results: it must NOT drop back
// to the whole-file path, because that path embeds every candidate document's content and would
// turn an index fault into an unplanned model-gateway egress and cost burst (pinned by the
// "soft-fails a pod query error without escaping or embedding documents" regression test). What the
// fault must not be is *silent*: an empty result would otherwise be indistinguishable from a
// genuinely unmatched query. The degradation is therefore recorded content-free through the
// existing pod retrieval observation seam — a mode label and counts, never paths or bodies.
function observePodDegradation(ctx: EmbeddingContext, mode: string): void {
  ctx.observePodRetrieval?.({
    mode,
    referenceCount: 0,
    denseCandidateCount: 0,
    lexicalCandidateCount: 0,
    lexicalOrFallbackUsed: true,
  });
}

// Candidates the pod query never referenced join the legacy leg. Scope this to genuinely
// unreferenced documents only: `legacyHits` embeds document bodies through the model gateway, so
// widening it to the whole indexed partition would re-introduce exactly the egress burst the pod
// path exists to avoid.
function legacyLegDocuments(
  partition: PodDocumentPartition,
  referencedPaths: ReadonlySet<string>,
): readonly CandidateDocument[] {
  const unreferenced = partition.indexed.filter(
    (document) => !referencedPaths.has(document.scopePath),
  );
  return unreferenced.length === 0 ? partition.fallback : [...partition.fallback, ...unreferenced];
}

async function podRankedHits(
  ctx: EmbeddingContext,
  pod: ResolvedRepositoryPod,
  prepared: PreparedSemanticSearch,
  partition: PodDocumentPartition,
): Promise<readonly SemanticSearchMatch[]> {
  const { documents, maxResults, queryTerms, queryText, signal } = prepared;
  const podOutcome = await repositoryPodHits(
    ctx,
    pod,
    partition.indexed,
    queryText,
    queryTerms,
    signal,
    maxResults,
  );
  const sharedQueryVector = ctx.podEmbeddingVectorCache.get(
    podEmbeddingCacheKey(ctx.provider.modelId, queryText),
  );
  const fallbackHits = await legacyHits(
    ctx,
    legacyLegDocuments(partition, podOutcome.referencedPaths),
    queryText,
    queryTerms,
    signal,
    sharedQueryVector,
  );
  return rankHits([...podOutcome.matches, ...fallbackHits], documents, maxResults);
}

async function semanticSearch(
  ctx: EmbeddingContext,
  request: SemanticSearchInput,
): Promise<readonly SemanticSearchMatch[]> {
  const prepared = prepareSemanticSearch(ctx, request);
  if (prepared === undefined) return [];
  const { documents, maxResults, queryTerms, queryText, signal } = prepared;
  if (ctx.repositoryPod.kind === "failed") {
    observePodDegradation(ctx, "pod-unavailable");
    return [];
  }
  if (ctx.repositoryPod.kind === "absent") {
    return legacyRankedHits(ctx, documents, queryText, queryTerms, signal, maxResults);
  }
  const partition = partitionPodDocuments(ctx, ctx.repositoryPod.pod, documents);
  if (partition.indexed.length === 0) {
    return legacyRankedHits(ctx, documents, queryText, queryTerms, signal, maxResults);
  }
  try {
    return await podRankedHits(ctx, ctx.repositoryPod.pod, prepared, partition);
  } catch {
    if (!isAborted(signal)) observePodDegradation(ctx, "pod-query-failed");
    return [];
  }
}

export function configuredRepoSemanticSearchProviderFor(
  deps: UiHandlerDeps,
  signal: AbortSignal | undefined,
  options: ConfiguredRepoSemanticSearchOptions = {},
): SemanticSearchProvider | undefined {
  const config = currentGatewayConfig(deps);
  const provider = configuredEmbeddingProviders(config)[0];
  if (provider === undefined) {
    return undefined;
  }
  const maxEmbeddingInputBytes = embeddingInputByteLimit(config, provider);
  const fs = options.fs ?? nodeWorkspaceFs;
  const podEmbeddingVectorCache = new Map<string, Float32Array>();
  const ctx: EmbeddingContext = {
    deps,
    provider,
    credentials: providerCredentials(provider, currentGatewayEgressConfig(deps)),
    request: requestEmbeddingImpl(deps),
    batchRequest: requestEmbeddingBatchImpl(deps),
    fs,
    signal,
    maxCandidates: Math.max(
      0,
      Math.min(MAX_SEMANTIC_CANDIDATES, options.maxCandidates ?? MAX_SEMANTIC_CANDIDATES),
    ),
    maxEmbeddingInputBytes,
    documentVectorCache: new Map(),
    localKnowledgeEmbeddingAdapter: trackedLocalKnowledgeEmbeddingAdapter(
      deps,
      provider,
      podEmbeddingVectorCache,
    ),
    podEmbeddingVectorCache,
    repositoryPod: resolveRepositoryPod(options.repositoryPod, fs, provider.modelId),
    ...(options.observePodRetrieval === undefined
      ? {}
      : { observePodRetrieval: options.observePodRetrieval }),
  };
  return {
    name: "configured-repo-semantic-search",
    search: (request: SemanticSearchInput) => semanticSearch(ctx, request),
  };
}

export function configuredRepoSemanticSearchProviderLeaseFor(
  deps: UiHandlerDeps,
  signal: AbortSignal | undefined,
  repositoryRoot: string,
): ConfiguredRepoSemanticSearchProviderLease {
  const fallback = configuredRepoSemanticSearchProviderFor(deps, signal);
  if (fallback === undefined) return { provider: undefined, close: () => undefined };
  try {
    const opened = openKnowledgeStoreForDeps(deps);
    const provider = configuredRepoSemanticSearchProviderFor(deps, signal, {
      repositoryPod: {
        store: opened.store,
        repositoryRoot,
        vectorIndex: opened.vectorIndex,
      },
    });
    return {
      provider,
      close: (): void => {
        opened.close();
      },
    };
  } catch {
    return { provider: fallback, close: () => undefined };
  }
}
