import { isAbsolute, relative, resolve } from "node:path";

import {
  type KnowledgeCapsule,
  type KnowledgeSource,
  type RetrievalReference,
} from "@oscharko-dev/keiko-contracts";
import {
  createLocalKnowledgeStoreVectorIndexPort,
  listCapsuleSources,
  listCapsules,
  listRepositoryChunkLineRanges,
  readRepositoryFileFingerprints,
  repositoryContentFingerprint,
  searchVectorsForScope,
  vectorIndexPortAsRepoAdapter,
  type KnowledgeStore,
  type RepositoryChunkLineRange,
  type RepositoryFileFingerprint,
  type VectorIndexOptions,
} from "@oscharko-dev/keiko-local-knowledge";
import {
  type SemanticSearchInput,
  type SemanticSearchMatch,
  type SemanticSearchProvider,
  type WorkspaceFs,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { currentGatewayConfig, type UiHandlerDeps } from "./deps.js";
import {
  configuredEmbeddingProviders,
  localKnowledgeEmbeddingAdapterForProvider,
} from "./local-knowledge-handlers.js";
import { openKnowledgeStoreForDeps } from "./local-knowledge-store-open.js";

const MAX_SEMANTIC_CANDIDATES = 32;
const SEMANTIC_CANDIDATE_RESULT_MULTIPLIER = 4;
const POD_FRESHNESS_MAX_BYTES = 64 * 1024 * 1024;

interface EmbeddingContext {
  readonly fs: WorkspaceFs;
  readonly signal?: AbortSignal | undefined;
  readonly maxCandidates: number;
  readonly localKnowledgeEmbeddingAdapter: ReturnType<
    typeof localKnowledgeEmbeddingAdapterForProvider
  >;
  readonly repositoryPod: RepositoryPodResolution;
  readonly observePodRetrieval?:
    ((observation: RepositoryPodRetrievalObservation) => void) | undefined;
}

interface CandidateDocument {
  readonly scopePath: string;
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

interface RepositorySourceMatch {
  readonly capsule: KnowledgeCapsule;
  readonly source: KnowledgeSource;
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

function compareOpaqueIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function matchingRepositorySources(
  store: KnowledgeStore,
  fs: WorkspaceFs,
  repositoryRoot: string,
  modelId: string,
): readonly RepositorySourceMatch[] {
  const expectedRoot = canonicalRoot(fs, repositoryRoot);
  const matches: RepositorySourceMatch[] = [];
  // Sorted below with a code-unit comparison, not localeCompare: the caller takes the FIRST match
  // as the pod to search, so this ordering picks which repository pod answers a question. Locale
  // collation is host- and ICU-dependent, which would let two machines with identical stores
  // resolve the same repository root to different pods.
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
      compareOpaqueIds(String(left.capsule.id), String(right.capsule.id)) ||
      compareOpaqueIds(String(left.source.id), String(right.source.id)),
  );
}

function resolvedPodForMatch(
  context: RepositoryPodSemanticSearchContext,
  match: RepositorySourceMatch,
): ResolvedRepositoryPod | undefined {
  if (match.capsule.lifecycleState !== "ready") return undefined;
  const fingerprints = readRepositoryFileFingerprints(
    context.store,
    match.capsule.id,
    match.source.id,
  );
  if (fingerprints.size === 0) return undefined;
  const lineRanges = listRepositoryChunkLineRanges(context.store, match.capsule.id).filter(
    (range) => fingerprints.has(range.relativePath),
  );
  if (lineRanges.length === 0) return undefined;
  return {
    context,
    capsule: match.capsule,
    source: match.source,
    fingerprints,
    lineRangeByChunk: new Map(lineRanges.map((range) => [String(range.chunkId), range])),
    indexedPaths: new Set(lineRanges.map((range) => range.relativePath)),
  };
}

function resolveRepositoryPod(
  context: RepositoryPodSemanticSearchContext | undefined,
  fs: WorkspaceFs,
  modelId: string,
): RepositoryPodResolution {
  if (context === undefined) return { kind: "absent" };
  let readFailed = false;
  try {
    const matches = matchingRepositorySources(context.store, fs, context.repositoryRoot, modelId);
    for (const match of matches) {
      try {
        const pod = resolvedPodForMatch(context, match);
        if (pod !== undefined) return { kind: "ready", pod };
      } catch {
        readFailed = true;
      }
    }
  } catch {
    return { kind: "failed" };
  }
  return readFailed ? { kind: "failed" } : { kind: "absent" };
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
    compareOpaqueIds(a.scopePath, b.scopePath)
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

// Refine a stored chunk's bounded line range without trusting an unanchored model-produced span.
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
    if (source.text.trim().length > 0) {
      documents.push({ scopePath: source.scopePath, sourceText: source.text, order: index });
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

function isContainedPath(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot.length > 0 && !fromRoot.startsWith("..") && !isAbsolute(fromRoot);
}

function stableFileStat(
  before: ReturnType<WorkspaceFs["stat"]>,
  after: ReturnType<WorkspaceFs["stat"]>,
): boolean {
  if (!after.isFile || after.isSymbolicLink || before.size !== after.size) return false;
  if (before.mtimeMs !== undefined && before.mtimeMs !== after.mtimeMs) return false;
  return before.ctimeMs === undefined || before.ctimeMs === after.ctimeMs;
}

function fingerprintByteLength(fingerprint: RepositoryFileFingerprint): number | undefined {
  const byteLength = fingerprint.byteLength;
  return Number.isSafeInteger(byteLength) &&
    byteLength >= 0 &&
    byteLength <= POD_FRESHNESS_MAX_BYTES
    ? byteLength
    : undefined;
}

interface LiveFingerprintFile {
  readonly absolutePath: string;
  readonly realPath: string;
  readonly before: ReturnType<WorkspaceFs["stat"]>;
}

function liveFingerprintFile(
  ctx: EmbeddingContext,
  pod: ResolvedRepositoryPod,
  scopePath: string,
  byteLength: number,
): LiveFingerprintFile | undefined {
  const absolutePath = containedDocumentPath(pod.context.repositoryRoot, scopePath);
  if (absolutePath === undefined) return undefined;
  const rootRealPath = ctx.fs.realPath(resolve(pod.context.repositoryRoot));
  const realPath = ctx.fs.realPath(absolutePath);
  if (!isContainedPath(rootRealPath, realPath)) return undefined;
  const before = ctx.fs.stat(absolutePath);
  if (!before.isFile || before.isSymbolicLink || before.size !== byteLength) return undefined;
  return { absolutePath, realPath, before };
}

async function readLiveFingerprintBytes(
  ctx: EmbeddingContext,
  pod: ResolvedRepositoryPod,
  scopePath: string,
  fingerprint: RepositoryFileFingerprint,
): Promise<Uint8Array | undefined> {
  const byteLength = fingerprintByteLength(fingerprint);
  if (byteLength === undefined || ctx.fs.readFileBytes === undefined) return undefined;
  try {
    const file = liveFingerprintFile(ctx, pod, scopePath, byteLength);
    if (file === undefined) return undefined;
    const bytes = await ctx.fs.readFileBytes(file.realPath, byteLength + 1);
    const after = ctx.fs.stat(file.absolutePath);
    return bytes.byteLength === byteLength && stableFileStat(file.before, after)
      ? bytes
      : undefined;
  } catch {
    return undefined;
  }
}

async function podDocumentIsFresh(
  ctx: EmbeddingContext,
  pod: ResolvedRepositoryPod,
  document: CandidateDocument,
): Promise<boolean> {
  if (!pod.indexedPaths.has(document.scopePath)) return false;
  const fingerprint = pod.fingerprints.get(document.scopePath);
  if (fingerprint === undefined) return false;
  const bytes = await readLiveFingerprintBytes(ctx, pod, document.scopePath, fingerprint);
  return (
    bytes !== undefined &&
    repositoryContentFingerprint(bytes, fingerprint.fingerprintKind) ===
      fingerprint.contentFingerprint
  );
}

async function freshPodDocuments(
  ctx: EmbeddingContext,
  pod: ResolvedRepositoryPod,
  documents: readonly CandidateDocument[],
): Promise<readonly CandidateDocument[]> {
  const indexed: CandidateDocument[] = [];
  for (const document of documents) {
    if (await podDocumentIsFresh(ctx, pod, document)) indexed.push(document);
  }
  return indexed;
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
}

function repositoryPodMatches(
  references: readonly RetrievalReference[],
  pod: ResolvedRepositoryPod,
  documents: readonly CandidateDocument[],
  queryTerms: readonly string[],
): RepositoryPodHitOutcome {
  const documentsByPath = new Map(documents.map((document) => [document.scopePath, document]));
  const intersected = references.filter((reference) => {
    const range = pod.lineRangeByChunk.get(String(reference.chunkId));
    if (range === undefined || !documentsByPath.has(range.relativePath)) return false;
    return true;
  });
  const maxScore = intersected.reduce(
    (current, reference) =>
      Math.max(current, Number.isFinite(reference.score) ? reference.score : 0),
    0,
  );
  if (maxScore <= 0) return { matches: [] };
  const bestByPath = new Map<string, SemanticSearchMatch>();
  for (const reference of intersected) {
    const match = repositoryPodMatch(reference, pod, documentsByPath, queryTerms, maxScore);
    const prior = match === undefined ? undefined : bestByPath.get(match.scopePath);
    if (match !== undefined && (prior === undefined || match.score > prior.score)) {
      bestByPath.set(match.scopePath, match);
    }
  }
  return { matches: [...bestByPath.values()] };
}

const POD_RETRIEVAL_TOPK_CEILING = MAX_SEMANTIC_CANDIDATES * SEMANTIC_CANDIDATE_RESULT_MULTIPLIER;

function podRetrievalTopK(candidateChunkCount: number, maxResults: number): number {
  return Math.max(maxResults, Math.min(candidateChunkCount, POD_RETRIEVAL_TOPK_CEILING));
}

function candidateChunkIds(
  pod: ResolvedRepositoryPod,
  documents: readonly CandidateDocument[],
): readonly string[] {
  const candidatePaths = new Set(documents.map((document) => document.scopePath));
  const chunkIds: string[] = [];
  for (const [chunkId, range] of pod.lineRangeByChunk) {
    if (candidatePaths.has(range.relativePath)) chunkIds.push(chunkId);
  }
  return chunkIds.sort(compareOpaqueIds);
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
  const chunkFilter = candidateChunkIds(pod, documents);
  if (chunkFilter.length === 0) return { matches: [] };
  const topK = podRetrievalTopK(chunkFilter.length, maxResults);
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
      chunkFilter,
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
  const queryText = request.query.text.trim();
  if (queryText.length === 0) return undefined;
  return {
    signal,
    maxResults,
    documents,
    queryText,
    queryTerms: localizeQueryTerms(request.query.text),
  };
}

// Repository semantic search is index-only. Missing, stale, or unreadable pod state degrades to the
// orchestrator's lexical lane and is recorded content-free; it never embeds whole candidate files
// at ask time.
function observePodDegradation(ctx: EmbeddingContext, mode: string): void {
  ctx.observePodRetrieval?.({
    mode,
    referenceCount: 0,
    denseCandidateCount: 0,
    lexicalCandidateCount: 0,
    lexicalOrFallbackUsed: true,
  });
}

async function podRankedHits(
  ctx: EmbeddingContext,
  pod: ResolvedRepositoryPod,
  prepared: PreparedSemanticSearch,
  freshDocuments: readonly CandidateDocument[],
): Promise<readonly SemanticSearchMatch[]> {
  const { documents, maxResults, queryTerms, queryText, signal } = prepared;
  const podOutcome = await repositoryPodHits(
    ctx,
    pod,
    freshDocuments,
    queryText,
    queryTerms,
    signal,
    maxResults,
  );
  return rankHits(podOutcome.matches, documents, maxResults);
}

async function semanticSearch(
  ctx: EmbeddingContext,
  request: SemanticSearchInput,
): Promise<readonly SemanticSearchMatch[]> {
  const prepared = prepareSemanticSearch(ctx, request);
  if (prepared === undefined) return [];
  const { documents, signal } = prepared;
  if (ctx.repositoryPod.kind === "failed") {
    observePodDegradation(ctx, "pod-unavailable");
    return [];
  }
  if (ctx.repositoryPod.kind === "absent") {
    observePodDegradation(ctx, "pod-absent");
    return [];
  }
  const freshDocuments = await freshPodDocuments(ctx, ctx.repositoryPod.pod, documents);
  if (freshDocuments.length === 0) {
    observePodDegradation(ctx, "pod-no-fresh-candidates");
    return [];
  }
  try {
    return await podRankedHits(ctx, ctx.repositoryPod.pod, prepared, freshDocuments);
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
  const fs = options.fs ?? nodeWorkspaceFs;
  const ctx: EmbeddingContext = {
    fs,
    signal,
    maxCandidates: Math.max(
      0,
      Math.min(MAX_SEMANTIC_CANDIDATES, options.maxCandidates ?? MAX_SEMANTIC_CANDIDATES),
    ),
    localKnowledgeEmbeddingAdapter: localKnowledgeEmbeddingAdapterForProvider(deps, provider),
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
  try {
    const opened = openKnowledgeStoreForDeps(deps);
    // ADR-0152 D3: repository-pod retrieval is served through the pillar-neutral
    // `VectorIndexPort` under the `repo` namespace. `opened.vectorIndex` already carries the
    // knowledge-namespace shim from the composition root, so we rebind its adapter to a repo
    // shim before it reaches the pod path. The store, extension gate, and other options are
    // preserved verbatim — this changes only the namespace label the port observes.
    const podVectorIndex: VectorIndexOptions = {
      ...opened.vectorIndex,
      adapter: vectorIndexPortAsRepoAdapter(
        createLocalKnowledgeStoreVectorIndexPort({
          namespace: "repo",
          store: opened.store,
          vectorIndexOptions: opened.vectorIndex,
        }),
      ),
    };
    const provider = configuredRepoSemanticSearchProviderFor(deps, signal, {
      repositoryPod: {
        store: opened.store,
        repositoryRoot,
        vectorIndex: podVectorIndex,
      },
    });
    return {
      provider,
      close: (): void => {
        opened.close();
      },
    };
  } catch {
    return { provider: undefined, close: () => undefined };
  }
}
