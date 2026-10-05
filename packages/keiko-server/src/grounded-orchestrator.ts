// Grounded repository Q&A orchestrator (Epic #177, Issue #185). Composes the connected-context
// layers — #181 exploration planner, #179 lexical search facade, #180 structural adapters,
// #182 candidate ranker, and #183 context-pack assembler — into a single linear pipeline that
// produces a redacted `ConnectedContextPack` plus an assistant-content string. The model call
// is injected through the `GroundedAnswerer` seam so production can route through the Model
// Gateway while tests can keep deterministic answerers.
//
// Pure orchestration: the only IO this module performs is delegated through the workspace
// package's already-bounded WorkspaceFs port. Path validation is enforced by every composed
// layer at its own boundary, so this file does not re-validate scope paths.

import { reconcileAndLogInlineCitations } from "./grounded-citation-log.js";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  connectedContextOmittedCount,
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXPLORATION_BUDGET,
  MAX_OMITTED_CONTEXT_ENTRIES,
  isValidScopePath,
  type CandidateFile,
  type CandidateOmissionReason,
  type ConnectedContextPack,
  type ContextCoverageDiagnostics,
  type ContextPackDiagnostics,
  type EvidenceAtom,
  type ExplorationBudget,
  type ExplorationUsage,
  type OmittedContextEntry,
  type RetrievalQuery,
  type SelectedScope,
  type UncertaintyMarker,
  type UncertaintyMarkerKind,
} from "@oscharko-dev/keiko-contracts/connected-context";
import type { ContextProfile } from "@oscharko-dev/keiko-contracts";
import type { GroundedPromptContextWire } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  activityLogErrorKindOr,
  activityLogEvent,
  classifyErrorKind,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
  type ActivityLogFields,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  advanceRing,
  applyUsage,
  assembleContextPack,
  canContinue,
  complete,
  contextPackIndexKey,
  extractAnchors,
  DEFAULT_FILTER_OPTIONS,
  planAndGovern,
  rankCandidates,
  isDirectEvidenceLookup,
  requiresRelationshipOrHistoryRings,
  resolveQueryTargetDecision,
  type QueryTargetDecision,
  type ClarificationPrompt,
  type ClarificationReason,
  type ExcerptWindow,
  type ExplorationPlan,
  type GovernorState,
  type MicroIndex,
  type RerankerExecutionContext,
  type RerankerSeam,
  type RetrievalIntent,
  type RetrievalRing,
  type SearchAnchor,
} from "@oscharko-dev/keiko-workflows";
import {
  CANONICAL_MANIFEST_BASENAMES,
  DEFAULT_SEARCH_LIMITS,
  FileTooLargeError,
  PathDeniedError,
  RepoSearchUnsupportedFileError,
  WorkspaceNotFoundError,
  detectWorkspaceAt,
  decodeTextFileBytes,
  endpointContractAdapter,
  findFiles,
  gitHistoryAdapter,
  isCanonicalMetadataFile,
  isEcosystemSourceFile,
  isDenied,
  readExcerpt,
  resolveWithinWorkspace,
  searchText,
  symbolGraphAdapter,
  type ReadExcerptResult,
  type SearchLimits,
  type SearchResult,
  type SearchScope,
  type SemanticSearchProvider,
  type WorkspaceDirEntry,
  type WorkspaceFs,
  type WorkspaceIndex,
  type WorkspaceIndexPreparationReport,
  type WorkspaceInfo,
  type WorkspaceStat,
  containedRealPathInfo,
  evidenceAtomStableId,
} from "@oscharko-dev/keiko-workspace";
import {
  isAllowedContainedPathParent,
  isCanonicalAllowedContainedPath,
} from "@oscharko-dev/keiko-workspace/internal/realpath-policy";
import {
  createStructuralAdapterRequestContext,
  createEcosystemStructureAdapters,
  importGraphAdapter,
  runStructuralAdapters,
  repositorySourceLines,
  structuralLineLooksLikeSymbolDefinition,
  type RepositorySourceLine,
  type StructuralAdapterRequestContext,
  type StructuralRequestContextDiagnostics,
  type StructuralAdapterRegistry,
  type StructuralCoverageDiagnostics,
  testSourcePairingAdapter,
} from "@oscharko-dev/keiko-workspace/code-intelligence";
import { CancelledError, ERROR_CODES } from "@oscharko-dev/keiko-model-gateway";
import { mapWithConcurrency } from "./bounded-concurrency.js";
import {
  BoundedMetadataPaths,
  MetadataRetention,
  type MetadataRetentionObservation,
} from "./grounded-metadata-retention.js";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import {
  isWorkspacePathSnapshotCurrent,
  nodeWorkspaceFs,
  type WorkspaceDescriptorReadCompleteness,
  type WorkspaceDescriptorUtf8Read,
  type WorkspaceFileReader,
  type WorkspaceHardLinkPolicy,
} from "@oscharko-dev/keiko-workspace/internal/fs";
import { preserveOwnedRootAuthority } from "@oscharko-dev/keiko-workspace/internal/owned-root-preserve";
import {
  normalizeGroundedAnswerPayload,
  type GroundedAnswerPayload,
  type GroundedAnswerResult,
} from "./grounded-answer.js";
import {
  connectedSearchNoEvidenceAnswer,
  buildPackCitationIndex,
  incompleteAnswerMarker,
  missingCitationMarkerFor,
  noEvidenceMarker,
  packHasUsableEvidence,
  unsupportedCitationMarker,
} from "./grounded-faithfulness.js";
import type { EntailmentStage } from "./grounded-entailment-stage.js";
import {
  collectDiscoveredSymbolTraceEvidence,
  collectFollowSymbolTraceEvidence,
  GROUNDED_TRACE_SEARCH_LIMITS,
} from "./grounded-symbol-trace.js";
import {
  defaultGitFileHistoryEvidenceProvider,
  type GitFileHistoryEvidenceProvider,
} from "./grounded-git-history-evidence.js";
import {
  collectConnectedDocumentEvidence,
  isConnectedDocumentPath,
  type DocumentEvidenceResult,
} from "./grounded-document-evidence.js";
import {
  certifiedContentPaths,
  type ContentEvidenceIdentity,
  selectGroundedCandidateFiles,
  pathOnlyEvidencePaths,
  selectGroundedEvidenceAtoms,
  tracePriority,
} from "./grounded-evidence-selection.js";
import { directDefinitionSymbol } from "./grounded-query-shape.js";
import { KnownFitScopeContext } from "./grounded-scope-context.js";
import {
  attachContextBudgetDiagnostics,
  deriveGroundedContextAssembly,
} from "./grounded-context-diagnostics.js";
import { correlationIdOrUnknown } from "./correlation.js";
import {
  createServerLogger,
  errorKindOf,
  reportServerLogFailure,
  startLogTimer,
  type ServerLogEvent,
  type ServerLogger,
  type ServerLogSink,
} from "./observability/index.js";
import { causeChain, keikoStackFrames } from "@oscharko-dev/keiko-activity-log";
import { processServerLogSink } from "./process-log-sink.js";
import { AbortDeadlineRaceError, raceAbortDeadline } from "./abort-race.js";
import {
  resolveRecordedWorkspaceRoot,
  isExpectedWorkspaceRootFailure,
} from "./workspace-root-denial-log.js";

const SEARCH_CONNECTED_CONTEXT_STARTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "search.connected-context.started",
  category: "search",
  owner: "keiko-server",
  emitter: "grounded-orchestrator.createConnectedContextActivity.started",
  fields: {
    scopeKind: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["workspace-root", "directory", "files", "invalid"],
    },
    relativePathCount: { type: "integer", dataClass: "count", required: true },
    explicitConnection: { type: "boolean", dataClass: "closed-enum", required: true },
    scopeIdentitySha256: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    queryKind: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["natural-language", "exact-symbol", "file-pattern", "regex", "invalid"],
    },
    queryIdentitySha256: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    inputStatus: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["valid", "invalid"],
    },
    caseSensitive: { type: "boolean", dataClass: "closed-enum", required: false },
    maxResults: { type: "integer", dataClass: "count", required: false },
    searchCallsMax: { type: "integer", dataClass: "count", required: false },
    filesReadMax: { type: "integer", dataClass: "count", required: false },
    filesReadBounded: { type: "boolean", dataClass: "closed-enum", required: false },
    excerptBytesMax: { type: "integer", dataClass: "count", required: false },
    modelInputTokensMax: { type: "integer", dataClass: "count", required: false },
    modelOutputTokensMax: { type: "integer", dataClass: "count", required: false },
    elapsedMsMax: { type: "integer", dataClass: "duration", required: false },
    elapsedMsBounded: { type: "boolean", dataClass: "closed-enum", required: false },
    rerankCallsMax: { type: "integer", dataClass: "count", required: false },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "start",
  analyzerProjection: "timeline",
  failureClasses: ["connected-context-retrieval"],
  proofIds: ["search.connected-context.started.line"],
  releaseImpact: "patch",
});

const SEARCH_CONNECTED_CONTEXT_COMPLETED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "search.connected-context.completed",
  category: "search",
  owner: "keiko-server",
  emitter: "grounded-orchestrator.createConnectedContextActivity.completed",
  fields: {
    scopeIdentitySha256: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    queryIdentitySha256: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    activityDetailStatus: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["complete", "unavailable"],
    },
    retrievalIntent: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "project-metadata",
        "repository-overview",
        "targeted-code-search",
        "diagnostic-search",
        "clarification-needed",
      ],
    },
    retrievalTargetDecision: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["literal-search", "direct-fact", "contextual"],
    },
    retrievalTargetCount: { type: "integer", dataClass: "count", required: false },
    retrievalAnchorCount: { type: "integer", dataClass: "count", required: false },
    plannedRingCount: { type: "integer", dataClass: "count", required: false },
    executedRingKinds: {
      type: "string-array",
      dataClass: "closed-enum",
      required: false,
      maxItems: 3,
      values: ["lexical", "structural", "git-history"],
    },
    skippedRingKinds: {
      type: "string-array",
      dataClass: "closed-enum",
      required: false,
      maxItems: 3,
      values: ["lexical", "structural", "git-history"],
    },
    ringSkipReasons: {
      type: "string-array",
      dataClass: "closed-enum",
      required: false,
      maxItems: 5,
      values: [
        "no-git-metadata",
        "ordinary-document",
        "literal-absence",
        "complete-exact-lookup",
        "verified-target-context",
      ],
    },
    augmentationSkipped: { type: "boolean", dataClass: "closed-enum", required: false },
    augmentationSkipReason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "no-git-metadata",
        "ordinary-document",
        "literal-absence",
        "complete-exact-lookup",
        "verified-target-context",
        "budget-exhausted",
      ],
    },
    usageSearchCalls: { type: "integer", dataClass: "count", required: false },
    usageFilesRead: { type: "integer", dataClass: "count", required: false },
    usageExcerptBytes: { type: "integer", dataClass: "count", required: false },
    excerptAnchoredWindowCount: { type: "integer", dataClass: "count", required: false },
    excerptReadWindowCount: { type: "integer", dataClass: "count", required: false },
    excerptOmittedRangeCount: { type: "integer", dataClass: "count", required: false },
    excerptTruncatedWindowCount: { type: "integer", dataClass: "count", required: false },
    excerptUnreadFileCount: { type: "integer", dataClass: "count", required: false },
    excerptStopReasons: {
      type: "string-array",
      dataClass: "closed-enum",
      required: false,
      maxItems: 3,
      values: ["file-grant", "byte-grant", "deadline"],
    },
    metadataObservedCount: { type: "integer", dataClass: "count", required: false },
    metadataRetainedCount: { type: "integer", dataClass: "count", required: false },
    metadataDiscardedCount: { type: "integer", dataClass: "count", required: false },
    metadataOmittedDetailCount: { type: "integer", dataClass: "count", required: false },
    metadataRetentionLimit: { type: "integer", dataClass: "count", required: false },
    usageModelInputTokens: { type: "integer", dataClass: "count", required: false },
    usageModelOutputTokens: { type: "integer", dataClass: "count", required: false },
    usageElapsedMs: { type: "integer", dataClass: "duration", required: false },
    usageRerankCalls: { type: "integer", dataClass: "count", required: false },
    selectedFileCount: { type: "integer", dataClass: "count", required: false },
    scopeContextSelectedFileCount: { type: "integer", dataClass: "count", required: false },
    contextSelectedExcerptCount: { type: "integer", dataClass: "count", required: false },
    contextSelectedExcerptEstimatedTokens: { type: "integer", dataClass: "count", required: false },
    contextBudgetPressure: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["low", "moderate", "high", "exceeded"],
    },
    contextRecencyLayoutApplied: { type: "boolean", dataClass: "closed-enum", required: false },
    omittedCount: { type: "integer", dataClass: "count", required: false },
    uncertaintyCount: { type: "integer", dataClass: "count", required: false },
    scopeIncompleteUncertaintyCount: { type: "integer", dataClass: "count", required: false },
    budgetClippedUncertaintyCount: { type: "integer", dataClass: "count", required: false },
    toolUnavailableUncertaintyCount: { type: "integer", dataClass: "count", required: false },
    unsupportedClaimUncertaintyCount: { type: "integer", dataClass: "count", required: false },
    entailmentUnavailableUncertaintyCount: { type: "integer", dataClass: "count", required: false },
    coverageStatus: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["not-reported", "incomplete", "complete"],
    },
    coverageReasons: {
      type: "string-array",
      dataClass: "closed-enum",
      required: false,
      maxItems: 6,
      values: ["aborted", "file-cap", "match-cap", "timeout", "depth-pruned", "io-error"],
    },
    coverageFilesDiscovered: { type: "integer", dataClass: "count", required: false },
    coverageFilesScanned: { type: "integer", dataClass: "count", required: false },
    coverageFilesSkipped: { type: "integer", dataClass: "count", required: false },
    coverageDepthPruned: { type: "integer", dataClass: "count", required: false },
    coverageMaxFilesPruned: { type: "integer", dataClass: "count", required: false },
    retrievalReadBudgetBlocked: { type: "boolean", dataClass: "closed-enum", required: false },
    retrievalElapsedBudgetBlocked: { type: "boolean", dataClass: "closed-enum", required: false },
    retrievalWorkspaceIndexProviderStatus: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["not-evaluated", "available", "unavailable"],
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["connected-context-retrieval"],
  proofIds: ["search.connected-context.completed.line"],
  releaseImpact: "patch",
});

const SEARCH_CONNECTED_CONTEXT_COMPLETION_DETAILS_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "search.connected-context.completion-details",
  category: "search",
  owner: "keiko-server",
  emitter: "grounded-orchestrator.createConnectedContextActivity.completionDetails",
  fields: {
    scopeIdentitySha256: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    queryIdentitySha256: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    activityDetailStatus: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["complete", "unavailable"],
    },
    structuralContextCount: { type: "integer", dataClass: "count", required: false },
    structuralCandidateInventoryBuildCount: {
      type: "integer",
      dataClass: "count",
      required: false,
    },
    structuralCandidateFileCount: { type: "integer", dataClass: "count", required: false },
    structuralCandidateDirectoryCount: { type: "integer", dataClass: "count", required: false },
    structuralCodeIndexBuildCount: { type: "integer", dataClass: "count", required: false },
    structuralSymbolGraphBuildCount: { type: "integer", dataClass: "count", required: false },
    structuralImportGraphBuildCount: { type: "integer", dataClass: "count", required: false },
    structuralEndpointGraphBuildCount: { type: "integer", dataClass: "count", required: false },
    structuralFileSearchCount: { type: "integer", dataClass: "count", required: false },
    structuralTextSearchCount: { type: "integer", dataClass: "count", required: false },
    indexProviderStatus: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["not-evaluated", "available", "unavailable"],
    },
    indexSearchMode: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "not-evaluated",
        "unused",
        "live-fallback",
        "persistent-cold",
        "persistent-warm",
        "persistent-reconciled",
        "request-local-cold",
        "request-local-warm",
        "request-local-reconciled",
      ],
    },
    indexLoadStatus: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["not-attempted", "hit", "miss", "mixed", "failed"],
    },
    indexSaveStatus: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["not-attempted", "succeeded", "unfinished", "failed"],
    },
    indexIndexedRecords: { type: "integer", dataClass: "count", required: false },
    indexReusedRecords: { type: "integer", dataClass: "count", required: false },
    indexStaleRecords: { type: "integer", dataClass: "count", required: false },
    indexSearchCount: { type: "integer", dataClass: "count", required: false },
    indexReportCount: { type: "integer", dataClass: "count", required: false },
    indexFallbackSearchCount: { type: "integer", dataClass: "count", required: false },
    indexLoadFailures: { type: "integer", dataClass: "count", required: false },
    indexSaveFailures: { type: "integer", dataClass: "count", required: false },
    workspaceIoReadDirCalls: { type: "integer", dataClass: "count", required: false },
    workspaceIoReadDirEntries: { type: "integer", dataClass: "count", required: false },
    workspaceIoStatCalls: { type: "integer", dataClass: "count", required: false },
    workspaceIoRealPathCalls: { type: "integer", dataClass: "count", required: false },
    workspaceIoExistsCalls: { type: "integer", dataClass: "count", required: false },
    workspaceIoContentReadCalls: { type: "integer", dataClass: "count", required: false },
    workspaceIoContentReadBytes: { type: "integer", dataClass: "count", required: false },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["connected-context-retrieval"],
  proofIds: ["search.connected-context.completion-details.line"],
  releaseImpact: "patch",
});

const SEARCH_CONNECTED_CONTEXT_FAILED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "search.connected-context.failed",
  category: "search",
  owner: "keiko-server",
  emitter: "grounded-orchestrator.createConnectedContextActivity.failed",
  fields: {
    scopeIdentitySha256: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    queryIdentitySha256: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    activityDetailStatus: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["complete", "unavailable"],
    },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["failed", "cancelled"],
    },
    failureKind: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
    retrievalPhase: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "request-validation",
        "planning",
        "workspace-admission",
        "budget-evaluation",
        "workspace-detection",
        "ring-retrieval",
        "pack-assembly",
        "empty-pack-assembly",
      ],
    },
    plannedRingCount: { type: "integer", dataClass: "count", required: true },
    structuralContextCount: { type: "integer", dataClass: "count", required: true },
    structuralCandidateInventoryBuildCount: { type: "integer", dataClass: "count", required: true },
    structuralCandidateFileCount: { type: "integer", dataClass: "count", required: true },
    structuralCandidateDirectoryCount: { type: "integer", dataClass: "count", required: true },
    structuralCodeIndexBuildCount: { type: "integer", dataClass: "count", required: true },
    structuralSymbolGraphBuildCount: { type: "integer", dataClass: "count", required: true },
    structuralImportGraphBuildCount: { type: "integer", dataClass: "count", required: true },
    structuralEndpointGraphBuildCount: { type: "integer", dataClass: "count", required: true },
    structuralFileSearchCount: { type: "integer", dataClass: "count", required: true },
    structuralTextSearchCount: { type: "integer", dataClass: "count", required: true },
    indexProviderStatus: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["not-evaluated", "available", "unavailable"],
    },
    indexSearchMode: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "not-evaluated",
        "unused",
        "live-fallback",
        "persistent-cold",
        "persistent-warm",
        "persistent-reconciled",
        "request-local-cold",
        "request-local-warm",
        "request-local-reconciled",
      ],
    },
    indexLoadStatus: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["not-attempted", "hit", "miss", "mixed", "failed"],
    },
    indexSaveStatus: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["not-attempted", "succeeded", "unfinished", "failed"],
    },
    indexIndexedRecords: { type: "integer", dataClass: "count", required: true },
    indexReusedRecords: { type: "integer", dataClass: "count", required: true },
    indexStaleRecords: { type: "integer", dataClass: "count", required: true },
    indexSearchCount: { type: "integer", dataClass: "count", required: true },
    indexReportCount: { type: "integer", dataClass: "count", required: true },
    indexFallbackSearchCount: { type: "integer", dataClass: "count", required: true },
    indexLoadFailures: { type: "integer", dataClass: "count", required: true },
    indexSaveFailures: { type: "integer", dataClass: "count", required: true },
    workspaceIoReadDirCalls: { type: "integer", dataClass: "count", required: true },
    workspaceIoReadDirEntries: { type: "integer", dataClass: "count", required: true },
    workspaceIoStatCalls: { type: "integer", dataClass: "count", required: true },
    workspaceIoRealPathCalls: { type: "integer", dataClass: "count", required: true },
    workspaceIoExistsCalls: { type: "integer", dataClass: "count", required: true },
    workspaceIoContentReadCalls: { type: "integer", dataClass: "count", required: true },
    workspaceIoContentReadBytes: { type: "integer", dataClass: "count", required: true },
    frames: {
      type: "string-array",
      dataClass: "safe-platform-class",
      required: false,
      maxLength: 512,
      maxItems: 8,
    },
    causeChain: {
      type: "string-array",
      dataClass: "error-kind",
      required: false,
      maxLength: 128,
      maxItems: 5,
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["connected-context-retrieval"],
  proofIds: ["search.connected-context.failed.line"],
  releaseImpact: "patch",
});

// ─── Public types ─────────────────────────────────────────────────────────────

export interface GroundedAnswerer {
  // The seam the route uses: production supplies a Model Gateway-backed answerer, while tests can
  // keep deterministic answerers.
  answer(question: string, pack: ConnectedContextPack): Promise<GroundedAnswerPayload>;
}

export interface OrchestratorInput {
  readonly scope: SelectedScope;
  readonly query: RetrievalQuery;
  // The original query remains authoritative for every retrieval ring. Callers may supply a
  // separately assembled answer question (for example with governed memory context) so personal
  // context can inform generation without changing repository retrieval decisions.
  readonly answerQuestion?: string | undefined;
  /** Current user wording, before retrieval continuity or answer-only memory is appended. */
  readonly currentQuestion?: string | undefined;
  readonly answerOnlyContextAvailable?: boolean | undefined;
  readonly workspaceRoot: string;
  // Request-scoped filesystem authority for the exact canonical root. Ordinary callers omit it;
  // managed-task callers receive it only after the lifecycle owner has re-proved the persisted
  // instance and paired app session. It is never serialized into evidence or wire payloads.
  readonly workspaceFs?: WorkspaceFs | undefined;
  readonly budget?: ExplorationBudget;
}

export interface OrchestratorDeps {
  readonly answerer: GroundedAnswerer;
  readonly nowMs?: () => number;
  readonly signal?: AbortSignal | undefined;
  // Activity evidence for the retrieval-only operation. Production resolves the shared process
  // sink; tests may inject a buffer without replacing the process-wide logger.
  readonly activityLog?: ServerLogSink | undefined;
  // Optional injected port for tests; production uses the realpath-contained node adapter.
  readonly fs?: WorkspaceFs;
  // Optional injected detector for tests so memFs fixtures don't need full WorkspaceInfo wiring.
  readonly detectWorkspace?: (root: string, fs: WorkspaceFs) => WorkspaceInfo;
  // Called after a ready plan exists and before any workspace detection or repository IO starts.
  readonly recordPlan?: (plan: ExplorationPlan) => void;
  // Ephemeral #183 context-pack cache for one connected scope/session.
  readonly microIndex?: MicroIndex;
  readonly contextPackReranker?: RerankerSeam | undefined;
  readonly repoSemanticSearchProvider?: SemanticSearchProvider | undefined;
  readonly gitFileHistoryEvidence?: GitFileHistoryEvidenceProvider | undefined;
  // ADR-0173 D5 — the request-scoped correlation id, already carried this far for the Gateway
  // answerer. Threaded on to the git-history evidence provider so a git read that silently emptied
  // this ask's history ring is joinable to the ask itself in `server.log` (AGENTS.md §8 Rule 1).
  //
  // REQUIRED, not optional-with-a-fallback. Three production paths reach retrieval — single-folder,
  // multi-source and hybrid — and each builds this object by hand. Two of them shipped without the
  // id and stamped every git-history failure `UNKNOWN_CORRELATION_ID`, which type-checked perfectly
  // because the field was optional. `undefined` is still an accepted VALUE (a caller genuinely
  // without a request id says so explicitly, and the provider falls back at the emitting site);
  // what the compiler now refuses is a call site that never considered it.
  readonly correlationId: string | undefined;
  // Optional context profile (ADR-0055 D1, PR4-W1). When absent (legacy callers, multi-source and
  // hybrid paths in W1), the diagnostics observer is NOT invoked and the assembled pack is
  // byte-identical to today. When present, the observer attaches ContextAssemblyDiagnostics-derived
  // ContextBudget to pack.diagnostics.contextBudget? — an additive field no prompt builder reads.
  readonly contextProfile?: ContextProfile | undefined;
  // Issue #1736 — optional production index provider. Tests and unsupported runtime dirs omit it;
  // the lexical ring falls back to bounded live scans.
  readonly workspaceIndexForRoot?:
    ((workspaceRoot: string) => WorkspaceIndex | undefined) | undefined;
  readonly semanticSearchProvider?: SemanticSearchProvider | undefined;
  // Knowledge M1.2 (#2563) — optional injected entailment stage. When present AND a compatible judge
  // model is configured, the model's cited claims are judged for SUPPORT (not just membership) after
  // answering, and any unsupported-claim / entailment-unavailable markers are appended to the pack's
  // uncertainty. Absent (the default, and every legacy caller/test) ⇒ byte-identical to today.
  readonly entailmentStage?: EntailmentStage | undefined;
}

export interface OrchestratorOutput {
  readonly pack: ConnectedContextPack;
  readonly assistantContent: string;
  readonly elapsedMs: number;
  readonly plan?: ExplorationPlan;
  // GEN-AI-GROUNDING-002/-003 (RB-4): true when the folder path ABSTAINED because the assembled
  // pack carried no usable evidence. The model was NOT called; assistantContent is the deterministic
  // no-evidence answer. Callers must suppress citations and skip persisting grounded evidence.
  readonly noEvidence?: boolean;
  // Distinguishes a deterministic no-evidence abstention from an answer generated over explicit
  // answer-only context. Citation and entailment checks follow model invocation; evidence
  // persistence follows source availability.
  readonly modelInvoked?: boolean;
  // The share the answer's sent prompt took, for the context meter. Counts only.
  readonly promptContext?: GroundedPromptContextWire | undefined;
}

// Epic #532 — retrieval-only output. The multi-source (1+N) path runs retrieval per connected
// source, then answers ONCE over the merged packs, so it needs the pack without a per-scope
// answer. `elapsedMs` here is retrieval-only wall time (no model call), distinct from
// OrchestratorOutput.elapsedMs which also includes the answer.
export interface RetrievalOnlyOutput {
  readonly pack: ConnectedContextPack;
  readonly elapsedMs: number;
  readonly plan: ExplorationPlan;
}

// Raised when the planner asks for clarification (no anchors, too-generic prompt, etc.). The
// route maps this to a 400 BAD_REQUEST via clarificationUserMessage below; the Error message
// itself keeps the stable machine-ish form for logs and tests.
export class ClarificationNeededError extends Error {
  public constructor(public readonly clarification: ClarificationPrompt) {
    super(`clarification needed: ${clarification.reason}`);
    this.name = "ClarificationNeededError";
  }
}

// Release 0.2.0 — user-facing mapping for a planner clarification. The raw reason string
// ("clarification needed: too-generic") told the user nothing actionable; the HTTP message now
// says what the planner needs and folds in the planner's own suggested questions. Static text
// plus planner-built suggestions only — no user/file content, so nothing to redact.
function clarificationIntro(reason: ClarificationReason): string {
  if (reason === "scope-empty") return "Die verbundene Quelle enthält nichts Durchsuchbares.";
  if (reason === "scope-invalid") return "Die verbundene Quelle konnte nicht durchsucht werden.";
  return "Keiko braucht mehr Kontext, um die verbundenen Quellen gezielt zu durchsuchen.";
}

