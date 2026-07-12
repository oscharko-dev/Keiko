// Public surface of @oscharko-dev/keiko-contracts. Issue #158 carries the first real type surface
// out of `src/<layer>/types.ts` into this leaf package. Re-exports use the explicit `export type`
// form for type-only names and `export` for value-emitting frozen const tables because
// verbatimModuleSyntax is on in tsconfig.base.json.
//
// The workflow event families (unit-test, bug-investigation) reuse the harness event-type NAMES
// (ModelCallStartedEvent, ModelCallCompletedEvent, PatchAppliedEvent, VerificationResultEvent) by
// structural convention. We surface only the workflow event UNION types here; the harness member
// names own the bare identifiers. Callers narrow on the union to reach the member shapes — the
// same pattern src/index.ts already uses.
//
// Issue #178 adds the connected repository context surface (Epic #177): pure type contracts plus
// pure validation helpers for the upcoming Files window → Conversation Center handoff.
//
// Issue #191 adds the Local Knowledge Connector surface (Epic #189): KnowledgeSource /
// KnowledgeCapsule / CapsuleSet primitives, document and vector lineage records, connector
// graph state, and pure validation helpers. No implementation — types only. Implementation
// lands in subsequent epic children.

export const KEIKO_CONTRACTS_VERSION = "0.2.15" as const;

// Single-source product version. Surfaced as `keiko --version`, in the BFF healthcheck
// response, and as the SDK's exported `SDK_VERSION` constant. Kept here on the leaf
// package so every consumer reaches it through one stable import path. Bump in lockstep
// with the root package.json "version" field as part of every release.
export const KEIKO_PRODUCT_VERSION = "0.2.15" as const;

// ─── Shared numeric primitive (GEN-DUP-SEMANTIC-003) ────────────────────────────
export { clampUnit } from "./numeric.js";

// ─── Shared stable ordering helpers ─────────────────────────────────────────────
export { sortedStrings } from "./stable-order.js";

// ─── Shared coded-HTTP-error mechanism (GEN-DUP-NEAR-008) ───────────────────────
export { CodedHttpError, httpStatusFor } from "./http-error.js";

// ─── Harness ───────────────────────────────────────────────────────────────────
export type {
  HarnessStateName,
  TerminalState,
  StateTransition,
  HarnessLimits,
  TaskType,
  GenerateUnitTestsInput,
  InvestigateBugInput,
  ExplainPlanInput,
  VerifyInput,
  TaskInput,
  RunCounters,
  RunOutcome,
  RunResult,
  RunManifest,
  HarnessCode,
  HarnessFailure,
  RunStartedEvent,
  StateTransitionEvent,
  ModelCallStartedEvent,
  ModelCallCompletedEvent,
  ModelCallFailedEvent,
  ToolCallStartedEvent,
  ToolCallCompletedEvent,
  ToolCallFailedEvent,
  CommandExecutedEvent,
  SandboxConfiguredEvent,
  PatchAppliedEvent,
  ReasoningTraceEvent,
  PatchProposedEvent,
  VerificationResultEvent,
  RunCompletedEvent,
  RunCancelledEvent,
  RunFailedEvent,
  BrowserSessionCloseReason,
  BrowserSessionOpenedEvent,
  BrowserNavigatedEvent,
  BrowserScreenshotCapturedEvent,
  BrowserPageContentCapturedEvent,
  BrowserSessionClosedEvent,
  BrowserTrustWarningEvent,
  BrowserErrorEvent,
  BrowserEvent,
  HarnessEvent,
} from "./harness.js";
export { TERMINAL_STATES, DEFAULT_LIMITS, HARNESS_CODES, HARNESS_VERSION } from "./harness.js";

// ─── Workflow descriptor ────────────────────────────────────────────────────────
export type { WorkflowDescriptor, WorkflowInputSpec } from "./workflow-descriptor.js";

// ─── Governed release impact (Issue #1690) ─────────────────────────────────────
export type {
  ReleaseImpactBreakingException,
  ReleaseImpactCatalog,
  ReleaseImpactCategory,
  ReleaseImpactEntry,
  ReleaseImpactPriority,
  ReleaseImpactPublishGate,
  ReleaseImpactRemediation,
  ReleaseImpactReview,
  ReleaseImpactStateImpact,
  ReleaseImpactUserVisibleChange,
} from "./release-impact.js";
export {
  RELEASE_IMPACT_CATEGORIES,
  RELEASE_IMPACT_PRIORITIES,
  RELEASE_IMPACT_PUBLISH_GATES,
  RELEASE_IMPACT_REMEDIATIONS,
  RELEASE_IMPACT_SCHEMA_VERSION,
} from "./release-impact.js";

// ─── Update availability / preflight (Issue #1692) ─────────────────────────────
export type {
  UpdatePreflightBlocker,
  UpdatePreflightBlockerCode,
  UpdatePreflightImpactEntry,
  UpdatePreflightImpactSummary,
  UpdatePreflightInstallabilitySource,
  UpdatePreflightPatchNoteSection,
  UpdatePreflightPatchNotes,
  UpdatePreflightPortableAssetStatus,
  UpdatePreflightPortableAssetSummary,
  UpdatePreflightPortableInstallability,
  UpdatePreflightRegistryStatus,
  UpdatePreflightReleaseMetadataStatus,
  UpdatePreflightReleaseSource,
  UpdatePreflightReleaseSummary,
  UpdatePreflightReport,
  UpdatePreflightSeverity,
  UpdatePreflightStatus,
} from "./update-preflight.js";
export {
  UPDATE_PREFLIGHT_BLOCKER_CODES,
  UPDATE_PREFLIGHT_INSTALLABILITY_SOURCES,
  UPDATE_PREFLIGHT_PORTABLE_ASSET_STATUSES,
  UPDATE_PREFLIGHT_REGISTRY_STATUSES,
  UPDATE_PREFLIGHT_RELEASE_METADATA_STATUSES,
  UPDATE_PREFLIGHT_RELEASE_SOURCES,
  UPDATE_PREFLIGHT_SCHEMA_VERSION,
  UPDATE_PREFLIGHT_SEVERITIES,
  UPDATE_PREFLIGHT_STATUSES,
} from "./update-preflight.js";

// ─── Governed update session runner (Issue #1693) ─────────────────────────────
export type {
  UpdateCommandPreview,
  UpdateInstallMode,
  UpdateInstallModeKind,
  UpdateInstallModeStatus,
  UpdateInstallPackageManager,
  UpdateMutationPolicy,
  UpdatePortableActivationStatus,
  UpdatePortableActivationSummary,
  UpdatePortableAssetSummary,
  UpdatePortableAssetVerificationStatus,
  UpdatePortableInstallStatus,
  UpdatePortableInstallSummary,
  UpdatePortableManagedRootKind,
  UpdatePortableSidecarFailureCode,
  UpdatePortableSidecarSummary,
  UpdatePortableSidecarVerificationStatus,
  UpdatePortableStagingStatus,
  UpdatePortableStagingSummary,
  UpdatePortableTarget,
  UpdatePolicySource,
  UpdateRecommendedAction,
  UpdateRestartCommandPreview,
  UpdateRestartVerificationRequest,
  UpdateRestartVerificationRequestParse,
  UpdateRestartVerificationRequestParseFail,
  UpdateRestartVerificationRequestParseOk,
  UpdateSession,
  UpdateSessionFailureReason,
  UpdateSessionLogPreview,
  UpdateSessionPhase,
  UpdateSessionStartRequest,
  UpdateSessionStartRequestParse,
  UpdateSessionStartRequestParseFail,
  UpdateSessionStartRequestParseOk,
  UpdateSessionStatus,
  UpdateUnsupportedReason,
} from "./update-session.js";
export {
  UPDATE_INSTALL_MODE_KINDS,
  parseUpdateRestartVerificationRequest,
  parseUpdateSessionStartRequest,
  UPDATE_INSTALL_MODE_STATUSES,
  UPDATE_INSTALL_PACKAGE_MANAGERS,
  UPDATE_PORTABLE_ACTIVATION_STATUSES,
  UPDATE_PORTABLE_ASSET_VERIFICATION_STATUSES,
  UPDATE_PORTABLE_INSTALL_STATUSES,
  UPDATE_PORTABLE_SIDECAR_FAILURE_CODES,
  UPDATE_PORTABLE_SIDECAR_VERIFICATION_STATUSES,
  UPDATE_PORTABLE_STAGING_STATUSES,
  UPDATE_PORTABLE_TARGET_ASSET_NAMES,
  UPDATE_PORTABLE_TARGETS,
  UPDATE_RECOMMENDED_ACTIONS,
  UPDATE_SESSION_FAILURE_REASONS,
  UPDATE_SESSION_PHASES,
  UPDATE_SESSION_SCHEMA_VERSION,
  UPDATE_UNSUPPORTED_REASONS,
} from "./update-session.js";

// ─── Governed update local state and recovery (Issue #1694) ─────────────────────
export type {
  UpdateCompatibilityScan,
  UpdateHealthState,
  UpdateRecoverySnapshot,
  UpdateRecoverySnapshotEntry,
  UpdateReleaseImpactInput,
  UpdateRemediationActionState,
  UpdateRemediationStatus,
  UpdateRuntimeAuditEvent,
  UpdateRuntimeEventType,
  UpdateRuntimeWarningCode,
  UpdateRuntimeState,
  UpdateStateStore,
  UpdateStoreHealth,
} from "./update-local-state.js";
export {
  UPDATE_HEALTH_LABELS,
  UPDATE_HEALTH_STATES,
  UPDATE_LOCAL_STATE_SCHEMA_VERSION,
  UPDATE_REMEDIATION_STATUSES,
  UPDATE_RUNTIME_EVENT_TYPES,
  UPDATE_RUNTIME_WARNING_CODES,
  UPDATE_STATE_STORES,
} from "./update-local-state.js";

// ─── Governed update remediation actions (Issue #1695) ────────────────────────
export type {
  UpdateRemediationAction,
  UpdateRemediationActionKind,
  UpdateRemediationActionRequest,
  UpdateRemediationActionRequestParse,
  UpdateRemediationActionRequestParseFail,
  UpdateRemediationActionRequestParseOk,
  UpdateRemediationActionStatus,
  UpdateRemediationAffectedFeature,
  UpdateRemediationDecision,
  UpdateRemediationFeatureState,
  UpdateRemediationOverallStatus,
  UpdateRemediationScopeCounts,
  UpdateRemediationStatusReport,
  UpdateRemediationStatusRequest,
  UpdateRemediationStatusRequestParse,
  UpdateRemediationStatusRequestParseFail,
  UpdateRemediationStatusRequestParseOk,
} from "./update-remediation.js";
export {
  isUpdateRemediationStatus,
  isUpdateStateStore,
  parseUpdateRemediationActionRequest,
  parseUpdateRemediationStatusRequest,
  UPDATE_REMEDIATION_ACTION_KINDS,
  UPDATE_REMEDIATION_ACTION_STATUSES,
  UPDATE_REMEDIATION_DECISIONS,
  UPDATE_REMEDIATION_FEATURE_STATES,
  UPDATE_REMEDIATION_OVERALL_STATUSES,
  UPDATE_REMEDIATION_SCHEMA_VERSION,
} from "./update-remediation.js";

// ─── Workspace ──────────────────────────────────────────────────────────────────
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
} from "./workspace.js";
export {
  DEFAULT_DISCOVERY_OPTIONS,
  DEFAULT_READ_OPTIONS,
  SELECTION_REASON_PRIORITY,
  DEFAULT_CONTEXT_REQUEST,
  WORKSPACE_LANGUAGES,
} from "./workspace.js";

// ─── Editor session (Issue #1197) ─────────────────────────────────────────────────
// Content-free editor-session/file-state correlation metadata + stable error codes. Owned by
// #1197, disjoint from the language-service namespace (#1198).
export type {
  EditorDocumentVersion,
  EditorSessionAiProvenance,
  EditorDocumentSession,
  EditorSessionErrorCode,
  EditorSessionValidation,
  EditorSessionValidationOk,
  EditorSessionValidationFail,
} from "./editor-session.js";
export {
  EDITOR_SESSION_SCHEMA_VERSION,
  EDITOR_SESSION_ERROR_CODES,
  isEditorDocumentVersion,
  parseEditorDocumentVersion,
} from "./editor-session.js";

// ─── Editor layout / dirty-close / hot-exit contracts (Issues #1375 + #1376) ────
export type {
  CreateEditorLayoutStateV2Input,
  EditorLayoutAction,
  EditorLayoutNode,
  EditorLayoutPaneNode,
  EditorLayoutSplitNode,
  EditorLayoutStateV2,
  EditorPaneStateV2,
  EditorSplitDirection,
  EditorSplitDropZone,
  EditorTabDragIntent,
} from "./editor-layout.js";
export {
  EDITOR_LAYOUT_SCHEMA_VERSION,
  activeEditorPane,
  createEditorLayoutStateV2,
  editorLayoutOpenFiles,
  editorLayoutPaneIds,
  editorLayoutPanes,
  editorLayoutReducer,
  serializeEditorLayoutStateV2,
} from "./editor-layout.js";
export type {
  EditorDirtyCloseDecision,
  EditorDirtyCloseIntent,
  EditorDirtyCloseReason,
  EditorDirtyCloseResolution,
} from "./editor-dirty-close.js";
export { createEditorDirtyCloseIntent } from "./editor-dirty-close.js";
// ─── Root-relative project-tree file-identifier contract (Issue #1374) ──────────
// Single tested place that turns a possibly-absolute candidate into the root-relative file
// identifier the Files/editor BFF requires, so the editor never triggers the absolute-path load
// failure. Reuses isContainedAgentPath; introduces no new workspace/project-tree subsystem.
export type {
  RootRelativeFileIdentifier,
  WorkspaceFileIdentifierResolution,
  WorkspaceFileTarget,
} from "./editor-workspace-path.js";
export {
  isRootRelativeFileIdentifier,
  resolveWorkspaceFileIdentifier,
  selectWorkspaceFileTarget,
} from "./editor-workspace-path.js";
export type { EditorHotExitIndexRecordV2, EditorHotExitSnapshotV1 } from "./editor-hot-exit.js";
export {
  EDITOR_HOT_EXIT_INDEX_SCHEMA_VERSION,
  EDITOR_HOT_EXIT_SCHEMA_VERSION,
  EDITOR_HOT_EXIT_TTL_MS,
  editorHotExitSnapshotExpired,
  isEditorHotExitIndexRecordV2,
  isEditorHotExitSnapshotV1,
} from "./editor-hot-exit.js";

// ─── Editor agent API (Issues #1391, #1392) ─────────────────────────────────────
export type {
  EditorAgentAction,
  EditorAgentActionFailure,
  EditorAgentActionOrigin,
  EditorAgentActionQueuedResponse,
  EditorAgentActionResult,
  EditorAgentActionResultRequest,
  EditorAgentActionStatus,
  EditorAgentActionType,
  EditorAgentNavigateSymbolOperation,
  EditorAgentNavigateSymbolRequest,
  EditorAgentSearchWorkspaceMode,
  EditorAgentSearchWorkspaceRequest,
  EditorAgentGitAspect,
  EditorAgentQueryGitAspects,
  EditorAgentQueryGitBlame,
  EditorAgentQueryGitCaps,
  EditorAgentQueryGitData,
  EditorAgentQueryGitDiff,
  EditorAgentQueryGitDiffFile,
  EditorAgentQueryGitDiffLayer,
  EditorAgentQueryGitMachineReason,
  EditorAgentQueryGitOmission,
  EditorAgentQueryGitOmissionReason,
  EditorAgentQueryGitRequest,
  EditorAgentQueryGitStatus,
  EditorAgentQueryGitStatusChange,
  EditorAgentQueryGitTarget,
  EditorAgentActionsPostBody,
  EditorAgentBridgeActionRequest,
  EditorAgentBridgeDecisionCapability,
  EditorAgentBridgeSnapshotRequest,
  EditorAgentChangeset,
  EditorAgentChangesetFile,
  EditorAgentConflictCode,
  EditorAgentConflictDetail,
  EditorAgentDiagnostic,
  EditorAgentDiagnosticsDetail,
  EditorAgentEvent,
  EditorAgentFailureCode,
  EditorAgentFileActionResult,
  EditorAgentFileActionStatus,
  EditorAgentGovernedAuthorityReference,
  EditorAgentOneUseApprovalReference,
  EditorAgentPaneSnapshot,
  EditorAgentParse,
  EditorAgentParseFail,
  EditorAgentParseOk,
  EditorAgentPreparedChangeKind,
  EditorAgentPreparedChangeset,
  EditorAgentPreparedChangesetFile,
  EditorAgentPreparedTextEdit,
  EditorAgentSessionSnapshot,
  EditorAgentSessionsResponse,
  EditorAgentSnapshotRequest,
  EditorAgentSnapshotResponse,
  EditorAgentSnapshotTextMode,
  EditorAgentVerificationRequest,
} from "./editor-agent.js";
export {
  DEFAULT_EDITOR_AGENT_ACTION_ORIGIN,
  DEFAULT_EDITOR_AGENT_SNAPSHOT_TEXT_MODE,
  EDITOR_AGENT_ACTION_ID_MAX_BYTES,
  EDITOR_AGENT_ACTION_DATA_MAX_BYTES,
  EDITOR_AGENT_NAVIGATION_DOCUMENT_MAX_BYTES,
  EDITOR_AGENT_NAVIGATE_SYMBOL_OPERATIONS,
  EDITOR_AGENT_SEARCH_MAX_QUERY_CHARS,
  EDITOR_AGENT_SEARCH_MAX_RESULTS,
  EDITOR_AGENT_ACTIVE_BUFFER_ACTION_TYPES,
  EDITOR_AGENT_ACTION_ORIGINS,
  EDITOR_AGENT_BRIDGE_DECISION_CAPABILITY_BYTES,
  EDITOR_AGENT_BRIDGE_DECISION_CAPABILITY_ENCODED_CHARS,
  EDITOR_AGENT_CHANGESET_MAX_FILES,
  EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES,
  EDITOR_AGENT_CONFLICT_CODES,
  EDITOR_AGENT_DIAGNOSTIC_MESSAGE_MAX_CHARS,
  EDITOR_AGENT_DIAGNOSTICS_MAX_ITEMS,
  EDITOR_AGENT_EVENT_ID_MAX_BYTES,
  EDITOR_AGENT_FAILURE_CODES,
  EDITOR_AGENT_IDEMPOTENCY_KEY_MAX_BYTES,
  EDITOR_AGENT_PANE_ID_MAX_BYTES,
  EDITOR_AGENT_PREPARED_CHANGESET_MAX_EDITS,
  EDITOR_AGENT_REFERENCE_ID_MAX_CHARS,
  EDITOR_AGENT_RESULT_MESSAGE_MAX_CHARS,
  EDITOR_AGENT_QUERY_GIT_BRANCH_MAX_CHARS,
  EDITOR_AGENT_QUERY_GIT_MACHINE_REASONS,
  EDITOR_AGENT_QUERY_GIT_OMISSION_REASONS,
  EDITOR_AGENT_QUERY_GIT_SCHEMA_VERSION,
  EDITOR_AGENT_QUERY_GIT_TARGET_BASENAME_MAX_CHARS,
  EDITOR_AGENT_SCHEMA_VERSION,
  EDITOR_AGENT_SESSION_ID_MAX_BYTES,
  EDITOR_AGENT_SNAPSHOT_MAX_DIRTY_FILES,
  EDITOR_AGENT_SNAPSHOT_MAX_OPEN_FILES_PER_PANE,
  EDITOR_AGENT_SNAPSHOT_MAX_PANES,
  EDITOR_AGENT_SNAPSHOT_PATH_METADATA_MAX_BYTES,
  EDITOR_AGENT_SNAPSHOT_TEXT_MAX_BYTES,
  EDITOR_AGENT_TARGET_PATH_MAX_BYTES,
  EDITOR_AGENT_WINDOW_ID_MAX_BYTES,
  EDITOR_AGENT_WORKSPACE_ROOT_MAX_BYTES,
  EDITOR_AGENT_WRITE_ACTION_TYPES,
  editorAgentActionHasWritePrecondition,
  editorAgentWritePreconditionError,
  isContainedAgentPath,
  isEditorAgentAction,
  isEditorAgentActiveBufferActionType,
  isEditorAgentActionOrigin,
  isEditorAgentActionResult,
  isEditorAgentBridgeDecisionCapability,
  isEditorAgentChangeset,
  isEditorAgentChangesetFile,
  isEditorAgentConflictCode,
  isEditorAgentConflictDetail,
  isEditorAgentDiagnostic,
  isEditorAgentDiagnosticsDetail,
  isEditorAgentEvent,
  isEditorAgentFailureCode,
  isEditorAgentFileActionResult,
  isEditorAgentGovernedAuthorityReference,
  isEditorAgentOneUseApprovalReference,
  isEditorAgentPreparedChangeset,
  isEditorAgentSessionSnapshot,
  isEditorAgentVerificationRequest,
  isEditorAgentWriteActionType,
  parseEditorAgentActionsPostBody,
  parseEditorAgentQueryGitData,
  parseEditorAgentSnapshotRequest,
  resolveEditorAgentActionOrigin,
  validateAgentTextEdits,
} from "./editor-agent.js";

