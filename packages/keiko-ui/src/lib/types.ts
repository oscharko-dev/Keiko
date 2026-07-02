// Browser-safe contract seam for the UI (ADR-0019 rule 8). Every name in this file
// is a pure re-export; zero type definitions live here. The wire entity shapes come from
// @oscharko-dev/keiko-contracts/bff-wire; evidence and verification-summary shapes come from
// their respective subpaths; everything else comes from the contracts root barrel. The SSE stream
// aggregation is UI-internal because no orchestration package knows about the union of all three
// sources, so it lives in ./sse-types and is re-exported here for ergonomic `@/lib/types` consumers.

// ─── Gateway + workflow descriptor canonical types (contracts root barrel) ─────────
export type {
  CostClass,
  LatencyClass,
  ModelKind,
  ModelCapability,
  ConversationIneligibilityReason,
  UsageMetadata,
  WorkflowDescriptor,
  WorkflowInputSpec,
  GroundingLimits,
  GitRepositoryState,
  GitUnavailableReason,
  GitStatusCode,
  GitChangedFile,
  GitRepositoryStatusResponse,
  GitDiffScope,
  GitRepositoryDiffResponse,
  GitRepositorySummary,
  GitRepositorySummaryRemote,
  GitRemoteSummary,
  GitRemotesResponse,
  GitHistoryEntry,
  GitHistoryResponse,
  GitSyncOperation,
  GitSyncOutcome,
  GitSyncPreview,
  GitSyncExecuteResponse,
  // Issue #1387 — controlled test/build/run command executor wire types.
  CommandTaskKind,
  CommandTaskSource,
  CommandTask,
  CommandTaskCatalog,
  CommandFailureReason,
  CommandTaskRunRequest,
  CommandTaskRunResult,
  CommandRunnerEventKind,
  CommandRunnerEvent,
  // Issue #1388 (ADR-0070) — container engine detection + governed execution wire types.
  ContainerEngineId,
  ContainerEngineState,
  ContainerEngineUnavailableReason,
  ContainerEngineStatus,
  ContainerCapabilityResponse,
  ContainerTaskKind,
  ContainerTask,
  ContainerTaskCatalog,
  ContainerRunRequest,
  ContainerFailureReason,
  ContainerRunResult,
  ContainerRunnerEventKind,
  ContainerRunnerEvent,
  VoiceProfile,
  VoiceProviderLocality,
  VoiceUnavailableReason,
  VoiceTransportPosture,
  VoiceCapabilityResolution,
  UpdatePreflightBlocker,
  UpdatePreflightBlockerCode,
  UpdatePreflightImpactEntry,
  UpdatePreflightImpactSummary,
  UpdatePreflightPatchNotes,
  UpdatePreflightRegistryStatus,
  UpdatePreflightReleaseMetadataStatus,
  UpdatePreflightReleaseSummary,
  UpdatePreflightReport,
  UpdatePreflightSeverity,
  UpdatePreflightStatus,
  UpdateCommandPreview,
  UpdateInstallMode,
  UpdateInstallModeStatus,
  UpdateInstallPackageManager,
  UpdateMutationPolicy,
  UpdatePolicySource,
  UpdateRestartVerificationRequest,
  UpdateSession,
  UpdateSessionFailureReason,
  UpdateSessionLogPreview,
  UpdateSessionPhase,
  UpdateSessionStartRequest,
  UpdateSessionStatus,
  UpdateUnsupportedReason,
  ReleaseImpactRemediation,
  ReleaseImpactStateImpact,
  UpdateReleaseImpactInput,
  UpdateStateStore,
  UpdateRemediationAction,
  UpdateRemediationActionKind,
  UpdateRemediationActionRequest,
  UpdateRemediationActionStatus,
  UpdateRemediationAffectedFeature,
  UpdateRemediationDecision,
  UpdateRemediationFeatureState,
  UpdateRemediationOverallStatus,
  UpdateRemediationScopeCounts,
  UpdateRemediationStatusReport,
  UpdateRemediationStatusRequest,
} from "@oscharko-dev/keiko-contracts";

