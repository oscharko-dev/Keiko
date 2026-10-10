import { Buffer } from "node:buffer";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import {
  readWorkspaceFileTextForInternalUse,
  type InternalWorkspaceTextRead,
} from "./discovery.js";
import type { CodeIntelligenceIndex } from "./codeIntelligence.js";
import { buildCodeIntelligenceIndexFromCandidates } from "./codeIntelligence.js";
import { buildEndpointContractGraphFromCandidates } from "./endpointContractGraph.js";
import { endpointSourcePreferences } from "./endpointContractSource.js";
import type { EndpointContractGraph } from "./endpointContractTypes.js";
import { PathDeniedError, PathEscapeError } from "./errors.js";
import type { WorkspaceFs } from "./fs.js";
import { buildImportGraphFromCandidates, type ImportGraph } from "./importGraphEdges.js";
import { resolveWithinWorkspace } from "./paths.js";
import { containedRealPathInfo, isCanonicalAllowedContainedPath } from "./realpath.js";
import {
  createRequestLocalSearchTextSessionPool,
  findFiles,
  findFilesBatch,
  type FilenameSearchRequest,
  type RequestLocalSearchTextSessionPool,
  type SearchLimits,
  type SearchResult,
  type SearchScope,
} from "./repoSearch.js";
import type { SearchHints, SearchPolicy } from "./repoSearchPolicy.js";
import type { SemanticSearchProvider } from "./repoSearchSemantic.js";
import {
  CONTENT_PRESCORE_MAX_BYTES,
  candidateInventoryFileLimit,
  deriveCandidateSetFromInventory,
  gatherCandidatesWithControl,
  gatherCandidatesWithoutContentPrescore,
  readCandidateContentPreviewWithMetadata,
  type CandidateSet,
} from "./repoSearchScan.js";
import { buildSymbolGraphFromCandidates } from "./symbolGraphBuild.js";
import type { SymbolGraph } from "./symbolGraphTypes.js";
import {
  isWorkspaceIndexFileMetadataCurrent,
  workspaceIndexFileMetadata,
  type WorkspaceIndex,
  type WorkspaceIndexDiscoveredFile,
} from "./workspaceIndex.js";
import type { DiscoveredFile } from "./types.js";
import {
  assertStructuralExecutionActive,
  createStructuralExecutionControl,
  executionControlledWorkspaceFs,
  sameStructuralExecutionFs,
  structuralExecutionStopped,
  StructuralExecutionStoppedError,
  type StructuralExecutionControl,
} from "./structuralExecution.js";

/**
 * Query-invariant structural products shared only for the lifetime of one retrieval request.
 *
 * The context is intentionally request-local and memory-only. It is not a second persistent
 * workspace index: the factory closes over the exact scope, limits and filesystem seam, memoizes
 * contained candidate inventories and query-invariant structural products by their exact
 * request-local binding, and releases everything with the request.
 */
export interface StructuralAdapterRequestContext {
  readonly assertGraphBinding: (scope: SearchScope, limits: SearchLimits, fs: WorkspaceFs) => void;
  readonly candidatePaths: () => readonly string[];
  readonly skippedSymbolicLinks: () => readonly string[];
  readonly candidateLimitReached: () => boolean;
  readonly codeIntelligenceIndex: () => Promise<CodeIntelligenceIndex>;
  readonly isCodeIntelligenceSourceCurrent: (scopePath: string) => boolean;
  readonly symbolGraph: () => Promise<SymbolGraph>;
  readonly importGraph: () => Promise<ImportGraph>;
  readonly endpointContractGraph: (
    preferredSourcePaths?: readonly string[],
  ) => Promise<EndpointContractGraph>;
  readonly findFiles: (
    query: RetrievalQuery,
    limits: SearchLimits,
    deps?: StructuralRequestSearchDeps,
  ) => Promise<SearchResult>;
  readonly findFilesBatch: (
    requests: readonly FilenameSearchRequest[],
    deps?: Pick<StructuralRequestSearchDeps, "signal" | "searchHints">,
  ) => Promise<readonly SearchResult[]>;
  readonly searchText: (
    query: RetrievalQuery,
    limits: SearchLimits,
    deps?: StructuralRequestSearchDeps,
  ) => Promise<SearchResult>;
  readonly diagnostics: () => StructuralRequestContextDiagnostics;
}

export interface StructuralRequestSearchDeps {
  readonly filePatternGroups?:
    { readonly patterns: readonly string[]; readonly maxMatchesPerPattern: number } | undefined;
  readonly searchHints?: SearchHints | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly workspaceIndex?: WorkspaceIndex | undefined;
  readonly semanticSearchProvider?: SemanticSearchProvider | undefined;
}

