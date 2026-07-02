// Public barrel for the repository-context & workspace-access layer (ADR-0005). The only
// boundary-checked file-read seam is `readWorkspaceFile` (lexical containment + symlink
// realpath gate + size cap + redaction). The Node-backed `nodeWorkspaceFs` adapter is kept on
// the package's internal subpath so the public barrel exposes safe operations and injectable port
// types, not a parallel raw read path.

export type {
  AuditEntry,
  AuditSummary,
  ContextEntry,
  ContextEntrySummary,
  ContextPack,
  ContextPackSummary,
  ContextRequest,
  DiscoveredFile,
  DiscoveryOptions,
  DiscoveryStats,
  FileContent,
  ReadOptions,
  SelectionReason,
  TestFramework,
  WorkspaceInfo,
  WorkspaceLanguage,
  WorkspaceSummary,
} from "./types.js";

export {
  DEFAULT_CONTEXT_REQUEST,
  DEFAULT_DISCOVERY_OPTIONS,
  DEFAULT_READ_OPTIONS,
  SELECTION_REASON_PRIORITY,
  WORKSPACE_LANGUAGES,
} from "./types.js";

export {
  FileTooLargeError,
  PathDeniedError,
  PathEscapeError,
  RepoSearchInvalidQueryError,
  RepoSearchInvalidRangeError,
  RepoSearchUnsupportedFileError,
  WORKSPACE_CODES,
  WorkspaceError,
  WorkspaceNotFoundError,
  WorkspaceReadError,
  type WorkspaceCode,
} from "./errors.js";

export { type WorkspaceDirEntry, type WorkspaceFs, type WorkspaceStat } from "./fs.js";

export { isWithinWorkspace, resolveWithinWorkspace } from "./paths.js";

export { assertContainedRealPath, containedRealPathInfo } from "./realpath.js";

export {
  compileIgnore,
  DEFAULT_DENY_PATTERNS,
  isDenied,
  isIgnored,
  type IgnoreMatcher,
} from "./ignore.js";

export { detectWorkspace, detectWorkspaceAt } from "./detect.js";

export {
  discoverFiles,
  discoverWithStats,
  readWorkspaceFile,
  type DiscoveryResult,
} from "./discovery.js";

export { lexicalRetrievalStrategy, type RankedFile, type RetrievalStrategy } from "./retrieval.js";

export {
  buildContextPack,
  buildContextPackFromFiles,
  selectScoredTextByByteBudget,
  type ContextPackDeps,
  type ScoredTextBudgetResult,
  type ScoredTextBudgetSelection,
} from "./contextPack.js";

export { buildWorkspaceSummary, summarizeForAudit } from "./summary.js";

// ─── Repository search facade (Issue #179 / Epic #177) ──────────────────────
export type {
  SearchScope,
  SearchLimits,
  SearchResult,
  ReadExcerptRequest,
  ReadExcerptResult,
} from "./repoSearch.js";
export { DEFAULT_SEARCH_LIMITS, searchText, findFiles, readExcerpt } from "./repoSearch.js";
export type {
  CandidateBucket,
  RankedCandidateDiagnostic,
  SearchDiagnostics,
  SearchHints,
  SearchIntent,
  SearchPolicy,
  SearchPolicyMode,
} from "./repoSearchPolicy.js";
export type {
  FileWorkspaceIndexStoreOptions,
  PreparedWorkspaceIndexEntry,
  WorkspaceIndexPreparationReport,
  PreparedWorkspaceIndexSnapshot,
  WorkspaceIndex,
  WorkspaceIndexCandidateSet,
  WorkspaceIndexDiscoveredFile,
  WorkspaceIndexDiscoverySnapshot,
  WorkspaceIndexRecord,
  WorkspaceIndexRecordKind,
  WorkspaceIndexScopeKey,
  WorkspaceIndexSnapshot,
  WorkspaceIndexStore,
} from "./workspaceIndex.js";
export {
  WORKSPACE_INDEX_SNAPSHOT_VERSION,
  buildWorkspaceIndexScopeKey,
  buildWorkspaceIndexSnapshot,
  createFileWorkspaceIndexStore,
  createInMemoryWorkspaceIndexStore,
  createWorkspaceIndex,
  prepareWorkspaceIndexSnapshot,
  workspaceIndexCandidateSet,
} from "./workspaceIndex.js";

