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

export { KEIKO_WORKSPACE_VERSION } from "./version.js";