export interface StructuralAdapterRequestContextDeps {
  readonly nowMs?: (() => number) | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly deadlineAtMs?: number | undefined;
  readonly isCandidateAllowed?: ((scopePath: string) => boolean) | undefined;
}

export interface StructuralRequestContextDiagnostics {
  readonly candidateInventoryBuildCount: number;
  readonly candidateFileCount: number;
  readonly candidateDirectoryCount: number;
  readonly codeIndexBuildCount: number;
  readonly symbolGraphBuildCount: number;
  readonly importGraphBuildCount: number;
  readonly endpointGraphBuildCount: number;
  readonly fileSearchCount: number;
  readonly textSearchCount: number;
}

type CandidateInventoryState =
  | { readonly status: "empty" }
  | { readonly status: "ready"; readonly candidates: CandidateSet }
  | { readonly status: "failed"; readonly error: unknown };

interface CachedCandidateContentPreview {
  readonly content: string | null | undefined;
  readonly completeEvidence?: CompleteStructuralSource | undefined;
  readonly file: DiscoveredFile;
  readonly metadata: WorkspaceIndexDiscoveredFile | undefined;
  readonly validatedFor: StructuralExecutionControl;
}

interface CandidateContentSnapshot {
  readonly metadata: WorkspaceIndexDiscoveredFile;
  readonly canonicalRoot: string;
}

interface CompleteStructuralSource extends CandidateContentSnapshot {
  readonly content: string;
  readonly sizeBytes: number;
  readonly encodedBytes: number;
}

// These are new aggregate bounds, not a claim about the existing preview Map.
const COMPLETE_STRUCTURAL_SOURCE_FILES_MAX = 512;
const COMPLETE_STRUCTURAL_SOURCE_BYTES_MAX = 32 * 1_024 * 1_024;

type CachedContentPreviewResolution =
  | { readonly status: "reused"; readonly content: string | undefined }
  | { readonly status: "read"; readonly file: DiscoveredFile };

function rethrowPreviewValidationBoundary(error: unknown): void {
  if (
    error instanceof PathDeniedError ||
    error instanceof PathEscapeError ||
    error instanceof StructuralExecutionStoppedError
  ) {
    throw error;
  }
}

function currentCandidateContentSnapshot(
  scope: SearchScope,
  file: DiscoveredFile,
  fs: WorkspaceFs,
): CandidateContentSnapshot | undefined {
  try {
    const absolutePath = resolveWithinWorkspace(scope.workspace.root, file.relativePath);
    const contained = containedRealPathInfo(fs, scope.workspace.root, absolutePath);
    if (!isCanonicalAllowedContainedPath(contained, scope.workspace.root, file.relativePath)) {
      throw new PathDeniedError(
        "refusing to validate a denied or non-canonical workspace path",
        file.relativePath,
      );
    }
    const stat = fs.stat(contained.path);
    if (!stat.isFile || stat.isSymbolicLink || stat.hardLinkCount !== 1) return undefined;
    return {
      metadata: workspaceIndexFileMetadata(file.relativePath, stat),
      canonicalRoot: contained.realBase,
    };
  } catch (error) {
    rethrowPreviewValidationBoundary(error);
    return undefined;
  }
}

function currentCandidateContentMetadata(
  scope: SearchScope,
  file: DiscoveredFile,
  fs: WorkspaceFs,
): WorkspaceIndexDiscoveredFile | undefined {
  return currentCandidateContentSnapshot(scope, file, fs)?.metadata;
}

function searchLimitsKey(limits: SearchLimits): string {
  return JSON.stringify([
    limits.maxFilesScanned,
    limits.maxMatchesReturned,
    limits.maxBytesPerFileScanned,
    limits.elapsedMsMax,
  ]);
}

function searchScopeKey(scope: SearchScope): string {
  return JSON.stringify(scope);
}

function immutableSearchScope(scope: SearchScope): SearchScope {
  return {
    scopeId: scope.scopeId,
    relativePaths: [...scope.relativePaths],
    workspace: {
      ...scope.workspace,
      sourceDirs: [...scope.workspace.sourceDirs],
      testDirs: [...scope.workspace.testDirs],
      languages: [...scope.workspace.languages],
      ignoreLines: [...scope.workspace.ignoreLines],
    },
  };
}