export function clarificationUserMessage(error: ClarificationNeededError): string {
  const { reason, suggestedQuestions } = error.clarification;
  const intro = clarificationIntro(reason);
  const anchorHint =
    reason === "no-anchors" || reason === "too-generic"
      ? " Nenne eine konkrete Datei, einen Identifier, eine Fehlermeldung oder eine exakte Phrase."
      : "";
  const examples = suggestedQuestions.slice(0, 2);
  const quotedExamples = examples.map((q) => `"${q}"`).join(" oder ");
  const exampleText = examples.length > 0 ? ` Zum Beispiel: ${quotedExamples}` : "";
  return `${intro}${anchorHint}${exampleText}`;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

interface SearchInputs {
  readonly discoverDefinitions: (
    governor: GovernorState,
    evidence: RingEvidenceAccumulator,
  ) => Promise<DefinitionDiscoveryExecution>;
  readonly scopeContextBytesMax: number;
  readonly tryReserveAdditionalSearchCall?: (() => boolean) | undefined;
  readonly hasGitMetadata: boolean;
  readonly searchScope: SearchScope;
  readonly query: RetrievalQuery;
  readonly targetDecision: QueryTargetDecision;
  readonly anchors: readonly SearchAnchor[];
  readonly retrievalIntent: RetrievalIntent;
  readonly fs: WorkspaceFs;
  readonly nowMs: () => number;
  readonly signal?: AbortSignal | undefined;
  readonly workspaceIndex?: WorkspaceIndex | undefined;
  readonly workspaceIndexActivity: WorkspaceIndexActivity;
  readonly repoSemanticSearchProvider?: SemanticSearchProvider | undefined;
  readonly gitFileHistoryEvidence: GitFileHistoryEvidenceProvider;
  readonly correlationId?: string | undefined;
  readonly structuralContexts: StructuralRequestContextPool;
  readonly deadlineAtMs: number;
}

interface StructuralRequestContextPoolDiagnostics extends StructuralRequestContextDiagnostics {
  readonly contextCount: number;
}

interface StructuralRequestContextPool {
  readonly forLimits: (limits: SearchLimits) => StructuralAdapterRequestContext;
  readonly diagnostics: () => StructuralRequestContextPoolDiagnostics;
}

type WorkspaceIndexProviderStatus = "not-evaluated" | "available" | "unavailable";
type WorkspaceIndexSearchMode =
  | "not-evaluated"
  | "unused"
  | "live-fallback"
  | "persistent-cold"
  | "persistent-warm"
  | "persistent-reconciled"
  | "request-local-cold"
  | "request-local-warm"
  | "request-local-reconciled";
type WorkspaceIndexLoadStatus = "not-attempted" | "hit" | "miss" | "mixed" | "failed";
type WorkspaceIndexSaveStatus = "not-attempted" | "succeeded" | "unfinished" | "failed";

interface WorkspaceIndexActivityDiagnostics extends WorkspaceIndexPreparationReport {
  readonly providerStatus: WorkspaceIndexProviderStatus;
  readonly searchMode: WorkspaceIndexSearchMode;
  readonly loadStatus: WorkspaceIndexLoadStatus;
  readonly saveStatus: WorkspaceIndexSaveStatus;
  readonly searchCount: number;
  readonly reportCount: number;
  readonly fallbackSearchCount: number;
  readonly loadAttempts: number;
  readonly loadHits: number;
  readonly loadMisses: number;
  readonly loadFailures: number;
  readonly saveAttempts: number;
  readonly saveSuccesses: number;
  readonly saveFailures: number;
}

interface MutableWorkspaceIndexActivityCounters {
  discoveredEntries: number;
  retainedEntries: number;
  indexedRecords: number;
  reusedRecords: number;
  staleRecords: number;
  skippedEntries: number;
  deletedEntries: number;
  droppedRecords: number;
  searchCount: number;
  reportCount: number;
  fallbackSearchCount: number;
  loadAttempts: number;
  loadHits: number;
  loadMisses: number;
  loadFailures: number;
  saveAttempts: number;
  saveSuccesses: number;
  saveFailures: number;
}

interface WorkspaceIndexActivity {
  readonly workspaceIndex: WorkspaceIndex | undefined;
  readonly recordSearchResult: (result: SearchResult) => void;
  readonly diagnostics: () => WorkspaceIndexActivityDiagnostics;
}

interface WorkspaceIoActivityDiagnostics {
  readonly readDirCalls: number;
  readonly readDirEntries: number;
  readonly statCalls: number;
  readonly realPathCalls: number;
  readonly existsCalls: number;
  readonly contentReadCalls: number;
  readonly contentReadBytes: number;
}

type MutableWorkspaceIoActivityCounters = {
  -readonly [Key in keyof WorkspaceIoActivityDiagnostics]: WorkspaceIoActivityDiagnostics[Key];
};

interface WorkspaceIoActivity {
  readonly fs: WorkspaceFs;
  readonly diagnostics: () => WorkspaceIoActivityDiagnostics;
}

function searchLimitsKey(limits: SearchLimits): string {
  return JSON.stringify([
    limits.maxFilesScanned,
    limits.maxMatchesReturned,
    limits.maxBytesPerFileScanned,
    limits.elapsedMsMax,
  ]);
}

function sumContextDiagnostics(
  contexts: readonly StructuralAdapterRequestContext[],
): StructuralRequestContextPoolDiagnostics {
  const values = contexts.map((context) => context.diagnostics());
  const sum = (key: keyof StructuralRequestContextDiagnostics): number =>
    values.reduce((total, value) => total + value[key], 0);
  return {
    contextCount: contexts.length,
    candidateInventoryBuildCount: sum("candidateInventoryBuildCount"),
    candidateFileCount: sum("candidateFileCount"),
    candidateDirectoryCount: sum("candidateDirectoryCount"),
    codeIndexBuildCount: sum("codeIndexBuildCount"),
    symbolGraphBuildCount: sum("symbolGraphBuildCount"),
    importGraphBuildCount: sum("importGraphBuildCount"),
    endpointGraphBuildCount: sum("endpointGraphBuildCount"),
    fileSearchCount: sum("fileSearchCount"),
    textSearchCount: sum("textSearchCount"),
  };
}

function emptyWorkspaceIndexActivityCounters(): MutableWorkspaceIndexActivityCounters {
  return {
    discoveredEntries: 0,
    retainedEntries: 0,
    indexedRecords: 0,
    reusedRecords: 0,
    staleRecords: 0,
    skippedEntries: 0,
    deletedEntries: 0,
    droppedRecords: 0,
    searchCount: 0,
    reportCount: 0,
    fallbackSearchCount: 0,
    loadAttempts: 0,
    loadHits: 0,
    loadMisses: 0,
    loadFailures: 0,
    saveAttempts: 0,
    saveSuccesses: 0,
    saveFailures: 0,
  };
}

function stoppedBeforeWorkspaceScan(result: SearchResult): boolean {
  return (
    result.workspaceIndex === undefined &&
    result.filesScanned === 0 &&
    result.diagnostics === undefined &&
    result.coverage.filesDiscovered === 0 &&
    result.coverage.reasons.some((reason) => reason === "aborted" || reason === "timeout")
  );
}

function addWorkspaceIndexResult(
  counters: MutableWorkspaceIndexActivityCounters,
  result: SearchResult,
): void {
  counters.searchCount += 1;
  const report = result.workspaceIndex;
  if (report === undefined) {
    if (!stoppedBeforeWorkspaceScan(result)) counters.fallbackSearchCount += 1;
    return;
  }
  counters.reportCount += 1;
  counters.discoveredEntries += report.discoveredEntries;
  counters.retainedEntries += report.retainedEntries;
  counters.indexedRecords += report.indexedRecords;
  counters.reusedRecords += report.reusedRecords;
  counters.staleRecords += report.staleRecords;
  counters.skippedEntries += report.skippedEntries;
  counters.deletedEntries += report.deletedEntries;
  counters.droppedRecords += report.droppedRecords;
}

function workspaceIndexPersistenceSucceeded(
  providerStatus: WorkspaceIndexProviderStatus,
  counters: MutableWorkspaceIndexActivityCounters,
): boolean {
  if (providerStatus !== "available") return false;
  return counters.loadHits > 0 || counters.saveSuccesses > 0;
}

function workspaceIndexSearchMode(
  providerStatus: WorkspaceIndexProviderStatus,
  counters: MutableWorkspaceIndexActivityCounters,
): WorkspaceIndexSearchMode {
  if (providerStatus === "not-evaluated") return "not-evaluated";
  if (counters.searchCount === 0) return "unused";
  if (counters.reportCount === 0) {
    return counters.fallbackSearchCount > 0 ? "live-fallback" : "unused";
  }
  const reconciled = counters.staleRecords + counters.deletedEntries + counters.droppedRecords > 0;
  const persistent = workspaceIndexPersistenceSucceeded(providerStatus, counters);
  if (reconciled) return persistent ? "persistent-reconciled" : "request-local-reconciled";
  if (counters.reusedRecords > 0) return persistent ? "persistent-warm" : "request-local-warm";
  return persistent ? "persistent-cold" : "request-local-cold";
}

function workspaceIndexLoadStatus(
  counters: MutableWorkspaceIndexActivityCounters,
): WorkspaceIndexLoadStatus {
  if (counters.loadFailures > 0) return "failed";
  if (counters.loadHits > 0 && counters.loadMisses > 0) return "mixed";
  if (counters.loadHits > 0) return "hit";
  if (counters.loadMisses > 0) return "miss";
  return "not-attempted";
}

function workspaceIndexSaveStatus(
  counters: MutableWorkspaceIndexActivityCounters,
): WorkspaceIndexSaveStatus {
  if (counters.saveFailures > 0) return "failed";
  if (counters.saveSuccesses > 0) return "succeeded";
  return counters.saveAttempts > 0 ? "unfinished" : "not-attempted";
}

function workspaceIndexActivityDiagnostics(
  providerStatus: WorkspaceIndexProviderStatus,
  counters: MutableWorkspaceIndexActivityCounters,
): WorkspaceIndexActivityDiagnostics {
  return {
    providerStatus,
    searchMode: workspaceIndexSearchMode(providerStatus, counters),
    loadStatus: workspaceIndexLoadStatus(counters),
    saveStatus: workspaceIndexSaveStatus(counters),
    ...counters,
  };
}

function observedWorkspaceIndex(
  source: WorkspaceIndex,
  counters: MutableWorkspaceIndexActivityCounters,
): WorkspaceIndex {
  return {
    loadSnapshot: async (scopeKey): ReturnType<WorkspaceIndex["loadSnapshot"]> => {
      counters.loadAttempts += 1;
      try {
        const snapshot = await source.loadSnapshot(scopeKey);
        if (snapshot === undefined) counters.loadMisses += 1;
        else counters.loadHits += 1;
        return snapshot;
      } catch (error) {
        counters.loadFailures += 1;
        throw error;
      }
    },
    saveSnapshot: async (scopeKey, snapshot): Promise<void> => {
      counters.saveAttempts += 1;
      try {
        await source.saveSnapshot(scopeKey, snapshot);
        counters.saveSuccesses += 1;
      } catch (error) {
        counters.saveFailures += 1;
        throw error;
      }
    },
  };
}

function createWorkspaceIndexActivity(source: WorkspaceIndex | undefined): WorkspaceIndexActivity {
  const providerStatus = source === undefined ? "unavailable" : "available";
  const counters = emptyWorkspaceIndexActivityCounters();
  return {
    workspaceIndex: source === undefined ? undefined : observedWorkspaceIndex(source, counters),
    recordSearchResult: (result): void => {
      addWorkspaceIndexResult(counters, result);
    },
    diagnostics: (): WorkspaceIndexActivityDiagnostics =>
      workspaceIndexActivityDiagnostics(providerStatus, counters),
  };
}

function observedStructuralContext(
  context: StructuralAdapterRequestContext,
  activity: WorkspaceIndexActivity,
): StructuralAdapterRequestContext {
  return {
    assertGraphBinding: context.assertGraphBinding.bind(context),
    candidatePaths: context.candidatePaths.bind(context),
    skippedSymbolicLinks: context.skippedSymbolicLinks.bind(context),
    candidateLimitReached: context.candidateLimitReached.bind(context),
    codeIntelligenceIndex: context.codeIntelligenceIndex.bind(context),
    symbolGraph: context.symbolGraph.bind(context),
    importGraph: context.importGraph.bind(context),
    endpointContractGraph: context.endpointContractGraph.bind(context),
    findFiles: context.findFiles.bind(context),
    searchText: async (
      query,
      limits,
      deps,
    ): ReturnType<StructuralAdapterRequestContext["searchText"]> => {
      const result = await context.searchText(query, limits, deps);
      activity.recordSearchResult(result);
      return result;
    },
    diagnostics: context.diagnostics.bind(context),
  };
}

function createStructuralRequestContextPool(
  scope: SearchScope,
  fs: WorkspaceFs,
  nowMs: () => number,
  deadlineAtMs: number,
  workspaceIndexActivity: WorkspaceIndexActivity,
  signal?: AbortSignal,
): StructuralRequestContextPool {
  const contexts = new Map<string, StructuralAdapterRequestContext>();
  return {
    forLimits: (limits): StructuralAdapterRequestContext => {
      const key = searchLimitsKey(limits);
      const existing = contexts.get(key);
      if (existing !== undefined) return existing;
      const created = observedStructuralContext(
        createStructuralAdapterRequestContext(scope, limits, fs, {
          nowMs,
          deadlineAtMs,
          ...(signal === undefined ? {} : { signal }),
        }),
        workspaceIndexActivity,
      );
      contexts.set(key, created);
      return created;
    },
    diagnostics: (): StructuralRequestContextPoolDiagnostics =>
      sumContextDiagnostics([...contexts.values()]),
  };
}

interface RingResult {
  readonly knownFitFileBytes?: ReadonlyMap<string, number> | undefined;
  readonly primaryContentIdentities?: readonly ContentEvidenceIdentity[];
  readonly atoms: readonly EvidenceAtom[];
  readonly omitted: readonly OmittedContextEntry[];
  readonly uncertainty: readonly UncertaintyMarker[];
  readonly usage: ExplorationUsage;
  // Explainable-ranking diagnostics from the lexical ring's candidate ordering (M2). Only the
  // lexical ring populates this; structural/git rings leave it undefined.
  readonly diagnostics?: ContextPackDiagnostics | undefined;
}

// Maps the workspace-layer SearchDiagnostics.rankedCandidates onto the contract pack-diagnostics
// shape. Structurally identical (path/bucket/score/ecosystem/signals) but mapped explicitly so the
// workspace and contracts types stay decoupled. Coverage may still be present when ranking is absent.
function toPackDiagnostics(result: Awaited<ReturnType<typeof searchText>>): ContextPackDiagnostics {
  const diagnostics = result.diagnostics;
  const coverage = (result as { readonly coverage?: ContextCoverageDiagnostics }).coverage;
  const coverageDiagnostics = coverage === undefined ? {} : { coverage };
  if (diagnostics === undefined) {
    return {
      rankedCandidates: [],
      ...coverageDiagnostics,
    };
  }
  return {
    rankedCandidates: diagnostics.rankedCandidates.map((entry) => ({
      scopePath: entry.scopePath,
      bucket: entry.bucket,
      score: entry.score,
      ecosystem: entry.ecosystem,
      signals: entry.signals.map((signal) => ({ name: signal.name, value: signal.value })),
    })),
    ...coverageDiagnostics,
  };
}

function onlyRetainedMatchesLimited(coverage: ContextCoverageDiagnostics): boolean {
  return (
    coverage.reasons.length === 1 &&
    coverage.reasons[0] === "match-cap" &&
    coverage.filesScanned === coverage.filesAfterPolicy &&
    coverage.depthPrunedByDiscovery === 0 &&
    coverage.maxFilesPrunedByDiscovery === 0
  );
}

function discoveryCoverageMarker(
  subject: string,
  coverage: ContextCoverageDiagnostics,
  details: string,
  nowMs: number,
): UncertaintyMarker {
  const retainedMatchesLimited = onlyRetainedMatchesLimited(coverage);
  return {
    kind: retainedMatchesLimited ? "budget-clipped" : "scope-incomplete",
    claim: retainedMatchesLimited
      ? `${subject}: all eligible files were searched; additional matching results were omitted from retained evidence (${details}); missing retained evidence does not prove a file or fact absent`
      : `${subject} coverage was incomplete (${details}); relevant files may be missing from the context pack`,
    impactedAtomIds: [],
    emittedAtMs: nowMs,
  };
}

function coverageUncertainty(
  result: Awaited<ReturnType<typeof searchText>>,
  nowMs: number,
): readonly UncertaintyMarker[] {
  const coverage = result.coverage;
  if (!coverage.incomplete) {
    return [];
  }
  const diagnostics = result.diagnostics;
  const details =
    diagnostics === undefined
      ? `scanned ${String(coverage.filesScanned)} file(s), reasons ${coverage.reasons.join(", ")}`
      : [
          `reasons ${coverage.reasons.join(", ")}`,
          `discovered ${String(coverage.filesDiscovered)} file(s)`,
          `kept ${String(coverage.filesAfterPolicy)} after policy`,
          `scanned ${String(coverage.filesScanned)}`,
          `oversized-prefix ${String(coverage.oversizedFilesScanned ?? 0)}`,
          `low-value-rescue-discovered ${String(coverage.lowValueRescueFilesDiscovered ?? 0)}`,
          `low-value-rescue-scanned ${String(coverage.lowValueRescueFilesScanned ?? 0)}`,
          `ignored ${String(coverage.ignoredByDiscovery)}`,
          `denied ${String(coverage.deniedByDiscovery)}`,
          `depth-pruned ${String(coverage.depthPrunedByDiscovery)}`,
          `max-files-pruned ${String(coverage.maxFilesPrunedByDiscovery)}`,
        ].join(", ");
  return [discoveryCoverageMarker("repository search", coverage, details, nowMs)];
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new CancelledError("grounded repository request cancelled");
  }
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function usageDelta(overrides: Partial<ExplorationUsage> = {}): ExplorationUsage {
  return {
    searchCalls: 0,
    filesRead: 0,
    excerptBytes: 0,
    modelInputTokens: 0,
    modelOutputTokens: 0,
    elapsedMs: 0,
    rerankCalls: 0,
    ...overrides,
  };
}

function clampUsageToBudget(usage: ExplorationUsage, budget: ExplorationBudget): ExplorationUsage {
  return {
    searchCalls: Math.min(usage.searchCalls, budget.searchCallsMax),
    filesRead: Math.min(usage.filesRead, budget.filesReadMax ?? Number.POSITIVE_INFINITY),
    excerptBytes: Math.min(usage.excerptBytes, budget.excerptBytesMax),
    modelInputTokens: Math.min(usage.modelInputTokens, budget.modelInputTokensMax),
    modelOutputTokens: Math.min(usage.modelOutputTokens, budget.modelOutputTokensMax),
    elapsedMs: Math.min(usage.elapsedMs, budget.elapsedMsMax ?? Number.POSITIVE_INFINITY),
    rerankCalls: Math.min(usage.rerankCalls, budget.rerankCallsMax),
  };
}

function budgetClipped(stopReason: string, nowMs: number): UncertaintyMarker {
  return {
    kind: "budget-clipped",
    claim: `repository exploration stopped: ${stopReason}`,
    impactedAtomIds: [],
    emittedAtMs: nowMs,
  };
}

function answerBudgetClipped(dimensions: readonly string[], nowMs: number): UncertaintyMarker {
  return {
    kind: "budget-clipped",
    claim: `grounded answer exceeded budget: ${dimensions.join(", ")}`,
    impactedAtomIds: [],
    emittedAtMs: nowMs,
  };
}

// Delegates to the shared marker factory so all three grounding topologies emit byte-identical
// no-evidence claims (KEIKO-0196). This used to be a hand-copied duplicate of the same literal,
// which is why grounded-faithfulness.ts's noEvidenceMarker had zero production call sites.
function noEvidence(nowMs: number): UncertaintyMarker {
  return noEvidenceMarker(nowMs);
}

function toolUnavailable(claim: string, nowMs: number): UncertaintyMarker {
  return {
    kind: "tool-unavailable",
    claim,
    impactedAtomIds: [],
    emittedAtMs: nowMs,
  };
}

function readBudgetStopReason(budget: ExplorationBudget): string | undefined {
  const exhausted = [
    ...(budget.filesReadMax !== null && budget.filesReadMax <= 0 ? ["filesRead"] : []),
    ...(budget.excerptBytesMax <= 0 ? ["excerptBytes"] : []),
  ];
  if (exhausted.length === 0) {
    return undefined;
  }
  return `budget-exhausted on ${exhausted.join(", ")}`;
}

function omittedFromSearchCandidates(
  candidates: readonly CandidateFile[],
  nowMs: number,
): readonly OmittedContextEntry[] {
  const omitted: OmittedContextEntry[] = [];
  for (const candidate of candidates) {
    if (candidate.omitted === undefined) {
      continue;
    }
    if (!isValidScopePath(candidate.scopePath, { mustBeRelative: true })) {
      continue;
    }
    omitted.push({
      scopePath: candidate.scopePath,
      reason: candidate.omitted,
      omittedAtMs: nowMs,
    });
  }
  return omitted;
}

function safeAdapterName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "");
  return cleaned.length === 0 ? "structural-adapter" : cleaned;
}

function structuralCoverageMarker(
  coverage: StructuralCoverageDiagnostics,
  nowMs: number,
): UncertaintyMarker | undefined {
  const partiallyIndexed = coverage.filesPartiallyIndexed ?? 0;
  if (
    coverage.filesSkipped <= 0 &&
    partiallyIndexed <= 0 &&
    coverage.candidateLimitReached !== true
  ) {
    return undefined;
  }
  const safeName = safeAdapterName(coverage.name);
  return {
    kind: "scope-incomplete",
    claim:
      `structural adapter coverage was incomplete: ${safeName} indexed ` +
      `${String(coverage.filesIndexed)} file(s), skipped ${String(
        coverage.filesSkipped,
      )} file(s), partially indexed ${String(
        partiallyIndexed,
      )} file(s), candidate limit reached=${String(
        coverage.candidateLimitReached === true,
      )}; structural edges may be missing from the context pack`,
    impactedAtomIds: [],
    emittedAtMs: nowMs,
  };
}

function adapterDiagnostics(
  result: {
    readonly unavailable: readonly string[];
    readonly errored: readonly { readonly name: string }[];
    readonly coverage?: readonly StructuralCoverageDiagnostics[] | undefined;
  },
  nowMs: number,
): readonly UncertaintyMarker[] {
  const markers: UncertaintyMarker[] = [];
  const seen = new Set<string>();
  for (const name of result.unavailable) {
    const safeName = safeAdapterName(name);
    if (seen.has(`unavailable:${safeName}`)) {
      continue;
    }
    seen.add(`unavailable:${safeName}`);
    markers.push(toolUnavailable(`structural adapter unavailable: ${safeName}`, nowMs));
  }
  for (const error of result.errored) {
    const safeName = safeAdapterName(error.name);
    if (seen.has(`errored:${safeName}`)) {
      continue;
    }
    seen.add(`errored:${safeName}`);
    markers.push(toolUnavailable(`structural adapter failed safely: ${safeName}`, nowMs));
  }
  for (const coverage of result.coverage ?? []) {
    const marker = structuralCoverageMarker(coverage, nowMs);
    if (marker === undefined) continue;
    const key = `${marker.kind}:${marker.claim}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    markers.push(marker);
  }
  return markers;
}

function dedupeUncertainty(markers: readonly UncertaintyMarker[]): readonly UncertaintyMarker[] {
  const seen = new Set<string>();
  const out: UncertaintyMarker[] = [];
  for (const marker of markers) {
    const key = `${marker.kind}:${marker.claim}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(marker);
  }
  return out;
}

function suppressGitMetadataAdapterDiagnostics(
  markers: readonly UncertaintyMarker[],
  gitFileAtomCount: number,
): readonly UncertaintyMarker[] {
  if (gitFileAtomCount === 0) {
    return markers;
  }
  return markers.filter((marker) => !marker.claim.includes("git-history"));
}

function anchorKindForTerm(
  term: string,
  anchors: readonly SearchAnchor[],
): SearchAnchor["kind"] | undefined {
  return anchors.find((anchor) => anchor.term === term)?.kind;
}

function looksPathAnchor(term: string): boolean {
  return term.includes("/") || /\.[a-z0-9]+$/i.test(term);
}

function queryForStructuralAnchor(
  term: string,
  kind: SearchAnchor["kind"] | undefined,
  base: RetrievalQuery,
): RetrievalQuery {
  return {
    ...base,
    kind:
      kind === "identifier" || (!looksPathAnchor(term) && kind !== "path")
        ? "exact-symbol"
        : "natural-language",
    text: term,
  };
}

function structuralQueriesForRing(
  ring: RetrievalRing,
  inputs: SearchInputs,
): readonly RetrievalQuery[] {
  if (queryTargetsRouteImplementation(inputs.query.text)) {
    return [inputs.query];
  }
  const queries: RetrievalQuery[] = [];
  const seen = new Set<string>();
  for (const term of ring.anchorTerms) {
    const anchorKind = anchorKindForTerm(term, inputs.anchors);
    if (anchorKind !== "path" && anchorKind !== "identifier" && anchorKind !== "quoted") {
      continue;
    }
    const query = queryForStructuralAnchor(term, anchorKind, inputs.query);
    const key = `${query.kind}:${query.text}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    queries.push(query);
  }
  return queries.length === 0 ? [inputs.query] : queries;
}

const MAX_STRUCTURAL_FOLLOW_UP_QUERIES = 6;

function plannedSearchCallsForRing(ring: RetrievalRing, inputs: SearchInputs): number {
  if (ring.kind !== "structural") return 1;
  const followUpCount = queryTargetsRouteImplementation(inputs.query.text)
    ? 0
    : MAX_STRUCTURAL_FOLLOW_UP_QUERIES;
  return structuralQueriesForRing(ring, inputs).length + followUpCount;
}

function mergeAtomsByStableId(
  results: readonly RunRingStructuralResult[],
  cap: number,
): readonly EvidenceAtom[] {
  const atoms: EvidenceAtom[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    for (const atom of result.atoms) {
      if (atoms.length >= cap) {
        return atoms;
      }
      if (seen.has(atom.stableId)) {
        continue;
      }
      seen.add(atom.stableId);
      atoms.push(atom);
    }
  }
  return atoms;
}

function isGitMetadataPath(scopePath: string): boolean {
  return scopePath === ".git" || scopePath.startsWith(".git/");
}

function isRankableFileAtom(
  atom: EvidenceAtom,
  inputs: SearchInputs,
  existsCache: FileExistenceCache,
): boolean {
  return (
    isValidScopePath(atom.scopePath, { mustBeRelative: true }) &&
    !isGitMetadataPath(atom.scopePath) &&
    !isDenied(atom.scopePath) &&
    fileExistsInSearchScope(inputs.searchScope, inputs.fs, atom.scopePath, existsCache)
  );
}

interface RunRingStructuralResult {
  readonly atoms: readonly EvidenceAtom[];
  readonly unavailable: readonly string[];
  readonly errored: readonly { readonly name: string }[];
  readonly coverage: readonly StructuralCoverageDiagnostics[];
  readonly elapsedMs: number;
}

function structuralFollowUpQueries(
  atoms: readonly EvidenceAtom[],
  base: RetrievalQuery,
): readonly RetrievalQuery[] {
  const queries: RetrievalQuery[] = [];
  const seen = new Set<string>([`${base.kind}:${base.text}`]);
  const push = (text: string | undefined, kind: SearchAnchor["kind"]): void => {
    const clean = text?.trim();
    if (
      clean === undefined ||
      clean.length === 0 ||
      queries.length >= MAX_STRUCTURAL_FOLLOW_UP_QUERIES
    ) {
      return;
    }
    const query = queryForStructuralAnchor(clean, kind, base);
    const key = `${query.kind}:${query.text}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    queries.push(query);
  };
  for (const atom of atoms) {
    const edge = atom.edge;
    if (edge === undefined) {
      continue;
    }
    push(edge.target.scopePath, "path");
    push(edge.target.symbol, "identifier");
    push(edge.source.scopePath, "path");
    push(edge.source.symbol, "identifier");
    if (queries.length >= MAX_STRUCTURAL_FOLLOW_UP_QUERIES) {
      break;
    }
  }
  return queries;
}

function structuralEdgeTargetAtoms(
  atoms: readonly EvidenceAtom[],
  inputs: SearchInputs,
): readonly EvidenceAtom[] {
  const out: EvidenceAtom[] = [];
  const seen = new Set<string>();
  const existsCache = createFileExistenceCache();
  const fs = cancellationGuardedWorkspaceFs(inputs.fs, inputs.signal);
  for (const atom of atoms) {
    throwIfCancelled(inputs.signal);
    if (inputs.nowMs() >= inputs.deadlineAtMs) break;
    const edge = atom.edge;
    if (edge === undefined) continue;
    const target = edge.target;
    if (
      target.scopePath === atom.scopePath ||
      !isValidScopePath(target.scopePath, { mustBeRelative: true }) ||
      isDenied(target.scopePath) ||
      !fileExistsInSearchScope(inputs.searchScope, fs, target.scopePath, existsCache)
    ) {
      continue;
    }
    const stableId = evidenceAtomStableId({
      scopeId: inputs.searchScope.scopeId,
      scopePath: target.scopePath,
      lineRange: target.lineRange,
      edge,
      provenanceKind: "structural",
      provenanceTool: "structural-edge-target",
      queryFingerprint: atom.provenance.queryFingerprint,
    });
    if (seen.has(stableId)) {
      continue;
    }
    seen.add(stableId);
    out.push(structuralEdgeTargetAtom(atom, edge, stableId, inputs.nowMs));
  }
  return out;
}

function structuralEdgeTargetAtom(
  atom: EvidenceAtom,
  edge: NonNullable<EvidenceAtom["edge"]>,
  stableId: string,
  nowMs: () => number,
): EvidenceAtom {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId,
    scopePath: edge.target.scopePath,
    lineRange: edge.target.lineRange,
    score: Math.max(0, Math.min(1, atom.score * 0.96)),
    provenance: {
      kind: "structural",
      tool: "structural-edge-target",
      queryFingerprint: atom.provenance.queryFingerprint,
    },
    edge,
    redactionState: "redacted",
    emittedAtMs: nowMs(),
    ledgerRef: undefined,
  };
}

function dedupeAtoms(atoms: readonly EvidenceAtom[], cap: number): readonly EvidenceAtom[] {
  const out: EvidenceAtom[] = [];
  const seen = new Set<string>();
  for (const atom of atoms) {
    if (out.length >= cap) {
      break;
    }
    if (seen.has(atom.stableId)) {
      continue;
    }
    seen.add(atom.stableId);
    out.push(atom);
  }
  return out;
}

type NonLexicalRing = Omit<RetrievalRing, "kind"> & {
  readonly kind: "structural" | "git-history";
};

function primaryLexicalAnchors(
  query: RetrievalQuery,
  anchors: readonly SearchAnchor[],
  retrievalIntent: RetrievalIntent,
  decision = resolveQueryTargetDecision(query, anchors),
): readonly SearchAnchor[] {
  if (query.kind !== "natural-language" || retrievalIntent === "repository-overview") return [];
  if (
    decision.kind === "contextual" &&
    (retrievalIntent === "diagnostic-search" ||
      requiresRelationshipOrHistoryRings(query) ||
      anchors.some(
        (anchor) =>
          anchor.kind === "path" ||
          (anchor.kind === "identifier" && /(?:Test|Tests|Spec)$/iu.test(anchor.term)),
      ))
  )
    return [];
  const sourceTerms = originalQueryAnchorTerms(query);
  return decision.targets.filter(
    (anchor) => anchor.kind === "quoted" || sourceTerms.has(anchor.term),
  );
}

function originalQueryAnchorTerms(query: RetrievalQuery): ReadonlySet<string> {
  const originalText = query.text.toLowerCase();
  const words = query.text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_.$-]+/u)
    .map(trimAnchorEdgeDots);
  // Preserve punctuation inside code quotes only when it occurs in the original text. Canonical
  // technical routing aliases cannot create an exact literal absent from the human's query.
  const original = extractAnchors({ text: query.text, maxAnchors: query.text.length }).anchors;
  return new Set([
    ...words,
    ...original
      .filter((anchor) => anchor.kind === "identifier" && originalText.includes(anchor.term))
      .map((anchor) => anchor.term),
  ]);
}

function trimAnchorEdgeDots(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === ".") start += 1;
  while (start < end && value[end - 1] === ".") end -= 1;
  return value.slice(start, end);
}

function anchoredLexicalTargets(inputs: SearchInputs): readonly string[] {
  return primaryLexicalAnchors(
    inputs.query,
    inputs.anchors,
    inputs.retrievalIntent,
    inputs.targetDecision,
  ).map((anchor) => anchor.term);
}

function primaryContentPaths(rings: RingRunSummary): ReadonlySet<string> {
  // Capture provenance directly at the lexical producer, before later augmentation adds atoms.
  return certifiedContentPaths(rings.atoms, rings.primaryContentIdentities ?? []);
}

function certifiedLexicalContent(
  result: SearchResult,
  inputs: SearchInputs,
): readonly ContentEvidenceIdentity[] {
  const literal =
    !requiresRelationshipOrHistoryRings(inputs.query) &&
    (anchoredLexicalTargets(inputs).length > 0 ||
      inputs.targetDecision.definitionSymbol !== undefined ||
      inputs.query.kind === "exact-symbol");
  return result.atoms
    .filter(
      (atom) =>
        ((literal &&
          atom.provenance.kind === "lexical-search" &&
          atom.provenance.tool === "repo.searchText") ||
          (atom.provenance.kind === "file-listing" && atom.provenance.tool === "repo.findFiles")) &&
        atom.lineRange !== undefined,
    )
    .map((atom) => ({
      stableId: atom.stableId,
      queryFingerprint: atom.provenance.queryFingerprint,
    }));
}

function primaryRankingAnchors(
  input: OrchestratorInput,
  plan: ExplorationPlan,
): readonly SearchAnchor[] {
  const anchors = [
    ...new Map(
      [...plan.anchors, ...(plan.targetDecision?.targets ?? [])].map((anchor) => [
        `${anchor.kind}:${anchor.term}`,
        anchor,
      ]),
    ).values(),
  ];
  const targets = new Set(
    primaryLexicalAnchors(input.query, anchors, plan.retrievalIntent, plan.targetDecision).map(
      (anchor) => anchor.term,
    ),
  );
  return targets.size === 0 || requiresRelationshipOrHistoryRings(input.query)
    ? anchors
    : anchors.filter(
        (anchor) =>
          targets.has(anchor.term) || anchor.kind !== "literal" || !/^\d+$/u.test(anchor.term),
      );
}

function lexicalSemanticProvider(inputs: SearchInputs): SemanticSearchProvider | undefined {
  if (inputs.targetDecision.kind === "contextual") return inputs.repoSemanticSearchProvider;
  if (
    inputs.targetDecision.kind === "literal-search" ||
    inputs.targetDecision.definitionSymbol !== undefined ||
    isDirectEvidenceLookup(inputs.query, inputs.anchors, inputs.targetDecision)
  )
    return undefined;
  return inputs.targetDecision.targets.some((anchor) => anchor.kind === "quoted")
    ? undefined
    : inputs.repoSemanticSearchProvider;
}

function lexicalSearchOptions(inputs: SearchInputs): {
  fs: WorkspaceFs;
  nowMs: () => number;
  deadlineAtMs: number;
  searchHints: { retrievalIntent: RetrievalIntent; allowSourceInspection: boolean };
  signal?: AbortSignal;
} {
  return {
    fs: inputs.fs,
    nowMs: inputs.nowMs,
    deadlineAtMs: inputs.deadlineAtMs,
    searchHints: { retrievalIntent: inputs.retrievalIntent, allowSourceInspection: true },
    ...(inputs.signal === undefined ? {} : { signal: inputs.signal }),
  };
}

interface ContextSearchResult extends SearchResult {
  readonly knownFitFileBytes?: ReadonlyMap<string, number> | undefined;
}

function lexicalQuery(inputs: SearchInputs, terms: readonly string[]): RetrievalQuery {
  const symbol = inputs.targetDecision.definitionSymbol;
  if (symbol !== undefined) return { ...inputs.query, kind: "exact-symbol", text: symbol };
  return {
    ...inputs.query,
    text:
      terms.length === 0 || inputs.targetDecision.kind === "contextual"
        ? inputs.query.text
        : terms.join(" "),
  };
}

async function searchLexicalTerms(
  ring: RetrievalRing,
  inputs: SearchInputs,
): Promise<ContextSearchResult> {
  const options = lexicalSearchOptions(inputs);
  const definitionSymbol = inputs.targetDecision.definitionSymbol;
  const terms = definitionSymbol === undefined ? anchoredLexicalTargets(inputs) : [];
  const query = lexicalQuery(inputs, terms);
  const semanticSearchProvider = lexicalSemanticProvider(inputs);
  const context = knownFitContextFor(inputs);
  const result = await searchText(inputs.searchScope, query, ring.searchLimits, {
    ...options,
    ...(context === undefined ? {} : { onEligibleTextFile: context.observe }),
    ...(inputs.workspaceIndex === undefined ? {} : { workspaceIndex: inputs.workspaceIndex }),
    ...(terms.length === 0 ? {} : { queryInterpretation: { kind: "literal" as const, terms } }),
    ...(semanticSearchProvider === undefined ? {} : { semanticSearchProvider }),
  });
  if (context === undefined || !allowsReadableScopeContext(result.coverage)) return result;
  return {
    ...result,
    knownFitFileBytes: context.fileBytes(),
    atoms: [...result.atoms, ...context.atoms()],
  };
}

function allowsReadableScopeContext(coverage: SearchResult["coverage"]): boolean {
  // Read failures leave these observed files individually verified. Keep that bounded readable
  // subset while preserving incomplete coverage; interrupted traversal cannot qualify it.
  return (
    !coverage.incomplete ||
    (coverage.reasons.length > 0 && coverage.reasons.every((reason) => reason === "io-error"))
  );
}

function knownFitContextFor(inputs: SearchInputs): KnownFitScopeContext | undefined {
  return inputs.query.kind === "natural-language" &&
    inputs.targetDecision.kind !== "literal-search" &&
    inputs.retrievalIntent !== "diagnostic-search" &&
    !requiresRelationshipOrHistoryRings(inputs.query) &&
    !inputs.anchors.some((anchor) => anchor.kind !== "literal")
    ? new KnownFitScopeContext(
        inputs.scopeContextBytesMax,
        inputs.searchScope.scopeId,
        projectMetadataQueryFingerprint(inputs.query),
        inputs.nowMs(),
      )
    : undefined;
}

async function lexicalRingSearch(
  ring: RetrievalRing,
  inputs: SearchInputs,
): Promise<ContextSearchResult> {
  const result = await searchLexicalTerms(ring, inputs);
  if (
    inputs.retrievalIntent !== "repository-overview" ||
    result.atoms.length > 0 ||
    result.coverage.incomplete ||
    inputs.tryReserveAdditionalSearchCall?.() !== true
  )
    return result;
  const listing = await findFiles(
    inputs.searchScope,
    { ...inputs.query, kind: "file-pattern", text: "**/*" },
    ring.searchLimits,
    lexicalSearchOptions(inputs),
  );
  return { ...listing, elapsedMs: result.elapsedMs + listing.elapsedMs };
}

function withoutNamedSemanticSubstitution(
  result: ContextSearchResult,
  inputs: SearchInputs,
): ContextSearchResult {
  if (
    inputs.targetDecision.kind === "contextual" ||
    requiresRelationshipOrHistoryRings(inputs.query) ||
    anchoredLexicalTargets(inputs).length === 0 ||
    certifiedLexicalContent(result, inputs).length > 0 ||
    result.atoms.length === 0
  )
    return result;
  // An approximate concept match cannot stand in for a missing named literal. Corpus failures
  // and result truncation remain intact; only the unrelated semantic replacement is rejected.
  return {
    ...result,
    atoms: [],
    candidates: result.candidates.filter((candidate) => candidate.omitted !== undefined),
    diagnostics:
      result.diagnostics === undefined
        ? undefined
        : { ...result.diagnostics, rankedCandidates: [] },
    coverage: { ...result.coverage, matchesReturned: 0 },
  };
}

async function runLexicalRing(ring: RetrievalRing, inputs: SearchInputs): Promise<RingResult> {
  const result = withoutNamedSemanticSubstitution(await lexicalRingSearch(ring, inputs), inputs);
  inputs.workspaceIndexActivity.recordSearchResult(result);
  // Lexical scanning is transient: each candidate file is read to match lines, then discarded.
  // It does NOT consume the excerpt budget; excerpt reads are charged later by the assembler.
  return {
    knownFitFileBytes: result.knownFitFileBytes,
    atoms: result.atoms,
    primaryContentIdentities: certifiedLexicalContent(result, inputs),
    omitted: omittedFromSearchCandidates(result.candidates, inputs.nowMs()),
    uncertainty: [
      ...coverageUncertainty(result, inputs.nowMs()),
      ...missingPrimaryContextMarker(result, inputs),
    ],
    usage: usageDelta({ elapsedMs: result.elapsedMs }),
    diagnostics: toPackDiagnostics(result),
  };
}

function missingPrimaryContextMarker(
  result: ContextSearchResult,
  inputs: SearchInputs,
): readonly UncertaintyMarker[] {
  if (
    inputs.targetDecision.kind !== "contextual" ||
    anchoredLexicalTargets(inputs).length === 0 ||
    !result.atoms.some((atom) => atom.provenance.tool.startsWith("repo.semanticSearch:")) ||
    result.atoms.some(
      (atom) => atom.provenance.tool === "repo.searchText" && atom.lineRange !== undefined,
    )
  )
    return [];
  return [
    {
      kind: "low-confidence",
      claim:
        "No verified exact content match for the requested target; retained semantic evidence provides related context only.",
      impactedAtomIds: [],
      emittedAtMs: inputs.nowMs(),
    },
  ];
}

function registryForRing(ring: NonLexicalRing): StructuralAdapterRegistry {
  // Keep the planner's ring split authoritative: the structural ring should only run the
  // structural adapters, while the git-history ring should only run the repo-level history
  // adapter. Reusing the full default registry for both rings duplicates atoms and inflates
  // downstream ranking signals whenever a workspace-root query plans both rings.
  return ring.kind === "structural"
    ? {
        adapters: [
          testSourcePairingAdapter,
          symbolGraphAdapter,
          importGraphAdapter,
          endpointContractAdapter,
          ...createEcosystemStructureAdapters(),
        ],
      }
    : { adapters: [gitHistoryAdapter] };
}

async function runAdapterQueries(
  registry: StructuralAdapterRegistry,
  ring: NonLexicalRing,
  queries: readonly RetrievalQuery[],
  inputs: SearchInputs,
  requestContext: StructuralAdapterRequestContext | undefined,
): Promise<readonly RunRingStructuralResult[]> {
  if (inputs.nowMs() >= inputs.deadlineAtMs) return [];
  const controller = new AbortController();
  const signal = parallelStageSignal(controller, inputs.signal);
  const pending = queries.map((query) =>
    runStructuralAdapters(registry, inputs.searchScope, query, ring.searchLimits, inputs.fs, {
      nowMs: inputs.nowMs,
      deadlineAtMs: inputs.deadlineAtMs,
      signal,
      ...(requestContext === undefined ? {} : { requestContext }),
    }),
  );
  return settleParallelStage(Promise.all(pending), pending, controller);
}

function parallelStageSignal(
  controller: AbortController,
  parent: AbortSignal | undefined,
): AbortSignal {
  return parent === undefined ? controller.signal : AbortSignal.any([parent, controller.signal]);
}

async function settleParallelStage<T>(
  result: Promise<T>,
  pending: readonly Promise<unknown>[],
  controller: AbortController,
): Promise<T> {
  try {
    return await result;
  } catch (error) {
    // Cancel stage siblings without aborting the caller's authority. Wait for admitted resources
    // to close before exposing the original failure or allowing a retry to start another walk.
    controller.abort();
    await Promise.allSettled(pending);
    throw error;
  }
}

async function runNonLexicalAdapters(
  ring: NonLexicalRing,
  inputs: SearchInputs,
): Promise<readonly RunRingStructuralResult[]> {
  const registry = registryForRing(ring);
  const queries =
    ring.kind === "structural" ? structuralQueriesForRing(ring, inputs) : [inputs.query];
  const requestContext =
    ring.kind === "structural" ? inputs.structuralContexts.forLimits(ring.searchLimits) : undefined;
  const results = await runAdapterQueries(registry, ring, queries, inputs, requestContext);
  const followUpQueries =
    ring.kind === "structural" &&
    inputs.nowMs() < inputs.deadlineAtMs &&
    !queryTargetsRouteImplementation(inputs.query.text)
      ? structuralFollowUpQueries(
          mergeAtomsByStableId(results, ring.searchLimits.maxMatchesReturned),
          inputs.query,
        )
      : [];
  const followUpResults = await runAdapterQueries(
    registry,
    ring,
    followUpQueries,
    inputs,
    requestContext,
  );
  return [...results, ...followUpResults];
}

async function gitFileAtomsForRing(
  ring: NonLexicalRing,
  inputs: SearchInputs,
  cap: number,
): Promise<{ readonly atoms: readonly EvidenceAtom[]; readonly elapsedMs: number }> {
  if (ring.kind !== "git-history" || inputs.nowMs() >= inputs.deadlineAtMs) {
    return { atoms: [], elapsedMs: 0 };
  }
  const startedAtMs = inputs.nowMs();
  let atoms: readonly EvidenceAtom[];
  try {
    atoms = await raceAbortDeadline(
      ({ signal }) =>
        inputs.gitFileHistoryEvidence({
          searchScope: inputs.searchScope,
          query: inputs.query,
          fs: inputs.fs,
          nowMs: inputs.nowMs,
          signal,
          maxFiles: cap,
          correlationId: inputs.correlationId,
          deadlineAtMs: inputs.deadlineAtMs,
        }),
      {
        deadlineAtMs: inputs.deadlineAtMs,
        nowMs: inputs.nowMs,
        ...(inputs.signal === undefined ? {} : { signal: inputs.signal }),
      },
    );
  } catch (error) {
    if (!(error instanceof AbortDeadlineRaceError)) throw error;
    if (error.reason === "aborted") {
      throw new CancelledError("grounded repository request cancelled");
    }
    atoms = [];
  }
  return { atoms, elapsedMs: Math.max(0, inputs.nowMs() - startedAtMs) };
}

