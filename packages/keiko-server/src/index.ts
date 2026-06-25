// Public barrel for the local UI BFF runtime (ADR-0019 §"Target Package Topology"
// row keiko-server). The browser tier stays presentation-only: model, filesystem,
// PTY, and harness authority remain in the loopback Node process behind JSON, SSE,
// and token-scoped WebSocket seams.

export { createUiServer, DEFAULT_UI_PORT, UI_HOST, type UiServerDeps } from "./server.js";
export { buildCspHeader, extractInlineScriptHashes } from "./csp.js";
export { createLiveCspHeaderProvider, loadCspHeader } from "./load-csp.js";
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
  handleDeleteLocalKnowledgeCapsule,
  handleGetLocalKnowledgeCapsule,
  handleListLocalKnowledgeCapsules,
  handleReindexLocalKnowledgeCapsule,
} from "./local-knowledge-handlers.js";
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
export { runMemoryMaintenance, type MaintenanceCounts } from "./memory-maintenance-handlers.js";
export {
  exportMemoryDiagnostics,
  type ExportMemoryDiagnosticsOptions,
  type MemoryDiagnostics,
  type MemoryScopeCount,
  type MemoryStatusHistogram,
} from "./memory-diagnostics.js";
export {
  createMemoryEmbedder,
  selectMemoryEmbeddingModelId,
  type MemoryEmbedder,
} from "./memory-embedding.js";
export {
  buildTerminalEvidenceEntry,
  appendTerminalEvidence,
  type TerminalEvidenceEntry,
} from "./terminal-evidence.js";
export {
  handleFilesContent,
  handleFilesSearch,
  listFilesDirectories,
  readFilesContent,
  readFilesPreview,
  readFilesTree,
  searchFiles,
  writeFilesContent,
  type FilesContentResponse,
  type FilesDirectoryEntry,
  type FilesDirectoryListing,
  type FilesDirectoryRoot,
  type FilesEntryKind,
  type FilesSearchFileRole,
  type FilesSearchMatchQuality,
  type FilesSearchResponse,
  type FilesSearchResult,
  type FilesSearchRootKind,
  type FilesPreviewResponse,
  type FilesTreeEntry,
  type FilesTreeResponse,
} from "./files.js";

// PR4-W4 (ADR-0055) — additive exports so the deterministic context-quality gate
// (scripts/check-context-quality.mjs) can drive the REAL chat history-compaction splice end-to-end.
// Behavior-preserving: these names already exist on their modules; only the barrel surface widens.
export {
  conversationForGateway,
  MAX_CONTEXT_MESSAGES,
  type GatewayConversationMessage,
} from "./chat-handlers.js";
export {
  conversationForGatewayWithCompaction,
  type ConversationCompactionOptions,
  type ConversationCompactionOutcome,
} from "./conversation-compaction.js";

// Epic #1307 / Issue #1314 — Prompt Enhancer governed surface. The BFF route handler and the reusable,
// deterministic orchestration the CLI command (`keiko prompt-enhancer`) drives so both surfaces produce
// byte-identical enhancements (AC1). Routed through the Model Gateway; never dispatches a model.
export {
  handlePromptEnhancement,
  buildPromptEnhancementRecordInput,
  runPromptEnhancement,
  PromptEnhancementCancelledError,
  PromptEnhancementInputError,
  type RunPromptEnhancementDeps,
} from "./promptEnhancer/index.js";
