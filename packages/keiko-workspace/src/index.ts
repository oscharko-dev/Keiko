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

export { detectWorkspace } from "./detect.js";

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
  type ContextPackDeps,
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
export { looksBinary, DEFAULT_BINARY_PROBE } from "./binaryDetect.js";
export type { BinaryProbeOptions } from "./binaryDetect.js";
export { evidenceAtomStableId, connectedContextPackStableId } from "./stableId.js";

// ─── Structural adapters (Issue #180 / Epic #177) ──────────────────────────
export type {
  AdapterError,
  RunAllResult,
  StructuralAdapter,
  StructuralAdapterDeps,
  StructuralAdapterRegistry,
} from "./structuralAdapters.js";
export { createDefaultStructuralRegistry, runStructuralAdapters } from "./structuralAdapters.js";
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