function nonLexicalAtoms(
  ring: NonLexicalRing,
  merged: readonly EvidenceAtom[],
  gitAtoms: readonly EvidenceAtom[],
  inputs: SearchInputs,
  cap: number,
): readonly EvidenceAtom[] {
  if (ring.kind === "structural") {
    return dedupeAtoms([...merged, ...structuralEdgeTargetAtoms(merged, inputs)], cap);
  }
  const existsCache = createFileExistenceCache();
  const guardedInputs = {
    ...inputs,
    fs: cancellationGuardedWorkspaceFs(inputs.fs, inputs.signal),
  };
  return dedupeAtoms(
    [...merged, ...gitAtoms].filter((atom) => {
      throwIfCancelled(inputs.signal);
      return (
        inputs.nowMs() < inputs.deadlineAtMs && isRankableFileAtom(atom, guardedInputs, existsCache)
      );
    }),
    cap,
  );
}

async function runNonLexicalRing(ring: NonLexicalRing, inputs: SearchInputs): Promise<RingResult> {
  const startedAtMs = inputs.nowMs();
  const allResults = await runNonLexicalAdapters(ring, inputs);
  const cap = Math.min(ring.searchLimits.maxMatchesReturned, inputs.query.maxResults);
  const merged = mergeAtomsByStableId(allResults, cap);
  const git = await gitFileAtomsForRing(ring, inputs, cap);
  const atoms = nonLexicalAtoms(ring, merged, git.atoms, inputs, cap);
  const adapterUncertainty = allResults.flatMap((result) =>
    adapterDiagnostics(result, inputs.nowMs()),
  );
  const uncertainty = dedupeUncertainty(
    ring.kind === "git-history"
      ? suppressGitMetadataAdapterDiagnostics(adapterUncertainty, git.atoms.length)
      : adapterUncertainty,
  );
  return {
    atoms,
    omitted: [],
    uncertainty,
    // Adapters run concurrently: their duration sum would double-charge the same wall time.
    usage: usageDelta({ elapsedMs: Math.max(0, Math.floor(inputs.nowMs() - startedAtMs)) }),
  };
}

async function runRing(ring: RetrievalRing, inputs: SearchInputs): Promise<RingResult> {
  if (ring.kind === "lexical") {
    return runLexicalRing(ring, inputs);
  }
  return runNonLexicalRing(ring as NonLexicalRing, inputs);
}

type RingSkipReason =
  | "no-git-metadata"
  | "ordinary-document"
  | "literal-absence"
  | "complete-exact-lookup"
  | "verified-target-context";
interface RingDecisionAudit {
  readonly executedRingKinds: RetrievalRing["kind"][];
  readonly skippedRingKinds: RetrievalRing["kind"][];
  readonly ringSkipReasons: RingSkipReason[];
  augmentationSkipped: boolean;
  augmentationSkipReason?: RingSkipReason | "budget-exhausted";
}

interface RingRunSummary {
  readonly metadataRetention?: MetadataRetentionObservation | undefined;
  readonly symbolDiscovery?: SymbolDiscoveryResult | undefined;
  readonly verifiedDefinitionContext?: boolean | undefined;
  readonly knownFitFileBytes?: ReadonlyMap<string, number> | undefined;
  readonly decisions?: RingDecisionAudit | undefined;
  readonly primaryContentIdentities?: readonly ContentEvidenceIdentity[];
  readonly atoms: readonly EvidenceAtom[];
  readonly omitted: readonly OmittedContextEntry[];
  readonly governor: GovernorState;
  readonly uncertainty: readonly UncertaintyMarker[];
  // Ranking diagnostics from the (first) lexical ring; undefined when no lexical ring ran (M2).
  readonly diagnostics?: ContextPackDiagnostics | undefined;
}

interface AugmentationBudgetResult {
  readonly governor: GovernorState;
  readonly marker?: UncertaintyMarker | undefined;
}

interface AugmentationBudgetMeter {
  readonly canContinue: () => boolean;
  readonly tryReserveSearchCall: () => boolean;
  readonly finish: (governor: GovernorState) => AugmentationBudgetResult;
}

function createAugmentationBudgetMeter(
  plan: ExplorationPlan,
  governor: GovernorState,
  nowMs: () => number,
  deadlineAtMs: number,
): AugmentationBudgetMeter {
  const startedAtMs = nowMs();
  let reservedSearchCalls = 0;
  let stopReason: string | undefined;
  const canContinue = (): boolean => {
    if (governor.status === "budget-exhausted") {
      stopReason ??= governor.stopReason ?? "budget exhausted";
      return false;
    }
    if (nowMs() < deadlineAtMs) return true;
    stopReason ??= "budget-exhausted on elapsedMs";
    return false;
  };
  const tryReserveSearchCall = (): boolean => {
    if (!canContinue()) return false;
    if (governor.usage.searchCalls + reservedSearchCalls >= plan.budget.searchCallsMax) {
      stopReason ??= "budget-exhausted on searchCalls";
      return false;
    }
    reservedSearchCalls += 1;
    return true;
  };
  return {
    canContinue,
    tryReserveSearchCall,
    finish: (current): AugmentationBudgetResult => {
      const endedAtMs = nowMs();
      if (endedAtMs >= deadlineAtMs) stopReason ??= "budget-exhausted on elapsedMs";
      const elapsedMs = Math.max(0, Math.floor(endedAtMs - startedAtMs));
      const charged = applyUsage(
        current,
        usageDelta({ searchCalls: reservedSearchCalls, elapsedMs }),
      );
      const reason = stopReason ?? charged.stopReason;
      return {
        governor: charged,
        ...(reason === undefined ? {} : { marker: budgetClipped(reason, endedAtMs) }),
      };
    },
  };
}

interface RingReservation {
  readonly governor: GovernorState;
  readonly marker?: UncertaintyMarker | undefined;
}

interface StoppedRingReservation {
  readonly governor: GovernorState;
  readonly marker: UncertaintyMarker;
}

function reserveRingSearchCalls(
  governor: GovernorState,
  ring: RetrievalRing,
  inputs: SearchInputs,
): RingReservation {
  const reserved = applyUsage(
    governor,
    usageDelta({ searchCalls: plannedSearchCallsForRing(ring, inputs) }),
  );
  if (reserved.status !== "budget-exhausted") {
    return { governor: reserved };
  }
  return {
    governor: reserved,
    marker: budgetClipped(reserved.stopReason ?? "budget exhausted", inputs.nowMs()),
  };
}

function initialBlockedRingSummary(
  governor: GovernorState,
  inputs: SearchInputs,
): RingRunSummary | undefined {
  const reason = readBudgetStopReason(governor.plan.budget);
  if (reason === undefined) return undefined;
  return {
    atoms: [],
    omitted: [],
    governor: complete(governor),
    uncertainty: [budgetClipped(reason, inputs.nowMs())],
  };
}

function elapsedDeadlineStop(
  governor: GovernorState,
  inputs: SearchInputs,
): StoppedRingReservation | undefined {
  if (inputs.nowMs() < inputs.deadlineAtMs) return undefined;
  const remainingElapsedMs = Math.max(
    0,
    (governor.plan.budget.elapsedMsMax ?? Number.POSITIVE_INFINITY) - governor.usage.elapsedMs,
  );
  return {
    governor: applyUsage(governor, usageDelta({ elapsedMs: remainingElapsedMs })),
    marker: budgetClipped("budget-exhausted on elapsedMs", inputs.nowMs()),
  };
}

const DOCUMENT_EVIDENCE_PATH_RE = /\.(?:html?|txt|rst|adoc|xml)$/iu;

function isCompleteExactLiteralLookup(
  query: RetrievalQuery,
  diagnostics: ContextPackDiagnostics | undefined,
  decision: QueryTargetDecision,
): boolean {
  const coverage = diagnostics?.coverage;
  return (
    decision.kind === "literal-search" &&
    coverage?.incomplete === false &&
    coverage.matchesReturned > 0 &&
    !requiresRelationshipOrHistoryRings(query) &&
    !requiresNamedDiscovery(decision)
  );
}

function isOrdinaryDocumentLookup(
  query: RetrievalQuery,
  hasGitMetadata: boolean,
  diagnostics: ContextPackDiagnostics | undefined,
): boolean {
  const candidates = diagnostics?.rankedCandidates ?? [];
  return (
    !hasGitMetadata &&
    !requiresRelationshipOrHistoryRings(query) &&
    candidates.length > 0 &&
    candidates.every((candidate) => DOCUMENT_EVIDENCE_PATH_RE.test(candidate.scopePath))
  );
}

function isOrdinaryLiteralAbsence(
  query: RetrievalQuery,
  hasGitMetadata: boolean,
  anchors: readonly SearchAnchor[],
  diagnostics: ContextPackDiagnostics | undefined,
): boolean {
  const coverage = diagnostics?.coverage;
  const literalTarget = anchors.some(
    (anchor) =>
      anchor.kind === "quoted" || (anchor.kind === "identifier" && anchor.term.includes("_")),
  );
  return (
    !hasGitMetadata &&
    literalTarget &&
    coverage?.incomplete === false &&
    coverage.matchesReturned === 0 &&
    !requiresRelationshipOrHistoryRings(query) &&
    directDefinitionSymbol(query, anchors) === undefined
  );
}

function lookupAugmentationSkipReason(
  query: RetrievalQuery,
  anchors: readonly SearchAnchor[],
  hasGitMetadata: boolean,
  diagnostics: ContextPackDiagnostics | undefined,
  decision: QueryTargetDecision,
): RingSkipReason | undefined {
  if (decision.kind === "contextual") return undefined;
  if (isCompleteExactLiteralLookup(query, diagnostics, decision)) return "complete-exact-lookup";
  if (isOrdinaryDocumentLookup(query, hasGitMetadata, diagnostics)) return "ordinary-document";
  if (isOrdinaryLiteralAbsence(query, hasGitMetadata, anchors, diagnostics))
    return "literal-absence";
  return undefined;
}

function optionalRingSkipReason(
  ring: RetrievalRing,
  inputs: SearchInputs,
  evidence: RingEvidenceAccumulator,
): RingSkipReason | undefined {
  if (requiresRelationshipOrHistoryRings(inputs.query) || ring.kind === "lexical") return undefined;
  if (evidence.verifiedDefinitionContext === true) return "verified-target-context";
  if (
    hasVerifiedTargetContext(inputs.query, inputs.targetDecision, inputs.retrievalIntent, evidence)
  )
    return "verified-target-context";
  if (
    inputs.targetDecision.kind !== "contextual" &&
    isCompleteExactLiteralLookup(inputs.query, evidence.diagnostics, inputs.targetDecision)
  )
    return "complete-exact-lookup";
  if (ring.kind === "git-history") return inputs.hasGitMetadata ? undefined : "no-git-metadata";
  return lookupAugmentationSkipReason(
    inputs.query,
    inputs.anchors,
    inputs.hasGitMetadata,
    evidence.diagnostics,
    inputs.targetDecision,
  );
}

function hasVerifiedTargetContext(
  query: RetrievalQuery,
  decision: QueryTargetDecision,
  intent: RetrievalIntent,
  evidence: Pick<RingRunSummary, "atoms" | "primaryContentIdentities" | "diagnostics">,
): boolean {
  // The full contextual lexical/semantic request already ran. One certified target proves
  // presence only; it does not certify an answer or the completeness of contextual dimensions.
  return (
    decision.kind === "contextual" &&
    decision.targets.length === 1 &&
    !requiresNamedDiscovery(decision) &&
    intent !== "diagnostic-search" &&
    !requiresRelationshipOrHistoryRings(query) &&
    evidence.diagnostics?.coverage?.incomplete === false &&
    certifiedContentPaths(evidence.atoms, evidence.primaryContentIdentities ?? []).size > 0
  );
}

function requiresNamedDiscovery(decision: QueryTargetDecision): boolean {
  return (
    decision.definitionRequested ||
    decision.targets.some((target) => DOCUMENT_REFERENCE_ANCHOR_RE.test(target.term))
  );
}

function reserveAvailableRing(
  governor: GovernorState,
  ring: RetrievalRing,
  inputs: SearchInputs,
): RingReservation {
  return elapsedDeadlineStop(governor, inputs) ?? reserveRingSearchCalls(governor, ring, inputs);
}

function lexicalContentIdentities(
  result: RingResult,
  previous: readonly ContentEvidenceIdentity[],
): readonly ContentEvidenceIdentity[] {
  return result.primaryContentIdentities ?? previous;
}

function skipPlannedRing(
  ring: RetrievalRing,
  inputs: SearchInputs,
  evidence: RingEvidenceAccumulator,
  decisions: RingDecisionAudit,
): boolean {
  const reason = optionalRingSkipReason(ring, inputs, evidence);
  if (reason === undefined) return false;
  decisions.skippedRingKinds.push(ring.kind);
  if (!decisions.ringSkipReasons.includes(reason)) decisions.ringSkipReasons.push(reason);
  return true;
}

interface ExecutedRing {
  governor: GovernorState;
  result: RingResult;
  marker?: undefined;
}
interface StoppedRing {
  governor: GovernorState;
  marker: UncertaintyMarker;
  result?: undefined;
}
async function runReservedRing(
  ring: RetrievalRing,
  inputs: SearchInputs,
  current: GovernorState,
  decisions: RingDecisionAudit,
): Promise<ExecutedRing | StoppedRing> {
  const reservation = reserveAvailableRing(current, ring, inputs);
  if (reservation.marker !== undefined)
    return { governor: reservation.governor, marker: reservation.marker };
  let governor = reservation.governor;
  decisions.executedRingKinds.push(ring.kind);
  const result = await runRing(ring, {
    ...inputs,
    tryReserveAdditionalSearchCall: (): boolean => {
      if (governor.usage.searchCalls >= governor.plan.budget.searchCallsMax) return false;
      governor = applyUsage(governor, usageDelta({ searchCalls: 1 }));
      return true;
    },
  });
  return { governor, result };
}

interface RingEvidenceAccumulator {
  symbolDiscovery?: SymbolDiscoveryResult;
  verifiedDefinitionContext?: boolean;
  knownFitFileBytes?: ReadonlyMap<string, number> | undefined;
  atoms: EvidenceAtom[];
  omitted: OmittedContextEntry[];
  uncertainty: UncertaintyMarker[];
  diagnostics: ContextPackDiagnostics | undefined;
  primaryContentIdentities: readonly ContentEvidenceIdentity[];
}
function newRingEvidence(): RingEvidenceAccumulator {
  return {
    atoms: [],
    omitted: [],
    uncertainty: [],
    diagnostics: undefined,
    primaryContentIdentities: [],
  };
}
function appendRingEvidence(evidence: RingEvidenceAccumulator, result: RingResult): void {
  evidence.knownFitFileBytes ??= result.knownFitFileBytes;
  evidence.diagnostics ??= result.diagnostics;
  evidence.primaryContentIdentities = lexicalContentIdentities(
    result,
    evidence.primaryContentIdentities,
  );
  for (const atom of result.atoms) evidence.atoms.push(atom);
  for (const omission of result.omitted) evidence.omitted.push(omission);
  for (const marker of result.uncertainty) evidence.uncertainty.push(marker);
}
function newRingDecisions(): RingDecisionAudit {
  return {
    executedRingKinds: [],
    skippedRingKinds: [],
    ringSkipReasons: [],
    augmentationSkipped: false,
  };
}

function declarationCoverageAllowsVerification(
  coverage: ContextCoverageDiagnostics | undefined,
): boolean {
  return (
    coverage !== undefined &&
    coverage.filesScanned === coverage.filesAfterPolicy &&
    (!coverage.incomplete || onlyRetainedMatchesLimited(coverage)) &&
    coverage.reasons.every((reason) => reason === "match-cap")
  );
}

function shouldDiscoverDefinitionsBeforeGraphs(
  inputs: SearchInputs,
  evidence: RingEvidenceAccumulator,
): boolean {
  return (
    evidence.symbolDiscovery === undefined &&
    inputs.targetDecision.kind === "contextual" &&
    inputs.targetDecision.definitionRequested &&
    inputs.retrievalIntent !== "diagnostic-search" &&
    !requiresRelationshipOrHistoryRings(inputs.query) &&
    declarationCoverageAllowsVerification(evidence.diagnostics?.coverage) &&
    certifiedContentPaths(evidence.atoms, evidence.primaryContentIdentities).size > 0
  );
}

async function runAllRings(
  rings: readonly RetrievalRing[],
  inputs: SearchInputs,
  initialGovernor: GovernorState,
): Promise<RingRunSummary> {
  const blocked = initialBlockedRingSummary(initialGovernor, inputs);
  if (blocked !== undefined) return blocked;
  const evidence = newRingEvidence();
  let governor = initialGovernor;
  const decisions = newRingDecisions();
  for (const ring of rings) {
    throwIfCancelled(inputs.signal);
    governor = await discoverRequiredDefinitionsForRing(ring, inputs, evidence, governor);
    if (skipPlannedRing(ring, inputs, evidence, decisions)) {
      governor = advanceRing(governor);
      continue;
    }
    if (!canContinue(governor)) {
      break;
    }
    const execution = await runReservedRing(ring, inputs, governor, decisions);
    governor = execution.governor;
    if (execution.marker !== undefined) {
      evidence.uncertainty.push(execution.marker);
      break;
    }
    const result = execution.result;
    throwIfCancelled(inputs.signal);
    appendRingEvidence(evidence, result);
    const afterRing = applyUsage(governor, result.usage);
    if (afterRing.status === "budget-exhausted") {
      governor = afterRing;
      evidence.uncertainty.push(
        budgetClipped(afterRing.stopReason ?? "budget exhausted", inputs.nowMs()),
      );
      break;
    }
    governor = advanceRing(afterRing);
  }
  if (governor.status === "running") {
    governor = complete(governor);
  }
  return { ...evidence, governor, decisions };
}

async function discoverRequiredDefinitionsForRing(
  ring: RetrievalRing,
  inputs: SearchInputs,
  evidence: RingEvidenceAccumulator,
  governor: GovernorState,
): Promise<GovernorState> {
  if (ring.kind === "lexical" || !shouldDiscoverDefinitionsBeforeGraphs(inputs, evidence))
    return governor;
  const discovery = await inputs.discoverDefinitions(governor, evidence);
  throwIfCancelled(inputs.signal);
  evidence.symbolDiscovery = discovery.evidence;
  evidence.verifiedDefinitionContext = discovery.verified;
  for (const atom of discovery.evidence.atoms) evidence.atoms.push(atom);
  for (const marker of discovery.evidence.uncertainty) evidence.uncertainty.push(marker);
  return discovery.governor;
}

export interface ExcerptInputs {
  readonly knownFitFileBytes?: ReadonlyMap<string, number> | undefined;
  readonly anchors?: readonly string[] | undefined;
  readonly searchScope: SearchScope;
  readonly fs: WorkspaceFs;
  readonly budget: ExplorationBudget;
  readonly initialUsage: ExplorationUsage;
  readonly atomsByPath: ReadonlyMap<string, readonly EvidenceAtom[]>;
  readonly nowMs: () => number;
  readonly signal?: AbortSignal | undefined;
  readonly deadlineAtMs: number;
}

type ExcerptStopReason = "file-grant" | "byte-grant" | "deadline";
interface ExcerptReadObservation {
  readonly omittedRangeCount: number;
  readonly truncatedWindowCount: number;
  readonly unreadFileCount: number;
  readonly stopReasons: readonly ExcerptStopReason[];
  readonly readBudgetBlocked: boolean;
}

export interface ExcerptReadSummary {
  readonly observation?: ExcerptReadObservation | undefined;
  readonly omitted?: readonly OmittedContextEntry[] | undefined;
  readonly byteBudgetOmittedPaths?: readonly string[] | undefined;
  readonly readWindowCount?: number | undefined;
  readonly anchoredWindowCount?: number | undefined;
  readonly excerpts: ReadonlyMap<string, readonly ExcerptWindow[]>;
  readonly uncertainty: readonly UncertaintyMarker[];
  // True when the absolute deadline stopped excerpt reading — either a read observed it after
  // returning, or the excerpt facade itself stopped a read with reason `timeout`. Reported rather
  // than inferred so the completion status cannot claim an unblocked elapsed budget (#3347 P1).
  readonly elapsedBudgetBlocked: boolean;
}

type PackCacheIdentity = readonly string[];

interface CandidateOrdering {
  readonly priorityPaths?: ReadonlySet<string>;
  readonly kept: readonly CandidateFile[];
  readonly omitted: readonly OmittedContextEntry[];
}

interface LineWindow {
  readonly startLine: number;
  readonly endLine: number;
}

const DEFAULT_EXCERPT_WINDOW: LineWindow = { startLine: 1, endLine: 200 };
const MAX_EXCERPT_WINDOW_BYTES = 8192;
const SINGLE_LINE_EXCERPT_CONTEXT_LINES = 3;
const DISCOVERED_DEFINITION_CONTEXT_AFTER = 24;
const PROJECT_METADATA_QUERY_TERMS = [
  "abhängigkeit",
  "abhängigkeiten",
  "abhaengigkeit",
  "abhaengigkeiten",
  "build",
  "cypress",
  "dependenc",
  "dependencies",
  "devdependencies",
  "framework",
  "java-script",
  "javascript",
  "jest",
  "node",
  "node.js",
  "npm",
  "package",
  "package.json",
  "package-manager",
  "paketmanager",
  "playwright",
  "pnpm",
  "react",
  "script",
  "stack",
  "tech-stack",
  "techstack",
  "test",
  "test-runner",
  "testing",
  "testumgebung",
  "type script",
  "type-script",
  "typescript",
  "version",
  "versionen",
  "vite",
  "vitest",
  "yarn",
] as const;
// Dependency lockfiles surfaced for project-metadata questions (unchanged behaviour). The manifest
// basenames themselves now come from the shared ecosystem registry (CANONICAL_MANIFEST_BASENAMES),
// which is a superset of the prior JS/TS-only list and additionally covers Maven/Gradle/Go/Rust/
// Python/.NET/etc., so "Which Java version does this project use?" injects pom.xml/build.gradle as
// deterministic score-1 metadata atoms.
const PROJECT_METADATA_LOCKFILES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
] as const;
const PROJECT_METADATA_FILENAMES: readonly string[] = [
  ...CANONICAL_MANIFEST_BASENAMES,
  ...PROJECT_METADATA_LOCKFILES,
];
const REPOSITORY_OVERVIEW_FILENAMES = [
  "README.md",
  "readme.md",
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "docs/README.md",
  "docs/architecture.md",
  "docs/ARCHITECTURE.md",
  "docs/adr/README.md",
] as const;
const WORKSPACE_PACKAGE_DIRS = ["packages", "apps", "services", "libs"] as const;
const WORKSPACE_MANIFEST_BYTES_MAX = DEFAULT_SEARCH_LIMITS.maxBytesPerFileScanned;
const WORKSPACE_PATTERN_CHARS_MAX = 1_024;
const SYMBOL_FILE_EXTENSIONS = [
  "cs",
  "fs",
  "go",
  "graphql",
  "gql",
  "groovy",
  "java",
  "ts",
  "tsx",
  "js",
  "jsx",
  "kt",
  "kts",
  "mts",
  "cts",
  "mjs",
  "cjs",
  "php",
  "proto",
  "py",
  "pyi",
  "rb",
  "rs",
  "scala",
  "swift",
  "vb",
  "vue",
] as const;
const SYMBOL_FILE_EXTENSION_SET: ReadonlySet<string> = new Set(SYMBOL_FILE_EXTENSIONS);
const SYMBOL_FILE_MATCHES_MAX = 96;
const DOCUMENT_REFERENCE_MATCHES_MAX = 8;
const MAX_DOCUMENT_REFERENCE_ANCHORS = 4;
const DOCUMENT_REFERENCE_ANCHOR_RE = /^(?:adr|rfc)-\d{3,6}$/u;
const SYMBOL_FILE_SEARCH_LIMITS = {
  maxFilesScanned: null,
  maxMatchesReturned: SYMBOL_FILE_MATCHES_MAX,
  maxBytesPerFileScanned: DEFAULT_SEARCH_LIMITS.maxBytesPerFileScanned,
  elapsedMsMax: DEFAULT_SEARCH_LIMITS.elapsedMsMax,
} as const;
const DOCUMENT_REFERENCE_SEARCH_LIMITS = {
  maxFilesScanned: null,
  maxMatchesReturned: DOCUMENT_REFERENCE_MATCHES_MAX,
  maxBytesPerFileScanned: DEFAULT_SEARCH_LIMITS.maxBytesPerFileScanned,
  elapsedMsMax: DEFAULT_SEARCH_LIMITS.elapsedMsMax,
} as const;
const SYMBOL_LINE_SCAN_BYTES_MAX = 2_097_152;
const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
  "gemfile.lock",
]);

function basename(scopePath: string): string {
  const index = scopePath.lastIndexOf("/");
  return index >= 0 ? scopePath.slice(index + 1) : scopePath;
}

function compareByScopePath(a: OmittedContextEntry, b: OmittedContextEntry): number {
  return compareStrings(a.scopePath, b.scopePath);
}

function isKeikoEvidenceArtifact(scopePath: string): boolean {
  return scopePath.toLowerCase().startsWith(".keiko/evidence/");
}

function isLockfilePath(scopePath: string): boolean {
  return LOCKFILE_NAMES.has(basename(scopePath).toLowerCase());
}

function dirname(scopePath: string): string {
  const index = scopePath.lastIndexOf("/");
  return index <= 0 ? "" : scopePath.slice(0, index);
}

function joinScopePath(base: string, filename: string): string {
  return base.length === 0 ? filename : `${base}/${filename}`;
}

function projectMetadataQueryFingerprint(query: RetrievalQuery): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: "project-metadata",
        queryKind: query.kind,
        text: query.text,
        caseSensitive: query.caseSensitive,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

function selectedFileQueryFingerprint(query: RetrievalQuery): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: "explicit-selected-file",
        queryKind: query.kind,
        text: query.text,
        caseSensitive: query.caseSensitive,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

function normalizedQueryText(queryText: string): string {
  return queryText.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

function wantsProjectMetadata(input: OrchestratorInput, intent: RetrievalIntent): boolean {
  if (intent === "project-metadata" || intent === "repository-overview") {
    return true;
  }
  const lowered = input.query.text.toLowerCase();
  const normalized = normalizedQueryText(input.query.text);
  return PROJECT_METADATA_QUERY_TERMS.some(
    (term) => lowered.includes(term) || normalized.includes(term),
  );
}

function wantsRepositoryOverview(intent: RetrievalIntent): boolean {
  return intent === "repository-overview";
}

function metadataRootsForScope(scope: SelectedScope): readonly string[] {
  if (scope.relativePaths.length === 0) {
    return [""];
  }
  const roots = new Set<string>();
  for (const entry of scope.relativePaths) {
    if (!isValidScopePath(entry, { mustBeRelative: true })) {
      continue;
    }
    roots.add(scope.kind === "files" ? dirname(entry) : entry);
  }
  return [...roots].sort((a, b) => a.localeCompare(b));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type MetadataCoverageIssue =
  | "workspace-manifest-byte-limit"
  | "workspace-manifest-read-unavailable"
  | "workspace-manifest-shape-unsupported"
  | "workspace-pattern-length-limit"
  | "workspace-pattern-shape-unsupported";

function recordMetadataCoverageIssue(
  cache: FileExistenceCache | undefined,
  issue: MetadataCoverageIssue,
  count = 1,
): void {
  if (cache === undefined || count <= 0) return;
  cache.metadataCoverageIssues.set(issue, (cache.metadataCoverageIssues.get(issue) ?? 0) + count);
}

function descriptorReadExceededLimit(error: unknown): boolean {
  return isRecord(error) && error.reason === "too-large";
}

function readBoundedWorkspaceManifest(
  fs: WorkspaceFs,
  absolutePath: string,
  cache?: FileExistenceCache,
): string | undefined {
  try {
    const stat = fs.stat(absolutePath);
    if (!stat.isFile || stat.size > WORKSPACE_MANIFEST_BYTES_MAX) {
      recordMetadataCoverageIssue(cache, "workspace-manifest-byte-limit");
      return undefined;
    }
    const boundedRead = fs.readFileUtf8SameDescriptor;
    // ADR-0005 D1: a bounded lane, or no advisory metadata at all. Falling back to the unbounded
    // `readFileUtf8` and checking the cap afterwards materializes the entire file first, so the cap
    // stops bounding anything — the exact class this PR removed from the workspace read lanes.
    if (boundedRead === undefined) {
      recordMetadataCoverageIssue(cache, "workspace-manifest-read-unavailable");
      return undefined;
    }
    const read = boundedRead(absolutePath, WORKSPACE_MANIFEST_BYTES_MAX, "reject", stat);
    if (!isWorkspacePathSnapshotCurrent(fs, absolutePath, absolutePath, stat)) return undefined;
    return decodeTextFileBytes(Buffer.from(read.rawText, "utf8"))?.text;
  } catch (error) {
    rethrowMetadataCancellation(error);
    recordMetadataCoverageIssue(
      cache,
      descriptorReadExceededLimit(error)
        ? "workspace-manifest-byte-limit"
        : "workspace-manifest-read-unavailable",
    );
    return undefined;
  }
}

function workspacePatternEntries(
  workspaces: unknown,
  cache?: FileExistenceCache,
): readonly unknown[] | undefined {
  if (Array.isArray(workspaces)) {
    return workspaces.map((entry: unknown): unknown => entry);
  }
  if (isRecord(workspaces) && Array.isArray(workspaces.packages)) {
    return workspaces.packages.map((entry: unknown): unknown => entry);
  }
  if (workspaces !== undefined) {
    recordMetadataCoverageIssue(cache, "workspace-manifest-shape-unsupported");
  }
  return undefined;
}

function boundedWorkspacePatterns(
  entries: readonly unknown[],
  cache?: FileExistenceCache,
): readonly string[] {
  const patterns: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") {
      recordMetadataCoverageIssue(cache, "workspace-pattern-shape-unsupported");
    } else if (entry.length > WORKSPACE_PATTERN_CHARS_MAX) {
      recordMetadataCoverageIssue(cache, "workspace-pattern-length-limit");
    } else {
      patterns.push(entry);
    }
  }
  return patterns;
}

function readWorkspacePatterns(
  searchScope: SearchScope,
  fs: WorkspaceFs,
  control: MetadataTraversalControl,
  existsCache?: FileExistenceCache,
): readonly string[] {
  if (!metadataTraversalCanContinue(control)) return [];
  if (!fileExistsInSearchScope(searchScope, fs, "package.json", existsCache)) {
    return [];
  }
  let rawText: string | undefined;
  try {
    const contained = canonicalContainedSearchPath(searchScope, fs, "package.json");
    if (contained === undefined) {
      recordMetadataCoverageIssue(existsCache, "workspace-manifest-read-unavailable");
      return [];
    }
    rawText = readBoundedWorkspaceManifest(fs, contained.path, existsCache);
  } catch (error) {
    rethrowMetadataCancellation(error);
    recordMetadataCoverageIssue(existsCache, "workspace-manifest-read-unavailable");
  }
  if (!metadataTraversalCanContinue(control)) return [];
  if (rawText === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(rawText);
    if (!isRecord(parsed)) {
      recordMetadataCoverageIssue(existsCache, "workspace-manifest-shape-unsupported");
      return [];
    }
    const entries = workspacePatternEntries(parsed.workspaces, existsCache);
    return entries === undefined ? [] : boundedWorkspacePatterns(entries, existsCache);
  } catch {
    recordMetadataCoverageIssue(existsCache, "workspace-manifest-shape-unsupported");
    return [];
  }
}

// Strips trailing "/" one character at a time instead of via `/\/+$/u` (SonarCloud S8786): that
// pattern is unanchored at the start, so a long run of "/" that never reaches the string's true end
// forces the engine to retry the backtrack at every position within the run, giving O(n²) work. A
// manual scan from the end can't backtrack and is O(n).
// Exported for the co-located S8786 pin (#3347); not a package public surface.
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end--;
  return value.slice(0, end);
}

// Exported for the co-located S8786 pin (#3347); not a package public surface.
export function normalizeWorkspacePattern(pattern: string): string | undefined {
  let normalized = pattern.trim().replaceAll("\\", "/");
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  normalized = stripTrailingSlashes(normalized);
  if (normalized.length === 0 || normalized.startsWith("../") || normalized.includes("/../")) {
    return undefined;
  }
  return normalized;
}

type BoundedDirectoryReadStatus = "complete" | "truncated" | "unavailable";

interface BoundedDirectoryRead {
  readonly entries: readonly WorkspaceDirEntry[];
  readonly status: BoundedDirectoryReadStatus;
}

interface MetadataTraversalControl {
  readonly signal: AbortSignal | undefined;
  readonly nowMs: () => number;
  readonly deadlineAtMs: number;
}

class MetadataTraversalDeadlineError extends Error {
  public constructor() {
    super("project metadata traversal deadline reached");
    this.name = "MetadataTraversalDeadlineError";
  }
}

// `instanceof` walks the thrown value's prototype chain, and a hostile getPrototypeOf trap (a
// proxied error from an injected callback, e.g. a test/adversarial `detectWorkspace`) can make that
// walk throw. Matches `isConnectedContextCancellation`'s established degrade-to-false shape so a
// hostile trap can never be allowed to replace the original retrieval failure.
function isMetadataTraversalDeadline(error: unknown): boolean {
  try {
    return error instanceof MetadataTraversalDeadlineError;
  } catch {
    return false;
  }
}

function assertMetadataTraversalActive(control: MetadataTraversalControl): void {
  throwIfCancelled(control.signal);
  if (control.nowMs() >= control.deadlineAtMs) {
    throw new MetadataTraversalDeadlineError();
  }
}

function metadataTraversalOperation<T>(control: MetadataTraversalControl, run: () => T): T {
  assertMetadataTraversalActive(control);
  const result = run();
  assertMetadataTraversalActive(control);
  return result;
}

function metadataTraversalFs(fs: WorkspaceFs, control: MetadataTraversalControl): WorkspaceFs {
  const descriptorRead = fs.readFileUtf8SameDescriptor;
  const canonicalRoot = fs.canonicalWorkspaceRoot;
  const run = <T>(operation: () => T): T => metadataTraversalOperation(control, operation);
  return preserveOwnedRootAuthority(fs, {
    ...(fs.iterateDirectory === undefined ? {} : { iterateDirectory: fs.iterateDirectory }),
    readFileUtf8: (path): string => run(() => fs.readFileUtf8(path)),
    stat: (path): WorkspaceStat => run(() => fs.stat(path)),
    readDir: (path, maxEntries): readonly WorkspaceDirEntry[] =>
      run(() => fs.readDir(path, maxEntries)),
    realPath: (path): string => run(() => fs.realPath(path)),
    exists: (path): boolean => run(() => fs.exists(path)),
    ...(descriptorRead === undefined
      ? {}
      : {
          readFileUtf8SameDescriptor: (
            path: string,
            maxBytes: number,
            hardLinkPolicy: WorkspaceHardLinkPolicy,
            expected: WorkspaceStat,
          ): WorkspaceDescriptorUtf8Read =>
            run(() => descriptorRead.call(fs, path, maxBytes, hardLinkPolicy, expected)),
        }),
    ...(canonicalRoot === undefined
      ? {}
      : {
          canonicalWorkspaceRoot: (root: string): string => run(() => canonicalRoot.call(fs, root)),
        }),
  });
}

function cancellationGuardedWorkspaceFs(
  fs: WorkspaceFs,
  signal: AbortSignal | undefined,
): WorkspaceFs {
  return signal === undefined
    ? fs
    : metadataTraversalFs(fs, { signal, nowMs: () => 0, deadlineAtMs: Number.POSITIVE_INFINITY });
}

function metadataTraversalCanContinue(control: MetadataTraversalControl): boolean {
  throwIfCancelled(control.signal);
  return control.nowMs() < control.deadlineAtMs;
}

function rethrowMetadataCancellation(error: unknown): void {
  if (error instanceof CancelledError) throw error;
}

type ContainedSearchPath = ReturnType<typeof containedRealPathInfo>;

function canonicalContainedSearchPath(
  searchScope: SearchScope,
  fs: WorkspaceFs,
  scopePath: string,
): ContainedSearchPath | undefined {
  const root = searchScope.workspace.root;
  const contained = containedRealPathInfo(fs, root, resolveWithinWorkspace(root, scopePath));
  return isCanonicalAllowedContainedPath(contained, root, scopePath) ? contained : undefined;
}

function safeReadDir(
  searchScope: SearchScope,
  fs: WorkspaceFs,
  scopePath: string,
  maxEntries: number,
): BoundedDirectoryRead {
  if (scopePath.length > 0 && !isValidScopePath(scopePath, { mustBeRelative: true })) {
    return { entries: [], status: "unavailable" };
  }
  const root = searchScope.workspace.root;
  const abs = resolveWithinWorkspace(root, scopePath);
  try {
    const contained = containedRealPathInfo(fs, root, abs);
    if (!isCanonicalAllowedContainedPath(contained, root, scopePath)) {
      if (!isAllowedContainedPathParent(contained, root, scopePath)) {
        return { entries: [], status: "unavailable" };
      }
      return fs.exists(abs)
        ? { entries: [], status: "unavailable" }
        : { entries: [], status: "complete" };
    }
    if (!fs.stat(contained.path).isDirectory) {
      return { entries: [], status: "complete" };
    }
    const entries = fs.readDir(contained.path, maxEntries + 1);
    const truncated = entries.length > maxEntries;
    return {
      entries: truncated ? [] : entries,
      status: truncated ? "truncated" : "complete",
    };
  } catch (error) {
    rethrowMetadataCancellation(error);
    return { entries: [], status: "unavailable" };
  }
}