// ─── Language / build-system ecosystem registry (enterprise retrieval, Milestone 1) ──
export {
  allRegisteredFilePatterns,
  canonicalMetadataEcosystem,
  CANONICAL_MANIFEST_BASENAMES,
  ECOSYSTEMS,
  ecosystemMetadataIntentPatterns,
  ecosystemTechnicalPhrases,
  isCanonicalMetadataFile,
  isEcosystemLockfile,
  isEcosystemSourceFile,
  isGeneratedArtifactPath,
  ecosystemPackageBoundary,
  ecosystemStructureProfiles,
  workspaceLanguageForEcosystem,
  workspaceLanguageForPath,
} from "./ecosystems.js";
export type {
  Ecosystem,
  EcosystemId,
  EcosystemPackageBoundary,
  EcosystemPattern,
  EcosystemPhrase,
  EcosystemStructureAvailabilityContext,
  EcosystemStructureCapability,
  EcosystemStructureExtractor,
  EcosystemStructureExtractorContext,
  EcosystemStructureProfile,
  EcosystemVersionDeclaration,
} from "./ecosystems.js";
export { looksBinary, DEFAULT_BINARY_PROBE } from "./binaryDetect.js";
export type { BinaryProbeOptions } from "./binaryDetect.js";
export {
  evidenceAtomStableId,
  connectedContextPackStableId,
  fileContentHash,
  hashExcerptContent,
  importEdgeStableId,
  MAX_HASH_FILE_BYTES,
  symbolGraphRecordStableId,
} from "./stableId.js";
export type { ImportEdgeStableIdInput, SymbolGraphRecordStableIdInput } from "./stableId.js";

// ─── Structural adapters (Issue #180 / Epic #177) ──────────────────────────
export type {
  AdapterError,
  RunAllResult,
  StructuralAdapter,
  StructuralAdapterDeps,
  StructuralAdapterRegistry,
  StructuralAdapterRegistryOptions,
} from "./structuralAdapters.js";
export {
  createDefaultStructuralRegistry,
  createEcosystemStructureAdapters,
  runStructuralAdapters,
} from "./structuralAdapters.js";
export type {
  ImportEdgeKind,
  ImportGraph,
  ImportGraphTraversalOptions,
  ImportResolutionKind,
  ImportSpecifierHit,
  ResolvedImportEdge,
} from "./importGraphEdges.js";
export {
  buildImportGraph,
  collectImportSpecifiers,
  importsFromSource,
  importersForTarget,
} from "./importGraphEdges.js";
export type {
  EndpointClientCallContract,
  EndpointClientKind,
  EndpointContractDiagnostics,
  EndpointContractGraph,
  EndpointContractLink,
  EndpointDtoEvidence,
  EndpointDtoShape,
  EndpointHttpMethod,
  EndpointRouteContract,
  EndpointServerFramework,
} from "./endpointContracts.js";
export {
  buildEndpointContractGraph,
  endpointContractAdapter,
  normalizeEndpointPath,
} from "./endpointContracts.js";
export type {
  SymbolDefinitionKind,
  SymbolGraph,
  SymbolGraphDiagnostics,
  SymbolGraphRecord,
  SymbolGraphRecordKind,
} from "./symbolGraph.js";
export {
  buildSymbolGraph,
  callsToSymbol,
  definitionsForSymbol,
  referencesForSymbol,
  symbolGraphAdapter,
} from "./symbolGraph.js";
export type {
  FollowSymbolTrace,
  FollowSymbolTraceDiagnostics,
  FollowSymbolTraceRecord,
  FollowSymbolTraceRelation,
  FollowSymbolTraceRequest,
} from "./followSymbolTrace.js";
export { followSymbolTrace } from "./followSymbolTrace.js";
export { testSourcePairingAdapter } from "./testSourcePairing.js";
export { importGraphAdapter } from "./importGraph.js";
export { gitHistoryAdapter } from "./gitHistory.js";

export { KEIKO_WORKSPACE_VERSION } from "./version.js";

// ─── Safe document context extraction (Issue #148 / Epic #142) ─────────────────
export type {
  DocumentExtractionBudget,
  DocumentExtractionFailure,
  DocumentExtractionResult,
  ExtractedDocumentContext,
} from "./document-extraction.js";
export {
  MAX_EXTRACTED_BYTES,
  MAX_TOTAL_EXTRACTED_BYTES,
  SUPPORTED_MIME_LITERALS,
  SUPPORTED_MIME_PREFIXES,
  extractDocumentContext,
} from "./document-extraction.js";
