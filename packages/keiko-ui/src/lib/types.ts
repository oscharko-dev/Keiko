// Browser-safe contract seam for the UI (issue #167 ADR-0019 rule 8). Every name in this file
// is a pure re-export — zero type DEFINITIONS live here. The wire entity shapes come from
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
  UsageMetadata,
  WorkflowDescriptor,
  WorkflowInputSpec,
} from "@oscharko-dev/keiko-contracts";

// ─── Workspace summary + context pack ──────────────────────────────────────────────
export type {
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
  ProjectsResponse,
  ProjectResponse,
  ChatsResponse,
  ChatResponse,
  MessagesResponse,
  MessageResponse,
  DesktopChatBootstrapResponse,
  DesktopChatSendResponse,
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
  BrowserViewportPx,
  CdpReachability,
  BrowserSessionMeta,
  BrowserNavigateResult,
  BrowserScreenshotResult,
  BrowserContentResult,
  BrowserEventKind,
  BrowserEventEnvelope,
} from "@oscharko-dev/keiko-contracts/bff-wire";

// ─── SSE stream aggregation (UI-internal — see ./sse-types for rationale) ──────────
export type { HarnessEvent, HarnessEventType, TerminalEventType, SseStatus } from "./sse-types";
export { ALL_SSE_EVENT_TYPES, TERMINAL_EVENT_TYPES } from "./sse-types";