// ─── Editor agent governance, policy, and audit (Issue #1395, ADR-0062) ─────────
export type {
  EditorAgentActionAuditInput,
  EditorAgentActionAuditRecord,
  EditorAgentActionDenyReason,
  EditorAgentActionDisposition,
  EditorAgentActionEffectClass,
  EditorAgentActionPolicyContext,
  EditorAgentActionPolicyDecision,
  EditorAgentActionReviewReason,
  EditorAgentAuthorityPolicy,
  EditorAgentAuditResponse,
} from "./editor-agent-governance.js";
export {
  EDITOR_AGENT_ACTION_DENY_REASONS,
  EDITOR_AGENT_ACTION_DISPOSITIONS,
  EDITOR_AGENT_ACTION_EFFECT_CLASS,
  EDITOR_AGENT_ACTION_APPROVAL_RISK,
  EDITOR_AGENT_ACTION_REVIEW_REASONS,
  EDITOR_AGENT_AUDIT_SCHEMA_VERSION,
  EDITOR_AGENT_AUDIT_SUMMARY_MAX_CHARS,
  EDITOR_AGENT_DISPOSITION_BY_POLICY_EFFECT,
  EDITOR_AGENT_WORKBENCH_ACTION_CLASS,
  EDITOR_AGENT_WORKBENCH_RESOURCE_SCOPE,
  buildEditorAgentActionAuditRecord,
  classifyEditorAgentAction,
  composeEditorAgentActionPolicyDecision,
  editorAgentDispositionForPolicyEffect,
  isEditorAgentActionAuditRecord,
  isEditorAgentActionDisposition,
  isEditorAgentActionEffectClass,
  isMutatingEditorAgentAction,
} from "./editor-agent-governance.js";

// ─── Language service (Issue #1198) ───────────────────────────────────────────────
// Provider-pluggable, language-agnostic deterministic language-intelligence contracts
// (completion, diagnostics, hover, document symbols). Owned by #1198, disjoint from the
// editor-session namespace (#1197). The TS/JS provider is first; the LSP expansion is staged (#1213).
export type {
  LanguageServiceOperation,
  LanguageServiceErrorCode,
  LanguagePosition,
  LanguageRange,
  LanguageDocumentOverlay,
  LanguageDiagnosticSeverity,
  LanguageDiagnostic,
  LanguageDiagnosticsResult,
  LanguageCompletionItemKind,
  LanguageCompletionItem,
  LanguageCompletionResult,
  LanguageHoverResult,
  LanguageSymbolKind,
  LanguageDocumentSymbol,
  LanguageSymbolResult,
  LanguageTextEdit,
  LanguageFormattingOptions,
  LanguageFormattingResult,
  LanguageLocation,
  LanguageDefinitionResult,
  LanguageTypeDefinitionResult,
  LanguageImplementationResult,
  LanguageCallHierarchyItem,
  LanguageCallHierarchyIncomingCall,
  LanguageCallHierarchyOutgoingCall,
  LanguageCallHierarchyRoot,
  LanguageCallHierarchyResult,
  LanguageInlayHintKind,
  LanguageInlayHint,
  LanguageInlayHintsResult,
  LanguageReferencesResult,
  LanguageRenamePrepareResult,
  LanguageRenameChangesetFile,
  LanguageRenameChangeset,
  LanguageRenameApplyResult,
  LanguageCodeActionKind,
  LanguageCodeAction,
  LanguageCodeActionsResult,
  LanguageSignatureParameterInformation,
  LanguageSignatureInformation,
  LanguageSignatureHelpResult,
  LanguageProviderAvailability,
  LanguageProviderDescriptor,
  LanguageServiceCapabilities,
  LanguageServiceLimits,
  LanguageDiagnosticsRequest,
  LanguageCompletionRequest,
  LanguageHoverRequest,
  LanguageSymbolsRequest,
  LanguageFormattingRequest,
  LanguageDefinitionRequest,
  LanguageTypeDefinitionRequest,
  LanguageImplementationRequest,
  LanguageCallHierarchyRequest,
  LanguageInlayHintsRequest,
  LanguageReferencesRequest,
  LanguageRenamePrepareRequest,
  LanguageRenameApplyRequest,
  LanguageCodeActionsRequest,
  LanguageSignatureHelpRequest,
  LanguageServiceRequest,
  LanguageServiceParseOk,
  LanguageServiceParseFail,
  LanguageServiceParse,
} from "./language-service.js";
export {
  LANGUAGE_SERVICE_SCHEMA_VERSION,
  LANGUAGE_SERVICE_OPERATIONS,
  LANGUAGE_SERVICE_ERROR_CODES,
  LANGUAGE_RENAME_CHANGESET_SCHEMA_VERSION,
  MAX_LANGUAGE_FORMATTING_TAB_SIZE,
  DEFAULT_LANGUAGE_SERVICE_LIMITS,
  isLanguagePosition,
  isLanguageRange,
  isLanguageDiagnostic,
  isLanguageDocumentOverlay,
  isLanguageFormattingOptions,
  parseLanguageServiceRequest,
} from "./language-service.js";

// ─── Editor language mode map (Issue #1379, Epic #1491, ADR-0067) ──────────────────
// The single canonical, frozen const table of the known source-language universe shared by the
// browser editor tier and the server language service. `plaintext` is intentionally excluded (it is
// the editor's render fallback, not a registry language). Strict leaf: pure const tables + pure
// functions, no other keiko-* imports, no clock/crypto/randomness.
export type { EditorLanguageMode } from "./editor-language-mode-map.js";
export {
  EDITOR_LANGUAGE_MODE_MAP,
  EDITOR_LANGUAGE_MODE_IDS,
  EDITOR_LANGUAGE_MODE_BY_EXTENSION,
  inferEditorLanguageModeId,
  isEditorLanguageModeId,
} from "./editor-language-mode-map.js";

// ─── Editor built-in capability registry (Issue #1380, Epic #1491, ADR-0068) ──────────────────
// The single canonical, frozen const table of per-language BROWSER built-in editor capabilities:
// syntax highlighting, bracket matching, and how "Format Document" is served (Monaco's bundled
// worker, the Keiko language-service bridge, or none). Sits beside the source-language mode map, not
// inside it (ADR-0068 D2): browser formatting reachability is an editor-tier concern, not server
// capability. Strict leaf: pure const tables + pure functions, no other keiko-* imports, no
// clock/crypto/randomness. Coherence with the mode map is test-pinned (ADR-0068 D6).
export type {
  EditorBuiltinCapability,
  EditorBuiltinFormattingSource,
} from "./editor-builtin-capabilities.js";
export {
  EDITOR_BUILTIN_CAPABILITIES,
  EDITOR_BUILTIN_CAPABILITY_BY_LANGUAGE,
  editorBuiltinCapability,
  editorBuiltinDocumentFormatting,
  isBuiltinFormattingAvailable,
} from "./editor-builtin-capabilities.js";

// ─── Governed LSP process manager (Issue #1381, Epic #1491, ADR-0069) ─────────────────────────
// The status, configuration, error-code, and content-free lifecycle-event vocabulary the long-lived
// supervised language-server process layer shares across package boundaries: the keiko-server
// process manager, its status route, and the language-provider registry. `lspStatusToProviderDescriptor`
// maps a live `LspProcessStatus` onto the existing `LanguageProviderDescriptor` so managed providers
// flow through `describeLanguageCapabilities()` without a UI change (ADR-0069 D5). Content-free by
// construction (ADR-0069 D6): `LspLifecycleEvent` carries only enums, ids, counts, and timestamps.
// Strict leaf: pure types + frozen const tables + throw-free pure functions, no other keiko-*
// imports, no clock/crypto/randomness.
export type {
  LspProcessErrorCode,
  LspProcessStatus,
  LspFrameRejectReason,
  LspNetworkPolicy,
  LspProcessConfig,
  LspLifecycleEvent,
  LspLatencyHistogram,
  ManagedLspProcessHealthSnapshot,
} from "./lsp-process.js";
export {
  LSP_PROCESS_SCHEMA_VERSION,
  LSP_PROCESS_ERROR_CODES,
  LSP_PROCESS_STATUSES,
  DEFAULT_LSP_PROCESS_CONFIG,
  isTerminalLspStatus,
  lspStatusToProviderDescriptor,
  parseLspFrameHeader,
} from "./lsp-process.js";

// ─── Local runtime capabilities (Issue #1385, Epic #1491) ─────────────────────────
// Wire contract for the BFF-owned runtime inventory: Git, host Node/package managers, common
// language toolchains, command-source metadata, and container-engine presence. The contract is
// metadata-only and content-free; the detector implementation lives in keiko-server so the browser
// never gains process, Git, Docker socket, or filesystem authority.
export type {
  RuntimeCapabilityKind,
  RuntimeCapabilityState,
  RuntimeCapabilityUnavailableReason,
  RuntimeCommandKind,
  RuntimeCommandSourceType,
  RuntimeCommandSource,
  RuntimeCapability,
  RuntimeCapabilitiesResponse,
  RuntimeCapabilitiesParseOk,
  RuntimeCapabilitiesParseFail,
  RuntimeCapabilitiesParse,
} from "./runtime-capabilities.js";
export {
  RUNTIME_CAPABILITY_SCHEMA_VERSION,
  RUNTIME_CAPABILITY_KINDS,
  RUNTIME_CAPABILITY_STATES,
  RUNTIME_CAPABILITY_UNAVAILABLE_REASONS,
  RUNTIME_COMMAND_KINDS,
  validateRuntimeCapabilitiesResponse,
} from "./runtime-capabilities.js";

// ─── Coding workbench contracts (Issue #1986, Epic #1982, ADR-0124) ─────────────────
// Shared leaf vocabulary for coding autonomy modes, authority envelopes, runtime events,
// permission requests, deployment ceilings, model-source routing, and content-free evidence.
// This module is browser-safe and dependency-free apart from leaf-local text-redaction helpers.
export type {
  CodingWorkbenchActionPolicyDecision,
  CodingWorkbenchActionClass,
  CodingWorkbenchApprovalRisk,
  CodingWorkbenchAuthorityEnvelope,
  CodingWorkbenchBudget,
  CodingWorkbenchBranchConstraints,
  CodingWorkbenchCommandPolicy,
  CodingWorkbenchCommandPolicyMode,
  CodingWorkbenchConnectorScope,
  CodingWorkbenchGate,
  CodingWorkbenchMode,
  CodingWorkbenchModePolicy,
  CodingWorkbenchModelProfile,
  CodingWorkbenchModelSource,
  CodingWorkbenchNetworkMode,
  CodingWorkbenchNetworkPolicy,
  CodingWorkbenchObservationChannel,
  CodingWorkbenchPermissionRequest,
  CodingWorkbenchPermissionRequestKind,
  CodingWorkbenchPolicyEffect,
  CodingWorkbenchPolicyDenialReason,
  CodingWorkbenchPolicyResourceScope,
  CodingWorkbenchModeDisplay,
  CodingWorkbenchModeEffectMatrix,
  CodingWorkbenchRuntimeEvent,
  CodingWorkbenchRuntimeEventKind,
  CodingWorkbenchRuntimeHealth,
  CodingWorkbenchRuntimeSource,
  CodingWorkbenchSidecarGatewayProjection,
  CodingWorkbenchSidecarGatewayResult,
  CodingWorkbenchSidecarGatewayRunMetadata,
  CodingWorkbenchSidecarGatewayStatus,
  CodingWorkbenchSidecarGatewayUnavailable,
  CodingWorkbenchSidecarGatewayUnavailableReason,
  CodingWorkbenchSupervisedActionKind,
  CodingWorkbenchSupervisedPolicyReason,
  CodingWorkbenchValidationFail,
  CodingWorkbenchValidationOk,
  CodingWorkbenchValidationResult,
  CodingWorkbenchWorkspaceIdentity,
} from "./coding-workbench.js";
export {
  CODING_WORKBENCH_ACTION_CLASSES,
  CODING_WORKBENCH_APPROVAL_RISKS,
  CODING_WORKBENCH_COMMAND_POLICY_MODES,
  CODING_WORKBENCH_CONNECTOR_SCOPES,
  CODING_WORKBENCH_GATES,
  CODING_WORKBENCH_MODEL_SOURCES,
  CODING_WORKBENCH_MODES,
  CODING_WORKBENCH_MODE_POLICIES,
  CODING_WORKBENCH_NETWORK_MODES,
  CODING_WORKBENCH_OBSERVATION_CHANNELS,
  CODING_WORKBENCH_PERMISSION_REQUEST_KINDS,
  CODING_WORKBENCH_POLICY_DENIAL_REASONS,
  CODING_WORKBENCH_POLICY_EFFECTS,
  CODING_WORKBENCH_POLICY_RESOURCE_SCOPES,
  CODING_WORKBENCH_RUNTIME_EVENT_KINDS,
  CODING_WORKBENCH_RUNTIME_HEALTH_STATES,
  CODING_WORKBENCH_RUNTIME_SOURCES,
  CODING_WORKBENCH_SCHEMA_VERSION,
  CODING_WORKBENCH_SUPERVISED_ACTION_KINDS,
  CODING_WORKBENCH_SUPERVISED_POLICY_REASONS,
  codingWorkbenchPolicyEffectFor,
  decideCodingWorkbenchActionForMode,
  isCodingWorkbenchActionAllowedForMode,
  isCodingWorkbenchModelSource,
  isCodingWorkbenchMode,
  isCodingWorkbenchRuntimeSource,
  permissionKindForSupervisedCodingAction,
  resolveEffectiveCodingWorkbenchMode,
  strictestCodingWorkbenchPolicyEffect,
  supervisedCodingActionRequiresApproval,
} from "./coding-workbench.js";
export type {
  CodingWorkbenchEvidenceKind,
  CodingWorkbenchEvidenceRecord,
} from "./coding-workbench-evidence.js";
export {
  CODING_WORKBENCH_EVIDENCE_KINDS,
  isCodingWorkbenchEvidenceSafeText,
  redactCodingWorkbenchEvidenceText,
  validateCodingWorkbenchEvidenceRecord,
} from "./coding-workbench-evidence.js";
export {
  validateCodingWorkbenchAuthorityEnvelope,
  validateCodingWorkbenchPermissionRequest,
  validateCodingWorkbenchRuntimeEvent,
} from "./coding-workbench-validation.js";

// ─── Atlassian connector contracts (Issue #2240, Epic #2238, ADR-0128) ─────────────
// Governed Confluence/Jira connector lane: descriptors (opaque authRef, never a secret), bounded
// sync scopes and job lifecycle, the D4 action-class mapping table with its pure per-mode decision
// helper, content-free activity/evidence shapes, and the connector-pod source projection.
export type {
  AtlassianConnectionVerificationStatus,
  AtlassianConnectorActionClass,
  AtlassianConnectorActionDecision,
  AtlassianConnectorActionDisposition,
  AtlassianConnectorActionExecutionFailed,
  AtlassianConnectorActionExecutionResult,
  AtlassianConnectorActionExecutionSucceeded,
  AtlassianConnectorActionReviewReason,
  AtlassianConnectorActionType,
  AtlassianConnectorActivityOutcome,
  AtlassianConnectorActivityReasonCode,
  AtlassianConnectorActivityRecord,
  AtlassianConnectorAuthScheme,
  AtlassianConnectorAuthorityFailureReason,
  AtlassianConnectorDescriptor,
  AtlassianConnectorHumanInitiationReason,
  AtlassianConnectorPendingApproval,
  AtlassianConnectorPodSource,
  AtlassianConnectorProvider,
  AtlassianConnectorWriteFailureReason,
  AtlassianLiveSearchTemplateId,
  AtlassianSyncBounds,
  AtlassianSyncChangeCounts,
  AtlassianSyncChangeSummary,
  AtlassianSyncFailureReason,
  AtlassianSyncJobCancelled,
  AtlassianSyncJobFailed,
  AtlassianSyncJobPartial,
  AtlassianSyncJobPending,
  AtlassianSyncJobRunning,
  AtlassianSyncJobState,
  AtlassianSyncJobStatus,
  AtlassianSyncJobSucceeded,
  AtlassianSyncProgressCounts,
  AtlassianSyncScope,
  AtlassianSyncTerminalStatus,
  ConfluenceSyncScope,
  JiraIssueCitationMetadata,
  JiraIssueLinkRef,
  JiraLiveIssue,
  JiraLiveSearchRequest,
  JiraLiveSearchResult,
  JiraSyncScope,
} from "./atlassian-connectors.js";
export {
  ATLASSIAN_CITATION_FIELD_MAX_CHARS,
  ATLASSIAN_CITATION_LIST_MAX_ENTRIES,
  ATLASSIAN_CITATION_METADATA_MAX_CHARS,
  ATLASSIAN_CONNECTION_VERIFICATION_STATUSES,
  ATLASSIAN_CONNECTOR_ACTION_APPROVAL_RISK,
  ATLASSIAN_CONNECTOR_ACTION_CLASS,
  ATLASSIAN_CONNECTOR_ACTION_CLASSES,
  ATLASSIAN_CONNECTOR_ACTION_DISPOSITIONS,
  ATLASSIAN_CONNECTOR_ACTION_PROVIDER,
  ATLASSIAN_CONNECTOR_ACTION_REQUIRED_SCOPE,
  ATLASSIAN_CONNECTOR_ACTION_REVIEW_REASONS,
  ATLASSIAN_CONNECTOR_ACTION_TYPES,
  ATLASSIAN_CONNECTOR_ACTIVITY_OUTCOMES,
  ATLASSIAN_CONNECTOR_AUTH_REF_PREFIX,
  ATLASSIAN_CONNECTOR_AUTH_SCHEMES,
  ATLASSIAN_CONNECTOR_AUTHORITY_FAILURE_REASONS,
  ATLASSIAN_CONNECTOR_BASE_URL_MAX_CHARS,
  ATLASSIAN_CONNECTOR_DISPLAY_NAME_MAX_CHARS,
  ATLASSIAN_CONNECTOR_HUMAN_INITIATION_REASON,
  ATLASSIAN_CONNECTOR_IDENTIFIER_MAX_CHARS,
  ATLASSIAN_CONNECTOR_PROVIDERS,
  ATLASSIAN_CONNECTOR_SCHEMA_VERSION,
  ATLASSIAN_CONNECTOR_SCOPE_DENY_REASON,
  ATLASSIAN_CONNECTOR_SUPERVISED_ACTION_KIND,
  ATLASSIAN_CONNECTOR_WORKBENCH_ACTION_CLASS,
  ATLASSIAN_CONNECTOR_WORKBENCH_RESOURCE_SCOPE,
  ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS,
  ATLASSIAN_CONFLUENCE_SPACE_KEY_MAX_CHARS,
  ATLASSIAN_JIRA_PROJECT_KEY_MAX_CHARS,
  ATLASSIAN_JQL_MAX_CHARS,
  ATLASSIAN_LIVE_ISSUE_SUMMARY_MAX_CHARS,
  ATLASSIAN_LIVE_SEARCH_MAX_RESULTS,
  ATLASSIAN_LIVE_SEARCH_TEMPLATE_IDS,
  ATLASSIAN_SYNC_FAILURE_REASONS,
  ATLASSIAN_SYNC_JOB_STATUSES,
  ATLASSIAN_SYNC_SCOPE_MAX_KEYS,
  ATLASSIAN_SYNC_TERMINAL_STATUSES,
  DEFAULT_ATLASSIAN_SYNC_BOUNDS,
  decideAtlassianConnectorAction,
  isAtlassianConnectionVerificationStatus,
  isAtlassianConnectorActionReviewReason,
  isAtlassianConnectorActionType,
  isAtlassianConnectorAuthRef,
  isAtlassianConnectorAuthScheme,
  isAtlassianConnectorAuthorityFailureReason,
  isAtlassianConnectorProvider,
  isAtlassianConnectorWriteFailureReason,
  isAtlassianLiveSearchTemplateId,
  isAtlassianSyncFailureReason,
  isAtlassianSyncJobStatus,
  isAtlassianSyncTerminalStatus,
  isJiraIssueCitationMetadata,
  isSafeAtlassianConnectorBaseUrl,
  isSafeAtlassianDisplayName,
  isSafeAtlassianIdentifier,
  isSafeConfluenceSpaceKey,
  isSafeJiraBrowseUrl,
  isSafeJiraCitationFieldText,
  isSafeJiraLiveIssueSummary,
  isSafeJiraProjectKey,
} from "./atlassian-connectors.js";
export type {
  AtlassianConnectorValidation,
  AtlassianConnectorValidationFail,
  AtlassianConnectorValidationOk,
} from "./atlassian-connectors-validation.js";
export {
  validateAtlassianConnectorActionExecutionResult,
  validateAtlassianConnectorActivityRecord,
  validateAtlassianConnectorDescriptor,
  validateAtlassianConnectorPendingApproval,
  validateAtlassianConnectorPodSource,
  validateAtlassianSyncBounds,
  validateAtlassianSyncChangeSummary,
  validateAtlassianSyncJobState,
  validateAtlassianSyncScope,
  validateJiraLiveSearchRequest,
  validateJiraLiveSearchResult,
} from "./atlassian-connectors-validation.js";
export type {
  CodingWorkbenchCodexAuthCommandLabel,
  CodingWorkbenchCodexAuthMethod,
  CodingWorkbenchCodexAuthSetupPlan,
  CodingWorkbenchCodexAuthSetupRequest,
  CodingWorkbenchCodexAuthStateRoot,
  CodingWorkbenchCodexAuthStateScope,
  CodingWorkbenchCodexAuthStatus,
  CodingWorkbenchCodexCredentialStore,
  CodingWorkbenchCodexCredentialTransport,
  CodingWorkbenchCodexRuntimeBinarySource,
  CodingWorkbenchCodexSubscriptionProfile,
  CodingWorkbenchRuntimeAdapterKind,
  CodingWorkbenchRuntimeProfileSelection,
} from "./coding-workbench-codex-auth.js";
export {
  CODING_WORKBENCH_CODEX_AUTH_COMMAND_LABELS,
  CODING_WORKBENCH_CODEX_AUTH_METHODS,
  CODING_WORKBENCH_CODEX_AUTH_STATE_ROOTS,
  CODING_WORKBENCH_CODEX_AUTH_STATE_SCOPES,
  CODING_WORKBENCH_CODEX_AUTH_STATUSES,
  CODING_WORKBENCH_CODEX_CREDENTIAL_STORES,
  CODING_WORKBENCH_CODEX_RUNTIME_BINARY_SOURCES,
  selectCodingWorkbenchRuntimeProfile,
  validateCodingWorkbenchCodexAuthSetupPlan,
  validateCodingWorkbenchCodexAuthSetupRequest,
  validateCodingWorkbenchCodexSubscriptionProfile,
} from "./coding-workbench-codex-auth.js";