// A per-call search must abort when either the request context or the individual call aborts, but
// `AbortSignal.any` allocates a follower on every call, so the two degenerate cases (no parent
// signal / the same signal on both sides, and no call signal) reuse the existing signal instead.
function combinedAbortSignal(
  parentSignal: AbortSignal | undefined,
  callSignal: AbortSignal | undefined,
): AbortSignal | undefined {
  if (parentSignal === undefined || parentSignal === callSignal) return callSignal;
  if (callSignal === undefined) return parentSignal;
  return AbortSignal.any([parentSignal, callSignal]);
}

class DefaultStructuralAdapterRequestContext implements StructuralAdapterRequestContext {
  private readonly scope: SearchScope;
  private readonly limits: SearchLimits;
  private readonly boundScopeKey: string;
  private readonly boundLimitsKey: string;
  private readonly executionControl: StructuralExecutionControl;
  private readonly executionFs: WorkspaceFs;
  private readonly isCandidateAllowed: ((scopePath: string) => boolean) | undefined;
  private candidateState: CandidateInventoryState = { status: "empty" };
  private readonly queryCandidateStates = new Map<string, CandidateInventoryState>();
  private readonly contentPreviews = new Map<string, CachedCandidateContentPreview>();
  private readonly retainedSourcePaths = new Set<string>();
  private readonly staleContentPreviewPaths = new Set<string>();
  private readonly searchTextSessions: RequestLocalSearchTextSessionPool =
    createRequestLocalSearchTextSessionPool();
  private hasGitMetadata: boolean | undefined;
  private paths: readonly string[] | undefined;
  private symbolicLinks: readonly string[] | undefined;
  private codeIndexPromise: Promise<CodeIntelligenceIndex> | undefined;
  private readonly codeIndexSourceSnapshots = new Map<string, CandidateContentSnapshot>();
  private symbolGraphPromise: Promise<SymbolGraph> | undefined;
  private importGraphPromise: Promise<ImportGraph> | undefined;
  private endpointGraphState:
    { readonly key: string; readonly promise: Promise<EndpointContractGraph> } | undefined;
  private candidateInventoryBuildCount = 0;
  private candidateFileCount = 0;
  private candidateDirectoryCount = 0;
  private codeIndexBuildCount = 0;
  private symbolGraphBuildCount = 0;
  private importGraphBuildCount = 0;
  private endpointGraphBuildCount = 0;
  private fileSearchCount = 0;
  private textSearchCount = 0;

  public constructor(
    private readonly boundScope: SearchScope,
    boundLimits: SearchLimits,
    private readonly fs: WorkspaceFs,
    deps: StructuralAdapterRequestContextDeps,
  ) {
    this.scope = immutableSearchScope(boundScope);
    this.limits = { ...boundLimits };
    this.boundScopeKey = searchScopeKey(boundScope);
    this.boundLimitsKey = searchLimitsKey(boundLimits);
    this.executionControl = createStructuralExecutionControl(
      boundLimits.elapsedMsMax,
      deps.nowMs ?? Date.now,
      deps.signal,
      deps.deadlineAtMs,
    );
    this.executionFs = executionControlledWorkspaceFs(this.fs, this.executionControl);
    this.isCandidateAllowed = deps.isCandidateAllowed;
  }

  private candidateSet(): CandidateSet {
    if (this.candidateState.status === "ready")
      return this.allowedCandidates(this.candidateState.candidates);
    if (this.candidateState.status === "failed") throw this.candidateState.error;
    try {
      this.candidateInventoryBuildCount += 1;
      const candidates = gatherCandidatesWithControl(
        this.scope,
        this.limits,
        this.executionFs,
        this.executionControl,
      );
      this.recordCandidateInventory(candidates);
      this.candidateState = { status: "ready", candidates };
      return this.allowedCandidates(candidates);
    } catch (error) {
      this.candidateState = { status: "failed", error };
      throw error;
    }
  }

  private allowedCandidates(candidates: CandidateSet): CandidateSet {
    const isAllowed = this.isCandidateAllowed;
    return isAllowed === undefined
      ? candidates
      : { ...candidates, files: candidates.files.filter((file) => isAllowed(file.relativePath)) };
  }

  private recordCandidateInventory(candidates: CandidateSet): void {
    this.candidateFileCount += candidates.files.length;
    this.candidateDirectoryCount += candidates.directories.length;
  }

  private candidateKey(query: RetrievalQuery, limits: SearchLimits, policy: SearchPolicy): string {
    return JSON.stringify([
      candidateInventoryFileLimit(this.scope, query, limits),
      limits.elapsedMsMax,
      policy.applyGitignore,
      policy.omitLowValueWorkspaceFiles,
      policy.lowValuePathAllowlist,
    ]);
  }

