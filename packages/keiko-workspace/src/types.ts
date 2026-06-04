// Re-export shim: workspace contract types live in @oscharko-dev/keiko-contracts (issue #158).
// `verbatimModuleSyntax` is on, so type-only names use `export type` and value-emitting frozen
// tables use `export`.

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
} from "@oscharko-dev/keiko-contracts";
export {
  DEFAULT_DISCOVERY_OPTIONS,
  DEFAULT_READ_OPTIONS,
  SELECTION_REASON_PRIORITY,
  DEFAULT_CONTEXT_REQUEST,
} from "@oscharko-dev/keiko-contracts";