// ─── Git repository status/diff BFF (Issue #1386, Epic #1491) ─────────────────────
// Read-only status/diff contract for the local BFF. The browser receives bounded, redacted
// repository metadata and unified diff text; all Git process execution stays server-side.
export type {
  GitRepositoryState,
  GitUnavailableReason,
  GitStatusCode,
  GitChangedFile,
  GitRepositoryStatusResponse,
  GitDiffScope,
  GitRepositoryDiffResponse,
  GitRepositoryValidationOk,
  GitRepositoryValidationFail,
  GitRepositoryValidation,
} from "./git-repository.js";
export {
  GIT_REPOSITORY_SCHEMA_VERSION,
  GIT_REPOSITORY_STATES,
  GIT_UNAVAILABLE_REASONS,
  validateGitRepositoryStatusResponse,
  validateGitRepositoryDiffResponse,
} from "./git-repository.js";

// ─── Editor Git read surface (Issue #2227, Epic #2093, ADR-0127) ────────────────
// Bounded structured staged/worktree diff and privacy-minimized blame contracts shared by the
// server route, editor decorations/peek, Git Client, and later read-only agent context.
export type {
  GitEditorDiffScope,
  GitEditorDiffLayer,
  GitEditorDiffLineKind,
  GitEditorDiffFileStatus,
  GitEditorDiffLine,
  GitEditorDiffHunk,
  GitEditorDiffFile,
  GitEditorDiffRequest,
  GitEditorDiffResponse,
  GitEditorBlameRequest,
  GitEditorBlameLine,
  GitEditorBlameResponse,
  GitEditorParseOk,
  GitEditorParseFail,
  GitEditorParseResult,
} from "./git-editor.js";
export {
  GIT_EDITOR_SCHEMA_VERSION,
  GIT_EDITOR_DIFF_MAX_BYTES,
  GIT_EDITOR_DIFF_MAX_FILES,
  GIT_EDITOR_DIFF_MAX_HUNKS_PER_FILE,
  GIT_EDITOR_DIFF_MAX_LINES_PER_HUNK,
  GIT_EDITOR_DIFF_MAX_HEADER_CHARS,
  GIT_EDITOR_DIFF_MAX_LINE_CHARS,
  GIT_EDITOR_PATH_MAX_BYTES,
  GIT_EDITOR_BLAME_MAX_BYTES,
  GIT_EDITOR_BLAME_MAX_LINES,
  GIT_EDITOR_BLAME_AUTHOR_MAX_CHARS,
  GIT_EDITOR_BLAME_SUMMARY_MAX_CHARS,
  GIT_AGENT_CONTEXT_MAX_FILES,
  GIT_AGENT_CONTEXT_MAX_HUNKS,
  GIT_AGENT_CONTEXT_MAX_BLAME_LINES,
  GIT_AGENT_CONTEXT_MAX_RESULT_BYTES,
  GIT_EDITOR_DIFF_SCOPES,
  GIT_EDITOR_DIFF_LAYERS,
  GIT_EDITOR_DIFF_LINE_KINDS,
  GIT_EDITOR_DIFF_FILE_STATUSES,
  isGitEditorDiffScope,
  isGitEditorDiffLayer,
  isGitEditorDiffLineKind,
  isGitEditorDiffFileStatus,
  isGitEditorDiffLine,
  isGitEditorDiffHunk,
  isGitEditorDiffFile,
  isGitEditorBlameLine,
  parseGitEditorDiffRequest,
  parseGitEditorDiffResponse,
  parseGitEditorBlameRequest,
  parseGitEditorBlameResponse,
} from "./git-editor.js";

// ─── Git repository summary + remotes BFF (Issue #1573, Epic #1572) ───────────────
// Read-only repository summary (branch/upstream/ahead-behind/counts/remotes/last-sync) and a
// dedicated remotes response. The browser receives bounded, redacted metadata only; all Git
// process execution stays server-side. Reuses GitRepositoryState/GitUnavailableReason unions.
export type {
  GitRemoteSummary,
  GitRepositorySummaryRemote,
  GitUpstreamSummary,
  GitLastSyncMetadata,
  GitRepositorySummary,
  GitRemotesResponse,
  GitRepositorySummaryValidation,
} from "./git-repository-summary.js";
export {
  GIT_REPOSITORY_SUMMARY_SCHEMA_VERSION,
  validateGitRepositorySummary,
  validateGitRemotesResponse,
} from "./git-repository-summary.js";

// ─── Git commit history BFF (Issue #1573, Epic #1572) ─────────────────────────────
// Read-only, paginated commit history (sha/subject/author/ISO date/refs/parent and changed-file
// counts). Bounded entries with limit/skip/truncated; all Git process execution stays server-side.
export type { GitHistoryEntry, GitHistoryResponse } from "./git-history.js";
export { GIT_HISTORY_SCHEMA_VERSION, validateGitHistoryResponse } from "./git-history.js";

// ─── Git fetch/pull sync BFF (Issue #1573, Epic #1572) ────────────────────────────
// Read-only sync preview (readiness/executable gate + block reason) and the governed execute
// request/response with an evidence-friendly outcome taxonomy. Fetch/pull deliberately do NOT
// enter the GitDeliveryActionKind mutation taxonomy; they use a dedicated bounded git executor.
export type {
  GitSyncOperation,
  GitSyncOutcome,
  GitSyncBlockReason,
  GitSyncExecuteRequest,
  GitSyncPreview,
  GitSyncExecuteResponse,
} from "./git-sync.js";
export {
  GIT_SYNC_SCHEMA_VERSION,
  GIT_SYNC_OPERATIONS,
  GIT_SYNC_OUTCOMES,
  GIT_SYNC_BLOCK_REASONS,
  isGitSyncOperation,
  isGitSyncOutcome,
  validateGitSyncPreview,
  validateGitSyncExecuteResponse,
} from "./git-sync.js";

// ─── Agent repository operation facade (Issue #1577, Epic #1571) ─────────────
// Typed agent admission contract over existing Git reads and governed Git delivery routes. It grants
// no shell/provider authority and reject command-shaped payloads before the BFF can delegate.
export type {
  GitRepositoryAgentOperationMode,
  GitRepositoryAgentOperationKind,
  GitRepositoryAgentDenialReason,
  GitRepositoryAgentOperationRequest,
  GitRepositoryAgentOperationDelegatedResponse,
  GitRepositoryAgentOperationDeniedResponse,
  GitRepositoryAgentOperationResponse,
  GitRepositoryAgentParseOk,
  GitRepositoryAgentParseFail,
  GitRepositoryAgentParseResult,
} from "./git-repository-agent.js";
export {
  GIT_REPOSITORY_AGENT_SCHEMA_VERSION,
  GIT_REPOSITORY_AGENT_OPERATION_MODES,
  GIT_REPOSITORY_AGENT_OPERATION_KINDS,
  GIT_REPOSITORY_AGENT_DENIAL_REASONS,
  parseGitRepositoryAgentOperationRequest,
  isGitRepositoryAgentOperationResponse,
} from "./git-repository-agent.js";

// ─── Controlled command executor (Issue #1387, Epic #1491) ────────────────────────
// Wire contract for the governed test/build/run command runner: a server-discovered catalog of
// vetted tasks, a run request that names a catalog `taskId` (never free-form argv), the structured
// run result (exit code, duration, truncation, failure reason), and the SSE run events. The executor
// allowlist (`COMMAND_TASK_RULES`) is separate from the read-only command rule tables so the
// test/build/run surface cannot widen them. Discovery + execution live in keiko-server.
export type {
  CommandTaskKind,
  CommandTaskSource,
  CommandTaskTrustState,
  CommandTaskTrustReason,
  CommandTask,
  CommandTaskCatalog,
  CommandFailureReason,
  CommandTaskRunRequest,
  CommandTaskRunResult,
  CommandRunnerEventKind,
  CommandRunnerEvent,
  CommandTaskRunRequestParseOk,
  CommandTaskRunRequestParseFail,
  CommandTaskRunRequestParse,
  CommandTaskCatalogParseOk,
  CommandTaskCatalogParseFail,
  CommandTaskCatalogParse,
  CommandTaskRunResultParseOk,
  CommandTaskRunResultParseFail,
  CommandTaskRunResultParse,
} from "./command-runner.js";
export {
  COMMAND_RUNNER_SCHEMA_VERSION,
  COMMAND_TASK_KINDS,
  COMMAND_TASK_SOURCES,
  COMMAND_TASK_TRUST_STATES,
  COMMAND_TASK_TRUST_REASONS,
  COMMAND_FAILURE_REASONS,
  COMMAND_RUNNER_EVENT_KINDS,
  COMMAND_TASK_RULES,
  parseCommandTaskRunRequest,
  validateCommandTaskCatalog,
  validateCommandTaskRunResult,
} from "./command-runner.js";

// ─── Editor completion gateway (Issue #1199) ──────────────────────────────────────
// Wire request/response for the governed `POST /api/editor/completion` route: deterministic
// language-service completion (#1198) merged with gated model-assisted completion (#1210) over
// coding context (#1211). Content-free apart from reviewable `insertText` (ADR-0042 D4/D5/D6).
export type {
  EditorCompletionWireTriggerKind,
  EditorCompletionItemOrigin,
  EditorCompletionWireItem,
  EditorCompletionSource,
  EditorCompletionWireProvenance,
  EditorCompletionWireResponse,
  EditorCompletionContextSelectors,
  EditorCompletionWireRequest,
  EditorCompletionParseOk,
  EditorCompletionParseFail,
  EditorCompletionParse,
} from "./editor-completion.js";
export {
  EDITOR_COMPLETION_SCHEMA_VERSION,
  EDITOR_COMPLETION_WIRE_TRIGGER_KINDS,
  EDITOR_COMPLETION_ITEM_ORIGINS,
  EDITOR_COMPLETION_SOURCES,
  parseEditorCompletionRequest,
} from "./editor-completion.js";

// ─── Container engine detection + governed execution (Issue #1388, ADR-0070) ──────
// Wire vocabulary for the container runtime pilot: the active-probe capability response (engine
// state aliased from the #1385 runtime-capability vocabulary), the closed execution policy
// (read-only `/workspace` mount, `--network none`, frozen resource limits, `--pull never`), the
// server-frozen task catalog + run request/result/events, and the deny-by-default
// `CONTAINER_TASK_RULES` defense-in-depth allowlist. Detection + execution live in keiko-server.
export type {
  ContainerEngineId,
  ContainerEngineState,
  ContainerEngineUnavailableReason,
  ContainerEngineStatus,
  ContainerCapabilityResponse,
  ContainerMountMode,
  ContainerNetworkMode,
  ContainerResourceLimits,
  ContainerExecutionPolicy,
  ContainerTaskKind,
  ContainerTask,
  ContainerTaskCatalog,
  ContainerRunRequest,
  ContainerFailureReason,
  ContainerRunResult,
  ContainerRunnerEventKind,
  ContainerRunnerEvent,
  ContainerRunRequestParseOk,
  ContainerRunRequestParseFail,
  ContainerRunRequestParse,
  ContainerCapabilityResponseParseOk,
  ContainerCapabilityResponseParseFail,
  ContainerCapabilityResponseParse,
  ContainerTaskCatalogParseOk,
  ContainerTaskCatalogParseFail,
  ContainerTaskCatalogParse,
  ContainerRunResultParseOk,
  ContainerRunResultParseFail,
  ContainerRunResultParse,
} from "./container-runtime.js";
export {
  CONTAINER_RUNTIME_SCHEMA_VERSION,
  CONTAINER_ENGINE_IDS,
  CONTAINER_MOUNT_MODES,
  CONTAINER_NETWORK_MODES,
  CONTAINER_TASK_KINDS,
  CONTAINER_FAILURE_REASONS,
  CONTAINER_RUNNER_EVENT_KINDS,
  CONTAINER_TASK_RULES,
  parseContainerRunRequest,
  validateContainerCapabilityResponse,
  validateContainerTaskCatalog,
  validateContainerRunResult,
} from "./container-runtime.js";

// ─── Editor inline completion (ghost text) (Issue #1200) ───────────────────────────
// Wire request/response for the governed `POST /api/editor/inline-completion` route (model-only,
// suffix-aware FIM via #1210 over coding context #1211) plus the content-free acceptance/rejection
// telemetry report for `POST /api/editor/inline-completion/telemetry`. Content-free apart from
// reviewable `insertText` (ADR-0042 D5/D6).
export type {
  EditorInlineCompletionWireTriggerKind,
  EditorInlineCompletionWireItem,
  EditorInlineCompletionWireProvenance,
  EditorInlineCompletionWireResponse,
  EditorInlineCompletionWireRequest,
  EditorInlineCompletionTelemetryReport,
  EditorInlineCompletionParseOk,
  EditorInlineCompletionParseFail,
  EditorInlineCompletionParse,
  EditorInlineCompletionTelemetryParseOk,
  EditorInlineCompletionTelemetryParseFail,
  EditorInlineCompletionTelemetryParse,
} from "./editor-inline-completion.js";
export {
  EDITOR_INLINE_COMPLETION_SCHEMA_VERSION,
  EDITOR_INLINE_COMPLETION_WIRE_TRIGGER_KINDS,
  EDITOR_INLINE_COMPLETION_TELEMETRY_SCHEMA_VERSION,
  parseEditorInlineCompletionRequest,
  parseEditorInlineCompletionTelemetry,
} from "./editor-inline-completion.js";

// ─── Editor test generation (Issue #1202) ─────────────────────────────────────────
// Wire request/response for the governed `POST /api/editor/test-generation` route. Wave-2 surface,
// shipped switched off (ADR-0042 D7): generation/execution/verification execute untrusted model code
// and are deferred behind a default-off flag enabled only once a deny-by-default egress boundary is
// enforced. Content-free apart from reviewable patch `newText`; the assured pre-filter funnel is
// always reported and is `not-run` in v1.
export type {
  EditorTestGenerationTargetKind,
  EditorTestGenerationWireSymbol,
  EditorTestGenerationWireTarget,
  EditorTestGenerationWireRequest,
  EditorTestGenerationStatus,
  EditorTestGenerationAssurance,
  EditorTestGenerationGateState,
  EditorTestGenerationFunnel,
  EditorTestGenerationWireChangeKind,
  EditorTestGenerationWireEdit,
  EditorTestGenerationWireFileChange,
  EditorTestGenerationWirePatch,
  EditorTestGenerationWireProvenance,
  EditorTestGenerationWireResponse,
  EditorTestGenerationParseOk,
  EditorTestGenerationParseFail,
  EditorTestGenerationParse,
} from "./editor-test-generation.js";
export {
  EDITOR_TEST_GENERATION_SCHEMA_VERSION,
  EDITOR_TEST_GENERATION_STABILITY_RUNS,
  EDITOR_TEST_GENERATION_TARGET_KINDS,
  EDITOR_TEST_GENERATION_STATUSES,
  EDITOR_TEST_GENERATION_ASSURANCES,
  EDITOR_TEST_GENERATION_GATE_STATES,
  notRunTestGenerationFunnel,
  parseEditorTestGenerationRequest,
} from "./editor-test-generation.js";

// ─── Editor patch apply + post-apply verification (Issue #1204) ───────────────────
// Wire request/response for the governed `POST /api/editor/patch-apply` route. Wave-2 surface, shipped
// switched off (ADR-0042 D7): patch apply and the verification that follows execute untrusted model
// code in an enforced, deny-by-default egress boundary (ADR-0043). Content-free apart from the
// reviewable diff the user explicitly applies and a guarded revert proposal's inverse diff.
export type {
  EditorPatchApplyDecision,
  EditorPatchApplyWireRequest,
  EditorPatchApplyStatus,
  EditorPatchRejectionReason,
  EditorPatchApplyRejection,
  EditorPatchApplyChangeCounts,
  EditorPatchVerificationOutcome,
  EditorPatchVerificationBounds,
  EditorPatchVerificationSummary,
  EditorPatchRevertProposal,
  EditorPatchApplyEvidenceRefs,
  EditorPatchApplyWireResponse,
  EditorPatchApplyParseOk,
  EditorPatchApplyParseFail,
  EditorPatchApplyParse,
} from "./editor-patch-apply.js";
export {
  EDITOR_PATCH_APPLY_SCHEMA_VERSION,
  EDITOR_PATCH_APPLY_DECISIONS,
  EDITOR_PATCH_APPLY_STATUSES,
  EDITOR_PATCH_REJECTION_REASONS,
  EDITOR_PATCH_VERIFICATION_OUTCOMES,
  parseEditorPatchApplyRequest,
} from "./editor-patch-apply.js";

// ─── Gateway (wire-safe subset only — credential-bearing shapes stay in src/gateway/types.ts) ──
export type {
  ModelKind,
  CostClass,
  LatencyClass,
  ModelTokenAccountingSource,
  ModelTokenAccounting,
  InfillingAlignment,
  ModelCapability,
  CompletionInteractionMode,
  CompletionDegradeReason,
  CompletionModelSelection,
  ChatMessage,
  ChatMessageContentPart,
  ChatMessageImageUrlContentPart,
  ChatMessageTextContentPart,
  ToolDefinition,
  ResponseFormat,
  GatewaySamplingParameters,
  GatewaySamplingParameterName,
  GatewaySamplingParameterIssue,
  GatewayRequest,
  NormalizedToolCall,
  UsageMetadata,
  NormalizedResponse,
  FinishReason,
  StreamDelta,
  StreamEvent,
  VoiceProviderLocality,
  VoicePersona,
  VoiceProfile,
  VoiceUnavailableReason,
  VoiceTransportPosture,
  VoiceCapabilityResolution,
  VoiceProviderAvailability,
} from "./gateway.js";
export {
  CONVERSATION_CAPABILITY_CONTRACT_VERSION,
  GATEWAY_TEMPERATURE_RANGE,
  GATEWAY_TOP_P_RANGE,
  INFILLING_ALIGNMENTS,
  VOICE_PROVIDER_LOCALITIES,
  VOICE_PERSONAS,
  assertValidGatewaySamplingParameters,
  isValidGatewaySamplingParameters,
  isValidGatewayTemperature,
  isValidGatewayTopP,
  validateGatewaySamplingParameters,
} from "./gateway.js";
export type { ConversationIneligibilityReason } from "./gateway.js";
export {
  isConversationEligibleModel,
  explainConversationIneligibility,
  modelSupportsInfilling,
  isAlignedInfillingModel,
  isAsYouTypeCompletionModel,
  isVoiceCapability,
  modelSupportsSpeechInput,
  modelSupportsSpeechOutput,
  modelSupportsRealtimeVoice,
  isConfiguredVoiceProvider,
  describeVoiceProviderAvailability,
  listVoicePersonas,
} from "./gateway.js";

