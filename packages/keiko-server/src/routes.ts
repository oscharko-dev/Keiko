// BFF route dispatch (ADR-0011 D5). The route contract is wired here. The route TABLE
// (method + pattern) is static and dependency-free; each entry names a handler that receives the
// request context AND the per-server handler dependencies (resolved config, evidence store, run
// registry, redactor — see deps.ts). A handler returns a RouteResult (status + JSON body, which the
// server serializes) OR the STREAMING sentinel, meaning it has taken over the raw ServerResponse
// (the SSE events route). Non-2xx bodies use the redacted error envelope `{ error: { code, message } }`.

import type { IncomingMessage, ServerResponse } from "node:http";
import { SDK_VERSION } from "@oscharko-dev/keiko-sdk";
import type { UiHandlerDeps } from "./deps.js";
import {
  handleConfig,
  handleModels,
  handleVoiceCapability,
  handleWorkflows,
  handleWorkspace,
  handleEvidenceList,
  handleEvidenceDetail,
} from "./read-handlers.js";
import { handleGetWorkspaceState, handlePutWorkspaceState } from "./workspace-state-handlers.js";
import {
  handleVoiceSpeak,
  handleVoiceSpeakStream,
  handleVoiceTranscribe,
} from "./voice-handlers.js";
import {
  handleCreateRun,
  handleAllRunEvents,
  handleRunEvents,
  handleCancelRun,
  handleGetRun,
  handleApplyRun,
} from "./run-handlers.js";
import {
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
  handleCreateRunSummaryPair,
  handleUpdateMessage,
} from "./store-handlers.js";
import {
  handleAppendDesktopVoiceTurn,
  handleCreateDesktopChat,
  handleRegenerateDesktopChat,
  handleSendDesktopChat,
} from "./chat-handlers.js";
import { handleSendDesktopChatStream } from "./chat-stream-handlers.js";
import { handleCloneRepository } from "./gitRepositoryRoutes.js";
import {
  handleListMemories,
  handleMemoryReviewQueue,
  handleGetMemory,
  handleEditMemory,
  handlePinMemory,
  handleUnpinMemory,
  handleArchiveMemory,
  handleForgetMemory,
  handleForgetMemories,
  handleDeleteMemory,
  handleCorrectMemory,
  handleResolveMemoryConflict,
  handleAcceptMemoryProposal,
  handleRejectMemoryProposal,
} from "./memory-handlers.js";
import {
  handleMemoryRetrieveContext,
  handleMemoryCaptureFromConversation,
} from "./memory-conv-handlers.js";
import {
  handleCancelConsolidationJob,
  handleCreateConsolidationJob,
  handleGetConsolidationJob,
} from "./memory-consolidation-handlers.js";
import { handleRunMaintenance } from "./memory-maintenance-handlers.js";
import { handleGroundedAsk } from "./grounded-qa.js";
import { handleRealtimeGroundedVoiceTool } from "./voice-realtime-grounded-tool.js";
import { handleGatewayReadiness } from "./gateway-readiness.js";
import { handleGatewaySetup } from "./gateway-setup.js";
import { handleGetUpdatePreflight, handlePostUpdatePreflightCheck } from "./update-preflight.js";
import {
  handleCancelUpdateSession,
  handleCreateUpdateSession,
  handleGetUpdateSession,
  handleRetryUpdateSession,
  handleVerifyUpdateRestart,
} from "./update-session-routes.js";
import {
  handleGetUpdateRemediation,
  handlePostUpdateRemediationStatus,
  handleRunUpdateRemediationAction,
} from "./update-remediation-routes.js";
import {
  handleCreateTerminalExecution,
  handleDeleteTerminalExecution,
  handleTerminalDirectories,
  handleTerminalEvents,
  handleTerminalPolicy,
} from "./terminal-routes.js";
import { handleRuntimeCapabilities } from "./runtime/capabilityRoutes.js";
import {
  handleCommandCatalog,
  handleCommandEvents,
  handleCreateCommandRun,
  handleDeleteCommandRun,
} from "./command-runner-routes.js";
import {
  handleActivateTaskWorkspace,
  handleCleanupOrphanTaskWorkspaces,
  handleCleanupTaskWorkspace,
  handleClearActiveTaskWorkspace,
  handleGetActiveTaskWorkspace,
  handleGetTaskWorkspace,
  handleGetTaskWorkspaceHealth,
  handleGetTaskWorkspaceReconciliation,
  handleHandoffTaskWorkspace,
  handleListTaskWorkspaces,
  handlePauseTaskWorkspace,
  handleProvisionTaskWorkspace,
  handleReconcileTaskWorkspaces,
  handleRepairTaskWorkspace,
  handleResumeTaskWorkspace,
  handleSetActiveTaskWorkspace,
} from "./task-workspace/routes.js";
import {
  handleContainerCapability,
  handleContainerCatalog,
  handleContainerEvents,
  handleCreateContainerRun,
  handleDeleteContainerRun,
} from "./runtime/containerRoutes.js";
import {
  handleFilesContent,
  handleFilesCopy,
  handleFilesCreate,
  handleFilesDelete,
  handleFilesDirectories,
  handleFilesPreview,
  handleFilesPreviewImage,
  handleFilesRename,
  handleFilesSearch,
  handleFilesTree,
} from "./files.js";
import { handleNativeFileDialogOpen } from "./native-file-dialog.js";
import { handleGitBranches, handleGitDiff, handleGitStatus } from "./gitRoutes.js";
import { handleGitHistory, handleGitRemotes, handleGitSummary } from "./gitRepositoryReads.js";
import {
  handleEditorLanguage,
  handleEditorLanguageCapabilitiesForRoute,
} from "./editor/languageRoutes.js";
import { handleEditorLspStatus } from "./editor/lsp/lspStatusRoute.js";
import {
  handleEditorContext,
  handleEditorLocalKnowledgeRetrieve,
  handleEditorRepoSearch,
} from "./editor/contextRoutes.js";
import { handleEditorCompletion } from "./editor/completionRoutes.js";
import {
  handleEditorInlineCompletion,
  handleEditorInlineCompletionTelemetry,
} from "./editor/inlineCompletionRoutes.js";
import { handleEditorTestGeneration } from "./editor/testGenerationRoutes.js";
import { handleEditorPatchApply } from "./editor/patchApplyRoutes.js";
import {
  handleEditorHotExitDelete,
  handleEditorHotExitRead,
  handleEditorHotExitWrite,
} from "./editor/hotExitRoutes.js";
import {
  handleEditorAgentActions,
  handleEditorAgentAudit,
  handleEditorAgentEvents,
  handleEditorAgentSessions,
  handleEditorAgentSnapshot,
} from "./editor/agentRoutes.js";
import {
  handleBrowserApplyScreenshot,
  handleBrowserContent,
  handleBrowserEvents,
  handleBrowserNavigate,
  handleBrowserScreenshot,
  handleBrowserStatus,
  handleCreateBrowserSession,
  handleDeleteBrowserSession,
} from "./browser.js";
import { handleDocsBrowserNavigate } from "./docs-browser.js";
import { handleDocsBrowserApprove, handleDocsBrowserPropose } from "./docs-browser-proposal.js";
import {
  handleCancelLocalKnowledgeCapsuleIndexing,
  handleConnectLocalKnowledgeCapsule,
  handleCreateLocalKnowledgeCapsule,
  handleCreateLocalKnowledgeCapsuleSet,
  handleDeleteLocalKnowledgeCapsule,
  handleDisconnectLocalKnowledgeCapsule,
  handleGetLocalKnowledgeCapsule,
  handleListLocalKnowledgeCapsules,
  handleListLocalKnowledgeCapsuleSets,
  handleRebindLocalKnowledgeCapsuleSource,
  handleReindexLocalKnowledgeCapsule,
  handleStartLocalKnowledgeCapsuleIndexing,
  handleUpdateLocalKnowledgeCapsule,
} from "./local-knowledge-handlers.js";
import {
  handleAuthorizePdfCitationPreview,
  handleClosePdfCitationPreviewSession,
  handleGetPdfCitationPreviewDocument,
  handleGetPdfCitationPreviewStatus,
  handleOpenPdfCitationPreviewSession,
} from "./local-knowledge-preview-handlers.js";
import {
  handleRelationshipCreate,
  handleRelationshipDelete,
  handleRelationshipDependencies,
  handleRelationshipEvents,
  handleRelationshipExplain,
  handleRelationshipGet,
  handleRelationshipHealth,
  handleRelationshipImpact,
  handleRelationshipList,
  handleRelationshipPatch,
  handleRelationshipValidate,
} from "./relationship-handlers.js";
import {
  handleQiCapabilities,
  handleQiDryRunFigma,
  handleQiDryRunJira,
  handleQiSourceSelect,
  handleListQiRuns,
  handleGetQiRun,
  QI_MODEL_POLICY_ROUTE_GROUP,
  QI_HANDOFF_ROUTE_GROUP,
  QI_RUN_EXECUTION_ROUTE_GROUP,
  QI_REVIEW_ROUTE_GROUP,
  QI_EXPORT_ROUTE_GROUP,
  QI_EDIT_ROUTE_GROUP,
  QI_RETENTION_ROUTE_GROUP,
  QI_TRACEABILITY_ROUTE_GROUP,
  QI_RECHECK_ROUTE_GROUP,
} from "./qualityIntelligence/index.js";
import {
  handleFigmaListSnapshots,
  handleFigmaInspectSnapshotScreenJson,
  handleFigmaDeleteSnapshot,
  handleFigmaTriggerSnapshot,
  handleFigmaLoadSnapshot,
  handleFigmaLoadSnapshotImage,
  handleFigmaRevokeToken,
  handleFigmaUpdateSnapshotMetadata,
} from "./qualityIntelligence/figmaSnapshotRoutes.js";
import { handleFigmaGenerateCode } from "./qualityIntelligence/figmaCodegenRoutes.js";
import {
  handlePromptEnhancement,
  handlePromptEnhancementEvidence,
} from "./promptEnhancer/index.js";
import { GIT_DELIVERY_ACTION_SHEET_ROUTE_GROUP } from "./gitDelivery/actionSheetRoutes.js";
import { GIT_DELIVERY_EVIDENCE_ROUTE_GROUP } from "./gitDelivery/evidenceRoutes.js";
import { GIT_DELIVERY_LOCAL_MUTATION_ROUTE_GROUP } from "./gitDelivery/localMutationRoutes.js";
import { GIT_DELIVERY_COMMIT_ROUTE_GROUP } from "./gitDelivery/commitRoutes.js";
import { GIT_DELIVERY_PUSH_ROUTE_GROUP } from "./gitDelivery/pushRoutes.js";
import { GIT_DELIVERY_PR_ROUTE_GROUP } from "./gitDelivery/prRoutes.js";
import { GIT_DELIVERY_MERGE_ROUTE_GROUP } from "./gitDelivery/mergeRoutes.js";
import { GIT_DELIVERY_SYNC_ROUTE_GROUP } from "./gitDelivery/syncRoutes.js";
import { GIT_AGENT_OPERATION_ROUTE_GROUP } from "./gitDelivery/agentOperationsRoutes.js";

