import { isAbsolute, relative, resolve } from "node:path";
import { createHash } from "node:crypto";

import {
  type KnowledgeCapsule,
  type EmbeddingModelIdentity,
  type KnowledgeSource,
  type RetrievalReference,
  type ExplorationUsage,
} from "@oscharko-dev/keiko-contracts";
import {
  createLocalKnowledgeStoreVectorIndexPort,
  listCapsuleSources,
  listCapsules,
  listRepositoryChunkLineRanges,
  readRepositoryFileFingerprints,
  repositoryContentFingerprint,
  searchVectorsForScope,
  scoreVector,
  shapeEmbeddingQuery,
  vectorIndexPortAsRepoAdapter,
  type KnowledgeStore,
  type RepositoryChunkLineRange,
  type RepositoryFileFingerprint,
  type VectorIndexOptions,
} from "@oscharko-dev/keiko-local-knowledge";
import {
  assertCompatibleEmbeddingIdentity,
  l2NormalizeVector,
  type OpenAIEmbeddingSuccess,
  type OpenAIEmbeddingOutcome,
  type GatewaySpendReservation,
} from "@oscharko-dev/keiko-model-gateway";
import {
  type SemanticSearchInput,
  type SemanticSearchMatch,
  type SemanticSearchProvider,
  type WorkspaceFs,
  containedRealPathInfo,
  isDenied,
} from "@oscharko-dev/keiko-workspace";
import {
  isWorkspacePathSnapshotCurrent,
  nodeWorkspaceFs,
} from "@oscharko-dev/keiko-workspace/internal/fs";
import { isCanonicalAllowedContainedPath } from "@oscharko-dev/keiko-workspace/internal/realpath-policy";
import { isValidScopePath } from "@oscharko-dev/keiko-contracts/connected-context";
import { raceAbortDeadline } from "./abort-race.js";
import { currentGatewayConfig, type UiHandlerDeps } from "./deps.js";
import {
  configuredEmbeddingProviders,
  localKnowledgeEmbeddingAdapterForProvider,
} from "./local-knowledge-handlers.js";
import { openKnowledgeStoreForDeps } from "./local-knowledge-store-open.js";
import { reserveGatewaySpendForAttempt } from "./gateway-spend-budget.js";
import { correlationIdOrUnknown } from "./correlation.js";

const MAX_SEMANTIC_CANDIDATES = 32;
const SEMANTIC_CANDIDATE_RESULT_MULTIPLIER = 4;
const POD_FRESHNESS_MAX_BYTES = 64 * 1024 * 1024;
const SEMANTIC_REFRESH_FILE_CAP = 8;
const SEMANTIC_REFRESH_FRAGMENT_BYTES = 16_384;
type QueryEmbeddingObserver = NonNullable<
  Parameters<typeof searchVectorsForScope>[4]["observeQueryEmbedding"]
>;

export interface RepositorySemanticFreshnessObservation {
  // Request-private paths, never activity-log fields. The orchestrator projects counts only.
  readonly stalePaths: readonly string[];
  readonly refreshedPaths: readonly string[];
  readonly unavailableFileCount: number;
  /** Attempted optional work; token/byte values are conservative admission bounds, not usage reports. */
  readonly refreshUsage?: Readonly<SemanticRefreshUsage> | undefined;
}

interface SemanticRefreshUsage {
  embeddingCallCount: number;
  readFileCount: number;
  readBytes: number;
  inputTokens: number;
}

export interface SemanticRefreshDocumentBudget {
  readonly remaining: () => number;
  readonly tryReserve: () => boolean;
}

interface SemanticRefreshOptions {
  readonly semanticRefreshDocumentBudget?: SemanticRefreshDocumentBudget | undefined;
  readonly tryReserveRefreshUsage?:
    ((delta: Readonly<Partial<ExplorationUsage>>) => boolean) | undefined;
  readonly semanticRefreshFilesMax?: number | undefined;
  readonly deadlineAtMs?: number | undefined;
  readonly nowMs?: (() => number) | undefined;
  readonly correlationId?: string | undefined;
  readonly observeSemanticFreshness?:
    ((observation: RepositorySemanticFreshnessObservation) => void) | undefined;
}

