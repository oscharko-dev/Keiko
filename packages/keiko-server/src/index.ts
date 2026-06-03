// Public barrel for the local UI BFF runtime (ADR-0019 §"Target Package Topology"
// row keiko-server). The browser tier stays presentation-only: model, filesystem,
// PTY, and harness authority remain in the loopback Node process behind JSON, SSE,
// and token-scoped WebSocket seams.
//
// After issue #166 the BFF runtime lives in `packages/keiko-server/`; the legacy
// `src/ui/` directory now contains only an enumerated re-export shim so existing
// consumers (`src/cli/ui.ts`, `src/cli/lifecycle.ts`, in-repo SDK callers) keep
// resolving their `from "../ui/index.js"` imports unchanged.

export { createUiServer, DEFAULT_UI_PORT, UI_HOST, type UiServerDeps } from "./server.js";
export { buildCspHeader, extractInlineScriptHashes } from "./csp.js";
export { loadCspHeader } from "./load-csp.js";
export { applySecurityHeaders } from "./headers.js";
export { isAllowedHost } from "./host-check.js";
export { resolveContainedPath, serveFile } from "./static.js";
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
} from "./routes.js";
export {
  buildUiHandlerDeps,
  buildRedactor,
  type UiHandlerDeps,
  type BuildHandlerDepsOptions,
  type Redactor,
  type ModelPortFactory,
} from "./deps.js";
export {
  createRunRegistry,
  ActiveRunLimitError,
  type RunRegistry,
  type RunRecord,
  type RunStatus,
  type AppliableSnapshot,
} from "./runs.js";
export { QueueEventSink, type StreamEvent, type SseWriter } from "./sink.js";
export { parseRunRequest, type RunRequest, type RunKind } from "./run-request.js";
export { startRun, applyRun, type StartRunResult } from "./run-engine.js";
export {
  handleCreateRun,
  handleRunEvents,
  handleCancelRun,
  handleGetRun,
  handleApplyRun,
} from "./run-handlers.js";
export {
  persistWorkflowEvidence,
  persistExplainEvidence,
  type EvidencePersistContext,
  type RunIdentity,
} from "./evidence.js";
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
} from "./store/index.js";
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
} from "./store-handlers.js";
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
} from "./terminal.js";
export { TerminalToolError, type TerminalErrorCode } from "./terminal-errors.js";
export {
  buildTerminalEvidenceEntry,
  appendTerminalEvidence,
  type TerminalEvidenceEntry,
} from "./terminal-evidence.js";
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
} from "./files.js";