  private queryCandidateSet(
    query: RetrievalQuery,
    limits: SearchLimits,
    policy: SearchPolicy,
    candidatePathPredicate?: (scopePath: string) => boolean,
    executionControl?: StructuralExecutionControl,
    prescoreContent?: boolean,
  ): CandidateSet {
    this.assertInventoryCovers(limits);
    const control = executionControl ?? this.executionControl;
    const key = this.candidateKey(query, limits, policy);
    const current = this.queryCandidateStates.get(key);
    if (current?.status === "failed") throw current.error;
    let inventory = current?.status === "ready" ? current.candidates : undefined;
    if (inventory === undefined) {
      this.candidateInventoryBuildCount += 1;
      try {
        inventory = gatherCandidatesWithoutContentPrescore(
          this.scope,
          query,
          limits,
          this.executionFs,
          policy,
          control,
        );
        if (!structuralExecutionStopped(control)) {
          this.queryCandidateStates.set(key, { status: "ready", candidates: inventory });
        }
        this.recordCandidateInventory(inventory);
      } catch (error) {
        this.queryCandidateStates.set(key, { status: "failed", error });
        throw error;
      }
    }
    return deriveCandidateSetFromInventory({
      scope: this.scope,
      query,
      limits,
      fs: this.executionFs,
      policy,
      inventory: this.allowedCandidates(inventory),
      candidatePathPredicate,
      contentPreviewFor: (file) => this.contentPreview(file, control),
      executionControl: control,
      prescoreContent,
    });
  }

  private contentPreview(
    file: DiscoveredFile,
    control: StructuralExecutionControl,
  ): string | undefined {
    if (structuralExecutionStopped(control)) return undefined;
    if (this.isCandidateAllowed?.(file.relativePath) === false) return undefined;
    const resolution = this.resolveCachedContentPreview(file, control);
    if (resolution.status === "reused") return resolution.content;
    const previewFile = resolution.file;
    const preview = readCandidateContentPreviewWithMetadata(
      this.scope,
      previewFile,
      this.executionFs,
    );
    const metadata = this.contentPreviewMetadata(previewFile, preview.metadata);
    if (preview.content === undefined && metadata === undefined) return undefined;
    this.contentPreviews.set(file.relativePath, {
      completeEvidence: this.compatibleCompleteEvidence(file.relativePath, metadata),
      content: preview.content ?? null,
      file: previewFile,
      metadata,
      validatedFor: control,
    });
    return preview.content;
  }

  private resolveCachedContentPreview(
    file: DiscoveredFile,
    control: StructuralExecutionControl,
  ): CachedContentPreviewResolution {
    const cached = this.contentPreviews.get(file.relativePath);
    if (cached?.content === undefined) return { status: "read", file };
    if (cached.validatedFor === control) {
      return { status: "reused", content: cached.content ?? undefined };
    }
    const current = currentCandidateContentMetadata(this.scope, file, this.executionFs);
    if (current !== undefined && isWorkspaceIndexFileMetadataCurrent(cached.metadata, current)) {
      this.contentPreviews.set(file.relativePath, { ...cached, validatedFor: control });
      return { status: "reused", content: cached.content ?? undefined };
    }
    this.staleContentPreviewPaths.add(file.relativePath);
    this.contentPreviews.delete(file.relativePath);
    return {
      status: "read",
      file: current === undefined ? file : { ...file, sizeBytes: current.sizeBytes },
    };
  }

  private compatibleCompleteEvidence(
    scopePath: string,
    metadata: WorkspaceIndexDiscoveredFile | undefined,
  ): CompleteStructuralSource | undefined {
    const complete = this.contentPreviews.get(scopePath)?.completeEvidence;
    return metadata !== undefined &&
      isWorkspaceIndexFileMetadataCurrent(complete?.metadata, metadata)
      ? complete
      : undefined;
  }

  private assertSourceAllowed(scopePath: string): void {
    assertStructuralExecutionActive(this.executionControl);
    if (this.isCandidateAllowed?.(scopePath) === false) {
      throw new PathDeniedError("structural source is no longer eligible", scopePath);
    }
  }

  private sourceSnapshot(scopePath: string): CandidateContentSnapshot | undefined {
    this.assertSourceAllowed(scopePath);
    const snapshot = currentCandidateContentSnapshot(
      this.scope,
      { relativePath: scopePath, sizeBytes: 0 },
      this.executionFs,
    );
    this.assertSourceAllowed(scopePath);
    return snapshot;
  }