// ─── Voice control / media protocol (Issue #496 / Epic #491; ADR-0101) ──────────
// Versioned, content-free wire-protocol contract for the optional Voice Digital Twin: the WebSocket
// control / signaling message catalog, the WebRTC media-plane descriptor, the capability-gating and
// fallback state table, and the replay / reconnect / redaction classification. Pure types + frozen
// const tables + pure validators only — no transport (that is Issue #497). `VOICE_PROTOCOL_VERSION`
// is independent of `CONVERSATION_CAPABILITY_CONTRACT_VERSION` and never bumps it. The protocol reuses
// the `VoiceProfile` / `VoiceProviderLocality` / `VoiceUnavailableReason` types from gateway.ts.
export type {
  VoicePlane,
  VoiceControlTransport,
  VoiceMediaTransport,
  VoiceNegotiationMode,
  VoiceReplayClass,
  VoiceRedactionClass,
  VoiceMessageDirection,
  VoiceMediaTrackKind,
  VoiceMediaPlaneDescriptor,
  VoiceControlMessageKind,
  VoiceDataChannelEventKind,
  VoiceSessionCloseReason,
  VoiceMediaTrackState,
  VoicePlaybackState,
  VoicePolicyDecision,
  VoiceProtocolErrorCode,
  VoiceSessionMemoryContext,
  VoiceSessionGroundingKind,
  VoiceSessionGroundingContext,
  VoiceSessionChatContext,
  VoiceSessionCreateMessage,
  VoiceSessionCreatedMessage,
  VoiceSessionCloseMessage,
  VoiceSessionClosedMessage,
  VoiceCapabilityOfferMessage,
  VoiceCapabilitySelectMessage,
  VoiceSdpOfferMessage,
  VoiceSdpAnswerMessage,
  VoiceIceCandidateMessage,
  VoiceMediaTrackStateMessage,
  VoiceControlCancelMessage,
  VoiceControlInterruptMessage,
  VoiceTranscriptPartialMessage,
  VoiceTranscriptCommittedMessage,
  VoiceTranscriptDiscardedMessage,
  VoicePlaybackStateMessage,
  VoicePolicyDecisionMessage,
  VoiceErrorMessage,
  VoiceControlMessage,
  VoiceProtocolTimeouts,
  VoiceProtocolValidation,
} from "./voice-protocol.js";
export {
  VOICE_PROTOCOL_VERSION,
  VOICE_PLANES,
  VOICE_CONTROL_TRANSPORTS,
  VOICE_CONTROL_TRANSPORT_V1,
  VOICE_MEDIA_TRANSPORTS,
  VOICE_NEGOTIATION_MODES,
  PREFERRED_VOICE_NEGOTIATION_MODE,
  VOICE_REPLAY_CLASSES,
  VOICE_REDACTION_CLASSES,
  VOICE_MESSAGE_DIRECTIONS,
  VOICE_MEDIA_TRACK_KINDS,
  VOICE_MEDIA_PLANE,
  VOICE_CONTROL_MESSAGE_KINDS,
  VOICE_DATA_CHANNEL_EVENT_KINDS,
  VOICE_SESSION_CLOSE_REASONS,
  VOICE_MEDIA_TRACK_STATES,
  VOICE_PLAYBACK_STATES,
  VOICE_POLICY_DECISIONS,
  VOICE_PROTOCOL_ERROR_CODES,
  VOICE_CONTROL_MESSAGE_REPLAY,
  VOICE_CONTROL_MESSAGE_REDACTION,
  VOICE_PROFILE_ALLOWED_MESSAGE_KINDS,
  VOICE_PROFILE_MEDIA_TRANSPORT,
  VOICE_PROFILE_NEGOTIATION_MODE,
  DEFAULT_VOICE_PROTOCOL_TIMEOUTS,
  isVoiceProtocolVersionSupported,
  isVoiceControlMessageKind,
  isVoiceMessageDirection,
  isVoiceNegotiationMode,
  voiceControlMessageReplayClass,
  voiceControlMessageRedactionClass,
  isVoiceReplayEligible,
  voiceMessageAllowedForProfile,
  assertNeverVoiceControlMessageKind,
  isVoiceControlMessage,
  validateVoiceControlMessage,
} from "./voice-protocol.js";

// ─── Voice transcript segment lifecycle (Issue #500 / Epic #491; ADR-0105) ───────
export type {
  VoiceTranscriptSegmentState,
  VoiceTranscriptProviderErrorKind,
  VoiceTranscriptSource,
  VoiceTranscriptSegment,
  CommittedVoiceTranscriptProjection,
  VoiceTranscriptEvidenceSummary,
} from "./voice-transcript.js";
export {
  VOICE_TRANSCRIPT_SCHEMA_VERSION,
  VOICE_TRANSCRIPT_SEGMENT_STATES,
  VOICE_TRANSCRIPT_CONSUMABLE_STATES,
  VOICE_TRANSCRIPT_PROVIDER_ERROR_KINDS,
  VOICE_TRANSCRIPT_SOURCES,
  VOICE_TRANSCRIPT_SEGMENT_REPLAY,
  VOICE_TRANSCRIPT_SEGMENT_REDACTION,
  VOICE_TRANSCRIPT_SEGMENT_TRANSITIONS,
  isVoiceTranscriptSchemaVersionSupported,
  isVoiceTranscriptSegmentState,
  isVoiceTranscriptProviderErrorKind,
  isVoiceTranscriptSource,
  voiceTranscriptSegmentReplayClass,
  voiceTranscriptSegmentRedactionClass,
  canTransitionVoiceTranscriptSegment,
  isCommittedVoiceTranscriptState,
  assertNeverVoiceTranscriptSegmentState,
  mapWireKindToVoiceTranscriptSegmentState,
  voiceTranscriptCaptureAllowed,
  voiceTranscriptPreviewAllowed,
  selectCommittedVoiceTranscript,
  summarizeVoiceTranscript,
} from "./voice-transcript.js";

// ─── Voice assistant speech-output playback lifecycle (Issue #501 / Epic #491; ADR-0106) ──
export type {
  VoicePlaybackPhase,
  VoicePlaybackFailureKind,
  VoicePlaybackEffect,
  VoicePlaybackTurnSummary,
} from "./voice-playback.js";
export {
  VOICE_PLAYBACK_SCHEMA_VERSION,
  VOICE_PLAYBACK_PHASES,
  VOICE_PLAYBACK_ACTIVE_PHASES,
  VOICE_PLAYBACK_SETTLED_PHASES,
  VOICE_PLAYBACK_FAILURE_KINDS,
  VOICE_PLAYBACK_PHASE_REPLAY,
  VOICE_PLAYBACK_PHASE_REDACTION,
  VOICE_PLAYBACK_AUDIO_PLANE,
  VOICE_PLAYBACK_TRANSITIONS,
  VOICE_PLAYBACK_EFFECTS,
  isVoicePlaybackSchemaVersionSupported,
  isVoicePlaybackPhase,
  isVoicePlaybackFailureKind,
  isVoicePlaybackEffect,
  voicePlaybackPhaseReplayClass,
  voicePlaybackPhaseRedactionClass,
  isActiveVoicePlaybackPhase,
  isSettledVoicePlaybackPhase,
  canTransitionVoicePlayback,
  assertNeverVoicePlaybackPhase,
  mapVoicePlaybackPhaseToWireState,
  voicePlaybackAllowedForProfile,
  voicePlaybackInterruptAllowedForProfile,
  initialVoicePlaybackPhase,
  summarizeVoicePlaybackTurn,
} from "./voice-playback.js";

// ─── Tools ──────────────────────────────────────────────────────────────────────
export type {
  NetworkPolicy,
  FilesystemPolicy,
  SandboxPolicy,
  SandboxBackend,
  SandboxAttestation,
  CommandRule,
  CommandRunInput,
  CommandResult,
  PatchChangeKind,
  PatchHunk,
  PatchFileChange,
  PatchRejectionCode,
  PatchRejection,
  PatchConflict,
  PatchValidation,
  PatchLimits,
  PatchApplyResult,
  ToolHostConfig,
  ToolHostConfigInput,
  ToolCallRequest,
  ToolCallMetadata,
  ToolCallResult,
  ToolPort,
} from "./tools.js";
export {
  DEFAULT_ENV_ALLOWLIST,
  DEFAULT_SANDBOX_POLICY,
  SANDBOX_BACKENDS,
  DEFAULT_COMMAND_RULES,
  DEFAULT_PATCH_LIMITS,
  DEFAULT_TOOL_HOST_CONFIG,
} from "./tools.js";

// ─── Verification ───────────────────────────────────────────────────────────────
export type {
  VerificationKind,
  VerificationStatus,
  ResourceDimension,
  ResourceLimitDecision,
  VerificationResourceLimits,
  VerificationStep,
  VerificationPlan,
  VerificationResult,
  VerificationFailureLocation,
  VerificationReport,
  ScriptCatalog,
  ScriptMapping,
} from "./verification.js";
export {
  DEFAULT_VERIFICATION_LIMITS,
  VERIFICATION_FAILURE_MESSAGE_MAX_CHARS,
  VERIFICATION_MAX_FAILURE_LOCATIONS,
} from "./verification.js";

// ─── Editor verification run/event envelope (Issue #2210, Epic #2092, ADR-0126) ──
export type {
  EditorVerificationRunState,
  EditorVerificationRunRequest,
  EditorVerificationRunRequestParse,
  EditorVerificationRunRequestParseOk,
  EditorVerificationRunRequestParseFail,
  EditorVerificationRun,
  EditorVerificationEventKind,
  EditorVerificationRunStartedEvent,
  EditorVerificationStepStartedEvent,
  EditorVerificationStepCompletedEvent,
  EditorVerificationRunCompletedEvent,
  EditorVerificationRunCancelledEvent,
  EditorVerificationRunFailedEvent,
  EditorVerificationEvent,
  EditorVerificationTrustState,
  EditorVerificationCatalogEntry,
  EditorVerificationCatalog,
} from "./editor-verification.js";
export {
  EDITOR_VERIFICATION_SCHEMA_VERSION,
  EDITOR_VERIFICATION_MAX_KINDS,
  EDITOR_VERIFICATION_MAX_REQUEST_ID_LENGTH,
  EDITOR_VERIFICATION_REASON_MAX_CHARS,
  EDITOR_VERIFICATION_KINDS,
  EDITOR_VERIFICATION_RUN_STATES,
  EDITOR_VERIFICATION_EVENT_KINDS,
  parseEditorVerificationRunRequest,
  isVerificationKind,
  isEditorVerificationRunState,
  isEditorVerificationEventKind,
  isEditorVerificationRun,
  isEditorVerificationEvent,
  isEditorVerificationCatalog,
} from "./editor-verification.js";

// ─── Editor problems aggregation (Issue #2210, Epic #2092, ADR-0126) ─────────────
export type {
  EditorProblemSeverity,
  EditorProblemSource,
  EditorProblemKind,
  EditorProblem,
  EditorProblemsSnapshot,
} from "./editor-problems.js";
export {
  EDITOR_PROBLEMS_SCHEMA_VERSION,
  EDITOR_PROBLEMS_PER_FILE_CAP,
  EDITOR_PROBLEMS_TOTAL_CAP,
  EDITOR_PROBLEM_MESSAGE_MAX_CHARS,
  compareEditorProblems,
  buildEditorProblemsSnapshot,
  isEditorProblem,
  isEditorProblemsSnapshot,
  isEditorProblemSeverity,
  isEditorProblemSource,
} from "./editor-problems.js";

// ─── Agent verification access (Issue #2214, Epic #2092, ADR-0126 D4/D5) ─────────
export type {
  EditorAgentVerificationRunRequest,
  EditorAgentVerificationRunRequestParse,
  EditorAgentVerificationRunRequestParseOk,
  EditorAgentVerificationRunRequestParseFail,
  RedactedVerificationStep,
  RedactedVerificationReport,
  EditorAgentVerificationDisposition,
  EditorAgentVerificationResult,
} from "./editor-agent-verification.js";
export {
  EDITOR_AGENT_VERIFICATION_SESSION_ID_MAX_CHARS,
  EDITOR_AGENT_VERIFICATION_RUN_ID_MAX_CHARS,
  EDITOR_AGENT_VERIFICATION_ENVELOPE_DIGEST_MAX_CHARS,
  toRedactedVerificationReport,
  parseEditorAgentVerificationResult,
  parseEditorAgentVerificationRunRequest,
  isEditorAgentVerificationResult,
} from "./editor-agent-verification.js";

// ─── Evaluations ────────────────────────────────────────────────────────────────
export type {
  EvaluationDimension,
  FixtureOracle,
  WorkflowKind,
  EvaluationFixture,
  DimensionOutcome,
  DimensionResult,
  FixtureRunResult,
  ScorecardEntry,
  SurfaceParityCheckResult,
  SurfaceParityResult,
  LiveRunContext,
  ScorecardSummary,
  EvalScorecard,
  EvaluationMode,
} from "./evaluations.js";
export { EVALUATION_DIMENSIONS, EVAL_SCORECARD_SCHEMA_VERSION } from "./evaluations.js";

// ─── Unit-test workflow events (member names collide with harness; only union surfaces) ───
export type {
  WorkflowStatus,
  FileNamingStyle,
  WorkflowLimits,
  WorkflowEvent,
  WorkflowEventSink,
} from "./unit-test-events.js";
export { DEFAULT_WORKFLOW_LIMITS } from "./unit-test-events.js";

// ─── Bug-investigation workflow events (distinct member names by ADR-0009 D5) ─────
export type {
  BugWorkflowStatus,
  BugWorkflowLimits,
  BugInvestigationStartedEvent,
  FailureParsedEvent,
  BugContextSelectedEvent,
  BugModelCallStartedEvent,
  BugModelCallCompletedEvent,
  RootCauseProposedEvent,
  BugPatchValidatedEvent,
  BugPatchAppliedEvent,
  BugVerificationResultEvent,
  BugInvestigationCompletedEvent,
  BugInvestigationFailedEvent,
  BugInvestigationEvent,
  BugWorkflowEventSink,
} from "./bug-investigation-events.js";
export { DEFAULT_BUG_WORKFLOW_LIMITS } from "./bug-investigation-events.js";

// ─── Verification summary (pure types; runtime functions stay in src/verification/summary.ts) ──
export type {
  VerificationResultSummary,
  VerificationSummary,
  AuditResultEntry,
  VerificationAuditSummary,
} from "./verification-summary.js";

// ─── Evidence (ADR-0010; store port + manifest types + retention config) ────────────────────
export type {
  EvidenceRunIdentity,
  EvidenceModel,
  EvidenceUsageTotals,
  EvidenceStateTransition,
  EvidenceToolCall,
  EvidenceCommandExecution,
  EvidenceSandboxConfiguration,
  EvidenceVerificationResult,
  EvidencePatch,
  EvidenceReasoningEntry,
  EvidenceFailure,
  EvidenceTaskType,
  EvidenceBrowserViewportPx,
  EvidenceBrowserEventType,
  EvidenceBrowserEvent,
  EvidenceBrowserScreenshot,
  EvidenceBrowserContentCapture,
  EvidenceBrowserCapture,
  EvidenceConnectedContextScope,
  EvidenceConnectedContextQuery,
  EvidenceConnectedContextExcerpt,
  EvidenceConnectedContextFile,
  EvidenceConnectedContextOmitted,
  EvidenceConnectedContextUncertainty,
  EvidenceConnectedContextPlan,
  EvidenceConnectedContextAudit,
  EvidenceManifest,
  AuditRedactionConfig,
  RetentionPolicy,
  BuildOptions,
  EvidenceBuildInput,
  EvidenceDeps,
  EvidenceStore,
  SideFileWriteResult,
} from "./evidence.js";
export { EVIDENCE_SCHEMA_VERSION, DEFAULT_RETENTION } from "./evidence.js";

// ─── BFF wire types (ADR-0013; entity shapes that travel over the HTTP wire) ──────────────
// NOTE: WorkflowStatus and ChatMessage are NOT re-exported here because those names are already
// taken by unit-test-events.ts and gateway.ts respectively. Import them directly from
// "@oscharko-dev/keiko-contracts/bff-wire" when needed (the subpath key has no .js suffix).
export type {
  Project,
  Chat,
  ChatRole,
  CreateChatOptions,
  UpdateProjectPatch,
  UpdateChatPatch,
  NewChatMessage,
  UpdateChatMessagePatch,
  GroundedAnswerContextPackSummary,
  GroundedAnswerContextSummary,
  GroundedAnswerRankingSummary,
  ConversationDocumentContextWire,
  ConversationAttachmentDescriptorWire,
  ConversationMemoryRequestWire,
  ConversationMemoryResultWire,
  DesktopChatSendRequestWire,
  DesktopChatSendResponse,
  DesktopChatStreamEventType,
  DesktopChatStreamTerminalEventType,
  DesktopChatStreamTokenEvent,
  DesktopChatStreamDoneEvent,
  DesktopChatStreamErrorEvent,
  DesktopChatStreamCancelledEvent,
  DesktopChatStreamEvent,
  DesktopChatStreamTerminalEvent,
  DesktopChatSendAbortContract,
  BffErrorCode,
  BffError,
  GroundingLimits,
} from "./bff-wire.js";
export {
  buildGroundedAnswerContextPackSummary,
  DEFAULT_GROUNDING_LIMITS,
  GROUNDING_LIMIT_CEILINGS,
  DESKTOP_CHAT_STREAM_EVENT_TYPES,
  DESKTOP_CHAT_STREAM_TERMINAL_EVENT_TYPES,
  DESKTOP_CHAT_SEND_ABORT_CONTRACT,
  isDesktopChatStreamEvent,
  isDesktopChatStreamTerminalEvent,
  eventIsDesktopChatStreamTerminal,
  resolveGroundingLimits,
  MAX_ATTACHMENT_BYTES,
  ALLOWED_IMAGE_MIME_PREFIXES,
  ALLOWED_DOCUMENT_MIME_PREFIXES,
  ALLOWED_DOCUMENT_MIME_LITERALS,
  classifyAttachmentMime,
  UI_HOST,
  DEFAULT_UI_PORT,
} from "./bff-wire.js";

// ─── Shared text-safety primitive (Epic #177/#189 grounding hardening, GRD-001) ──
export {
  containsAbsolutePath,
  containsPseudoRoleMarker,
  redactAbsolutePaths,
  stripUnsafeFormatChars,
} from "./text-safety.js";

// ─── Governed documentation browser (Epic #1851, ADR-0113) ──────────────────────
export type {
  DocumentationTargetClass,
  DocumentationTargetClassification,
  DocumentationTargetClassificationOk,
  DocumentationTargetClassificationFail,
  DocumentationNavigationReason,
  DocumentationReasonSeverity,
  DocumentationNavigationRequest,
  DocumentationNavigationResult,
  DocumentationNavigationResultInput,
  DocumentationBrowserCapability,
  DocumentationNavigationParse,
  DocumentationNavigationParseOk,
  DocumentationNavigationParseFail,
} from "./documentation-browser.js";
export {
  DOCUMENTATION_BROWSER_SCHEMA_VERSION,
  DOCUMENTATION_TARGET_CLASSES,
  DOCUMENTATION_TARGET_MAX_LENGTH,
  DOCUMENTATION_NAVIGATION_REASONS,
  DOCUMENTATION_NAVIGATION_REASON_SEVERITY,
  classifyDocumentationTarget,
  mapBrowserErrorToDocumentationReason,
  resolveDocumentationNavigationReason,
  parseDocumentationNavigationRequest,
  buildDocumentationNavigationResult,
  isIndexingProposalEligibleClass,
} from "./documentation-browser.js";

// ─── Indexable HTML manual proposal + consent (Epic #1852, ADR-0113 extension) ──────
export type {
  DocumentationManualSourceKind,
  DocumentationManualProposalState,
  DocumentationManualProposalReason,
  DocumentationManualConfidence,
  DocumentationManualDetection,
  DocumentationManualRobotsPosture,
  DocumentationManualDeniedLinkClass,
  DocumentationManualScopeLimits,
  DocumentationManualScopePreview,
  DocumentationIndexingProposal,
  DocumentationIndexingApproval,
  DocumentationManualProposalRequest,
  DocumentationManualProposalParse,
  DocumentationManualValidation,
} from "./documentation-manual-proposal.js";
export {
  DOCUMENTATION_MANUAL_PROPOSAL_SCHEMA_VERSION,
  DOCUMENTATION_MANUAL_SOURCE_KINDS,
  DOCUMENTATION_MANUAL_PROPOSAL_STATES,
  DOCUMENTATION_MANUAL_PROPOSAL_REASONS,
  DOCUMENTATION_MANUAL_DENIED_LINK_CLASSES,
  DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS,
  isApprovableProposalState,
  detectIndexableManual,
  applyAuthenticationRequiredOverride,
  summarizeManualOrigin,
  summarizeManualPathPrefix,
  buildManualScopePreview,
  findIndexedManualForFingerprint,
  buildDocumentationIndexingProposal,
  asAlreadyIndexedProposal,
  parseManualProposalRequest,
  validateDocumentationIndexingProposal,
  validateDocumentationIndexingApproval,
} from "./documentation-manual-proposal.js";

// ─── HTML Manual Knowledge Pod source (Epic #1853, Issue #1871) ──────────────────────
export type {
  HtmlManualCrawlScope,
  HtmlManualSourceKind,
  HtmlManualSource,
  HtmlManualSourceSummary,
  DeriveHtmlManualSourceInput,
} from "./html-manual-source.js";
export {
  HTML_MANUAL_SOURCE_SCHEMA_VERSION,
  HTML_MANUAL_INCLUDE_GLOBS,
  isSafeManualOrigin,
  isSafeManualPathPrefix,
  validateHtmlManualCrawlScope,
  validateHtmlManualScopeLimits,
  validateHtmlManualSource,
  deriveHtmlManualSource,
  summarizeHtmlManualSource,
  htmlManualLocalFolderScope,
  htmlManualReachableFilesScope,
  htmlManualSourceKindTag,
  htmlManualSourceFingerprintTag,
  parseHtmlManualSourceTagMetadata,
} from "./html-manual-source.js";

// ─── HTML Manual Knowledge Pod refresh change summary (Epic #1856, Issue #1890) ──────
export type {
  ManualRefreshOutcome,
  ManualRefreshRemovalDetection,
  ManualRefreshReasonCode,
  ManualRefreshChangeCounts,
  ManualRefreshChangeSummary,
} from "./html-manual-refresh.js";
export {
  HTML_MANUAL_REFRESH_SCHEMA_VERSION,
  MANUAL_REFRESH_OUTCOMES,
  MANUAL_REFRESH_REMOVAL_DETECTIONS,
  MANUAL_REFRESH_REASON_CODES,
  MANUAL_REFRESH_REASON_GUIDANCE,
  validateManualRefreshChangeSummary,
} from "./html-manual-refresh.js";

