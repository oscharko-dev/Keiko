import { maxUtf8BytesForTokenBudget, stripUnsafeFormatChars } from "@oscharko-dev/keiko-contracts";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import {
  requestOpenAIEmbedding,
  requestOpenAIEmbeddingBatch,
  type ModelProviderConfig,
  type OpenAIEmbeddingBatchOutcome,
  type OpenAIEmbeddingBatchRequest,
  type OpenAIEmbeddingOutcome,
  type OpenAIEmbeddingRequest,
} from "@oscharko-dev/keiko-model-gateway";
import {
  readExcerpt,
  assertContainedRealPath,
  resolveWithinWorkspace,
  WorkspaceError,
  type SearchScope,
  type SemanticSearchHit,
  type SemanticSearchProvider,
  type SemanticSearchRequest,
  type WorkspaceFs,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import {
  currentGatewayConfig,
  currentGatewayEgressConfig,
  type UiHandlerDeps,
} from "./deps.js";
import { configuredEmbeddingProviders } from "./local-knowledge-handlers.js";

const MAX_SEMANTIC_CANDIDATES = 32;
const SEMANTIC_CANDIDATE_RESULT_MULTIPLIER = 4;
const SEMANTIC_EXCERPT_LINES = 240;
const SEMANTIC_EXCERPT_BYTES = 16_384;
const SEMANTIC_VECTOR_CACHE_SCHEMA_VERSION = 1;
const SEMANTIC_VECTOR_CACHE_DIR = ".keiko/repo-semantic-search";
const MAX_CACHED_VECTOR_DIMS = 16_384;
const EMBEDDING_INPUT_SAFETY_TOKENS = 16;

interface ProviderCredentials {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly apiKeyHeaderName?: string;
  readonly egress?: NonNullable<ModelProviderConfig["egress"]>;
  readonly timeoutMs: number;
}

interface EmbeddingContext {
  readonly deps: UiHandlerDeps;
  readonly provider: ModelProviderConfig;
  readonly credentials: ProviderCredentials;
  readonly request: (request: OpenAIEmbeddingRequest) => Promise<OpenAIEmbeddingOutcome>;
  readonly batchRequest?:
    | ((request: OpenAIEmbeddingBatchRequest) => Promise<OpenAIEmbeddingBatchOutcome>)
    | undefined;
  readonly fs: WorkspaceFs;
  readonly signal?: AbortSignal | undefined;
  readonly maxCandidates: number;
  readonly maxEmbeddingInputBytes: number;
  readonly documentVectorCache: Map<string, Float32Array>;
}

interface CandidateDocument {
  readonly scopePath: string;
  readonly lineRange: { readonly startLine: number; readonly endLine: number };
  readonly text: string;
  readonly order: number;
}

interface CachedDocumentVector {
  readonly schemaVersion: number;
  readonly key: string;
  readonly vector: readonly number[];
}

type PersistentWorkspaceFs = WorkspaceFs & Required<Pick<WorkspaceFs, "makeDir" | "writeFileUtf8">>;

export interface ConfiguredRepoSemanticSearchOptions {
  readonly fs?: WorkspaceFs | undefined;
  readonly maxCandidates?: number | undefined;
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
  };
}

function candidateLimit(request: SemanticSearchRequest, configuredLimit: number): number {
  return Math.max(
    0,
    Math.min(
      request.candidatePaths.length,
      request.limits.maxFilesScanned,
      configuredLimit,
      Math.max(request.maxResults, request.maxResults * SEMANTIC_CANDIDATE_RESULT_MULTIPLIER),
    ),
  );
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function lineCount(text: string): number {
  if (text.length === 0) return 1;
  return text.split("\n").length;
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
    .replace(/�+$/u, "");
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

function hasPersistentWorkspaceState(fs: WorkspaceFs): fs is PersistentWorkspaceFs {
  return fs.makeDir !== undefined && fs.writeFileUtf8 !== undefined;
}

function semanticCacheKey(ctx: EmbeddingContext, scope: SearchScope, document: CandidateDocument): string {
  return sha256Hex(
    JSON.stringify({
      schemaVersion: SEMANTIC_VECTOR_CACHE_SCHEMA_VERSION,
      providerEndpoint: ctx.provider.baseUrl,
      modelId: ctx.provider.modelId,
      workspaceRoot: scope.workspace.root,
      scopePath: document.scopePath,
      textHash: sha256Hex(document.text),
    }),
  );
}

function persistentCacheDir(scope: SearchScope): string {
  return resolveWithinWorkspace(scope.workspace.root, SEMANTIC_VECTOR_CACHE_DIR);
}

function persistentCachePath(scope: SearchScope, key: string): string {
  return resolveWithinWorkspace(scope.workspace.root, `${SEMANTIC_VECTOR_CACHE_DIR}/${key}.json`);
}

function vectorFromJson(value: unknown, key: string): Float32Array | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as CachedDocumentVector).schemaVersion !== SEMANTIC_VECTOR_CACHE_SCHEMA_VERSION ||
    (value as CachedDocumentVector).key !== key ||
    !Array.isArray((value as CachedDocumentVector).vector)
  ) {
    return undefined;
  }
  const raw = (value as CachedDocumentVector).vector;
  if (
    raw.length === 0 ||
    raw.length > MAX_CACHED_VECTOR_DIMS ||
    !raw.every((item): item is number => typeof item === "number" && Number.isFinite(item))
  ) {
    return undefined;
  }
  return new Float32Array(raw);
}