function metadataDirectoryPath(
  searchScope: SearchScope,
  fs: WorkspaceFs,
  scopePath: string,
): string | undefined {
  if (scopePath.length > 0 && !isValidScopePath(scopePath, { mustBeRelative: true }))
    throw new Error("invalid metadata directory");
  const root = searchScope.workspace.root;
  const absolute = resolveWithinWorkspace(root, scopePath);
  const contained = containedRealPathInfo(fs, root, absolute);
  if (!isCanonicalAllowedContainedPath(contained, root, scopePath)) {
    if (isAllowedContainedPathParent(contained, root, scopePath) && !fs.exists(absolute))
      return undefined;
    throw new Error("metadata directory unavailable");
  }
  const stat = fs.stat(contained.path);
  if (stat.isSymbolicLink) throw new Error("metadata directory is a symbolic link");
  return stat.isDirectory ? contained.path : undefined;
}

function recordUnavailableMetadataDirectory(cache: FileExistenceCache | undefined): void {
  // The connected-context completion records the resulting scope-incomplete uncertainty count.
  if (cache !== undefined) cache.unavailableDirectoryInspections += 1;
}

async function visitMetadataDirectory(
  searchScope: SearchScope,
  fs: WorkspaceFs,
  scopePath: string,
  control: MetadataTraversalControl,
  cache: FileExistenceCache | undefined,
  visit: (entry: WorkspaceDirEntry) => void | Promise<void>,
): Promise<boolean> {
  try {
    assertMetadataTraversalActive(control);
    const path = metadataDirectoryPath(searchScope, fs, scopePath);
    if (path === undefined) return true;
    const iterate = fs.iterateDirectory;
    if (iterate === undefined) throw new Error("streaming directory inspection unavailable");
    for await (const entry of iterate.call(fs, path)) {
      assertMetadataTraversalActive(control);
      await visit(entry);
    }
    assertMetadataTraversalActive(control);
    if (metadataDirectoryPath(searchScope, fs, scopePath) !== path)
      throw new Error("metadata directory changed");
    return true;
  } catch (error) {
    rethrowMetadataCancellation(error);
    recordUnavailableMetadataDirectory(cache);
    return false;
  }
}

async function canonicalManifestScopePathsInDir(
  dir: string,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  maxResults: number,
  control: MetadataTraversalControl,
  existsCache?: FileExistenceCache,
  policy: { readonly cacheAbsentNames?: boolean; readonly rememberDirectory?: boolean } = {},
): Promise<readonly string[]> {
  if (!beginMetadataDirectory(existsCache, dir, policy.rememberDirectory !== false)) return [];
  const paths = new BoundedMetadataPaths(maxResults);
  const present = new Set<string>();
  const complete = await visitMetadataDirectory(
    searchScope,
    fs,
    dir,
    control,
    existsCache,
    (entry): void => {
      if (entry.isSymbolicLink || !entry.isFile) return;
      if (policy.cacheAbsentNames === true && PROJECT_METADATA_FILENAMES.includes(entry.name))
        present.add(entry.name);
      const path = joinScopePath(dir, entry.name);
      retainCanonicalMetadataPath(path, searchScope, fs, paths, existsCache);
    },
  );
  if (complete && policy.cacheAbsentNames === true)
    cacheAbsentMetadataNames(existsCache, dir, present);
  return paths.sorted();
}

function beginMetadataDirectory(
  cache: FileExistenceCache | undefined,
  dir: string,
  remember: boolean,
): boolean {
  if (cache === undefined) return true;
  if (cache.metadataDirectories.has(dir)) return false;
  if (remember && cache.metadataWildcardBases.has(dirname(dir))) return false;
  if (remember) cache.metadataDirectories.add(dir);
  return true;
}

function cacheAbsentMetadataNames(
  cache: FileExistenceCache | undefined,
  dir: string,
  present: ReadonlySet<string>,
): void {
  if (cache === undefined) return;
  for (const name of PROJECT_METADATA_FILENAMES)
    if (!present.has(name)) cache.files.set(joinScopePath(dir, name), false);
}

function isAdmittedMetadataPath(
  path: string,
  scope: SearchScope,
  cache: FileExistenceCache | undefined,
): boolean {
  if (!isValidScopePath(path, { mustBeRelative: true }) || isDenied(path)) return false;
  if (scope.relativePaths.length === 0) return true;
  const selected = cache?.metadataScopePaths ?? new Set(scope.relativePaths);
  let ancestor = path;
  for (;;) {
    if (selected.has(ancestor)) return true;
    const separator = ancestor.lastIndexOf("/");
    if (separator < 0) return false;
    ancestor = ancestor.slice(0, separator);
  }
}

function retainCanonicalMetadataPath(
  path: string,
  scope: SearchScope,
  fs: WorkspaceFs,
  paths: BoundedMetadataPaths,
  cache: FileExistenceCache | undefined,
): void {
  if (
    !isCanonicalMetadataFile(path) ||
    !isAdmittedMetadataPath(path, scope, cache) ||
    !fileExistsByContainedStat(scope, fs, path)
  )
    return;
  cache?.metadataRetention?.observe(path);
  paths.retain(path);
}

async function expandWorkspacePattern(
  pattern: string,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  control: MetadataTraversalControl,
  maxResults: number,
  existsCache?: FileExistenceCache,
): Promise<readonly string[]> {
  if (!metadataTraversalCanContinue(control)) return [];
  const normalized = normalizeWorkspacePattern(pattern);
  if (normalized === undefined) {
    recordMetadataCoverageIssue(existsCache, "workspace-pattern-shape-unsupported");
    return [];
  }
  if (!normalized.includes("*")) {
    const dir = normalized.endsWith("/package.json")
      ? normalized.slice(0, -"/package.json".length)
      : normalized;
    return canonicalManifestScopePathsInDir(dir, searchScope, fs, maxResults, control, existsCache);
  }
  if (!normalized.endsWith("/*") || normalized.slice(0, -2).includes("*")) {
    recordMetadataCoverageIssue(existsCache, "workspace-pattern-shape-unsupported");
    return [];
  }
  return workspacePatternServiceManifests(
    normalized.slice(0, -2),
    searchScope,
    fs,
    control,
    maxResults,
    existsCache,
  );
}

async function workspacePatternServiceManifests(
  base: string,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  control: MetadataTraversalControl,
  maxResults: number,
  existsCache?: FileExistenceCache,
): Promise<readonly string[]> {
  if (existsCache?.metadataWildcardBases.has(base) === true) return [];
  existsCache?.metadataWildcardBases.add(base);
  const manifests = new BoundedMetadataPaths(maxResults);
  await visitMetadataDirectory(
    searchScope,
    fs,
    base,
    control,
    existsCache,
    async (entry): Promise<void> => {
      if (!entry.isDirectory || entry.isSymbolicLink) return;
      const dir = joinScopePath(base, entry.name);
      if (!isValidScopePath(dir, { mustBeRelative: true }) || isDenied(dir)) return;
      for (const path of await canonicalManifestScopePathsInDir(
        dir,
        searchScope,
        fs,
        maxResults,
        control,
        existsCache,
        { rememberDirectory: false },
      ))
        manifests.retain(path);
    },
  );
  return manifests.sorted();
}

async function workspacePackageManifestPaths(
  input: OrchestratorInput,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  control: MetadataTraversalControl,
  maxResults: number,
  existsCache?: FileExistenceCache,
): Promise<readonly string[]> {
  if (input.scope.kind !== "workspace-root" || input.scope.relativePaths.length !== 0) return [];
  if (!metadataTraversalCanContinue(control)) return [];
  const patterns = new Set<string>(readWorkspacePatterns(searchScope, fs, control, existsCache));
  for (const dir of WORKSPACE_PACKAGE_DIRS) patterns.add(`${dir}/*`);
  const paths = new BoundedMetadataPaths(maxResults);
  for (const pattern of [...patterns].sort(compareStrings)) {
    if (!metadataTraversalCanContinue(control)) break;
    for (const path of await expandWorkspacePattern(
      pattern,
      searchScope,
      fs,
      control,
      maxResults,
      existsCache,
    ))
      paths.retain(path);
  }
  return paths.sorted();
}

function metadataAtom(
  scope: SelectedScope,
  scopePath: string,
  queryFingerprint: string,
  nowMs: () => number,
): EvidenceAtom {
  return {
    schemaVersion: scope.schemaVersion,
    stableId: evidenceAtomStableId({
      scopeId: scope.scopeId,
      scopePath,
      lineRange: undefined,
      provenanceKind: "file-listing",
      provenanceTool: "repo.projectMetadata",
      queryFingerprint,
    }),
    scopePath,
    lineRange: undefined,
    score: 1,
    provenance: {
      kind: "file-listing",
      tool: "repo.projectMetadata",
      queryFingerprint,
    },
    redactionState: "redacted",
    emittedAtMs: nowMs(),
    ledgerRef: undefined,
  };
}

function overviewAtom(
  scope: SelectedScope,
  scopePath: string,
  queryFingerprint: string,
  nowMs: () => number,
): EvidenceAtom {
  return {
    schemaVersion: scope.schemaVersion,
    stableId: evidenceAtomStableId({
      scopeId: scope.scopeId,
      scopePath,
      lineRange: undefined,
      provenanceKind: "file-listing",
      provenanceTool: "repo.repositoryOverview",
      queryFingerprint,
    }),
    scopePath,
    lineRange: undefined,
    score: 1,
    provenance: {
      kind: "file-listing",
      tool: "repo.repositoryOverview",
      queryFingerprint,
    },
    redactionState: "redacted",
    emittedAtMs: nowMs(),
    ledgerRef: undefined,
  };
}

function symbolFileQuery(input: OrchestratorInput, pattern: string): RetrievalQuery {
  return {
    kind: "file-pattern",
    text: pattern,
    caseSensitive: false,
    maxResults: SYMBOL_FILE_MATCHES_MAX,
    emittedAtMs: input.query.emittedAtMs,
  };
}

function documentReferenceAnchorTerms(plan: ExplorationPlan): readonly string[] {
  return plan.anchors
    .filter(
      (anchor) =>
        (anchor.kind === "identifier" || anchor.kind === "quoted") &&
        DOCUMENT_REFERENCE_ANCHOR_RE.test(anchor.term),
    )
    .map((anchor) => anchor.term)
    .slice(0, MAX_DOCUMENT_REFERENCE_ANCHORS);
}

function documentReferenceCoverageMarker(
  term: string,
  coverage: ContextCoverageDiagnostics,
  nowMs: () => number,
): UncertaintyMarker | undefined {
  if (!coverage.incomplete) return undefined;
  return discoveryCoverageMarker(
    `Document reference discovery for "${term}"`,
    coverage,
    `reasons=${coverage.reasons.join(",")}; ` +
      `filesScanned=${String(coverage.filesScanned)}, ` +
      `filesSkipped=${String(coverage.filesSkipped)}, ` +
      `matchesReturned=${String(coverage.matchesReturned)}`,
    nowMs(),
  );
}

function reserveAugmentationSearchTerms(
  terms: readonly string[],
  signal: AbortSignal | undefined,
  budget: AugmentationBudgetMeter,
): readonly string[] {
  throwIfCancelled(signal);
  return terms.length > 0 && budget.tryReserveSearchCall() ? terms : [];
}

async function documentReferenceAtoms(
  input: OrchestratorInput,
  plan: ExplorationPlan,
  nowMs: () => number,
  signal: AbortSignal | undefined,
  requestContext: StructuralAdapterRequestContext,
  budget: AugmentationBudgetMeter,
): Promise<DeterministicContextEvidence> {
  const terms = reserveAugmentationSearchTerms(documentReferenceAnchorTerms(plan), signal, budget);
  if (terms.length === 0) return { atoms: [], uncertainty: [] };
  const maxMatches = DOCUMENT_REFERENCE_MATCHES_MAX * terms.length;
  const result = await requestContext.findFiles(
    { ...symbolFileQuery(input, "**/*"), maxResults: maxMatches },
    { ...DOCUMENT_REFERENCE_SEARCH_LIMITS, maxMatchesReturned: maxMatches },
    {
      ...(signal === undefined ? {} : { signal }),
      searchHints: { retrievalIntent: plan.retrievalIntent },
      filePatternGroups: {
        patterns: terms.map((term) => `**${term}*`),
        maxMatchesPerPattern: DOCUMENT_REFERENCE_MATCHES_MAX,
      },
    },
  );
  const marker = documentReferenceCoverageMarker(terms.join(", "), result.coverage, nowMs);
  return { atoms: result.atoms, uncertainty: marker === undefined ? [] : [marker] };
}

// eslint-disable-next-line complexity -- Guard chain keeps symbol-anchor filtering explicit.
function symbolFileAnchorTerms(plan: ExplorationPlan): readonly string[] {
  if (
    plan.retrievalIntent !== "targeted-code-search" &&
    plan.retrievalIntent !== "diagnostic-search"
  ) {
    return [];
  }
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const anchor of [...(plan.targetDecision?.targets ?? []), ...plan.anchors]) {
    if ((anchor.kind !== "identifier" && anchor.kind !== "quoted") || anchor.weight < 0.7) {
      continue;
    }
    if (
      !/^[a-z_$][a-z0-9_$-]+$/u.test(anchor.term) ||
      anchor.term.includes(".") ||
      DOCUMENT_REFERENCE_ANCHOR_RE.test(anchor.term)
    ) {
      continue;
    }
    if (!seen.has(anchor.term)) {
      seen.add(anchor.term);
      terms.push(anchor.term);
    }
    if (terms.length >= 8) {
      break;
    }
  }
  return terms;
}

interface SymbolLineScanControl {
  readonly signal: AbortSignal | undefined;
  readonly nowMs: () => number;
  readonly deadlineMs: number;
}

interface SymbolLineLookupResult {
  readonly lineNumber: number | undefined;
  readonly deadlineReached: boolean;
  readonly definitionMatch?: true;
}

function symbolLineDeadlineReached(control: SymbolLineScanControl): boolean {
  return control.nowMs() >= control.deadlineMs;
}

function sourceLineDefinesSymbol(
  sourceLines: readonly RepositorySourceLine[] | undefined,
  lineNumber: number,
  term: string,
): boolean {
  const structural = sourceLines?.[lineNumber - 1]?.structural;
  return (
    structural !== undefined && structuralLineLooksLikeSymbolDefinition(structural, term, false)
  );
}

// Exported only for deterministic cancellation/deadline regression coverage; this file is not a
// package export. The per-line guard ensures a bounded-but-large 2 MiB source cannot run past the
// request's absolute elapsed deadline after the descriptor read has completed.
export function scanFirstSymbolLine(
  rawText: string,
  term: string,
  control: SymbolLineScanControl,
  sourceLines?: readonly RepositorySourceLine[],
): SymbolLineLookupResult {
  const loweredTerm = term.toLowerCase();
  let firstOccurrence: number | undefined;
  let lineNumber = 1;
  let start = 0;
  while (start <= rawText.length) {
    throwIfCancelled(control.signal);
    if (symbolLineDeadlineReached(control)) {
      return { lineNumber: undefined, deadlineReached: true };
    }
    const newline = rawText.indexOf("\n", start);
    const line = rawText.slice(start, newline < 0 ? rawText.length : newline);
    if (sourceLineDefinesSymbol(sourceLines, lineNumber, term)) {
      return { lineNumber, deadlineReached: false, definitionMatch: true };
    }
    if (firstOccurrence === undefined && line.toLowerCase().includes(loweredTerm)) {
      firstOccurrence = lineNumber;
    }
    if (newline < 0) break;
    start = newline + 1;
    lineNumber += 1;
  }
  return { lineNumber: firstOccurrence, deadlineReached: false };
}

function boundedSymbolFileText(fs: WorkspaceFs, absolutePath: string): string | undefined {
  const stat = fs.stat(absolutePath);
  if (!stat.isFile || stat.size > SYMBOL_LINE_SCAN_BYTES_MAX) return undefined;
  const boundedRead = fs.readFileUtf8SameDescriptor;
  // ADR-0005 D1: bounded primitive or nothing. A port without it yields no symbol-line evidence
  // rather than an uncapped `readFileUtf8` whose size is only inspected once the whole file is
  // already resident. A pre-read stat is not a bound: the file it describes can grow before the
  // read, and the post-read length check has already paid the memory cost it was meant to refuse.
  if (boundedRead === undefined) return undefined;
  const read = boundedRead(absolutePath, SYMBOL_LINE_SCAN_BYTES_MAX, "reject", stat);
  return isWorkspacePathSnapshotCurrent(fs, absolutePath, absolutePath, stat)
    ? read.rawText
    : undefined;
}

function symbolLinesForPath(
  inputs: PrioritizedSymbolInputs,
  scopePath: string,
  terms: readonly string[],
  control: SymbolLineScanControl,
): ReadonlyMap<string, SymbolLineLookupResult> {
  throwIfCancelled(control.signal);
  if (symbolLineDeadlineReached(control)) return new Map();
  try {
    const contained = canonicalContainedSearchPath(inputs.searchScope, inputs.fs, scopePath);
    throwIfCancelled(control.signal);
    if (symbolLineDeadlineReached(control)) return new Map();
    const text =
      contained === undefined ? undefined : boundedSymbolFileText(inputs.fs, contained.path);
    if (text === undefined) return new Map();
    throwIfCancelled(control.signal);
    if (symbolLineDeadlineReached(control)) return new Map();
    const sourceLines = repositorySourceLines(text, scopePath);
    return new Map(
      terms.map((term) => [term, scanFirstSymbolLine(text, term, control, sourceLines)]),
    );
  } catch (error) {
    if (error instanceof CancelledError) throw error;
    return new Map();
  }
}

function symbolLineAtom(
  scope: SelectedScope,
  scopePath: string,
  lineNumber: number,
  queryFingerprint: string,
  nowMs: () => number,
  definitionMatch = false,
): EvidenceAtom {
  const lineRange = { startLine: lineNumber, endLine: lineNumber };
  const tool = definitionMatch ? "discovered-symbol-definition" : "repo.symbolFileDiscovery";
  return {
    schemaVersion: scope.schemaVersion,
    stableId: evidenceAtomStableId({
      scopeId: scope.scopeId,
      scopePath,
      lineRange,
      provenanceKind: "lexical-search",
      provenanceTool: tool,
      queryFingerprint,
    }),
    scopePath,
    lineRange,
    score: 1,
    provenance: {
      kind: "lexical-search",
      tool,
      queryFingerprint,
    },
    redactionState: "redacted",
    emittedAtMs: nowMs(),
    ledgerRef: undefined,
  };
}

