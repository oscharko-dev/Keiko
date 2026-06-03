// Public barrel for the repository-context & workspace-access layer (ADR-0005). The only
// boundary-checked file-read seam is `readWorkspaceFile` (lexical containment + symlink
// realpath gate + size cap + redaction). `nodeWorkspaceFs` is the `WorkspaceFs` IO port
// that consumers inject INTO the security primitives (`readWorkspaceFile`,
// `assertContainedRealPath`, `containedRealPathInfo`); it is not a parallel read path —
// ADR-0019 trust rule 4 forbids raw `node:fs` in tools/harness/workflows precisely so
// every workspace-rooted read routes through this port and the primitives that consume
// it. Explicit named re-exports, `type` keyword for type-only, double quotes, `.js`.

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

export {
  nodeWorkspaceFs,
  type WorkspaceDirEntry,
  type WorkspaceFs,
  type WorkspaceStat,
} from "./fs.js";

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
