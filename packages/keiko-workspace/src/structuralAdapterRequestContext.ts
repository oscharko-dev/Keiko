import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import type { CodeIntelligenceIndex } from "./codeIntelligence.js";
import { buildCodeIntelligenceIndexFromCandidates } from "./codeIntelligence.js";
import { buildEndpointContractGraphFromCandidates } from "./endpointContractGraph.js";
import type { EndpointContractGraph } from "./endpointContractTypes.js";
import { PathDeniedError, PathEscapeError } from "./errors.js";
import type { WorkspaceFs } from "./fs.js";
import { buildImportGraphFromCandidates, type ImportGraph } from "./importGraphEdges.js";
import { resolveWithinWorkspace } from "./paths.js";
import { containedRealPathInfo, isCanonicalAllowedContainedPath } from "./realpath.js";
import {
  createRequestLocalSearchTextSessionPool,
  findFiles,
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
  readonly symbolGraph: () => Promise<SymbolGraph>;
  readonly importGraph: () => Promise<ImportGraph>;
  readonly endpointContractGraph: () => Promise<EndpointContractGraph>;
  readonly findFiles: (
    query: RetrievalQuery,
    limits: SearchLimits,
    deps?: StructuralRequestSearchDeps,
  ) => Promise<SearchResult>;
  readonly searchText: (
    query: RetrievalQuery,
    limits: SearchLimits,
    deps?: StructuralRequestSearchDeps,
  ) => Promise<SearchResult>;
  readonly diagnostics: () => StructuralRequestContextDiagnostics;
}

export interface StructuralRequestSearchDeps {
  readonly searchHints?: SearchHints | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly workspaceIndex?: WorkspaceIndex | undefined;
  readonly semanticSearchProvider?: SemanticSearchProvider | undefined;
}

export interface StructuralAdapterRequestContextDeps {
  readonly nowMs?: (() => number) | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly deadlineAtMs?: number | undefined;
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
  readonly content: string | null;
  readonly file: DiscoveredFile;
  readonly metadata: WorkspaceIndexDiscoveredFile | undefined;
  readonly validatedFor: StructuralExecutionControl;
}

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

function currentCandidateContentMetadata(
  scope: SearchScope,
  file: DiscoveredFile,
  fs: WorkspaceFs,
): WorkspaceIndexDiscoveredFile | undefined {
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
    return workspaceIndexFileMetadata(file.relativePath, stat);
  } catch (error) {
    rethrowPreviewValidationBoundary(error);
    return undefined;
  }
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
  private candidateState: CandidateInventoryState = { status: "empty" };
  private readonly queryCandidateStates = new Map<string, CandidateInventoryState>();
  private readonly contentPreviews = new Map<string, CachedCandidateContentPreview>();
  private readonly staleContentPreviewPaths = new Set<string>();
  private readonly searchTextSessions: RequestLocalSearchTextSessionPool =
    createRequestLocalSearchTextSessionPool();
  private paths: readonly string[] | undefined;
  private symbolicLinks: readonly string[] | undefined;
  private codeIndexPromise: Promise<CodeIntelligenceIndex> | undefined;
  private symbolGraphPromise: Promise<SymbolGraph> | undefined;
  private importGraphPromise: Promise<ImportGraph> | undefined;
  private endpointGraphPromise: Promise<EndpointContractGraph> | undefined;
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
  }

  private candidateSet(): CandidateSet {
    if (this.candidateState.status === "ready") return this.candidateState.candidates;
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
      return candidates;
    } catch (error) {
      this.candidateState = { status: "failed", error };
      throw error;
    }
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
      inventory,
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
    if (cached === undefined) return { status: "read", file };
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
    return this.contentPreviews.get(scopePath)?.content ?? undefined;
  }

  private drainStaleContentPreviewPaths(): readonly string[] {
    const paths = [...this.staleContentPreviewPaths];
    this.staleContentPreviewPaths.clear();
    return paths;
  }

  public candidatePaths(): readonly string[] {
    this.paths ??= this.candidateSet().files.map((file) => file.relativePath);
    return this.paths;
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
        { executionControl: this.executionControl, disableCache: true },
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

  public endpointContractGraph(): Promise<EndpointContractGraph> {
    this.endpointGraphPromise ??= Promise.resolve().then(() => {
      this.endpointGraphBuildCount += 1;
      return buildEndpointContractGraphFromCandidates(
        this.scope,
        this.limits,
        this.executionFs,
        this.candidateSet(),
        this.executionControl,
      );
    });
    return this.endpointGraphPromise;
  }

  private assertInventoryCovers(limits: SearchLimits): void {
    if (
      limits.maxFilesScanned > this.limits.maxFilesScanned ||
      limits.maxMatchesReturned > this.limits.maxMatchesReturned ||
      limits.maxBytesPerFileScanned > this.limits.maxBytesPerFileScanned ||
      limits.elapsedMsMax > this.limits.elapsedMsMax
    ) {
      throw new RangeError("request context does not cover the requested search limits");
    }
  }

  private searchControl(
    limits: SearchLimits,
    deps: StructuralRequestSearchDeps,
  ): StructuralExecutionControl {
    const nowMs = this.executionControl.nowMs;
    const callDeadlineAtMs = nowMs() + Math.max(0, limits.elapsedMsMax);
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
        ...(deps.searchHints === undefined ? {} : { searchHints: deps.searchHints }),
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
        ...(deps.searchHints === undefined ? {} : { searchHints: deps.searchHints }),
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