export interface ApiError {
  readonly error: {
    readonly code: string;
    readonly message: string;
    // RB-6 (GEN-OBS-CORRELATION-103/402): a request-scoped correlation id an operator can grep for.
    // Optional and additive — when absent the body is byte-identical to the pre-RB-6 shape, so the
    // hundreds of routes/tests that assert `{ error: { code, message } }` are unaffected. Only the
    // paths that mint an id (the top-level 500 and any handler that opts in) surface it.
    readonly correlationId?: string;
  };
}

// A route handler returns the HTTP status and the JSON body to serialize, or STREAMING when it has
// written directly to the ServerResponse (SSE) and the server must not write a JSON body.
export interface RouteResult {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

export const STREAMING = Symbol("streaming");
export type HandlerOutcome = RouteResult | typeof STREAMING;

export interface RouteContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly params: Readonly<Record<string, string>>;
  // Parsed request URL (loopback-authority base); handlers read the query without re-parsing.
  readonly url: URL;
  // RB-6: the request-scoped correlation id minted at request entry (server.ts). Handlers that build
  // error responses or SSE error frames thread it through so a failure is traceable end-to-end.
  // Optional so the many existing RouteContext literals in tests compile unchanged.
  readonly correlationId?: string;
}

export type RouteHandler = (
  ctx: RouteContext,
  deps: UiHandlerDeps,
) => HandlerOutcome | Promise<HandlerOutcome>;

export interface RouteDefinition {
  readonly method: string;
  // Path template with `:name` segments captured into `RouteContext.params`.
  readonly pattern: string;
  readonly handler: RouteHandler;
}

function health(): RouteResult {
  return { status: 200, body: { status: "ok", version: SDK_VERSION } };
}