// ─── Connected repository context (Issue #178 / Epic #177) ──────────────────────
export type {
  SelectedScopeKind,
  SelectedScope,
  EvidenceLedgerRef,
  EvidenceAtomProvenanceKind,
  EvidenceAtomProvenance,
  EvidenceAtomRedactionState,
  LineRange,
  EvidenceAtom,
  ExplorationBudget,
  ExplorationUsage,
  RetrievalQueryKind,
  RetrievalQuery,
  CandidateOmissionReason,
  CandidateSignal,
  CandidateFile,
  ContextExcerpt,
  ConnectedFileRole,
  ConnectedFileEntry,
  UncertaintyMarkerKind,
  UncertaintyMarker,
  OmittedContextEntry,
  ConnectedContextPack,
  ConnectedContextPackSummary,
  ContextPackDiagnostics,
  RankedCandidateExplanation,
  ConversationAttachmentContextLink,
  ValidationResult,
  IsValidScopePathOptions,
  EvidenceAtomStableIdInput,
  ConnectedContextPackStableIdInput,
} from "./connected-context.js";
export {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  MAX_RANKED_CANDIDATE_DIAGNOSTICS,
  SELECTED_SCOPE_KINDS,
  EVIDENCE_ATOM_PROVENANCE_KINDS,
  EVIDENCE_ATOM_REDACTION_STATES,
  RETRIEVAL_QUERY_KINDS,
  CANDIDATE_OMISSION_REASONS,
  UNCERTAINTY_MARKER_KINDS,
  CONNECTED_FILE_ROLES,
  DEFAULT_EXPLORATION_BUDGET,
  isValidScopePath,
  isValidLineRange,
  isWithinBudget,
  validateSelectedScope,
  validateEvidenceAtom,
  validateRetrievalQuery,
  validateConnectedContextPack,
} from "./connected-context.js";

// ─── Workspace search and replace preview (Epic #2090) ─────────────────────────
export type {
  WorkspaceSearchMode,
  WorkspaceSearchRequest,
  WorkspaceSearchResultMatch,
  WorkspaceSearchResponse,
  WorkspaceSymbolSearchRequest,
  WorkspaceSymbolSearchResult,
  WorkspaceSymbolSearchResponse,
  SymbolDefinitionKind,
  WorkspaceReplacePreviewRequest,
  WorkspaceReplacePreviewTextRange,
  WorkspaceReplacePreviewEdit,
  WorkspaceReplacePreviewFileEdit,
  WorkspaceReplacePreviewResponse,
  WorkspaceReplaceApplyFile,
  WorkspaceReplaceApplyRequest,
  WorkspaceReplaceApplyConflict,
  WorkspaceReplaceApplyResponse,
} from "./workspace-search.js";
export {
  WORKSPACE_REPLACE_MAX_FILES,
  WORKSPACE_SEARCH_MAX_RESULTS,
  WORKSPACE_SEARCH_MODES,
  validateWorkspaceSearchRequest,
  validateWorkspaceSymbolSearchRequest,
  validateWorkspaceReplaceApplyRequest,
  validateWorkspaceReplacePreviewRequest,
  isWorkspaceSearchResultMatch,
  regexSafetyIssue,
} from "./workspace-search.js";

// ─── Deterministic context-engineering layer (ADR-0052, context-engineering milestone) ──
export type {
  ContextLaneId,
  ContextEvictionPolicy,
  ContextBudgetPressure,
  ContextTokenAccountingSource,
  ContextTokenAccounting,
  ContextModelMetadata,
  ContextProfile,
  ContextLaneBudget,
  ContextBudget,
  ContextLane,
  ContextLaneDiagnostics,
  ContextAssemblyDiagnostics,
  ContextCompactionRecord,
  ContextCompactionModelSummary,
  ContextCompactionModelSummaryStatus,
  ContextCompactionModelSummaryValidationState,
  ContextCompactionModelSummaryFailureReason,
  ContextRehydrationHandle,
  ContextProvenanceRefKind,
  ContextProvenanceRef,
  ContextPreservedFact,
  ContextAssumption,
  ContextUserConstraint,
  ContextCommandOutcome,
  ContextInvalidationKey,
} from "./context-engineering.js";
export {
  CONTEXT_ENGINEERING_SCHEMA_VERSION,
  CONTEXT_COMPACTION_MODEL_SUMMARY_MAX_CHARS,
  CONTEXT_COMPACTION_MODEL_SUMMARY_MAX_ITEM_CHARS,
  CONTEXT_COMPACTION_MODEL_SUMMARY_MAX_ITEMS,
  CONTEXT_COMPACTION_MODEL_SUMMARY_STATUSES,
  CONTEXT_COMPACTION_MODEL_SUMMARY_VALIDATION_STATES,
  CONTEXT_COMPACTION_MODEL_SUMMARY_FAILURE_REASONS,
  CONTEXT_COMPACTION_MODEL_SUMMARY_PROMPT_VERSION,
  DEFAULT_TOKEN_ESTIMATOR_ID,
  DEFAULT_CONTEXT_TOKEN_ACCOUNTING,
  CONTEXT_LANE_IDS,
  CONTEXT_EVICTION_POLICIES,
  CONTEXT_TOKEN_ACCOUNTING_SOURCES,
  DEFAULT_CONTEXT_PROFILE,
  estimateTokens,
  estimateTokensForSegments,
  countContextTokens,
  countContextTokensForSegments,
  resolveContextTokenAccounting,
  maxUtf8BytesForTokenBudget,
  deriveContextProfile,
  deriveContextProfileFromCapability,
} from "./context-engineering.js";
export type { ContextValidationResult } from "./context-engineering-validation.js";
export {
  isContextLaneId,
  validateContextProfile,
  validateContextBudget,
  validateContextAssemblyDiagnostics,
} from "./context-engineering-validation.js";
export {
  isContextProvenanceRefKind,
  validateContextProvenanceRef,
  validateContextPreservedFact,
  validateContextAssumption,
  validateContextCommandOutcome,
  validateContextInvalidationKey,
  validateContextCompactionRecord,
  validateContextRehydrationHandle,
} from "./context-engineering-compaction-validation.js";

// ─── Shaped tool observations (ADR-0054, PR3-W1) ────────────────────────────────
export type {
  ShapedStreamExcerpt,
  ShapedCommandObservation,
  ShapedTestCounts,
  ShapedTestObservation,
  ShapedSearchRange,
  ShapedSearchObservation,
  ShapedBrowserObservation,
  ContextToolObservation,
  ContextToolRehydrationHandle,
} from "./context-observations.js";
export {
  MAX_OBSERVATION_EXCERPT_BYTES,
  MAX_FAILING_TEST_NAMES,
  MAX_OBSERVATION_QUERY_BYTES,
  MAX_TOP_RANGES,
  MAX_STACK_FRAME_LINES,
} from "./context-observations.js";
export {
  isContextToolObservationKind,
  validateShapedCommandObservation,
  validateShapedTestObservation,
  validateShapedSearchObservation,
  validateShapedBrowserObservation,
  validateContextToolRehydrationHandle,
  validateContextToolObservation,
} from "./context-observations-validation.js";

// ─── Governed coding-context retrieval (Issue #1211 / Epic #1189, ADR-0042 D6) ──
export type {
  CodingContextPurpose,
  CodingContextSourceKind,
  CodingContextSourceTier,
  CodingContextOmissionReason,
  CodingContextOmission,
  CodingContextCitation,
  CodingContextExcerpt,
  CodingContextPack,
  CodingContextWirePack,
  CodingContextBudget,
  CodingContextScopeKind,
  CodingContextRequest,
  CodingContextValidationResult,
} from "./coding-context.js";
export {
  CODING_CONTEXT_SCHEMA_VERSION,
  CODING_CONTEXT_PURPOSES,
  CODING_CONTEXT_SOURCE_KINDS,
  CODING_CONTEXT_SOURCE_TIERS,
  CODING_CONTEXT_SOURCE_TIER_BY_KIND,
  CODING_CONTEXT_OMISSION_REASONS,
  CODING_CONTEXT_BUDGETS,
  isCodingContextPurpose,
  tierForCodingContextSource,
  embeddingProvidersAllowed,
  isCodingContextCitation,
  toCodingContextWirePack,
  validateCodingContextRequest,
} from "./coding-context.js";

// ─── Workflow handoff & patch-scope (Issue #186 / Epic #177) ────────────────────
// NOTE: `WorkflowKind` and `ValidationResult` are NOT re-exported here because both names
// are already taken by evaluations.ts and connected-context.ts respectively. Import them
// directly from "@oscharko-dev/keiko-contracts/workflow-handoff" when needed (the subpath
// key has no .js suffix).
export type {
  PatchScopeLimits,
  ExpectedCheck,
  PatchScope,
  WorkflowHandoffRequest,
  UserApprovalTokenInput,
  PatchScopeViolationKind,
  PatchScopeViolation,
  PatchScopeCheck,
  ProposedPatchEntry,
} from "./workflow-handoff.js";
export {
  WORKFLOW_HANDOFF_SCHEMA_VERSION,
  DEFAULT_PATCH_SCOPE_LIMITS,
  EXPECTED_CHECKS,
  WORKFLOW_KINDS,
  validatePatchScope,
  validateWorkflowHandoffRequest,
  isApprovalTokenShape,
  checkPatchAgainstScope,
} from "./workflow-handoff.js";

// ─── Local Knowledge Connector (Issue #191 / Epic #189) ─────────────────────────
// KnowledgeSource / KnowledgeCapsule / CapsuleSet are kept structurally distinct: a source is
// the smallest selectable scope, a capsule is a named local KB over one or more sources, a
// CapsuleSet is a logical composed view over multiple capsules (no vector copy). Every
// document-derived record carries capsuleId + sourceId + documentId lineage so retrieval can
// never silently merge sources across capsules.
export type {
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  CapsuleSetId,
  DocumentId,
  ChunkId,
  VectorId,
  EmbeddingVectorMetric,
  EmbeddingVectorNormalization,
  EmbeddingModelIdentity,
  ParserDependencyVersion,
  ParserIdentity,
  KnowledgeSourceScope,
  KnowledgeSourceScopeKind,
  KnowledgeSource,
  CapsuleLifecycleState,
  CapsuleRetrievalEffort,
  CapsuleOutputMode,
  CapsuleAnswerGroundingPolicy,
  CapsuleContextualRetrievalSettings,
  KnowledgeCapsule,
  CapsuleSet,
  ConnectorNodeKind,
  LocalKnowledgeNodeTarget,
  ConnectorNode,
  ConnectorNodeRef,
  ConnectorEdge,
  ConnectorGraphState,
  UpdateCapsulePatch,
  CreateCapsuleSetBody,
} from "./local-knowledge.js";
export {
  CAPSULE_METADATA_MAX_KEYS,
  CAPSULE_METADATA_KEY_MAX_CHARS,
  CAPSULE_METADATA_VALUE_MAX_CHARS,
  CAPSULE_SET_MAX_MEMBERS,
  LOCAL_KNOWLEDGE_SCHEMA_VERSION,
  EMBEDDING_VECTOR_METRICS,
  KNOWLEDGE_SOURCE_SCOPE_KINDS,
  CAPSULE_LIFECYCLE_STATES,
  CAPSULE_RETRIEVAL_EFFORTS,
  CAPSULE_OUTPUT_MODES,
  CAPSULE_ANSWER_GROUNDING_POLICIES,
  CAPSULE_CONTEXTUAL_RETRIEVAL_DOCUMENT_CONTEXT_MAX_CHARS_MAX,
  CAPSULE_CONTEXTUAL_RETRIEVAL_MAX_CONTEXT_CHARS_MAX,
  CONNECTOR_NODE_KINDS,
} from "./local-knowledge.js";
export type {
  DocumentStatus,
  DocumentRecord,
  PageBoundingBox,
  PageRecord,
  SectionRecord,
  ParsedUnit,
  ParsedUnitKind,
  ChunkRecord,
  VectorRecord,
  CitationReference,
  RetrievalReference,
  ParserDiagnosticSeverity,
  ParserDiagnostic,
  ParserResult,
  IndexingJobStatus,
  CapsuleReindexMode,
  CapsuleReindexRequest,
  IndexingJobError,
  IndexingJobRecord,
  CapsuleEmbeddingCompatibilityStatus,
  CapsuleEmbeddingCompatibilityReason,
  CapsuleEmbeddingCompatibility,
  CapsuleContextualRetrievalHealthSource,
  CapsuleContextualRetrievalHealthStatus,
  CapsuleContextualRetrievalHealth,
  CapsuleHealth,
  CapsuleDeleteRequest,
} from "./local-knowledge-records.js";
export {
  DOCUMENT_STATUSES,
  PARSED_UNIT_KINDS,
  PARSER_DIAGNOSTIC_SEVERITIES,
  INDEXING_JOB_STATUSES,
  CAPSULE_REINDEX_MODES,
} from "./local-knowledge-records.js";
export { isSafeScopePath, isSafeStorageReference } from "./local-knowledge-paths.js";
export type {
  ValidationOk as LocalKnowledgeValidationOk,
  ValidationFail as LocalKnowledgeValidationFail,
  LocalKnowledgeValidation,
} from "./local-knowledge-validation.js";
export {
  isSafeDisplaySummary,
  validateEmbeddingModelIdentity,
  validateKnowledgeSourceScope,
  validateKnowledgeCapsule,
  validateCapsuleContextualRetrievalSettings,
  validateCapsuleSet,
  validateCapsuleReindexRequest,
  validateConnectorGraphState,
} from "./local-knowledge-validation.js";
export type {
  EmbeddingProfileCompatibilityDecision,
  EmbeddingProfileCompatibilityReason,
  EmbeddingProfileCompatibilityStatus,
  EmbeddingProfileFromModelOptions,
  EmbeddingProfileIdentity,
  EmbeddingProfileLocality,
  EmbeddingProfilePolicyCapability,
} from "./local-knowledge-embedding-profiles.js";
export {
  EMBEDDING_PROFILE_COMPATIBILITY_REASONS,
  EMBEDDING_PROFILE_COMPATIBILITY_STATUSES,
  EMBEDDING_PROFILE_POLICY_CAPABILITIES,
  EMBEDDING_PROFILE_SCHEMA_VERSION,
  compareEmbeddingProfiles,
  embeddingProfileFromModelIdentity,
  embeddingProfileKey,
  inferEmbeddingModelFamily,
} from "./local-knowledge-embedding-profiles.js";
export type {
  KnowledgePodModelUseOperation,
  KnowledgePodModelUsePolicy,
  KnowledgePodModelUsePolicyDecision,
  KnowledgePodModelUsePolicyMode,
  KnowledgePodModelUsePolicyOperations,
  KnowledgePodModelUsePolicySource,
  KnowledgePodModelUsePolicyResolvedDecision,
  KnowledgePodResolvedModelUsePolicy,
  KnowledgePodResolvedModelUsePolicyOperations,
} from "./local-knowledge-model-use-policy.js";
export {
  KNOWLEDGE_POD_MODEL_USE_OPERATIONS,
  KNOWLEDGE_POD_MODEL_USE_POLICY_DECISIONS,
  KNOWLEDGE_POD_MODEL_USE_POLICY_MODES,
  KNOWLEDGE_POD_MODEL_USE_POLICY_RESOLVED_DECISIONS,
  KNOWLEDGE_POD_MODEL_USE_POLICY_SCHEMA_VERSION,
  isKnowledgePodModelUseOperationAllowed,
  resolveKnowledgePodModelUsePolicy,
  sealedLocalPodModelUsePolicy,
  standardPodModelUsePolicy,
  validateKnowledgePodModelUsePolicy,
} from "./local-knowledge-model-use-policy.js";
export type {
  KnowledgePodBackingKind,
  KnowledgePodCompatibilitySummary,
  KnowledgePodCounts,
  KnowledgePodEvidenceMode,
  KnowledgePodGovernanceSummary,
  KnowledgePodLocationKind,
  KnowledgePodModelUsePolicySummary,
  KnowledgePodPolicyPosture,
  KnowledgePodPrivacySummary,
  KnowledgePodReadiness,
  KnowledgePodRetrievalCapabilities,
  KnowledgePodSealingPosture,
  KnowledgePodSetReadinessReasonCode,
  KnowledgePodSetReadinessSummary,
  KnowledgePodSourceKind,
  KnowledgePodSummary,
  KnowledgePodSummaryKind,
  LocalKnowledgeCapsuleListEntry,
  LocalKnowledgeCapsuleSetListEntry,
  LocalKnowledgeCapsuleSetsResponse,
  LocalKnowledgeCapsulesResponse,
} from "./local-knowledge-pods.js";
export {
  KNOWLEDGE_POD_SET_READINESS_REASON_CODES,
  KNOWLEDGE_POD_SUMMARY_SCHEMA_VERSION,
  isKnowledgePodEvidenceSafeText,
  validateKnowledgePodSummary,
} from "./local-knowledge-pods.js";
export type {
  KnowledgePodRetrievalActivity,
  KnowledgePodRetrievalActivityMode,
  KnowledgePodRetrievalActivityPod,
  KnowledgePodRetrievalActivityPodCounts,
  KnowledgePodRetrievalActivityPrivacy,
  KnowledgePodRetrievalActivityReasonCode,
  KnowledgePodRetrievalActivityState,
  KnowledgePodRetrievalActivitySummary,
} from "./local-knowledge-retrieval-activity.js";
export {
  KNOWLEDGE_POD_RETRIEVAL_ACTIVITY_MODES,
  KNOWLEDGE_POD_RETRIEVAL_ACTIVITY_REASON_CODES,
  KNOWLEDGE_POD_RETRIEVAL_ACTIVITY_SCHEMA_VERSION,
  KNOWLEDGE_POD_RETRIEVAL_ACTIVITY_STATES,
  isKnowledgePodRetrievalActivitySafeText,
  validateKnowledgePodRetrievalActivity,
} from "./local-knowledge-retrieval-activity.js";

// ─── Bounded large-document ingestion (Epic #1160 / Issue #1286) ────────────────
export type {
  LargeDocumentResourcePolicy,
  LargeDocumentExtractionStrategy,
  LargeDocumentPreflightDecision,
  LargeDocumentPreflight,
  ExtractionPhase,
  CoverageQuality,
  ExtractionCapabilityStatus,
  ExtractionCapabilityAvailability,
  LargeDocumentDiagnosticCode,
  CheckpointFingerprint,
  ExtractionCheckpointRecord,
  CheckpointIncompatibilityReason,
  CheckpointCompatibility,
  LargeDocumentJobProgress,
  LargeDocumentResumeChoice,
  CapsuleLargeDocumentHealth,
} from "./local-knowledge-large-document.js";
export {
  DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY,
  largeDocumentPolicyFingerprint,
  LARGE_DOCUMENT_EXTRACTION_STRATEGIES,
  EXTRACTION_PHASES,
  TERMINAL_EXTRACTION_PHASES,
  isTerminalExtractionPhase,
  COVERAGE_QUALITIES,
  EXTRACTION_CAPABILITY_STATUSES,
  DEFAULT_EXTRACTION_CAPABILITY_AVAILABILITY,
  capabilityContributesCoverage,
  LARGE_DOCUMENT_DIAGNOSTIC_CODES,
  CHECKPOINT_INCOMPATIBILITY_REASONS,
  checkpointCompatibility,
  LARGE_DOCUMENT_RESUME_CHOICES,
} from "./local-knowledge-large-document.js";
export {
  validateLargeDocumentResourcePolicy,
  validateExtractionCheckpointRecord,
  isSafeQualityWarning,
} from "./local-knowledge-large-document-validation.js";

// ─── Local Knowledge Capsule persistent schema (Issue #265 / Epic #189) ─────────
// Static SQL DDL manifest + scoped indexes + migration manifest for the on-disk capsule
// store. The runtime that *applies* the DDL ships in #193; this package only carries the
// pure constants and pure helpers (validateCapsuleRowShape, redactPathInDiagnostic) so
// every other package can reference the schema without pulling `node:sqlite`.
export type { KnowledgeCapsuleMigration } from "./local-knowledge-schema.js";
export {
  LOCAL_KNOWLEDGE_DB_SCHEMA_VERSION,
  KNOWLEDGE_CAPSULE_DDL,
  KNOWLEDGE_CAPSULE_INDEXES,
  KNOWLEDGE_CAPSULE_MIGRATIONS,
  KNOWLEDGE_CAPSULE_V1_TABLES,
  KNOWLEDGE_CAPSULE_TABLES,
  KNOWLEDGE_CAPSULE_INDEX_NAMES,
  DELETE_CAPSULE_SQL,
} from "./local-knowledge-schema.js";
export type { CapsuleRowShape, RedactPathOptions } from "./local-knowledge-schema-validation.js";
export {
  validateCapsuleRowShape,
  redactPathInDiagnostic,
} from "./local-knowledge-schema-validation.js";
export type {
  CurrentPdfCitationPreviewSnapshot,
  PdfCitationPreviewAnchorQuality,
  PdfCitationPreviewAuthorizationResponse,
  PdfCitationPreviewAuthorized,
  PdfCitationPreviewCitationStatus,
  PdfCitationPreviewDisplay,
  PdfCitationPreviewFailureState,
  PdfCitationPreviewOpenAuthorized,
  PdfCitationPreviewOpenResponse,
  PdfCitationPreviewOrigin,
  PdfCitationPreviewReasonCode,
  PdfCitationPreviewRejected,
  PdfCitationPreviewSelection,
  PdfCitationPreviewSessionMetadata,
  PdfCitationPreviewStatusRequest,
  PdfCitationPreviewStatusResponse,
  PdfCitationPreviewStatusState,
  StoredPdfCitationPreviewCitation,
  StoredPdfCitationPreviewLineage,
} from "./local-knowledge-preview.js";
export {
  PDF_CITATION_PREVIEW_ANCHOR_QUALITIES,
  PDF_CITATION_PREVIEW_FAILURE_STATES,
  PDF_CITATION_PREVIEW_ORIGINS,
  PDF_CITATION_PREVIEW_REASON_CODES,
  PDF_CITATION_PREVIEW_STATUS_STATES,
  normalizePdfCitationPreviewMarkerIndex,
  pdfCitationPreviewAnchorQuality,
  pdfCitationPreviewFailureState,
} from "./local-knowledge-preview.js";

