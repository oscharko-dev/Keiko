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

export const KEIKO_CONTRACTS_VERSION = "0.8.0" as const;

// Single-source product version. Surfaced as `keiko --version`, in the BFF healthcheck
// response, and as the SDK's exported `SDK_VERSION` constant. Kept here on the leaf
// package so every consumer reaches it through one stable import path. Bump in lockstep
// with the root package.json "version" field as part of every release.
export const KEIKO_PRODUCT_VERSION = "0.2.8" as const;

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
export type { EditorHotExitSnapshotV1 } from "./editor-hot-exit.js";
export {
  EDITOR_HOT_EXIT_SCHEMA_VERSION,
  EDITOR_HOT_EXIT_TTL_MS,
  editorHotExitSnapshotExpired,
  isEditorHotExitSnapshotV1,
} from "./editor-hot-exit.js";

// ─── Editor agent API (Issues #1391, #1392) ─────────────────────────────────────
export type {
  EditorAgentAction,
  EditorAgentActionFailure,
  EditorAgentActionQueuedResponse,
  EditorAgentActionResult,
  EditorAgentActionResultRequest,
  EditorAgentActionStatus,
  EditorAgentActionType,
  EditorAgentActionsPostBody,
  EditorAgentBridgeSnapshotRequest,
  EditorAgentConflictCode,
  EditorAgentEvent,
  EditorAgentFailureCode,
  EditorAgentPaneSnapshot,
  EditorAgentParse,
  EditorAgentParseFail,
  EditorAgentParseOk,
  EditorAgentSessionSnapshot,
  EditorAgentSessionsResponse,
  EditorAgentSnapshotRequest,
  EditorAgentSnapshotResponse,
  EditorAgentSnapshotTextMode,
} from "./editor-agent.js";
export {
  DEFAULT_EDITOR_AGENT_SNAPSHOT_TEXT_MODE,
  EDITOR_AGENT_CONFLICT_CODES,
  EDITOR_AGENT_FAILURE_CODES,
  EDITOR_AGENT_SCHEMA_VERSION,
  EDITOR_AGENT_WRITE_ACTION_TYPES,
  editorAgentActionHasWritePrecondition,
  editorAgentWritePreconditionError,
  isContainedAgentPath,
  isEditorAgentAction,
  isEditorAgentActionResult,
  isEditorAgentConflictCode,
  isEditorAgentEvent,
  isEditorAgentFailureCode,
  isEditorAgentSessionSnapshot,
  isEditorAgentWriteActionType,
  parseEditorAgentActionsPostBody,
  parseEditorAgentSnapshotRequest,
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
  EditorAgentAuditResponse,
} from "./editor-agent-governance.js";
export {
  EDITOR_AGENT_ACTION_DENY_REASONS,
  EDITOR_AGENT_ACTION_DISPOSITIONS,
  EDITOR_AGENT_ACTION_EFFECT_CLASS,
  EDITOR_AGENT_ACTION_REVIEW_REASONS,
  EDITOR_AGENT_AUDIT_SCHEMA_VERSION,
  EDITOR_AGENT_AUDIT_SUMMARY_MAX_CHARS,
  buildEditorAgentActionAuditRecord,
  classifyEditorAgentAction,
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
  LanguageProviderAvailability,
  LanguageProviderDescriptor,
  LanguageServiceCapabilities,
  LanguageServiceLimits,
  LanguageDiagnosticsRequest,
  LanguageCompletionRequest,
  LanguageHoverRequest,
  LanguageSymbolsRequest,
  LanguageFormattingRequest,
  LanguageServiceRequest,
  LanguageServiceParseOk,
  LanguageServiceParseFail,
  LanguageServiceParse,
} from "./language-service.js";
export {
  LANGUAGE_SERVICE_SCHEMA_VERSION,
  LANGUAGE_SERVICE_OPERATIONS,
  LANGUAGE_SERVICE_ERROR_CODES,
  MAX_LANGUAGE_FORMATTING_TAB_SIZE,
  DEFAULT_LANGUAGE_SERVICE_LIMITS,
  isLanguagePosition,
  isLanguageDocumentOverlay,
  isLanguageFormattingOptions,
  parseLanguageServiceRequest,
} from "./language-service.js";

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
  GatewayRequest,
  NormalizedToolCall,
  UsageMetadata,
  NormalizedResponse,
  FinishReason,
  StreamDelta,
  StreamEvent,
} from "./gateway.js";
export { CONVERSATION_CAPABILITY_CONTRACT_VERSION, INFILLING_ALIGNMENTS } from "./gateway.js";
export type { ConversationIneligibilityReason } from "./gateway.js";
export {
  isConversationEligibleModel,
  explainConversationIneligibility,
  modelSupportsInfilling,
  isAlignedInfillingModel,
  isAsYouTypeCompletionModel,
} from "./gateway.js";

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
  VerificationReport,
  ScriptCatalog,
  ScriptMapping,
} from "./verification.js";
export { DEFAULT_VERIFICATION_LIMITS } from "./verification.js";

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
  DesktopChatSendRequestWire,
  BffErrorCode,
  BffError,
  GroundingLimits,
} from "./bff-wire.js";
export {
  buildGroundedAnswerContextPackSummary,
  DEFAULT_GROUNDING_LIMITS,
  GROUNDING_LIMIT_CEILINGS,
  resolveGroundingLimits,
} from "./bff-wire.js";