function scopePathExtension(scopePath: string): string {
  const name = scopePath.slice(scopePath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

// True when `scopePath` is a `<term>.<code-extension>` definition file. The single-walk symbol glob
// `**/term.*` also matches multi-dot names like `term.test.tsx` (which the prior per-extension globs
// did not), so this restores the exact contract: keep only paths ending in `term.<ext>` for a code
// extension — the implementation file, not its co-named spec/story. Exported for direct testing.
export function isSymbolDefinitionPath(scopePath: string, term: string): boolean {
  const extension = scopePathExtension(scopePath);
  return (
    (SYMBOL_FILE_EXTENSION_SET.has(extension) || isEcosystemSourceFile(scopePath)) &&
    scopePath.toLowerCase().endsWith(`${term.toLowerCase()}.${extension}`)
  );
}

interface SymbolDefinitionMatch {
  readonly atom: EvidenceAtom;
  readonly term: string;
  readonly priority: number;
}

interface SymbolDiscoveryResult {
  readonly atoms: readonly EvidenceAtom[];
  readonly uncertainty: readonly UncertaintyMarker[];
  readonly verifiedTerms?: ReadonlySet<string>;
  readonly observedTerms?: ReadonlySet<string>;
  readonly complete?: boolean;
}

function symbolCoverageIncomplete(
  term: string,
  coverage: ContextCoverageDiagnostics | undefined,
  nowMs: () => number,
): UncertaintyMarker | undefined {
  if (coverage?.incomplete !== true) {
    return undefined;
  }
  return discoveryCoverageMarker(
    `Symbol file discovery for "${term}"`,
    coverage,
    `reasons=${coverage.reasons.join(",")}; ` +
      `filesScanned=${String(coverage.filesScanned)}, ` +
      `filesSkipped=${String(coverage.filesSkipped)}, ` +
      `matchesReturned=${String(coverage.matchesReturned)}, ` +
      `limits=maxFilesScanned:${String(coverage.limits.maxFilesScanned)},` +
      `maxMatchesReturned:${String(coverage.limits.maxMatchesReturned)},` +
      `elapsedMsMax:${String(coverage.limits.elapsedMsMax)}`,
    nowMs(),
  );
}

function symbolDefinitionPriority(scopePath: string, term: string): number {
  const loweredPath = scopePath.toLowerCase();
  return (
    1 +
    (loweredPath.includes(`/src/`) || loweredPath.startsWith("src/") ? 0.4 : 0) +
    (isSymbolDefinitionPath(scopePath, term) ? 0.2 : 0) -
    (/(^|\/)(test|tests|spec|specs|__tests__)\//u.test(loweredPath) ? 0.3 : 0)
  );
}

function compareSymbolMatches(a: SymbolDefinitionMatch, b: SymbolDefinitionMatch): number {
  const priorityDelta = b.priority - a.priority;
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  return a.atom.scopePath.localeCompare(b.atom.scopePath);
}

function symbolLineDeadlineMarker(
  skippedCount: number,
  nowMs: () => number,
): UncertaintyMarker | undefined {
  if (skippedCount === 0) return undefined;
  return {
    kind: "scope-incomplete",
    claim:
      `Symbol line lookup reached the absolute elapsed deadline and skipped ` +
      `${String(skippedCount)} definition file(s); file-level symbol matches remain available.`,
    impactedAtomIds: [],
    emittedAtMs: nowMs(),
  };
}

// One admitted traversal discovers all requested symbol filenames. Independent bounded pattern
// buckets preserve each target before the fair emitted result selection.
async function collectSymbolDefinitionMatches(
  terms: readonly string[],
  input: OrchestratorInput,
  plan: ExplorationPlan,
  nowMs: () => number,
  signal: AbortSignal | undefined,
  requestContext: StructuralAdapterRequestContext,
  budget: AugmentationBudgetMeter,
): Promise<{
  readonly terms: readonly string[];
  readonly matches: readonly SymbolDefinitionMatch[];
  readonly uncertainty: readonly UncertaintyMarker[];
}> {
  const reservedTerms = reserveAugmentationSearchTerms(terms, signal, budget);
  if (reservedTerms.length === 0) return { terms: [], matches: [], uncertainty: [] };
  const result = await requestContext.findFiles(
    symbolFileQuery(input, "**/*"),
    SYMBOL_FILE_SEARCH_LIMITS,
    {
      ...(signal === undefined ? {} : { signal }),
      searchHints: { retrievalIntent: plan.retrievalIntent },
      filePatternGroups: {
        patterns: reservedTerms.map((term) => `**/${term}.*`),
        maxMatchesPerPattern: SYMBOL_FILE_MATCHES_MAX,
      },
    },
  );
  const matches: SymbolDefinitionMatch[] = [];
  for (const atom of result.atoms) {
    for (const term of reservedTerms) {
      if (isSymbolDefinitionPath(atom.scopePath, term)) {
        matches.push({ atom, term, priority: symbolDefinitionPriority(atom.scopePath, term) });
      }
    }
  }
  const marker = symbolCoverageIncomplete(reservedTerms.join(", "), result.coverage, nowMs);
  return { terms: reservedTerms, matches, uncertainty: marker === undefined ? [] : [marker] };
}

function pushUniqueAtom(atoms: EvidenceAtom[], seen: Set<string>, atom: EvidenceAtom): void {
  if (seen.has(atom.stableId)) {
    return;
  }
  seen.add(atom.stableId);
  atoms.push(atom);
}

interface PrioritizedSymbolInputs {
  readonly input: OrchestratorInput;
  readonly searchScope: SearchScope;
  readonly fs: WorkspaceFs;
  readonly nowMs: () => number;
  readonly signal: AbortSignal | undefined;
  readonly deadlineAtMs: number;
}

// The per-match state the prioritized-symbol loop threads into one line lookup: the match itself,
// the loop's shared accumulator, and the scan control derived once from the request-scoped inputs.
// Kept apart from PrioritizedSymbolInputs so the request-scoped values stay one shared value.
interface SymbolLineAtomTarget {
  readonly match: SymbolDefinitionMatch;
  readonly atoms: EvidenceAtom[];
  readonly seen: Set<string>;
  readonly control: SymbolLineScanControl;
  readonly lookup: SymbolLineLookupResult | undefined;
  readonly verifiedTerms: Set<string>;
  readonly observedTerms: Set<string>;
}

function pushSymbolLineAtom(
  inputs: PrioritizedSymbolInputs,
  target: SymbolLineAtomTarget,
): boolean {
  const { match, atoms, seen, control, lookup } = target;
  const { atom, term } = match;
  if (lookup?.lineNumber === undefined) {
    return lookup?.deadlineReached === true || symbolLineDeadlineReached(control);
  }
  target.observedTerms.add(term);
  if (lookup.definitionMatch === true) target.verifiedTerms.add(term);
  pushUniqueAtom(
    atoms,
    seen,
    symbolLineAtom(
      inputs.input.scope,
      atom.scopePath,
      lookup.lineNumber,
      atom.provenance.queryFingerprint,
      inputs.nowMs,
      lookup.definitionMatch === true,
    ),
  );
  return false;
}

function orderSymbolMatchesForTerms(
  matches: readonly SymbolDefinitionMatch[],
  terms: readonly string[],
): readonly SymbolDefinitionMatch[] {
  const sorted = [...matches].sort(compareSymbolMatches);
  const firstPerTerm = new Set<SymbolDefinitionMatch>();
  for (const term of terms) {
    const match = sorted.find((entry) => entry.term === term);
    if (match !== undefined) firstPerTerm.add(match);
  }
  return [...firstPerTerm, ...sorted.filter((match) => !firstPerTerm.has(match))];
}

function withLexicalSymbolCandidates(
  matches: readonly SymbolDefinitionMatch[],
  terms: readonly string[],
  lexicalAtoms: readonly EvidenceAtom[],
): readonly SymbolDefinitionMatch[] {
  const combined = new Map(
    matches.map((match) => [`${match.atom.scopePath}\0${match.term}`, match]),
  );
  for (const atom of lexicalAtoms) {
    for (const term of terms) {
      const key = `${atom.scopePath}\0${term}`;
      if (!combined.has(key))
        combined.set(key, { atom, term, priority: symbolDefinitionPriority(atom.scopePath, term) });
    }
  }
  return [...combined.values()];
}

function collectPrioritizedSymbolAtoms(
  inputs: PrioritizedSymbolInputs,
  matches: readonly SymbolDefinitionMatch[],
  terms: readonly string[],
): SymbolDiscoveryResult {
  const atoms: EvidenceAtom[] = [];
  const seen = new Set<string>();
  const verifiedTerms = new Set<string>();
  const observedTerms = new Set<string>();
  const lookups = new Map<string, ReadonlyMap<string, SymbolLineLookupResult>>();
  let complete = true;
  let deadlineSkippedCount = 0;
  let lineDeadlineReached = false;
  const control: SymbolLineScanControl = {
    signal: inputs.signal,
    nowMs: inputs.nowMs,
    deadlineMs: inputs.deadlineAtMs,
  };
  for (const match of orderSymbolMatchesForTerms(matches, terms)) {
    throwIfCancelled(inputs.signal);
    pushUniqueAtom(atoms, seen, match.atom);
    if (lineDeadlineReached) {
      deadlineSkippedCount += 1;
    } else {
      const fileLookups = cachedSymbolLines(inputs, match.atom.scopePath, terms, control, lookups);
      complete &&= fileLookups.size === terms.length;
      lineDeadlineReached = pushSymbolLineAtom(inputs, {
        match,
        atoms,
        seen,
        control,
        lookup: fileLookups.get(match.term),
        verifiedTerms,
        observedTerms,
      });
      if (lineDeadlineReached) deadlineSkippedCount += 1;
    }
  }
  return {
    atoms,
    verifiedTerms,
    observedTerms,
    complete: complete && !lineDeadlineReached,
    uncertainty: [symbolLineDeadlineMarker(deadlineSkippedCount, inputs.nowMs)].filter(
      (marker): marker is UncertaintyMarker => marker !== undefined,
    ),
  };
}

function cachedSymbolLines(
  inputs: PrioritizedSymbolInputs,
  scopePath: string,
  terms: readonly string[],
  control: SymbolLineScanControl,
  cache: Map<string, ReadonlyMap<string, SymbolLineLookupResult>>,
): ReadonlyMap<string, SymbolLineLookupResult> {
  const existing = cache.get(scopePath);
  if (existing !== undefined) return existing;
  const lines = symbolLinesForPath(inputs, scopePath, terms, control);
  cache.set(scopePath, lines);
  return lines;
}

async function symbolFileAtoms(
  inputs: DeterministicContextInputs,
  requestContext: StructuralAdapterRequestContext,
): Promise<SymbolDiscoveryResult> {
  const { input, plan, searchScope, fs, nowMs, signal, deadlineAtMs, budget } = inputs;
  const terms = symbolFileAnchorTerms(plan);
  if (terms.length === 0) {
    return { atoms: [], uncertainty: [] };
  }
  const collected = await collectSymbolDefinitionMatches(
    terms,
    input,
    plan,
    nowMs,
    signal,
    requestContext,
    budget,
  );
  if (collected.terms.length === 0) return { atoms: [], uncertainty: [] };
  const prioritized = collectPrioritizedSymbolAtoms(
    {
      input,
      searchScope,
      fs,
      nowMs,
      signal,
      deadlineAtMs,
    },
    withLexicalSymbolCandidates(collected.matches, collected.terms, inputs.lexicalAtoms ?? []),
    collected.terms,
  );
  return {
    ...prioritized,
    uncertainty: [...collected.uncertainty, ...prioritized.uncertainty],
  };
}

interface DefinitionDiscoveryExecution {
  readonly evidence: SymbolDiscoveryResult;
  readonly governor: GovernorState;
  readonly verified: boolean;
}

function requiredDeclarationTargets(
  query: RetrievalQuery,
  decision: QueryTargetDecision,
): ReadonlySet<string> {
  const original = extractAnchors({ text: query.text, maxAnchors: query.text.length }).anchors;
  const required = new Set(
    [...decision.targets, ...original]
      .filter((anchor) => anchor.kind === "quoted" || anchor.weight >= 0.9)
      .map((anchor) => anchor.term),
  );
  for (const token of query.text.matchAll(/[\p{L}\p{N}_$.-]+/gu)) {
    const term = token[0].toLowerCase();
    const anchor = extractAnchors({ text: token[0], maxAnchors: 1 }).anchors[0];
    if (anchor?.kind === "identifier" && anchor.weight >= 0.85 && anchor.term === term)
      required.add(term);
  }
  return required;
}

function verifiedDefinitionDiscovery(
  evidence: SymbolDiscoveryResult,
  query: RetrievalQuery,
  decision: QueryTargetDecision,
): boolean {
  const verified = evidence.verifiedTerms ?? new Set<string>();
  return (
    evidence.complete === true &&
    evidence.uncertainty.length === 0 &&
    verified.size > 0 &&
    [...requiredDeclarationTargets(query, decision)].every((term) => verified.has(term)) &&
    [...(evidence.observedTerms ?? [])].every((term) => verified.has(term))
  );
}

function finishDefinitionDiscovery(
  args: AssembleGroundedPackInputs,
  evidence: SymbolDiscoveryResult,
  result: AugmentationBudgetResult,
): DefinitionDiscoveryExecution {
  return {
    evidence:
      result.marker === undefined
        ? evidence
        : { ...evidence, uncertainty: [...evidence.uncertainty, result.marker] },
    governor: result.governor,
    verified:
      result.marker === undefined &&
      verifiedDefinitionDiscovery(
        evidence,
        args.input.query,
        args.plan.targetDecision ?? resolveQueryTargetDecision(args.input.query, args.plan.anchors),
      ),
  };
}

async function discoverDefinitionsBeforeGraphs(
  args: AssembleGroundedPackInputs,
): Promise<DefinitionDiscoveryExecution> {
  const {
    input,
    plan,
    rings,
    searchScope,
    fs,
    metadataFs,
    nowMs,
    structuralContexts,
    deadlineAtMs,
    deps,
  } = args;
  const budget = createAugmentationBudgetMeter(plan, rings.governor, nowMs, deadlineAtMs);
  const certifiedPaths = primaryContentPaths(rings);
  const evidence = await symbolFileAtoms(
    {
      input,
      plan,
      searchScope,
      fs,
      metadataFs,
      nowMs,
      structuralContexts,
      deadlineAtMs,
      budget,
      signal: deps.signal,
      lexicalAtoms: rings.atoms.filter(
        (atom) => certifiedPaths.has(atom.scopePath) && atom.provenance.tool === "repo.searchText",
      ),
    },
    structuralContexts.forLimits(SYMBOL_FILE_SEARCH_LIMITS),
  );
  return finishDefinitionDiscovery(args, evidence, budget.finish(rings.governor));
}

function selectedFileAtom(
  scope: SelectedScope,
  scopePath: string,
  queryFingerprint: string,
  nowMs: () => number,
): EvidenceAtom {
  return {
    schemaVersion: scope.schemaVersion,
    stableId: evidenceAtomStableId({
      scopeId: scope.scopeId,
      scopePath,
      lineRange: undefined,
      provenanceKind: "file-listing",
      provenanceTool: "repo.selectedFile",
      queryFingerprint,
    }),
    scopePath,
    lineRange: undefined,
    score: 1,
    provenance: {
      kind: "file-listing",
      tool: "repo.selectedFile",
      queryFingerprint,
    },
    redactionState: "redacted",
    emittedAtMs: nowMs(),
    ledgerRef: undefined,
  };
}

function fileExistsInSearchScope(
  searchScope: SearchScope,
  fs: WorkspaceFs,
  scopePath: string,
  existsCache?: FileExistenceCache,
): boolean {
  const cached = existsCache?.files.get(scopePath);
  if (cached !== undefined) return cached;
  const parentScopePath = dirname(scopePath);
  const entryName = basenameScopePath(scopePath);
  const directory = cachedDirectoryEntries(
    searchScope,
    fs,
    parentScopePath,
    PROJECT_METADATA_FILENAMES.length,
    existsCache,
  );
  const entry = directory.entries.find((candidate) => candidate.name === entryName);
  if (entry === undefined) {
    const exists =
      directory.status === "complete"
        ? false
        : fileExistsByContainedStat(searchScope, fs, scopePath);
    existsCache?.files.set(scopePath, exists);
    return exists;
  }
  // A Dirent is only an enumeration hint. The path may have been replaced after readDir(), and a
  // hard link is reported as an ordinary file, so every positive candidate still needs the shared
  // canonical/stat authority check before it can produce evidence.
  const exists =
    entry.isFile || entry.isSymbolicLink
      ? fileExistsByContainedStat(searchScope, fs, scopePath)
      : false;
  existsCache?.files.set(scopePath, exists);
  return exists;
}

function fileExistsByContainedStat(
  searchScope: SearchScope,
  fs: WorkspaceFs,
  scopePath: string,
): boolean {
  try {
    const contained = canonicalContainedSearchPath(searchScope, fs, scopePath);
    return containedPathIsSafeRegularFile(fs, contained);
  } catch (error) {
    rethrowMetadataCancellation(error);
    return false;
  }
}

function isSafeRegularFile(stat: WorkspaceStat): boolean {
  return (
    stat.isFile &&
    !stat.isSymbolicLink &&
    (stat.hardLinkCount === undefined || stat.hardLinkCount <= 1)
  );
}

function containedPathIsSafeRegularFile(
  fs: WorkspaceFs,
  contained: ContainedSearchPath | undefined,
): boolean {
  return contained === undefined ? false : isSafeRegularFile(fs.stat(contained.path));
}

interface FileExistenceCache {
  readonly files: Map<string, boolean>;
  readonly directories: Map<string, BoundedDirectoryRead>;
  unavailableDirectoryInspections: number;
  readonly metadataCoverageIssues: Map<MetadataCoverageIssue, number>;
  readonly metadataDirectories: Set<string>;
  readonly metadataWildcardBases: Set<string>;
  readonly metadataScopePaths: ReadonlySet<string> | undefined;
  metadataRetention?: MetadataRetention;
}

function createFileExistenceCache(scopePaths?: readonly string[]): FileExistenceCache {
  return {
    files: new Map(),
    directories: new Map(),
    unavailableDirectoryInspections: 0,
    metadataCoverageIssues: new Map(),
    metadataDirectories: new Set(),
    metadataWildcardBases: new Set(),
    metadataScopePaths: scopePaths === undefined ? undefined : new Set(scopePaths),
  };
}

function basenameScopePath(scopePath: string): string {
  const index = scopePath.lastIndexOf("/");
  return index === -1 ? scopePath : scopePath.slice(index + 1);
}

function cachedDirectoryEntries(
  searchScope: SearchScope,
  fs: WorkspaceFs,
  scopePath: string,
  maxEntries: number,
  existsCache?: FileExistenceCache,
): BoundedDirectoryRead {
  const cacheKey = `${maxEntries.toString()}:${scopePath}`;
  const cached = existsCache?.directories.get(cacheKey);
  if (cached !== undefined) return cached;
  const read = safeReadDir(searchScope, fs, scopePath, maxEntries);
  existsCache?.directories.set(cacheKey, read);
  return read;
}

function selectedFileScopeAtoms(
  input: OrchestratorInput,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  nowMs: () => number,
  existsCache?: FileExistenceCache,
  deadlineAtMs?: number,
  signal?: AbortSignal,
): readonly EvidenceAtom[] {
  if (input.scope.explicitConnection !== true || input.scope.kind !== "files") {
    return [];
  }
  const atoms: EvidenceAtom[] = [];
  const seen = new Set<string>();
  const queryFingerprint = selectedFileQueryFingerprint(input.query);
  const guardedFs = cancellationGuardedWorkspaceFs(fs, signal);
  for (const entry of input.scope.relativePaths) {
    throwIfCancelled(signal);
    if (deadlineAtMs !== undefined && nowMs() >= deadlineAtMs) break;
    if (!isValidScopePath(entry, { mustBeRelative: true })) {
      continue;
    }
    const scopePath = entry.replaceAll("\\", "/");
    if (seen.has(scopePath)) {
      continue;
    }
    seen.add(scopePath);
    // Connected documents (supported DOCX/XLSX/PDF, or a known-unsupported document format) are not
    // code-first excerpt files; they are handled exclusively by bounded document extraction (Issue
    // #1285), so they must not also enter the line-window excerpt path here — that would double-count
    // the file and leave an empty, unreadable code excerpt alongside the document evidence/diagnostic.
    if (isConnectedDocumentPath(scopePath)) {
      continue;
    }
    if (fileExistsInSearchScope(searchScope, guardedFs, scopePath, existsCache)) {
      atoms.push(selectedFileAtom(input.scope, scopePath, queryFingerprint, nowMs));
    }
  }
  return atoms;
}

// Accept a candidate injection path once: not already seen, shape-valid, and NOT deny-listed.
// isDenied is re-checked here (not only at the downstream read gate) so a registry manifest pattern
// can never inject a deny-listed/secret path as a score-1 atom; registry patterns are also asserted
// deny-clean in ecosystems.test.ts. Mutates `seen` on acceptance.
function acceptInjectionScopePath(scopePath: string, seen: Set<string>): boolean {
  if (
    seen.has(scopePath) ||
    !isValidScopePath(scopePath, { mustBeRelative: true }) ||
    isDenied(scopePath)
  ) {
    return false;
  }
  seen.add(scopePath);
  return true;
}

async function rootGlobManifestPaths(
  root: string,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  seen: Set<string>,
  control: MetadataTraversalControl,
  maxResults: number,
  existsCache?: FileExistenceCache,
): Promise<readonly string[]> {
  if (!metadataTraversalCanContinue(control)) return [];
  const paths = await canonicalManifestScopePathsInDir(
    root,
    searchScope,
    fs,
    maxResults,
    control,
    existsCache,
    { cacheAbsentNames: true },
  );
  return paths.filter((path) => acceptInjectionScopePath(path, seen));
}

// The request-scoped input set both deterministic metadata passes read, built once per request so
// the guarded fs, the traversal control and the shared existence cache stay in lockstep across
// them instead of being re-threaded positionally into each pass.
interface MetadataDiscoveryInputs {
  readonly input: OrchestratorInput;
  readonly intent: RetrievalIntent;
  readonly searchScope: SearchScope;
  readonly fs: WorkspaceFs;
  readonly nowMs: () => number;
  readonly queryFingerprint: string;
  readonly control: MetadataTraversalControl;
  readonly existsCache: FileExistenceCache;
  readonly maxResults: number;
}

// `seen` is added per pass, not shared: each pass de-duplicates injection scope paths within its
// own atom set.
interface MetadataAtomCollectionContext extends MetadataDiscoveryInputs {
  readonly seen: Set<string>;
}

async function projectMetadataRootAtoms(
  root: string,
  context: MetadataAtomCollectionContext,
): Promise<readonly EvidenceAtom[]> {
  const {
    input,
    searchScope,
    fs,
    nowMs,
    queryFingerprint,
    control,
    existsCache,
    seen,
    maxResults,
  } = context;
  const atoms: EvidenceAtom[] = [];
  const globPaths = await rootGlobManifestPaths(
    root,
    searchScope,
    fs,
    seen,
    control,
    maxResults,
    existsCache,
  );
  for (const filename of PROJECT_METADATA_FILENAMES) {
    if (!metadataTraversalCanContinue(control)) break;
    const scopePath = joinScopePath(root, filename);
    if (
      isAdmittedMetadataPath(scopePath, searchScope, existsCache) &&
      (globPaths.includes(scopePath) || acceptInjectionScopePath(scopePath, seen)) &&
      fileExistsInSearchScope(searchScope, fs, scopePath, existsCache)
    ) {
      existsCache.metadataRetention?.observeRootFallback(scopePath);
      atoms.push(metadataAtom(input.scope, scopePath, queryFingerprint, nowMs));
    }
  }
  for (const scopePath of globPaths.filter(
    (path) => !atoms.some((atom) => atom.scopePath === path),
  )) {
    atoms.push(metadataAtom(input.scope, scopePath, queryFingerprint, nowMs));
  }
  return atoms;
}

async function workspacePackageMetadataAtoms(
  context: MetadataAtomCollectionContext,
): Promise<readonly EvidenceAtom[]> {
  const {
    input,
    searchScope,
    fs,
    nowMs,
    queryFingerprint,
    control,
    existsCache,
    seen,
    maxResults,
  } = context;
  const atoms: EvidenceAtom[] = [];
  for (const scopePath of await workspacePackageManifestPaths(
    input,
    searchScope,
    fs,
    control,
    maxResults,
    existsCache,
  )) {
    if (!metadataTraversalCanContinue(control)) break;
    if (acceptInjectionScopePath(scopePath, seen)) {
      atoms.push(metadataAtom(input.scope, scopePath, queryFingerprint, nowMs));
    }
  }
  return atoms;
}

async function projectMetadataAtoms(
  inputs: MetadataDiscoveryInputs,
): Promise<readonly EvidenceAtom[]> {
  const { input, intent, control } = inputs;
  if (!wantsProjectMetadata(input, intent) || !metadataTraversalCanContinue(control)) {
    return [];
  }
  const context: MetadataAtomCollectionContext = { ...inputs, seen: new Set<string>() };
  const retained = new MetadataRetention(
    inputs.maxResults,
    MAX_OMITTED_CONTEXT_ENTRIES,
    metadataRootsForScope(input.scope),
    PROJECT_METADATA_FILENAMES,
  );
  inputs.existsCache.metadataRetention = retained;
  for (const root of metadataRootsForScope(input.scope)) {
    if (!metadataTraversalCanContinue(control)) break;
    await projectMetadataRootAtoms(root, context);
  }
  await workspacePackageMetadataAtoms(context);
  return retained
    .retainedPaths()
    .map((path) => metadataAtom(input.scope, path, inputs.queryFingerprint, inputs.nowMs));
}

function repositoryOverviewAtoms(inputs: MetadataDiscoveryInputs): readonly EvidenceAtom[] {
  const { input, intent, searchScope, fs, nowMs, queryFingerprint, control, existsCache } = inputs;
  if (!wantsRepositoryOverview(intent) || !metadataTraversalCanContinue(control)) {
    return [];
  }
  const atoms: EvidenceAtom[] = [];
  const seen = new Set<string>();
  for (const root of metadataRootsForScope(input.scope)) {
    if (!metadataTraversalCanContinue(control)) break;
    for (const filename of REPOSITORY_OVERVIEW_FILENAMES) {
      if (!metadataTraversalCanContinue(control)) break;
      const scopePath = joinScopePath(root, filename);
      if (
        acceptInjectionScopePath(scopePath, seen) &&
        fileExistsInSearchScope(searchScope, fs, scopePath, existsCache)
      ) {
        atoms.push(overviewAtom(input.scope, scopePath, queryFingerprint, nowMs));
      }
    }
  }
  return atoms;
}

interface DeterministicContextEvidence {
  readonly metadataRetention?: MetadataRetentionObservation | undefined;
  readonly atoms: readonly EvidenceAtom[];
  readonly uncertainty: readonly UncertaintyMarker[];
  readonly omitted?: readonly OmittedContextEntry[];
}

function mergeDeterministicEvidence(
  sources: readonly DeterministicContextEvidence[],
): DeterministicContextEvidence {
  return {
    metadataRetention: sources.find((source) => source.metadataRetention !== undefined)
      ?.metadataRetention,
    atoms: sources.flatMap((source) => source.atoms),
    uncertainty: sources.flatMap((source) => source.uncertainty),
    omitted: sources.flatMap((source) => source.omitted ?? []),
  };
}

function metadataDirectoryCoverageUncertainty(
  cache: FileExistenceCache,
  nowMs: number,
): readonly UncertaintyMarker[] {
  const markers: UncertaintyMarker[] = [];
  if (cache.unavailableDirectoryInspections > 0) {
    markers.push({
      kind: "scope-incomplete",
      claim:
        `project metadata discovery could not enumerate ` +
        `${String(cache.unavailableDirectoryInspections)} directory inspection(s); ` +
        `exact manifest probes were used but glob manifests may be missing`,
      impactedAtomIds: [],
      emittedAtMs: nowMs,
    });
  }
  return markers;
}

function metadataManifestCoverageUncertainty(
  cache: FileExistenceCache,
  nowMs: number,
): readonly UncertaintyMarker[] {
  if (cache.metadataCoverageIssues.size === 0) return [];
  const issueCounts = [...cache.metadataCoverageIssues]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([issue, count]) => `${issue}:${String(count)}`)
    .join(",");
  return [
    {
      kind: "scope-incomplete",
      claim:
        `project metadata discovery skipped bounded or unsupported workspace metadata ` +
        `(reasons=${issueCounts}); workspace package manifests may be missing`,
      impactedAtomIds: [],
      emittedAtMs: nowMs,
    },
  ];
}

async function deterministicMetadataEvidence(
  input: OrchestratorInput,
  plan: ExplorationPlan,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  nowMs: () => number,
  signal: AbortSignal | undefined,
  deadlineAtMs: number,
): Promise<DeterministicContextEvidence> {
  const control: MetadataTraversalControl = { signal, nowMs, deadlineAtMs };
  const existsCache = createFileExistenceCache(input.scope.relativePaths);
  const discovery: MetadataDiscoveryInputs = {
    input,
    intent: plan.retrievalIntent,
    searchScope,
    fs: metadataTraversalFs(fs, control),
    nowMs,
    queryFingerprint: projectMetadataQueryFingerprint(input.query),
    control,
    existsCache,
    maxResults: plan.budget.filesReadMax ?? input.query.maxResults,
  };
  const atoms = [...(await projectMetadataAtoms(discovery)), ...repositoryOverviewAtoms(discovery)];
  const emittedAtMs = nowMs();
  return {
    atoms,
    omitted: metadataRetentionOmissions(existsCache, emittedAtMs),
    metadataRetention: existsCache.metadataRetention?.observation(),
    uncertainty: [
      ...metadataDirectoryCoverageUncertainty(existsCache, emittedAtMs),
      ...metadataManifestCoverageUncertainty(existsCache, emittedAtMs),
      ...metadataRetentionUncertainty(existsCache, emittedAtMs),
    ],
  };
}

function metadataRetentionOmissions(
  cache: FileExistenceCache,
  nowMs: number,
): readonly OmittedContextEntry[] {
  return (cache.metadataRetention?.omittedPaths() ?? []).map((scopePath) => ({
    scopePath,
    reason: "budget-exhausted",
    omittedAtMs: nowMs,
  }));
}

function metadataRetentionUncertainty(
  cache: FileExistenceCache,
  nowMs: number,
): readonly UncertaintyMarker[] {
  const count = cache.metadataRetention?.discardedCount ?? 0;
  return count === 0
    ? []
    : [
        {
          kind: "budget-clipped",
          claim:
            `project metadata retention omitted ${String(count)} observed manifest candidates; ` +
            `canonical omission paths are bounded representative details, not an unfinished traversal`,
          impactedAtomIds: [],
          emittedAtMs: nowMs,
        },
      ];
}

type ParallelDeterministicEvidence = readonly [
  DeterministicContextEvidence,
  DeterministicContextEvidence,
  DeterministicContextEvidence,
];

// The one request-scoped input set every deterministic-evidence step reads, kept as a single value
// so the shared members stay in lockstep across the collect/metadata/merge chain instead of being
// re-threaded positionally at each hop.
interface DeterministicContextInputs {
  readonly lexicalAtoms?: readonly EvidenceAtom[];
  readonly symbolDiscovery?: SymbolDiscoveryResult | undefined;
  readonly skipOptionalTrace?: boolean;
  readonly input: OrchestratorInput;
  readonly plan: ExplorationPlan;
  readonly searchScope: SearchScope;
  readonly fs: WorkspaceFs;
  // The request's plain, unwrapped fs — used only for project-metadata discovery (#3347 P1), which
  // is not bound to `structuralContexts` and must keep making its own real, individually observable
  // reads rather than the ring-retrieval discovery cache `fs` may carry.
  readonly metadataFs: WorkspaceFs;
  readonly nowMs: () => number;
  readonly signal: AbortSignal | undefined;
  readonly structuralContexts: StructuralRequestContextPool;
  readonly deadlineAtMs: number;
  readonly budget: AugmentationBudgetMeter;
}

async function collectParallelDeterministicEvidence(
  inputs: DeterministicContextInputs,
  fileSearchContext: StructuralAdapterRequestContext,
  traceContext: StructuralAdapterRequestContext,
): Promise<ParallelDeterministicEvidence> {
  const controller = new AbortController();
  const signal = parallelStageSignal(controller, inputs.signal);
  const { input, plan, searchScope, fs, nowMs, deadlineAtMs, budget } = inputs;
  const pending = [
    inputs.skipOptionalTrace === true
      ? Promise.resolve({ atoms: [], uncertainty: [] })
      : collectFollowSymbolTraceEvidence({
          scope: input.scope,
          query: input.query,
          anchors: plan.anchors,
          retrievalIntent: plan.retrievalIntent,
          searchScope,
          fs,
          nowMs,
          signal,
          requestContext: traceContext,
          deadlineAtMs,
          tryReserveSearchCall: budget.tryReserveSearchCall,
        }),
    inputs.symbolDiscovery === undefined
      ? symbolFileAtoms({ ...inputs, signal }, fileSearchContext)
      : Promise.resolve({ atoms: [], uncertainty: [] }),
    documentReferenceAtoms(input, plan, nowMs, signal, fileSearchContext, budget),
  ] as const;
  return settleParallelStage(Promise.all(pending), pending, controller);
}

// Project metadata streams the admitted filesystem directly, retaining only the accepted evidence
// budget. It does not depend on structural inventories or their filesystem identity binding.
async function deterministicMetadataAtoms(
  inputs: DeterministicContextInputs,
): Promise<DeterministicContextEvidence> {
  return inputs.budget.canContinue()
    ? deterministicMetadataEvidence(
        inputs.input,
        inputs.plan,
        inputs.searchScope,
        inputs.metadataFs,
        inputs.nowMs,
        inputs.signal,
        inputs.deadlineAtMs,
      )
    : { atoms: [], uncertainty: [] };
}

async function deterministicContextEvidence(
  inputs: DeterministicContextInputs,
): Promise<DeterministicContextEvidence> {
  const fileSearchContext = inputs.structuralContexts.forLimits(SYMBOL_FILE_SEARCH_LIMITS);
  const traceContext = inputs.structuralContexts.forLimits(GROUNDED_TRACE_SEARCH_LIMITS);
  const [traceEvidence, symbolDiscovery, referencedDocuments] =
    await collectParallelDeterministicEvidence(inputs, fileSearchContext, traceContext);
  const metadata = await deterministicMetadataAtoms(inputs);
  return mergeDeterministicEvidence([
    symbolDiscovery,
    traceEvidence,
    referencedDocuments,
    metadata,
  ]);
}

async function withDeterministicContextAtoms(
  rings: RingRunSummary,
  inputs: DeterministicContextInputs,
): Promise<RingRunSummary> {
  const deterministic = await deterministicContextEvidence(inputs);
  if (
    deterministic.atoms.length === 0 &&
    deterministic.uncertainty.length === 0 &&
    deterministic.metadataRetention === undefined
  ) {
    return rings;
  }
  return {
    ...rings,
    metadataRetention: deterministic.metadataRetention,
    atoms: [...rings.atoms, ...deterministic.atoms],
    omitted: [...rings.omitted, ...(deterministic.omitted ?? [])],
    uncertainty: [...rings.uncertainty, ...deterministic.uncertainty],
  };
}

function withExplicitScopeAtoms(
  rings: RingRunSummary,
  input: OrchestratorInput,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  nowMs: () => number,
  deadlineAtMs: number,
  signal: AbortSignal | undefined,
): RingRunSummary {
  const selectedAtoms = selectedFileScopeAtoms(
    input,
    searchScope,
    fs,
    nowMs,
    createFileExistenceCache(),
    deadlineAtMs,
    signal,
  );
  return selectedAtoms.length === 0
    ? rings
    : { ...rings, atoms: [...selectedAtoms, ...rings.atoms] };
}

function queryTerms(queryText: string, anchors: readonly SearchAnchor[]): readonly string[] {
  const terms = new Set<string>();
  const loweredQuery = queryText.toLowerCase();
  for (const token of loweredQuery.split(/[^a-z0-9._/-]+/)) {
    if (token.length > 0) {
      terms.add(token);
    }
  }
  for (const anchor of anchors) {
    const lowered = anchor.term.toLowerCase();
    if (lowered.length > 0) {
      terms.add(lowered);
    }
    for (const token of lowered.split(/[^a-z0-9._/-]+/)) {
      if (token.length > 0) {
        terms.add(token);
      }
    }
  }
  return [...terms];
}

function explicitlyTargetsRuntimeArtifact(
  scopePath: string,
  queryText: string,
  anchors: readonly SearchAnchor[],
): boolean {
  if (!isKeikoEvidenceArtifact(scopePath)) {
    return false;
  }
  const loweredQuery = queryText.toLowerCase();
  if (loweredQuery.includes(".keiko") || loweredQuery.includes("evidence artifact")) {
    return true;
  }
  return queryTerms(queryText, anchors).some((term) => scopePath.toLowerCase().includes(term));
}

function explicitlyTargetsLockfile(
  scopePath: string,
  queryText: string,
  anchors: readonly SearchAnchor[],
): boolean {
  if (!isLockfilePath(scopePath)) {
    return false;
  }
  const loweredQuery = queryText.toLowerCase();
  if (
    loweredQuery.includes("lockfile") ||
    loweredQuery.includes("package manager") ||
    loweredQuery.includes("packagemanager") ||
    loweredQuery.includes("dependency version") ||
    loweredQuery.includes("dependency versions") ||
    loweredQuery.includes("resolved version") ||
    loweredQuery.includes("resolved versions")
  ) {
    return true;
  }
  const path = scopePath.toLowerCase();
  const name = basename(scopePath).toLowerCase();
  return queryTerms(queryText, anchors).some((term) => path.includes(term) || name === term);
}

function orderForDistinctEvidencePaths(
  kept: readonly CandidateFile[],
  anchors: readonly SearchAnchor[],
  priorityPaths: Set<string>,
): readonly CandidateFile[] {
  const selected = new Set(kept.slice(0, 1));
  for (const anchor of anchors) {
    if (anchor.kind === "literal" || anchor.weight < 0.7) continue;
    const term = anchor.term.toLowerCase();
    const candidate =
      [...selected].find((entry) => entry.scopePath.toLowerCase().includes(term)) ??
      kept.find((entry) => entry.scopePath.toLowerCase().includes(term));
    if (candidate !== undefined) {
      selected.add(candidate);
      priorityPaths.add(candidate.scopePath);
    }
  }
  const names = new Set(
    [...selected].map((candidate) => basename(candidate.scopePath).toLowerCase()),
  );
  for (const candidate of kept) {
    const name = basename(candidate.scopePath).toLowerCase();
    if (names.has(name)) continue;
    names.add(name);
    selected.add(candidate);
  }
  return [...selected, ...kept.filter((candidate) => !selected.has(candidate))];
}

function refineCandidateOrdering(
  kept: readonly CandidateFile[],
  omitted: readonly OmittedContextEntry[],
  query: RetrievalQuery,
  anchors: readonly SearchAnchor[],
  diagnostics: ContextPackDiagnostics | undefined,
  nowMs: number,
): CandidateOrdering {
  const queryText = query.text;
  const preferred: CandidateFile[] = [];
  const lockfiles: CandidateFile[] = [];
  const runtimeArtifacts: CandidateFile[] = [];

  for (const candidate of kept) {
    const scopePath = candidate.scopePath;
    if (
      isKeikoEvidenceArtifact(scopePath) &&
      !explicitlyTargetsRuntimeArtifact(scopePath, queryText, anchors)
    ) {
      runtimeArtifacts.push(candidate);
      continue;
    }
    if (isLockfilePath(scopePath) && !explicitlyTargetsLockfile(scopePath, queryText, anchors)) {
      lockfiles.push(candidate);
      continue;
    }
    preferred.push(candidate);
  }

  if (preferred.length === 0) {
    return { kept, omitted };
  }

  const nextOmitted = runtimeArtifactOmissions(omitted, runtimeArtifacts, nowMs);
  const priorityPaths = new Set<string>();
  const useSearchOrder = candidateOrderingUsesSearchOrder(query, anchors, diagnostics);
  const orderedPreferred = useSearchOrder
    ? orderPreferredCandidates(preferred, diagnostics, priorityPaths)
    : preferred;
  return {
    kept: [
      ...orderForDistinctEvidencePaths(orderedPreferred, anchors, priorityPaths),
      ...lockfiles,
    ],
    omitted: nextOmitted,
    priorityPaths,
  };
}

function runtimeArtifactOmissions(
  omitted: readonly OmittedContextEntry[],
  artifacts: readonly CandidateFile[],
  nowMs: number,
): readonly OmittedContextEntry[] {
  return [
    ...omitted,
    ...artifacts.map((candidate): OmittedContextEntry => ({
      scopePath: candidate.scopePath,
      reason: "low-relevance",
      omittedAtMs: nowMs,
    })),
  ].sort(compareByScopePath);
}

function candidateOrderingUsesSearchOrder(
  query: RetrievalQuery,
  anchors: readonly SearchAnchor[],
  diagnostics: ContextPackDiagnostics | undefined,
): boolean {
  return (
    queryTargetsRouteImplementation(query.text) ||
    directDefinitionSymbol(query, anchors) !== undefined ||
    (isOrdinaryDocumentLookup(query, false, diagnostics) &&
      anchors.some(
        (anchor) =>
          (anchor.kind === "identifier" || anchor.kind === "quoted") && anchor.weight >= 0.85,
      ))
  );
}

const ROUTE_METHOD_QUERY_RE = /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/iu;
const ROUTE_PATH_QUERY_RE = /\/[A-Za-z0-9:_?&=./-]*[A-Za-z0-9_}/-]/u;
const ROUTE_INTENT_QUERY_RE =
  /\b(?:api|endpoint|handler|implement|implements|implemented|route)\b/iu;

function queryTargetsRouteImplementation(queryText: string): boolean {
  return (
    ROUTE_METHOD_QUERY_RE.test(queryText) &&
    ROUTE_PATH_QUERY_RE.test(queryText) &&
    ROUTE_INTENT_QUERY_RE.test(queryText)
  );
}

function orderPreferredCandidates(
  kept: readonly CandidateFile[],
  diagnostics: ContextPackDiagnostics | undefined,
  priorityPaths: Set<string>,
): readonly CandidateFile[] {
  const ranked = diagnostics?.rankedCandidates ?? [];
  if (ranked.length === 0 || kept.length <= 1) {
    return kept;
  }
  const byPath = new Map(kept.map((candidate) => [candidate.scopePath, candidate]));
  const routeCandidate = ranked
    .map((candidate) => byPath.get(candidate.scopePath))
    .find((candidate) => candidate !== undefined);
  if (routeCandidate === undefined) return kept;
  priorityPaths.add(routeCandidate.scopePath);
  return [routeCandidate, ...kept.filter((candidate) => candidate !== routeCandidate)];
}

function groupEvidenceAtomsByPath(
  atoms: readonly EvidenceAtom[],
): ReadonlyMap<string, readonly EvidenceAtom[]> {
  const grouped = new Map<string, EvidenceAtom[]>();
  for (const atom of atoms) {
    const existing = grouped.get(atom.scopePath);
    if (existing === undefined) {
      grouped.set(atom.scopePath, [atom]);
    } else {
      existing.push(atom);
    }
  }
  return grouped;
}

function lineWindowForAtom(atom: EvidenceAtom): LineWindow {
  const range = atom.lineRange;
  if (range === undefined) {
    return DEFAULT_EXCERPT_WINDOW;
  }
  const isDiscoveredDefinition = tracePriority(atom) === 2;
  const addSingleLineContext =
    range.startLine === range.endLine &&
    atom.provenance.kind !== "semantic-search" &&
    atom.provenance.kind !== "model-rerank";
  let contextBefore: number;
  let contextAfter: number;
  if (isDiscoveredDefinition) {
    contextBefore = 0;
    contextAfter = DISCOVERED_DEFINITION_CONTEXT_AFTER;
  } else {
    const surroundingContext = addSingleLineContext ? SINGLE_LINE_EXCERPT_CONTEXT_LINES : 0;
    contextBefore = surroundingContext;
    contextAfter = surroundingContext;
  }
  return {
    startLine: Math.max(1, range.startLine - contextBefore),
    endLine: range.endLine + contextAfter,
  };
}

function mergeLineWindows(windows: readonly LineWindow[]): readonly LineWindow[] {
  const sorted = [...windows].sort((a, b) =>
    a.startLine === b.startLine ? a.endLine - b.endLine : a.startLine - b.startLine,
  );
  const merged: LineWindow[] = [];
  for (const window of sorted) {
    const previous = merged.at(-1);
    if (previous === undefined || window.startLine > previous.endLine + 1) {
      merged.push(window);
      continue;
    }
    merged[merged.length - 1] = {
      startLine: previous.startLine,
      endLine: Math.max(previous.endLine, window.endLine),
    };
  }
  return merged;
}

function windowContainsAtom(window: LineWindow, atom: EvidenceAtom): boolean {
  const range = atom.lineRange;
  return (
    range === undefined || (window.startLine <= range.startLine && window.endLine >= range.endLine)
  );
}

interface ExcerptWindowStrength {
  readonly tracePriority: number;
  readonly score: number;
}

function mergeWindowsByTracePriority(atomsForPath: readonly EvidenceAtom[]): readonly LineWindow[] {
  let selected: readonly LineWindow[] = [];
  for (const priority of [2, 1, 0]) {
    const windows = mergeLineWindows(
      atomsForPath.filter((atom) => tracePriority(atom) === priority).map(lineWindowForAtom),
    );
    selected = selected
      .concat(nonOverlappingExcerptWindows(windows, selected))
      .sort((a, b) => a.startLine - b.startLine);
  }
  return selected;
}

function nonOverlappingExcerptWindows(
  windows: readonly LineWindow[],
  selected: readonly LineWindow[],
): readonly LineWindow[] {
  const retained: LineWindow[] = [];
  let index = 0;
  for (const window of windows) {
    while ((selected[index]?.endLine ?? Infinity) < window.startLine) index += 1;
    if ((selected[index]?.startLine ?? Infinity) > window.endLine) retained.push(window);
  }
  return retained;
}

function strongerExcerptWindow(
  candidate: ExcerptWindowStrength,
  current: ExcerptWindowStrength,
): ExcerptWindowStrength {
  if (candidate.tracePriority !== current.tracePriority) {
    return candidate.tracePriority > current.tracePriority ? candidate : current;
  }
  return candidate.score > current.score ? candidate : current;
}

function windowIndexContainingLine(windows: readonly LineWindow[], line: number): number {
  let low = 0;
  let high = windows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((windows[middle]?.startLine ?? Infinity) <= line) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

function rankedExcerptWindows(
  windows: readonly LineWindow[],
  atoms: readonly EvidenceAtom[],
): readonly LineWindow[] {
  const sorted = [...windows].sort((a, b) => a.startLine - b.startLine);
  const strengths = sorted.map((): ExcerptWindowStrength => ({ tracePriority: 0, score: 0 }));
  let unlocated: ExcerptWindowStrength = { tracePriority: 0, score: 0 };
  for (const atom of atoms) {
    const strength = { tracePriority: tracePriority(atom), score: atom.score };
    const range = atom.lineRange;
    if (range === undefined) {
      unlocated = strongerExcerptWindow(strength, unlocated);
      continue;
    }
    const index = windowIndexContainingLine(sorted, range.startLine);
    const window = sorted[index];
    const current = strengths[index];
    if (window !== undefined && current !== undefined && windowContainsAtom(window, atom))
      strengths[index] = strongerExcerptWindow(strength, current);
  }
  return sorted
    .map((window, index) => ({
      window,
      strength: strongerExcerptWindow(strengths[index] ?? unlocated, unlocated),
    }))
    .sort(
      (a, b) =>
        b.strength.tracePriority - a.strength.tracePriority ||
        b.strength.score - a.strength.score ||
        a.window.startLine - b.window.startLine,
    )
    .map(({ window }) => window);
}

interface ExcerptWindowSelection {
  readonly windows: readonly LineWindow[];
  readonly omittedWindowCount: number;
}

function excerptLineWindows(
  atomsForPath: readonly EvidenceAtom[] | undefined,
): ExcerptWindowSelection {
  if (atomsForPath === undefined || atomsForPath.length === 0) {
    return { windows: [DEFAULT_EXCERPT_WINDOW], omittedWindowCount: 0 };
  }
  const merged = mergeWindowsByTracePriority(atomsForPath);
  const selected = rankedExcerptWindows(merged, atomsForPath);
  return {
    windows: selected,
    omittedWindowCount: Math.max(0, merged.length - selected.length),
  };
}

function exhaustedDimensions(remainingFiles: number, remainingBytes: number): string {
  return [
    ...(remainingFiles <= 0 ? ["filesRead"] : []),
    ...(remainingBytes <= 0 ? ["excerptBytes"] : []),
  ].join(", ");
}

interface ReadPathExcerptWindowsResult {
  readonly anchoredWindowCount: number;
  readonly windows: readonly ExcerptWindow[];
  readonly bytesConsumed: number;
  readonly omittedWindowCount: number;
  readonly truncatedWindowCount: number;
  readonly deadlineReached: boolean;
}

type ExcerptSkippedReason = "too-large" | "unsupported" | "timeout";

interface ReadPathExcerptTaskResult {
  readonly scopePath: string;
  readonly result?: ReadPathExcerptWindowsResult | undefined;
  readonly skippedReason?: ExcerptSkippedReason | undefined;
  readonly omissionReason?: CandidateOmissionReason | undefined;
}

function appendReadExcerptWindows(
  result: ReadExcerptResult,
  windows: ExcerptWindow[],
): { readonly bytes: number; readonly truncated: number; readonly anchored: number } {
  let bytes = 0;
  let truncated = 0;
  let anchored = 0;
  const seen = new Set(windows.map(excerptWindowKey));
  for (const read of result.windows ?? [result]) {
    const range = read.atom.lineRange;
    if (range === undefined) continue;
    const identity = read.truncated
      ? connectedContextActivityDigest("keiko.excerpt-window.v1", [
          String(range.startLine),
          String(range.endLine),
          read.content,
        ])
      : undefined;
    const key = excerptWindowKey({ ...range, content: "", identity });
    if (seen.has(key)) continue;
    seen.add(key);
    windows.push({
      ...range,
      content: read.content,
      ...(identity === undefined ? {} : { identity }),
    });
    bytes += utf8ByteLength(read.content);
    truncated += Number(read.truncated);
    anchored += Number(read.anchoredWindowApplied === true);
  }
  return { bytes, truncated, anchored };
}

function excerptWindowKey(window: ExcerptWindow): string {
  return JSON.stringify([window.startLine, window.endLine, window.identity ?? null]);
}

function remainingExcerptWindowBytes(
  scopePath: string,
  availableBytes: number,
  inputs: ExcerptInputs,
): number {
  return Math.min(
    inputs.knownFitFileBytes?.get(scopePath) ?? MAX_EXCERPT_WINDOW_BYTES,
    availableBytes,
  );
}

function qualifiedWholeFileRanges(
  scopePath: string,
  windows: readonly LineWindow[],
  inputs: ExcerptInputs,
): boolean {
  if (inputs.knownFitFileBytes?.has(scopePath) !== true) return false;
  const wholeFile = (inputs.atomsByPath.get(scopePath) ?? []).find(
    (atom) =>
      atom.provenance.kind === "file-listing" &&
      atom.provenance.tool === "repo.findFiles" &&
      atom.lineRange !== undefined,
  );
  return (
    wholeFile !== undefined && windows.every((window) => windowContainsAtom(window, wholeFile))
  );
}

async function readPathExcerptWindows(
  scopePath: string,
  inputs: ExcerptInputs,
  remainingBytes: number,
): Promise<ReadPathExcerptWindowsResult> {
  const windows: ExcerptWindow[] = [];
  const selection = excerptLineWindows(inputs.atomsByPath.get(scopePath));
  const containingRange = containingExcerptRange(selection.windows);
  throwIfCancelled(inputs.signal);
  if (inputs.nowMs() >= inputs.deadlineAtMs || remainingBytes <= 0)
    return unreadExcerptWindows(selection, inputs.nowMs() >= inputs.deadlineAtMs);
  const result = await readExcerpt(
    inputs.searchScope,
    {
      scopePath,
      ...containingRange,
      ranges: selection.windows,
      maxBytes: remainingExcerptWindowBytes(scopePath, remainingBytes, inputs),
      anchors: qualifiedWholeFileRanges(scopePath, selection.windows, inputs)
        ? undefined
        : inputs.anchors,
      maxTotalBytes: remainingBytes,
      maxWindows: Math.max(1, remainingBytes),
    },
    {
      fs: inputs.fs,
      nowMs: inputs.nowMs,
      deadlineAtMs: inputs.deadlineAtMs,
      ...(inputs.signal === undefined ? {} : { signal: inputs.signal }),
    },
  );
  throwIfCancelled(inputs.signal);
  if (inputs.nowMs() >= inputs.deadlineAtMs) return unreadExcerptWindows(selection, true);
  const appended = appendReadExcerptWindows(result, windows);
  return {
    windows,
    bytesConsumed: appended.bytes,
    truncatedWindowCount: appended.truncated,
    anchoredWindowCount: appended.anchored,
    deadlineReached: false,
    omittedWindowCount: selection.omittedWindowCount + (result.omittedRangeCount ?? 0),
  };
}

function containingExcerptRange(windows: readonly LineWindow[]): LineWindow {
  let startLine = Infinity;
  let endLine = 1;
  for (const window of windows) {
    startLine = Math.min(startLine, window.startLine);
    endLine = Math.max(endLine, window.endLine);
  }
  return { startLine, endLine };
}

function unreadExcerptWindows(
  selection: ExcerptWindowSelection,
  deadlineReached: boolean,
): ReadPathExcerptWindowsResult {
  return {
    windows: [],
    bytesConsumed: 0,
    truncatedWindowCount: 0,
    anchoredWindowCount: 0,
    omittedWindowCount: selection.omittedWindowCount + selection.windows.length,
    deadlineReached,
  };
}

function excerptReadLossSummary(state: ExcerptWaveState, nowMs: () => number): UncertaintyMarker[] {
  if (
    state.omittedWindowCount === 0 &&
    state.truncatedWindowCount === 0 &&
    state.omitted.length === 0
  )
    return [];
  return [
    {
      kind: "scope-incomplete",
      claim:
        `excerpt read limits omitted ${String(state.omittedWindowCount)} additional matching range(s); ` +
        `excerpt byte limit truncated ${String(state.truncatedWindowCount)} selected range(s); ` +
        `${String(state.omitted.length)} files unavailable during excerpt reading`,
      impactedAtomIds: [],
      emittedAtMs: nowMs(),
    },
  ];
}

function excerptOmissionReason(reason: string): CandidateOmissionReason {
  if (reason === "binary") return "binary";
  if (reason === "timeout" || reason === "aborted") return "budget-exhausted";
  if (reason === "denied" || reason === "outside-scope") return "outside-scope";
  if (reason === "ignored") return "ignored";
  return "tool-unavailable";
}

function distributeByteBudget(totalBytes: number, slots: number): readonly number[] {
  if (slots <= 0 || totalBytes <= 0) return [];
  const base = Math.floor(totalBytes / slots);
  const remainder = totalBytes % slots;
  return Array.from({ length: slots }, (_value, index) => base + (index < remainder ? 1 : 0));
}

async function readPathExcerptTask(
  scopePath: string,
  inputs: ExcerptInputs,
  byteBudget: number,
): Promise<ReadPathExcerptTaskResult> {
  try {
    return {
      scopePath,
      result: await readPathExcerptWindows(scopePath, inputs, byteBudget),
    };
  } catch (error) {
    // A single unreadable file (unsupported/binary, or larger than the excerpt read cap) must
    // degrade to a skipped excerpt, never crash the whole grounded answer. Other kept files and
    // the rest of the pipeline continue; the file simply contributes no excerpt content.
    if (error instanceof FileTooLargeError) {
      return { scopePath, skippedReason: "too-large", omissionReason: "size-exceeded" };
    }
    if (error instanceof RepoSearchUnsupportedFileError) {
      // Preserve the stop reason (#3347 P1): the excerpt facade reports an elapsed-budget stop as
      // `timeout`, and flattening that to `unsupported` erased the only evidence that this file was
      // dropped because the request ran out of time — so no elapsed-budget marker was raised and
      // the completion status reported an unblocked elapsed budget.
      return {
        scopePath,
        skippedReason: error.reason === "timeout" ? "timeout" : "unsupported",
        omissionReason: excerptOmissionReason(error.reason),
      };
    }
    throw error;
  }
}

interface RemainingExcerptCapacity {
  readonly files: number;
  readonly bytes: number;
}

function remainingExcerptCapacity(inputs: ExcerptInputs): RemainingExcerptCapacity {
  return {
    files: Math.max(
      0,
      (inputs.budget.filesReadMax ?? Number.POSITIVE_INFINITY) - inputs.initialUsage.filesRead,
    ),
    bytes: Math.max(0, inputs.budget.excerptBytesMax - inputs.initialUsage.excerptBytes),
  };
}

// Both ways the absolute deadline can stop one file's excerpt read: the loop observed it after a
// read returned (and dropped that result), or the excerpt facade stopped the read itself and
// reported `timeout`.
function excerptTaskStoppedByDeadline({
  result,
  skippedReason,
}: ReadPathExcerptTaskResult): boolean {
  return result?.deadlineReached === true || skippedReason === "timeout";
}

function stoppedExcerptReads(
  inputs: ExcerptInputs,
  remainingFiles: number,
  remainingBytes: number,
): ExcerptReadSummary | undefined {
  if (inputs.nowMs() >= inputs.deadlineAtMs) {
    return {
      excerpts: new Map(),
      uncertainty: [budgetClipped("budget-exhausted on elapsedMs", inputs.nowMs())],
      elapsedBudgetBlocked: true,
    };
  }
  if (remainingFiles <= 0 || remainingBytes <= 0) {
    const dimensions = exhaustedDimensions(remainingFiles, remainingBytes);
    return {
      excerpts: new Map(),
      uncertainty: [budgetClipped(`budget-exhausted on ${dimensions}`, inputs.nowMs())],
      elapsedBudgetBlocked: false,
    };
  }
  return undefined;
}

async function readKeptExcerpts(
  keptPaths: readonly string[],
  inputs: ExcerptInputs,
): Promise<ExcerptReadSummary> {
  const excerpts = new Map<string, readonly ExcerptWindow[]>();
  const uncertainty: UncertaintyMarker[] = [];
  const { files: remainingFiles, bytes: remainingBytes } = remainingExcerptCapacity(inputs);
  const stopped = stoppedExcerptReads(inputs, remainingFiles, remainingBytes);
  if (stopped !== undefined)
    return {
      ...stopped,
      omitted: budgetExcerptOmissions(keptPaths, inputs.nowMs()),
      observation: excerptReadObservation(
        keptPaths.length,
        0,
        0,
        remainingFiles <= 0,
        remainingBytes <= 0,
        stopped.elapsedBudgetBlocked,
      ),
    };
  const readablePaths = keptPaths.slice(0, remainingFiles);
  if (readablePaths.length < keptPaths.length) {
    uncertainty.push(budgetClipped("budget-exhausted on filesRead", inputs.nowMs()));
  }
  const state: ExcerptWaveState = {
    excerpts,
    uncertainty,
    remainingBytes,
    anchoredWindowCount: 0,
    elapsedBudgetBlocked: false,
    byteBudgetOmittedPaths: undefined,
    omitted: [],
    omittedWindowCount: 0,
    truncatedWindowCount: 0,
  };
  await readExcerptWaves(readablePaths, inputs, state);
  uncertainty.push(...excerptReadLossSummary(state, inputs.nowMs));
  if (state.elapsedBudgetBlocked) {
    uncertainty.push(budgetClipped("budget-exhausted on elapsedMs", inputs.nowMs()));
  }
  return completedExcerptSummary(keptPaths, readablePaths, state, inputs.nowMs);
}

function excerptReadObservation(
  unreadFileCount: number,
  omittedRangeCount: number,
  truncatedWindowCount: number,
  fileGrantBlocked: boolean,
  byteGrantBlocked: boolean,
  deadlineBlocked: boolean,
): ExcerptReadObservation {
  const stopReasons: ExcerptStopReason[] = [];
  if (fileGrantBlocked) stopReasons.push("file-grant");
  if (byteGrantBlocked) stopReasons.push("byte-grant");
  if (deadlineBlocked) stopReasons.push("deadline");
  return {
    unreadFileCount,
    omittedRangeCount,
    truncatedWindowCount,
    stopReasons,
    readBudgetBlocked: fileGrantBlocked || byteGrantBlocked,
  };
}

function budgetExcerptOmissions(paths: readonly string[], nowMs: number): OmittedContextEntry[] {
  return paths.map((scopePath) => ({ scopePath, reason: "budget-exhausted", omittedAtMs: nowMs }));
}

function completedExcerptSummary(
  keptPaths: readonly string[],
  readablePaths: readonly string[],
  state: ExcerptWaveState,
  nowMs: () => number,
): ExcerptReadSummary {
  const accounted = new Set([
    ...state.excerpts.keys(),
    ...state.omitted.map((entry) => entry.scopePath),
  ]);
  const readable = new Set(readablePaths);
  const stoppedPaths = keptPaths.filter(
    (path) => !accounted.has(path) && (state.elapsedBudgetBlocked || !readable.has(path)),
  );
  return {
    excerpts: state.excerpts,
    uncertainty: state.uncertainty,
    observation: excerptReadObservation(
      keptPaths.length - state.excerpts.size,
      state.omittedWindowCount,
      state.truncatedWindowCount,
      readablePaths.length < keptPaths.length,
      (state.byteBudgetOmittedPaths?.length ?? 0) > 0 ||
        state.omittedWindowCount > 0 ||
        state.truncatedWindowCount > 0,
      state.elapsedBudgetBlocked,
    ),
    omitted: [
      ...state.omitted,
      ...(stoppedPaths.length === 0 ? [] : budgetExcerptOmissions(stoppedPaths, nowMs())),
    ],
    elapsedBudgetBlocked: state.elapsedBudgetBlocked,
    readWindowCount: [...state.excerpts.values()].reduce(
      (count, windows) => count + windows.length,
      0,
    ),
    anchoredWindowCount: state.anchoredWindowCount,
    ...(state.byteBudgetOmittedPaths === undefined
      ? {}
      : { byteBudgetOmittedPaths: state.byteBudgetOmittedPaths }),
  };
}

interface ExcerptWaveState {
  readonly omitted: OmittedContextEntry[];
  omittedWindowCount: number;
  truncatedWindowCount: number;
  readonly excerpts: Map<string, readonly ExcerptWindow[]>;
  readonly uncertainty: UncertaintyMarker[];
  remainingBytes: number;
  anchoredWindowCount: number;
  elapsedBudgetBlocked: boolean;
  byteBudgetOmittedPaths: readonly string[] | undefined;
}

function appendExcerptWave(
  results: readonly ReadPathExcerptTaskResult[],
  inputs: ExcerptInputs,
  state: ExcerptWaveState,
): void {
  for (const task of results) {
    throwIfCancelled(inputs.signal);
    const { scopePath, result } = task;
    state.elapsedBudgetBlocked ||= excerptTaskStoppedByDeadline(task);
    if (result === undefined || result.windows.length === 0) {
      if (task.omissionReason !== undefined)
        state.omitted.push({ scopePath, reason: task.omissionReason, omittedAtMs: inputs.nowMs() });
      continue;
    }
    state.remainingBytes -= result.bytesConsumed;
    state.anchoredWindowCount += result.anchoredWindowCount;
    state.excerpts.set(scopePath, result.windows);
    state.omittedWindowCount += result.omittedWindowCount;
    state.truncatedWindowCount += result.truncatedWindowCount;
  }
}

async function readExcerptWaves(
  paths: readonly string[],
  inputs: ExcerptInputs,
  state: ExcerptWaveState,
): Promise<void> {
  let next = 0;
  while (next < paths.length && state.remainingBytes > 0 && !state.elapsedBudgetBlocked) {
    throwIfCancelled(inputs.signal);
    if (inputs.nowMs() >= inputs.deadlineAtMs) {
      state.elapsedBudgetBlocked = true;
      break;
    }
    const slots = Math.min(
      8,
      paths.length - next,
      Math.max(1, Math.floor(state.remainingBytes / MAX_EXCERPT_WINDOW_BYTES)),
    );
    const wave = paths.slice(next, next + slots);
    const grants = excerptWaveGrants(wave, state.remainingBytes, inputs);
    const results = await mapWithConcurrency(wave, 8, (scopePath, index) => {
      throwIfCancelled(inputs.signal);
      return readPathExcerptTask(scopePath, inputs, grants[index] ?? 0);
    });
    appendExcerptWave(results, inputs, state);
    next += wave.length;
  }
  if (next < paths.length && state.remainingBytes <= 0) {
    state.byteBudgetOmittedPaths = paths.slice(next);
    state.uncertainty.push(budgetClipped("budget-exhausted on excerptBytes", inputs.nowMs()));
  }
}

function excerptWaveGrants(
  paths: readonly string[],
  totalBytes: number,
  inputs: ExcerptInputs,
): readonly number[] {
  const known = paths.map((path) => inputs.knownFitFileBytes?.get(path));
  const knownBytes = known.reduce<number>((sum, bytes) => sum + (bytes ?? 0), 0);
  if (knownBytes > totalBytes || known.every((bytes) => bytes === undefined))
    return distributeByteBudget(totalBytes, paths.length);
  const remaining = distributeByteBudget(
    totalBytes - knownBytes,
    known.filter((bytes) => bytes === undefined).length,
  );
  let next = 0;
  return known.map((bytes) => bytes ?? remaining[next++] ?? 0);
}

// Internal seam: package-local tests drive the excerpt-read step with a scripted clock, which the
// whole-request path cannot do — every other phase reads the same clock, so a crossing aimed at one
// excerpt read would land somewhere else.
export function _readKeptExcerptsForTests(
  keptPaths: readonly string[],
  inputs: ExcerptInputs,
): Promise<ExcerptReadSummary> {
  return readKeptExcerpts(keptPaths, inputs);
}

function buildSearchScope(scope: SelectedScope, workspace: WorkspaceInfo): SearchScope {
  return {
    workspace,
    scopeId: scope.scopeId,
    relativePaths: scope.relativePaths,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function strongFileCacheIdentity(
  scopePath: string,
  canonicalRelativePath: string,
  stat: WorkspaceStat,
): string | undefined {
  if (
    canonicalRelativePath !== scopePath ||
    !stat.isFile ||
    stat.isSymbolicLink ||
    stat.hardLinkCount !== 1 ||
    !isNonEmptyString(stat.fileIdentity) ||
    !isNonEmptyString(stat.mtimeNs) ||
    !isNonEmptyString(stat.ctimeNs)
  ) {
    return undefined;
  }
  return JSON.stringify({
    scopePath,
    canonicalRelativePath,
    size: stat.size,
    fileIdentity: stat.fileIdentity,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    hardLinkCount: stat.hardLinkCount,
  });
}

async function fileStateCacheIdentity(
  keptPaths: readonly string[],
  searchScope: SearchScope,
  fs: WorkspaceFs,
  nowMs: () => number,
  deadlineAtMs: number,
  signal?: AbortSignal,
): Promise<PackCacheIdentity | undefined> {
  const identity: string[] = [];
  const guardedFs = cancellationGuardedWorkspaceFs(fs, signal);
  try {
    for (const scopePath of keptPaths) {
      throwIfCancelled(signal);
      if (nowMs() >= deadlineAtMs) return undefined;
      const target = canonicalContainedSearchPath(searchScope, guardedFs, scopePath);
      if (target === undefined) return undefined;
      throwIfCancelled(signal);
      if (nowMs() >= deadlineAtMs) return undefined;
      const stat = guardedFs.stat(target.path);
      const strongIdentity = strongFileCacheIdentity(scopePath, target.realRelative, stat);
      if (strongIdentity === undefined) return undefined;
      identity.push(strongIdentity);
      if (identity.length % 64 === 0) await cacheIdentitySchedulingYield(signal);
    }
  } catch (error) {
    rethrowMetadataCancellation(error);
    return undefined;
  }
  if (nowMs() >= deadlineAtMs) return undefined;
  return identity.sort((left, right) => left.localeCompare(right));
}

// Internal mutation seam: package-local tests pin cancellation between synchronous cache-identity
// probes without exposing this implementation detail from the server package root.
export async function _fileStateCacheIdentityForTests(
  keptPaths: readonly string[],
  searchScope: SearchScope,
  fs: WorkspaceFs,
  nowMs: () => number,
  deadlineAtMs: number,
  signal: AbortSignal | undefined,
): Promise<readonly string[] | undefined> {
  return fileStateCacheIdentity(keptPaths, searchScope, fs, nowMs, deadlineAtMs, signal);
}

async function cacheIdentitySchedulingYield(signal?: AbortSignal): Promise<void> {
  // Scheduling batches bound event-loop monopolization, not eligible paths or cache coverage.
  await new Promise<void>((resolve) => setImmediate(resolve));
  throwIfCancelled(signal);
}

interface ReadyPlanResult {
  readonly plan: ExplorationPlan;
  readonly governor: GovernorState;
}

function createReadyGovernedPlan(input: OrchestratorInput, nowMs: () => number): ReadyPlanResult {
  const planned = planAndGovern(
    input.budget === undefined
      ? { scope: input.scope, query: input.query }
      : { scope: input.scope, query: input.query, budget: input.budget },
    { nowMs },
  );
  const { plan } = planned;
  if (plan.state !== "ready") {
    if (plan.clarification !== undefined) {
      throw new ClarificationNeededError(plan.clarification);
    }
    throw new ClarificationNeededError({
      reason: "scope-invalid",
      suggestedQuestions: ["Reselect files or a directory before asking."],
      minimumAnchorCount: 0,
    });
  }
  if (planned.governor === undefined) {
    throw new Error("ready exploration plan did not produce a budget governor");
  }
  return { plan, governor: planned.governor };
}

interface AssembleGroundedPackInputs {
  readonly input: OrchestratorInput;
  readonly deps: OrchestratorDeps;
  readonly plan: ExplorationPlan;
  readonly rings: RingRunSummary;
  readonly searchScope: SearchScope;
  readonly fs: WorkspaceFs;
  // The request's plain, unwrapped fs — used only for project-metadata discovery (#3347 P1), which
  // is not bound to `structuralContexts` and must keep making its own real, individually observable
  // reads rather than the ring-retrieval discovery cache `fs` may carry.
  readonly metadataFs: WorkspaceFs;
  readonly nowMs: () => number;
  readonly structuralContexts: StructuralRequestContextPool;
  readonly workspaceIndex: WorkspaceIndex | undefined;
  readonly deadlineAtMs: number;
  readonly hasGitMetadata: boolean;
}

interface EmptyGroundedPackInputs {
  readonly input: OrchestratorInput;
  readonly deps: OrchestratorDeps;
  readonly plan: ExplorationPlan;
  readonly governor: GovernorState;
  readonly nowMs: () => number;
  readonly stopReason: string;
}

interface GroundedPackCacheLookupInputs {
  readonly input: OrchestratorInput;
  readonly plan: ExplorationPlan;
  readonly rings: RingRunSummary;
  readonly atoms: readonly EvidenceAtom[];
  readonly ordered: CandidateOrdering;
  readonly cacheIdentity: PackCacheIdentity | undefined;
  readonly initialUsage: ExplorationUsage;
  readonly assembleOptions: AssembleOptionsForGroundedPack;
}

interface AssembleOptionsForGroundedPack {
  readonly maxBytesPerExcerptByPath?: ReadonlyMap<string, number>;
  readonly includeSurroundingContext: boolean;
  readonly nowMs: () => number;
  readonly microIndex?: MicroIndex;
  readonly reranker?: RerankerSeam;
}

function knownFitAssembleOptions(
  options: AssembleOptionsForGroundedPack,
  rings: RingRunSummary,
): AssembleOptionsForGroundedPack {
  return rings.knownFitFileBytes === undefined
    ? options
    : { ...options, maxBytesPerExcerptByPath: rings.knownFitFileBytes };
}

function deadlineBoundMicroIndex(
  index: MicroIndex,
  nowMs: () => number,
  deadlineAtMs: number,
): MicroIndex {
  const canStart = (): boolean => nowMs() < deadlineAtMs;
  return {
    get: (key): ConnectedContextPack | undefined => (canStart() ? index.get(key) : undefined),
    set: (key, pack): void => {
      if (canStart()) index.set(key, pack);
    },
    delete: index.delete.bind(index),
    clear: index.clear.bind(index),
    size: index.size.bind(index),
  };
}

async function raceRerankerToDeadline<T>(
  operation: (context: RerankerExecutionContext) => Promise<T>,
  nowMs: () => number,
  deadlineAtMs: number,
  callerSignal: AbortSignal | undefined,
): Promise<T | undefined> {
  try {
    return await raceAbortDeadline(operation, {
      deadlineAtMs,
      nowMs,
      ...(callerSignal === undefined ? {} : { signal: callerSignal }),
    });
  } catch (error) {
    if (error instanceof AbortDeadlineRaceError) {
      if (error.reason === "aborted") {
        throw new CancelledError("grounded repository request cancelled");
      }
      return undefined;
    }
    throw error;
  }
}

function deadlineBoundReranker(
  reranker: RerankerSeam,
  nowMs: () => number,
  deadlineAtMs: number,
  callerSignal: AbortSignal | undefined,
): RerankerSeam {
  return {
    name: reranker.name,
    isAvailable: async (): ReturnType<RerankerSeam["isAvailable"]> => {
      const availability = await raceRerankerToDeadline(
        (context) => reranker.isAvailable(context),
        nowMs,
        deadlineAtMs,
        callerSignal,
      );
      return availability ?? { available: false, reason: "elapsed-budget-exhausted" };
    },
    rerank: async (candidates, atomsByPath, topK): ReturnType<RerankerSeam["rerank"]> => {
      const reordered = await raceRerankerToDeadline(
        (context) => reranker.rerank(candidates, atomsByPath, topK, context),
        nowMs,
        deadlineAtMs,
        callerSignal,
      );
      return reordered ?? candidates;
    },
  };
}

function assembleOptionsFor(
  deps: OrchestratorDeps,
  nowMs: () => number,
  includeMicroIndex: boolean,
  includeReranker = true,
  deadlineAtMs?: number,
): AssembleOptionsForGroundedPack {
  const microIndex =
    deps.microIndex === undefined || deadlineAtMs === undefined
      ? deps.microIndex
      : deadlineBoundMicroIndex(deps.microIndex, nowMs, deadlineAtMs);
  const reranker =
    deps.contextPackReranker === undefined || deadlineAtMs === undefined
      ? deps.contextPackReranker
      : deadlineBoundReranker(deps.contextPackReranker, nowMs, deadlineAtMs, deps.signal);
  return {
    nowMs,
    includeSurroundingContext: true,
    ...(includeMicroIndex && microIndex !== undefined ? { microIndex } : {}),
    ...(includeReranker && reranker !== undefined ? { reranker } : {}),
  };
}

interface PreparedPackAssembly {
  readonly atoms: readonly EvidenceAtom[];
  readonly initialUsage: ExplorationUsage;
  readonly ordered: CandidateOrdering;
  readonly atomsByPath: ReadonlyMap<string, readonly EvidenceAtom[]>;
  readonly evidenceUncertainty: readonly UncertaintyMarker[];
  readonly keptPaths: readonly string[];
}

interface FinalContextPackInputs {
  readonly input: OrchestratorInput;
  readonly plan: ExplorationPlan;
  readonly rings: RingRunSummary;
  readonly prepared: PreparedPackAssembly;
  readonly excerptReads: ExcerptReadSummary;
  readonly documentEvidence: DocumentEvidenceResult;
  readonly cacheIdentity: PackCacheIdentity | undefined;
  readonly cacheKey: string | undefined;
  readonly signal: AbortSignal | undefined;
  readonly assembleOptions: AssembleOptionsForGroundedPack;
}

// Document paths are disjoint from code excerpt paths (documents are excluded from the code-first
// selected-file atoms), so a plain copy-merge never overwrites a code excerpt.
function mergeExcerptSources(
  base: ReadonlyMap<string, readonly ExcerptWindow[]>,
  documents: ReadonlyMap<string, readonly ExcerptWindow[]>,
): ReadonlyMap<string, readonly ExcerptWindow[]> {
  if (documents.size === 0) {
    return base;
  }
  const merged = new Map<string, readonly ExcerptWindow[]>(base);
  for (const [scopePath, windows] of documents) {
    merged.set(scopePath, windows);
  }
  return merged;
}

async function assembleEmptyGroundedPack({
  input,
  deps,
  plan,
  governor,
  nowMs,
  stopReason,
}: EmptyGroundedPackInputs): Promise<ConnectedContextPack> {
  // An empty pack has nothing to rerank or cache. Keeping both seams out also ensures a request
  // stopped before workspace IO cannot start unrelated external work during empty-pack assembly.
  const assembleOptions = assembleOptionsFor(deps, nowMs, false, false);
  const assemble = await assembleContextPack(
    {
      scope: input.scope,
      query: input.query,
      budget: plan.budget,
      atoms: [],
      ranked: [],
      omittedFromRanking: [],
      excerpts: new Map(),
      initialUsage: clampUsageToBudget(governor.usage, plan.budget),
      initialUncertainty: [budgetClipped(stopReason, nowMs())],
    },
    assembleOptions,
  );
  return assemble.pack;
}

function groundedPackCacheKey({
  input,
  plan,
  rings,
  atoms,
  ordered,
  cacheIdentity,
  initialUsage,
  assembleOptions,
}: GroundedPackCacheLookupInputs): string | undefined {
  if (assembleOptions.microIndex === undefined || cacheIdentity === undefined) {
    return undefined;
  }
  const key = contextPackIndexKey(
    {
      scope: input.scope,
      query: input.query,
      budget: plan.budget,
      atoms,
      ranked: ordered.kept,
      omittedFromRanking: [...rings.omitted, ...ordered.omitted],
      excerpts: new Map(),
      cacheIdentity,
      initialUsage,
      diagnostics: rings.diagnostics,
      initialUncertainty: rings.uncertainty,
    },
    knownFitAssembleOptions(assembleOptions, rings),
  );
  return key;
}

function selectPackAtoms(
  atoms: readonly EvidenceAtom[],
  selectedPaths: ReadonlySet<string>,
  input: OrchestratorInput,
  plan: ExplorationPlan,
): readonly EvidenceAtom[] {
  const targetDecision =
    plan.targetDecision ?? resolveQueryTargetDecision(input.query, plan.anchors);
  return selectGroundedEvidenceAtoms(
    atoms,
    selectedPaths,
    input.scope.scopeId,
    targetDecision.definitionRequested,
  );
}

function primaryCandidateFilter(rings: RingRunSummary): typeof DEFAULT_FILTER_OPTIONS {
  return {
    ...DEFAULT_FILTER_OPTIONS,
    minScoreExemptPaths: primaryContentPaths(rings),
    maxKept: new Set(rings.atoms.map((atom) => atom.scopePath)).size,
  };
}

function codeEvidenceAtoms(
  atoms: readonly EvidenceAtom[],
  scope: SelectedScope,
): readonly EvidenceAtom[] {
  // Explicit documents belong to extraction, including its unsupported diagnostics. Keep them
  // off the code excerpt path before merging that exclusively document-owned result.
  return scope.kind === "files" && scope.explicitConnection === true
    ? atoms.filter((atom) => !isConnectedDocumentPath(atom.scopePath))
    : atoms;
}

function selectionEvidencePaths(
  input: OrchestratorInput,
  plan: ExplorationPlan,
  rings: RingRunSummary,
): ReadonlySet<string> {
  const paths = new Set(primaryContentPaths(rings));
  const decision = plan.targetDecision ?? resolveQueryTargetDecision(input.query, plan.anchors);
  if (decision.kind === "contextual") {
    for (const atom of rings.atoms) {
      if (atom.lineRange !== undefined && atom.provenance.tool.startsWith("repo.semanticSearch:"))
        paths.add(atom.scopePath);
    }
  }
  // This changes only relative selection, after normal absolute-score filtering. Semantic
  // context remains secondary and cannot certify literal presence or declaration discovery.
  return paths;
}

function preparePackAssembly(
  input: OrchestratorInput,
  plan: ExplorationPlan,
  rings: RingRunSummary,
  nowMs: () => number,
  hasGitMetadata: boolean,
): PreparedPackAssembly {
  const atoms = codeEvidenceAtoms(rings.atoms, input.scope);
  const initialUsage = clampUsageToBudget(rings.governor.usage, plan.budget);
  // M4: pass the classified retrieval intent so ranking can apply intent-conditioned signals
  // (canonical-metadata, structural-edge). Non-boosted intents (e.g. clarification) and the
  // no-context default are byte-identical — see weightsForIntent / isIntentBoosted.
  const ranking = rankCandidates(
    {
      atoms,
      anchors: primaryRankingAnchors(input, plan),
      context: { retrievalIntent: plan.retrievalIntent },
      ...(hasGitMetadata ? {} : { hints: { generatedPathPatterns: [] } }),
    },
    {
      nowMs,
      // Retain the admitted evidence pool until distinct requested targets are ordered. The
      // accepted file/read/context budgets below still bound the material sent to the model.
      filter: primaryCandidateFilter(rings),
    },
  );
  const refined = refineCandidateOrdering(
    ranking.kept,
    ranking.omitted,
    input.query,
    plan.anchors,
    rings.diagnostics,
    nowMs(),
  );
  const ordered = selectGroundedCandidateFiles({
    ...refined,
    scopeKind: input.scope.kind,
    protectedContentPaths: selectionEvidencePaths(input, plan, rings),
    pathOnlyPaths: pathOnlyEvidencePaths(atoms),
    filesReadMax: plan.budget.filesReadMax,
    nowMs: nowMs(),
  });
  const selectedPaths = new Set(ordered.kept.map((candidate) => candidate.scopePath));
  const selectedAtoms = selectPackAtoms(atoms, selectedPaths, input, plan);
  return {
    atoms: selectedAtoms,
    initialUsage,
    ordered,
    atomsByPath: groupEvidenceAtomsByPath(selectedAtoms),
    evidenceUncertainty:
      selectedAtoms.length === 0 || ordered.kept.length === 0 ? [noEvidence(nowMs())] : [],
    keptPaths: ordered.kept.map((c) => c.scopePath),
  };
}

function afterExcerptReadOmissions(
  ordered: CandidateOrdering,
  reads: ExcerptReadSummary,
  nowMs: number,
): CandidateOrdering {
  const entries = [
    ...(reads.omitted ?? []),
    ...(reads.byteBudgetOmittedPaths ?? []).map((scopePath): OmittedContextEntry => ({
      scopePath,
      reason: "budget-exhausted",
      omittedAtMs: nowMs,
    })),
  ];
  if (entries.length === 0) return ordered;
  const omitted = new Set(entries.map((entry) => entry.scopePath));
  return {
    kept: ordered.kept.filter((candidate) => !omitted.has(candidate.scopePath)),
    omitted: [...ordered.omitted, ...entries],
  };
}

async function assemblePackFromReads(
  inputs: FinalContextPackInputs,
): Promise<ConnectedContextPack> {
  const {
    input,
    plan,
    rings,
    prepared,
    excerptReads,
    documentEvidence,
    cacheIdentity,
    assembleOptions,
  } = inputs;
  const excerpts = mergeExcerptSources(excerptReads.excerpts, documentEvidence.excerpts);
  const ordered = afterExcerptReadOmissions(
    prepared.ordered,
    excerptReads,
    assembleOptions.nowMs(),
  );
  // Connected documents are owned exclusively by the bounded document-extraction path: they either
  // surface as document evidence or as a precise document diagnostic. The code-first lexical scan
  // also sees them as binary candidates, so strip any document-path omission it produced to avoid a
  // path that is both a selected file and an omitted entry (which the pack validator rejects).
  const codeOmitted = [...rings.omitted, ...ordered.omitted].filter(
    (entry) => !isConnectedDocumentPath(entry.scopePath),
  );
  const assemble = await assembleContextPack(
    {
      scope: input.scope,
      query: input.query,
      budget: plan.budget,
      atoms: [...prepared.atoms, ...documentEvidence.atoms],
      ranked: [...ordered.kept, ...documentEvidence.candidates],
      omittedFromRanking: [...codeOmitted, ...documentEvidence.omitted],
      excerpts,
      // Document evidence is request-local and not part of the file-state cache key, so a pack that
      // carries any document evidence — extracted atoms OR skipped-document omissions — must not be
      // written into the micro-index under a code-only file-state key (it would orphan an entry the
      // read-bypass gate never serves). Mirror the bypass condition in prepareGroundedAssembly.
      cacheIdentity:
        documentEvidence.atoms.length > 0 || documentEvidence.omitted.length > 0
          ? undefined
          : cacheIdentity,
      initialUsage: prepared.initialUsage,
      diagnostics: rings.diagnostics,
      initialUncertainty: [
        ...rings.uncertainty,
        ...excerptReads.uncertainty,
        ...prepared.evidenceUncertainty,
        ...documentEvidence.uncertainty,
        ...missingExcerptEvidence(prepared, excerpts.size, assembleOptions.nowMs()),
      ],
    },
    withoutMicroIndex(knownFitAssembleOptions(assembleOptions, rings)),
  );
  cacheAssembledGroundedPack(inputs, assemble.pack);
  return assemble.pack;
}

function missingExcerptEvidence(
  prepared: PreparedPackAssembly,
  count: number,
  nowMs: number,
): readonly UncertaintyMarker[] {
  return count === 0 &&
    !prepared.evidenceUncertainty.some((marker) => marker.kind === "no-evidence")
    ? [noEvidence(nowMs)]
    : [];
}

function cacheAssembledGroundedPack(
  inputs: FinalContextPackInputs,
  pack: ConnectedContextPack,
): void {
  throwIfCancelled(inputs.signal);
  if (
    inputs.cacheIdentity === undefined ||
    inputs.cacheKey === undefined ||
    inputs.excerptReads.elapsedBudgetBlocked ||
    (inputs.excerptReads.omitted?.length ?? 0) !== 0
  )
    return;
  inputs.assembleOptions.microIndex?.set(inputs.cacheKey, pack);
}

function withoutMicroIndex(
  options: AssembleOptionsForGroundedPack,
): AssembleOptionsForGroundedPack {
  const { microIndex, ...uncached } = options;
  return microIndex === undefined ? options : uncached;
}

function finishAugmentationBudget(
  rings: RingRunSummary,
  budget: AugmentationBudgetMeter,
): RingRunSummary {
  const result = budget.finish(rings.governor);
  return {
    ...rings,
    governor: result.governor,
    uncertainty: dedupeUncertainty([
      ...rings.uncertainty,
      ...(result.marker === undefined ? [] : [result.marker]),
    ]),
  };
}

async function discoveredTraceForAugmentation(
  args: AssembleGroundedPackInputs,
  rings: RingRunSummary,
  budget: AugmentationBudgetMeter,
): Promise<DeterministicContextEvidence> {
  if (!budget.canContinue()) return { atoms: [], uncertainty: [] };
  const {
    input,
    deps,
    plan,
    searchScope,
    fs,
    nowMs,
    structuralContexts,
    workspaceIndex,
    deadlineAtMs,
  } = args;
  return collectDiscoveredSymbolTraceEvidence({
    scope: input.scope,
    query: input.query,
    anchors: plan.anchors,
    retrievalIntent: plan.retrievalIntent,
    searchScope,
    fs,
    nowMs,
    atoms: rings.atoms,
    signal: deps.signal,
    workspaceIndex,
    requestContext: structuralContexts.forLimits(GROUNDED_TRACE_SEARCH_LIMITS),
    deadlineAtMs,
    tryReserveSearchCall: budget.tryReserveSearchCall,
  });
}

function markAugmentationSkipped(
  rings: RingRunSummary,
  reason: RingSkipReason | "budget-exhausted",
): void {
  if (rings.decisions === undefined) return;
  rings.decisions.augmentationSkipped = true;
  rings.decisions.augmentationSkipReason = reason;
}

function recordAugmentationSkip(args: AssembleGroundedPackInputs, rings: RingRunSummary): boolean {
  const decision =
    args.plan.targetDecision ?? resolveQueryTargetDecision(args.input.query, args.plan.anchors);
  if (hasVerifiedTargetContext(args.input.query, decision, args.plan.retrievalIntent, rings)) {
    markAugmentationSkipped(rings, "verified-target-context");
    return true;
  }
  const reason = lookupAugmentationSkipReason(
    args.input.query,
    args.plan.anchors,
    args.hasGitMetadata,
    rings.diagnostics,
    decision,
  );
  if (reason === undefined) return false;
  markAugmentationSkipped(rings, reason);
  return true;
}

async function augmentRingsWithDeterministicAtoms(
  args: AssembleGroundedPackInputs,
): Promise<RingRunSummary> {
  const {
    input,
    deps,
    plan,
    rings,
    searchScope,
    fs,
    metadataFs,
    nowMs,
    structuralContexts,
    deadlineAtMs,
  } = args;
  const budget = createAugmentationBudgetMeter(plan, rings.governor, nowMs, deadlineAtMs);
  // Explicitly selected files are direct user scope, not another search. Preserve healthy files
  // when a planned ring consumed the search-call share (notably multi-source splits), while the
  // absolute deadline still prevents any new containment/stat work.
  const scopedRings =
    nowMs() < deadlineAtMs
      ? withExplicitScopeAtoms(rings, input, searchScope, fs, nowMs, deadlineAtMs, deps.signal)
      : rings;
  if (!budget.canContinue()) {
    markAugmentationSkipped(scopedRings, "budget-exhausted");
    return finishAugmentationBudget(scopedRings, budget);
  }
  if (recordAugmentationSkip(args, scopedRings))
    return finishAugmentationBudget(scopedRings, budget);
  const deterministicRings = await withDeterministicContextAtoms(scopedRings, {
    symbolDiscovery: scopedRings.symbolDiscovery,
    skipOptionalTrace: scopedRings.verifiedDefinitionContext === true,
    input,
    plan,
    searchScope,
    fs,
    metadataFs,
    nowMs,
    signal: deps.signal,
    structuralContexts,
    deadlineAtMs,
    budget,
  });
  const discoveredTrace = await discoveredTraceForAugmentation(args, deterministicRings, budget);
  return finishAugmentationBudget(
    {
      ...deterministicRings,
      atoms: [...deterministicRings.atoms, ...discoveredTrace.atoms],
      uncertainty: [...deterministicRings.uncertainty, ...discoveredTrace.uncertainty],
    },
    budget,
  );
}

interface GroundedAssemblyContext {
  readonly documentEvidence: DocumentEvidenceResult;
  readonly cached: ConnectedContextPack | undefined;
  readonly cacheIdentity: PackCacheIdentity | undefined;
  readonly cacheKey: string | undefined;
  readonly assembleOptions: AssembleOptionsForGroundedPack;
}

interface GroundedPackAssembly {
  readonly excerptObservation?: ExcerptReadObservation | undefined;
  readonly metadataRetention?: MetadataRetentionObservation | undefined;
  readonly readWindowCount?: number | undefined;
  readonly anchoredWindowCount?: number | undefined;
  readonly pack: ConnectedContextPack;
  readonly elapsedBudgetBlocked: boolean;
}

async function assemblyFileStateCacheIdentity(
  args: AssembleGroundedPackInputs,
  keptPaths: readonly string[],
): Promise<PackCacheIdentity | undefined> {
  const { searchScope, fs, nowMs, deadlineAtMs, deps } = args;
  return fileStateCacheIdentity(keptPaths, searchScope, fs, nowMs, deadlineAtMs, deps.signal);
}

async function prepareGroundedAssembly(
  args: AssembleGroundedPackInputs,
  augmentedRings: RingRunSummary,
  prepared: PreparedPackAssembly,
): Promise<GroundedAssemblyContext> {
  const { input, deps, plan, searchScope, fs, nowMs, deadlineAtMs } = args;
  // Bounded small-document extraction for explicit `files` scopes (Issue #1285). Returns empty
  // evidence for every other scope kind, leaving the code-first path byte-identical.
  const documentEvidence = await collectConnectedDocumentEvidence({
    scope: input.scope,
    query: input.query,
    searchScope,
    fs,
    nowMs,
    signal: deps.signal,
    deadlineAtMs,
  });
  const hasDocumentEvidence =
    documentEvidence.atoms.length > 0 || documentEvidence.omitted.length > 0;
  const withinDeadline = nowMs() < deadlineAtMs;
  const cacheIdentity =
    deps.microIndex === undefined || hasDocumentEvidence || !withinDeadline
      ? undefined
      : await assemblyFileStateCacheIdentity(args, prepared.keptPaths);
  const canStartAssemblySeams = nowMs() < deadlineAtMs;
  const assembleOptions = assembleOptionsFor(
    deps,
    nowMs,
    !hasDocumentEvidence && canStartAssemblySeams,
    canStartAssemblySeams,
    deadlineAtMs,
  );
  // The micro-index cache key does not model request-local document evidence, so a scope that
  // carried documents this run must not be served from (or written to) the shared cache.
  const cacheKey = hasDocumentEvidence
    ? undefined
    : groundedPackCacheKey({
        input,
        plan,
        rings: augmentedRings,
        atoms: prepared.atoms,
        ordered: prepared.ordered,
        cacheIdentity,
        initialUsage: prepared.initialUsage,
        assembleOptions,
      });
  const cached = cacheKey === undefined ? undefined : assembleOptions.microIndex?.get(cacheKey);
  return { documentEvidence, cached, cacheIdentity, cacheKey, assembleOptions };
}

// PR4-W1 (ADR-0055 D1): conditional diagnostics observer. When a ContextProfile is threaded
// through OrchestratorDeps, the fully assembled pack is enriched with an additive
// `diagnostics.contextBudget?`. The observer is pure and touches no field a prompt builder reads,
// so the wire output stays byte-identical (AC5). When the profile is absent, the pack is returned
// exactly as assembled — the unchanged-guarantee for legacy callers and existing tests.
function withGroundedContextDiagnostics(
  pack: ConnectedContextPack,
  deps: OrchestratorDeps,
): ConnectedContextPack {
  if (deps.contextProfile === undefined) {
    return pack;
  }
  return attachContextBudgetDiagnostics(pack, deps.contextProfile);
}

// #3347 P1: `ctx.cacheIdentity` is captured BEFORE the excerpt reads, and the pack cache key
// substitutes it for the excerpt content hashes (keiko-workflows' cacheExcerptIdentity). A file
// replaced between the capture and its read would therefore publish the REPLACEMENT's bytes under
// the ORIGINAL's identity, so a later request over the restored original would be served the
// replacement out of the micro-index. A per-read descriptor check cannot close this: it proves each
// individual read was self-consistent, not that every kept path still presents the identity the key
// claims. Re-derive the identity after the reads and keep it only when every kept path matches the
// one proven before them; on any mismatch — or an identity that can no longer be established at all
// — drop the identity so the pack is assembled but never inserted into the cache.
async function excerptBoundCacheIdentity(
  args: AssembleGroundedPackInputs,
  keptPaths: readonly string[],
  captured: PackCacheIdentity | undefined,
): Promise<PackCacheIdentity | undefined> {
  if (captured === undefined) return undefined;
  const current = await assemblyFileStateCacheIdentity(args, keptPaths);
  if (current === undefined) return undefined;
  if (current.length !== captured.length) return undefined;
  return current.every((entry, index) => entry === captured[index]) ? captured : undefined;
}

async function assembleGroundedPack(
  args: AssembleGroundedPackInputs,
): Promise<GroundedPackAssembly> {
  const { input, deps, plan, searchScope, fs, nowMs, deadlineAtMs } = args;
  const augmentedRings = await augmentRingsWithDeterministicAtoms(args);
  const prepared = preparePackAssembly(input, plan, augmentedRings, nowMs, args.hasGitMetadata);
  const ctx = await prepareGroundedAssembly(args, augmentedRings, prepared);
  if (ctx.cached !== undefined) {
    return {
      pack: withGroundedContextDiagnostics(ctx.cached, deps),
      metadataRetention: augmentedRings.metadataRetention,
      elapsedBudgetBlocked: false,
    };
  }
  const excerptReads = await readKeptExcerpts(prepared.keptPaths, {
    knownFitFileBytes: augmentedRings.knownFitFileBytes,
    searchScope,
    fs,
    budget: plan.budget,
    initialUsage: prepared.initialUsage,
    atomsByPath: prepared.atomsByPath,
    anchors: plan.anchors.filter((anchor) => anchor.kind !== "path").map((anchor) => anchor.term),
    nowMs,
    signal: deps.signal,
    deadlineAtMs,
  });
  const pack = await assemblePackFromReads({
    input,
    plan,
    rings: augmentedRings,
    prepared,
    excerptReads,
    documentEvidence: ctx.documentEvidence,
    cacheIdentity: await excerptBoundCacheIdentity(args, prepared.keptPaths, ctx.cacheIdentity),
    cacheKey: ctx.cacheKey,
    signal: deps.signal,
    assembleOptions: ctx.assembleOptions,
  });
  return {
    pack: withGroundedContextDiagnostics(pack, deps),
    metadataRetention: augmentedRings.metadataRetention,
    excerptObservation: excerptReads.observation,
    elapsedBudgetBlocked: excerptReads.elapsedBudgetBlocked,
    anchoredWindowCount: excerptReads.anchoredWindowCount,
    readWindowCount: excerptReads.readWindowCount,
  };
}

// ─── Public entry ─────────────────────────────────────────────────────────────

interface ConnectedContextCompletionStatus {
  readonly excerptObservation?: ExcerptReadObservation | undefined;
  readonly metadataRetention?: MetadataRetentionObservation | undefined;
  readonly decisions?: RingDecisionAudit | undefined;
  readonly excerptReadWindowCount?: number | undefined;
  readonly anchoredExcerptWindowCount?: number | undefined;
  readonly readBudgetBlocked: boolean;
  readonly elapsedBudgetBlocked: boolean;
  readonly workspaceIndexProviderStatus: "not-evaluated" | "available" | "unavailable";
}

interface ConnectedContextExecution {
  readonly output: RetrievalOnlyOutput;
  readonly status: ConnectedContextCompletionStatus;
  readonly structural: StructuralRequestContextPoolDiagnostics;
  readonly workspaceIndex: WorkspaceIndexActivityDiagnostics;
  readonly workspaceIo: WorkspaceIoActivityDiagnostics;
}

interface ConnectedContextActivity {
  readonly elapsedMs: () => number;
  readonly started: () => void;
  readonly completed: (execution: ConnectedContextExecution) => void;
  readonly failed: (error: unknown, progress: ConnectedContextProgress) => void;
}

type ConnectedContextPhase =
  | "request-validation"
  | "planning"
  | "workspace-admission"
  | "budget-evaluation"
  | "workspace-detection"
  | "ring-retrieval"
  | "pack-assembly"
  | "empty-pack-assembly";

interface ConnectedContextProgress {
  phase: ConnectedContextPhase;
  plannedRingCount: number;
  structuralContexts?: StructuralRequestContextPool | undefined;
  workspaceIndexActivity?: WorkspaceIndexActivity | undefined;
  workspaceIoActivity?: WorkspaceIoActivity | undefined;
}

interface ConnectedContextRuntime {
  readonly fs: WorkspaceFs;
  readonly workspaceRoot: string;
  readonly detect: (root: string, fs: WorkspaceFs) => WorkspaceInfo;
  readonly nowMs: () => number;
  readonly activity: ConnectedContextActivity;
  readonly progress: ConnectedContextProgress;
  readonly workspaceIoActivity: WorkspaceIoActivity;
  readonly requestStartedAtMs: number;
}

const EMPTY_STRUCTURAL_DIAGNOSTICS: StructuralRequestContextPoolDiagnostics = {
  contextCount: 0,
  candidateInventoryBuildCount: 0,
  candidateFileCount: 0,
  candidateDirectoryCount: 0,
  codeIndexBuildCount: 0,
  symbolGraphBuildCount: 0,
  importGraphBuildCount: 0,
  endpointGraphBuildCount: 0,
  fileSearchCount: 0,
  textSearchCount: 0,
};

const NOT_EVALUATED_WORKSPACE_INDEX_DIAGNOSTICS = workspaceIndexActivityDiagnostics(
  "not-evaluated",
  emptyWorkspaceIndexActivityCounters(),
);

// `elapsedBudgetBlocked` is reported by the assembly that observed it, never hardcoded (#3347 P1):
// a live retrieval whose excerpt reads were stopped by the absolute deadline reached this status
// claiming an unblocked elapsed budget, contradicting the elapsed-budget marker on its own pack.
function liveRetrievalCompletion(
  workspaceIndexAvailable: boolean,
  assembled: GroundedPackAssembly,
  decisions: RingDecisionAudit | undefined,
): ConnectedContextCompletionStatus {
  return {
    anchoredExcerptWindowCount: assembled.anchoredWindowCount,
    excerptReadWindowCount: assembled.readWindowCount,
    excerptObservation: assembled.excerptObservation,
    metadataRetention: assembled.metadataRetention,
    decisions,
    readBudgetBlocked: assembled.excerptObservation?.readBudgetBlocked ?? false,
    elapsedBudgetBlocked: assembled.elapsedBudgetBlocked,
    workspaceIndexProviderStatus: workspaceIndexAvailable ? "available" : "unavailable",
  };
}

function stoppedRetrievalCompletion(
  readBudgetBlocked: boolean,
  elapsedBudgetBlocked: boolean,
): ConnectedContextCompletionStatus {
  return {
    readBudgetBlocked,
    elapsedBudgetBlocked,
    workspaceIndexProviderStatus: "not-evaluated",
  };
}

type ActivityScopeKind = "workspace-root" | "directory" | "files" | "invalid";
type ActivityQueryKind = RetrievalQuery["kind"] | "invalid";
type ActivityNumber = number | "invalid";
type ActivityBoolean = boolean | "invalid";

interface ConnectedContextActivityIdentity {
  readonly scopeKind: ActivityScopeKind;
  readonly relativePathCount: number;
  readonly explicitConnection: boolean;
  readonly scopeIdentitySha256: string;
  readonly queryKind: ActivityQueryKind;
  readonly queryIdentitySha256: string;
  readonly caseSensitive: ActivityBoolean;
  readonly maxResults: ActivityNumber;
  readonly searchCallsMax: ActivityNumber;
  readonly filesReadMax: ActivityNumber | null;
  readonly excerptBytesMax: ActivityNumber;
  readonly modelInputTokensMax: ActivityNumber;
  readonly modelOutputTokensMax: ActivityNumber;
  readonly elapsedMsMax: ActivityNumber | null;
  readonly rerankCallsMax: ActivityNumber;
}

interface ConnectedContextCommonActivityFields {
  readonly scopeKind: ActivityScopeKind;
  readonly relativePathCount: number;
  readonly explicitConnection: boolean;
  readonly scopeIdentitySha256: string;
  readonly queryKind: ActivityQueryKind;
  readonly queryIdentitySha256: string;
  readonly inputStatus: "valid" | "invalid";
  readonly caseSensitive?: boolean;
  readonly maxResults?: number;
  readonly searchCallsMax?: number;
  readonly filesReadMax?: number;
  readonly filesReadBounded: boolean;
  readonly excerptBytesMax?: number;
  readonly modelInputTokensMax?: number;
  readonly modelOutputTokensMax?: number;
  readonly elapsedMsMax?: number;
  readonly elapsedMsBounded: boolean;
  readonly rerankCallsMax?: number;
  readonly completeness: "complete";
  readonly loss: "none";
}

function activityProperty(record: Readonly<Record<string, unknown>>, key: string): unknown {
  try {
    return record[key];
  } catch {
    return undefined;
  }
}

function activityString(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = activityProperty(record, key);
  return typeof value === "string" ? value : "";
}

function activityNumber(record: Readonly<Record<string, unknown>>, key: string): ActivityNumber {
  const value = activityProperty(record, key);
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : "invalid";
}

function activityBoolean(record: Readonly<Record<string, unknown>>, key: string): ActivityBoolean {
  const value = activityProperty(record, key);
  return typeof value === "boolean" ? value : "invalid";
}

function activityScopeKind(value: unknown): ActivityScopeKind {
  return value === "workspace-root" || value === "directory" || value === "files"
    ? value
    : "invalid";
}

function activityQueryKind(value: unknown): ActivityQueryKind {
  return value === "natural-language" ||
    value === "exact-symbol" ||
    value === "file-pattern" ||
    value === "regex"
    ? value
    : "invalid";
}

function activityRelativePaths(scope: Readonly<Record<string, unknown>>): readonly string[] {
  const value = activityProperty(scope, "relativePaths");
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function connectedContextActivityDigest(domain: string, parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of [domain, ...parts]) {
    hash.update(`${String(part.length)}:${part}`);
  }
  return hash.digest("hex");
}

function activityBudget(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const value = activityProperty(input, "budget");
  if (value === undefined) return { ...DEFAULT_EXPLORATION_BUDGET };
  return isRecord(value) ? value : {};
}

function queryActivityIdentity(
  input: Readonly<Record<string, unknown>>,
): Pick<
  ConnectedContextActivityIdentity,
  "queryKind" | "queryIdentitySha256" | "caseSensitive" | "maxResults"
> {
  const value = activityProperty(input, "query");
  const query = isRecord(value) ? value : {};
  const queryKind = activityQueryKind(activityProperty(query, "kind"));
  const caseSensitive = activityBoolean(query, "caseSensitive");
  const maxResults = activityNumber(query, "maxResults");
  return {
    queryKind,
    caseSensitive,
    maxResults,
    queryIdentitySha256: connectedContextActivityDigest("keiko.connected-context.query.v1", [
      queryKind,
      activityString(query, "text"),
      String(caseSensitive),
      String(maxResults),
    ]),
  };
}

function budgetActivityIdentity(
  input: Readonly<Record<string, unknown>>,
): Pick<
  ConnectedContextActivityIdentity,
  | "searchCallsMax"
  | "filesReadMax"
  | "excerptBytesMax"
  | "modelInputTokensMax"
  | "modelOutputTokensMax"
  | "elapsedMsMax"
  | "rerankCallsMax"
> {
  const budget = activityBudget(input);
  return {
    searchCallsMax: activityNumber(budget, "searchCallsMax"),
    filesReadMax:
      activityProperty(budget, "filesReadMax") === null
        ? null
        : activityNumber(budget, "filesReadMax"),
    excerptBytesMax: activityNumber(budget, "excerptBytesMax"),
    modelInputTokensMax: activityNumber(budget, "modelInputTokensMax"),
    modelOutputTokensMax: activityNumber(budget, "modelOutputTokensMax"),
    elapsedMsMax:
      activityProperty(budget, "elapsedMsMax") === null
        ? null
        : activityNumber(budget, "elapsedMsMax"),
    rerankCallsMax: activityNumber(budget, "rerankCallsMax"),
  };
}

function connectedContextActivityIdentity(
  input: OrchestratorInput,
): ConnectedContextActivityIdentity {
  const inputRecord = isRecord(input) ? input : {};
  const scopeValue = activityProperty(inputRecord, "scope");
  const scope = isRecord(scopeValue) ? scopeValue : {};
  const scopeKind = activityScopeKind(activityProperty(scope, "kind"));
  const relativePaths = activityRelativePaths(scope);
  const explicitConnection = activityProperty(scope, "explicitConnection") === true;
  const digest = connectedContextActivityDigest("keiko.connected-context.scope.v2", [
    activityString(scope, "scopeId"),
    activityString(inputRecord, "workspaceRoot"),
    scopeKind,
    String(explicitConnection),
    ...relativePaths,
  ]);
  return {
    scopeKind,
    relativePathCount: relativePaths.length,
    explicitConnection,
    scopeIdentitySha256: digest,
    ...queryActivityIdentity(inputRecord),
    ...budgetActivityIdentity(inputRecord),
  };
}

function validActivityNumber(value: ActivityNumber | null): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function connectedContextInputStatus(
  identity: ConnectedContextActivityIdentity,
): "valid" | "invalid" {
  const values: readonly (
    ActivityNumber | ActivityBoolean | ActivityScopeKind | ActivityQueryKind | null
  )[] = [
    identity.scopeKind,
    identity.queryKind,
    identity.caseSensitive,
    identity.maxResults,
    identity.searchCallsMax,
    identity.filesReadMax,
    identity.excerptBytesMax,
    identity.modelInputTokensMax,
    identity.modelOutputTokensMax,
    identity.elapsedMsMax,
    identity.rerankCallsMax,
  ];
  return values.includes("invalid") ? "invalid" : "valid";
}

function commonActivityExtra(
  identity: ConnectedContextActivityIdentity,
): ConnectedContextCommonActivityFields {
  const maxResults = validActivityNumber(identity.maxResults);
  const searchCallsMax = validActivityNumber(identity.searchCallsMax);
  const filesReadMax = validActivityNumber(identity.filesReadMax);
  const excerptBytesMax = validActivityNumber(identity.excerptBytesMax);
  const modelInputTokensMax = validActivityNumber(identity.modelInputTokensMax);
  const modelOutputTokensMax = validActivityNumber(identity.modelOutputTokensMax);
  const elapsedMsMax = validActivityNumber(identity.elapsedMsMax);
  const rerankCallsMax = validActivityNumber(identity.rerankCallsMax);
  return {
    scopeKind: identity.scopeKind,
    relativePathCount: identity.relativePathCount,
    explicitConnection: identity.explicitConnection,
    scopeIdentitySha256: identity.scopeIdentitySha256,
    queryKind: identity.queryKind,
    queryIdentitySha256: identity.queryIdentitySha256,
    inputStatus: connectedContextInputStatus(identity),
    ...(identity.caseSensitive === "invalid" ? {} : { caseSensitive: identity.caseSensitive }),
    ...(maxResults === undefined ? {} : { maxResults }),
    ...(searchCallsMax === undefined ? {} : { searchCallsMax }),
    ...(filesReadMax === undefined ? {} : { filesReadMax }),
    filesReadBounded: identity.filesReadMax !== null,
    ...(excerptBytesMax === undefined ? {} : { excerptBytesMax }),
    ...(modelInputTokensMax === undefined ? {} : { modelInputTokensMax }),
    ...(modelOutputTokensMax === undefined ? {} : { modelOutputTokensMax }),
    ...(elapsedMsMax === undefined ? {} : { elapsedMsMax }),
    elapsedMsBounded: identity.elapsedMsMax !== null,
    ...(rerankCallsMax === undefined ? {} : { rerankCallsMax }),
    completeness: "complete",
    loss: "none",
  };
}

function uncertaintyActivityExtra(
  markers: readonly UncertaintyMarker[],
): Readonly<Record<string, number>> {
  const counts: Record<UncertaintyMarkerKind, number> = {
    "no-evidence": 0,
    "stale-evidence": 0,
    "scope-incomplete": 0,
    "budget-clipped": 0,
    "tool-unavailable": 0,
    "low-confidence": 0,
    "unsupported-citation": 0,
    "uncited-answer": 0,
    "incomplete-answer": 0,
    "unsupported-claim": 0,
    "entailment-unavailable": 0,
  };
  for (const marker of markers) counts[marker.kind] += 1;
  return {
    scopeIncompleteUncertaintyCount: counts["scope-incomplete"],
    budgetClippedUncertaintyCount: counts["budget-clipped"],
    toolUnavailableUncertaintyCount: counts["tool-unavailable"],
    unsupportedClaimUncertaintyCount: counts["unsupported-claim"],
    entailmentUnavailableUncertaintyCount: counts["entailment-unavailable"],
  };
}

type ConnectedContextCompletedActivityFields = ActivityLogFields<
  typeof SEARCH_CONNECTED_CONTEXT_COMPLETED_OPERATION
>;
type ConnectedContextCompletionDetailsActivityFields = ActivityLogFields<
  typeof SEARCH_CONNECTED_CONTEXT_COMPLETION_DETAILS_OPERATION
>;
type ConnectedContextFailedActivityFields = ActivityLogFields<
  typeof SEARCH_CONNECTED_CONTEXT_FAILED_OPERATION
>;
type FailedStructuralFields = Pick<
  ConnectedContextFailedActivityFields,
  | "structuralContextCount"
  | "structuralCandidateInventoryBuildCount"
  | "structuralCandidateFileCount"
  | "structuralCandidateDirectoryCount"
  | "structuralCodeIndexBuildCount"
  | "structuralSymbolGraphBuildCount"
  | "structuralImportGraphBuildCount"
  | "structuralEndpointGraphBuildCount"
  | "structuralFileSearchCount"
  | "structuralTextSearchCount"
>;
type FailedIndexFields = Pick<
  ConnectedContextFailedActivityFields,
  | "indexProviderStatus"
  | "indexSearchMode"
  | "indexLoadStatus"
  | "indexSaveStatus"
  | "indexIndexedRecords"
  | "indexReusedRecords"
  | "indexStaleRecords"
  | "indexSearchCount"
  | "indexReportCount"
  | "indexFallbackSearchCount"
  | "indexLoadFailures"
  | "indexSaveFailures"
>;
type FailedWorkspaceIoFields = Pick<
  ConnectedContextFailedActivityFields,
  | "workspaceIoReadDirCalls"
  | "workspaceIoReadDirEntries"
  | "workspaceIoStatCalls"
  | "workspaceIoRealPathCalls"
  | "workspaceIoExistsCalls"
  | "workspaceIoContentReadCalls"
  | "workspaceIoContentReadBytes"
>;

function coverageActivityExtra(
  pack: ConnectedContextPack,
): Partial<ConnectedContextCompletedActivityFields> {
  const coverage = pack.diagnostics?.coverage;
  if (coverage === undefined) {
    return { coverageStatus: "not-reported", coverageReasons: [] };
  }
  return {
    coverageStatus: coverage.incomplete ? "incomplete" : "complete",
    coverageReasons: coverage.reasons,
    coverageFilesDiscovered: coverage.filesDiscovered,
    coverageFilesScanned: coverage.filesScanned,
    coverageFilesSkipped: coverage.filesSkipped,
    coverageDepthPruned: coverage.depthPrunedByDiscovery,
    coverageMaxFilesPruned: coverage.maxFilesPrunedByDiscovery,
  };
}

function structuralActivityExtra(
  structural: StructuralRequestContextPoolDiagnostics,
): FailedStructuralFields & Partial<ConnectedContextCompletionDetailsActivityFields> {
  return {
    structuralContextCount: structural.contextCount,
    structuralCandidateInventoryBuildCount: structural.candidateInventoryBuildCount,
    structuralCandidateFileCount: structural.candidateFileCount,
    structuralCandidateDirectoryCount: structural.candidateDirectoryCount,
    structuralCodeIndexBuildCount: structural.codeIndexBuildCount,
    structuralSymbolGraphBuildCount: structural.symbolGraphBuildCount,
    structuralImportGraphBuildCount: structural.importGraphBuildCount,
    structuralEndpointGraphBuildCount: structural.endpointGraphBuildCount,
    structuralFileSearchCount: structural.fileSearchCount,
    structuralTextSearchCount: structural.textSearchCount,
  };
}

function workspaceIndexActivityExtra(
  index: WorkspaceIndexActivityDiagnostics,
): FailedIndexFields & Partial<ConnectedContextCompletionDetailsActivityFields> {
  return {
    indexProviderStatus: index.providerStatus,
    indexSearchMode: index.searchMode,
    indexLoadStatus: index.loadStatus,
    indexSaveStatus: index.saveStatus,
    indexIndexedRecords: index.indexedRecords,
    indexReusedRecords: index.reusedRecords,
    indexStaleRecords: index.staleRecords,
    indexSearchCount: index.searchCount,
    indexReportCount: index.reportCount,
    indexFallbackSearchCount: index.fallbackSearchCount,
    indexLoadFailures: index.loadFailures,
    indexSaveFailures: index.saveFailures,
  };
}

function workspaceIoActivityExtra(
  io: WorkspaceIoActivityDiagnostics,
): FailedWorkspaceIoFields & Partial<ConnectedContextCompletionDetailsActivityFields> {
  return {
    workspaceIoReadDirCalls: io.readDirCalls,
    workspaceIoReadDirEntries: io.readDirEntries,
    workspaceIoStatCalls: io.statCalls,
    workspaceIoRealPathCalls: io.realPathCalls,
    workspaceIoExistsCalls: io.existsCalls,
    workspaceIoContentReadCalls: io.contentReadCalls,
    workspaceIoContentReadBytes: io.contentReadBytes,
  };
}

function contextObservationActivityExtra(
  pack: ConnectedContextPack,
): Partial<ConnectedContextCompletedActivityFields> {
  const profile = pack.diagnostics?.contextBudget?.profile;
  if (profile === undefined) return {};
  const observed = deriveGroundedContextAssembly(pack, profile);
  return {
    contextSelectedExcerptCount: observed.lanes.reduce((sum, lane) => sum + lane.includedItems, 0),
    contextSelectedExcerptEstimatedTokens: observed.totalEstimatedTokens,
    contextBudgetPressure: observed.budgetPressure,
    contextRecencyLayoutApplied: observed.orderedForRecency,
  };
}

function retrievalLossActivityExtra(
  status: ConnectedContextCompletionStatus,
): Partial<ConnectedContextCompletedActivityFields> {
  const { excerptObservation: excerpt, metadataRetention: metadata } = status;
  return {
    ...(excerpt === undefined
      ? {}
      : {
          excerptOmittedRangeCount: excerpt.omittedRangeCount,
          excerptTruncatedWindowCount: excerpt.truncatedWindowCount,
          excerptUnreadFileCount: excerpt.unreadFileCount,
          excerptStopReasons: excerpt.stopReasons,
        }),
    ...(metadata === undefined
      ? {}
      : {
          metadataObservedCount: metadata.observedCount,
          metadataRetainedCount: metadata.retainedCount,
          metadataDiscardedCount: metadata.discardedCount,
          metadataOmittedDetailCount: metadata.omittedDetailCount,
          metadataRetentionLimit: metadata.limit,
        }),
  };
}

function completionActivityExtra(
  identity: ConnectedContextActivityIdentity,
  execution: ConnectedContextExecution,
): ConnectedContextCompletedActivityFields {
  const { pack, plan } = execution.output;
  return {
    scopeIdentitySha256: identity.scopeIdentitySha256,
    queryIdentitySha256: identity.queryIdentitySha256,
    activityDetailStatus: "complete",
    plannedRingCount: plan.rings.length,
    retrievalIntent: plan.retrievalIntent,
    ...(plan.targetDecision === undefined
      ? {}
      : {
          retrievalTargetDecision: plan.targetDecision.kind,
          retrievalTargetCount: plan.targetDecision.targets.length,
        }),
    retrievalAnchorCount: plan.anchors.length,
    ...execution.status.decisions,
    usageSearchCalls: pack.usage.searchCalls,
    usageFilesRead: pack.usage.filesRead,
    usageExcerptBytes: pack.usage.excerptBytes,
    excerptAnchoredWindowCount: execution.status.anchoredExcerptWindowCount ?? 0,
    excerptReadWindowCount: execution.status.excerptReadWindowCount ?? 0,
    ...retrievalLossActivityExtra(execution.status),
    usageModelInputTokens: pack.usage.modelInputTokens,
    usageModelOutputTokens: pack.usage.modelOutputTokens,
    usageElapsedMs: pack.usage.elapsedMs,
    usageRerankCalls: pack.usage.rerankCalls,
    selectedFileCount: pack.files.length,
    scopeContextSelectedFileCount: pack.files.filter((file) =>
      file.excerpts.some(
        (excerpt) =>
          excerpt.atom.provenance.kind === "file-listing" &&
          excerpt.atom.provenance.tool === "repo.findFiles" &&
          excerpt.atom.lineRange !== undefined,
      ),
    ).length,
    ...contextObservationActivityExtra(pack),
    omittedCount: connectedContextOmittedCount(pack),
    uncertaintyCount: pack.uncertainty.length,
    ...uncertaintyActivityExtra(pack.uncertainty),
    ...coverageActivityExtra(pack),
    retrievalReadBudgetBlocked: execution.status.readBudgetBlocked,
    retrievalElapsedBudgetBlocked: execution.status.elapsedBudgetBlocked,
    retrievalWorkspaceIndexProviderStatus: execution.status.workspaceIndexProviderStatus,
    completeness: "complete",
    loss: "none",
  };
}

function completionDetailsActivityExtra(
  identity: ConnectedContextActivityIdentity,
  execution: ConnectedContextExecution,
): ConnectedContextCompletionDetailsActivityFields {
  return {
    scopeIdentitySha256: identity.scopeIdentitySha256,
    queryIdentitySha256: identity.queryIdentitySha256,
    activityDetailStatus: "complete",
    ...structuralActivityExtra(execution.structural),
    ...workspaceIndexActivityExtra(execution.workspaceIndex),
    ...workspaceIoActivityExtra(execution.workspaceIo),
    completeness: "complete",
    loss: "none",
  };
}

function failureActivityExtra(
  identity: ConnectedContextActivityIdentity,
  error: unknown,
  progress: ConnectedContextProgress,
  cancelled: boolean,
): ConnectedContextFailedActivityFields {
  const frames = keikoStackFrames(error);
  const chain = causeChain(error);
  const structural = progress.structuralContexts?.diagnostics() ?? EMPTY_STRUCTURAL_DIAGNOSTICS;
  const index =
    progress.workspaceIndexActivity?.diagnostics() ?? NOT_EVALUATED_WORKSPACE_INDEX_DIAGNOSTICS;
  const io = progress.workspaceIoActivity?.diagnostics() ?? emptyWorkspaceIoActivityDiagnostics();
  return {
    scopeIdentitySha256: identity.scopeIdentitySha256,
    queryIdentitySha256: identity.queryIdentitySha256,
    activityDetailStatus: "complete",
    outcome: cancelled ? "cancelled" : "failed",
    failureKind: connectedContextFailureKind(error),
    retrievalPhase: progress.phase,
    plannedRingCount: progress.plannedRingCount,
    ...structuralActivityExtra(structural),
    ...workspaceIndexActivityExtra(index),
    ...workspaceIoActivityExtra(io),
    ...(frames.length === 0 ? {} : { frames }),
    ...(chain.length === 0 ? {} : { causeChain: chain }),
    completeness: "complete",
    loss: "none",
  };
}

function safeConnectedContextErrorKind(error: unknown): ActivityLogErrorKind {
  const value = connectedContextFailureKind(error);
  if (value === ERROR_CODES.CANCELLED) return "cancelled";
  return activityLogErrorKindOr(value, "internal");
}

function connectedContextFailureKind(error: unknown): string {
  try {
    return classifyErrorKind(errorKindOf(error)) ?? "unknown";
  } catch {
    return "unknown";
  }
}

function isConnectedContextCancellation(error: unknown, errorKind: ActivityLogErrorKind): boolean {
  try {
    if (error instanceof CancelledError) return true;
  } catch {
    // A hostile getPrototypeOf trap cannot be allowed to replace the original retrieval failure.
  }
  return errorKind === "cancelled";
}

function unavailableFailureActivityExtra(
  identity: ConnectedContextActivityIdentity,
  progress: ConnectedContextProgress,
  cancelled: boolean,
): ConnectedContextFailedActivityFields {
  return {
    scopeIdentitySha256: identity.scopeIdentitySha256,
    queryIdentitySha256: identity.queryIdentitySha256,
    activityDetailStatus: "unavailable",
    outcome: cancelled ? "cancelled" : "failed",
    retrievalPhase: progress.phase,
    plannedRingCount: progress.plannedRingCount,
    ...structuralActivityExtra(EMPTY_STRUCTURAL_DIAGNOSTICS),
    ...workspaceIndexActivityExtra(NOT_EVALUATED_WORKSPACE_INDEX_DIAGNOSTICS),
    ...workspaceIoActivityExtra(emptyWorkspaceIoActivityDiagnostics()),
    completeness: "partial",
    loss: "none",
  };
}

function unavailableCompletionActivityExtra(
  identity: ConnectedContextActivityIdentity,
): ConnectedContextCompletedActivityFields {
  return {
    scopeIdentitySha256: identity.scopeIdentitySha256,
    queryIdentitySha256: identity.queryIdentitySha256,
    activityDetailStatus: "unavailable",
    completeness: "complete",
    loss: "none",
  };
}

function unavailableCompletionDetailsActivityExtra(
  identity: ConnectedContextActivityIdentity,
  workspaceIo: WorkspaceIoActivityDiagnostics,
): ConnectedContextCompletionDetailsActivityFields {
  return {
    scopeIdentitySha256: identity.scopeIdentitySha256,
    queryIdentitySha256: identity.queryIdentitySha256,
    activityDetailStatus: "unavailable",
    ...workspaceIoActivityExtra(workspaceIo),
    completeness: "complete",
    loss: "none",
  };
}

function safeCompletionActivityExtra(
  identity: ConnectedContextActivityIdentity,
  execution: ConnectedContextExecution,
  correlationId: string,
): ConnectedContextCompletedActivityFields {
  try {
    return completionActivityExtra(identity, execution);
  } catch (error) {
    reportServerLogFailure(error, { op: "search.connected-context.completed", correlationId });
    return unavailableCompletionActivityExtra(identity);
  }
}

function safeCompletionDetailsActivityExtra(
  identity: ConnectedContextActivityIdentity,
  execution: ConnectedContextExecution,
  correlationId: string,
): ConnectedContextCompletionDetailsActivityFields {
  try {
    return completionDetailsActivityExtra(identity, execution);
  } catch (error) {
    reportServerLogFailure(error, {
      op: "search.connected-context.completion-details",
      correlationId,
    });
    return unavailableCompletionDetailsActivityExtra(identity, execution.workspaceIo);
  }
}

function safeFailureActivityExtra(
  identity: ConnectedContextActivityIdentity,
  error: unknown,
  progress: ConnectedContextProgress,
  cancelled: boolean,
  correlationId: string,
): ConnectedContextFailedActivityFields {
  try {
    return failureActivityExtra(identity, error, progress, cancelled);
  } catch (projectionError) {
    reportServerLogFailure(projectionError, {
      op: "search.connected-context.failed",
      correlationId,
    });
    return unavailableFailureActivityExtra(identity, progress, cancelled);
  }
}

function logConnectedContextCompletion(
  logger: ServerLogger,
  identity: ConnectedContextActivityIdentity,
  execution: ConnectedContextExecution,
  correlationId: string,
  durationMs: number,
): void {
  logger.info(() =>
    activityLogEvent(
      SEARCH_CONNECTED_CONTEXT_COMPLETION_DETAILS_OPERATION,
      { correlationId },
      safeCompletionDetailsActivityExtra(identity, execution, correlationId),
    ),
  );
  logger.info(() =>
    activityLogEvent(
      SEARCH_CONNECTED_CONTEXT_COMPLETED_OPERATION,
      { correlationId, durationMs },
      safeCompletionActivityExtra(identity, execution, correlationId),
    ),
  );
}

function createConnectedContextActivity(
  input: OrchestratorInput,
  deps: OrchestratorDeps,
  nowMs: () => number,
  logicalStartMs: number,
): ConnectedContextActivity {
  const sink = deps.activityLog ?? processServerLogSink();
  const logger = createServerLogger({ sink, level: "debug" });
  const correlationId = correlationIdOrUnknown(deps.correlationId);
  const identity = connectedContextActivityIdentity(input);
  const logElapsed = startLogTimer();
  return {
    elapsedMs: (): number => Math.max(0, nowMs() - logicalStartMs),
    started: (): void => {
      logger.info(() =>
        activityLogEvent(
          SEARCH_CONNECTED_CONTEXT_STARTED_OPERATION,
          { correlationId },
          commonActivityExtra(identity),
        ),
      );
    },
    completed: (execution): void => {
      logConnectedContextCompletion(logger, identity, execution, correlationId, logElapsed());
    },
    failed: (error, progress): void => {
      const errorKind = safeConnectedContextErrorKind(error);
      const cancelled = isConnectedContextCancellation(error, errorKind);
      const event = (): ServerLogEvent =>
        activityLogEvent(
          SEARCH_CONNECTED_CONTEXT_FAILED_OPERATION,
          { correlationId, durationMs: logElapsed(), errorKind },
          safeFailureActivityExtra(identity, error, progress, cancelled, correlationId),
        );
      if (cancelled) logger.warn(event);
      else logger.error(event);
    },
  };
}

function fallbackConnectedContextActivity(
  nowMs: () => number,
  logicalStartMs: number,
): ConnectedContextActivity {
  return {
    elapsedMs: (): number => Math.max(0, nowMs() - logicalStartMs),
    started: (): void => undefined,
    completed: (): void => undefined,
    failed: (): void => undefined,
  };
}

function safeActivityCorrelationId(deps: OrchestratorDeps): string {
  const record = isRecord(deps) ? deps : {};
  const value = activityProperty(record, "correlationId");
  return correlationIdOrUnknown(typeof value === "string" ? value : undefined);
}

function safeConnectedContextActivity(
  input: OrchestratorInput,
  deps: OrchestratorDeps,
  nowMs: () => number,
  logicalStartMs: number,
): ConnectedContextActivity {
  try {
    return createConnectedContextActivity(input, deps, nowMs, logicalStartMs);
  } catch (error) {
    reportServerLogFailure(error, {
      op: "search.connected-context.started",
      correlationId: safeActivityCorrelationId(deps),
    });
    return fallbackConnectedContextActivity(nowMs, logicalStartMs);
  }
}

function connectedContextExecution(
  pack: ConnectedContextPack,
  plan: ExplorationPlan,
  activity: ConnectedContextActivity,
  status: ConnectedContextCompletionStatus,
  structural: StructuralRequestContextPoolDiagnostics,
  workspaceIndex: WorkspaceIndexActivityDiagnostics,
  workspaceIo: WorkspaceIoActivityDiagnostics,
): ConnectedContextExecution {
  return {
    output: { pack, elapsedMs: activity.elapsedMs(), plan },
    status,
    structural,
    workspaceIndex,
    workspaceIo,
  };
}

function connectedContextSearchInputs(
  input: OrchestratorInput,
  deps: OrchestratorDeps,
  plan: ExplorationPlan,
  runtime: ConnectedContextRuntime,
  context: LiveRetrievalContext,
): SearchInputs {
  const { workspaceIndex } = context;
  return {
    discoverDefinitions: (governor, evidence) =>
      discoverDefinitionsBeforeGraphs(
        liveGroundedPackInputs(input, deps, plan, runtime, context, { ...evidence, governor }),
      ),
    scopeContextBytesMax: plan.budget.excerptBytesMax,
    hasGitMetadata: context.hasGitMetadata,
    searchScope: context.searchScope,
    query: input.query,
    targetDecision: plan.targetDecision ?? resolveQueryTargetDecision(input.query, plan.anchors),
    anchors: plan.anchors,
    retrievalIntent: plan.retrievalIntent,
    fs: context.ringFs,
    nowMs: runtime.nowMs,
    signal: deps.signal,
    ...(workspaceIndex === undefined ? {} : { workspaceIndex }),
    workspaceIndexActivity: context.workspaceIndexActivity,
    repoSemanticSearchProvider: deps.repoSemanticSearchProvider ?? deps.semanticSearchProvider,
    gitFileHistoryEvidence: deps.gitFileHistoryEvidence ?? defaultGitFileHistoryEvidenceProvider,
    correlationId: deps.correlationId,
    structuralContexts: context.structuralContexts,
    deadlineAtMs: context.deadlineAtMs,
  };
}

function emptyWorkspaceIoActivityDiagnostics(): WorkspaceIoActivityDiagnostics {
  return {
    readDirCalls: 0,
    readDirEntries: 0,
    statCalls: 0,
    realPathCalls: 0,
    existsCalls: 0,
    contentReadCalls: 0,
    contentReadBytes: 0,
  };
}

function addWorkspaceIoPayloadCount(
  counters: MutableWorkspaceIoActivityCounters,
  key: "readDirEntries" | "contentReadBytes",
  value: unknown,
): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return;
  counters[key] = Math.min(Number.MAX_SAFE_INTEGER, counters[key] + value);
}

function recordTextPayload(counters: MutableWorkspaceIoActivityCounters, value: string): string {
  try {
    addWorkspaceIoPayloadCount(counters, "contentReadBytes", Buffer.byteLength(value, "utf8"));
  } catch {
    // Observability must never replace the workspace result supplied by the owning port.
  }
  return value;
}

function recordDescriptorPayload(
  counters: MutableWorkspaceIoActivityCounters,
  value: WorkspaceDescriptorUtf8Read,
): void {
  try {
    addWorkspaceIoPayloadCount(counters, "contentReadBytes", value.sizeBytes);
  } catch {
    // Observability must never evaluate a hostile projection outside its own failure boundary.
  }
}

function recordBytePayload<T extends Uint8Array>(
  counters: MutableWorkspaceIoActivityCounters,
  value: T,
): T {
  try {
    addWorkspaceIoPayloadCount(counters, "contentReadBytes", value.byteLength);
  } catch {
    // Observability must never replace the workspace result supplied by the owning port.
  }
  return value;
}

function observedWorkspaceFileReader(
  reader: WorkspaceFileReader,
  counters: MutableWorkspaceIoActivityCounters,
): WorkspaceFileReader {
  return {
    close: (): Promise<void> => reader.close(),
    readRange: async (startByte, length): Promise<Uint8Array> => {
      counters.contentReadCalls += 1;
      return recordBytePayload(counters, await reader.readRange(startByte, length));
    },
  };
}

function workspaceFsProperty<Key extends keyof WorkspaceFs>(
  fs: WorkspaceFs,
  key: Key,
): WorkspaceFs[Key] | undefined {
  try {
    return fs[key];
  } catch {
    return undefined;
  }
}

function observedDescriptorRead(
  fs: WorkspaceFs,
  counters: MutableWorkspaceIoActivityCounters,
): Pick<WorkspaceFs, "readFileUtf8SameDescriptor"> | Record<string, never> {
  const descriptorRead = workspaceFsProperty(fs, "readFileUtf8SameDescriptor");
  if (descriptorRead === undefined) return {};
  return {
    readFileUtf8SameDescriptor: (
      path: string,
      maxBytes: number,
      hardLinkPolicy: WorkspaceHardLinkPolicy,
      expected: WorkspaceStat,
    ): WorkspaceDescriptorUtf8Read => {
      counters.contentReadCalls += 1;
      const result = descriptorRead.call(fs, path, maxBytes, hardLinkPolicy, expected);
      recordDescriptorPayload(counters, result);
      return result;
    },
  };
}

function observedContainedDescriptorRead(
  fs: WorkspaceFs,
  counters: MutableWorkspaceIoActivityCounters,
): Pick<WorkspaceFs, "readFileUtf8WithinRootSameDescriptor"> | Record<string, never> {
  const containedDescriptorRead = workspaceFsProperty(fs, "readFileUtf8WithinRootSameDescriptor");
  if (containedDescriptorRead === undefined) return {};
  return {
    readFileUtf8WithinRootSameDescriptor: (
      canonicalRoot: string,
      path: string,
      maxBytes: number,
      hardLinkPolicy: WorkspaceHardLinkPolicy,
      completeness: WorkspaceDescriptorReadCompleteness,
    ): WorkspaceDescriptorUtf8Read => {
      counters.contentReadCalls += 1;
      const result = containedDescriptorRead.call(
        fs,
        canonicalRoot,
        path,
        maxBytes,
        hardLinkPolicy,
        completeness,
      );
      recordDescriptorPayload(counters, result);
      return result;
    },
  };
}

function observedPrefixRead(
  fs: WorkspaceFs,
  counters: MutableWorkspaceIoActivityCounters,
): Pick<WorkspaceFs, "readFileUtf8Prefix"> | Record<string, never> {
  const prefixRead = workspaceFsProperty(fs, "readFileUtf8Prefix");
  if (prefixRead === undefined) return {};
  return {
    readFileUtf8Prefix: (
      path: string,
      maxBytes: number,
      hardLinkPolicy: WorkspaceHardLinkPolicy,
      expected: WorkspaceStat,
    ): string => {
      counters.contentReadCalls += 1;
      return recordTextPayload(
        counters,
        prefixRead.call(fs, path, maxBytes, hardLinkPolicy, expected),
      );
    },
  };
}

function observedSynchronousContentReads(
  fs: WorkspaceFs,
  counters: MutableWorkspaceIoActivityCounters,
): Partial<WorkspaceFs> {
  return {
    ...observedDescriptorRead(fs, counters),
    ...observedContainedDescriptorRead(fs, counters),
    ...observedPrefixRead(fs, counters),
  };
}

function observedAsyncByteRead(
  read: (
    path: string,
    maxBytes: number,
    hardLinkPolicy: WorkspaceHardLinkPolicy,
    expected: WorkspaceStat,
  ) => Promise<Uint8Array>,
  fs: WorkspaceFs,
  counters: MutableWorkspaceIoActivityCounters,
): (
  path: string,
  maxBytes: number,
  hardLinkPolicy: WorkspaceHardLinkPolicy,
  expected: WorkspaceStat,
) => Promise<Uint8Array> {
  return async (path, maxBytes, hardLinkPolicy, expected): Promise<Uint8Array> => {
    counters.contentReadCalls += 1;
    return recordBytePayload(
      counters,
      await read.call(fs, path, maxBytes, hardLinkPolicy, expected),
    );
  };
}

function observedAsyncContentReads(
  fs: WorkspaceFs,
  counters: MutableWorkspaceIoActivityCounters,
): Partial<WorkspaceFs> {
  const byteRead = workspaceFsProperty(fs, "readFileBytes");
  const rangeRead = workspaceFsProperty(fs, "readFileRange");
  const openReader = workspaceFsProperty(fs, "openFileReader");
  return {
    ...(byteRead === undefined
      ? {}
      : { readFileBytes: observedAsyncByteRead(byteRead, fs, counters) }),
    ...(rangeRead === undefined
      ? {}
      : {
          readFileRange: async (
            path: string,
            start: number,
            length: number,
            hardLinkPolicy: WorkspaceHardLinkPolicy,
            expected: WorkspaceStat,
          ): Promise<Uint8Array> => {
            counters.contentReadCalls += 1;
            return recordBytePayload(
              counters,
              await rangeRead.call(fs, path, start, length, hardLinkPolicy, expected),
            );
          },
        }),
    ...(openReader === undefined
      ? {}
      : {
          openFileReader: async (
            path: string,
            hardLinkPolicy: WorkspaceHardLinkPolicy,
            expected: WorkspaceStat,
          ): Promise<WorkspaceFileReader> => {
            counters.contentReadCalls += 1;
            return observedWorkspaceFileReader(
              await openReader.call(fs, path, hardLinkPolicy, expected),
              counters,
            );
          },
        }),
  };
}

function observedCanonicalWorkspaceRoot(
  fs: WorkspaceFs,
  counters: MutableWorkspaceIoActivityCounters,
  canonicalRoots: Map<string, string>,
  observedRealPath: (absolutePath: string) => string,
  absoluteRoot: string,
): string {
  const key = resolve(absoluteRoot);
  const cached = canonicalRoots.get(key);
  if (cached !== undefined) return cached;
  const canonicalRoot = workspaceFsProperty(fs, "canonicalWorkspaceRoot");
  if (canonicalRoot === undefined) {
    const canonical = observedRealPath(absoluteRoot);
    canonicalRoots.set(key, canonical);
    return canonical;
  }
  counters.realPathCalls += 1;
  const canonical = canonicalRoot.call(fs, absoluteRoot);
  canonicalRoots.set(key, canonical);
  return canonical;
}

function observedDirectoryIteration(
  fs: WorkspaceFs,
  counters: MutableWorkspaceIoActivityCounters,
): Pick<WorkspaceFs, "iterateDirectory"> {
  const iterate = workspaceFsProperty(fs, "iterateDirectory");
  if (iterate === undefined) return {};
  return {
    iterateDirectory: async function* (path): AsyncIterable<WorkspaceDirEntry> {
      counters.readDirCalls += 1;
      for await (const entry of iterate.call(fs, path)) {
        addWorkspaceIoPayloadCount(counters, "readDirEntries", 1);
        yield entry;
      }
    },
  };
}

function requestScopedWorkspaceFs(fs: WorkspaceFs): WorkspaceIoActivity {
  const counters: MutableWorkspaceIoActivityCounters = emptyWorkspaceIoActivityDiagnostics();
  const canonicalRoots = new Map<string, string>();
  const observedRealPath = (absolutePath: string): string => {
    counters.realPathCalls += 1;
    return fs.realPath(absolutePath);
  };
  const observedFs = preserveOwnedRootAuthority(fs, {
    readFileUtf8: (absolutePath): string => {
      counters.contentReadCalls += 1;
      return recordTextPayload(counters, fs.readFileUtf8(absolutePath));
    },
    stat: (absolutePath): WorkspaceStat => {
      counters.statCalls += 1;
      return fs.stat(absolutePath);
    },
    readDir: (absolutePath, maxEntries): readonly WorkspaceDirEntry[] => {
      counters.readDirCalls += 1;
      const entries = fs.readDir(absolutePath, maxEntries);
      try {
        addWorkspaceIoPayloadCount(counters, "readDirEntries", entries.length);
      } catch {
        // Observability must never replace the workspace result supplied by the owning port.
      }
      return entries;
    },
    realPath: observedRealPath,
    exists: (absolutePath): boolean => {
      counters.existsCalls += 1;
      return fs.exists(absolutePath);
    },
    ...observedDirectoryIteration(fs, counters),
    ...observedSynchronousContentReads(fs, counters),
    ...observedAsyncContentReads(fs, counters),
    canonicalWorkspaceRoot: (absoluteRoot): string =>
      observedCanonicalWorkspaceRoot(fs, counters, canonicalRoots, observedRealPath, absoluteRoot),
  });
  return {
    fs: observedFs,
    diagnostics: (): WorkspaceIoActivityDiagnostics => ({ ...counters }),
  };
}

// One request-wide sentinel cap for the ring-retrieval directory snapshot (#3347 P1). Ring
// consumers do not agree on a per-directory cap: the lexical ring's candidate discovery, the
// structural ring's own SearchLimits, and the symbol-file / document-reference search contexts each
// derive an entry budget from their own `maxFilesScanned`, so ONE request asks the SAME directory
// for several listings at caps orders of magnitude apart — measured against this pipeline with the
// snapshot disabled, four enumerations of one workspace root at 10_001 apiece on one fixture and at
// 56_301 / 30_701 / 100_001 / 500_001 on another, and a selected directory at 25 for a `files`
// scope. Reading at the caller's own cap and retaining the listing only when it came back BELOW
// that cap therefore kept exactly the cheap case and dropped the expensive one: a directory whose
// fan-out reaches a cap was discarded and re-enumerated by every later consumer, which is where a
// repeated walk costs the most. Reading once at a cap chosen before the first ring instead lets
// every later consumer be served from that single listing.
//
// 500_001 is the largest of those measured caps (the symbol-file / document-reference search
// contexts' 10_000-file scan budget, expanded by the workspace layer's candidate-discovery entry
// budget). Nothing depends on that number for CORRECTNESS: a request the snapshot cannot answer
// exactly — an uncapped read, or a cap beyond a snapshot that already overflowed — falls through to
// a real read rather than returning a silent subset. It buys the single-enumeration property, and
// the cost it trades for it is that the FIRST consumer to touch a directory pays the sentinel read
// instead of its own smaller one. In a request that also walks the directory that is a move, not an
// addition — the walk would have made the larger read anyway, and every consumer after it now makes
// none; a directory touched only by a small probe pays the sentinel read in place of that probe.
const RING_DISCOVERY_SENTINEL_ENTRIES = 500_001;

interface RingDirectorySnapshot {
  readonly entries: readonly WorkspaceDirEntry[];
  // True when the directory holds MORE entries than this snapshot captured, so the snapshot can
  // only answer a request whose cap it can satisfy exactly.
  readonly overflowed: boolean;
}

// Every consumer of `readDir` that ring retrieval feeds either (a) treats a capped read that comes
// back at its cap as an opaque "too many entries, reject this directory" signal — a count
// comparison, not an ordering assumption (discovery.ts) — or (b) hashes the returned entries
// through `workspaceDirectoryFingerprint`, which sorts before hashing and is therefore
// order-independent. Serving the first `maxEntries` of the snapshot is consequently observably
// identical to a fresh read at that cap. Returning `undefined` means the snapshot CANNOT answer
// exactly: it overflowed and the caller asked for more than it holds, so the caller must see a real
// read instead of a subset the snapshot cannot prove is the whole answer.
function sliceRingDirectorySnapshot(
  snapshot: RingDirectorySnapshot,
  maxEntries: number | undefined,
): readonly WorkspaceDirEntry[] | undefined {
  const { entries, overflowed } = snapshot;
  if (maxEntries !== undefined && maxEntries <= entries.length) {
    return maxEntries === entries.length ? entries : entries.slice(0, maxEntries);
  }
  return overflowed ? undefined : entries;
}

function ringDirectorySnapshot(
  fs: WorkspaceFs,
  snapshots: Map<string, RingDirectorySnapshot>,
  absolutePath: string,
): RingDirectorySnapshot {
  const cached = snapshots.get(absolutePath);
  if (cached !== undefined) return cached;
  // One entry past the sentinel: coming back at or below the sentinel is proof nothing was left
  // unread, which is what lets a later consumer with a larger cap be answered from this listing.
  const entries = fs.readDir(absolutePath, RING_DISCOVERY_SENTINEL_ENTRIES + 1);
  const snapshot: RingDirectorySnapshot = {
    entries,
    overflowed: entries.length > RING_DISCOVERY_SENTINEL_ENTRIES,
  };
  snapshots.set(absolutePath, snapshot);
  return snapshot;
}

// A side effect worth naming: because every ring consumer is served from the same snapshot, they
// all see ONE generation of each directory. Four independent enumerations could each observe a
// different generation of the same directory and mix them across the rings of one request; the port
// detects a replacement around each single enumeration, but nothing reconciled the four against
// each other.
//
// Scoped to ring retrieval only — a fresh wrapper around `runtime.fs`, not a change to `runtime.fs`
// itself — so project-metadata discovery (deterministicMetadataEvidence's package.json/pom.xml
// probing, which deliberately re-reads a directory at escalating small caps to detect and report a
// genuine enumeration failure) keeps making its own real, individually observable calls against the
// unwrapped fs. `runtime.fs`'s own methods are plain closures with no `this` dependency (see
// requestScopedWorkspaceFs), so spreading it to forward every other method verbatim is safe.
function ringDiscoveryFs(fs: WorkspaceFs): WorkspaceFs {
  const snapshots = new Map<string, RingDirectorySnapshot>();
  return preserveOwnedRootAuthority(fs, {
    ...fs,
    readDir: (absolutePath, maxEntries): readonly WorkspaceDirEntry[] =>
      sliceRingDirectorySnapshot(ringDirectorySnapshot(fs, snapshots, absolutePath), maxEntries) ??
      fs.readDir(absolutePath, maxEntries),
  });
}

// Internal seam: package-local tests drive the ring-retrieval snapshot at fan-outs and caps the
// production rings only reach on a workspace far too large to seed in a unit test.
export function _ringDiscoveryFsForTests(fs: WorkspaceFs): WorkspaceFs {
  return ringDiscoveryFs(fs);
}

export const _RING_DISCOVERY_SENTINEL_ENTRIES_FOR_TESTS = RING_DISCOVERY_SENTINEL_ENTRIES;

function liveStructuralContexts(
  searchScope: SearchScope,
  fs: WorkspaceFs,
  runtime: ConnectedContextRuntime,
  deadlineAtMs: number,
  workspaceIndexActivity: WorkspaceIndexActivity,
  signal: AbortSignal | undefined,
): StructuralRequestContextPool {
  return createStructuralRequestContextPool(
    searchScope,
    fs,
    runtime.nowMs,
    deadlineAtMs,
    workspaceIndexActivity,
    signal,
  );
}

interface LiveRetrievalContext {
  readonly hasGitMetadata: boolean;
  readonly deadlineAtMs: number;
  readonly searchScope: SearchScope;
  readonly ringFs: WorkspaceFs;
  readonly structuralContexts: StructuralRequestContextPool;
  readonly workspaceIndexSource: WorkspaceIndex | undefined;
  readonly workspaceIndexActivity: WorkspaceIndexActivity;
  readonly workspaceIndex: WorkspaceIndex | undefined;
}

function detectConnectedContextWorkspace(root: string, fs: WorkspaceFs): WorkspaceInfo {
  return detectWorkspaceAt(root, fs, { scanSourceFilesForLanguages: false });
}

// #3347 P2: detection previously received the observed raw filesystem with no request signal or
// deadline, so its first time check happened only after `detect` returned — a hostile or merely
// huge workspace could stat past the deadline before the request noticed. Guard the sync core
// operations detection actually performs (stat/exists/readFileUtf8/realPath/readDir) with the SAME
// cancellation/deadline control the rest of this request honors — the check-run-check pattern
// `metadataTraversalOperation` already uses to bound the deterministic-metadata traversal — so a
// trip lands BETWEEN two detector filesystem operations, not only after `detect` returns. Unlike
// `metadataTraversalFs`, this spreads `fs` first (safe: `runtime.fs`'s methods are plain closures
// with no `this` dependency, see requestScopedWorkspaceFs/ringDiscoveryFs) so every OTHER method —
// including the async descriptor/range readers detection never calls but callers may still probe —
// stays forwarded unguarded, rather than silently dropped.
function detectionGuardedFs(fs: WorkspaceFs, control: MetadataTraversalControl): WorkspaceFs {
  const run = <T>(operation: () => T): T => metadataTraversalOperation(control, operation);
  return preserveOwnedRootAuthority(fs, {
    ...fs,
    readFileUtf8: (path): string => run(() => fs.readFileUtf8(path)),
    stat: (path): WorkspaceStat => run(() => fs.stat(path)),
    readDir: (path, maxEntries): readonly WorkspaceDirEntry[] =>
      run(() => fs.readDir(path, maxEntries)),
    realPath: (path): string => run(() => fs.realPath(path)),
    exists: (path): boolean => run(() => fs.exists(path)),
  });
}

function explorationDeadlineAtMs(startedAtMs: number, budget: ExplorationBudget): number {
  return budget.elapsedMsMax === null
    ? Number.POSITIVE_INFINITY
    : startedAtMs + Math.max(0, budget.elapsedMsMax);
}

function prepareLiveRetrievalContext(
  input: OrchestratorInput,
  deps: OrchestratorDeps,
  plan: ExplorationPlan,
  runtime: ConnectedContextRuntime,
): LiveRetrievalContext {
  const deadlineAtMs = explorationDeadlineAtMs(runtime.requestStartedAtMs, plan.budget);
  runtime.progress.phase = "workspace-detection";
  const detectionControl: MetadataTraversalControl = {
    signal: deps.signal,
    nowMs: runtime.nowMs,
    deadlineAtMs,
  };
  const workspace = runtime.detect(
    runtime.workspaceRoot,
    detectionGuardedFs(runtime.fs, detectionControl),
  );
  const hasGitMetadata = detectionGuardedFs(runtime.fs, detectionControl).exists(
    resolve(workspace.root, ".git"),
  );
  const searchScope = buildSearchScope(input.scope, workspace);
  const workspaceIndexSource =
    runtime.nowMs() < deadlineAtMs ? deps.workspaceIndexForRoot?.(workspace.root) : undefined;
  const workspaceIndexActivity = createWorkspaceIndexActivity(workspaceIndexSource);
  runtime.progress.workspaceIndexActivity = workspaceIndexActivity;
  const ringFs = ringDiscoveryFs(runtime.fs);
  const structuralContexts = liveStructuralContexts(
    searchScope,
    ringFs,
    runtime,
    deadlineAtMs,
    workspaceIndexActivity,
    deps.signal,
  );
  runtime.progress.structuralContexts = structuralContexts;
  return {
    hasGitMetadata,
    deadlineAtMs,
    searchScope,
    ringFs,
    structuralContexts,
    workspaceIndexSource,
    workspaceIndexActivity,
    workspaceIndex: workspaceIndexActivity.workspaceIndex,
  };
}

function liveGroundedPackInputs(
  input: OrchestratorInput,
  deps: OrchestratorDeps,
  plan: ExplorationPlan,
  runtime: ConnectedContextRuntime,
  context: LiveRetrievalContext,
  rings: RingRunSummary,
): AssembleGroundedPackInputs {
  return {
    input,
    deps,
    plan,
    rings,
    searchScope: context.searchScope,
    fs: context.ringFs,
    metadataFs: runtime.fs,
    nowMs: runtime.nowMs,
    structuralContexts: context.structuralContexts,
    workspaceIndex: context.workspaceIndex,
    deadlineAtMs: context.deadlineAtMs,
    hasGitMetadata: context.hasGitMetadata,
  };
}

async function retrieveLiveConnectedContext(
  input: OrchestratorInput,
  deps: OrchestratorDeps,
  plan: ExplorationPlan,
  governor: GovernorState,
  runtime: ConnectedContextRuntime,
  context: LiveRetrievalContext,
): Promise<ConnectedContextExecution> {
  runtime.progress.phase = "ring-retrieval";
  const rings = await runAllRings(
    plan.rings,
    connectedContextSearchInputs(input, deps, plan, runtime, context),
    governor,
  );
  throwIfCancelled(deps.signal);
  runtime.progress.phase = "pack-assembly";
  const assembled = await assembleGroundedPack(
    liveGroundedPackInputs(input, deps, plan, runtime, context, rings),
  );
  throwIfCancelled(deps.signal);
  return connectedContextExecution(
    assembled.pack,
    plan,
    runtime.activity,
    liveRetrievalCompletion(context.workspaceIndexSource !== undefined, assembled, rings.decisions),
    context.structuralContexts.diagnostics(),
    context.workspaceIndexActivity.diagnostics(),
    runtime.workspaceIoActivity.diagnostics(),
  );
}

// Which budget actually stopped the request is reported, not inferred: `readBudgetBlocked` and
// `elapsedBudgetBlocked` stay separate flags because both can be true at once and the completion
// status distinguishes them. Carried together so the reason and the two flags that describe it
// cannot drift apart across the two call sites that raise them.
interface BudgetExhaustedStop {
  readonly stopReason: string;
  readonly readBudgetBlocked: boolean;
  readonly elapsedBudgetBlocked: boolean;
}

async function emptyBudgetExhaustedRetrieval(
  input: OrchestratorInput,
  deps: OrchestratorDeps,
  plan: ExplorationPlan,
  governor: GovernorState,
  runtime: ConnectedContextRuntime,
  stop: BudgetExhaustedStop,
): Promise<ConnectedContextExecution> {
  runtime.progress.phase = "empty-pack-assembly";
  const stoppedGovernor = stop.elapsedBudgetBlocked
    ? applyUsage(governor, usageDelta({ elapsedMs: plan.budget.elapsedMsMax ?? 0 }))
    : governor;
  const pack = await assembleEmptyGroundedPack({
    input,
    deps,
    plan,
    governor: stoppedGovernor,
    nowMs: runtime.nowMs,
    stopReason: stop.stopReason,
  });
  throwIfCancelled(deps.signal);
  return connectedContextExecution(
    pack,
    plan,
    runtime.activity,
    stoppedRetrievalCompletion(stop.readBudgetBlocked, stop.elapsedBudgetBlocked),
    EMPTY_STRUCTURAL_DIAGNOSTICS,
    NOT_EVALUATED_WORKSPACE_INDEX_DIAGNOSTICS,
    runtime.workspaceIoActivity.diagnostics(),
  );
}

// #3347 P2: workspace detection is deadline/signal-guarded (see prepareLiveRetrievalContext) so a
// request that is already out of budget by the time detection runs stops mid-traversal instead of
// finishing an unbounded filesystem walk, rather than reaching ring retrieval on a workspace that
// was never actually resolved in time. Catching only around preparation — not the whole
// live-retrieval call — keeps this narrow: nothing past preparation uses the same deadline-guarded
// fs, so no later, unrelated deadline trip can be mistaken for this one. Fold the outcome into the
// SAME empty-pack, budget-exhausted result the caller's pre-flight elapsedMs check already produces,
// instead of letting a half-finished detection surface as an unhandled orchestrator error.
async function retrieveLiveOrDeadlineExhausted(
  input: OrchestratorInput,
  deps: OrchestratorDeps,
  plan: ExplorationPlan,
  governor: GovernorState,
  runtime: ConnectedContextRuntime,
): Promise<ConnectedContextExecution> {
  let liveContext: LiveRetrievalContext;
  try {
    liveContext = prepareLiveRetrievalContext(input, deps, plan, runtime);
  } catch (error) {
    if (!isMetadataTraversalDeadline(error)) throw error;
    return emptyBudgetExhaustedRetrieval(input, deps, plan, governor, runtime, {
      stopReason: "budget-exhausted on elapsedMs",
      readBudgetBlocked: false,
      elapsedBudgetBlocked: true,
    });
  }
  return retrieveLiveConnectedContext(input, deps, plan, governor, runtime, liveContext);
}

async function executeConnectedContextRetrieval(
  input: OrchestratorInput,
  deps: OrchestratorDeps,
  runtime: ConnectedContextRuntime,
): Promise<ConnectedContextExecution> {
  throwIfCancelled(deps.signal);
  runtime.progress.phase = "planning";
  const { plan, governor } = createReadyGovernedPlan(input, runtime.nowMs);
  runtime.progress.plannedRingCount = plan.rings.length;
  deps.recordPlan?.(plan);
  throwIfCancelled(deps.signal);
  runtime.progress.phase = "workspace-admission";
  const admittedRuntime: ConnectedContextRuntime = {
    ...runtime,
    workspaceRoot: assertGroundedWorkspaceRootAllowed(runtime.fs, input.workspaceRoot, deps),
  };
  runtime.progress.phase = "budget-evaluation";
  const readBudgetBlock = readBudgetStopReason(plan.budget);
  const deadlineAtMs = explorationDeadlineAtMs(runtime.requestStartedAtMs, plan.budget);
  const elapsedBudgetBlock =
    runtime.nowMs() >= deadlineAtMs ? "budget-exhausted on elapsedMs" : undefined;
  const stopReason = readBudgetBlock ?? elapsedBudgetBlock;
  if (stopReason === undefined) {
    return retrieveLiveOrDeadlineExhausted(input, deps, plan, governor, admittedRuntime);
  }
  return emptyBudgetExhaustedRetrieval(input, deps, plan, governor, runtime, {
    stopReason,
    readBudgetBlocked: readBudgetBlock !== undefined,
    elapsedBudgetBlocked: elapsedBudgetBlock !== undefined,
  });
}

// Epic #532 — retrieval-only pipeline: the ready-governed plan, workspace detection, ring run,
// and pack assembly (the original steps 1–4) WITHOUT the model answer. `deps.answerer` is part of
// the shared deps type but is intentionally not invoked here; the multi-source path answers once
// over the merged packs rather than per source.
function assertGroundedWorkspaceRootAllowed(
  fs: WorkspaceFs,
  workspaceRoot: string,
  deps: OrchestratorDeps,
): string {
  try {
    return resolveRecordedWorkspaceRoot(fs, workspaceRoot, deps);
  } catch (error) {
    if (
      error instanceof PathDeniedError ||
      error instanceof WorkspaceNotFoundError ||
      error instanceof CancelledError
    ) {
      throw error;
    }
    if (!isExpectedWorkspaceRootFailure(error)) throw error;
    const unavailable = new WorkspaceNotFoundError(
      "The workspace root is unavailable.",
      workspaceRoot,
      [workspaceRoot],
    );
    unavailable.cause = error;
    throw unavailable;
  }
}

export async function retrieveConnectedContextPack(
  input: OrchestratorInput,
  deps: OrchestratorDeps,
): Promise<RetrievalOnlyOutput> {
  const nowMs = deps.nowMs ?? Date.now;
  const requestStartedAtMs = nowMs();
  const activity = safeConnectedContextActivity(input, deps, nowMs, requestStartedAtMs);
  const progress: ConnectedContextProgress = {
    phase: "request-validation",
    plannedRingCount: 0,
  };
  activity.started();
  try {
    const workspaceIoActivity = requestScopedWorkspaceFs(
      input.workspaceFs ?? deps.fs ?? nodeWorkspaceFs,
    );
    progress.workspaceIoActivity = workspaceIoActivity;
    const execution = await executeConnectedContextRetrieval(input, deps, {
      fs: workspaceIoActivity.fs,
      workspaceRoot: input.workspaceRoot,
      detect: deps.detectWorkspace ?? detectConnectedContextWorkspace,
      nowMs,
      activity,
      progress,
      workspaceIoActivity,
      requestStartedAtMs,
    });
    activity.completed(execution);
    return execution.output;
  } catch (error) {
    activity.failed(error, progress);
    throw error;
  }
}

// Knowledge M1.2 (#2563): fetch the injected entailment stage's markers for the answer, or `[]`
// when no stage is injected (keeps runGroundedExploration under the complexity/LOC bound).
async function entailmentMarkersFor(
  deps: OrchestratorDeps,
  answerContent: string,
  pack: ConnectedContextPack,
  nowMs: number,
): Promise<readonly UncertaintyMarker[]> {
  return (await deps.entailmentStage?.evaluate(answerContent, [pack], nowMs)) ?? [];
}

function citationCoverageMarkerFor(
  answerContent: string,
  pack: ConnectedContextPack,
  nowMs: number,
  correlationId: string | undefined,
): UncertaintyMarker | undefined {
  const reconciliation = reconcileAndLogInlineCitations(
    answerContent,
    buildPackCitationIndex([pack]),
    correlationId,
  );
  const unsupported = unsupportedCitationMarker(reconciliation.unsupported, nowMs);
  if (unsupported !== undefined || reconciliation.citedScopePaths.size > 0) return unsupported;
  return missingCitationMarkerFor(answerContent, nowMs);
}

function exhaustedAnswerBudgetDimensions(
  answer: GroundedAnswerResult,
  pack: ConnectedContextPack,
  elapsedMs: number,
): readonly string[] {
  return [
    ...(answer.usage.promptTokens > pack.budget.modelInputTokensMax ? ["modelInputTokens"] : []),
    ...(answer.usage.completionTokens > pack.budget.modelOutputTokensMax
      ? ["modelOutputTokens"]
      : []),
    ...(pack.budget.elapsedMsMax !== null && elapsedMs > pack.budget.elapsedMsMax
      ? ["elapsedMs"]
      : []),
  ];
}

async function answerWithAvailableContext(
  input: OrchestratorInput,
  deps: OrchestratorDeps,
  pack: ConnectedContextPack,
  plan: OrchestratorOutput["plan"],
  sourceEvidenceAvailable: boolean,
  start: number,
  nowMs: () => number,
): Promise<OrchestratorOutput> {
  const answer = normalizeGroundedAnswerPayload(
    await deps.answerer.answer(input.answerQuestion ?? input.query.text, pack),
  );
  const elapsedMs = Math.max(0, nowMs() - start);
  const exhausted = exhaustedAnswerBudgetDimensions(answer, pack, elapsedMs);
  const unsupportedMarker = citationCoverageMarkerFor(
    answer.content,
    pack,
    nowMs(),
    deps.correlationId,
  );
  const entailmentMarkers = await entailmentMarkersFor(deps, answer.content, pack, nowMs());
  const groundedPack: ConnectedContextPack = {
    ...pack,
    usage: {
      ...pack.usage,
      modelInputTokens: Math.min(answer.usage.promptTokens, pack.budget.modelInputTokensMax),
      modelOutputTokens: Math.min(answer.usage.completionTokens, pack.budget.modelOutputTokensMax),
      elapsedMs: Math.min(
        Math.max(pack.usage.elapsedMs, elapsedMs),
        pack.budget.elapsedMsMax ?? Number.POSITIVE_INFINITY,
      ),
    },
    uncertainty: [
      ...pack.uncertainty,
      ...(exhausted.length === 0 ? [] : [answerBudgetClipped(exhausted, nowMs())]),
      ...(unsupportedMarker === undefined ? [] : [unsupportedMarker]),
      ...(answer.finishReason === "length" ? [incompleteAnswerMarker(nowMs())] : []),
      ...entailmentMarkers,
    ],
  };
  return {
    pack: groundedPack,
    assistantContent: answer.content,
    elapsedMs,
    modelInvoked: true,
    ...(answer.promptContext === undefined ? {} : { promptContext: answer.promptContext }),
    ...(plan === undefined ? {} : { plan }),
    ...(!sourceEvidenceAvailable ? { noEvidence: true } : {}),
  };
}

export async function runGroundedExploration(
  input: OrchestratorInput,
  deps: OrchestratorDeps,
): Promise<OrchestratorOutput> {
  // AC5 (#532): the single-source path measures its OWN total wall time (retrieval + answer) so the
  // observable elapsedMs is byte-identical to before this split. The retrieval-only elapsed returned
  // by retrieveConnectedContextPack is deliberately discarded here.
  const nowMs = deps.nowMs ?? Date.now;
  const start = nowMs();
  const { pack, plan } = await retrieveConnectedContextPack(input, deps);
  // GEN-AI-GROUNDING-002/-003 (RB-4): abstain BEFORE the model call when the assembled pack carries
  // no usable evidence. The local-knowledge and hybrid paths already short-circuit here; the folder
  // path must too, so the model is never asked to answer confidently over zero evidence and no
  // hallucinated answer is persisted as grounded. The `no-evidence` uncertainty marker is already on
  // the pack (assemblePackFromReads adds it when excerpts are empty).
  const sourceEvidenceAvailable = packHasUsableEvidence(pack);
  if (!sourceEvidenceAvailable && input.answerOnlyContextAvailable !== true) {
    const elapsedMs = Math.max(0, nowMs() - start);
    return {
      pack,
      assistantContent: connectedSearchNoEvidenceAnswer(input.currentQuestion ?? input.query.text),
      elapsedMs,
      plan,
      noEvidence: true,
    };
  }
  return answerWithAvailableContext(input, deps, pack, plan, sourceEvidenceAvailable, start, nowMs);
}

// Re-export DEFAULT_SEARCH_LIMITS for parity with #179 callers that import limits via the
// orchestrator. Keeps `grounded-qa.ts` from needing a second workspace import path.
export { DEFAULT_SEARCH_LIMITS };