// ─── Governed Enterprise Memory Vault (Issue #205 / Epic #204) ──────────────────
// Pure contract surface for durable, scoped, governed memory: scopes, sensitivity,
// status lifecycle, provenance, validity intervals, edges, operation envelopes, and
// pure validators. Storage (#206), capture (#207), consolidation (#208), conflict and
// forget (#209), retrieval (#210), MemoriaViva UI (#211), Conversation Center
// integration (#212), workflow integration (#213), audit (#214), evaluation (#215),
// and final verification (#216) all pin against `MEMORY_SCHEMA_VERSION` and the types
// re-exported here. A breaking change to the contract introduces a NEW literal member
// rather than mutating the existing "1" — the same evolution rule as
// `CONNECTED_CONTEXT_SCHEMA_VERSION` and `LOCAL_KNOWLEDGE_SCHEMA_VERSION`.
export type {
  ConversationId as MemoryConversationId,
  EvidenceManifestId as MemoryEvidenceManifestId,
  MemoryAcceptance,
  MemoryArchive,
  MemoryAuditAction,
  MemoryAuditActionKind,
  MemoryAuditEvent,
  MemoryAuditEventKind,
  MemoryAuditInitiatorSurface,
  MemoryAuditRecord,
  MemoryAuditRecordId,
  MemoryEdge,
  MemoryEdgeId,
  MemoryEdgeKind,
  MemoryForget,
  MemoryForgetReason,
  MemoryId,
  MemoryModelIdentity,
  MemoryPin,
  MemoryProposal,
  MemoryProposalId,
  MemoryProvenance,
  MemoryRecord,
  MemoryRejection,
  MemoryRetentionHint,
  MemoryRetrievalRequest,
  MemoryReviewerId,
  MemoryScope,
  MemoryScopeKind,
  MemorySensitivity,
  MemorySourceKind,
  MemoryStatus,
  MemoryStructuredPayload,
  MemoryStructuredPayloadKind,
  MemorySupersession,
  MemoryType,
  MemoryUnpin,
  MemoryUpdate,
  MemoryUpdateField,
  MemoryValidation,
  MemoryValidationFail,
  MemoryValidationOk,
  MemoryValidityInterval,
  ProjectId as MemoryProjectId,
  StaleModelMetadataInput,
  StatusTransitionCheck,
  UserId as MemoryUserId,
  WorkflowDefinitionId as MemoryWorkflowDefinitionId,
  WorkflowRunId as MemoryWorkflowRunId,
  WorkspaceId as MemoryWorkspaceId,
} from "./memory-barrel.js";
export {
  MEMORY_AUDIT_ACTION_KINDS,
  MEMORY_AUDIT_EVENT_KINDS,
  MEMORY_AUDIT_EVENT_SCHEMA_VERSION,
  MEMORY_AUDIT_EVENT_SUMMARY_MAX_CHARS,
  MEMORY_AUDIT_INITIATOR_SURFACES,
  MEMORY_EDGE_KINDS,
  MEMORY_FORGET_REASON_EVICT_OVERFLOW,
  MEMORY_FORGET_REASON_EXPIRE_AGE,
  MEMORY_FORGET_REASON_EXPIRE_PROPOSAL,
  MEMORY_FORGET_REASON_EXPLICIT_USER_REQUEST,
  MEMORY_FORGET_REASON_PROPOSED_FAINT_AGED_OUT,
  MEMORY_FORGET_REASON_USER_REQUEST,
  MEMORY_FORGET_REASON_VALIDITY_EXPIRED,
  MEMORY_FORGET_REASONS,
  MEMORY_SCHEMA_VERSION,
  MEMORY_SCOPE_KINDS,
  MEMORY_SENSITIVITIES,
  MEMORY_SOURCE_KINDS,
  MEMORY_STATUSES,
  MEMORY_STATUS_TRANSITIONS,
  MEMORY_STRUCTURED_PAYLOAD_KINDS,
  MEMORY_TYPES,
  MEMORY_TYPE_DECAY_HALF_LIFE_MULTIPLIERS,
  MEMORY_UPDATE_FIELDS,
  assertNeverMemoryType,
  decayHalfLifeMultiplierForType,
  checkStatusTransition,
  hasStaleModelMetadata,
  isMemoryEdge,
  isMemoryRecord,
  isScopeReachable,
  looksLikeSecretShape,
  validateMemoryAcceptance,
  validateMemoryArchive,
  validateMemoryAuditRecord,
  validateMemoryEdge,
  validateMemoryForget,
  validateMemoryPin,
  validateMemoryProposal,
  validateMemoryProvenance,
  validateMemoryRecord,
  validateMemoryRejection,
  validateMemoryRetrievalRequest,
  validateMemoryScope,
  validateMemoryStructuredPayload,
  validateMemorySupersession,
  validateMemoryUnpin,
  validateMemoryUpdate,
  validateMemoryValidityInterval,
} from "./memory-barrel.js";

export type {
  MemoryConsolidationJobStateWire,
  MemoryConsolidationStaleReasonWire,
  MemoryConsolidationStaleFlagWire,
  MemoryConsolidationReviewReasonWire,
  MemoryConsolidationProposedActionWire,
  MemoryConsolidationEvidenceKindWire,
  MemoryConsolidationEvidenceWire,
  MemoryConsolidationReviewItemWire,
  MemoryConsolidationSuggestedResolutionWire,
  MemoryConsolidationSummaryStatusWire,
  MemoryConsolidationResultWire,
  MemoryConsolidationJobWire,
  MemoryConsolidationJobSelectionWire,
  MemoryConsolidationJobSettingsWire,
  MemoryConsolidationJobEnvelopeWire,
  MemoryConsolidationJobResponseWire,
} from "./memory-consolidation-wire.js";

export type {
  MemoryHealthScanFindingKindWire,
  MemoryHealthScanMemoryRefWire,
  MemoryHealthScanFindingWire,
  MemoryHealthScanResultWire,
} from "./memory-health-scan-wire.js";
export {
  MEMORY_HEALTH_SCAN_REASON_MAX_CHARS,
  MEMORY_HEALTH_SCAN_FINDING_KINDS,
} from "./memory-health-scan-wire.js";

// ─── Workflow memory port (Issue #213 / Epic #204) ──────────────────────────────
// Optional read-only port that workflow packages compose with to inject scoped memory
// context before model invocation and emit memory lifecycle events. Memory cannot grant
// write/execution authority — existing tool gates remain the sole apply surface.
export type {
  MemoryOmittedEvent,
  MemoryUsedEvent,
  MemoryWorkflowContext,
  MemoryWorkflowPort,
  MemoryWriteCandidateEvent,
} from "./memory-workflow-port.js";

// ─── Quality Intelligence (Issue #277 / Epic #270) ─────────────────────────────
// QI surface is re-exported under a single namespace because the QI vocabulary
// (RunId, TestCaseId, finding kinds, etc.) collides with names already used by
// gateway/workflow/audit modules above. Consumers reach the QI types via
// `import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";` and then
// `QualityIntelligence.QualityIntelligenceRunEvent`.
// The schema version literal follows the same evolution rule as
// LOCAL_KNOWLEDGE_SCHEMA_VERSION / MEMORY_SCHEMA_VERSION: a breaking change adds a
// new literal member instead of mutating the existing one.
export * as QualityIntelligence from "./qualityIntelligence/index.js";
// Issue #280 introduced flat BFF wire-type re-exports for the UI consumers.
export type {
  QualityIntelligenceUiEvidenceRef,
  QualityIntelligenceUiFindingSummary,
  QualityIntelligenceUiRunDetail,
  QualityIntelligenceUiAtomCoverage,
  QualityIntelligenceUiRunListResponse,
  QualityIntelligenceUiRunSummary,
  QualityIntelligenceUiRunTotals,
  QualityIntelligenceUiCandidate,
  QualityIntelligenceUiWeakTestFlag,
  QualityIntelligenceUiDriftMetadata,
  QualityIntelligenceQualityDiagnostics,
  QualityIntelligenceUiStalenessEntry,
  QualityIntelligenceUiStalenessReport,
  QualityIntelligenceUiRegenerateResult,
  QualityIntelligenceInlineSource,
  QualityIntelligenceInlineSourceKind,
  QualityIntelligenceRequirementsSource,
  QualityIntelligenceWorkspaceSource,
  QualityIntelligenceFileSource,
  QualityIntelligenceCapsuleSource,
  QualityIntelligenceCapsuleSetSource,
  QualityIntelligenceFigmaSnapshotSource,
  QualityIntelligenceImageSource,
  QualityIntelligenceModelPolicy,
  QualityIntelligenceResolvedModelPolicy,
  QualityIntelligenceModelPolicyValidationIssueCode,
  QualityIntelligenceModelPolicyValidationIssue,
  QualityIntelligenceModelPolicyValidation,
  QualityIntelligenceModelPreflightStatus,
  QualityIntelligenceModelPreflightErrorCategory,
  QualityIntelligenceModelPreflightStageResult,
  QualityIntelligenceModelPreflightSummary,
  QualityIntelligenceModelStageFailure,
  QualityIntelligenceModelRouting,
  QualityIntelligenceModelPolicyResponse,
  QualityIntelligenceModelPolicyPreflightRequest,
  QualityIntelligenceModelPolicyPreflightResponse,
  QualityIntelligenceStartRunRequest,
  QualityIntelligenceSkippedSource,
  QualityIntelligenceSourceSummary,
  QualityIntelligenceRunStreamAccepted,
  QualityIntelligenceRunStreamEvent,
  QualityIntelligenceRunStreamDone,
  QualityIntelligenceRunStreamError,
  QualityIntelligenceRunStreamMessage,
} from "./qualityIntelligence/bffWire.js";
// Issue #283 added flat export-adapter consumers.
export type {
  QualityIntelligenceExportAdapter,
  QualityIntelligenceExportBundle,
  QualityIntelligenceExportBundleEntry,
  QualityIntelligenceTestCaseCandidate,
  QualityIntelligenceReviewState,
  QualityIntelligenceReviewAction,
  QualityIntelligenceRunStatus,
  QualityIntelligencePriority,
  QualityIntelligenceRiskClass,
  QualityIntelligenceTestCaseStatus,
} from "./qualityIntelligence/index.js";
// Shared QI status/terminal/projection helpers (GEN-DUP-SEMANTIC-008/-009/-010).
export {
  QUALITY_INTELLIGENCE_RUN_STATUSES,
  QUALITY_INTELLIGENCE_TERMINAL_REVIEW_STATES,
  QUALITY_INTELLIGENCE_REVIEW_ACTION_TARGET,
  isTerminalReviewState,
  reviewActionResultState,
} from "./qualityIntelligence/index.js";
// Epic #736 (Issue #746) added the test-quality rubric judge contracts as flat re-exports.
export type {
  TestQualityDimensionName,
  TestQualityRubricDimension,
  TestQualityJudgeVerdict,
} from "./qualityIntelligence/index.js";
export {
  TEST_QUALITY_RUBRIC_DIMENSIONS,
  TEST_QUALITY_JUDGE_RESPONSE_SCHEMA,
} from "./qualityIntelligence/index.js";
export {
  assertExportBundleInvariant,
  QUALITY_INTELLIGENCE_EXPORT_ADAPTERS,
  QUALITY_INTELLIGENCE_TMS_ADAPTERS,
} from "./qualityIntelligence/index.js";
// Issue #725 (Epic #712) added inline-edit revision contracts.
export type {
  QualityIntelligenceCandidateEditProvenance,
  QualityIntelligenceCandidateEditableFields,
  QualityIntelligenceCandidateEditedRevision,
} from "./qualityIntelligence/editableRevision.js";

// ─── Workspace UI interaction substrate (Epic #518 / Issue #527; ADR-0028) ──
// Typed Command + Action + KeyChord contracts consumed by @oscharko-dev/keiko-ui.
// The WorkspaceUiAction discriminated union declares constructors only for
// ui.* state mutations; there is no constructor for evidence/patch/
// verification/model-call/tool/memory/fs/durable-config kinds — the
// compile-time refusal that makes ADR-0028's undo boundary load-bearing.
export type {
  WorkspaceUiRect,
  WorkspaceUiView,
  WorkspaceUiSelectionState,
  WorkspaceCommandAuthority,
  WorkspaceCommandCategory,
  WorkspaceKeyChord,
  WorkspaceKeyChordModifier,
  WorkspaceCommandContext,
  WorkspaceCommand,
  WorkspaceUiWindowSnapshot,
  WorkspaceUiAction,
  WorkspaceUiActionKind,
  WorkspaceUndoStackApi,
  WorkspaceKeyboardShortcutBinding,
  WorkspaceKeyboardShortcutConflict,
} from "./workspace-ui.js";
export {
  WORKSPACE_RESERVED_CHORDS,
  workspaceActionLabel,
  workspaceChordKey,
  workspaceChordsEqual,
  isWorkspaceReservedChord,
  workspaceInverseAction,
} from "./workspace-ui.js";

// ─── Workspace object descriptor metadata (Epic #518 / Issue #528; ADR-0029) ──
// Closed-set enums and the registration-time validator for workspace object
// descriptor metadata. The four fields (lifecycle, trustBoundary, authority,
// persistence) are declared per WindowType in a sidecar table in
// @oscharko-dev/keiko-ui; the validator below catches inconsistent
// trust/authority/persistence declarations at module evaluation in dev/test
// and is asserted by a unit test in production builds.
export type {
  WorkspaceObjectLifecycleState,
  WorkspaceObjectTrustBoundary,
  WorkspaceObjectAuthority,
  WorkspaceObjectPersistence,
  WorkspaceDescriptorMeta,
  WorkspaceDescriptorValidationError,
} from "./workspace-descriptors.js";
export {
  WORKSPACE_LIFECYCLE_STATES,
  WORKSPACE_TRUST_BOUNDARIES,
  WORKSPACE_AUTHORITY_REQUIREMENTS,
  WORKSPACE_PERSISTENCE_EXPECTATIONS,
  validateWorkspaceDescriptorMeta,
} from "./workspace-descriptors.js";

// ─── Relationship engine (Epic #532 / Issue #538) ───────────────────────────────
// Versioned contracts for the cross-domain relationship engine. Pure types + frozen
// constant tables; the deterministic validator lives in `relationships-validation.ts`
// and is pure (no IO, no clock, no random). Storage / API composition lands in #539;
// inspector + graph in #540; impact + health in #542.
export type {
  ObjectReference,
  Relationship,
  RelationshipActivityState,
  RelationshipCardinality,
  RelationshipCardinalityCounts,
  RelationshipDenialCode,
  RelationshipDirection,
  RelationshipEndpointResolverResult,
  RelationshipEndpointStatus,
  RelationshipEvidenceRelevance,
  RelationshipForbiddenMetadataKeySubstring,
  RelationshipLifecycleState,
  RelationshipObjectKind,
  RelationshipSupportedObjectKind,
  RelationshipType,
  RelationshipTypeDefinition,
  RelationshipTypeLifecycleFlags,
  RelationshipValidationContext,
  RelationshipValidationError,
} from "./relationships.js";
export {
  RELATIONSHIP_ACTIVITY_STATES,
  RELATIONSHIP_DENIAL_CODES,
  RELATIONSHIP_FORBIDDEN_METADATA_KEY_SUBSTRINGS,
  RELATIONSHIP_LIFECYCLE_STATES,
  RELATIONSHIP_OBJECT_KINDS,
  RELATIONSHIP_SCHEMA_VERSION,
  RELATIONSHIP_SUPPORTED_OBJECT_KINDS,
  RELATIONSHIP_TYPE_DEFINITIONS,
  RELATIONSHIP_TYPES,
} from "./relationships.js";
export type {
  ValidationOk as RelationshipValidationOk,
  ValidationFail as RelationshipValidationFail,
  RelationshipValidation,
} from "./relationships-validation.js";
export {
  assertRelationshipTypeAllowsKinds,
  validateRelationship,
} from "./relationships-validation.js";

// ─── Prompt Enhancer (Epic #1307 / Issue #1309) ─────────────────────────────────
// Wire-safe contracts, task taxonomy (≥10 classes), generation-profile metadata, and the
// deterministic analyzer-result shape, plus the pure deterministic `analyzePrompt` and the pure
// Ok|Fail validators. Provider-neutral by construction (no credentials, hidden prompts, or tool
// authority — ADR-0044 §5). Governed by ADR-0044 and the prompt-enhancer architecture blueprint.
export type {
  PromptEnhancementRequestId,
  EnhancedPromptId,
  PromptTaskClass,
  PromptDomain,
  PromptCriticality,
  PromptRiskClass,
  GroundingNeedKind,
  GroundingSignal,
  GroundingNeed,
  GroundingStrategy,
  RetrievalMode,
  GroundingSourceKind,
  GroundingSourcePolicy,
  CitationDiscipline,
  CitationGranularity,
  CitationRequirement,
  RecencyExpectation,
  ContradictionPolicy,
  NoAnswerCondition,
  GroundingDirective,
  RagEvaluationDimension,
  RagEvaluationHint,
  GroundingPlan,
  OutputFormat,
  OutputFormatHint,
  OutputSchemaDescriptor,
  MissingContextTopic,
  PromptClarification,
  PromptAssumption,
  ClarificationOrAssumption,
  MissingInformationStrategy,
  PromptSignalStrength,
  PromptSignalDimension,
  PromptClassificationSignal,
  PromptEnhancementProfileId,
  PromptEnhancementProfile,
  RawPromptInput,
  PromptEnhancementRequest,
  PromptTaskAnalysis,
  EnhancedPrompt,
} from "./prompt-enhancer.js";
export {
  PROMPT_ENHANCER_SCHEMA_VERSION,
  PROMPT_ANALYSIS_MAX_SCAN_CHARS,
  PROMPT_MISSING_CONTEXT_MAX_CHARS,
  PROMPT_TASK_CLASSES,
  PROMPT_DOMAINS,
  SAFETY_CRITICAL_DOMAINS,
  PROMPT_CRITICALITIES,
  PROMPT_RISK_CLASSES,
  GROUNDING_NEED_KINDS,
  GROUNDING_SIGNALS,
  GROUNDING_STRATEGIES,
  RETRIEVAL_MODES,
  GROUNDING_SOURCE_KINDS,
  CITATION_DISCIPLINES,
  CITATION_GRANULARITIES,
  CONTRADICTION_POLICIES,
  NO_ANSWER_CONDITIONS,
  GROUNDING_DIRECTIVES,
  RAG_EVALUATION_DIMENSIONS,
  PROMPT_OUTPUT_FORMATS,
  OUTPUT_FORMAT_HINTS,
  MISSING_CONTEXT_TOPICS,
  MISSING_INFORMATION_STRATEGIES,
  PROMPT_SIGNAL_STRENGTHS,
  PROMPT_SIGNAL_DIMENSIONS,
  PROMPT_ENHANCEMENT_PROFILE_IDS,
  PROMPT_ENHANCEMENT_PROFILES,
  isSafetyCriticalDomain,
  asPromptEnhancementRequestId,
  asEnhancedPromptId,
  validatePromptEnhancerIdString,
  assertNeverTaskClass,
  normalizePromptDraft,
} from "./prompt-enhancer.js";
export { analyzePrompt } from "./prompt-enhancer-analyzer.js";
export { planGrounding } from "./prompt-enhancer-grounding.js";
export type { PlanGroundingOptions } from "./prompt-enhancer-grounding.js";
export type {
  ValidationOk as PromptEnhancerValidationOk,
  ValidationFail as PromptEnhancerValidationFail,
  PromptEnhancerValidation,
} from "./prompt-enhancer-validation.js";
export {
  PROMPT_REQUEST_TEXT_MAX_CHARS,
  validatePromptEnhancementRequest,
  validatePromptTaskAnalysis,
  validateEnhancedPrompt,
  validateGroundingPlan,
  validatePromptCandidateScorecard,
  validatePromptCandidateSelection,
} from "./prompt-enhancer-validation.js";
// Prompt Enhancer candidate-critic contract surface (#1312; ADR-0044 §6).
export type {
  PromptCriticDimension,
  PromptCriticDimensionScore,
  PromptCandidateScorecard,
  PromptCandidateRejection,
  PromptCandidateRejectionReason,
  PromptOptimizationBounds,
  PromptCandidateSelection,
} from "./prompt-enhancer-critic.js";
export {
  PROMPT_CRITIC_DIMENSIONS,
  PROMPT_CANDIDATE_REJECTION_REASONS,
  isPromptCriticDimension,
  isPromptCandidateRejectionReason,
} from "./prompt-enhancer-critic.js";
// Prompt Enhancer safety annotations + validate-stage rule model (#1313; ADR-0044 §4/§5/§7).
export type {
  PromptSafetyRuleId,
  PromptSafetyViolationCode,
  PromptSafetySeverity,
  LeastPrivilegeConstraint,
  PromptSafetyDecision,
  PromptSafetyVerificationStatus,
  PromptSafetyFinding,
  PromptSafetyAssessment,
} from "./prompt-enhancer-safety.js";
export {
  PROMPT_SAFETY_RULE_IDS,
  PROMPT_SAFETY_VIOLATION_CODES,
  PROMPT_SAFETY_SEVERITIES,
  LEAST_PRIVILEGE_CONSTRAINTS,
  PROMPT_SAFETY_DECISIONS,
  PROMPT_SAFETY_VERIFICATION_STATUSES,
  PROMPT_SAFETY_VIOLATION_DETAILS,
  isPromptSafetyViolationCode,
  requiresHumanReviewForAnalysis,
  leastPrivilegeForAnalysis,
  summarizePromptSafety,
  assessEnhancedPromptStructuralSafety,
  validatePromptSafetyAssessment,
} from "./prompt-enhancer-safety.js";
// Prompt Enhancer BFF wire surface (#1314; ADR-0044 §1 "BFF /api/prompt-enhancer/* routes"). The
// request/response envelope the governed API, CLI, and UI surfaces exchange, plus the pure request
// validator. Also re-exported from `./bff-wire.js` for the `@oscharko-dev/keiko-contracts/bff-wire`
// subpath the UI imports.
export type {
  PromptEnhancementWireRequest,
  PromptEnhancementModelAvailability,
  PromptEnhancementModelRoutingReason,
  PromptEnhancementExecutionStatus,
  PromptEnhancementModelFallbackReason,
  PromptEnhancementModelRouting,
  PromptEnhancementCandidateComparison,
  PromptEnhancementGroundingReadiness,
  PromptEnhancementGroundingReadinessStatus,
  PromptEnhancementGroundingReadinessReason,
  PromptEnhancementEvidenceReference,
  PromptEnhancementWireResponse,
} from "./prompt-enhancer-bff.js";
export {
  PROMPT_ENHANCEMENT_LOCALE_MAX_CHARS,
  PROMPT_ENHANCEMENT_MODEL_ID_MAX_CHARS,
  PROMPT_ENHANCEMENT_DEFAULT_CANDIDATE_COUNT,
  PROMPT_ENHANCEMENT_MAX_CANDIDATE_COUNT,
  PROMPT_ENHANCEMENT_MODEL_AVAILABILITIES,
  validatePromptEnhancementWireRequest,
} from "./prompt-enhancer-bff.js";