  private cachedCompleteSource(scopePath: string, maxBytes: number): string | undefined {
    const complete = this.contentPreviews.get(scopePath)?.completeEvidence;
    if (complete === undefined || complete.sizeBytes > maxBytes) return undefined;
    const before = this.sourceSnapshot(scopePath);
    if (!this.sameCompleteSnapshot(complete, before)) return undefined;
    const after = this.sourceSnapshot(scopePath);
    return this.sameCompleteSnapshot(complete, after) ? complete.content : undefined;
  }

  private sameCompleteSnapshot(
    complete: CompleteStructuralSource,
    snapshot: CandidateContentSnapshot | undefined,
  ): boolean {
    return (
      complete.canonicalRoot === snapshot?.canonicalRoot &&
      isWorkspaceIndexFileMetadataCurrent(complete.metadata, snapshot.metadata)
    );
  }

  private canRetainCompleteSource(scopePath: string, encodedBytes: number): boolean {
    if (
      !this.retainedSourcePaths.has(scopePath) &&
      this.retainedSourcePaths.size >= COMPLETE_STRUCTURAL_SOURCE_FILES_MAX
    )
      return false;
    let retainedBytes = 0;
    for (const path of this.retainedSourcePaths) {
      if (path !== scopePath)
        retainedBytes += this.contentPreviews.get(path)?.completeEvidence?.encodedBytes ?? 0;
    }
    return retainedBytes + encodedBytes <= COMPLETE_STRUCTURAL_SOURCE_BYTES_MAX;
  }

  private retainCompleteSource(scopePath: string, read: InternalWorkspaceTextRead): void {
    const snapshot = read.snapshot;
    if (
      snapshot === undefined ||
      read.sizeBytes !== read.stat.size ||
      read.sizeBytes > CONTENT_PRESCORE_MAX_BYTES
    )
      return;
    const metadata = workspaceIndexFileMetadata(scopePath, read.stat);
    if (
      !isWorkspaceIndexFileMetadataCurrent(
        workspaceIndexFileMetadata(scopePath, snapshot.before),
        metadata,
      )
    )
      return;
    if (
      !isWorkspaceIndexFileMetadataCurrent(
        workspaceIndexFileMetadata(scopePath, snapshot.descriptor),
        metadata,
      )
    )
      return;
    const encodedBytes = Buffer.byteLength(read.content, "utf8");
    if (!this.canRetainCompleteSource(scopePath, encodedBytes)) return;
    this.retainedSourcePaths.add(scopePath);
    const previous = this.contentPreviews.get(scopePath);
    this.contentPreviews.set(scopePath, {
      ...previous,
      content: isWorkspaceIndexFileMetadataCurrent(previous?.metadata, metadata)
        ? previous?.content
        : undefined,
      file: { relativePath: scopePath, sizeBytes: read.sizeBytes },
      metadata,
      validatedFor: this.executionControl,
      completeEvidence: {
        canonicalRoot: snapshot.canonicalRoot,
        metadata,
        content: read.content,
        sizeBytes: read.sizeBytes,
        encodedBytes,
      },
    });
  }

  private readCompleteStructuralSource(
    scopePath: string,
    maxBytes: number,
  ): InternalWorkspaceTextRead {
    this.assertSourceAllowed(scopePath);
    const read = readWorkspaceFileTextForInternalUse(
      this.scope.workspace,
      scopePath,
      { maxBytes },
      this.executionFs,
      "evidence",
      true,
      () => {
        this.assertSourceAllowed(scopePath);
      },
    );
    this.assertSourceAllowed(scopePath);
    return read;
  }

  private captureCodeIndexSource(scopePath: string, read: InternalWorkspaceTextRead): void {
    const snapshot = read.snapshot;
    const metadata = workspaceIndexFileMetadata(scopePath, read.stat);
    if (
      snapshot === undefined ||
      read.sizeBytes !== read.stat.size ||
      this.codeIndexSourceSnapshots.size >= Math.max(0, this.limits.maxFilesScanned ?? 2048)
    )
      return;
    if (
      !isWorkspaceIndexFileMetadataCurrent(
        workspaceIndexFileMetadata(scopePath, snapshot.before),
        metadata,
      ) ||
      !isWorkspaceIndexFileMetadataCurrent(
        workspaceIndexFileMetadata(scopePath, snapshot.descriptor),
        metadata,
      )
    )
      return;
    this.codeIndexSourceSnapshots.set(scopePath, {
      canonicalRoot: snapshot.canonicalRoot,
      metadata,
    });
  }