// ─── Shared text-safety primitive (Epic #177/#189 grounding hardening, GRD-001) ──
export { stripUnsafeFormatChars } from "./text-safety.js";

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

// ─── Deterministic context-engineering layer (ADR-0052, context-engineering milestone) ──
export type {
  ContextLaneId,
  ContextEvictionPolicy,
  ContextBudgetPressure,
  ContextModelMetadata,
  ContextProfile,
  ContextLaneBudget,
  ContextBudget,
  ContextLane,
  ContextLaneDiagnostics,
  ContextAssemblyDiagnostics,
  ContextCompactionRecord,
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
  DEFAULT_TOKEN_ESTIMATOR_ID,
  CONTEXT_LANE_IDS,
  CONTEXT_EVICTION_POLICIES,
  DEFAULT_CONTEXT_PROFILE,
  estimateTokens,
  estimateTokensForSegments,
  deriveContextProfile,
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
  validateCapsuleSet,
  validateCapsuleReindexRequest,
  validateConnectorGraphState,
} from "./local-knowledge-validation.js";

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
  MEMORY_SCHEMA_VERSION,
  MEMORY_SCOPE_KINDS,
  MEMORY_SENSITIVITIES,
  MEMORY_SOURCE_KINDS,
  MEMORY_STATUSES,
  MEMORY_STATUS_TRANSITIONS,
  MEMORY_STRUCTURED_PAYLOAD_KINDS,
  MEMORY_TYPES,
  MEMORY_UPDATE_FIELDS,
  assertNeverMemoryType,
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

// ─── Conversation budget estimator (Issue #151 / Epic #142) ─────────────────────
// Pure, deterministic helper for the Conversation Center context-pressure
// indicator and the "clear history" affordance. Token counts are APPROXIMATE
// (bytes/4) by design — UI copy and tests must state this precisely.
export type {
  ConversationBudgetBreakdown,
  ConversationBudgetDocumentContext,
  ConversationBudgetEstimate,
  ConversationBudgetInputs,
  ConversationBudgetMessage,
  ConversationBudgetPressure,
} from "./conversation-budget.js";
export { estimateConversationBudget } from "./conversation-budget.js";

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
  QualityIntelligenceStartRunRequest,
  QualityIntelligenceSkippedSource,
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
  QualityIntelligencePriority,
  QualityIntelligenceRiskClass,
  QualityIntelligenceTestCaseStatus,
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