// The full route contract: the twelve original (ADR-0011 D5), the first-run gateway setup
// endpoint, the 10 additive UI-store routes (ADR-0013 D7), three Issue #66 run-summary routes,
// two desktop chat routes, desktop terminal JSON routes, and read-only Files widget routes.
// Terminal byte I/O uses a token-scoped WebSocket upgrade path.
export const API_ROUTES: readonly RouteDefinition[] = [
  { method: "GET", pattern: "/api/health", handler: health },
  { method: "GET", pattern: "/api/config", handler: handleConfig },
  { method: "GET", pattern: "/api/models", handler: handleModels },
  { method: "GET", pattern: "/api/voice/capability", handler: handleVoiceCapability },
  // Issue #494 (Epic #491) — optional, capability-gated STT composer dictation (ADR-0100 D1/D2/D4).
  // POST a short audio clip (base64 inside the JSON + CSRF envelope) and receive its transcript;
  // answers VOICE_UNAVAILABLE when no speech-to-text capability is configured/enabled.
  { method: "POST", pattern: "/api/voice/transcribe", handler: handleVoiceTranscribe },
  // Issue #1558 (Epic #1556) — optional, capability-gated assistant speech output (ADR-0095). POST
  // the visible assistant answer text (inside the JSON + CSRF envelope) and receive synthesized audio
  // as base64; answers VOICE_UNAVAILABLE when no speech-output capability is configured/enabled.
  { method: "POST", pattern: "/api/voice/speak", handler: handleVoiceSpeak },
  { method: "POST", pattern: "/api/voice/speak/stream", handler: handleVoiceSpeakStream },
  { method: "POST", pattern: "/api/gateway/readiness", handler: handleGatewayReadiness },
  { method: "POST", pattern: "/api/gateway/setup", handler: handleGatewaySetup },
  { method: "GET", pattern: "/api/update/preflight", handler: handleGetUpdatePreflight },
  {
    method: "POST",
    pattern: "/api/update/preflight/check",
    handler: handlePostUpdatePreflightCheck,
  },
  { method: "GET", pattern: "/api/update/session", handler: handleGetUpdateSession },
  { method: "POST", pattern: "/api/update/session", handler: handleCreateUpdateSession },
  { method: "POST", pattern: "/api/update/session/retry", handler: handleRetryUpdateSession },
  {
    method: "POST",
    pattern: "/api/update/session/verify-restart",
    handler: handleVerifyUpdateRestart,
  },
  { method: "DELETE", pattern: "/api/update/session", handler: handleCancelUpdateSession },
  { method: "GET", pattern: "/api/update/remediation", handler: handleGetUpdateRemediation },
  {
    method: "POST",
    pattern: "/api/update/remediation/status",
    handler: handlePostUpdateRemediationStatus,
  },
  {
    method: "POST",
    pattern: "/api/update/remediation/actions",
    handler: handleRunUpdateRemediationAction,
  },
  { method: "GET", pattern: "/api/workflows", handler: handleWorkflows },
  { method: "POST", pattern: "/api/runs", handler: handleCreateRun },
  { method: "GET", pattern: "/api/runs/events", handler: handleAllRunEvents },
  { method: "GET", pattern: "/api/runs/:runId/events", handler: handleRunEvents },
  { method: "POST", pattern: "/api/runs/:runId/cancel", handler: handleCancelRun },
  { method: "GET", pattern: "/api/runs/:runId", handler: handleGetRun },
  { method: "POST", pattern: "/api/runs/:runId/apply", handler: handleApplyRun },
  { method: "GET", pattern: "/api/evidence", handler: handleEvidenceList },
  { method: "GET", pattern: "/api/evidence/:runId", handler: handleEvidenceDetail },
  { method: "GET", pattern: "/api/workspace", handler: handleWorkspace },
  { method: "GET", pattern: "/api/workspace/state", handler: handleGetWorkspaceState },
  { method: "PUT", pattern: "/api/workspace/state", handler: handlePutWorkspaceState },
  // ADR-0013 D7 — UI-local persistence routes (additive).
  { method: "GET", pattern: "/api/projects", handler: handleListProjects },
  { method: "POST", pattern: "/api/projects", handler: handleCreateProject },
  { method: "PATCH", pattern: "/api/projects", handler: handleUpdateProject },
  { method: "DELETE", pattern: "/api/projects", handler: handleDeleteProject },
  { method: "POST", pattern: "/api/repositories/clone", handler: handleCloneRepository },
  { method: "GET", pattern: "/api/chats", handler: handleListChats },
  { method: "POST", pattern: "/api/chats", handler: handleCreateChat },
  { method: "PATCH", pattern: "/api/chats", handler: handleUpdateChat },
  { method: "DELETE", pattern: "/api/chats", handler: handleDeleteChat },
  { method: "GET", pattern: "/api/chats/messages", handler: handleListMessages },
  { method: "POST", pattern: "/api/chats/messages", handler: handleCreateMessage },
  // Issue #66 — atomic composer write: exactly one user message plus one run-summary system message.
  {
    method: "POST",
    pattern: "/api/chats/messages/run-summary-pair",
    handler: handleCreateRunSummaryPair,
  },
  // Issue #66 — PATCH a run-summary message (status/shortResult/taskType).
  { method: "PATCH", pattern: "/api/chats/messages", handler: handleUpdateMessage },
  // Issue #185 — grounded repository-aware Q&A. Composes #179-#183 behind the chat-scope binding.
  { method: "POST", pattern: "/api/chats/messages/grounded", handler: handleGroundedAsk },
  {
    method: "POST",
    pattern: "/api/voice/realtime/grounded-tool",
    handler: handleRealtimeGroundedVoiceTool,
  },
  // Desktop canvas V1 — real chat against the configured gateway model without new agent scope.
  { method: "POST", pattern: "/api/desktop/chats", handler: handleCreateDesktopChat },
  { method: "POST", pattern: "/api/desktop/chat", handler: handleSendDesktopChat },
  { method: "POST", pattern: "/api/desktop/chat/regenerate", handler: handleRegenerateDesktopChat },
  { method: "POST", pattern: "/api/desktop/chat/stream", handler: handleSendDesktopChatStream },
  {
    method: "POST",
    pattern: "/api/desktop/chat/voice-turn",
    handler: handleAppendDesktopVoiceTurn,
  },
  // ADR-0018 — bounded permitted-command execution. PTY routes (shells/sessions/WS upgrade) and
  // the WebSocket upgrade handler in server.ts are removed; commands run via synchronous POST.
  { method: "GET", pattern: "/api/terminal/policy", handler: handleTerminalPolicy },
  { method: "GET", pattern: "/api/terminal/directories", handler: handleTerminalDirectories },
  { method: "POST", pattern: "/api/terminal/executions", handler: handleCreateTerminalExecution },
  {
    method: "DELETE",
    pattern: "/api/terminal/executions/:executionId",
    handler: handleDeleteTerminalExecution,
  },
  { method: "GET", pattern: "/api/terminal/events", handler: handleTerminalEvents },
  // Issue #1385 — read-only local runtime inventory. Metadata-only detection: no package manager,
  // Git, language, or container command is executed; root-scoped command sources use contained
  // manifest reads on a registered project.
  {
    method: "GET",
    pattern: "/api/runtime/capabilities",
    handler: (ctx, deps) =>
      handleRuntimeCapabilities(ctx, deps, deps.runtimeCapabilityRouteOptions),
  },
  // Issue #1386 — read-only Git repository status/diff BFF. Git execution stays server-side with
  // fixed args/env, selected-root containment, unsafe-owner surfacing, and bounded diff output.
  {
    method: "GET",
    pattern: "/api/git/status",
    handler: (ctx, deps) => handleGitStatus(ctx, deps, deps.gitRouteOptions),
  },
  {
    method: "GET",
    pattern: "/api/git/diff",
    handler: (ctx, deps) => handleGitDiff(ctx, deps, deps.gitRouteOptions),
  },
  {
    method: "GET",
    pattern: "/api/git/branches",
    handler: (ctx, deps) => handleGitBranches(ctx, deps, deps.gitRouteOptions),
  },
  // Issue #1573 — read-only Git repository summary, history, and remotes BFF. Reuses the hardened
  // runner + selected-root containment from the #1386 reads; responses are content-free (counts,
  // typed codes, branch/remote names, ISO dates) and pass through the live-payload redactor.
  {
    method: "GET",
    pattern: "/api/git/summary",
    handler: (ctx, deps) => handleGitSummary(ctx, deps, deps.gitRouteOptions),
  },
  {
    method: "GET",
    pattern: "/api/git/history",
    handler: (ctx, deps) => handleGitHistory(ctx, deps, deps.gitRouteOptions),
  },
  {
    method: "GET",
    pattern: "/api/git/remotes",
    handler: (ctx, deps) => handleGitRemotes(ctx, deps, deps.gitRouteOptions),
  },
  {
    method: "POST",
    pattern: "/api/native-file-dialog/open",
    handler: handleNativeFileDialogOpen,
  },
  // Issue #1387 — controlled test/build/run command executor. Tasks are discovered from package
  // scripts and run through the single governed spawn boundary (keiko-tools runCommand): allowlisted
  // task ids only (never free-form argv), workspace-contained cwd, output cap, timeout, cancellation,
  // and content-free evidence. Literal `catalog`/`events` paths register before the `:runId` route.
  {
    method: "GET",
    pattern: "/api/commands/catalog",
    handler: handleCommandCatalog,
  },
  {
    method: "GET",
    pattern: "/api/commands/events",
    handler: handleCommandEvents,
  },
  { method: "POST", pattern: "/api/commands/runs", handler: handleCreateCommandRun },
  {
    method: "DELETE",
    pattern: "/api/commands/runs/:runId",
    handler: handleDeleteCommandRun,
  },
  // Issue #445 (Epic #443, ADR-0089) — governed managed task-workspace provisioning + activation.
  // Provision creates a dedicated task branch + managed Git worktree from an approved base branch
  // through the narrow worktree adapter (single governed spawn boundary; no generic git runner) and
  // persists a WorkspaceInstance; activate yields the WorkspaceBinding surfaces bind to. CSRF is
  // enforced by the server's state-changing gate for the POST routes.
  { method: "POST", pattern: "/api/task-workspaces", handler: handleProvisionTaskWorkspace },
  // Issue #446 (Epic #443, ADR-0090) — the shared ACTIVE task-workspace binding the Studio/editor/
  // runtime/Git-Delivery surfaces consume. `matchRoute` resolves by literal specificity, so the
  // literal `active` and the `?root` collection paths win over the `:workspaceId` param route
  // regardless of registration order. CSRF is enforced by the state-changing gate for POST/DELETE.
  { method: "GET", pattern: "/api/task-workspaces", handler: handleListTaskWorkspaces },
  { method: "GET", pattern: "/api/task-workspaces/active", handler: handleGetActiveTaskWorkspace },
  { method: "POST", pattern: "/api/task-workspaces/active", handler: handleSetActiveTaskWorkspace },
  {
    method: "DELETE",
    pattern: "/api/task-workspaces/active",
    handler: handleClearActiveTaskWorkspace,
  },
  {
    method: "POST",
    pattern: "/api/task-workspaces/:workspaceId/pause",
    handler: handlePauseTaskWorkspace,
  },
  {
    method: "POST",
    pattern: "/api/task-workspaces/:workspaceId/resume",
    handler: handleResumeTaskWorkspace,
  },
  {
    method: "POST",
    pattern: "/api/task-workspaces/:workspaceId/handoff",
    handler: handleHandoffTaskWorkspace,
  },
  {
    method: "POST",
    pattern: "/api/task-workspaces/:workspaceId/activate",
    handler: handleActivateTaskWorkspace,
  },
  // Issue #447 (Epic #443, ADR-0091) — startup reconciliation report (read-only, derived from the
  // persisted content-free fields), an explicit live reconcile pass (CSRF-gated POST), and the
  // controlled, operator-approval-gated repair. The literal `reconciliation` path wins over the
  // `:workspaceId` GET by `matchRoute` specificity.
  {
    method: "GET",
    pattern: "/api/task-workspaces/reconciliation",
    handler: handleGetTaskWorkspaceReconciliation,
  },
  {
    method: "POST",
    pattern: "/api/task-workspaces/reconciliation",
    handler: handleReconcileTaskWorkspaces,
  },
  {
    method: "POST",
    pattern: "/api/task-workspaces/:workspaceId/repair",
    handler: handleRepairTaskWorkspace,
  },
  // Issue #448 (Epic #443, ADR-0092) — operational health/drift/orphan report (read-only) plus the
  // governed, operator-approval-gated cleanup controls. The literal `health` and `cleanup/orphans`
  // paths win over the `:workspaceId` routes by `matchRoute` specificity.
  { method: "GET", pattern: "/api/task-workspaces/health", handler: handleGetTaskWorkspaceHealth },
  {
    method: "POST",
    pattern: "/api/task-workspaces/cleanup/orphans",
    handler: handleCleanupOrphanTaskWorkspaces,
  },
  {
    method: "POST",
    pattern: "/api/task-workspaces/:workspaceId/cleanup",
    handler: handleCleanupTaskWorkspace,
  },
  { method: "GET", pattern: "/api/task-workspaces/:workspaceId", handler: handleGetTaskWorkspace },
  // Issue #1388 (ADR-0070) — governed container engine detection + execution pilot. The capability
  // route runs an opt-in ACTIVE daemon probe (distinct from the metadata-only #1385 detector); the
  // catalog/run routes degrade to 503 CONTAINER_ENGINE_UNAVAILABLE when no engine is present. A run
  // names a closed-catalog task id only (never a free-form image/argv/flag), executes a server-frozen
  // hardened `docker run` argv through the single runCommand boundary, and writes content-free
  // evidence. Literal `capability`/`catalog`/`events` paths register before the `:runId` route.
  {
    method: "GET",
    pattern: "/api/containers/capability",
    handler: handleContainerCapability,
  },
  {
    method: "GET",
    pattern: "/api/containers/catalog",
    handler: handleContainerCatalog,
  },
  {
    method: "GET",
    pattern: "/api/containers/events",
    handler: handleContainerEvents,
  },
  { method: "POST", pattern: "/api/containers/runs", handler: handleCreateContainerRun },
  {
    method: "DELETE",
    pattern: "/api/containers/runs/:runId",
    handler: handleDeleteContainerRun,
  },
  // Desktop files — selected-root browser, preview, and editor control plane.
  { method: "GET", pattern: "/api/files/directories", handler: handleFilesDirectories },
  { method: "GET", pattern: "/api/files/tree", handler: handleFilesTree },
  { method: "GET", pattern: "/api/files/search", handler: handleFilesSearch },
  { method: "GET", pattern: "/api/files/preview", handler: handleFilesPreview },
  { method: "GET", pattern: "/api/files/preview/image", handler: handleFilesPreviewImage },
  { method: "GET", pattern: "/api/files/content", handler: handleFilesContent },
  { method: "PATCH", pattern: "/api/files/content", handler: handleFilesContent },
  // File-tree mutations (create / rename / delete). State-changing methods inherit the server CSRF +
  // JSON gate; each handler re-resolves containment + deny inside the selected root and is
  // non-destructive by default (atomic no-overwrite create, no-clobber rename, symlinks rejected).
  { method: "POST", pattern: "/api/files/create", handler: handleFilesCreate },
  { method: "POST", pattern: "/api/files/rename", handler: handleFilesRename },
  { method: "POST", pattern: "/api/files/delete", handler: handleFilesDelete },
  { method: "POST", pattern: "/api/files/copy", handler: handleFilesCopy },
  // Issue #1198 — deterministic, model-free language intelligence (completion, diagnostics, hover,
  // symbols) over an editor overlay (ADR-0042 D4). Capabilities advertises the registered providers.
  {
    method: "GET",
    pattern: "/api/editor/language/capabilities",
    handler: (ctx, deps) =>
      handleEditorLanguageCapabilitiesForRoute(ctx, deps, deps.editorLanguageRouteOptions),
  },
  {
    method: "POST",
    pattern: "/api/editor/language",
    handler: (ctx, deps) => handleEditorLanguage(ctx, deps, deps.editorLanguageRouteOptions),
  },
  // Issue #1211 — governed coding-context retrieval (ADR-0042 D6). The context route assembles a
  // bounded, redacted pack (repo-search always; Local Knowledge + memory only for explicit,
  // embedding-eligible purposes) and returns the content-free wire pack; the repo-search and
  // local-knowledge routes expose the governed building blocks (EvidenceAtom[] and query-only
  // retrieval references). No browser-side retrieval, embedding, or model access.
  { method: "POST", pattern: "/api/editor/context", handler: handleEditorContext },
  { method: "POST", pattern: "/api/editor/repo-search", handler: handleEditorRepoSearch },
  // Editor hot-exit recovery: content is persisted only in the server-owned encrypted local store.
  // Browser IndexedDB keeps metadata and an opaque ref, never raw file contents or workspace paths.
  { method: "POST", pattern: "/api/editor/hot-exit/write", handler: handleEditorHotExitWrite },
  { method: "POST", pattern: "/api/editor/hot-exit/read", handler: handleEditorHotExitRead },
  { method: "POST", pattern: "/api/editor/hot-exit/delete", handler: handleEditorHotExitDelete },
  // Issue #1199 — governed completion gateway (ADR-0042 D4/D5/D6). Deterministic language-service
  // completion (#1198) always, plus gated model-assisted completion (#1210) over coding context
  // (#1211). Content-free response apart from reviewable insertText; the browser never reaches a model.
  { method: "POST", pattern: "/api/editor/completion", handler: handleEditorCompletion },
  // Issue #1200 — governed inline completion (ghost text, ADR-0042 D5/D6). Model-only, gated on an
  // aligned FIM model (#1210) over coding context (#1211, purpose:inline); degrades to zero items
  // (falling back to #1199) when unavailable, disabled by policy, or rate-limited. The telemetry
  // route records content-free acceptance/rejection counts. The browser never reaches a model.
  {
    method: "POST",
    pattern: "/api/editor/inline-completion",
    handler: handleEditorInlineCompletion,
  },
  {
    method: "POST",
    pattern: "/api/editor/inline-completion/telemetry",
    handler: handleEditorInlineCompletionTelemetry,
  },
  // Issue #1202 — governed editor-driven test generation (ADR-0042 D7). Wave-2 surface shipped
  // switched OFF: default → `disabled` (no retrieval/model/execution); enabled → `deferred` (governed
  // #1211 discovery for provenance, but NO model call) until an enforced egress boundary unlocks
  // candidate generation. No v1 flow executes model-generated code; the browser never reaches a model.
  {
    method: "POST",
    pattern: "/api/editor/test-generation",
    handler: handleEditorTestGeneration,
  },
  // Issue #1204 — governed editor-driven patch apply + post-apply verification (ADR-0042 D7, ADR-0043).
  // Wave-2 surface shipped switched OFF: default → `disabled` (no validation/write/execution). When
  // enabled, a reviewed candidate patch is applied only on an explicit user decision and only after
  // keiko-tools validation (scope, conflict, no-silent-overwrite, limits); post-apply verification then
  // re-confirms the applied test under an enforced, deny-by-default egress boundary (keiko-sandbox), and
  // a failed verification surfaces a guarded revert proposal (never a silent rollback).
  {
    method: "POST",
    pattern: "/api/editor/patch-apply",
    handler: handleEditorPatchApply,
  },
  {
    method: "GET",
    pattern: "/api/editor/agent/sessions",
    handler: handleEditorAgentSessions,
  },
  {
    method: "POST",
    pattern: "/api/editor/agent/snapshot",
    handler: handleEditorAgentSnapshot,
  },
  {
    method: "POST",
    pattern: "/api/editor/agent/actions",
    handler: handleEditorAgentActions,
  },
  {
    method: "GET",
    pattern: "/api/editor/agent/events",
    handler: handleEditorAgentEvents,
  },
  // Issue #1395 (ADR-0062) — read-only bounded audit feed of recent agent editor actions.
  {
    method: "GET",
    pattern: "/api/editor/agent/audit",
    handler: handleEditorAgentAudit,
  },
  // Issue #1381 (ADR-0069) — read-only, content-free LSP process lifecycle status feed. Env-gated
  // default-OFF via KEIKO_EDITOR_LSP_STATUS (404 until an operator opts in). No CSP change needed.
  {
    method: "GET",
    pattern: "/api/editor/lsp/status",
    handler: (ctx, deps) => handleEditorLspStatus(ctx, { env: deps.env }),
  },
  {
    method: "POST",
    pattern: "/api/editor/local-knowledge/retrieve",
    handler: handleEditorLocalKnowledgeRetrieve,
  },
  // Issue #198 audit fix — live capsule detail/health routes for the Local Knowledge UI.
  {
    method: "GET",
    pattern: "/api/local-knowledge/capsules",
    handler: handleListLocalKnowledgeCapsules,
  },
  {
    method: "POST",
    pattern: "/api/local-knowledge/capsules",
    handler: handleCreateLocalKnowledgeCapsule,
  },
  {
    method: "GET",
    pattern: "/api/local-knowledge/capsule-sets",
    handler: handleListLocalKnowledgeCapsuleSets,
  },
  {
    method: "POST",
    pattern: "/api/local-knowledge/capsule-sets",
    handler: handleCreateLocalKnowledgeCapsuleSet,
  },
  {
    method: "GET",
    pattern: "/api/local-knowledge/capsules/:capsuleId",
    handler: handleGetLocalKnowledgeCapsule,
  },
  {
    method: "PATCH",
    pattern: "/api/local-knowledge/capsules/:capsuleId",
    handler: handleUpdateLocalKnowledgeCapsule,
  },
  {
    method: "POST",
    pattern: "/api/local-knowledge/capsules/:capsuleId/index",
    handler: handleStartLocalKnowledgeCapsuleIndexing,
  },
  {
    method: "DELETE",
    pattern: "/api/local-knowledge/capsules/:capsuleId/index",
    handler: handleCancelLocalKnowledgeCapsuleIndexing,
  },
  {
    method: "POST",
    pattern: "/api/local-knowledge/capsules/:capsuleId/connection",
    handler: handleConnectLocalKnowledgeCapsule,
  },
  {
    method: "DELETE",
    pattern: "/api/local-knowledge/capsules/:capsuleId/connection",
    handler: handleDisconnectLocalKnowledgeCapsule,
  },
  {
    method: "PATCH",
    pattern: "/api/local-knowledge/capsules/:capsuleId/sources/:sourceId/root",
    handler: handleRebindLocalKnowledgeCapsuleSource,
  },
  {
    method: "DELETE",
    pattern: "/api/local-knowledge/capsules/:capsuleId",
    handler: handleDeleteLocalKnowledgeCapsule,
  },
  {
    method: "POST",
    pattern: "/api/local-knowledge/capsules/:capsuleId/reindex",
    handler: handleReindexLocalKnowledgeCapsule,
  },
  {
    method: "POST",
    pattern: "/api/local-knowledge/citation-preview/status",
    handler: handleGetPdfCitationPreviewStatus,
  },
  {
    method: "POST",
    pattern: "/api/local-knowledge/citation-preview/authorize",
    handler: handleAuthorizePdfCitationPreview,
  },
  {
    method: "POST",
    pattern: "/api/local-knowledge/citation-preview/open",
    handler: handleOpenPdfCitationPreviewSession,
  },
  {
    method: "GET",
    pattern: "/api/local-knowledge/citation-preview/sessions/:sessionHandle/document",
    handler: handleGetPdfCitationPreviewDocument,
  },
  {
    method: "DELETE",
    pattern: "/api/local-knowledge/citation-preview/sessions/:sessionHandle",
    handler: handleClosePdfCitationPreviewSession,
  },
  // Issues #209/#211 — MemoriaViva governance routes (Epic #204).
  { method: "GET", pattern: "/api/memory", handler: handleListMemories },
  { method: "GET", pattern: "/api/memory/review-queue", handler: handleMemoryReviewQueue },
  { method: "POST", pattern: "/api/memory/forget", handler: handleForgetMemories },
  {
    method: "POST",
    pattern: "/api/memory/conflicts/resolve",
    handler: handleResolveMemoryConflict,
  },
  { method: "GET", pattern: "/api/memory/:id", handler: handleGetMemory },
  { method: "PATCH", pattern: "/api/memory/:id", handler: handleEditMemory },
  { method: "POST", pattern: "/api/memory/:id/pin", handler: handlePinMemory },
  { method: "POST", pattern: "/api/memory/:id/unpin", handler: handleUnpinMemory },
  { method: "POST", pattern: "/api/memory/:id/archive", handler: handleArchiveMemory },
  { method: "POST", pattern: "/api/memory/:id/forget", handler: handleForgetMemory },
  { method: "DELETE", pattern: "/api/memory/:id", handler: handleDeleteMemory },
  { method: "POST", pattern: "/api/memory/:id/correct", handler: handleCorrectMemory },
  {
    method: "POST",
    pattern: "/api/memory/proposals/:id/accept",
    handler: handleAcceptMemoryProposal,
  },
  {
    method: "POST",
    pattern: "/api/memory/proposals/:id/reject",
    handler: handleRejectMemoryProposal,
  },
  // Issue #212 — Conversation Center memory wiring.
  { method: "POST", pattern: "/api/memory/context", handler: handleMemoryRetrieveContext },
  {
    method: "POST",
    pattern: "/api/memory/capture-from-conversation",
    handler: handleMemoryCaptureFromConversation,
  },
  // Issue #208 — explicit consolidation jobs for the MemoriaViva review surface.
  {
    method: "POST",
    pattern: "/api/memory/consolidation/jobs",
    handler: handleCreateConsolidationJob,
  },
  {
    method: "GET",
    pattern: "/api/memory/consolidation/jobs/:jobId",
    handler: handleGetConsolidationJob,
  },
  {
    method: "POST",
    pattern: "/api/memory/consolidation/jobs/:jobId/cancel",
    handler: handleCancelConsolidationJob,
  },
  // Issue #204 — bounded, user-triggerable memory maintenance (consolidate + decay + forget).
  { method: "POST", pattern: "/api/memory/maintenance", handler: handleRunMaintenance },
  // ADR-0017 — browser tool (BYO Chrome over CDP).
  { method: "GET", pattern: "/api/browser/status", handler: handleBrowserStatus },
  { method: "POST", pattern: "/api/browser/sessions", handler: handleCreateBrowserSession },
  {
    method: "DELETE",
    pattern: "/api/browser/sessions/:sessionId",
    handler: handleDeleteBrowserSession,
  },
  {
    method: "POST",
    pattern: "/api/browser/sessions/:sessionId/navigate",
    handler: handleBrowserNavigate,
  },
  {
    method: "POST",
    pattern: "/api/browser/sessions/:sessionId/screenshot",
    handler: handleBrowserScreenshot,
  },
  {
    method: "POST",
    pattern: "/api/browser/sessions/:sessionId/apply",
    handler: handleBrowserApplyScreenshot,
  },
  {
    method: "POST",
    pattern: "/api/browser/sessions/:sessionId/content",
    handler: handleBrowserContent,
  },
  {
    method: "GET",
    pattern: "/api/browser/sessions/:sessionId/events",
    handler: handleBrowserEvents,
  },
  // Epic #1851 (ADR-0113) — governed documentation browser navigation (product-level adapter).
  { method: "POST", pattern: "/api/docs-browser/navigate", handler: handleDocsBrowserNavigate },
  { method: "POST", pattern: "/api/docs-browser/propose", handler: handleDocsBrowserPropose },
  { method: "POST", pattern: "/api/docs-browser/approve", handler: handleDocsBrowserApprove },
  // Issue #278 (Epic #270) — Quality Intelligence connector routes (additive).
  // Authorisation defaults to FALSE; only flips on explicit gateway-config flags.
  // No outbound network call; no provider SDK import.
  {
    method: "POST",
    pattern: "/api/quality-intelligence/sources/select",
    handler: handleQiSourceSelect,
  },
  {
    method: "POST",
    pattern: "/api/quality-intelligence/sources/dryrun-figma",
    handler: handleQiDryRunFigma,
  },
  {
    method: "POST",
    pattern: "/api/quality-intelligence/sources/dryrun-jira",
    handler: handleQiDryRunJira,
  },
  {
    method: "GET",
    pattern: "/api/quality-intelligence/sources/capabilities",
    handler: handleQiCapabilities,
  },
  // Epic #1307 / Issue #1314 — Prompt Enhancer governed BFF route (additive). Composes the
  // deterministic enhancer core (#1309–#1313) through the Model Gateway; never dispatches a model.
  { method: "POST", pattern: "/api/prompt-enhancement", handler: handlePromptEnhancement },
  {
    method: "GET",
    pattern: "/api/prompt-enhancement/evidence/:runId",
    handler: handlePromptEnhancementEvidence,
  },
  // Issue #280 (Epic #270) — Quality Intelligence UI read routes (additive). Composed from
  // keiko-evidence UNCHANGED (ADR-0023 D8).
  { method: "GET", pattern: "/api/quality-intelligence/runs", handler: handleListQiRuns },
  { method: "GET", pattern: "/api/quality-intelligence/runs/:id", handler: handleGetQiRun },
  // QI model orchestration policy: local persisted defaults + preflight.
  ...QI_MODEL_POLICY_ROUTE_GROUP,
  // Issue #273/#280 (Epic #270) — Quality Intelligence run execution: start (SSE progress stream)
  // + cancel. The model-routed test-design workflow runs through the Keiko Model Gateway and
  // persists the manifest + candidate artifact through Keiko Evidence.
  ...QI_RUN_EXECUTION_ROUTE_GROUP,
  // Issue #282/#283 (Epic #270) — Quality Intelligence review governance + export. Literal-suffix
  // POST routes (/runs/:id/review, /runs/:id/export) disambiguate against /runs/:id/cancel.
  ...QI_REVIEW_ROUTE_GROUP,
  ...QI_EXPORT_ROUTE_GROUP,
  // Issue #726 (Epic #712) — inline candidate editing. Literal-suffix POST /runs/:id/edit
  // disambiguates against /runs/:id/cancel just like /review and /export above.
  ...QI_EDIT_ROUTE_GROUP,
  // Issue #282 follow-up (Epic #270) — run-deletion control. DELETE /runs/:id is method-distinct
  // from GET /runs/:id and sweeps every server-owned companion (ADR-0023 D8).
  ...QI_RETENTION_ROUTE_GROUP,
  // Issue #740 (Epic #734) — requirement↔test traceability matrix export.
  ...QI_TRACEABILITY_ROUTE_GROUP,
  // Issue #743 (Epic #735) — drift re-check + targeted regeneration. Literal-suffix POST routes
  // (:id/re-check, :id/regenerate-stale) must be registered before any parameterised sibling.
  ...QI_RECHECK_ROUTE_GROUP,
  // Issue #539 (Epic #532) — relationship engine routes. The api-contract.md §2 ordering
  // is preserved; literal-suffix paths (validate, impact, health, events) come BEFORE the
  // `:id`-templated routes so matchRoute returns the literal handler instead of binding
  // "validate" / "impact" / "health" / "events" to the `:id` param. Internal route #11
  // (events) returns the STREAMING sentinel from `handleRelationshipEvents`.
  { method: "POST", pattern: "/api/relationships/validate", handler: handleRelationshipValidate },
  { method: "GET", pattern: "/api/relationships/impact", handler: handleRelationshipImpact },
  { method: "GET", pattern: "/api/relationships/health", handler: handleRelationshipHealth },
  { method: "GET", pattern: "/api/relationships/events", handler: handleRelationshipEvents },
  { method: "POST", pattern: "/api/relationships", handler: handleRelationshipCreate },
  { method: "GET", pattern: "/api/relationships", handler: handleRelationshipList },
  { method: "GET", pattern: "/api/relationships/:id", handler: handleRelationshipGet },
  { method: "PATCH", pattern: "/api/relationships/:id", handler: handleRelationshipPatch },
  { method: "DELETE", pattern: "/api/relationships/:id", handler: handleRelationshipDelete },
  {
    method: "GET",
    pattern: "/api/relationships/:id/dependencies",
    handler: handleRelationshipDependencies,
  },
  { method: "GET", pattern: "/api/relationships/:id/explain", handler: handleRelationshipExplain },
  // Epic #750, Issue #756 — Figma Snapshot UI routes. PAT stays server-side; UI-safe projection only.
  // POST triggers a bounded snapshot-build from a board link; GET loads the stored summary.
  // Token: resolved server-side from vault, config, or FIGMA_ACCESS_TOKEN env; never in response.
  { method: "POST", pattern: "/api/figma/snapshots", handler: handleFigmaTriggerSnapshot },
  { method: "GET", pattern: "/api/figma/snapshots", handler: handleFigmaListSnapshots },
  { method: "GET", pattern: "/api/figma/snapshots/:runId", handler: handleFigmaLoadSnapshot },
  {
    method: "PATCH",
    pattern: "/api/figma/snapshots/:runId",
    handler: handleFigmaUpdateSnapshotMetadata,
  },
  { method: "DELETE", pattern: "/api/figma/snapshots/:runId", handler: handleFigmaDeleteSnapshot },
  {
    method: "GET",
    pattern: "/api/figma/snapshots/:runId/screens/:screenId/json",
    handler: handleFigmaInspectSnapshotScreenJson,
  },
  {
    method: "GET",
    pattern: "/api/figma/snapshots/:runId/screens/:screenIndex/image",
    handler: handleFigmaLoadSnapshotImage,
  },
  // Epic #750 #758/#760 — operator revokes the stored encrypted PAT (audited key removal).
  { method: "DELETE", pattern: "/api/figma/token", handler: handleFigmaRevokeToken },
  // Epic #750 #755 — design-to-code: emit reviewable HTML/CSS from a stored snapshot.
  { method: "POST", pattern: "/api/figma/snapshots/:runId/code", handler: handleFigmaGenerateCode },
  // Issue #281 (Epic #270) — Conversation Center → QI workflow handoff route group.
  // Single POST seam; the body is a typed `QualityIntelligenceConversationCenterHandoff`
  // envelope (refs only, no chat content). Registered as a sibling group so concurrent
  // QI epic merges (e.g. #280) stay mechanically merge-safe.
  ...QI_HANDOFF_ROUTE_GROUP,
  // Issue #473 (Epic #470) — governed Git delivery action-sheet route group. Single READ-ONLY
  // POST seam returning a UI-safe GitDeliveryActionSheet projection; never mutates the repo.
  // Registered as a sibling group so concurrent #470 epic merges stay mechanically merge-safe.
  ...GIT_DELIVERY_ACTION_SHEET_ROUTE_GROUP,
  ...GIT_DELIVERY_EVIDENCE_ROUTE_GROUP,
  // #475 governed local write flows: branch create/switch, staging, and commit preview/execute. These
  // EXECUTE through the #472 kernel + #474 evidence ledger; gated by the same capability flag and CSRF.
  ...GIT_DELIVERY_LOCAL_MUTATION_ROUTE_GROUP,
  ...GIT_DELIVERY_COMMIT_ROUTE_GROUP,
  // #476 governed remote publish: push preview (read-only) + execute through the SEPARATE publish
  // gateway (dedicated push-only allowlist) + #474 evidence ledger; same capability flag and CSRF.
  ...GIT_DELIVERY_PUSH_ROUTE_GROUP,
  // #477 governed GitHub pull request command center: PR preview (read-only metadata/readiness/
  // recommendation) + execute through the SEPARATE PR gateway (dedicated `gh api` allowlist) + #474
  // evidence ledger; same capability flag and CSRF.
  ...GIT_DELIVERY_PR_ROUTE_GROUP,
  // #478 governed merge: merge preview (read-only readiness/eligible-strategies/recommendation) +
  // execute through the SEPARATE merge gateway (dedicated `gh api` merge allowlist, readiness gate, final
  // approval) + #474 evidence ledger; same capability flag and CSRF.
  ...GIT_DELIVERY_MERGE_ROUTE_GROUP,
  // #1573 governed fetch/pull sync: sync preview (read-only readiness + executable gate) + execute
  // through a preflight-gated credential-capable runner (NOT the #472 kernel — fetch/pull have no
  // GitDeliveryActionKind) + a dedicated content-free sync evidence ledger; same central CSRF + JSON
  // content-type gate.
  ...GIT_DELIVERY_SYNC_ROUTE_GROUP,
  // #1577 agent repository operations: typed facade over existing Git read and governed delivery
  // handlers. No shell/provider authority is introduced; command-shaped payloads are denied first.
  ...GIT_AGENT_OPERATION_ROUTE_GROUP,
];