  private codeIntelligenceSource(scopePath: string, maxBytes: number): string {
    const read = this.readCompleteStructuralSource(scopePath, maxBytes);
    this.captureCodeIndexSource(scopePath, read);
    this.retainCompleteSource(scopePath, read);
    return read.content;
  }

  public isCodeIntelligenceSourceCurrent(scopePath: string): boolean {
    const indexed = this.codeIndexSourceSnapshots.get(scopePath);
    if (indexed === undefined || this.isCandidateAllowed?.(scopePath) === false) return false;
    const current = this.sourceSnapshot(scopePath);
    return (
      indexed.canonicalRoot === current?.canonicalRoot &&
      isWorkspaceIndexFileMetadataCurrent(indexed.metadata, current.metadata)
    );
  }

  private endpointSource(scopePath: string, maxBytes: number): string {
    this.assertSourceAllowed(scopePath);
    return (
      this.cachedCompleteSource(scopePath, maxBytes) ??
      this.readCompleteStructuralSource(scopePath, maxBytes).content
    );
  }

  private contentPreviewMetadata(
    file: DiscoveredFile,
    metadata: WorkspaceIndexDiscoveredFile | undefined,
  ): WorkspaceIndexDiscoveredFile | undefined {
    if (metadata !== undefined) return metadata;
    return file.sizeBytes > CONTENT_PRESCORE_MAX_BYTES
      ? currentCandidateContentMetadata(this.scope, file, this.executionFs)
      : undefined;
  }

  private validateCachedContentPreviews(control: StructuralExecutionControl): void {
    // The snapshot is deliberate and must not become a direct `this.contentPreviews.values()` walk
    // (S7747): revalidating a stale entry deletes its key and re-inserts it (see `contentPreview`
    // via `resolveCachedContentPreview`), which moves it to the end of a LIVE Map iteration and
    // makes the loop visit it a second time. Each extra visit spends another
    // `structuralExecutionStopped` clock read against the caller's deadline, so iterating live
    // would let a re-read entry shorten the budget the rest of the cache is validated under.
    const pending = [...this.contentPreviews.values()];
    for (const cached of pending) {
      if (cached.content === undefined) continue;
      if (structuralExecutionStopped(control)) return;
      this.contentPreview(cached.file, control);
    }
  }

  private reconcileContentPreviews(
    entries: readonly WorkspaceIndexDiscoveredFile[],
    missingPaths: readonly string[],
  ): void {
    for (const scopePath of missingPaths) this.contentPreviews.delete(scopePath);
    for (const entry of entries) {
      const cached = this.contentPreviews.get(entry.scopePath);
      if (cached !== undefined && !isWorkspaceIndexFileMetadataCurrent(cached.metadata, entry)) {
        this.contentPreviews.delete(entry.scopePath);
      }
    }
  }

  private cachedCandidateContent(scopePath: string): string | undefined {
    if (this.isCandidateAllowed?.(scopePath) === false) return undefined;
    return this.contentPreviews.get(scopePath)?.content ?? undefined;
  }

  private drainStaleContentPreviewPaths(): readonly string[] {
    const paths = [...this.staleContentPreviewPaths];
    this.staleContentPreviewPaths.clear();
    return paths;
  }

  public candidatePaths(): readonly string[] {
    this.paths ??= this.candidateSet().files.map((file) => file.relativePath);
    const isAllowed = this.isCandidateAllowed;
    return isAllowed === undefined ? this.paths : this.paths.filter(isAllowed);
  }

  public skippedSymbolicLinks(): readonly string[] {
    this.symbolicLinks ??= this.candidateSet().skippedSymbolicLinks;
    return this.symbolicLinks;
  }

  public candidateLimitReached(): boolean {
    return this.candidateSet().truncated;
  }

  public codeIntelligenceIndex(): Promise<CodeIntelligenceIndex> {
    this.codeIndexPromise ??= Promise.resolve().then(() => {
      this.codeIndexBuildCount += 1;
      return buildCodeIntelligenceIndexFromCandidates(
        this.scope,
        this.limits,
        this.executionFs,
        this.candidateSet(),
        {
          executionControl: this.executionControl,
          disableCache: true,
          readSource: (path, maxBytes) => this.codeIntelligenceSource(path, maxBytes),
          assertSourceAllowed: (path) => {
            this.assertSourceAllowed(path);
          },
        },
      );
    });
    return this.codeIndexPromise;
  }