// ─── Governed Git delivery contracts (Issue #471, Epic #470; ADR-0058) ───────────
// The core atom git-delivery.ts owns action kinds, risk taxonomy, the lifecycle envelope, the
// typed constraint union, the policy decision, provider capability, and the shared parse result.
// git-delivery-policy.ts owns the policy packs + the deterministic evaluator. git-delivery-provider.ts
// owns the provider-neutral interfaces. Each symbol is re-exported from whichever file owns it.

// git-delivery.ts
export type {
  GitDeliveryActionKind,
  GitDeliveryRiskClass,
  GitDeliveryMergeStrategyHint,
  GitDeliveryAbortableOperation,
  GitDeliveryRecoveryStrategyHint,
  GitDeliveryProviderCapability,
  GitDeliveryBranchMatchKind,
  GitDeliveryBranchPattern,
  GitDeliveryBranchPatternConstraint,
  GitDeliveryProviderCapabilityConstraint,
  GitDeliveryRiskClassCeilingConstraint,
  GitDeliveryConstraint,
  GitDeliveryBlockReason,
  GitDeliveryMergeBlockReason,
  GitDeliveryExecutionOutcome,
  GitDeliveryExecutionErrorCode,
  GitDeliveryPartialDetail,
  GitDeliveryBranchCreateInputs,
  GitDeliveryStageInputs,
  GitDeliveryUnstageInputs,
  GitDeliveryCommitInputs,
  GitDeliveryPushInputs,
  GitDeliveryPrCreateInputs,
  GitDeliveryPrUpdateInputs,
  GitDeliveryMergeInputs,
  GitDeliveryAbortInputs,
  GitDeliveryRecoveryInputs,
  GitDeliveryResolvedInputs,
  GitDeliveryApprovalNotRequired,
  GitDeliveryApprovalGranted,
  GitDeliveryApprovalRequirement,
  GitDeliveryApprovalClaim,
  GitDeliveryApprovalRequest,
  GitDeliveryPolicyDecision,
  GitDeliveryActionPreview,
  GitDeliveryExecutionResult,
  GitDeliveryEvidenceRef,
  GitDeliveryActionEnvelopeFor,
  GitDeliveryActionEnvelope,
  GitDeliveryParseResult,
} from "./git-delivery.js";
export {
  GIT_DELIVERY_SCHEMA_VERSION,
  GIT_DELIVERY_ACTION_KINDS,
  GIT_DELIVERY_RISK_CLASSES,
  GIT_DELIVERY_RISK_CLASS_SEVERITY,
  GIT_DELIVERY_ACTION_RISK_DEFAULTS,
  GIT_DELIVERY_MERGE_STRATEGY_HINTS,
  GIT_DELIVERY_ABORTABLE_OPERATIONS,
  GIT_DELIVERY_RECOVERY_STRATEGY_HINTS,
  GIT_DELIVERY_PROVIDER_CAPABILITIES,
  GIT_DELIVERY_BRANCH_MATCH_KINDS,
  GIT_DELIVERY_EXECUTION_OUTCOMES,
  GIT_DELIVERY_EXECUTION_ERROR_CODES,
  GIT_DELIVERY_BLOCK_REASONS,
  GIT_DELIVERY_MERGE_BLOCK_REASONS,
  isGitDeliveryActionKind,
  isGitDeliveryRiskClass,
  isGitDeliveryProviderCapability,
  isGitDeliveryBranchMatchKind,
  isGitDeliveryBranchPattern,
  isGitDeliveryConstraint,
  isGitDeliveryBlockReason,
  isGitDeliveryMergeBlockReason,
  isGitDeliveryMergeStrategyHint,
  isGitDeliveryAbortableOperation,
  isGitDeliveryRecoveryStrategyHint,
  isGitDeliveryExecutionOutcome,
  isGitDeliveryExecutionErrorCode,
  isGitDeliveryApprovalRequirement,
  isGitDeliveryApprovalClaim,
  isGitDeliveryPolicyDecision,
  isGitDeliveryEvidenceRef,
  isGitDeliveryExecutionResult,
  parseGitDeliveryResolvedInputs,
  parseGitDeliveryActionEnvelope,
  gitDeliveryDefaultRiskClass,
  gitDeliveryRiskClassForInputs,
  gitDeliveryRiskClassWithinCeiling,
  gitDeliveryBranchNameMatchesPattern,
  gitDeliveryBranchNameMatchesAny,
} from "./git-delivery.js";

// git-delivery-policy.ts
export type {
  GitDeliveryRuleDecision,
  GitDeliveryPolicyRule,
  GitDeliveryDefaultRule,
  GitDeliveryRepoPolicyPack,
  GitDeliveryOrgPolicyPack,
  GitDeliveryPolicyContext,
} from "./git-delivery-policy.js";
export {
  GIT_DELIVERY_POLICY_SCHEMA_VERSION,
  GIT_DELIVERY_RULE_DECISIONS,
  isGitDeliveryPolicyRule,
  evaluateGitPolicy,
  parseGitPolicyPack,
  parseGitRepoPolicyPack,
  parseGitOrgPolicyPack,
} from "./git-delivery-policy.js";

// git-delivery-provider.ts
export type {
  GitDeliveryChecksOverallStatus,
  GitDeliveryPullRequestStatus,
  GitDeliveryBranchProtection,
  GitDeliveryChecksState,
  GitDeliveryMergeReadiness,
  GitDeliveryPullRequestState,
  GitDeliveryRemoteTargetPolicy,
  GitDeliveryProviderDescriptor,
} from "./git-delivery-provider.js";
export {
  GIT_DELIVERY_PROVIDER_SCHEMA_VERSION,
  GIT_DELIVERY_CHECKS_OVERALL_STATUSES,
  GIT_DELIVERY_PULL_REQUEST_STATUSES,
  isGitDeliveryChecksOverallStatus,
  isGitDeliveryPullRequestStatus,
  isGitDeliveryBranchProtection,
  isGitDeliveryChecksState,
  isGitDeliveryMergeReadiness,
  isGitDeliveryPullRequestState,
  isGitDeliveryProviderDescriptor,
  isGitDeliveryRemoteTargetPolicy,
} from "./git-delivery-provider.js";

// git-delivery-action-sheet.ts (Issue #473, Epic #470; ADR-0060)
// UI-safe approval/preview projection: action-sheet state, approval summary, preview manifest,
// blocked-cause classification, and recovery hints over the content-free contract facts.
export type {
  GitDeliveryActionSheetState,
  GitDeliveryApprovalNecessity,
  GitDeliveryBlockedCause,
  GitDeliveryBlockerSource,
  GitDeliveryBlockerSeverity,
  GitDeliveryRemediationClass,
  GitDeliveryExpectedBlocker,
  GitDeliveryRecoveryActionHint,
  GitDeliveryRecoveryHint,
  GitDeliveryApprovalSummary,
  GitDeliveryPolicyExplanation,
  GitDeliveryPreviewManifest,
  GitDeliveryBlockedDetail,
  GitDeliveryActionSheet,
  GitDeliveryActionSheetInput,
  GitDeliveryPreviewManifestInput,
  GitDeliveryActionSheetStateInput,
  GitDeliveryWorktreeSnapshot,
  GitDeliveryActionSheetProviderState,
  GitDeliveryActionSheetRequest,
} from "./git-delivery-action-sheet.js";
export {
  GIT_DELIVERY_ACTION_SHEET_SCHEMA_VERSION,
  GIT_DELIVERY_ACTION_SHEET_STATES,
  GIT_DELIVERY_APPROVAL_NECESSITIES,
  GIT_DELIVERY_BLOCKED_CAUSES,
  GIT_DELIVERY_BLOCKER_SOURCES,
  GIT_DELIVERY_BLOCKER_SEVERITIES,
  GIT_DELIVERY_REMEDIATION_CLASSES,
  GIT_DELIVERY_RECOVERY_ACTION_HINTS,
  GIT_DELIVERY_POLICY_DECISION_OUTCOMES,
  isGitDeliveryPolicyDecisionOutcome,
  isGitDeliveryActionSheetState,
  isGitDeliveryApprovalNecessity,
  isGitDeliveryBlockedCause,
  isGitDeliveryBlockerSource,
  isGitDeliveryBlockerSeverity,
  isGitDeliveryRemediationClass,
  isGitDeliveryRecoveryActionHint,
  isGitDeliveryExpectedBlocker,
  isGitDeliveryRecoveryHint,
  isGitDeliveryApprovalSummary,
  isGitDeliveryPolicyExplanation,
  isGitDeliveryPreviewManifest,
  isGitDeliveryBlockedDetail,
  isGitDeliveryActionSheet,
  parseGitDeliveryActionSheet,
  buildGitDeliveryPreviewManifest,
  gitDeliveryApprovalNecessityForDecision,
  gitDeliveryActionSheetStateFor,
  gitDeliveryBlockedCauseFor,
  gitDeliverySuggestedRecoveryStrategy,
  buildGitDeliveryActionSheet,
} from "./git-delivery-action-sheet.js";

// git-delivery-evidence.ts (Issue #474, Epic #470; ADR-0061)
// The retrospective, content-free audit record produced for every governed Git mutation attempt,
// the exportable audit packet, the AC1 outcome-class vocabulary, the AC3 three-way recovery
// disposition, and the deterministic recovery-disposition derivations.
export type {
  GitDeliveryEvidenceOutcomeClass,
  GitDeliveryRecoveryDisposition,
  GitDeliveryEvidenceLifecyclePhase,
  GitDeliveryRecoveryMetadata,
  GitDeliveryEvidenceCorrelation,
  GitDeliveryEvidenceApproval,
  GitDeliveryEvidencePreviewSummary,
  GitDeliveryEvidenceExecution,
  GitDeliveryEvidenceRepoContext,
  GitDeliveryEvidenceRecord,
  GitDeliveryAuditPacket,
} from "./git-delivery-evidence.js";
export {
  GIT_DELIVERY_EVIDENCE_SCHEMA_VERSION,
  GIT_DELIVERY_EVIDENCE_OUTCOME_CLASSES,
  GIT_DELIVERY_RECOVERY_DISPOSITIONS,
  GIT_DELIVERY_EVIDENCE_LIFECYCLE_PHASES,
  isGitDeliveryEvidenceOutcomeClass,
  isGitDeliveryRecoveryDisposition,
  isGitDeliveryEvidenceLifecyclePhase,
  isGitDeliveryRecoveryMetadata,
  isGitDeliveryEvidenceRecord,
  isGitDeliveryAuditPacket,
  gitDeliveryRecoveryDispositionForExecutionError,
  gitDeliveryRecoveryDispositionForBlockReason,
  buildGitDeliveryAuditPacket,
  GIT_DELIVERY_AUDIT_PACKET_KNOWN_LIMITATIONS,
} from "./git-delivery-evidence.js";

// git-commit-policy.ts (Issue #475, Epic #470; ADR-0062)
// The deterministic, content-free commit-message-policy validator: a server-resolved policy shape
// (conventional-commit, issue-key, sign-off, subject-length) and a pure validator returning typed
// violation codes only — never any fragment of the message.
export type {
  GitCommitConventionalCommitRule,
  GitCommitIssueKeyRule,
  GitCommitMessagePolicy,
  GitCommitMessageViolationCode,
  GitCommitMessageValidation,
} from "./git-commit-policy.js";
export {
  GIT_COMMIT_POLICY_SCHEMA_VERSION,
  GIT_COMMIT_MESSAGE_VIOLATION_CODES,
  KEIKO_DEFAULT_COMMIT_MESSAGE_POLICY,
  validateGitCommitMessage,
  isGitCommitMessageViolationCode,
  isGitCommitMessagePolicy,
  isGitCommitMessageValidation,
} from "./git-commit-policy.js";

// git-commit-intent.ts (Issue #475, Epic #470; ADR-0062)
// The deterministic commit-intent heuristics: a content-free staged-change summary, the quality
// warning vocabulary, and a pure analyzer producing warnings plus scaffolding suggestions (no model
// call).
export type {
  GitCommitChangeSummary,
  GitCommitQualityWarningCode,
  GitCommitIntentAnalysis,
  GitCommitIntentInput,
} from "./git-commit-intent.js";
export {
  GIT_COMMIT_INTENT_SCHEMA_VERSION,
  DEFAULT_LARGE_CHANGE_THRESHOLD,
  GIT_COMMIT_QUALITY_WARNING_CODES,
  analyzeGitCommitIntent,
  isGitCommitQualityWarningCode,
  isGitCommitChangeSummary,
  isGitCommitIntentAnalysis,
} from "./git-commit-intent.js";

// git-pull-request.ts (Issue #477, Epic #470; ADR-0064)
// The provider-neutral, content-free PR-orchestration leaf: the readiness model (objectExists vs
// reviewReady with severity-ranked blockers), the deterministic metadata-synthesis heuristics, the
// reviewer/label/linkage suggestion shapes, and the provider-failure rejection taxonomy. The actual PR
// title/body strings and the GitHub-specific raw-error classifier are keiko-tools concerns.
export type {
  GitPrChangeType,
  GitPrPolicyOutcome,
  GitPullRequestChangeNarrative,
  GitPullRequestRiskDigest,
  GitPrSummarySection,
  GitPrRiskSection,
  GitPrChangeNarrativeSection,
  GitPullRequestMetadataDraft,
  GitPullRequestReadinessBlockerCode,
  GitPrBlockerSeverity,
  GitPrRemediationClass,
  GitPullRequestReadinessBlocker,
  GitPullRequestReadinessSummary,
  GitPullRequestReadinessInput,
  GitPullRequestRecommendation,
  GitPrReviewerSuggestionBasis,
  GitPrLabelSuggestionBasis,
  GitPrLinkageSuggestionBasis,
  GitPullRequestReviewerSuggestion,
  GitPullRequestLabelSuggestion,
  GitPullRequestLinkageSuggestion,
  GitPullRequestRejectionReason,
} from "./git-pull-request.js";
export {
  GIT_PULL_REQUEST_SCHEMA_VERSION,
  GIT_PR_CHANGE_TYPES,
  GIT_PR_POLICY_OUTCOMES,
  GIT_PR_READINESS_BLOCKER_CODES,
  GIT_PR_RECOMMENDATIONS,
  GIT_PR_REJECTION_REASONS,
  GIT_PR_REJECTION_ERROR_CODE,
  GIT_PR_REJECTION_DISPOSITION,
  gitPrRejectionToErrorCode,
  gitPrRejectionToDisposition,
  synthesizePullRequestMetadata,
  gitPullRequestReadinessFor,
  gitPullRequestRecommendationFor,
  gitPullRequestReviewerSuggestionsFor,
  gitPullRequestLabelSuggestionsFor,
  gitPullRequestLinkageSuggestionsFor,
  isGitPrChangeType,
  isGitPrPolicyOutcome,
  isGitPullRequestReadinessBlockerCode,
  isGitPullRequestRecommendation,
  isGitPullRequestRejectionReason,
  isGitPullRequestReadinessBlocker,
  isGitPullRequestReadinessSummary,
  isGitPullRequestChangeNarrative,
  isGitPullRequestMetadataDraft,
  parseGitPullRequestReadinessSummary,
} from "./git-pull-request.js";

// git-merge.ts (Issue #478, Epic #470; ADR-0087)
// The provider-neutral, content-free merge-governance leaf: the merge-readiness model (the severity-
// ranked blocker taxonomy reusing GitDeliveryMergeBlockReason plus the lifecycle/preview states), the
// strategy-eligibility derivation (policy ∩ provider capability, never a UI default), the merge
// recommendation, and the provider-failure rejection taxonomy. The GitHub-specific mergeable-state
// mapper and raw-error classifier are keiko-tools concerns.
export type {
  GitMergeLifecycleBlockerCode,
  GitMergeReadinessBlockerCode,
  GitMergeBlockerSeverity,
  GitMergeRemediationClass,
  GitMergeReadinessBlocker,
  GitMergeReadinessSummary,
  GitMergeStrategyPolicy,
  GitMergeStrategyEligibility,
  GitMergeRecommendation,
  GitMergeApprovalContext,
  GitMergeRejectionReason,
  GitMergeRejection,
  GitMergeReadinessInput,
} from "./git-merge.js";
export {
  GIT_MERGE_SCHEMA_VERSION,
  GIT_MERGE_LIFECYCLE_BLOCKER_CODES,
  GIT_MERGE_READINESS_BLOCKER_CODES,
  GIT_MERGE_RECOMMENDATIONS,
  GIT_MERGE_REJECTION_REASONS,
  GIT_MERGE_REJECTION_ERROR_CODE,
  GIT_MERGE_REJECTION_DISPOSITION,
  gitMergeBlockerRemediationFor,
  gitMergeBlockerActionHintFor,
  deriveEligibleMergeStrategies,
  gitMergeRecommendationFor,
  gitMergeRejectionToErrorCode,
  gitMergeRejectionToDisposition,
  gitMergeRejectionFor,
  gitMergeReadinessFor,
  gitMergeReadinessBlockerIsPrerequisite,
  isGitMergeReadinessBlockerCode,
  isGitMergeRecommendation,
  isGitMergeRejectionReason,
  isGitMergeReadinessBlocker,
  isGitMergeReadinessSummary,
  parseGitMergeReadinessSummary,
} from "./git-merge.js";

// ─── Discussion intelligence (Issue #502 / Epic #491; ADR-0107) ──────────────────
// Text-first colleague-like discussion contract (5 modes, disagreement structure, confidence bridge,
// interruption-recovery turn model). Reuses the prompt-enhancer citation/contradiction/grounding vocab
// and the voice transcript capability gate (no parallel stack). Pure, content-free leaf module.
export type {
  DiscussionMode,
  ConfidenceLevel,
  DisagreementFacet,
  DiscussionDirective,
  DiscussionModePlan,
  DiscussionTurnStatus,
  DiscussionTurnContext,
  DiscussionTurnSummary,
  DiscussionValidationResult,
} from "./discussion-intelligence.js";
export {
  DISCUSSION_INTELLIGENCE_SCHEMA_VERSION,
  DISCUSSION_MODES,
  DISCUSSION_CONFIDENCE_LEVELS,
  DISAGREEMENT_FACETS,
  DISCUSSION_DIRECTIVES,
  DISCUSSION_DIRECTIVE_TEMPLATES,
  DISCUSSION_DIRECTIVE_FACETS,
  DISCUSSION_MODE_PLANS,
  DISCUSSION_TURN_STATUSES,
  DISCUSSION_TURN_STATUS_TRANSITIONS,
  isDiscussionIntelligenceSchemaVersionSupported,
  isDiscussionMode,
  assertNeverDiscussionMode,
  confidenceLevelFromScore,
  assertNeverDiscussionDirective,
  discussionModePlan,
  discussionDirectivesCoverFacets,
  voiceCanDriveDiscussion,
  isDiscussionTurnStatus,
  canTransitionDiscussionTurnStatus,
  assertNeverDiscussionTurnStatus,
  discussionTopicIdReasons,
  isValidDiscussionTopicId,
  beginDiscussionTurn,
  applyDiscussionInterruption,
  applyDiscussionRecovery,
  resolveDiscussionTurn,
  summarizeDiscussionTurn,
  validateDiscussionTurnContext,
  validateDiscussionModePlan,
} from "./discussion-intelligence.js";

