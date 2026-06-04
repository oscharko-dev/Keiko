// Re-export shim: workspace contract types are owned by @oscharko-dev/keiko-contracts and
// re-exported through @oscharko-dev/keiko-workspace (issues #158, #161). Routing through
// keiko-workspace keeps the legacy `from "./types.js"` import paths resolving for callers
// that have not yet migrated to the absolute package surface.

export type {
  WorkspaceLanguage,
  TestFramework,
  WorkspaceInfo,
  DiscoveredFile,
  DiscoveryOptions,
  DiscoveryStats,
  ReadOptions,
  FileContent,
  SelectionReason,
  ContextRequest,
  ContextEntry,
  ContextPack,
  ContextEntrySummary,
  ContextPackSummary,
  WorkspaceSummary,
  AuditEntry,
  AuditSummary,
} from "@oscharko-dev/keiko-workspace";
export {
  DEFAULT_DISCOVERY_OPTIONS,
  DEFAULT_READ_OPTIONS,
  SELECTION_REASON_PRIORITY,
  DEFAULT_CONTEXT_REQUEST,
} from "@oscharko-dev/keiko-workspace";