interface PreparedRoute {
  readonly definition: RouteDefinition;
  readonly parts: readonly string[];
  readonly specificity: number;
}

function prepareRoute(definition: RouteDefinition): PreparedRoute {
  const parts = definition.pattern.split("/");
  return {
    definition,
    parts,
    specificity: parts.filter((part) => !part.startsWith(":")).length,
  };
}

const PREPARED_API_ROUTES: readonly PreparedRoute[] = API_ROUTES.map(prepareRoute);
const PREPARED_ROUTES_BY_METHOD: ReadonlyMap<string, readonly PreparedRoute[]> = ((): ReadonlyMap<
  string,
  readonly PreparedRoute[]
> => {
  const routesByMethod = new Map<string, PreparedRoute[]>();
  for (const route of PREPARED_API_ROUTES) {
    const routes = routesByMethod.get(route.definition.method) ?? [];
    routes.push(route);
    routesByMethod.set(route.definition.method, routes);
  }
  return routesByMethod;
})();

// Matches a concrete path against prepared route parts, capturing `:name` params. Returns the captured
// params, or undefined when the segment counts differ or a literal segment mismatches.
function matchPatternParts(
  patternParts: readonly string[],
  pathParts: readonly string[],
): Readonly<Record<string, string>> | undefined {
  if (patternParts.length !== pathParts.length) {
    return undefined;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i] ?? "";
    const actual = pathParts[i] ?? "";
    if (p.startsWith(":")) {
      if (actual.length === 0) {
        return undefined;
      }
      params[p.slice(1)] = actual;
    } else if (p !== actual) {
      return undefined;
    }
  }
  return params;
}