// ─── Spoken action intent governance (Issue #503 / Epic #491; ADR-0108) ──────────
// Deterministic, fail-closed normalization + confirmation layer that sits IN FRONT OF the existing
// governed-handoff governance for UNTRUSTED spoken transcripts. Adds preconditions, removes none. Pure,
// content-free leaf module: the audit record carries no raw text/audio, only enums/counts/digest.
export type {
  SpokenActionEffectClass,
  SpokenActionEffectMarkers,
  SpokenActionState,
  SpokenActionOutcome,
  SpokenActionConfirmationInput,
  SpokenActionProposal,
  SpokenActionAuditInput,
  SpokenActionAuditRecord,
  SpokenActionValidationResult,
} from "./voice-action-intent.js";
export {
  VOICE_ACTION_INTENT_SCHEMA_VERSION,
  SPOKEN_ACTION_EFFECT_CLASSES,
  SPOKEN_ACTION_EFFECT_REQUIRES_CONFIRMATION,
  SPOKEN_ACTION_EFFECT_MARKERS,
  SPOKEN_ACTION_STATES,
  SPOKEN_ACTION_TERMINAL_STATES,
  SPOKEN_ACTION_STATE_TRANSITIONS,
  SPOKEN_ACTION_OUTCOMES,
  isVoiceActionIntentSchemaVersionSupported,
  isSpokenActionEffectClass,
  assertNeverSpokenActionEffectClass,
  spokenActionRequiresConfirmation,
  classifySpokenActionEffect,
  isSpokenActionState,
  canTransitionSpokenAction,
  isTerminalSpokenActionState,
  assertNeverSpokenActionState,
  voiceCanProposeAction,
  isSpokenActionOutcome,
  canonicalizeSpokenActionConfirmation,
  normalizeSpokenActionProposal,
  buildSpokenActionAuditRecord,
  validateSpokenActionProposal,
  validateSpokenActionAuditRecord,
} from "./voice-action-intent.js";

// ─── Voice session recap (Issue #504, ADR-0109) ───
// Committed-transcript-derived memory candidates: capability predicate, candidate lifecycle,
// content-free span/turn descriptors, and the recap audit record. The server (voice-recap.ts) is
// the only site that joins this leaf with the memory-capture domain.
export type {
  VoiceSessionRecapSchemaVersion,
  VoiceRecapCandidateStatus,
  VoiceRecapCommittedSpanDescriptor,
  VoiceRecapAssistantTurnDescriptor,
  VoiceSessionRecapEvidenceSummary,
  VoiceSessionRecapAuditRecord,
} from "./voice-session-recap.js";
export {
  VOICE_SESSION_RECAP_SCHEMA_VERSION,
  VOICE_RECAP_CANDIDATE_STATUSES,
  isVoiceSessionRecapSchemaVersionSupported,
  isVoiceRecapCandidateStatus,
  voiceRecapAllowed,
  validateVoiceSessionRecapAuditRecord,
} from "./voice-session-recap.js";

// ─── Task-scoped workspace domain (Issue #444, Epic #443) ───
// The authoritative contract for what a task-scoped isolated workspace IS, how a task binds to it,
// its lifecycle state machine (legal/illegal transitions + SC4 preconditions), drift/recovery
// semantics, the content-free audit event, the read-only vs mutating operation authority (AC3), and
// the no-duplicate-subsystem delegation boundary (AC4). Delegates git mutation (#470), editor/runtime
// context (#1491), terminal mutation (ADR-0018), and workspace discovery + path containment
// (@oscharko-dev/keiko-workspace) — it never re-implements them. Follow-on slices #445–#450 consume
// this as the single source for status/health/repair/binding/audit.
export type {
  TaskWorkspaceValidationOk,
  TaskWorkspaceValidationFail,
  TaskWorkspaceValidation,
  TaskWorkspaceTransitionValidation,
  TaskWorkspaceLifecycleState,
  TaskWorkspaceTransitionPrecondition,
  TaskWorkspaceTransitionContext,
  TaskWorkspaceTransitionInput,
  TaskWorkspaceHealth,
  TaskWorkspaceDriftMarker,
  WorkspaceLockReason,
  WorkspaceLock,
  WorkspaceFailureClass,
  WorkspaceRecoveryStrategy,
  WorkspaceRecoveryHint,
  WorkspaceSurface,
  WorkspaceEventType,
  WorkspaceEvent,
  WorkspaceInstance,
  WorkspaceBinding,
  WorkspaceActivation,
  WorkspaceOperationAuthority,
  WorkspaceOperationName,
  WorkspaceOperation,
  TaskWorkspaceDelegatedConcern,
  TaskWorkspaceDelegatedSubsystem,
  WorkspaceReconciliationStatus,
  WorkspaceReconciliationFacts,
  WorkspaceReconciliationOutcome,
  WorkspaceReconciliationEntry,
  WorkspaceActiveRestorationKind,
  WorkspaceActiveRestoration,
  WorkspaceReconciliationReport,
  WorkspaceHealthClassification,
  WorkspaceCleanupRefusalReason,
  WorkspaceCleanupSafetyFacts,
  WorkspaceCleanupDecision,
  WorkspaceHealthSignals,
  WorkspaceHealthEvaluation,
  WorkspaceHealthEntryKind,
  WorkspaceHealthEntry,
  WorkspaceHealthReport,
} from "./task-workspace.js";
export {
  TASK_WORKSPACE_SCHEMA_VERSION,
  TASK_WORKSPACE_LIFECYCLE_STATES,
  TASK_WORKSPACE_LEGAL_TRANSITIONS,
  TASK_WORKSPACE_TRANSITION_PRECONDITIONS,
  TASK_WORKSPACE_HEALTH_STATES,
  TASK_WORKSPACE_DRIFT_MARKERS,
  WORKSPACE_LOCK_REASONS,
  WORKSPACE_FAILURE_CLASSES,
  WORKSPACE_RECOVERY_STRATEGIES,
  TASK_WORKSPACE_SURFACES,
  WORKSPACE_EVENT_TYPES,
  WORKSPACE_EVENT_ALLOWED_KEYS,
  WORKSPACE_INSTANCE_ALLOWED_KEYS,
  WORKSPACE_BINDING_ALLOWED_KEYS,
  WORKSPACE_ACTIVATION_ALLOWED_KEYS,
  TASK_WORKSPACE_OPERATIONS,
  TASK_WORKSPACE_DELEGATED_SUBSYSTEMS,
  isTaskWorkspaceLifecycleState,
  isLegalTaskWorkspaceTransition,
  nextLegalTaskWorkspaceStates,
  isTaskWorkspaceTransitionPrecondition,
  requiredTaskWorkspaceTransitionPreconditions,
  validateTaskWorkspaceTransition,
  isTaskWorkspaceHealth,
  isTaskWorkspaceDriftMarker,
  isWorkspaceLockReason,
  isWorkspaceFailureClass,
  isWorkspaceRecoveryStrategy,
  isWorkspaceSurface,
  isWorkspaceEventType,
  validateWorkspaceEvent,
  validateWorkspaceInstance,
  validateWorkspaceBinding,
  validateWorkspaceActivation,
  taskWorkspaceOperation,
  isReadOnlyTaskWorkspaceOperation,
  isMutatingTaskWorkspaceOperation,
  isDelegatedTaskWorkspaceConcern,
  taskWorkspaceDelegatedOwner,
  WORKSPACE_RECONCILIATION_STATUSES,
  WORKSPACE_RECONCILIATION_ENTRY_ALLOWED_KEYS,
  WORKSPACE_RECONCILIATION_REPORT_ALLOWED_KEYS,
  WORKSPACE_ACTIVE_RESTORATION_KINDS,
  isWorkspaceReconciliationStatus,
  isWorkspaceActiveRestorationKind,
  classifyWorkspaceReconciliation,
  planWorkspaceRecoveryHints,
  reconciliationHealth,
  reconciliationRequiresRecoveryFlag,
  reconciliationStatusFromInstance,
  isAutomaticWorkspaceRepairStrategy,
  isWorkspaceRepairStrategyApplicable,
  workspaceEntryRepairable,
  workspaceEntryOperatorActionRequired,
  deriveReconciliationEntry,
  resolveActiveRestoration,
  validateWorkspaceReconciliationEntry,
  validateWorkspaceActiveRestoration,
  validateWorkspaceReconciliationReport,
  WORKSPACE_HEALTH_CLASSIFICATIONS,
  WORKSPACE_CLEANUP_ELIGIBLE_LIFECYCLE_STATES,
  WORKSPACE_CLEANUP_REFUSAL_REASONS,
  WORKSPACE_HEALTH_ENTRY_KINDS,
  WORKSPACE_HEALTH_ENTRY_ALLOWED_KEYS,
  WORKSPACE_HEALTH_REPORT_ALLOWED_KEYS,
  isWorkspaceHealthClassification,
  isCleanupEligibleLifecycleState,
  isWorkspaceCleanupRefusalReason,
  isWorkspaceHealthEntryKind,
  evaluateWorkspaceCleanupSafety,
  classifyWorkspaceHealth,
  deriveWorkspaceHealthEntry,
  deriveOrphanWorktreeHealthEntry,
  validateWorkspaceHealthEntry,
  validateWorkspaceHealthReport,
} from "./task-workspace.js";

// ─── Native OS file/folder dialog (Epic #1941, ADR-0118) ───────────────────────────
export type {
  LocalKnowledgeFileFilterDefinition,
  LocalKnowledgeFileFilterId,
} from "./local-knowledge-file-selection.js";
export {
  LOCAL_KNOWLEDGE_PDF_FILE_EXTENSIONS,
  LOCAL_KNOWLEDGE_DOCX_FILE_EXTENSIONS,
  LOCAL_KNOWLEDGE_XLSX_FILE_EXTENSIONS,
  LOCAL_KNOWLEDGE_DOCUMENT_FILE_EXTENSIONS,
  LOCAL_KNOWLEDGE_JSON_FILE_EXTENSIONS,
  LOCAL_KNOWLEDGE_CSV_FILE_EXTENSIONS,
  LOCAL_KNOWLEDGE_TSV_FILE_EXTENSIONS,
  LOCAL_KNOWLEDGE_STRUCTURED_DATA_FILE_EXTENSIONS,
  LOCAL_KNOWLEDGE_TEXT_DOCUMENT_FILE_EXTENSIONS,
  LOCAL_KNOWLEDGE_WEB_DOCUMENT_FILE_EXTENSIONS,
  LOCAL_KNOWLEDGE_SCRIPT_FILE_EXTENSIONS,
  LOCAL_KNOWLEDGE_SOURCE_CODE_FILE_EXTENSIONS,
  LOCAL_KNOWLEDGE_CONFIGURATION_FILE_EXTENSIONS,
  LOCAL_KNOWLEDGE_TEXT_FILE_EXTENSIONS,
  LOCAL_KNOWLEDGE_FILE_FILTERS,
} from "./local-knowledge-file-selection.js";
export type {
  NativeFileDialogMode,
  NativeFileDialogSelectionKind,
  NativeFileDialogFilter,
  NativeFileDialogRequest,
  NativeFileDialogSelection,
  NativeFileDialogResponse,
  NativeFileDialogCapability,
  NativeFileDialogErrorCode,
  NativeFileDialogRequestValidation,
} from "./native-file-dialog.js";
export {
  NATIVE_FILE_DIALOG_SCHEMA_VERSION,
  NATIVE_FILE_DIALOG_MODES,
  NATIVE_FILE_DIALOG_ERROR_CODES,
  NATIVE_FILE_DIALOG_TITLE_MAX_LENGTH,
  NATIVE_FILE_DIALOG_DEFAULT_PATH_MAX_LENGTH,
  NATIVE_FILE_DIALOG_MAX_FILTERS,
  NATIVE_FILE_DIALOG_FILTER_NAME_MAX_LENGTH,
  NATIVE_FILE_DIALOG_MAX_EXTENSIONS_PER_FILTER,
  NATIVE_FILE_DIALOG_MAX_SELECTIONS,
  validateNativeFileDialogRequest,
  nativeFileDialogSelectionBounds,
  nativeFileDialogExpectedKind,
} from "./native-file-dialog.js";

// ─── Managed multi-language LSP activation (Epic #2094, Issue #2271, ADR-0128) ───
export type {
  ManagedLspLanguage,
  ManagedLspEffectiveState,
  ManagedLspActivationReasonCode,
  ManagedLspProductSupport,
  ManagedLspCanonicalState,
  ManagedLspDeploymentPolicy,
  ManagedLspProvisioning,
  ManagedLspWorkspaceActivation,
  ManagedLspLegacyEnvironment,
  ManagedLspNegotiation,
  ManagedLspRuntimeHealth,
  ManagedLspPolicyResult,
  ManagedLspActivationInput,
  ManagedLspActivationStatus,
  ManagedLspActivationDenied,
  ManagedLspActivationResolution,
  ManagedLspActivationParseResult,
} from "./managed-lsp-activation.js";
export {
  MANAGED_LSP_ACTIVATION_SCHEMA_VERSION,
  MANAGED_LSP_LANGUAGES,
  MANAGED_LSP_EFFECTIVE_STATES,
  MANAGED_LSP_ACTIVATION_REASON_CODES,
  parseManagedLspActivationInput,
  parseManagedLspActivationStatus,
  resolveManagedLspActivation,
} from "./managed-lsp-activation.js";

export type {
  ManagedLspSettingSource,
  ManagedLspPersistedSettingSource,
  ManagedLspSettingLayers,
  ManagedLspResolvedSetting,
  ManagedLspWorkspaceActivationSetting,
  ManagedLspApprovedRuntimeReference,
  ManagedLspWorkspaceRelativePath,
  ManagedLspConfigurationProvenance,
  ManagedLspPythonSettings,
  ManagedLspGoBuildFlags,
  ManagedLspGoOperatingSystem,
  ManagedLspGoArchitecture,
  ManagedLspGoTarget,
  ManagedLspGoDirectoryFilter,
  ManagedLspGoSettings,
  ManagedLspShellCheckSettings,
  ManagedLspShellSettings,
  ManagedLspJavaLanguageLevel,
  ManagedLspJavaSettings,
  ManagedLspRustCfg,
  ManagedLspRustResourceBudget,
  ManagedLspRustSettings,
  ManagedLspRestartField,
  ManagedLspPythonConfiguration,
  ManagedLspGoConfiguration,
  ManagedLspShellConfiguration,
  ManagedLspJavaConfiguration,
  ManagedLspRustConfiguration,
  ManagedLspRuntimeConfiguration,
  ManagedLspConfigurationPrecondition,
  ManagedLspRuntimeParseResult,
} from "./managed-lsp-runtime.js";
export {
  MANAGED_LSP_RUNTIME_SCHEMA_VERSION,
  MANAGED_LSP_RUNTIME_ID_MAX_CHARS,
  MANAGED_LSP_ETAG_MAX_CHARS,
  MANAGED_LSP_BUILD_TAG_MAX_COUNT,
  MANAGED_LSP_BUILD_TAG_MAX_CHARS,
  MANAGED_LSP_PYTHON_EXTRA_PATH_MAX_COUNT,
  MANAGED_LSP_GO_DIRECTORY_FILTER_MAX_COUNT,
  MANAGED_LSP_SHELLCHECK_EXCLUDE_MAX_COUNT,
  MANAGED_LSP_SHELL_INCLUDE_PATH_MAX_COUNT,
  MANAGED_LSP_JAVA_CLASSPATH_MAX_COUNT,
  MANAGED_LSP_JAVA_PROJECT_ROOT_MAX_COUNT,
  MANAGED_LSP_RUST_FEATURE_MAX_COUNT,
  MANAGED_LSP_RUST_CFG_MAX_COUNT,
  MANAGED_LSP_RUST_LINKED_PROJECT_MAX_COUNT,
  MANAGED_LSP_RUST_MAX_PROJECT_FILES,
  MANAGED_LSP_RUST_MAX_CARGO_METADATA_BYTES,
  MANAGED_LSP_RUST_MAX_MEMORY_MB,
  MANAGED_LSP_RUST_MAX_INDEX_DEADLINE_MS,
  MANAGED_LSP_SETTING_PRECEDENCE,
  resolveManagedLspSetting,
  parseManagedLspRuntimeConfiguration,
  matchesManagedLspConfigurationPrecondition,
} from "./managed-lsp-runtime.js";

export type {
  ManagedLspProtocolVersion,
  ManagedLspPositionEncoding,
  ManagedLspTextSync,
  ManagedLspCandidateCapabilities,
  ManagedLspNegotiatedSemanticTokens,
  ManagedLspNegotiatedCapabilitySnapshot,
  ManagedLspSemanticTokenType,
  ManagedLspSemanticTokenModifier,
  ManagedLspSemanticTokenLegend,
  ManagedLspSemanticTokenData,
  ManagedLspSemanticTokenRequest,
  ManagedLspSemanticTokenResponse,
  ManagedLspCapabilityParseResult,
} from "./managed-lsp-capabilities.js";
export {
  MANAGED_LSP_CAPABILITY_SCHEMA_VERSION,
  MANAGED_LSP_SEMANTIC_TOKEN_MAX_TYPES,
  MANAGED_LSP_SEMANTIC_TOKEN_MAX_MODIFIERS,
  MANAGED_LSP_SEMANTIC_TOKEN_MAX_TOKENS,
  MANAGED_LSP_SEMANTIC_TOKEN_TYPES,
  MANAGED_LSP_SEMANTIC_TOKEN_MODIFIERS,
  parseManagedLspCandidateCapabilities,
  parseManagedLspNegotiatedCapabilitySnapshot,
  isManagedLspOperationNegotiated,
  parseManagedLspSemanticTokenLegend,
  parseManagedLspSemanticTokenData,
  managedLspSemanticTokensFitDocument,
  parseManagedLspSemanticTokenRequest,
} from "./managed-lsp-capabilities.js";

export type {
  ManagedLspEvidenceActorClass,
  ManagedLspEvidenceKind,
  ManagedLspEvidenceAction,
  ManagedLspEvidenceOutcome,
  ManagedLspActivationEvidence,
  ManagedLspLifecycleEvidence,
  ManagedLspEvidence,
  ManagedLspEvidenceParseResult,
} from "./managed-lsp-evidence.js";
export {
  MANAGED_LSP_EVIDENCE_SCHEMA_VERSION,
  MANAGED_LSP_EVIDENCE_ACTOR_CLASSES,
  MANAGED_LSP_EVIDENCE_ACTIONS,
  MANAGED_LSP_EVIDENCE_OUTCOMES,
  parseManagedLspEvidence,
} from "./managed-lsp-evidence.js";

// ─── M7 editor personalization and resilience platform (Epic #2095, ADR-0133) ───
export type {
  EditorM7ParseResult,
  EditorM7ReasonCode,
  EditorM7SettingScope,
  EditorM7SettingSource,
  EditorM7SettingType,
  EditorM7SettingEffect,
  EditorM7SettingSecurity,
  EditorM7SettingId,
  EditorM7WordWrap,
  EditorM7WhitespaceRendering,
  EditorM7ExternalReloadPolicy,
  EditorM7LargeFileMode,
  EditorM7SettingValue,
  EditorM7SettingDefinition,
  EditorM7SettingsLayer,
  EditorM7PolicyCeiling,
  EditorM7ResolvedSetting,
  EditorM7SettingsRecord,
  EditorM7StoreState,
  EditorM7SettingsSnapshot,
  EditorM7SettingsMutationAction,
  EditorM7SettingsMutation,
  EditorM7SettingsMutationOk,
  EditorM7SettingsMutationResult,
  EditorM7SettingsEvent,
  EditorM7WatchEventKind,
  EditorM7WatchHealth,
  EditorM7WatchEntryKind,
  EditorM7WatchDegradedReason,
  EditorM7WatchEvent,
  EditorM7WatchSnapshot,
  EditorM7ModelEntry,
  EditorM7ModelEvictionPlan,
  EditorM7CommandScope,
  EditorM7CommandContext,
  EditorM7CommandDispatchOwner,
  EditorM7CommandDefinition,
  EditorM7KeybindingOverride,
  EditorM7ActiveKeybinding,
  EditorM7Snippet,
  EditorM7SnippetCollection,
  EditorM7AiFeature,
  EditorM7AiState,
  EditorM7AiActivationInput,
  EditorM7AiActivationStatus,
  EditorM7AiActivationSummary,
} from "./editor-m7.js";
export type {
  EditorM7SnippetProvenance,
  EditorM7WorkspaceSnippet,
  EditorM7WorkspaceSnippetInput,
  EditorM7WorkspaceSnippetCollection,
  EditorM7WorkspaceSnippetSnapshot,
  EditorM7WorkspaceSnippetMutationAction,
  EditorM7WorkspaceSnippetMutation,
  EditorM7WorkspaceSnippetMutationResult,
  EditorM7SnippetCompletion,
  EditorM7SnippetDiagnostics,
} from "./editor-snippets.js";
export {
  EDITOR_M7_SCHEMA_VERSION,
  EDITOR_M7_SETTING_REGISTRY,
  EDITOR_M7_COMMAND_REGISTRY,
  EDITOR_M7_KEYBINDING_OVERRIDE_VERSION,
  parseEditorM7SettingValue,
  parseEditorM7SettingPatch,
  defaultEditorM7Settings,
  resolveEditorM7Settings,
  parseEditorM7SettingsRecord,
  parseEditorM7SettingsEvent,
  parseEditorM7WatchEvent,
  parseEditorM7WatchSnapshot,
  planEditorM7ModelEviction,
  validateEditorM7Keybinding,
  serializeEditorM7KeybindingOverride,
  parseEditorM7KeybindingOverrideRecord,
  parseEditorM7KeybindingOverrides,
  parseEditorM7SnippetCollection,
  resolveEditorM7AiActivation,
} from "./editor-m7.js";
export {
  EDITOR_M7_SNIPPET_COLLECTION_VERSION,
  parseEditorM7WorkspaceSnippetCollection,
  compileEditorM7SnippetBody,
  editorM7SnippetDiagnostics,
  matchingEditorM7Snippets,
} from "./editor-snippets.js";