  public symbolGraph(): Promise<SymbolGraph> {
    this.symbolGraphPromise ??= Promise.resolve().then(() => {
      this.symbolGraphBuildCount += 1;
      return buildSymbolGraphFromCandidates(
        this.scope,
        this.limits,
        this.executionFs,
        this.candidateSet(),
        undefined,
        this.executionControl,
      );
    });
    return this.symbolGraphPromise;
  }

  public importGraph(): Promise<ImportGraph> {
    this.importGraphPromise ??= Promise.resolve().then(() => {
      this.importGraphBuildCount += 1;
      return buildImportGraphFromCandidates(
        this.scope,
        this.limits,
        this.executionFs,
        this.candidateSet(),
        this.executionControl,
      );
    });
    return this.importGraphPromise;
  }

  private failedEndpointGraph(error: unknown): Promise<EndpointContractGraph> {
    if (this.endpointGraphState?.key === "unavailable") return this.endpointGraphState.promise;
    this.endpointGraphBuildCount += 1;
    const reason =
      error instanceof Error
        ? error
        : new Error("structural inventory unavailable", { cause: error });
    const promise = Promise.reject<EndpointContractGraph>(reason);
    this.endpointGraphState = { key: "unavailable", promise };
    return promise;
  }

  public endpointContractGraph(
    preferredSourcePaths: readonly string[] = [],
  ): Promise<EndpointContractGraph> {
    let candidates: CandidateSet;
    try {
      candidates = this.candidateSet();
    } catch (error) {
      return this.failedEndpointGraph(error);
    }
    const preferences = endpointSourcePreferences(candidates, this.limits, preferredSourcePaths);
    const key = JSON.stringify(preferences);
    if (this.endpointGraphState?.key === key) return this.endpointGraphState.promise;
    const promise = Promise.resolve().then(() => {
      this.endpointGraphBuildCount += 1;
      return buildEndpointContractGraphFromCandidates(
        this.scope,
        this.limits,
        this.executionFs,
        candidates,
        this.executionControl,
        {
          preferredSourcePaths: preferences,
          readSource: (path, maxBytes) => this.endpointSource(path, maxBytes),
          isCandidateAllowed: (path) => this.isCandidateAllowed?.(path) !== false,
        },
      );
    });
    this.endpointGraphState = { key, promise };
    return promise;
  }

  private assertInventoryCovers(limits: SearchLimits): void {
    if (
      (limits.maxFilesScanned ?? Infinity) > (this.limits.maxFilesScanned ?? Infinity) ||
      limits.maxMatchesReturned > this.limits.maxMatchesReturned ||
      limits.maxBytesPerFileScanned > this.limits.maxBytesPerFileScanned ||
      (limits.elapsedMsMax ?? Infinity) > (this.limits.elapsedMsMax ?? Infinity)
    ) {
      throw new RangeError("request context does not cover the requested search limits");
    }
  }

  private searchControl(
    limits: SearchLimits,
    deps: StructuralRequestSearchDeps,
  ): StructuralExecutionControl {
    const nowMs = this.executionControl.nowMs;
    const callDeadlineAtMs = nowMs() + Math.max(0, limits.elapsedMsMax ?? Infinity);
    const signal = combinedAbortSignal(this.executionControl.signal, deps.signal);
    return {
      nowMs,
      deadlineAtMs: Math.min(this.executionControl.deadlineAtMs, callDeadlineAtMs),
      ...(signal === undefined ? {} : { signal }),
    };
  }

  public assertGraphBinding(scope: SearchScope, limits: SearchLimits, fs: WorkspaceFs): void {
    if (
      scope !== this.boundScope ||
      !sameStructuralExecutionFs(fs, this.fs) ||
      searchScopeKey(scope) !== this.boundScopeKey ||
      searchLimitsKey(limits) !== this.boundLimitsKey
    ) {
      throw new TypeError("structural request context binding mismatch");
    }
  }

  private searchHints(hints: SearchHints | undefined): SearchHints {
    if (structuralExecutionStopped(this.executionControl))
      return { ...hints, hasGitMetadata: false };
    this.hasGitMetadata ??= this.executionFs.exists(
      resolveWithinWorkspace(this.scope.workspace.root, ".git"),
    );
    return { ...hints, hasGitMetadata: this.hasGitMetadata };
  }

