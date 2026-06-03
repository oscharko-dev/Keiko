// Re-export shim: the local UI BFF runtime now lives in @oscharko-dev/keiko-server
// (issue #166, ADR-0019). Existing consumers (`src/cli/ui.ts`, `src/cli/lifecycle.ts`,
// in-repo SDK callers, package-surface verification tests) import from the legacy
// path; this shim preserves those import paths. Explicit-named re-exports (no
// `export *`) keep the surface auditable — same convention as the harness, workflows,
// evidence, tools, workspace, and model-gateway shims.

export {
  createUiServer,
  DEFAULT_UI_PORT,
  UI_HOST,
  type UiServerDeps,
} from "@oscharko-dev/keiko-server";
export { buildCspHeader, extractInlineScriptHashes } from "@oscharko-dev/keiko-server";
export { loadCspHeader } from "@oscharko-dev/keiko-server";
export { applySecurityHeaders } from "@oscharko-dev/keiko-server";
export { isAllowedHost } from "@oscharko-dev/keiko-server";
export { resolveContainedPath, serveFile } from "@oscharko-dev/keiko-server";
export {
  API_ROUTES,
  isApiPath,
  matchRoute,
  errorBody,
  STREAMING,
  type ApiError,
  type HandlerOutcome,
  type RouteContext,
  type RouteDefinition,
  type RouteHandler,
  type RouteMatch,
  type RouteResult,
} from "@oscharko-dev/keiko-server";
export {
  buildUiHandlerDeps,
  buildRedactor,
  type UiHandlerDeps,
  type BuildHandlerDepsOptions,
  type Redactor,
  type ModelPortFactory,
} from "@oscharko-dev/keiko-server";
export {
  createRunRegistry,
  ActiveRunLimitError,
  type RunRegistry,
  type RunRecord,
  type RunStatus,
  type AppliableSnapshot,
} from "@oscharko-dev/keiko-server";
export { QueueEventSink, type StreamEvent, type SseWriter } from "@oscharko-dev/keiko-server";
export { parseRunRequest, type RunRequest, type RunKind } from "@oscharko-dev/keiko-server";
export { startRun, applyRun, type StartRunResult } from "@oscharko-dev/keiko-server";
export {
  handleCreateRun,
  handleRunEvents,
  handleCancelRun,
  handleGetRun,
  handleApplyRun,
} from "@oscharko-dev/keiko-server";
export {
  persistWorkflowEvidence,
  persistExplainEvidence,
  type EvidencePersistContext,
  type RunIdentity,
} from "@oscharko-dev/keiko-server";
// ADR-0013 — UI-local SQLite persistence: ports, factories, and route handlers.
export {
  createInMemoryUiStore,
  createNodeUiStore,
  isProjectAvailable,
  resolveUiDbPath,
  runMigrations,
  SCHEMA_VERSION,
  UI_DB_DIRNAME,
  UI_DB_FILENAME,
  UiStoreError,
  validateProjectPath,
  type Chat,
  type ChatMessage,
  type ChatRole,
  type CreateChatOptions,
  type NewChatMessage,
  type Project,
  type UiStore,
  type UiStoreErrorCode,
  type UiStoreFactoryOptions,
  type UpdateChatPatch,
  type UpdateProjectPatch,
  type WorkflowStatus,
} from "@oscharko-dev/keiko-server";
export {
  handleListProjects,
  handleCreateProject,
  handleUpdateProject,
  handleDeleteProject,
  handleListChats,
  handleCreateChat,
  handleUpdateChat,
  handleDeleteChat,
  handleListMessages,
  handleCreateMessage,
} from "@oscharko-dev/keiko-server";
export {
  createTerminalExecutionManager,
  buildTerminalPolicySummary,
  listDirectories,
  type TerminalDirectoryListing,
  type TerminalExecutionInput,
  type TerminalExecutionManager,
  type TerminalExecutionResult,
  type TerminalEventEmitter,
  type TerminalEventEnvelope,
  type TerminalEventKind,
  type TerminalPolicySummary,
} from "@oscharko-dev/keiko-server";
export { TerminalToolError, type TerminalErrorCode } from "@oscharko-dev/keiko-server";
export {
  buildTerminalEvidenceEntry,
  appendTerminalEvidence,
  type TerminalEvidenceEntry,
} from "@oscharko-dev/keiko-server";
export {
  listFilesDirectories,
  readFilesPreview,
  readFilesTree,
  type FilesDirectoryEntry,
  type FilesDirectoryListing,
  type FilesDirectoryRoot,
  type FilesEntryKind,
  type FilesPreviewResponse,
  type FilesTreeEntry,
  type FilesTreeResponse,
} from "@oscharko-dev/keiko-server";