interface EmbeddingContext extends SemanticRefreshOptions {
  readonly reserveRefreshSpend: (input: string) => GatewaySpendReservation | undefined;
  readonly refreshUsage?: SemanticRefreshUsage | undefined;
  readonly fs: WorkspaceFs;
  readonly redactText: (text: string) => string;
  readonly signal?: AbortSignal | undefined;
  readonly maxCandidates: number;
  readonly localKnowledgeEmbeddingAdapter: ReturnType<
    typeof localKnowledgeEmbeddingAdapterForProvider
  >;
  readonly repositoryPod: ResolvedRepositoryPod;
  readonly observePodRetrieval?:
    ((observation: RepositoryPodRetrievalObservation) => void) | undefined;
}

interface CandidateDocument {
  readonly startLine: number;
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

export interface ConfiguredRepoSemanticSearchOptions extends SemanticRefreshOptions {
  /**
   * Called once with the identity of the pod that answered, when one resolved. The same observation
   * idiom as `observePodRetrieval` below, and the only way a caller learns WHICH index it read
   * without resolving the pod a second time (#3416).
   */
  readonly observePodIdentity?:
    ((identity: { readonly capsuleId: string; readonly sourceId: string }) => void) | undefined;
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
  /** 64-hex identity of the pod this lease opened; absent when none resolved (#3416). */
  readonly indexIdentityDigest?: string | undefined;
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
      documents.push({
        scopePath: source.scopePath,
        sourceText: source.text,
        order: index,
        startLine: source.startLine ?? 1,
      });
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
): LiveFingerprintFile | undefined {
  if (semanticOperationStopped(ctx)) return undefined;
  if (!isValidScopePath(scopePath, { mustBeRelative: true }) || isDenied(scopePath))
    return undefined;
  const absolutePath = containedDocumentPath(pod.context.repositoryRoot, scopePath);
  if (absolutePath === undefined) return undefined;
  const contained = containedRealPathInfo(ctx.fs, pod.context.repositoryRoot, absolutePath);
  if (!isCanonicalAllowedContainedPath(contained, pod.context.repositoryRoot, scopePath))
    return undefined;
  const realPath = contained.path;
  const before = ctx.fs.stat(absolutePath);
  if (!before.isFile || before.isSymbolicLink || (before.hardLinkCount ?? 1) > 1) return undefined;
  return { absolutePath, realPath, before };
}

async function readLiveFingerprintBytes(
  ctx: EmbeddingContext,
  file: LiveFingerprintFile,
  fingerprint: RepositoryFileFingerprint,
): Promise<Uint8Array | undefined> {
  const byteLength = fingerprintByteLength(fingerprint);
  if (
    byteLength === undefined ||
    ctx.fs.readFileBytes === undefined ||
    semanticOperationStopped(ctx)
  )
    return undefined;
  try {
    if (file.before.size !== byteLength) return undefined;
    const bytes = await readSemanticFileBytes(ctx, file, byteLength + 1);
    return verifiedLiveBytes(ctx, file, bytes, byteLength);
  } catch {
    return undefined;
  }
}

function verifiedLiveBytes(
  ctx: EmbeddingContext,
  file: LiveFingerprintFile,
  bytes: Uint8Array | undefined,
  byteLength: number,
): Uint8Array | undefined {
  return bytes !== undefined &&
    !semanticOperationStopped(ctx) &&
    bytes.byteLength === byteLength &&
    isWorkspacePathSnapshotCurrent(ctx.fs, file.absolutePath, file.realPath, file.before)
    ? bytes
    : undefined;
}

async function readSemanticFileBytes(
  ctx: EmbeddingContext,
  file: LiveFingerprintFile,
  maxBytes: number,
  deadlineAtMs = ctx.deadlineAtMs ?? Infinity,
  onRead?: () => void,
): Promise<Uint8Array | undefined> {
  const read = ctx.fs.readFileBytes;
  if (read === undefined) return undefined;
  return raceAbortDeadline(
    () => {
      onRead?.();
      return read.call(ctx.fs, file.realPath, maxBytes, "reject", file.before);
    },
    { deadlineAtMs, nowMs: ctx.nowMs ?? Date.now, signal: ctx.signal },
  );
}

type FreshnessState = "fresh" | "stale" | "unindexed" | "unavailable";

async function podDocumentFreshness(
  ctx: EmbeddingContext,
  pod: ResolvedRepositoryPod,
  document: CandidateDocument,
): Promise<FreshnessState> {
  if (!pod.indexedPaths.has(document.scopePath)) return "unindexed";
  const fingerprint = pod.fingerprints.get(document.scopePath);
  if (fingerprint === undefined || fingerprintByteLength(fingerprint) === undefined)
    return "unavailable";
  const preflight = fingerprintPreflight(ctx, pod, document.scopePath, fingerprint);
  if (preflight.kind !== "ready") return preflight.kind;
  // Reuse this validated snapshot. The descriptor reader and post-read pathname/metadata check
  // still reject replacement; reconstructing the same preflight would add metadata I/O only.
  const bytes = await readLiveFingerprintBytes(ctx, preflight.file, fingerprint);
  if (bytes === undefined || semanticOperationStopped(ctx)) return "unavailable";
  return repositoryContentFingerprint(bytes, fingerprint.fingerprintKind) ===
    fingerprint.contentFingerprint
    ? "fresh"
    : "stale";
}

type FingerprintPreflight =
  | { readonly kind: "ready"; readonly file: LiveFingerprintFile }
  | { readonly kind: "stale" | "unavailable" };

function fingerprintPreflight(
  ctx: EmbeddingContext,
  pod: ResolvedRepositoryPod,
  scopePath: string,
  fingerprint: RepositoryFileFingerprint,
): FingerprintPreflight {
  try {
    const file = liveFingerprintFile(ctx, pod, scopePath);
    if (
      file === undefined ||
      semanticOperationStopped(ctx) ||
      !isWorkspacePathSnapshotCurrent(ctx.fs, file.absolutePath, file.realPath, file.before)
    )
      return { kind: "unavailable" };
    if (file.before.size !== fingerprint.byteLength) return { kind: "stale" };
    return { kind: "ready", file };
  } catch {
    return { kind: "unavailable" };
  }
}

interface ClassifiedPodDocuments {
  readonly fresh: readonly CandidateDocument[];
  readonly stale: readonly CandidateDocument[];
  readonly unavailableFileCount: number;
}

async function freshPodDocuments(
  ctx: EmbeddingContext,
  pod: ResolvedRepositoryPod,
  documents: readonly CandidateDocument[],
): Promise<ClassifiedPodDocuments> {
  const fresh: CandidateDocument[] = [];
  const stale: CandidateDocument[] = [];
  let unavailableFileCount = 0;
  for (const document of documents) {
    if (semanticOperationStopped(ctx)) break;
    const state = await podDocumentFreshness(ctx, pod, document);
    if (state === "fresh") fresh.push(document);
    else if (state === "stale") stale.push(document);
    else if (state === "unavailable") unavailableFileCount += 1;
  }
  return { fresh, stale, unavailableFileCount };
}

function chunkAnchoredLine(
  document: CandidateDocument,
  range: RepositoryChunkLineRange,
  queryTerms: readonly string[],
): number {
  const chunkText = document.sourceText
    .split("\n")
    .slice(
      Math.max(0, range.startLine - document.startLine),
      Math.max(0, range.endLine - document.startLine + 1),
    )
    .join("\n");
  const refined =
    Math.max(range.startLine, document.startLine) + localizeMatchLine(chunkText, queryTerms) - 1;
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
  observeQueryEmbedding?: QueryEmbeddingObserver,
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
      ...(observeQueryEmbedding === undefined ? {} : { observeQueryEmbedding }),
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
  const signal = combinedSemanticSignal(ctx.signal, request.signal);
  const maxResults = Math.max(0, Math.min(request.query.maxResults, ctx.maxCandidates));
  if (
    maxResults <= 0 ||
    request.query.text.trim().length === 0 ||
    semanticOperationStopped(ctx, signal)
  )
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

function combinedSemanticSignal(
  outer: AbortSignal | undefined,
  request: AbortSignal | undefined,
): AbortSignal | undefined {
  if (outer === undefined) return request;
  return request === undefined ? outer : AbortSignal.any([outer, request]);
}

function semanticOperationStopped(
  ctx: EmbeddingContext,
  signal: AbortSignal | undefined = ctx.signal,
): boolean {
  const deadline = ctx.deadlineAtMs;
  return (
    isAborted(signal) ||
    (deadline !== undefined && (Number.isNaN(deadline) || (ctx.nowMs ?? Date.now)() >= deadline))
  );
}

// Repository semantic search reuses indexed vectors by default. Missing, stale, or unreadable pod
// state degrades to the lexical lane; explicitly enabled bounded refresh may embed safe live
// fragments without mutating the pod. Freshness observations remain request-private.
function observePodDegradation(
  ctx: Pick<EmbeddingContext, "observePodRetrieval">,
  mode: string,
): void {
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
  observeQueryEmbedding?: QueryEmbeddingObserver,
): Promise<readonly SemanticSearchMatch[]> {
  if (freshDocuments.length === 0) return [];
  const { documents, maxResults, queryTerms, queryText, signal } = prepared;
  const podOutcome = await repositoryPodHits(
    ctx,
    pod,
    freshDocuments,
    queryText,
    queryTerms,
    signal,
    maxResults,
    observeQueryEmbedding,
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
  const active = {
    ...ctx,
    signal,
    refreshUsage: { embeddingCallCount: 0, readFileCount: 0, readBytes: 0, inputTokens: 0 },
  };
  const classified = await freshPodDocuments(active, active.repositoryPod, documents);
  const queryCapture = reusableSemanticQuery(active, prepared, classified.stale.length);
  const refreshed: SemanticSearchMatch[] = [];
  try {
    if (semanticOperationStopped(active, signal)) return [];
    const hits = await podRankedHits(
      active,
      active.repositoryPod,
      prepared,
      classified.fresh,
      queryCapture?.observe,
    );
    refreshed.push(
      ...(await refreshedSemanticHits(active, prepared, classified.stale, queryCapture?.vector())),
    );
    if (classified.fresh.length === 0) observePodDegradation(ctx, "pod-no-fresh-candidates");
    return rankHits([...hits, ...refreshed], documents, prepared.maxResults);
  } catch {
    if (!isAborted(signal)) observePodDegradation(ctx, "pod-query-failed");
    return [];
  } finally {
    ctx.observeSemanticFreshness?.({
      stalePaths: classified.stale.map((document) => document.scopePath),
      refreshedPaths: refreshed.map((hit) => hit.scopePath),
      unavailableFileCount: classified.unavailableFileCount,
      ...(active.refreshUsage.embeddingCallCount + active.refreshUsage.readFileCount === 0
        ? {}
        : { refreshUsage: { ...active.refreshUsage } }),
    });
  }
}

function reusableSemanticQuery(
  ctx: EmbeddingContext,
  prepared: PreparedSemanticSearch,
  staleCount: number,
):
  | { readonly observe: QueryEmbeddingObserver; readonly vector: () => Float32Array | undefined }
  | undefined {
  if (!refreshAllowed(ctx, prepared, staleCount, refreshFileLimit(ctx), refreshDeadline(ctx)))
    return undefined;
  const expected = ctx.repositoryPod.capsule.embeddingModelIdentity;
  let captured: Float32Array | undefined;
  return {
    vector: (): Float32Array | undefined => captured,
    observe: (observation): void => {
      if (
        semanticOperationStopped(ctx, prepared.signal) ||
        observation.query !== prepared.queryText ||
        observation.identity.modelId !== expected.modelId ||
        !assertCompatibleEmbeddingIdentity(expected, observation.identity).ok ||
        observation.vector.length !== expected.vectorDimensions ||
        !observation.vector.every(Number.isFinite)
      )
        return;
      captured = Float32Array.from(observation.vector);
    },
  };
}

function refreshFileLimit(ctx: SemanticRefreshOptions): number {
  const cap = ctx.semanticRefreshFilesMax;
  return cap !== undefined && Number.isInteger(cap) && cap >= 0
    ? Math.min(SEMANTIC_REFRESH_FILE_CAP, cap)
    : 0;
}

// Document embedding is a separate, explicit opt-in from query embedding. Missing, malformed,
// fractional, or negative values stay off; enabled requests still need a live elapsed budget.
function configuredRefreshFileLimit(deps: UiHandlerDeps, options: SemanticRefreshOptions): number {
  return refreshFileLimit({
    semanticRefreshFilesMax:
      options.semanticRefreshFilesMax ?? Number(deps.env.KEIKO_REPO_SEMANTIC_REFRESH_FILES_MAX),
  });
}

/** One logical ask shares these permits across its root leases, searches and follow-up. */
export function createSemanticRefreshDocumentBudget(
  deps: UiHandlerDeps,
): SemanticRefreshDocumentBudget {
  let remaining = configuredRefreshFileLimit(deps, {});
  return {
    remaining: (): number => remaining,
    tryReserve: (): boolean => {
      if (remaining === 0) return false;
      remaining -= 1;
      return true;
    },
  };
}

function refreshDeadline(ctx: SemanticRefreshOptions): number {
  const now = (ctx.nowMs ?? Date.now)();
  const deadline = ctx.deadlineAtMs;
  return deadline === undefined || Number.isNaN(deadline) ? now : Math.min(deadline, now + 5_000);
}

interface RefreshFragment {
  readonly document: CandidateDocument;
  readonly file: LiveFingerprintFile;
}

function boundedRefreshFile(file: LiveFingerprintFile | undefined): file is LiveFingerprintFile {
  return (
    file !== undefined &&
    Number.isSafeInteger(file.before.size) &&
    file.before.size >= 0 &&
    file.before.size <= SEMANTIC_REFRESH_FRAGMENT_BYTES
  );
}

function verifiedRefreshBytes(
  ctx: EmbeddingContext,
  file: LiveFingerprintFile,
  bytes: Uint8Array | undefined,
  deadlineAtMs: number,
): bytes is Uint8Array {
  return (
    bytes !== undefined &&
    !refreshStopped(ctx, ctx.signal, deadlineAtMs) &&
    bytes.byteLength === file.before.size &&
    !bytes.includes(0) &&
    isWorkspacePathSnapshotCurrent(ctx.fs, file.absolutePath, file.realPath, file.before)
  );
}

function observeRefreshRead(ctx: EmbeddingContext, size: number): void {
  if (ctx.refreshUsage === undefined) return;
  ctx.refreshUsage.readFileCount += 1;
  ctx.refreshUsage.readBytes += size;
}

function reserveRefreshRead(
  ctx: EmbeddingContext,
  file: LiveFingerprintFile,
  deadlineAtMs: number,
): boolean {
  if (
    refreshStopped(ctx, ctx.signal, deadlineAtMs) ||
    ctx.semanticRefreshDocumentBudget?.remaining() === 0 ||
    ctx.tryReserveRefreshUsage?.({ filesRead: 1, excerptBytes: file.before.size }) !== true
  )
    return false;
  if (refreshStopped(ctx, ctx.signal, deadlineAtMs)) return false;
  // Synchronous admission immediately precedes the read. A failed/cancelled attempt keeps its
  // permit: another root or a later pass must not reopen the original document allowance.
  return ctx.semanticRefreshDocumentBudget?.tryReserve() !== false;
}

async function liveRefreshFragment(
  ctx: EmbeddingContext,
  document: CandidateDocument,
  deadlineAtMs: number,
): Promise<RefreshFragment | undefined> {
  if (ctx.fs.readFileBytes === undefined) return undefined;
  try {
    const file = liveFingerprintFile(ctx, ctx.repositoryPod, document.scopePath);
    if (!boundedRefreshFile(file)) return undefined;
    if (!reserveRefreshRead(ctx, file, deadlineAtMs)) return undefined;
    const bytes = await readSemanticFileBytes(
      ctx,
      file,
      SEMANTIC_REFRESH_FRAGMENT_BYTES + 1,
      deadlineAtMs,
      () => {
        observeRefreshRead(ctx, file.before.size);
      },
    );
    if (!verifiedRefreshBytes(ctx, file, bytes, deadlineAtMs)) return undefined;
    const sourceText = ctx.redactText(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return { file, document: { ...document, sourceText, startLine: 1 } };
  } catch {
    recordSemanticRefreshFailure(ctx, deadlineAtMs);
    return undefined;
  }
}

function recordSemanticRefreshFailure(ctx: EmbeddingContext, deadlineAtMs: number): void {
  if (semanticOperationStopped(ctx) || refreshStopped(ctx, ctx.signal, deadlineAtMs)) return;
  observePodDegradation(ctx, "pod-query-failed");
}

function compatibleRefreshVector(
  identity: EmbeddingModelIdentity,
  outcome: OpenAIEmbeddingSuccess,
): Float32Array | undefined {
  if (outcome.vector.length === 0 || !outcome.vector.every(Number.isFinite)) return undefined;
  const current: EmbeddingModelIdentity = {
    ...identity,
    modelId: outcome.modelId,
    vectorDimensions: outcome.vector.length,
    ...(outcome.modelRevision === undefined ? {} : { modelRevision: outcome.modelRevision }),
  };
  if (!assertCompatibleEmbeddingIdentity(identity, current).ok) return undefined;
  return identity.normalization === "l2" ? l2NormalizeVector(outcome.vector) : outcome.vector;
}

function callRefreshEmbedding(
  ctx: EmbeddingContext,
  input: string,
  signal: AbortSignal,
  timeoutMs: number | undefined,
  inputTokens: number,
): Promise<OpenAIEmbeddingOutcome> {
  const adapter = ctx.localKnowledgeEmbeddingAdapter;
  const identity = ctx.repositoryPod.capsule.embeddingModelIdentity;
  if (ctx.refreshUsage !== undefined) {
    ctx.refreshUsage.embeddingCallCount += 1;
    ctx.refreshUsage.inputTokens += inputTokens;
  }
  return adapter.request({
    endpoint: adapter.endpoint,
    apiKey: adapter.apiKey,
    modelId: identity.modelId,
    input,
    ...(adapter.apiKeyHeaderName === undefined
      ? {}
      : { apiKeyHeaderName: adapter.apiKeyHeaderName }),
    ...(identity.dimensionsParam === undefined ? {} : { dimensions: identity.dimensionsParam }),
    ...(ctx.correlationId === undefined
      ? {}
      : { logContext: { correlationId: ctx.correlationId } }),
    signal,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

async function refreshEmbedding(
  ctx: EmbeddingContext,
  input: string,
  signal: AbortSignal | undefined,
  deadlineAtMs: number,
): Promise<Float32Array | undefined> {
  const identity = ctx.repositoryPod.capsule.embeddingModelIdentity;
  // UTF-8 bytes are a conservative token upper bound when no embedding tokenizer is available.
  const inputTokens = Buffer.byteLength(input, "utf8");
  if (
    refreshStopped(ctx, signal, deadlineAtMs) ||
    ctx.tryReserveRefreshUsage?.({ modelInputTokens: inputTokens }) !== true
  )
    return undefined;
  if (refreshStopped(ctx, signal, deadlineAtMs)) return undefined;
  const reservation = ctx.reserveRefreshSpend(input);
  try {
    const outcome = await raceAbortDeadline(
      ({ signal: boundedSignal, timeoutMs }) =>
        callRefreshEmbedding(ctx, input, boundedSignal, timeoutMs, inputTokens),
      { deadlineAtMs, nowMs: ctx.nowMs ?? Date.now, signal },
    );
    return outcome.ok ? compatibleRefreshVector(identity, outcome.value) : undefined;
  } finally {
    // The adapter has no measured token usage; preserve the existing durable upper reservation.
    reservation?.settle(undefined);
  }
}

function refreshMatch(
  ctx: EmbeddingContext,
  fragment: RefreshFragment,
  query: Float32Array,
  vector: Float32Array,
  terms: readonly string[],
): SemanticSearchMatch | undefined {
  if (
    !isWorkspacePathSnapshotCurrent(
      ctx.fs,
      fragment.file.absolutePath,
      fragment.file.realPath,
      fragment.file.before,
    )
  )
    return undefined;
  const metric = ctx.repositoryPod.capsule.embeddingModelIdentity.vectorMetric;
  const rawScore = scoreVector(metric, query, vector);
  const score = metric === "euclidean" ? 1 / (1 - rawScore) : Math.max(0, Math.min(1, rawScore));
  return Number.isFinite(score) && score > 0
    ? {
        scopePath: fragment.document.scopePath,
        line: localizeMatchLine(fragment.document.sourceText, terms),
        score,
      }
    : undefined;
}

async function refreshedSemanticHits(
  ctx: EmbeddingContext,
  prepared: PreparedSemanticSearch,
  stale: readonly CandidateDocument[],
  queryVector?: Float32Array,
): Promise<readonly SemanticSearchMatch[]> {
  const limit = refreshFileLimit(ctx);
  const deadlineAtMs = refreshDeadline(ctx);
  if (!refreshAllowed(ctx, prepared, stale.length, limit, deadlineAtMs)) return [];
  const hits: SemanticSearchMatch[] = [];
  try {
    const identity = ctx.repositoryPod.capsule.embeddingModelIdentity;
    const query =
      queryVector ??
      (await refreshEmbedding(
        ctx,
        shapeEmbeddingQuery(identity, prepared.queryText),
        prepared.signal,
        deadlineAtMs,
      ));
    if (query === undefined) return [];
    for (const document of stale.slice(0, limit)) {
      if (refreshStopped(ctx, prepared.signal, deadlineAtMs)) break;
      const hit = await refreshedDocumentHit(ctx, prepared, document, query, deadlineAtMs);
      if (hit !== undefined) hits.push(hit);
    }
  } catch {
    recordSemanticRefreshFailure(ctx, deadlineAtMs);
    return hits;
  }
  return hits;
}

function refreshStopped(
  ctx: SemanticRefreshOptions,
  signal: AbortSignal | undefined,
  deadlineAtMs: number,
): boolean {
  return (ctx.nowMs ?? Date.now)() >= deadlineAtMs || isAborted(signal);
}

function refreshAllowed(
  ctx: SemanticRefreshOptions,
  prepared: PreparedSemanticSearch,
  staleCount: number,
  limit: number,
  deadlineAtMs: number,
): boolean {
  return (
    ctx.tryReserveRefreshUsage !== undefined &&
    ctx.semanticRefreshDocumentBudget?.remaining() !== 0 &&
    limit > 0 &&
    staleCount > 0 &&
    !refreshStopped(ctx, prepared.signal, deadlineAtMs)
  );
}

async function refreshedDocumentHit(
  ctx: EmbeddingContext,
  prepared: PreparedSemanticSearch,
  document: CandidateDocument,
  query: Float32Array,
  deadlineAtMs: number,
): Promise<SemanticSearchMatch | undefined> {
  const fragment = await liveRefreshFragment(ctx, document, deadlineAtMs);
  if (fragment === undefined || refreshStopped(ctx, prepared.signal, deadlineAtMs))
    return undefined;
  const vector = await refreshEmbedding(
    ctx,
    `Path: ${document.scopePath}\n${fragment.document.sourceText}`,
    prepared.signal,
    deadlineAtMs,
  );
  return vector === undefined || refreshStopped(ctx, prepared.signal, deadlineAtMs)
    ? undefined
    : refreshMatch(ctx, fragment, query, vector, prepared.queryTerms);
}

// Reports the resolved pod's identity to a caller that asked for it, and returns the resolution
// unchanged. Never resolves anything itself: the identity a caller discloses must be the identity
// the search actually used.
function observedPodIdentity(
  resolution: RepositoryPodResolution,
  observe: ConfiguredRepoSemanticSearchOptions["observePodIdentity"],
): RepositoryPodResolution {
  if (resolution.kind === "ready") {
    observe?.({ capsuleId: resolution.pod.capsule.id, sourceId: resolution.pod.source.id });
  }
  return resolution;
}

function refreshSpendReserver(
  deps: UiHandlerDeps,
  config: ReturnType<typeof currentGatewayConfig>,
  modelId: string,
  correlationId: string | undefined,
): EmbeddingContext["reserveRefreshSpend"] {
  const capability = config?.capabilities?.find(
    (candidate) => candidate.kind === "embedding" && candidate.id === modelId,
  );
  const correlation = correlationIdOrUnknown(correlationId);
  return (input) =>
    reserveGatewaySpendForAttempt(
      deps.env,
      capability,
      { modelId, messages: [{ role: "user", content: input }], maxOutputTokens: 0 },
      correlation,
    );
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
  const repositoryPod = observedPodIdentity(
    resolveRepositoryPod(options.repositoryPod, fs, provider.modelId),
    options.observePodIdentity,
  );
  if (repositoryPod.kind !== "ready") {
    observePodDegradation(
      options,
      repositoryPod.kind === "failed" ? "pod-unavailable" : "pod-absent",
    );
    return undefined;
  }
  const ctx: EmbeddingContext = {
    ...options,
    semanticRefreshFilesMax: configuredRefreshFileLimit(deps, options),
    fs,
    redactText: (text): string => String(deps.redactor(text)),
    signal,
    maxCandidates: Math.max(
      0,
      Math.min(MAX_SEMANTIC_CANDIDATES, options.maxCandidates ?? MAX_SEMANTIC_CANDIDATES),
    ),
    localKnowledgeEmbeddingAdapter: localKnowledgeEmbeddingAdapterForProvider(deps, provider),
    reserveRefreshSpend: refreshSpendReserver(
      deps,
      config,
      provider.modelId,
      options.correlationId,
    ),
    repositoryPod: repositoryPod.pod,
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
  options: ConfiguredRepoSemanticSearchOptions = {},
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
    let indexIdentityDigest: string | undefined;
    const provider = configuredRepoSemanticSearchProviderFor(deps, signal, {
      ...options,
      repositoryPod: {
        store: opened.store,
        repositoryRoot,
        vectorIndex: podVectorIndex,
      },
      observePodIdentity: (identity): void => {
        indexIdentityDigest = createHash("sha256")
          .update(`${identity.capsuleId}\n${identity.sourceId}`)
          .digest("hex");
        options.observePodIdentity?.(identity);
      },
    });
    return {
      provider,
      ...(indexIdentityDigest === undefined ? {} : { indexIdentityDigest }),
      close: (): void => {
        opened.close();
      },
    };
  } catch {
    return { provider: undefined, close: () => undefined };
  }
}