function readPersistentVector(
  ctx: EmbeddingContext,
  scope: SearchScope,
  key: string,
): Float32Array | undefined {
  try {
    const cacheFile = assertContainedRealPath(
      ctx.fs,
      scope.workspace.root,
      persistentCachePath(scope, key),
      "repo semantic vector cache file",
    );
    if (!ctx.fs.exists(cacheFile)) {
      return undefined;
    }
    return vectorFromJson(JSON.parse(ctx.fs.readFileUtf8(cacheFile)), key);
  } catch {
    return undefined;
  }
}

function writePersistentVector(
  ctx: EmbeddingContext,
  scope: SearchScope,
  key: string,
  vector: Float32Array,
): void {
  if (!hasPersistentWorkspaceState(ctx.fs)) {
    return;
  }
  try {
    const cacheDir = assertContainedRealPath(
      ctx.fs,
      scope.workspace.root,
      persistentCacheDir(scope),
      "repo semantic vector cache directory",
    );
    ctx.fs.makeDir(cacheDir);
    const cacheFile = assertContainedRealPath(
      ctx.fs,
      scope.workspace.root,
      persistentCachePath(scope, key),
      "repo semantic vector cache file",
    );
    ctx.fs.writeFileUtf8(
      cacheFile,
      JSON.stringify({
        schemaVersion: SEMANTIC_VECTOR_CACHE_SCHEMA_VERSION,
        key,
        vector: Array.from(vector),
      } satisfies CachedDocumentVector),
    );
  } catch {
    // Semantic search must remain best-effort; cache writes never block retrieval.
  }
}

function cachedDocumentVector(
  ctx: EmbeddingContext,
  scope: SearchScope,
  document: CandidateDocument,
): { readonly key: string; readonly vector?: Float32Array | undefined } {
  const key = semanticCacheKey(ctx, scope, document);
  const memory = ctx.documentVectorCache.get(key);
  if (memory !== undefined) {
    return { key, vector: memory };
  }
  const persisted = readPersistentVector(ctx, scope, key);
  if (persisted !== undefined) {
    ctx.documentVectorCache.set(key, persisted);
    return { key, vector: persisted };
  }
  return { key };
}

function isIoError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string"
  );
}