export {
  DEFAULT_GROUNDING_LIMITS,
  UPDATE_PREFLIGHT_BLOCKER_CODES,
  UPDATE_PREFLIGHT_SCHEMA_VERSION,
  UPDATE_PREFLIGHT_SEVERITIES,
} from "@oscharko-dev/keiko-contracts";

// ─── Editor completion gateway wire shapes (Issue #1199, contracts root barrel) ─────
export type {
  EditorCompletionWireTriggerKind,
  EditorCompletionItemOrigin,
  EditorCompletionWireItem,
  EditorCompletionSource,
  EditorCompletionWireProvenance,
  EditorCompletionWireResponse,
  EditorCompletionContextSelectors,
  EditorCompletionWireRequest,
} from "@oscharko-dev/keiko-contracts";
export { EDITOR_COMPLETION_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts";

// ─── Editor inline-completion (ghost text) wire shapes (Issue #1200, contracts root barrel) ─────
export type {
  EditorInlineCompletionWireTriggerKind,
  EditorInlineCompletionWireItem,
  EditorInlineCompletionWireProvenance,
  EditorInlineCompletionWireResponse,
  EditorInlineCompletionWireRequest,
  EditorInlineCompletionTelemetryReport,
} from "@oscharko-dev/keiko-contracts";
export {
  EDITOR_INLINE_COMPLETION_SCHEMA_VERSION,
  EDITOR_INLINE_COMPLETION_TELEMETRY_SCHEMA_VERSION,
} from "@oscharko-dev/keiko-contracts";

// ─── Editor test-generation wire shapes (Issue #1202, contracts root barrel) ───────────────────
export type {
  EditorTestGenerationWireTarget,
  EditorTestGenerationWireRequest,
  EditorTestGenerationWireResponse,
  EditorTestGenerationStatus,
  EditorTestGenerationAssurance,
  EditorTestGenerationFunnel,
  EditorTestGenerationWirePatch,
  EditorTestGenerationWireFileChange,
  EditorTestGenerationWireProvenance,
} from "@oscharko-dev/keiko-contracts";
export { EDITOR_TEST_GENERATION_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts";

// ─── Editor patch-apply + post-apply verification wire shapes (Issue #1204, contracts root barrel) ──
export type {
  EditorPatchApplyDecision,
  EditorPatchApplyWireRequest,
  EditorPatchApplyWireResponse,
  EditorPatchApplyStatus,
  EditorPatchApplyChangeCounts,
  EditorPatchApplyRejection,
  EditorPatchRejectionReason,
  EditorPatchVerificationOutcome,
  EditorPatchVerificationSummary,
  EditorPatchRevertProposal,
} from "@oscharko-dev/keiko-contracts";
export { EDITOR_PATCH_APPLY_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts";

// ─── Deterministic language-service wire shapes (Issue #1198/#1201, contracts root barrel) ─────
// The `POST /api/editor/language` route serves diagnostics, hover, document symbols, and formatting
// for the governed languages; these are the result shapes the editor host maps into Monaco.
export type {
  LanguageServiceOperation,
  LanguageRange,
  LanguageDiagnosticSeverity,
  LanguageDiagnostic,
  LanguageDiagnosticsResult,
  LanguageHoverResult,
  LanguageSymbolKind,
  LanguageDocumentSymbol,
  LanguageSymbolResult,
  LanguageTextEdit,
  LanguageFormattingOptions,
  LanguageFormattingResult,
  LanguageProviderDescriptor,
  LanguageServiceCapabilities,
} from "@oscharko-dev/keiko-contracts";

// ─── Editor agent API wire shapes (Issue #1391) ────────────────────────────────
export type {
  EditorAgentAction,
  EditorAgentActionQueuedResponse,
  EditorAgentActionResult,
  EditorAgentActionResultRequest,
  EditorAgentConflictCode,
  EditorAgentEvent,
  EditorAgentPaneSnapshot,
  EditorAgentSessionSnapshot,
  EditorAgentSessionsResponse,
  EditorAgentSnapshotRequest,
  EditorAgentSnapshotResponse,
  EditorAgentSnapshotTextMode,
} from "@oscharko-dev/keiko-contracts";
export {
  EDITOR_AGENT_SCHEMA_VERSION,
  isContainedAgentPath,
  isEditorAgentEvent,
} from "@oscharko-dev/keiko-contracts";

// ─── Editor agent governance, policy, and audit (Issue #1395, ADR-0062) ─────────
export type {
  EditorAgentActionAuditRecord,
  EditorAgentActionDisposition,
  EditorAgentActionEffectClass,
  EditorAgentAuditResponse,
} from "@oscharko-dev/keiko-contracts";
export { isEditorAgentActionAuditRecord } from "@oscharko-dev/keiko-contracts";

// ─── Deterministic context-engineering layer (ADR-0052 / ADR-0057) ──────────────────
// The context-status panel (ContextStatusPanel.tsx) needs the lane-id literal union and the
// budget-pressure enum from the root barrel; `GroundedAnswerContextSummary` (the path-free
// aggregate carried on a grounded answer's pack summary) comes from the bff-wire subpath. All
// three are structurally path-free (string literal unions, numbers, booleans) by construction.
export type { ContextLaneId, ContextBudgetPressure } from "@oscharko-dev/keiko-contracts";
export { DEFAULT_TOKEN_ESTIMATOR_ID } from "@oscharko-dev/keiko-contracts";

// Issue #144 / Epic #142: pure conversation-eligibility helpers re-exported
// from keiko-contracts. UI cannot import from keiko-model-gateway (ADR-0019
// trust-3, error severity); contracts is the legitimate value-import source
// for browser-tier code.
export {
  isConversationEligibleModel,
  explainConversationIneligibility,
} from "@oscharko-dev/keiko-contracts";

// Issue #1557 / Epic #1556 (ADR-0094 D3/D5): pure, content-free voice-provider availability helpers
// re-exported from keiko-contracts so the model list can present a correctly configured voice
// provider as available (not as a chat-ineligibility warning) without importing keiko-model-gateway
// (ADR-0019 trust-3).
export {
  isConfiguredVoiceProvider,
  describeVoiceProviderAvailability,
} from "@oscharko-dev/keiko-contracts";
export type { VoiceProviderAvailability, VoicePersona } from "@oscharko-dev/keiko-contracts";

// ─── Workspace summary + context pack ──────────────────────────────────────────────
export type {
  SelectedScopeKind,
  WorkspaceLanguage,
  TestFramework,
  DiscoveryStats,
  SelectionReason,
  ContextEntrySummary,
  ContextPackSummary,
  WorkspaceSummary,
} from "@oscharko-dev/keiko-contracts";

// ─── Verification ──────────────────────────────────────────────────────────────────
export type { VerificationStatus, ResourceLimitDecision } from "@oscharko-dev/keiko-contracts";

export type {
  AuditResultEntry,
  VerificationAuditSummary,
} from "@oscharko-dev/keiko-contracts/verification-summary";

// ─── Evidence ledger (full manifest + sub-records) ─────────────────────────────────
export type {
  EvidenceRunIdentity,
  EvidencePatch,
  EvidenceReasoningEntry,
  EvidenceBrowserViewportPx,
  EvidenceBrowserEvent,
  EvidenceBrowserScreenshot,
  EvidenceBrowserContentCapture,
  EvidenceBrowserCapture,
  EvidenceManifest,
} from "@oscharko-dev/keiko-contracts/evidence";

// ─── BFF wire types (entities, responses, error envelope, RunReport, evidence list) ──
export type {
  Project,
  ProjectWithAvailability,
  Chat,
  ChatConnectedScope,
  ChatLocalKnowledgeScope,
  ChatRole,
  ChatStatus,
  ChatMessage,
  ChatMessageRole,
  ChatWorkflowStatus,
  CreateChatOptions,
  UpdateProjectPatch,
  UpdateChatPatch,
  NewChatMessage,
  UpdateChatMessagePatch,
  PatchChatMessageBody,
  PatchMessageResponse,
  GroundedAskRequest,
  GroundedEvidenceCitation,
  GroundedUncertainty,
  GroundedAnswer,
  LocalKnowledgeEvidenceCitation,
  GroundedAnswerContextPackSummary,
  GroundedAnswerContextSummary,
  GroundedAnswerRankingSummary,
  LocalKnowledgeGroundedAnswerContextSummary,
  HybridGroundedAnswerContextSummary,
  ProjectsResponse,
  ProjectResponse,
  ChatsResponse,
  ChatResponse,
  MessagesResponse,
  MessageResponse,
  DesktopChatBootstrapResponse,
  DesktopChatSendResponse,
  ConversationDocumentContextWire,
  ConversationMemoryActionWire,
  ConversationMemoryContextEntryWire,
  ConversationMemoryContextWire,
  ConversationMemoryRequestWire,
  ConversationMemoryResultWire,
  ConversationMemoryScopeContextWire,
  SafeProviderConfig,
  SafeCircuitBreakerConfig,
  SafeGatewayConfig,
  WorkflowInputType,
  WorkflowModelOptions,
  ExplainPlanInputSpec,
  VerifyInputSpec,
  WorkflowsResponse,
  AgentWorkflowId,
  UnitTestTargetKind,
  AgentVerifyInput,
  AgentExplainPlanInput,
  AgentUnitTestInput,
  AgentBugInvestigationInput,
  BffErrorCode,
  BffError,
  RunStatus,
  ChangedFile,
  RunReport,
  EvidenceOutcome,
  EvidenceListEntry,
  TerminalPolicySummary,
  TerminalDirectoryRoot,
  TerminalDirectoryEntry,
  TerminalDirectoryListing,
  TerminalExecutionInput,
  TerminalExecutionResult,
  TerminalEventKind,
  TerminalEventEnvelope,
  FilesDirectoryRoot,
  FilesDirectoryEntry,
  FilesDirectoryListing,
  FilesEntryKind,
  FilesTreeEntry,
  FilesTreeResponse,
  FilesSearchResult,
  FilesSearchResponse,
  FilesPreviewBase,
  FilesPreviewResponse,
  FilesContentResponse,
  FilesWriteRequest,
  FilesCreateRequest,
  FilesRenameRequest,
  FilesDeleteRequest,
  FilesCopyRequest,
  FilesMutationResponse,
  EditorDocumentSession,
  EditorDocumentVersion,
  EditorSessionErrorCode,
  BrowserViewportPx,
  CdpReachability,
  BrowserSessionMeta,
  BrowserNavigateResult,
  BrowserScreenshotResult,
  BrowserContentResult,
  BrowserEventKind,
  BrowserEventEnvelope,
  GatewayReadinessOptions,
  GatewayReadinessOverallStatus,
  GatewayReadinessProbeName,
  GatewayReadinessProbeResult,
  GatewayReadinessProbeStatus,
  GatewayReadinessReport,
  GatewayReadinessRequest,
  GatewayReadinessVerifiedCapabilities,
} from "@oscharko-dev/keiko-contracts/bff-wire";

// ─── Prompt Enhancer wire types (Epic #1307 / Issue #1314) ──────────────────────────
export type {
  PromptEnhancementWireRequest,
  PromptEnhancementWireResponse,
  PromptEnhancementModelRouting,
  PromptEnhancementModelAvailability,
  PromptEnhancementModelRoutingReason,
  PromptEnhancementCandidateComparison,
  PromptEnhancementGroundingReadiness,
  PromptEnhancementGroundingReadinessStatus,
  PromptEnhancementGroundingReadinessReason,
  PromptEnhancementEvidenceReference,
} from "@oscharko-dev/keiko-contracts/bff-wire";

export type { ExpectedCheck, WorkflowKind } from "@oscharko-dev/keiko-contracts/workflow-handoff";

// ─── SSE stream aggregation (UI-internal — see ./sse-types for rationale) ──────────
export type { HarnessEvent, HarnessEventType, TerminalEventType, SseStatus } from "./sse-types";
export { ALL_SSE_EVENT_TYPES, TERMINAL_EVENT_TYPES } from "./sse-types";
