// Browser-safe contract seam for the UI (ADR-0019 rule 8). Every name in this file
// is a pure re-export; zero type definitions live here. The wire entity shapes come from
// @oscharko-dev/keiko-contracts/bff-wire; evidence and verification-summary shapes come from
// their respective subpaths; everything else comes from the contracts root barrel. The SSE
// stream aggregation (HarnessEvent/SseStatus/ALL_SSE_EVENT_TYPES/TERMINAL_EVENT_TYPES) is
// UI-internal because no orchestration package knows about the union of all three sources, so
// it lives in ./sse-types and is re-exported here for ergonomic `@/lib/types` consumers.

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
} from "@oscharko-dev/keiko-contracts";

export { DEFAULT_GROUNDING_LIMITS } from "@oscharko-dev/keiko-contracts";

// Issue #144 / Epic #142: pure conversation-eligibility helpers re-exported
// from keiko-contracts. UI cannot import from keiko-model-gateway (ADR-0019
// trust-3, error severity); contracts is the legitimate value-import source
// for browser-tier code.
export {
  isConversationEligibleModel,
  explainConversationIneligibility,
} from "@oscharko-dev/keiko-contracts";

// Issue #151 / Epic #142: pure conversation-budget estimator. The Conversation
// Center context-pressure indicator and "clear history" affordance derive from
// this on every render. Token counts are APPROXIMATE (bytes/4) by construction
// — UI copy and tests must state this precisely.
export type {
  ConversationBudgetBreakdown,
  ConversationBudgetDocumentContext,
  ConversationBudgetEstimate,
  ConversationBudgetInputs,
  ConversationBudgetMessage,
  ConversationBudgetPressure,
} from "@oscharko-dev/keiko-contracts";
export { estimateConversationBudget } from "@oscharko-dev/keiko-contracts";

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
  GroundedWorkflowHandoffRequest,
  GroundedWorkflowHandoffResponse,
  GroundedAskRequest,
  GroundedEvidenceCitation,
  GroundedUncertainty,
  GroundedAnswer,
  LocalKnowledgeEvidenceCitation,
  GroundedAnswerContextPackSummary,
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
  FilesPreviewBase,
  FilesPreviewResponse,
  FilesContentResponse,
  FilesWriteRequest,
  BrowserViewportPx,
  CdpReachability,
  BrowserSessionMeta,
  BrowserNavigateResult,
  BrowserScreenshotResult,
  BrowserContentResult,
  BrowserEventKind,
  BrowserEventEnvelope,
} from "@oscharko-dev/keiko-contracts/bff-wire";

export type { ExpectedCheck, WorkflowKind } from "@oscharko-dev/keiko-contracts/workflow-handoff";

// ─── SSE stream aggregation (UI-internal — see ./sse-types for rationale) ──────────
export type { HarnessEvent, HarnessEventType, TerminalEventType, SseStatus } from "./sse-types";
export { ALL_SSE_EVENT_TYPES, TERMINAL_EVENT_TYPES } from "./sse-types";