async function readCandidateDocument(
  ctx: EmbeddingContext,
  scope: SearchScope,
  scopePath: string,
  order: number,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<CandidateDocument | undefined> {
  if (isAborted(signal)) {
    return undefined;
  }
  try {
    const excerpt = await readExcerpt(
      scope,
      {
        scopePath,
        startLine: 1,
        endLine: SEMANTIC_EXCERPT_LINES,
        maxBytes,
      },
      { fs: ctx.fs, ...(signal !== undefined ? { signal } : {}) },
    );
    const text = embeddingText(ctx, `Path: ${scopePath}\n${excerpt.content}`).trim();
    if (text.length === 0) {
      return undefined;
    }
    return {
      scopePath,
      lineRange: { startLine: 1, endLine: Math.max(1, lineCount(excerpt.content)) },
      text,
      order,
    };
  } catch (error) {
    if (error instanceof WorkspaceError || isIoError(error)) {
      return undefined;
    }
    throw error;
  }
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
  scope: SearchScope,
  documents: readonly CandidateDocument[],
  signal: AbortSignal | undefined,
): Promise<readonly (Float32Array | undefined)[]> {
  const vectors = Array<Float32Array | undefined>(documents.length).fill(undefined);
  const missingDocuments: CandidateDocument[] = [];
  const missingKeys: string[] = [];
  const missingIndexes: number[] = [];
  for (let index = 0; index < documents.length; index += 1) {
    const document = documents[index];
    if (document === undefined) {
      continue;
    }
    const cached = cachedDocumentVector(ctx, scope, document);
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
    writePersistentVector(ctx, scope, key, vector);
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
  a: SemanticSearchHit,
  b: SemanticSearchHit,
): number {
  const scoreDelta = b.score - a.score;
  if (scoreDelta !== 0) return scoreDelta;
  return (
    (orderByPath.get(a.scopePath) ?? 0) - (orderByPath.get(b.scopePath) ?? 0) ||
    a.scopePath.localeCompare(b.scopePath)
  );
}

function rankHits(
  hits: readonly SemanticSearchHit[],
  documents: readonly CandidateDocument[],
  maxResults: number,
): readonly SemanticSearchHit[] {
  const orderByPath = hitOrderMap(documents);
  return [...hits].sort((a, b) => compareHits(orderByPath, a, b)).slice(0, maxResults);
}

function hitForDocument(
  document: CandidateDocument,
  vector: Float32Array | undefined,
  queryVector: Float32Array,
): SemanticSearchHit | undefined {
  if (vector === undefined) {
    return undefined;
  }
  const score = cosineScore(queryVector, vector);
  if (score === undefined || score <= 0) {
    return undefined;
  }
  return {
    scopePath: document.scopePath,
    lineRange: document.lineRange,
    score,
  };
}

function hitsFromVectors(
  documents: readonly CandidateDocument[],
  vectors: readonly (Float32Array | undefined)[],
  queryVector: Float32Array,
): readonly SemanticSearchHit[] {
  const hits: SemanticSearchHit[] = [];
  for (let index = 0; index < documents.length; index += 1) {
    const document = documents[index];
    if (document === undefined) {
      continue;
    }
    const hit = hitForDocument(document, vectors[index], queryVector);
    if (hit !== undefined) {
      hits.push(hit);
    }
  }
  return hits;
}

async function candidateDocuments(
  ctx: EmbeddingContext,
  request: SemanticSearchRequest,
  signal: AbortSignal | undefined,
): Promise<readonly CandidateDocument[]> {
  const limit = candidateLimit(request, ctx.maxCandidates);
  const documents: CandidateDocument[] = [];
  const maxBytes = Math.max(
    0,
    Math.min(SEMANTIC_EXCERPT_BYTES, request.limits.maxBytesPerFileScanned),
  );
  if (maxBytes <= 0) {
    return [];
  }
  for (let index = 0; index < limit; index += 1) {
    const scopePath = request.candidatePaths[index];
    if (scopePath === undefined || isAborted(signal)) {
      break;
    }
    const document = await readCandidateDocument(
      ctx,
      request.scope,
      scopePath,
      index,
      maxBytes,
      signal,
    );
    if (document !== undefined) {
      documents.push(document);
    }
  }
  return documents;
}

async function semanticSearch(
  ctx: EmbeddingContext,
  request: SemanticSearchRequest,
): Promise<readonly SemanticSearchHit[]> {
  const signal = request.signal ?? ctx.signal;
  if (request.maxResults <= 0 || request.query.text.trim().length === 0 || isAborted(signal)) {
    return [];
  }
  const documents = await candidateDocuments(ctx, request, signal);
  if (documents.length === 0 || isAborted(signal)) {
    return [];
  }
  const queryText = embeddingText(ctx, request.query.text).trim();
  if (queryText.length === 0) {
    return [];
  }
  const queryVector = await embedOne(ctx, queryText, signal);
  if (queryVector === undefined || isAborted(signal)) {
    return [];
  }
  const vectors = await embedDocuments(ctx, request.scope, documents, signal);
  return rankHits(hitsFromVectors(documents, vectors, queryVector), documents, request.maxResults);
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
  const ctx: EmbeddingContext = {
    deps,
    provider,
    credentials: providerCredentials(provider, currentGatewayEgressConfig(deps)),
    request: requestEmbeddingImpl(deps),
    batchRequest: requestEmbeddingBatchImpl(deps),
    fs: options.fs ?? nodeWorkspaceFs,
    signal,
    maxCandidates: Math.max(
      0,
      Math.min(MAX_SEMANTIC_CANDIDATES, options.maxCandidates ?? MAX_SEMANTIC_CANDIDATES),
    ),
    maxEmbeddingInputBytes,
    documentVectorCache: new Map(),
  };
  return {
    search: (request: SemanticSearchRequest) => semanticSearch(ctx, request),
  };
}
