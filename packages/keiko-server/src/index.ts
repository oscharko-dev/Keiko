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
  type ProductionCodingRuntimePorts,
  type Redactor,
  type ModelPortFactory,
  type MemoryAuthorizationContext,
} from "./deps.js";
export {
  createProductionCodingRuntimeHost,
  type CodingRuntimeTaskDispatcher,
  type ProductionCodingRuntimeHost,
  type ProductionCodingRuntimeResolver,
  type QualifiedProductionCodingRuntime,
} from "./coding-runtime/productionCodingRuntimeHost.js";
export {
  createProductionCodingRuntimeResolver,
  type ProductionCodingRuntimeResolverInput,
  type ProductionRuntimeBackendInput,
  type ProductionRuntimeBackendResolver,
  type QualifiedProductionRuntimeRun,
} from "./coding-runtime/productionCodingRuntimeResolver.js";
// The command-runner seam types stay module-internal on purpose: they are server-owned shapes,
// and the launch surface consuming this probe needs only the function (reviewer finding on
// #3026 — cross-package types belong in contracts, and this seam is not a cross-package
// contract).
export { portableInstallCarriesReleaseSignature } from "./coding-runtime/productionPortableCodingRuntime.js";
export {
  createUpdateLocalStateManager,
  type CreateUpdateSnapshotInput,
  type UpdateLocalStateRepairResult,
  type UpdateLocalStateManager,
  type UpdateLocalStateManagerOptions,
} from "./update-local-state.js";
export {
  createUpdatePreflightService,
  runUpdatePreflight,
  type UpdatePreflightService,
} from "./update-preflight.js";
export {
  createFileUpdateSessionLock,
  createStateDirUpdateSessionLock,
  updateSessionLockPath,
  type FileUpdateSessionLockOptions,
  type UpdateSessionLock,
  type UpdateSessionLockRecord,
} from "./update-session-lock.js";
export {
  createUpdateSessionManager,
  UpdateSessionError,
  type UpdateSessionManager,
  type UpdateSessionManagerOptions,
  type UpdateSessionStartOutcome,
} from "./update-session.js";
export {
  createUpdateRemediationManager,
  UpdateRemediationError,
  type UpdateRemediationManager,
  type UpdateRemediationManagerOptions,
} from "./update-remediation.js";
export {
  createLocalKnowledgeRemediationPort,
  type CreateLocalKnowledgeRemediationPortOptions,
  type LocalKnowledgeRemediationPort,
  type LocalKnowledgeRemediationRunResult,
  type LocalKnowledgeRemediationScope,
} from "./local-knowledge-remediation.js";
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
  type WorkspaceTrustRecordRow,
  type WorkspaceTrustRecordRowInput,
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
export {
  runMemoryMaintenance,
  memoryRetentionPolicy,
  memorySemanticizationMultipliers,
  resolveMemoryRetentionPolicy,
  type MaintenanceCounts,
} from "./memory-maintenance-handlers.js";
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
  DEFAULT_RUNTIME_CAPABILITY_DEADLINE_MS,
  PathHostExecutableProbe,
  RUNTIME_HOST_EXECUTABLE_SPECS,
  detectRuntimeCapabilities,
  type HostExecutableProbe,
  type HostExecutableProbeResult,
  type HostExecutableSpec,
  type RuntimeCapabilityDetectorOptions,
} from "./runtime/capabilityDetector.js";
export {
  handleRuntimeCapabilities,
  type RuntimeCapabilityRouteOptions,
} from "./runtime/capabilityRoutes.js";
// Issue #1388 (ADR-0070) — governed container engine detection + execution pilot.
export {
  detectContainerEngines,
  DEFAULT_CONTAINER_PROBE_DEADLINE_MS,
  SUPPORTED_DOCKER_MAJOR,
  KEIKO_CONTAINERS_DISABLED_ENV,
  type ContainerProbeDeps,
} from "./runtime/containerEngineDetector.js";
export {
  createContainerRunnerManager,
  buildContainerRunArgv,
  DEFAULT_CONTAINER_EXECUTION_POLICY,
  DEFAULT_CONTAINER_RESOURCE_LIMITS,
  DEFAULT_CONTAINER_TASKS,
  type ContainerRunInput,
  type ContainerRunnerEventEmitter,
  type ContainerRunnerManager,
  type ContainerRunnerManagerOptions,
} from "./runtime/containerRunner.js";
export {
  handleContainerCapability,
  handleContainerCatalog,
  handleContainerEvents,
  handleCreateContainerRun,
  handleDeleteContainerRun,
} from "./runtime/containerRoutes.js";
export {
  ContainerRunnerError,
  CONTAINER_RUNNER_ERROR_CODES,
  type ContainerRunnerErrorCode,
} from "./runtime/containerRunner-errors.js";
export {
  appendContainerRunEvidence,
  buildContainerRunEvidenceEntry,
  CONTAINER_RUN_EVIDENCE_KIND,
  type ContainerRunEvidenceEntry,
  type ContainerRunEvidenceInput,
} from "./runtime/containerRunner-evidence.js";
export {
  copyFilesEntry,
  createFilesEntry,
  deleteFilesEntry,
  handleFilesContent,
  handleFilesCopy,
  handleFilesCreate,
  handleFilesDelete,
  handleFilesRename,
  handleFilesSearch,
  readFilesContent,
  readFilesPreview,
  readFilesTree,
  renameFilesEntry,
  searchFiles,
  writeFilesContent,
  type FilesContentResponse,
  type FilesEntryKind,
  type FilesMutationResponse,
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
  usableGatewayMessages,
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

// RB-5 / GEN-AI-RELEASE-GATE-001 — production semantic + RRF + model-reranker retrieval-quality eval.
// Exposed so scripts/check-grounded-retrieval-quality.mjs can gate the REAL retrieval path (not the
// lexical toy corpus) with non-tautological floors and injected-regression proofs.
export {
  runGroundedRetrievalQualityEval,
  evaluateGroundedRetrievalBudget,
  DEFAULT_GROUNDED_RETRIEVAL_BUDGET,
  GROUNDED_RETRIEVAL_REGRESSION_MODES,
  type GroundedRetrievalEvalMode,
  type GroundedRetrievalScorecard,
  type GroundedRetrievalBudget,
} from "./grounded-retrieval-eval.js";

// Audit KEIKO-0053 — the LATENCY counterpart of the eval above. The quality gate drives the real
// grounded path but records no timing, and check:retrieval-latency times only lexical searchText,
// so nothing gated embedding/ANN/rerank/entailment wall-clock. Exposed so
// scripts/check-grounded-retrieval-latency.mjs can measure it with a deterministic judge.
export {
  runGroundedRetrievalLatencyEval,
  FIXTURE_ANSWER_CLAIMS,
  type GroundedLatencySample,
  type GroundedLatencyEvalOptions,
} from "./grounded-latency-eval.js";

// Knowledge M2.3 (#2567) — the single governed model-rerank facade shared by every grounded
// orchestrator. Documents remain caller-shaped, while policy/config gating, provider mapping,
// diagnostics, and deterministic fallback behavior stay centralized.
export {
  rerankSelection,
  type RerankFallbackMode,
  type RerankSelection,
  type RerankSelectionInput,
  type RerankSelectionPolicy,
} from "./grounded-rerank-facade.js";

// RB-4 / GEN-AI-EVAL-003 — grounded-answer faithfulness + citation-support eval. Exposed so
// scripts/check-grounded-faithfulness.mjs can gate that fabricated citations are flagged and empty
// evidence abstains.
export {
  runGroundedFaithfulnessEval,
  evaluateGroundedFaithfulnessBudget,
  DEFAULT_GROUNDED_FAITHFULNESS_BUDGET,
  type GroundedFaithfulnessScorecard,
  type GroundedFaithfulnessBudget,
} from "./grounded-faithfulness-eval.js";

// Knowledge M1.2 (#2563) — the entailment (citation-support) eval, exported so
// scripts/check-grounded-entailment.mjs can gate that an in-pack citation whose excerpt does NOT
// support the claim is flagged, no supported claim is falsely flagged, an unavailable judge degrades
// to WARN, and the checker is load-bearing (non-tautology proven).
export {
  runGroundedEntailmentEval,
  evaluateGroundedEntailmentBudget,
  DEFAULT_GROUNDED_ENTAILMENT_BUDGET,
  type GroundedEntailmentScorecard,
  type GroundedEntailmentBudget,
} from "./grounded-entailment-eval.js";

// ADR-0141 W1.5 (#2478) — the trusted-launcher half of the app-session pairing hand-off. Exposed so
// the keiko-cli launcher (`keiko start --open`) mints the single-use attestation with the SAME claim
// construction the server-side pairing port verifies; the claim formula stays single-source here.
export {
  SESSION_PAIRING_LAUNCHER_SECRET_ENV,
  computeLauncherPairingClaim,
  mintLauncherPairingAttestation,
} from "./coding-app-session/launcherSessionPairingPort.js";

// ADR-0173 (server activity log v2): file-backed activity log sink for the BFF. The CLI wires it
// into createUiServer so every HTTP request produces one JSON line in `<stateDir>/logs/server.log`,
// giving operators diagnosable evidence without an env-var opt-in. The additional names below
// (envelope identity/schema helpers, the log-level threshold resolver and its env constants, and
// the category/level/threshold types) are exported for `keiko-cli`'s process-lifecycle logging
// (`ui.ts`) and its support-bundle exporter (`support-export.ts`), which previously had to mirror
// this package's log-level resolution and shutdown-close logic locally instead of reusing it.
// `createBufferedServerLogSink` is deliberately absent: it is a test-only helper, every consumer
// is an in-package test importing it from `./observability/index.js`, and a packaged export is a
// promise this package would then have to keep.
export {
  createFileServerLogSink,
  nullServerLogSink,
  closeFileServerLogSinks,
  serverLogInstanceId,
  SERVER_LOG_SCHEMA_VERSION,
  resolveServerLogThreshold,
  SERVER_LOG_LEVEL_ENV,
  DEFAULT_SERVER_LOG_LEVEL,
  type ServerLogSink,
  type ServerLogEvent,
  type ServerLogCategory,
  type ServerLogLevel,
  type ServerLogThreshold,
} from "./observability/server-log.js";

// ADR-0173 D3/D11 — error evidence for the activity log: dist/src-anchored stack frames, a
// content-free `.cause` chain, and the content-free error-CLASS classifier they both build on.
// Exposed so `keiko-cli`'s process-guards fatal path (an uncaught exception/unhandled rejection
// with a state directory present) can compute the SAME evidence this package's own diagnostics
// sink already writes, via a dynamic `import("@oscharko-dev/keiko-server")` reached only inside the
// crash handler — never at module scope, where it would cost real startup time against
// GEN-PERF-CLI-001's budget.
export { causeChain, keikoStackFrames } from "./observability/stack-frames.js";
export { contentFreeErrorClass, describeError } from "./diagnostics-log.js";

// Install-mode detection for `keiko-cli`'s process-lifecycle (`process.started`) and
// support-bundle manifest fields. `detectUpdateInstallMode`/`productionUpdateFacts` are exported
// rather than `detectPortableUpdateInstallMode` (the narrower portable-only branch in
// `./update-portable-install-mode.js`): the portable detector returns `undefined` for every
// non-portable install, which is the common case, so it cannot answer "which install mode is this
// process running in" on its own. `detectUpdateInstallMode` calls the portable detector internally
// and falls through to package-manager detection, so it is the one call that always answers the
// question. Both functions run synchronously, take no lock, and are the exact pair
// `UpdateSessionManagerImpl.getStatus()` already calls under the hood (`defaultDetectorFor` in
// `./update-session-support.js`) — exporting them lets a caller that only wants the install mode
// (not the full update-session machinery: locks, run history, command execution) skip
// constructing an `UpdateSessionManager` entirely.
export { detectUpdateInstallMode, productionUpdateFacts } from "./update-install-mode.js";