function bestOtherMethodSpecificity(method: string, pathParts: readonly string[]): number {
  let bestSpecificity = -1;
  for (const route of PREPARED_API_ROUTES) {
    if (route.definition.method === method || route.specificity <= bestSpecificity) {
      continue;
    }
    if (matchPatternParts(route.parts, pathParts) !== undefined) {
      bestSpecificity = route.specificity;
    }
  }
  return bestSpecificity;
}

export interface RouteMatch {
  readonly definition: RouteDefinition;
  readonly params: Readonly<Record<string, string>>;
}

// Resolves a method+path to a route. Returns `{ definition, params }` on a full match, the string
// `"method-not-allowed"` when the path matches a route of a different method, or undefined when no
// route path matches at all.
export function matchRoute(
  method: string,
  pathname: string,
): RouteMatch | "method-not-allowed" | undefined {
  let bestMethodMatch: RouteMatch | undefined;
  let bestMethodSpecificity = -1;
  const pathParts = pathname.split("/");
  for (const route of PREPARED_ROUTES_BY_METHOD.get(method) ?? []) {
    const params = matchPatternParts(route.parts, pathParts);
    if (params === undefined) {
      continue;
    }
    if (route.specificity > bestMethodSpecificity) {
      bestMethodSpecificity = route.specificity;
      bestMethodMatch = { definition: route.definition, params };
    }
  }
  const otherMethodSpecificity = bestOtherMethodSpecificity(method, pathParts);
  if (bestMethodMatch !== undefined && bestMethodSpecificity >= otherMethodSpecificity) {
    return bestMethodMatch;
  }
  return otherMethodSpecificity >= 0 ? "method-not-allowed" : undefined;
}

export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

export function errorBody(code: string, message: string, correlationId?: string): ApiError {
  return { error: { code, message, ...(correlationId === undefined ? {} : { correlationId }) } };
}

export function notFoundBody(): ApiError {
  return errorBody("NOT_FOUND", "The requested resource was not found.");
}

export function methodNotAllowedBody(): ApiError {
  return errorBody("METHOD_NOT_ALLOWED", "The HTTP method is not allowed for this resource.");
}