  public findFiles(
    query: RetrievalQuery,
    limits: SearchLimits,
    deps: StructuralRequestSearchDeps = {},
  ): Promise<SearchResult> {
    this.assertInventoryCovers(limits);
    this.fileSearchCount += 1;
    return Promise.resolve().then(() => {
      const control = this.searchControl(limits, deps);
      return findFiles(this.scope, query, limits, {
        fs: this.executionFs,
        nowMs: this.executionControl.nowMs,
        deadlineAtMs: control.deadlineAtMs,
        searchHints: this.searchHints(deps.searchHints),
        ...(deps.filePatternGroups === undefined
          ? {}
          : { filePatternGroups: deps.filePatternGroups }),
        ...(control.signal === undefined ? {} : { signal: control.signal }),
        ...(deps.workspaceIndex === undefined ? {} : { workspaceIndex: deps.workspaceIndex }),
        ...(deps.semanticSearchProvider === undefined
          ? {}
          : { semanticSearchProvider: deps.semanticSearchProvider }),
        candidateSetFor: (candidateQuery, candidateLimits, policy, predicate, prescoreContent) =>
          this.queryCandidateSet(
            candidateQuery,
            candidateLimits,
            policy,
            predicate,
            control,
            prescoreContent,
          ),
      });
    });
  }

  public async findFilesBatch(
    requests: readonly FilenameSearchRequest[],
    deps: Pick<StructuralRequestSearchDeps, "signal" | "searchHints"> = {},
  ): Promise<readonly SearchResult[]> {
    for (const request of requests) this.assertInventoryCovers(request.limits);
    const first = requests[0];
    if (first === undefined) return [];
    const control = this.searchControl(first.limits, deps);
    this.fileSearchCount += requests.length;
    return findFilesBatch(this.scope, requests, {
      fs: this.executionFs,
      nowMs: this.executionControl.nowMs,
      deadlineAtMs: control.deadlineAtMs,
      searchHints: this.searchHints(deps.searchHints),
      ...(control.signal === undefined ? {} : { signal: control.signal }),
    });
  }

  public searchText(
    query: RetrievalQuery,
    limits: SearchLimits,
    deps: StructuralRequestSearchDeps = {},
  ): Promise<SearchResult> {
    this.assertInventoryCovers(limits);
    this.textSearchCount += 1;
    return Promise.resolve().then(() => {
      const control = this.searchControl(limits, deps);
      return this.searchTextSessions.searchText(this.scope, query, limits, {
        fs: this.executionFs,
        nowMs: this.executionControl.nowMs,
        deadlineAtMs: control.deadlineAtMs,
        searchHints: this.searchHints(deps.searchHints),
        ...(control.signal === undefined ? {} : { signal: control.signal }),
        ...(deps.workspaceIndex === undefined ? {} : { workspaceIndex: deps.workspaceIndex }),
        ...(deps.semanticSearchProvider === undefined
          ? {}
          : { semanticSearchProvider: deps.semanticSearchProvider }),
        candidateSetFor: (candidateQuery, candidateLimits, policy, predicate, prescoreContent) =>
          this.queryCandidateSet(
            candidateQuery,
            candidateLimits,
            policy,
            predicate,
            control,
            prescoreContent,
          ),
        candidateContentFor: (scopePath): string | undefined =>
          this.cachedCandidateContent(scopePath),
        validateCachedCandidateContent: (): void => {
          this.validateCachedContentPreviews(control);
        },
        drainStaleCandidateContentPaths: (): readonly string[] =>
          this.drainStaleContentPreviewPaths(),
        reconcileCandidateContentEntries: (entries, missingPaths): void => {
          this.reconcileContentPreviews(entries, missingPaths);
        },
      });
    });
  }

  public diagnostics(): StructuralRequestContextDiagnostics {
    return {
      candidateInventoryBuildCount: this.candidateInventoryBuildCount,
      candidateFileCount: this.candidateFileCount,
      candidateDirectoryCount: this.candidateDirectoryCount,
      codeIndexBuildCount: this.codeIndexBuildCount,
      symbolGraphBuildCount: this.symbolGraphBuildCount,
      importGraphBuildCount: this.importGraphBuildCount,
      endpointGraphBuildCount: this.endpointGraphBuildCount,
      fileSearchCount: this.fileSearchCount,
      textSearchCount: this.textSearchCount,
    };
  }
}

export function createStructuralAdapterRequestContext(
  scope: SearchScope,
  limits: SearchLimits,
  fs: WorkspaceFs,
  deps: StructuralAdapterRequestContextDeps = {},
): StructuralAdapterRequestContext {
  return new DefaultStructuralAdapterRequestContext(scope, limits, fs, deps);
}
