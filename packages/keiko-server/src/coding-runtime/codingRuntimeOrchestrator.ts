import type { CodingRuntimeHistory } from "./codingRuntimeHistory.js";
/** Server-owned, single-slot lifecycle coordinator for the Coding Workbench (issue #2256). */
import { createHash, randomUUID } from "node:crypto";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type {
  CodingWorkbenchAuxiliaryStatus,
  CodingWorkbenchIssueBinding,
  CodingWorkbenchMode,
  CodingWorkbenchModelRefusalReason,
  CodingWorkbenchOperatorDecision,
  CodingWorkbenchRuntimeApprovalDecisionRequest,
  CodingWorkbenchRuntimeEvent,
  CodingWorkbenchRuntimeFailureCode,
  CodingWorkbenchRuntimePendingApprovalReview,
  CodingWorkbenchRuntimePendingPermission,
  CodingWorkbenchRuntimePendingResearch,
  CodingWorkbenchRuntimeResearchGrant,
  CodingWorkbenchRuntimeResult,
  CodingWorkbenchRuntimeSnapshot as PublicSnapshot,
  CodingWorkbenchRuntimeStartRequest,
  CodingWorkbenchRuntimeStateName,
  SkillDiscoveryResultV1,
} from "@oscharko-dev/keiko-contracts";
import { isLegalCodingWorkbenchRuntimeTransition } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";
import { GOVERNED_TOOL_HUMAN_DECISION_WAIT_MS } from "@oscharko-dev/keiko-contracts/runtime/tools";
import { isDeliveredDraftDeliveryPhase } from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import {
  parseCodingWorkbenchRuntimeRecoveryAcknowledgementRequest,
  parseCodingWorkbenchRuntimeResumeRequest,
  parseCodingWorkbenchRuntimeApprovalDecisionRequest,
  parseCodingWorkbenchRuntimeResearchRevokeRequest,
  parseCodingWorkbenchRuntimeStartRequest,
  parseCodingWorkbenchRuntimeStopRequest,
  parseCodingWorkbenchRuntimeTakeoverRequest,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import type {
  CodingRuntimeApprovalIssueResult,
  CodingRuntimeFailureCode,
  CodingRuntimeManager,
} from "./codingRuntimeManager.js";
import type {
  CodingRuntimeSnapshot,
  CodingRuntimeSnapshotStore,
} from "./codingRuntimeSnapshotStore.js";
import {
  DRAFT_DELIVERY_RECOVERY_MAX_PREDECESSORS,
  draftDeliveryLineageRecord,
  localDraftDeliverySource,
  sameDraftRecoveryTask,
} from "./codingRuntimeDraftDeliverySource.js";
import { reviewableResearchAsk } from "./researchApprovalIssuance.js";
import type { ActiveWorkspaceView } from "../task-workspace/types.js";
import { isIdentityProofFailure } from "../task-workspace/errors.js";
import { CodingRuntimeOperationCoordinator } from "./codingRuntimeOperationCoordinator.js";
import {
  auxiliaryEventFacts,
  CodingRuntimeOrchestratorState,
  type AuxiliaryEventFacts,
} from "./codingRuntimeOrchestratorState.js";
import {
  contentFreeErrorClass,
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticSink,
  describeError,
} from "../diagnostics-log.js";
import { isValidCorrelationId, UNKNOWN_CORRELATION_ID } from "../correlation.js";
import type { ServerLogSink } from "../observability/server-log.js";
import type {
  CodingRuntimeLaunchResolver,
  CodingRuntimeOrchestratorDeps,
  CodingRuntimeOrchestratorResult,
  CodingRuntimeQuestionOperationResult,
} from "./codingRuntimeOrchestratorTypes.js";
import { launchRejectionDiagnosticReason, refusedLaunch } from "./launchFailure.js";
import type {
  CodingRuntimeTaskDispatchResult,
  CodingRuntimeTaskOutcome,
} from "./productionCodingRuntimeHost.js";
import {
  admitCodingRuntimeIssue,
  type CodingRuntimeIssueAttachment,
} from "./codingRuntimeIssueIntake.js";
import { renderInitialTurnContext } from "./productionCodingRuntimePorts.js";
import {
  codingRuntimeProjectMemoryScopes,
  composeCodingRuntimeInitialContext,
  renderCodingRuntimeProjectMemoryContext,
} from "./codingRuntimeProjectMemory.js";
import type {
  CodingRuntimeDescriptionJobStore,
  WorkbenchDescriptionScope,
} from "./codingRuntimeDescriptionJobStore.js";
import type { PrDescriptionDraftPreview } from "../gitDelivery/prDescriptionTypes.js";
import {
  WORKBENCH_DESCRIPTION_REASON_STATES,
  type WorkbenchDescriptionReason,
  type WorkbenchDescriptionStatus,
  type WorkbenchDescriptionGenerationBinding,
} from "@oscharko-dev/keiko-contracts/runtime/workbench-description-status";
import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
export type { CodingRuntimeIssueIntake } from "./codingRuntimeIssueIntake.js";

const CODING_RUNTIME_STATE_FIELD = {
  type: "string",
  dataClass: "closed-enum",
  required: true,
  values: [
    "idle",
    "starting",
    "ready",
    "running",
    "paused",
    "awaiting-approval",
    "stopping",
    "succeeded",
    "failed",
    "cancelled",
    "taken-over",
    "recovery-required",
  ],
} as const;

const CODING_RUNTIME_RUN_FIELDS = {
  runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
  state: CODING_RUNTIME_STATE_FIELD,
  revision: { type: "integer", dataClass: "count", required: true },
  requestedMode: {
    type: "string",
    dataClass: "closed-enum",
    required: true,
    values: ["governed-assist", "supervised-coding", "autonomous-delivery"],
  },
  runtimeSource: {
    type: "string",
    dataClass: "closed-enum",
    required: true,
    values: ["keiko-sidecar", "codex-cli-adapter", "delivery-runner"],
  },
  modelSource: {
    type: "string",
    dataClass: "closed-enum",
    required: true,
    values: [
      "keiko-model-gateway",
      "openai-api-key-through-gateway",
      "chatgpt-codex-subscription-profile",
    ],
  },
} as const;

const CODING_RUNTIME_FAILURE_CODE_FIELD = {
  type: "string",
  dataClass: "closed-enum",
  required: false,
  values: [
    "runtime-unavailable",
    "active-run-conflict",
    "invalid-intent",
    "approval-activation-failed",
    "authority-resolution-failed",
    "authority-expired",
    "authority-replayed",
    "task-drift",
    "workspace-drift",
    "project-drift",
    "branch-drift",
    "scope-drift",
    "budget-drift",
    "authority-budget-exceeded",
    "source-drift",
    "runtime-failed",
    "revoked",
    "recovery-required",
    "replay-cap-exhausted",
    "issue-context-unavailable",
    "question-answer-rejected",
    "delivery-not-evidenced",
    "model-unavailable",
    "workspace-unqualified",
  ],
} as const;

const CODING_RUNTIME_OPTIONAL_DIAGNOSTIC_FIELDS = {
  code: { type: "string", dataClass: "opaque-id", required: false, maxLength: 256 },
  gatewayRequestId: {
    type: "string",
    dataClass: "opaque-id",
    required: false,
    maxLength: 128,
  },
  httpStatus: { type: "integer", dataClass: "count", required: false },
  retryAfterMs: { type: "integer", dataClass: "duration", required: false },
  partialPromptTokens: { type: "integer", dataClass: "count", required: false },
  partialCompletionTokens: { type: "integer", dataClass: "count", required: false },
  frames: {
    type: "string-array",
    dataClass: "opaque-id",
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
} as const;

const CODING_RUNTIME_RUN_STARTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.run.started",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.codingRuntimeOrchestrator.recordRuntimeRunStarted",
  fields: {
    ...CODING_RUNTIME_RUN_FIELDS,
    effectiveMode: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["governed-assist", "supervised-coding", "autonomous-delivery"],
    },
    hasPredecessor: { type: "boolean", dataClass: "closed-enum", required: true },
    predecessorSelectionReason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "acknowledged-recovery",
        "failed-successor-lineage",
        "historical-local-draft",
        "no-bounded-lineage",
      ],
    },
    predecessorRunId: {
      type: "string",
      dataClass: "opaque-id",
      required: false,
      maxLength: 128,
    },
  },
  causal: "correlation",
  lifecycle: "start",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-run-start"],
  proofIds: ["coding-runtime.run.started.emitted-line"],
  releaseImpact: "patch",
});

const CODING_RUNTIME_PROJECT_MEMORY_CONTEXT_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.project-memory.context",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.codingRuntimeOrchestrator.recordRuntimeProjectMemoryContext",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["disabled", "empty", "failed", "included", "unavailable"],
    },
    includedMemoryCount: { type: "integer", dataClass: "count", required: true },
    scopeKindCount: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-project-memory"],
  proofIds: ["coding-runtime.project-memory.context.emitted-line"],
  releaseImpact: "patch",
});

const CODING_RUNTIME_APPROVAL_WAITING_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.approval.waiting",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.codingRuntimeOrchestrator.recordRuntimeApprovalWaiting",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    revision: { type: "integer", dataClass: "count", required: true },
    requestId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    permissionKind: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "workspace-write",
        "command-execution",
        "network-egress",
        "connector-access",
        "delivery-substrate",
      ],
    },
    actionClass: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "workspace-read",
        "workspace-write",
        "command-execution",
        "verification",
        "connector-access",
        "network-egress",
        "delivery-substrate",
      ],
    },
    actionKind: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "file-edit",
        "git-stage",
        "verification-command",
        "ci-observe",
        "connector-read",
        "research",
        "commit",
        "push",
        "pull-request",
        "merge",
        "connector-write",
        "external-write",
        "system-mutation",
      ],
    },
    queuePosition: { type: "integer", dataClass: "count", required: false },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-approval-wait"],
  proofIds: ["coding-runtime.approval.waiting.emitted-line"],
  releaseImpact: "patch",
});

const CODING_RUNTIME_RUN_OPERATOR_DECISION_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.run.operator-decision",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.codingRuntimeOrchestrator.recordRuntimeOperatorDecision",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    revision: { type: "integer", dataClass: "count", required: true },
    runState: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "idle",
        "starting",
        "ready",
        "running",
        "paused",
        "awaiting-approval",
        "stopping",
        "succeeded",
        "failed",
        "cancelled",
        "taken-over",
        "recovery-required",
      ],
    },
    decision: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["workspace-script-trust"],
    },
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["waiting", "settled", "not-admissible"],
    },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["accepted", "denied", "unavailable", "limit-reached", "stopped"],
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-operator-decision"],
  proofIds: ["coding-runtime.run.operator-decision.emitted-line"],
  releaseImpact: "patch",
});

const CODING_RUNTIME_EVENT_DROPPED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.event.dropped",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.codingRuntimeOrchestrator.recordRuntimeEventDropped",
  fields: {
    eventKind: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "runtime-started",
        "runtime-stopped",
        "runtime-health",
        "task-submitted",
        "observation-streamed",
        "permission-requested",
        "diff-summarized",
        "verification-summarized",
        "artifact-produced",
        "research-performed",
        "skill-invoked",
        "child-run-started",
        "child-run-completed",
        "operator-decision",
        "failure-redacted",
      ],
    },
    eventRunId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["no-live-run", "run-mismatch"],
    },
    liveRunId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 128 },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["coding-runtime-event-drop"],
  proofIds: ["coding-runtime.event.dropped.emitted-line"],
  releaseImpact: "patch",
});

const CODING_RUNTIME_VERIFICATION_SUMMARIZED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.verification-summarized",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.codingRuntimeOrchestrator.recordRuntimeVerificationSummary",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    verificationEventId: {
      type: "string",
      dataClass: "opaque-id",
      required: true,
      maxLength: 128,
    },
    verificationKind: {
      type: "string",
      dataClass: "opaque-id",
      required: true,
      maxLength: 128,
    },
    verificationStatus: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["passed", "failed", "partial"],
    },
    passedCount: { type: "integer", dataClass: "count", required: true },
    failedCount: { type: "integer", dataClass: "count", required: true },
    skippedCount: { type: "integer", dataClass: "count", required: true },
    failureLocationCount: { type: "integer", dataClass: "count", required: false },
    failureLocationsTruncated: {
      type: "boolean",
      dataClass: "closed-enum",
      required: false,
    },
    verificationTargetDigest: {
      type: "string",
      dataClass: "digest",
      required: false,
      maxLength: 64,
    },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-verification"],
  proofIds: ["coding-runtime.verification-summarized.emitted-line"],
  releaseImpact: "patch",
});

const CODING_RUNTIME_RUN_SETTLED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.run.settled",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.codingRuntimeOrchestrator.recordRuntimeRunSettled",
  fields: {
    ...CODING_RUNTIME_RUN_FIELDS,
    terminal: { type: "boolean", dataClass: "closed-enum", required: true },
    failureCode: CODING_RUNTIME_FAILURE_CODE_FIELD,
    taskOutcomeStatus: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["cancelled", "failed", "signalled", "succeeded"],
    },
    exitCode: { type: "integer", dataClass: "count", required: false },
    outputByteCount: { type: "integer", dataClass: "count", required: false },
    outputLineCount: { type: "integer", dataClass: "count", required: false },
    outputDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    outputTruncated: { type: "boolean", dataClass: "closed-enum", required: false },
    diagnosticByteCount: { type: "integer", dataClass: "count", required: false },
    diagnosticLineCount: { type: "integer", dataClass: "count", required: false },
    diagnosticDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    diagnosticTruncated: { type: "boolean", dataClass: "closed-enum", required: false },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-run-settlement"],
  proofIds: ["coding-runtime.run.settled.emitted-line"],
  releaseImpact: "patch",
});

const CODING_RUNTIME_RECOVERY_ACKNOWLEDGED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.run.recovery-acknowledged",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.codingRuntimeOrchestrator.acknowledgeRecovery",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    revision: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-recovery-acknowledgement"],
  proofIds: ["coding-runtime.run.recovery-acknowledged.emitted-line"],
  releaseImpact: "patch",
});

const CODING_RUNTIME_DELIVERY_EVIDENCE_UNREADABLE_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.run.delivery-evidence-unreadable",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.codingRuntimeOrchestrator.recordDeliveryEvidenceUnreadable",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    issueNumber: { type: "integer", dataClass: "count", required: false },
    errorClass: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
    ...CODING_RUNTIME_OPTIONAL_DIAGNOSTIC_FIELDS,
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["coding-runtime-delivery-evidence"],
  proofIds: ["coding-runtime.run.delivery-evidence-unreadable.emitted-line"],
  releaseImpact: "patch",
});

const CODING_RUNTIME_DELIVERY_CONTINUED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.run.delivery-continued",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.codingRuntimeOrchestrator.recordDeliveryContinued",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    issueNumber: { type: "integer", dataClass: "count", required: false },
    attempt: { type: "integer", dataClass: "count", required: true },
    max: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-delivery-continuation"],
  proofIds: ["coding-runtime.run.delivery-continued.emitted-line"],
  releaseImpact: "patch",
});

const CODING_RUNTIME_DELIVERY_CONTINUATION_REFUSED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.run.delivery-continuation-refused",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.codingRuntimeOrchestrator.recordDeliveryContinuationRefused",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    issueNumber: { type: "integer", dataClass: "count", required: false },
    attempt: { type: "integer", dataClass: "count", required: true },
    max: { type: "integer", dataClass: "count", required: true },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["dispatch-threw", "dispatch-refused", "evidence-unreadable", "run-superseded"],
    },
    errorClass: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
    ...CODING_RUNTIME_OPTIONAL_DIAGNOSTIC_FIELDS,
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["coding-runtime-delivery-continuation"],
  proofIds: ["coding-runtime.run.delivery-continuation-refused.emitted-line"],
  releaseImpact: "patch",
});

const CODING_RUNTIME_DELIVERY_UNEVIDENCED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.run.delivery-unevidenced",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.codingRuntimeOrchestrator.deliveryTruthfulOutcome",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    issueNumber: { type: "integer", dataClass: "count", required: true },
    hasVerifiedCommit: { type: "boolean", dataClass: "closed-enum", required: true },
    hasDraftDelivery: { type: "boolean", dataClass: "closed-enum", required: true },
    reportedOutcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["succeeded"],
    },
    continuations: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["coding-runtime-delivery-evidence"],
  proofIds: ["coding-runtime.run.delivery-unevidenced.emitted-line"],
  releaseImpact: "patch",
});

const CODING_RUNTIME_RUN_SHUTDOWN_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.run.shutdown",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.codingRuntimeOrchestrator.shutdown",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    stateBefore: CODING_RUNTIME_STATE_FIELD,
    revision: { type: "integer", dataClass: "count", required: true },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["server-shutdown"],
    },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["ended", "refused"],
    },
    failureCode: CODING_RUNTIME_FAILURE_CODE_FIELD,
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-shutdown"],
  proofIds: ["coding-runtime.run.shutdown.emitted-line"],
  releaseImpact: "patch",
});

const CODING_RUNTIME_ISSUE_CONTEXT_ATTACHED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.run.issue-context-attached",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.codingRuntimeOrchestrator.startFresh",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    issueNumber: { type: "integer", dataClass: "count", required: true },
    itemCount: { type: "integer", dataClass: "count", required: true },
    linkedIssueCount: { type: "integer", dataClass: "count", required: true },
    byteCount: { type: "integer", dataClass: "count", required: true },
    issuePurpose: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["context", "delivery"],
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-issue-context"],
  proofIds: ["coding-runtime.run.issue-context-attached.emitted-line"],
  releaseImpact: "patch",
});

function issuePurposeOf(request: CodingWorkbenchRuntimeStartRequest): "context" | "delivery" {
  return request.issuePurpose ?? "delivery";
}

const CODING_RUNTIME_DESCRIPTION_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.description",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.codingRuntimeOrchestrator.logDescriptionEvent",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    remoteDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    event: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "dispatched",
        "coalesced",
        "superseded",
        "blocked",
        "generated",
        "failed",
        "stale",
        "reviewed",
      ],
    },
    generationVersion: { type: "integer", dataClass: "count", required: false },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "generated",
        "partial-generated",
        "fallback-generated",
        "fallback-output-refused",
        "stale-snapshot",
        "expired",
        "authority-expired",
        "model-egress-denied",
        "budget-exhausted",
        "generation-unavailable",
        "interrupted",
        "provider-failed",
      ],
    },
    proposalRetained: { type: "boolean", dataClass: "closed-enum", required: false },
    errorClass: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
    ...CODING_RUNTIME_OPTIONAL_DIAGNOSTIC_FIELDS,
    generationBindingDigest: {
      type: "string",
      dataClass: "digest",
      required: false,
      maxLength: 64,
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-description-generation"],
  proofIds: ["coding-runtime.description.emitted-line"],
  releaseImpact: "patch",
});

function descriptionGenerationBinding(
  snapshot: CodingRuntimeSnapshot,
): WorkbenchDescriptionGenerationBinding {
  return {
    taskDigest: snapshot.taskDigest,
    authorityDigest: snapshot.authorityDigest,
    runtimeBindingDigest: snapshot.bindingDigest,
    deliveryBindingDigest:
      snapshot.draftDelivery === undefined
        ? null
        : sha256Hex(canonicalise(snapshot.draftDelivery.binding)),
  };
}

function descriptionComparisonRefs(
  snapshot: CodingRuntimeSnapshot,
  workspace: ActiveWorkspaceView | undefined,
  fallback: { readonly baseRef: string; readonly headRef: string },
): { readonly baseRef: string; readonly headRef: string } {
  const delivery = snapshot.draftDelivery?.binding;
  if (delivery !== undefined) return { baseRef: delivery.baseRef, headRef: delivery.headRef };
  return {
    baseRef: workspace?.instance.baseBranch ?? fallback.baseRef,
    headRef: workspace?.instance.taskBranch ?? fallback.headRef,
  };
}

function descriptionApplicationTarget(
  snapshot: CodingRuntimeSnapshot,
  workspace: ActiveWorkspaceView | undefined,
  headSha: string,
): WorkbenchDescriptionScope["applicationTarget"] {
  const delivery = snapshot.draftDelivery;
  const pullRequest = delivery?.pullRequest;
  const repository = delivery?.binding.repository;
  if (
    workspace === undefined ||
    pullRequest?.state !== "open" ||
    repository === undefined ||
    pullRequest.headSha !== headSha ||
    pullRequest.repository.toLowerCase() !== repository.toLowerCase()
  ) {
    return undefined;
  }
  return {
    projectId: workspace.binding.activeRoot,
    ownerAndRepo: pullRequest.repository,
    prNumber: pullRequest.number,
  };
}

function sameDescriptionStatusScope(
  status: WorkbenchDescriptionStatus,
  scope: WorkbenchDescriptionScope,
): boolean {
  return (
    status.runId === scope.runId &&
    status.remoteDigest === scope.remoteDigest &&
    status.baseSha === scope.baseSha &&
    status.headSha === scope.headSha &&
    canonicalise(status.generationBinding) === canonicalise(scope.generationBinding)
  );
}

// #3401: the outcome a wired generator reports for one dispatched scope. `snapshotDigest` and
// `draftDigest` are present only for the reasons that produce them (see
// `WORKBENCH_DESCRIPTION_REASON_STATES`); the caller never invents a digest a reason does not use.
export interface WorkbenchDescriptionDispatchOutcome {
  readonly reason: WorkbenchDescriptionReason;
  readonly snapshotDigest?: string;
  readonly draftDigest?: string;
  readonly artifactOutcome?: "complete" | "partial" | "fallback" | "failed";
  readonly proposalId?: string;
}

/**
 * The one seam this orchestrator calls to actually generate a description (#3397 snapshot capture,
 * #3399 description-authority admission and model-egress check, #3398 narrative rendering). It is
 * deliberately NOT part of `CodingRuntimeOrchestratorDeps`: this file owns only the dedup/coalesce/
 * supersede dispatch DECISION, never the generation itself, so a fake in a unit test can stand in
 * for the full chain without this file depending on the model gateway or #3399's routes.
 */
export interface WorkbenchDescriptionDispatcher {
  readonly generate: (
    scope: WorkbenchDescriptionScope,
    signal: AbortSignal,
  ) => Promise<WorkbenchDescriptionDispatchOutcome>;
  readonly hasProposal?: (
    scope: WorkbenchDescriptionScope,
    proposalId: string,
    snapshotDigest: string,
  ) => boolean;
  readonly reviewDraft?: (
    scope: WorkbenchDescriptionScope,
    proposalId: string,
    snapshotDigest: string,
  ) => PrDescriptionDraftPreview | undefined;
}

/** Optional support the terminal-run hook consumes; absent means the feature is not yet wired. */
export interface CodingRuntimeDescriptionSupport {
  readonly jobs: CodingRuntimeDescriptionJobStore;
  readonly dispatcher?: WorkbenchDescriptionDispatcher;
}

/**
 * #3390: names the actual cause of a lost proposal, from data already in hand.
 *
 * A moved scope really is a stale snapshot. An UNCHANGED scope whose hold is simply gone is an
 * expired retention — the artifact lapsed, the change did not move. Reporting the second as
 * `stale-snapshot` told the operator their change had moved when nothing had.
 */
function lostProposalReason(
  status: WorkbenchDescriptionStatus,
  scope: WorkbenchDescriptionScope | undefined,
): "stale-snapshot" | "expired" {
  if (scope === undefined) return "stale-snapshot";
  return sameDescriptionStatusScope(status, scope) ? "expired" : "stale-snapshot";
}

function isRetainedDescriptionProposal(
  support: CodingRuntimeDescriptionSupport | undefined,
  scope: WorkbenchDescriptionScope | undefined,
  status: WorkbenchDescriptionStatus,
  proposalId: string,
  snapshotDigest: string,
): boolean {
  const hasProposal = support?.dispatcher?.hasProposal;
  if (hasProposal === undefined || scope === undefined) return false;
  return (
    sameDescriptionStatusScope(status, scope) && hasProposal(scope, proposalId, snapshotDigest)
  );
}

function matchesDescriptionProposal(
  status: WorkbenchDescriptionStatus | undefined,
  proposalId: string,
  snapshotDigest: string,
): status is WorkbenchDescriptionStatus {
  return status?.proposalId === proposalId && status.snapshotDigest === snapshotDigest;
}

function runtimePauseFailureCode(
  code:
    | "authority-expired"
    | "authority-resolution-failed"
    | "runtime-run-mismatch"
    | "runtime-stopped",
): CodingWorkbenchRuntimeFailureCode {
  if (code === "runtime-run-mismatch") return "authority-resolution-failed";
  // KEIKO-0386: a pause/resume rejected because the runtime was mid-teardown surfaces on the
  // orchestrator as `runtime-failed`, matching how issueApproval's runtime-stopped rejection is
  // projected (see runtimeApprovalIssueFailureCode). Both refuse further operator input on an
  // active that is disposing.
  if (code === "runtime-stopped") return "runtime-failed";
  return code;
}

type CodingRuntimeApprovalIssueFailureCode = Extract<
  CodingRuntimeApprovalIssueResult,
  { readonly ok: false }
>["failureCode"];

function runtimeApprovalIssueFailureCode(
  code: CodingRuntimeApprovalIssueFailureCode,
): CodingWorkbenchRuntimeFailureCode {
  if (code === "approval-activation-failed") return code;
  return code === "runtime-run-mismatch" ? "authority-resolution-failed" : "runtime-failed";
}

type RuntimeStartFailureReason =
  | "history-initialization"
  | CodingRuntimeFailureCode
  | "initial-turn-dispatch"
  | "initial-turn-recovery"
  | "launch-resolution"
  | "manager-exception"
  | "run-mismatch";

type RuntimeLifecycleFailureReason = "failure-redacted" | "runtime-stopped-live";

function runtimeDiagnosticCorrelationId(runId: string): string {
  return isValidCorrelationId(runId) ? runId : UNKNOWN_CORRELATION_ID;
}

function isExactRunRevision(
  snapshot: CodingRuntimeSnapshot | undefined,
  runId: string,
  revision: number,
): snapshot is CodingRuntimeSnapshot {
  return snapshot?.runId === runId && snapshot.revision === revision;
}

function recordRuntimeStartFailure(
  diagnostics: ServerDiagnosticSink | undefined,
  runId: string,
  reason: RuntimeStartFailureReason,
  error?: unknown,
): void {
  const launchReason =
    reason === "launch-resolution" ? launchRejectionDiagnosticReason(error) : undefined;
  const diagnosticCode = `stage=start:reason=${reason}`;
  emitServerDiagnostic(diagnostics, {
    correlationId: runtimeDiagnosticCorrelationId(runId),
    timestamp: new Date().toISOString(),
    operation:
      reason === "history-initialization" ? "coding-runtime.history" : "coding-runtime.start",
    source: "coding-runtime-orchestrator.start",
    ...(error === undefined ? { errorClass: "CodingRuntimeStartFailure" } : describeError(error)),
    message:
      reason === "history-initialization" ? "runtime-history-failed" : "runtime-start-failed",
    code: launchReason === undefined ? diagnosticCode : `${diagnosticCode}:${launchReason}`,
  });
}

function recordRuntimeLifecycleFailure(
  diagnostics: ServerDiagnosticSink | undefined,
  runId: string,
  reason: RuntimeLifecycleFailureReason,
): void {
  emitServerDiagnostic(diagnostics, {
    correlationId: runtimeDiagnosticCorrelationId(runId),
    timestamp: new Date().toISOString(),
    operation: "coding-runtime.lifecycle",
    source: "coding-runtime-orchestrator.ingest",
    errorClass: "CodingRuntimeLifecycleFailure",
    message: "runtime-lifecycle-failed",
    code: `stage=lifecycle:reason=${reason}`,
  });
}

function recordRuntimeStopFailure(
  diagnostics: ServerDiagnosticSink | undefined,
  runId: string,
  error: unknown,
): void {
  emitServerDiagnostic(
    diagnostics,
    serverDiagnosticFromError({
      correlationId: runtimeDiagnosticCorrelationId(runId),
      operation: "coding-runtime.stop",
      source: "coding-runtime-orchestrator.permission-denied",
      error,
      redact: () => "Coding runtime stop failed.",
    }),
  );
}

function recordRuntimeRunStarted(
  activityLog: ServerLogSink | undefined,
  snapshot: CodingRuntimeSnapshot,
  effectiveMode: CodingWorkbenchMode,
  predecessorSelectionReason: PredecessorSelectionReason,
): void {
  activityLog?.write(
    activityLogEvent(
      CODING_RUNTIME_RUN_STARTED_OPERATION,
      { correlationId: runtimeDiagnosticCorrelationId(snapshot.runId) },
      {
        runId: snapshot.runId,
        state: snapshot.state,
        revision: snapshot.revision,
        requestedMode: snapshot.requestedMode,
        effectiveMode,
        runtimeSource: snapshot.runtimeSource,
        modelSource: snapshot.modelSource,
        hasPredecessor: snapshot.predecessorRunId !== undefined,
        predecessorSelectionReason,
        ...(snapshot.predecessorRunId === undefined
          ? {}
          : { predecessorRunId: snapshot.predecessorRunId }),
      },
    ),
  );
}

type ProjectMemoryContextOutcome = "disabled" | "empty" | "failed" | "included" | "unavailable";

function recordRuntimeProjectMemoryContext(
  activityLog: ServerLogSink | undefined,
  runId: string,
  outcome: ProjectMemoryContextOutcome,
  includedMemoryCount = 0,
): void {
  activityLog?.write(
    activityLogEvent(
      CODING_RUNTIME_PROJECT_MEMORY_CONTEXT_OPERATION,
      {
        level: outcome === "failed" ? "warn" : "info",
        correlationId: runtimeDiagnosticCorrelationId(runId),
        ...(outcome === "failed" ? { errorKind: "unavailable" as const } : {}),
      },
      { runId, outcome, includedMemoryCount, scopeKindCount: 2 },
    ),
  );
}

function recordRuntimeProjectMemoryFailure(
  diagnostics: ServerDiagnosticSink | undefined,
  runId: string,
  error: unknown,
): void {
  emitServerDiagnostic(diagnostics, {
    correlationId: runtimeDiagnosticCorrelationId(runId),
    timestamp: new Date().toISOString(),
    operation: "coding-runtime.project-memory",
    source: "coding-runtime-orchestrator.project-memory",
    errorClass: contentFreeErrorClass(error),
    message: "coding-runtime-project-memory-context-failed",
    code: "stage=start:reason=project-memory-context",
  });
}

type PredecessorSelectionReason =
  | "acknowledged-recovery"
  | "failed-successor-lineage"
  | "historical-local-draft"
  | "no-bounded-lineage";

interface PredecessorSelection {
  readonly snapshot: CodingRuntimeSnapshot;
  readonly reason: PredecessorSelectionReason;
}

function eligibleFailedLineageCandidate(
  snapshot: CodingRuntimeSnapshot,
  candidate: CodingRuntimeSnapshot | undefined,
): candidate is CodingRuntimeSnapshot & { readonly predecessorRunId: string } {
  if (candidate === undefined) return false;
  return (
    candidate.state === "failed" &&
    candidate.terminalAt !== undefined &&
    candidate.predecessorRunId !== undefined &&
    sameDraftRecoveryTask(snapshot, candidate)
  );
}

function isAcknowledgedDraftLineage(
  lineage: ReturnType<typeof draftDeliveryLineageRecord>,
): boolean {
  return (
    lineage?.snapshot.state === "recovery-required" &&
    lineage.snapshot.terminalAt !== undefined &&
    lineage.snapshot.recoveryAcknowledgedAt !== undefined
  );
}

function recordRuntimeApprovalWaiting(
  activityLog: ServerLogSink | undefined,
  runId: string,
  revision: number,
  permission: CodingWorkbenchRuntimePendingPermission,
  queuePosition?: number,
): void {
  activityLog?.write(
    activityLogEvent(
      CODING_RUNTIME_APPROVAL_WAITING_OPERATION,
      { correlationId: runtimeDiagnosticCorrelationId(runId) },
      {
        runId,
        revision,
        requestId: permission.requestId,
        permissionKind: permission.kind,
        actionClass: permission.actionClass,
        ...(permission.actionKind === undefined ? {} : { actionKind: permission.actionKind }),
        ...(queuePosition === undefined ? {} : { queuePosition }),
      },
    ),
  );
}

/**
 * The run's own record that a human decision is outstanding, and that it settled. This is what a
 * customer's log has to reconstruct: WHICH decision blocked the run, at which revision it began
 * waiting, and how the wait ended. The governed tool writes the matching
 * `coding-runtime.operator-decision` line from its side; the two share the run's correlation id.
 */
function recordRuntimeOperatorDecision(
  activityLog: ServerLogSink | undefined,
  snapshot: {
    readonly runId: string;
    readonly revision: number;
    readonly state: CodingWorkbenchRuntimeStateName;
  },
  decision: CodingWorkbenchOperatorDecision,
  state: "waiting" | "settled" | "not-admissible",
  outcome?: CodingWorkbenchAuxiliaryStatus,
): void {
  activityLog?.write(
    activityLogEvent(
      CODING_RUNTIME_RUN_OPERATOR_DECISION_OPERATION,
      {
        level: state === "not-admissible" ? "warn" : "info",
        correlationId: runtimeDiagnosticCorrelationId(snapshot.runId),
        ...(state === "not-admissible" ? { errorKind: "permission-denied" as const } : {}),
      },
      {
        runId: snapshot.runId,
        revision: snapshot.revision,
        runState: snapshot.state,
        decision,
        state,
        ...(outcome === undefined ? {} : { outcome }),
      },
    ),
  );
}

/**
 * A runtime event that names a run other than the live one is refused here, and used to be refused
 * silently: the producer saw `invalid-intent` and the log saw nothing, so a tool announcing a
 * decision under a stale or mismatched run id left no trace of why the run never reacted. The line
 * carries the event's kind and both ids — identifiers, not content.
 */
function recordRuntimeEventDropped(
  activityLog: ServerLogSink | undefined,
  event: CodingWorkbenchRuntimeEvent,
  current: CodingRuntimeSnapshot | undefined,
): void {
  activityLog?.write(
    activityLogEvent(
      CODING_RUNTIME_EVENT_DROPPED_OPERATION,
      {
        level: "warn",
        correlationId: runtimeDiagnosticCorrelationId(event.runId),
        errorKind: "conflict",
      },
      {
        eventKind: event.kind,
        eventRunId: event.runId,
        reason: current === undefined ? "no-live-run" : "run-mismatch",
        ...(current === undefined ? {} : { liveRunId: current.runId }),
      },
    ),
  );
}

type CompleteVerificationSummary = CodingWorkbenchRuntimeEvent & {
  readonly kind: "verification-summarized";
  readonly verificationKind: NonNullable<CodingWorkbenchRuntimeEvent["verificationKind"]>;
  readonly verificationStatus: NonNullable<CodingWorkbenchRuntimeEvent["verificationStatus"]>;
  readonly passedCount: number;
  readonly failedCount: number;
  readonly skippedCount: number;
};

function isCompleteVerificationSummary(
  event: CodingWorkbenchRuntimeEvent,
): event is CompleteVerificationSummary {
  if (event.kind !== "verification-summarized") return false;
  return [
    event.verificationKind,
    event.verificationStatus,
    event.passedCount,
    event.failedCount,
    event.skippedCount,
  ].every((value) => value !== undefined);
}

function recordRuntimeVerificationSummary(
  activityLog: ServerLogSink | undefined,
  event: CodingWorkbenchRuntimeEvent,
): void {
  if (!isCompleteVerificationSummary(event)) return;
  activityLog?.write(
    activityLogEvent(
      CODING_RUNTIME_VERIFICATION_SUMMARIZED_OPERATION,
      {
        correlationId: runtimeDiagnosticCorrelationId(event.runId),
        ...(event.verificationStatus === "failed" || event.verificationStatus === "partial"
          ? { errorKind: "validation-failed" as const }
          : {}),
      },
      {
        runId: event.runId,
        verificationEventId: event.eventId,
        verificationKind: event.verificationKind,
        verificationStatus: event.verificationStatus,
        passedCount: event.passedCount,
        failedCount: event.failedCount,
        skippedCount: event.skippedCount,
        ...(event.failureLocationCount === undefined
          ? {}
          : { failureLocationCount: event.failureLocationCount }),
        ...(event.failureLocationsTruncated === undefined
          ? {}
          : { failureLocationsTruncated: event.failureLocationsTruncated }),
        ...(event.verificationTargetDigest === undefined
          ? {}
          : { verificationTargetDigest: event.verificationTargetDigest }),
      },
    ),
  );
}

function recordRuntimeRunSettled(
  activityLog: ServerLogSink | undefined,
  snapshot: CodingRuntimeSnapshot,
  state: CodingWorkbenchRuntimeStateName,
  failureCode?: CodingWorkbenchRuntimeFailureCode,
): void {
  const errorKind = runtimeRunSettledErrorKind(state);
  activityLog?.write(
    activityLogEvent(
      CODING_RUNTIME_RUN_SETTLED_OPERATION,
      {
        correlationId: runtimeDiagnosticCorrelationId(snapshot.runId),
        ...(errorKind === undefined ? {} : { errorKind }),
      },
      {
        runId: snapshot.runId,
        state,
        revision: snapshot.revision,
        requestedMode: snapshot.requestedMode,
        runtimeSource: snapshot.runtimeSource,
        modelSource: snapshot.modelSource,
        terminal: TERMINAL_STATES.has(state),
        ...(failureCode === undefined ? {} : { failureCode }),
        ...runtimeResultLogFields(snapshot.result),
      },
    ),
  );
}

function runtimeRunSettledErrorKind(
  state: CodingWorkbenchRuntimeStateName,
): ActivityLogErrorKind | undefined {
  if (state === "failed" || state === "recovery-required") return "internal";
  if (state === "cancelled" || state === "taken-over") return "cancelled";
  return undefined;
}

function descriptionSettleOp(
  reason: WorkbenchDescriptionReason,
): "generated" | "blocked" | "failed" | "stale" {
  const state = WORKBENCH_DESCRIPTION_REASON_STATES[reason];
  if (state === "failed") return "failed";
  if (state === "stale") return "stale";
  return state === "blocked" ? "blocked" : "generated";
}

type DescriptionLogEvent =
  | "dispatched"
  | "coalesced"
  | "superseded"
  | "blocked"
  | "generated"
  | "failed"
  | "stale"
  | "reviewed";

interface DescriptionLogFields {
  readonly generationVersion?: number;
  readonly reason?: WorkbenchDescriptionReason;
  readonly proposalRetained?: boolean;
  readonly errorClass?: string;
  readonly code?: string;
  readonly gatewayRequestId?: string;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
  readonly partialPromptTokens?: number;
  readonly partialCompletionTokens?: number;
  readonly frames?: readonly string[];
  readonly causeChain?: readonly string[];
}

function descriptionLogErrorKind(
  event: DescriptionLogEvent,
  reason: WorkbenchDescriptionReason | undefined,
): ActivityLogErrorKind | undefined {
  if (event === "superseded" || event === "stale") return "conflict";
  if (event === "failed") return "unavailable";
  if (event !== "blocked") return undefined;
  if (reason === "authority-expired" || reason === "model-egress-denied") {
    return "authority-denied";
  }
  if (reason === "budget-exhausted") return "rate-limited";
  return "unavailable";
}

interface RuntimeResultLogFields {
  readonly taskOutcomeStatus?: "cancelled" | "failed" | "signalled" | "succeeded";
  readonly exitCode?: number;
  readonly outputByteCount?: number;
  readonly outputLineCount?: number;
  readonly outputDigest?: string;
  readonly outputTruncated?: boolean;
  readonly diagnosticByteCount?: number;
  readonly diagnosticLineCount?: number;
  readonly diagnosticDigest?: string;
  readonly diagnosticTruncated?: boolean;
}

function runtimeResultLogFields(
  result: CodingWorkbenchRuntimeResult | undefined,
): RuntimeResultLogFields {
  if (result === undefined) return {};
  return {
    taskOutcomeStatus: result.status,
    ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
    outputByteCount: result.output.byteCount,
    outputLineCount: result.output.lineCount,
    outputDigest: result.output.sha256,
    outputTruncated: result.output.truncated,
    diagnosticByteCount: result.error.byteCount,
    diagnosticLineCount: result.error.lineCount,
    diagnosticDigest: result.error.sha256,
    diagnosticTruncated: result.error.truncated,
  };
}

export type {
  CodingRuntimeApprovalAuthority,
  CodingRuntimeLaunchResolver,
  CodingRuntimeOrchestratorDeps,
  CodingRuntimeOrchestratorResult,
  CodingRuntimeQuestionOperationResult,
} from "./codingRuntimeOrchestratorTypes.js";

interface ApprovalChallenge {
  readonly revision: number;
  readonly expiresAt: number;
  readonly permission: CodingWorkbenchRuntimePendingPermission;
  used: boolean;
}

interface ResumeAdmission {
  readonly current: CodingRuntimeSnapshot;
  readonly requestedMode: CodingWorkbenchMode;
}

const TERMINAL_STATES: ReadonlySet<CodingWorkbenchRuntimeStateName> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "taken-over",
]);

/**
 * Server-side ceiling on how long one approval challenge may live.
 *
 * The lifetime arrives on the runtime child's `permission-requested` event as
 * `permissionRequest.expiresAt`. The child is on the untrusted side of the boundary — it is the
 * process the approval is being asked ABOUT — so it must not choose its own security lifetime. This
 * ceiling is the trusted counterpart of the 5-minute value the generated child-side tool source
 * happens to send today: a child that asks for longer (or a tampered one that asks for a year) is
 * clamped here, before the instant becomes the challenge expiry, the operator-visible deadline on
 * the approval card, and the TTL of the minted approval authority. All three derive from this one
 * clamped instant, so the card can never display a deadline the server does not enforce.
 *
 * It is the contract's one human-decision wait, so the catalog budget, the tool bridge deadline and
 * the plugin client timeout of every tool that waits for an approval derive from the same value
 * (keiko-contracts GOVERNED_TOOL_HUMAN_DECISION_WAIT_MS, PR #3452).
 */
export const MAX_APPROVAL_CHALLENGE_TTL_MS = GOVERNED_TOOL_HUMAN_DECISION_WAIT_MS;
export const MAX_QUEUED_APPROVALS_PER_RUN = 64;

const DIGEST = (value: string): string => createHash("sha256").update(value).digest("hex");
const GRANT_VISIBLE_STATES: ReadonlySet<CodingWorkbenchRuntimeStateName> = new Set([
  "starting",
  "ready",
  "running",
  "awaiting-approval",
  "paused",
  "stopping",
]);

/**
 * Keeps all lifecycle mutation behind one promise tail. This deliberately provides no replay API:
 * after a process restart durable active rows are recovery-required until an operator starts anew.
 */
type DeliveryEvidence =
  | {
      readonly readable: true;
      readonly hasVerifiedCommit: boolean;
      readonly hasDraftDelivery: boolean;
    }
  | { readonly readable: false; readonly error: unknown };

type DeliveryContinuationRefusal =
  "dispatch-threw" | "dispatch-refused" | "evidence-unreadable" | "run-superseded";

// A settlement target is taken only when the delivery evidence could be read and the transition to
// it is legal; anything else asks for recovery.
function isLegalSettlementTarget<T extends { readonly state: CodingWorkbenchRuntimeStateName }>(
  live: CodingRuntimeSnapshot,
  target: T | undefined,
): target is T {
  return target !== undefined && isLegalCodingWorkbenchRuntimeTransition(live.state, target.state);
}

interface DeliveryContinuationFields {
  readonly runId: string;
  readonly issueNumber?: number;
  readonly attempt: number;
  readonly max: number;
}

interface RuntimeDeliveryErrorFields {
  readonly errorClass: string;
  readonly code?: string;
  readonly gatewayRequestId?: string;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
  readonly partialPromptTokens?: number;
  readonly partialCompletionTokens?: number;
  readonly frames?: readonly string[];
  readonly causeChain?: readonly string[];
}

function deliveryContinuationExtra(
  live: CodingRuntimeSnapshot,
  attempt: number,
): DeliveryContinuationFields {
  return {
    runId: live.runId,
    ...(live.issueBinding === undefined ? {} : { issueNumber: live.issueBinding.issueNumber }),
    attempt,
    max: DELIVERY_CONTINUATION_MAX,
  };
}

function runtimeDeliveryErrorFields(error: unknown): RuntimeDeliveryErrorFields {
  const description = describeError(error);
  return {
    errorClass: description.errorClass,
    ...(description.code === undefined ? {} : { code: description.code }),
    ...(description.gatewayRequestId === undefined
      ? {}
      : { gatewayRequestId: description.gatewayRequestId }),
    ...(description.httpStatus === undefined ? {} : { httpStatus: description.httpStatus }),
    ...(description.retryAfterMs === undefined ? {} : { retryAfterMs: description.retryAfterMs }),
    ...(description.partialUsage === undefined
      ? {}
      : {
          partialPromptTokens: description.partialUsage.promptTokens,
          partialCompletionTokens: description.partialUsage.completionTokens,
        }),
    ...(description.frames === undefined ? {} : { frames: description.frames }),
    ...(description.causeChain === undefined ? {} : { causeChain: description.causeChain }),
  };
}

export class CodingRuntimeOrchestrator {
  private tail: Promise<void> = Promise.resolve();
  private activeRunId: string | undefined;
  /**
   * The most recently settled run, kept as the public status until the next run is admitted. A
   * poller or a reloaded window that arrives after settlement still sees the run, its terminal
   * state and its body-free result instead of an `idle` snapshot with no runId (#3257 Wave 0).
   */
  private settledRunId: string | undefined;
  private activeEffectiveMode: CodingWorkbenchMode | undefined;
  // F66: how many delivery continuations each live run has been given (at most
  // DELIVERY_CONTINUATION_MAX); dropped when the run settles.
  private readonly deliveryContinuations = new Map<string, number>();
  /** Last accepted mode retained only for same-process post-terminal description work. */
  private readonly settledEffectiveModes = new Map<string, CodingWorkbenchMode>();
  private readonly approvals = new Map<string, ApprovalChallenge>();
  private readonly queuedApprovals = new Map<string, ApprovalChallenge[]>();
  private readonly operations: CodingRuntimeOperationCoordinator;
  private readonly projection: CodingRuntimeOrchestratorState;
  private readonly now: () => Date;
  private readonly newRunId: () => string;
  private readonly descriptionDispatchAbort = new Map<string, AbortController>();

  constructor(
    private readonly deps: CodingRuntimeOrchestratorDeps,
    private description?: CodingRuntimeDescriptionSupport,
  ) {
    this.now = deps.now ?? ((): Date => new Date());
    // The run id becomes `authority.runId` inside the minted Authority Envelope, whose contract
    // admits only content-free evidence-safe labels; a raw UUID's hex segments are rejected there,
    // so the default identity is the approved `run-<decimal>` projection of the UUID's 128 bits.
    this.newRunId =
      deps.newRunId ??
      ((): string => {
        const decimal = BigInt(`0x${randomUUID().replaceAll("-", "")}`).toString(10);
        return `run-${decimal}`;
      });
    this.projection = new CodingRuntimeOrchestratorState({
      eventHub: deps.eventHub,
      now: this.now,
      pendingPermission: (runId: string): CodingWorkbenchRuntimePendingPermission | undefined =>
        this.approvals.get(runId)?.permission,
      effectiveMode: (runId: string): CodingWorkbenchMode | undefined =>
        this.activeRunId === runId ? this.activeEffectiveMode : undefined,
      ...(deps.contextUsage ? { contextUsage: deps.contextUsage } : {}),
    });
    this.operations = new CodingRuntimeOperationCoordinator({
      current: (): CodingRuntimeSnapshot | undefined => this.current(),
      serial: <T>(work: () => Promise<T>): Promise<T> => this.serial(work),
      advanceRevision: (current, eventKind): CodingRuntimeOrchestratorResult =>
        this.advanceRevision(current, eventKind),
      publicSnapshot: (current): PublicSnapshot => this.publicSnapshotWithDescription(current),
      taskDispatcher: deps.taskDispatcher,
      resumePaused: (current): Promise<CodingRuntimeOrchestratorResult> =>
        this.resumePausedForFollowUp(current),
      settleTask: (runId, outcome): void => {
        this.queueTaskSettlement(runId, outcome);
      },
      questionPort: deps.questionPort,
      manager: deps.manager,
      // [P1] review 3941746512: this seam was never wired, so every question/follow-up transport
      // failure silently fell back to processServerLogSink() instead of the composed ServerLogSink
      // production actually reads.
      activityLog: deps.activityLog,
    });
    // Production bootstrap marks stale active rows recovery-required before composition. Restore only
    // that content-free slot; no adapter turn or productive action is ever replayed.
    this.activeRunId = deps.snapshots.listRecentActive(1)[0]?.runId;
    this.settledRunId =
      this.activeRunId === undefined ? latestSettledRunId(deps.snapshots) : undefined;
  }

  /**
   * A plain "Start coding run" is also the reachable path once the operator has acknowledged a
   * `recovery-required` predecessor: the acknowledgement itself is the human reconciliation
   * ADR-0137 D5 requires before a replacement run may occupy the slot, so `start` auto-detects it
   * and takes the same predecessor-superseding path `retry` uses. Any other occupied slot
   * (running, or an unacknowledged recovery) still fails closed as `active-run-conflict` inside
   * `startFresh`.
   */
  start(input: unknown, correlationId?: string): Promise<CodingRuntimeOrchestratorResult> {
    return this.serial(() =>
      this.startFreshAgainstPredecessor(
        input,
        this.acknowledgedRecoveryPredecessorId(),
        correlationId,
      ),
    );
  }

  private acknowledgedRecoveryPredecessorId(): string | undefined {
    const current = this.current();
    return current?.state === "recovery-required" && current.recoveryAcknowledgedAt !== undefined
      ? current.runId
      : undefined;
  }

  private async startFreshAgainstPredecessor(
    input: unknown,
    predecessorRunId: string | undefined,
    correlationId?: string,
  ): Promise<CodingRuntimeOrchestratorResult> {
    if (predecessorRunId === undefined) return this.startFresh(input, undefined, correlationId);
    this.activeRunId = undefined;
    this.activeEffectiveMode = undefined;
    try {
      return await this.startFresh(input, predecessorRunId, correlationId);
    } finally {
      this.restoreUnsettledRecoverySlot(predecessorRunId);
    }
  }

  retry(
    runId: string,
    input: unknown,
    correlationId?: string,
  ): Promise<CodingRuntimeOrchestratorResult> {
    return this.serial(async () => {
      if (!parseCodingWorkbenchRuntimeStartRequest(input).ok) return this.fail("invalid-intent");
      const prior = this.deps.snapshots.get(runId);
      if (prior?.state !== "recovery-required" || !prior.recoveryAcknowledgedAt)
        return this.fail("invalid-intent");
      if (this.activeRunId !== undefined && this.activeRunId !== runId)
        return this.fail("active-run-conflict");
      return this.startFreshAgainstPredecessor(input, runId, correlationId);
    });
  }

  /**
   * A retry settles its predecessor's recovery row only once the fresh run has actually been
   * admitted to the ledger (`settlePredecessorRecovery`). When the start never gets that far — the
   * authority mint still refuses while the predecessor's process tree is unreaped, or no workspace
   * is bound — the recovery row is untouched and the orchestrator must keep pointing at it.
   * Without this the slot would fall back to the unbound idle projection, and every readiness
   * surface would offer "Ready to start" for a runtime whose every start is rejected.
   */
  private restoreUnsettledRecoverySlot(runId: string): void {
    if (this.activeRunId !== undefined) return;
    const prior = this.deps.snapshots.get(runId);
    if (prior?.state !== "recovery-required" || prior.terminalAt !== undefined) return;
    this.activeRunId = runId;
  }

  /** Finalizes recovery cleanup once — and only once — its successor holds the active slot. */
  private settlePredecessorRecovery(predecessorRunId: string): void {
    const prior = this.deps.snapshots.get(predecessorRunId);
    if (prior?.state !== "recovery-required") return;
    if (prior.terminalAt === undefined)
      this.deps.snapshots.releaseRecoveryForRetry(predecessorRunId, this.now().toISOString());
    this.deps.safeActivityProjection?.purge(predecessorRunId, "stop");
    this.pruneSettled();
  }
  /**
   * Whether a run is live right now — the orchestrator's own notion of `current()`, exposed because
   * the shutdown evidence has to state what it is about to end and must not re-derive "terminal"
   * from a copy of `TERMINAL_STATES` somewhere else.
   */
  hasLiveRun(): boolean {
    return this.current() !== undefined;
  }
  snapshot(): PublicSnapshot {
    const visibleRunId = this.activeRunId ?? this.settledRunId;
    return visibleRunId === undefined
      ? this.projection.idle()
      : this.publicSnapshotWithDescription(this.deps.snapshots.get(visibleRunId));
  }
  status(): PublicSnapshot {
    return this.snapshot();
  }
  getSnapshot(runId: string): PublicSnapshot | undefined {
    const snapshot = this.deps.snapshots.get(runId);
    return snapshot ? this.publicSnapshotWithDescription(snapshot) : undefined;
  }

  submitFollowUp(
    runId: string,
    input: unknown,
    correlationId?: string,
  ): Promise<CodingRuntimeOrchestratorResult> {
    return this.operations.submitFollowUp(runId, input, correlationId);
  }

  listQuestions(
    runId: string,
    input: unknown,
    correlationId?: string,
  ): Promise<CodingRuntimeQuestionOperationResult> {
    return this.operations.listQuestions(runId, input, correlationId);
  }

  answerQuestion(
    runId: string,
    input: unknown,
    correlationId?: string,
  ): Promise<CodingRuntimeOrchestratorResult> {
    return this.operations.answerQuestion(runId, input, correlationId);
  }

  rejectQuestion(
    runId: string,
    input: unknown,
    correlationId?: string,
  ): Promise<CodingRuntimeOrchestratorResult> {
    return this.operations.rejectQuestion(runId, input, correlationId);
  }

  /**
   * Pause halts admission of new tool mutations without terminating the run: it is serialized like
   * stop, and only a running run may be paused. A paused run still accepts inline answer/reject and
   * stop; it never accepts a widening mode change. Resume returns a paused run to running.
   */
  pause(runId: string, input: unknown): Promise<CodingRuntimeOrchestratorResult> {
    return this.serialValue(() => {
      const current = this.current();
      const parsed = parseCodingWorkbenchRuntimeStopRequest(input);
      if (!parsed.ok || parsed.value.requestId !== runId || current?.state !== "running") {
        return this.fail("invalid-intent");
      }
      const paused = this.deps.manager.pause(runId);
      return paused.ok
        ? this.transition(current, "paused")
        : this.fail(runtimePauseFailureCode(paused.failureCode));
    });
  }

  resume(runId: string, input: unknown): Promise<CodingRuntimeOrchestratorResult> {
    return this.serial(() => this.resumeCurrent(runId, input));
  }

  private async resumeCurrent(
    runId: string,
    input: unknown,
  ): Promise<CodingRuntimeOrchestratorResult> {
    const admitted = resumeAdmission(this.current(), runId, input, this.activeEffectiveMode);
    if (admitted === undefined) return this.fail("invalid-intent");
    return this.resumeAdmitted(admitted);
  }

  // A follow-up sent to a paused run resumes it before the replacement task is dispatched (called
  // by the operation coordinator inside the same serial section, so it never re-enters
  // `serial`). The runtime admits tool calls only while running; a replacement dispatched into
  // the pause failed its first call `state-not-admissible` and that failure ended the run (Coding
  // Workbench run 16, 2026-09-10). A pause held for an operator decision keeps its one exit — the
  // decision — exactly as `resumeAdmission` refuses the operator's Resume for it.
  private resumePausedForFollowUp(
    current: CodingRuntimeSnapshot,
  ): Promise<CodingRuntimeOrchestratorResult> {
    if (current.state !== "paused" || current.pauseReason !== undefined) {
      return Promise.resolve(this.fail("invalid-intent"));
    }
    return this.resumeAdmitted({
      current,
      requestedMode: this.activeEffectiveMode ?? current.requestedMode,
    });
  }

  private async resumeAdmitted(
    admitted: ResumeAdmission,
  ): Promise<CodingRuntimeOrchestratorResult> {
    const { runId } = admitted.current;
    const approval = this.approvals.get(runId);
    if (approval !== undefined && approval.expiresAt <= this.now().getTime()) {
      this.approvals.delete(runId);
      return this.stopExpiredPausedRuntime(admitted.current);
    }
    const effectiveMode = admitted.requestedMode;
    this.activeEffectiveMode = effectiveMode;
    const nextState = approval === undefined ? "running" : "awaiting-approval";
    const transitioned = this.transition(admitted.current, nextState);
    if (!transitioned.ok || transitioned.snapshot.state !== nextState) {
      await this.containPausedRuntime(runId);
      return transitioned;
    }
    const resumeFailure = await this.resumeManagerAfterTransition(runId, effectiveMode);
    if (resumeFailure !== undefined) return resumeFailure;
    this.activeEffectiveMode = effectiveModeAfterResume(transitioned, effectiveMode);
    if (approval !== undefined) {
      recordRuntimeApprovalWaiting(
        this.deps.activityLog,
        runId,
        transitioned.snapshot.revision,
        approval.permission,
      );
    }
    return transitioned;
  }

  private async resumeManagerAfterTransition(
    runId: string,
    effectiveMode: CodingWorkbenchMode,
  ): Promise<CodingRuntimeOrchestratorResult | undefined> {
    let resumed: ReturnType<CodingRuntimeManager["resume"]>;
    try {
      resumed = this.deps.manager.resume(runId, effectiveMode);
    } catch {
      return this.stopAfterResumeFailure(runtimePauseFailureCode("authority-resolution-failed"));
    }
    if (!resumed.ok) {
      return this.stopAfterResumeFailure(runtimePauseFailureCode(resumed.failureCode));
    }
    if (resumed.effectiveMode !== undefined && resumed.effectiveMode !== effectiveMode) {
      return this.stopAfterResumeFailure("authority-resolution-failed");
    }
    return undefined;
  }

  private async stopAfterResumeFailure(
    failureCode: CodingWorkbenchRuntimeFailureCode,
  ): Promise<CodingRuntimeOrchestratorResult> {
    const current = this.current();
    return current === undefined
      ? this.fail(failureCode)
      : this.stopAfterIssueFailure(current, failureCode);
  }

  private async containPausedRuntime(runId: string): Promise<void> {
    try {
      await this.deps.manager.stop(runId, "failed");
    } catch {
      // The failed state publish already put the run in recovery-required; containment stays open.
    }
  }

  private async stopExpiredPausedRuntime(
    current: CodingRuntimeSnapshot,
  ): Promise<CodingRuntimeOrchestratorResult> {
    try {
      const stopped = await this.deps.manager.stop(current.runId, "failed");
      return stopped.ok
        ? this.transition(current, "failed", "authority-expired")
        : this.transition(current, "recovery-required", "recovery-required");
    } catch {
      return this.transition(current, "recovery-required", "recovery-required");
    }
  }

  /**
   * Drops every live #2387 research grant for the run (parent and children share the run-bound
   * registry entry) in one revision bump. Bound to the observed revision and a live grant id, so a
   * stale or forged revoke fails closed. Runtime snapshots never carry grant content (#2644).
   */
  revokeResearch(runId: string, input: unknown): Promise<CodingRuntimeOrchestratorResult> {
    return this.serialValue(() => {
      const registry = this.deps.researchGrants;
      const parsed = parseCodingWorkbenchRuntimeResearchRevokeRequest(input);
      const current = this.current();
      if (registry === undefined || !parsed.ok || current?.runId !== runId)
        return this.fail("invalid-intent");
      if (parsed.value.expectedRevision !== current.revision) return this.fail("invalid-intent");
      const live = registry.activeGrants(runId, this.now().getTime());
      if (!live.some((grant) => grant.grantId === parsed.value.grantId))
        return this.fail("invalid-intent");
      registry.invalidateRun(runId);
      return this.advanceRevision(current);
    });
  }

  /**
   * The reviewable facts of the run's live research ask, for the AUTHENTICATED research channel
   * only (#2387 "visible sanitized queries"). Never reaches the unauthenticated status or SSE
   * projection: the host and request line are model-chosen text and those surfaces stay
   * content-free. Returns undefined when nothing is pending, the ask expired, or the run is not
   * the current one — a stale panel can never review an ask that is no longer approvable.
   */
  pendingResearchAsk(runId: string): CodingWorkbenchRuntimePendingResearch | undefined {
    const store = this.deps.pendingResearchApprovals;
    if (store === undefined || this.current()?.runId !== runId) return undefined;
    const pending = store.peek(runId, this.now().getTime());
    if (pending === undefined) return undefined;
    const reviewable = reviewableResearchAsk(pending);
    if (reviewable === undefined) return undefined;
    return {
      requestId: pending.requestId,
      host: reviewable.host,
      requestLine: reviewable.requestLine,
      expiresAt: new Date(pending.expiresAtMs).toISOString(),
    };
  }

  /**
   * The reviewable changeset facts of the approval the operator is being asked to decide, for the
   * AUTHENTICATED approval-review channel only (#2802). A human cannot exercise control over a
   * change they are not shown (ADR-0129 D1), so the path list and the change magnitude reach the
   * card — but never through the unauthenticated status or SSE projection, which stay content-free
   * (#2644), and never a byte of the patch.
   *
   * Fails closed in every stale shape: a run that is not the current one, a run that is no longer
   * awaiting a decision, a challenge that was already consumed or has expired, and a review the
   * manager no longer binds to the live request id.
   */
  pendingApprovalReview(runId: string): CodingWorkbenchRuntimePendingApprovalReview | undefined {
    const current = this.current();
    if (current?.runId !== runId || current.state !== "awaiting-approval") return undefined;
    const challenge = this.approvals.get(runId);
    if (challenge === undefined || challenge.used) return undefined;
    if (challenge.expiresAt <= this.now().getTime()) return undefined;
    return this.deps.manager.pendingApprovalReview(runId, challenge.permission.requestId);
  }

  /**
   * Aggregates live grants for the authenticated research channel. General runtime snapshots are
   * structurally unable to carry this model-selected host content (#2644).
   */
  researchGrant(runId: string): CodingWorkbenchRuntimeResearchGrant | undefined {
    const current = this.current();
    if (current?.runId !== runId || !GRANT_VISIBLE_STATES.has(current.state)) {
      return undefined;
    }
    const registry = this.deps.researchGrants;
    if (registry === undefined) return undefined;
    const grants = registry.activeGrants(runId, this.now().getTime());
    const newest = grants.at(-1);
    if (newest === undefined) return undefined;
    // The UI shows one row per authenticated research channel, so we project the newest live
    // grant exclusively. Previously we unioned domains from every live grant while pairing the
    // newest grant's id, which misrepresented an older grant's authority as belonging to the
    // newest one. #3099 P2 follow-up: also drop the older grants' domains — grant id, domains,
    // and expiry must all describe the SAME underlying grant record (a domain that belongs to
    // a still-live older grant would otherwise be shown with the newest grant's expiry, then
    // "unexpectedly reappear" with the older expiry once the newest grant is pruned).
    const domains = [...new Set(newest.domains)].sort((left, right) => left.localeCompare(right));
    return {
      grantId: newest.grantId,
      domains,
      expiresAt: new Date(newest.expiresAtMs).toISOString(),
    };
  }

  /**
   * The approved skills of the run the operator is watching, for the AUTHENTICATED skills channel
   * (#3417). The projection is the closed, body-free record discovery reports, with the readiness the
   * catalog can tell on its own; the live authority and budget belong to an invocation, not to this
   * view. A run that is not the current one has none.
   */
  approvedSkills(runId: string): SkillDiscoveryResultV1 | undefined {
    return this.current()?.runId === runId ? this.deps.approvedSkills?.() : undefined;
  }

  decideApproval(runId: string, input: unknown): Promise<CodingRuntimeOrchestratorResult> {
    return this.serial(async () => {
      const admitted = this.validateApprovalDecision(runId, input);
      if (admitted === undefined) return this.fail("invalid-intent");
      const { decision, current, challenge, actionKind, request } = admitted;
      challenge.used = true;
      if (decision === "approved") {
        const rejection = await this.issueApprovedAuthority(
          current,
          challenge,
          actionKind,
          request,
        );
        if (rejection !== undefined) return rejection;
      }
      const permissionSettled = await this.resolveRuntimePermission(
        current.runId,
        challenge.permission.requestId,
        decision,
      );
      if (!permissionSettled) return this.stopAfterApprovalFailure(current);
      if (decision === "denied") return this.stopAfterPermissionDenied(current);
      this.approvals.delete(current.runId);
      const running = this.transition(current, "running");
      if (!running.ok) return running;
      const live = this.current();
      return live === undefined ? running : await this.promoteQueuedApproval(live);
    });
  }

  private async resolveRuntimePermission(
    runId: string,
    requestId: string,
    decision: "approved" | "denied",
  ): Promise<boolean> {
    if (this.deps.permissionPort === undefined) return true;
    try {
      return await this.deps.permissionPort.resolve({ runId, requestId, decision });
    } catch {
      return false;
    }
  }

  private validateApprovalDecision(
    runId: string,
    input: unknown,
  ):
    | {
        readonly decision: CodingWorkbenchRuntimeApprovalDecisionRequest["decision"];
        readonly current: CodingRuntimeSnapshot;
        readonly challenge: ApprovalChallenge;
        readonly actionKind: NonNullable<CodingWorkbenchRuntimePendingPermission["actionKind"]>;
        readonly request: CodingWorkbenchRuntimeApprovalDecisionRequest;
      }
    | undefined {
    const parsed = parseCodingWorkbenchRuntimeApprovalDecisionRequest(input);
    const current = this.current();
    const challenge = this.approvals.get(current?.runId ?? "");
    if (
      !parsed.ok ||
      current?.runId !== runId ||
      current.state !== "awaiting-approval" ||
      !this.approvalChallengeMatches(challenge, parsed.value) ||
      !challenge.permission.actionKind
    )
      return undefined;
    return {
      decision: parsed.value.decision,
      current,
      challenge,
      actionKind: challenge.permission.actionKind,
      request: parsed.value,
    };
  }

  private approvalChallengeMatches(
    challenge: ApprovalChallenge | undefined,
    decision: { readonly requestId: string; readonly expectedRevision: number },
  ): challenge is ApprovalChallenge {
    return (
      challenge?.permission.requestId === decision.requestId &&
      !challenge.used &&
      challenge.revision === decision.expectedRevision &&
      challenge.expiresAt > this.now().getTime()
    );
  }

  /** Returns the failure transition when issuing approved authority did not succeed. */
  private async issueApprovedAuthority(
    current: CodingRuntimeSnapshot,
    challenge: ApprovalChallenge,
    actionKind: NonNullable<CodingWorkbenchRuntimePendingPermission["actionKind"]>,
    request: CodingWorkbenchRuntimeApprovalDecisionRequest,
  ): Promise<CodingRuntimeOrchestratorResult | undefined> {
    const principal = this.deps.serverPrincipal();
    if (!principal) return this.stopAfterApprovalFailure(current);
    let issued: CodingRuntimeApprovalIssueResult;
    try {
      issued = this.deps.approvalAuthority.issue({
        runId: current.runId,
        requestId: challenge.permission.requestId,
        actionKind,
        ...(challenge.permission.connectorScopes
          ? { connectorScopes: challenge.permission.connectorScopes }
          : {}),
        approvedByUserId: principal,
        grantScope: request.grantScope ?? "once",
        ...(request.commandTemplateId === undefined
          ? {}
          : { commandTemplateId: request.commandTemplateId }),
        ...(request.safeArgumentClasses === undefined
          ? {}
          : { safeArgumentClasses: request.safeArgumentClasses }),
        ttlMs: Math.max(1, challenge.expiresAt - this.now().getTime()),
        boundRevision: challenge.revision,
      });
    } catch {
      return this.stopAfterApprovalFailure(current);
    }
    if (!issued.ok) {
      return this.stopAfterApprovalFailure(
        current,
        runtimeApprovalIssueFailureCode(issued.failureCode),
      );
    }
    return undefined;
  }

  private async stopAfterIssueFailure(
    current: CodingRuntimeSnapshot,
    failureCode: CodingWorkbenchRuntimeFailureCode = "authority-resolution-failed",
  ): Promise<CodingRuntimeOrchestratorResult> {
    try {
      const stopped = await this.deps.manager.stop(current.runId, "failed");
      return stopped.ok
        ? this.transition(current, "failed", failureCode)
        : this.transition(current, "recovery-required", "recovery-required");
    } catch {
      return this.transition(current, "recovery-required", "recovery-required");
    }
  }

  private async stopAfterPermissionDenied(
    current: CodingRuntimeSnapshot,
  ): Promise<CodingRuntimeOrchestratorResult> {
    const stopping = this.transition(current, "stopping");
    if (!stopping.ok) return stopping;
    this.approvals.delete(current.runId);
    try {
      const stopped = await this.deps.manager.stop(current.runId);
      const live = this.current();
      if (live === undefined) return this.fail("runtime-failed");
      return stopped.ok
        ? this.transition(live, "failed", "revoked")
        : this.transition(live, "recovery-required", "recovery-required");
    } catch (error: unknown) {
      recordRuntimeStopFailure(this.deps.diagnostics, current.runId, error);
      const live = this.current();
      return live === undefined
        ? this.fail("runtime-failed")
        : this.transition(live, "recovery-required", "recovery-required");
    }
  }

  private stopAfterApprovalFailure(
    current: CodingRuntimeSnapshot,
    failureCode: CodingWorkbenchRuntimeFailureCode = "authority-resolution-failed",
  ): Promise<CodingRuntimeOrchestratorResult> {
    const stopping = this.transition(current, "stopping");
    if (!stopping.ok) return Promise.resolve(stopping);
    this.approvals.delete(current.runId);
    this.queuedApprovals.delete(current.runId);
    const live = this.current();
    return live === undefined
      ? Promise.resolve(this.fail("runtime-failed"))
      : this.stopAfterIssueFailure(live, failureCode);
  }

  stop(runId: string, input: unknown): Promise<CodingRuntimeOrchestratorResult> {
    return this.end("stop", runId, input);
  }
  takeover(runId: string, input: unknown): Promise<CodingRuntimeOrchestratorResult> {
    return this.end("takeover", runId, input);
  }
  acknowledgeRecovery(runId: string, input: unknown): Promise<CodingRuntimeOrchestratorResult> {
    return this.serialValue(() => {
      const parsed = parseCodingWorkbenchRuntimeRecoveryAcknowledgementRequest(input);
      const current = this.current();
      if (
        !parsed.ok ||
        current?.runId !== runId ||
        parsed.value.requestId !== runId ||
        current.state !== "recovery-required"
      )
        return this.fail("invalid-intent");
      const acknowledged = this.deps.snapshots.acknowledgeRecovery(
        current.runId,
        this.now().toISOString(),
      );
      this.deps.activityLog?.write(
        activityLogEvent(
          CODING_RUNTIME_RECOVERY_ACKNOWLEDGED_OPERATION,
          { correlationId: runtimeDiagnosticCorrelationId(acknowledged.runId) },
          { runId: acknowledged.runId, revision: acknowledged.revision },
        ),
      );
      return { ok: true, snapshot: this.publicSnapshotWithDescription(acknowledged) };
    });
  }

  /** Accepts only manager events for the current slot and projects no event content into durable state. */
  ingest(event: CodingWorkbenchRuntimeEvent): Promise<CodingRuntimeOrchestratorResult> {
    return this.serial(() => this.ingestCurrent(event));
  }

  private async ingestCurrent(
    event: CodingWorkbenchRuntimeEvent,
  ): Promise<CodingRuntimeOrchestratorResult> {
    const current = this.current();
    if (event.runId !== current?.runId) {
      recordRuntimeEventDropped(this.deps.activityLog, event, current);
      return this.fail("invalid-intent");
    }
    if (event.kind === "failure-redacted") {
      recordRuntimeLifecycleFailure(this.deps.diagnostics, current.runId, "failure-redacted");
      return this.stopAfterIssueFailure(current, "runtime-failed");
    }
    const paused = await this.ingestPausedEvent(current, event);
    return paused ?? this.ingestActiveEvent(current, event);
  }

  private async ingestPausedEvent(
    current: CodingRuntimeSnapshot,
    event: CodingWorkbenchRuntimeEvent,
  ): Promise<CodingRuntimeOrchestratorResult | undefined> {
    const terminal = event.kind === "runtime-stopped" || event.kind === "failure-redacted";
    if (current.state !== "paused" || terminal) return undefined;
    // A run paused FOR a decision is resumed by that decision settling, so this one event is the
    // exception to a paused run absorbing its runtime events.
    if (event.kind === "operator-decision") return this.ingestOperatorDecision(current, event);
    if (event.kind === "permission-requested") {
      const challenge = this.approvalChallenge(current, event);
      if (challenge === undefined) return this.fail("invalid-intent");
      if (this.approvals.has(current.runId)) return await this.queueApproval(current, challenge);
      this.approvals.set(current.runId, challenge);
    }
    return { ok: true, snapshot: this.publicSnapshotWithDescription(current) };
  }

  /**
   * A governed tool met a decision only a local human can make and is waiting in place for it. The
   * run says so: `running` -> `paused` naming the decision, and back to `running` the moment the
   * wait settles — whichever way it settled, because the tool then either retries the effect or
   * hands the model its refusal, and in both cases the run is no longer waiting on a person.
   *
   * This is deliberately NOT the Authority Envelope approval plane. The decision it carries is a
   * hard, mode-independent boundary (ADR-0147 package-script trust), recorded on the workspace's own
   * trust surface and minting no action authority, so routing it through `awaiting-approval` would
   * mint the wrong artifact and, in `governed-assist`, collapse that mode's separate per-command
   * approval into a workspace trust grant.
   *
   * Every other run state absorbs the event unchanged: a run already stopping, settling or awaiting
   * an approval is not a run that can start waiting on this, and forcing a transition there would
   * either be refused as illegal or overwrite a state the operator is already acting on.
   */
  private ingestOperatorDecision(
    current: CodingRuntimeSnapshot,
    event: CodingWorkbenchRuntimeEvent,
  ): CodingRuntimeOrchestratorResult {
    const decision = event.operatorDecision;
    if (decision === undefined) return this.fail("invalid-intent");
    const open = event.auxiliaryOutcome === undefined;
    // Both lines record the snapshot that BEGAN or ENDED the wait — the post-transition one — so the
    // log's revision and run state are the ones the store now holds (CodeRabbit review, 2026-09-10).
    if (open && current.state === "running") {
      const paused = this.transition(current, "paused", undefined, decision);
      if (paused.ok) {
        recordRuntimeOperatorDecision(
          this.deps.activityLog,
          { ...paused.snapshot, runId: current.runId },
          decision,
          "waiting",
        );
      }
      return paused;
    }
    if (!open && current.state === "paused" && current.pauseReason === decision) {
      const resumed = this.transition(current, "running");
      if (resumed.ok) {
        recordRuntimeOperatorDecision(
          this.deps.activityLog,
          { ...resumed.snapshot, runId: current.runId },
          decision,
          "settled",
          event.auxiliaryOutcome,
        );
      }
      return resumed;
    }
    recordRuntimeOperatorDecision(
      this.deps.activityLog,
      current,
      decision,
      "not-admissible",
      event.auxiliaryOutcome,
    );
    return { ok: true, snapshot: this.publicSnapshotWithDescription(current) };
  }

  private async ingestActiveEvent(
    current: CodingRuntimeSnapshot,
    event: CodingWorkbenchRuntimeEvent,
  ): Promise<CodingRuntimeOrchestratorResult> {
    if (event.kind === "permission-requested") {
      return await this.ingestPermissionRequested(current, event);
    }
    if (event.kind === "operator-decision") return this.ingestOperatorDecision(current, event);
    if (event.kind === "task-submitted") return this.ingestTaskSubmitted(current);
    if (event.kind === "runtime-stopped") return this.ingestRuntimeStopped(current);
    recordRuntimeVerificationSummary(this.deps.activityLog, event);
    return this.publishOrRecover(current, event.kind, auxiliaryEventFacts(event));
  }

  /**
   * The runtime process is gone. `cancelled` is legal only from the states an operator-initiated
   * stop passes through — `stopping` here; from every other live state this ingest rejects it, so
   * it used to fail closed SILENTLY — no transition, no evidence record, no SSE frame — and a dead
   * runtime kept presenting as `running` until the separate task-settlement wait gave up
   * (OPEN_CODE_MAX_TURN_WAIT_MS, 30 minutes). A runtime that exits under a live run terminates that
   * run, the same terminal projection a non-zero exit already produces through `failure-redacted`;
   * the exit code itself reaches the operator diagnostic sink, not this content-free lifecycle
   * projection.
   *
   * The shared LEGAL_TRANSITIONS contract also legalizes `starting` -> `cancelled` (KEIKO-0618),
   * but that edge is not reachable through this ingest path: `serial()`/`startFresh()` serialize
   * every operation on `this.tail`, so `start()` has already advanced `current.state` past
   * `starting` before any externally-ingested event can reach `ingestRuntimeStopped`. That edge is
   * genuinely used elsewhere — runtimeAuthorityService.ts's `REAP_SETTLEMENT_TRANSITIONS["starting"]`,
   * reached via `confirmReaped` when a Codex/OpenCode sidecar fails its startup handshake — so do
   * not remove it from the shared contract on the strength of this call site alone.
   */
  private ingestRuntimeStopped(current: CodingRuntimeSnapshot): CodingRuntimeOrchestratorResult {
    if (isLegalCodingWorkbenchRuntimeTransition(current.state, "cancelled")) {
      return this.transition(current, "cancelled");
    }
    recordRuntimeLifecycleFailure(this.deps.diagnostics, current.runId, "runtime-stopped-live");
    return this.transition(current, "failed", "runtime-failed");
  }

  private async ingestPermissionRequested(
    current: CodingRuntimeSnapshot,
    event: CodingWorkbenchRuntimeEvent,
  ): Promise<CodingRuntimeOrchestratorResult> {
    const challenge = this.approvalChallenge(current, event);
    if (challenge === undefined) return this.fail("invalid-intent");
    if (current.state === "awaiting-approval") {
      return await this.queueApproval(current, challenge);
    }
    this.approvals.set(current.runId, challenge);
    const next = this.transition(current, "awaiting-approval");
    if (!next.ok) {
      this.approvals.delete(current.runId);
    } else {
      recordRuntimeApprovalWaiting(
        this.deps.activityLog,
        current.runId,
        next.snapshot.revision,
        challenge.permission,
      );
    }
    return next;
  }

  private approvalChallenge(
    current: CodingRuntimeSnapshot,
    event: CodingWorkbenchRuntimeEvent,
  ): ApprovalChallenge | undefined {
    if (!event.permissionRequest?.actionKind) return undefined;
    const requested = Date.parse(event.permissionRequest.expiresAt);
    const nowMs = this.now().getTime();
    if (!Number.isFinite(requested) || requested <= nowMs) return undefined;
    // Clamp the child-declared lifetime to the server ceiling and re-publish the clamped instant on
    // the permission itself, so the challenge expiry, the operator-visible deadline, and the minted
    // approval TTL are one value the server owns (MAX_APPROVAL_CHALLENGE_TTL_MS).
    const expiresAt = Math.min(requested, nowMs + MAX_APPROVAL_CHALLENGE_TTL_MS);
    return {
      revision: current.revision + 1,
      expiresAt,
      permission: { ...event.permissionRequest, expiresAt: new Date(expiresAt).toISOString() },
      used: false,
    };
  }

  private async queueApproval(
    current: CodingRuntimeSnapshot,
    challenge: ApprovalChallenge,
  ): Promise<CodingRuntimeOrchestratorResult> {
    if (!this.approvals.has(current.runId)) {
      return this.stopAfterApprovalFailure(current);
    }
    const queued = this.queuedApprovals.get(current.runId) ?? [];
    const requestId = challenge.permission.requestId;
    if (
      this.approvals.get(current.runId)?.permission.requestId === requestId ||
      queued.some((candidate) => candidate.permission.requestId === requestId)
    ) {
      return this.fail("invalid-intent");
    }
    if (queued.length >= MAX_QUEUED_APPROVALS_PER_RUN) {
      return this.stopAfterApprovalFailure(current);
    }
    queued.push(challenge);
    this.queuedApprovals.set(current.runId, queued);
    recordRuntimeApprovalWaiting(
      this.deps.activityLog,
      current.runId,
      current.revision,
      challenge.permission,
      queued.length,
    );
    return { ok: true, snapshot: this.publicSnapshotWithDescription(current) };
  }

  private async promoteQueuedApproval(
    current: CodingRuntimeSnapshot,
  ): Promise<CodingRuntimeOrchestratorResult> {
    const queued = this.queuedApprovals.get(current.runId);
    if (queued === undefined) {
      this.queuedApprovals.delete(current.runId);
      return { ok: true, snapshot: this.publicSnapshotWithDescription(current) };
    }
    const challenge = queued.shift();
    if (challenge === undefined) {
      this.queuedApprovals.delete(current.runId);
      return { ok: true, snapshot: this.publicSnapshotWithDescription(current) };
    }
    if (challenge.expiresAt <= this.now().getTime()) {
      this.queuedApprovals.delete(current.runId);
      return this.stopAfterApprovalFailure(current, "authority-expired");
    }
    if (queued.length === 0) this.queuedApprovals.delete(current.runId);
    const promoted = { ...challenge, revision: current.revision + 1 };
    this.approvals.set(current.runId, promoted);
    const waiting = this.transition(current, "awaiting-approval");
    if (!waiting.ok) this.approvals.delete(current.runId);
    else
      recordRuntimeApprovalWaiting(
        this.deps.activityLog,
        current.runId,
        waiting.snapshot.revision,
        promoted.permission,
      );
    return waiting;
  }

  private ingestTaskSubmitted(current: CodingRuntimeSnapshot): CodingRuntimeOrchestratorResult {
    if (current.state !== "running") return this.transition(current, "running");
    return this.publishOrRecover(current, "task-submitted");
  }

  private queueTaskSettlement(runId: string, outcome: CodingRuntimeTaskOutcome): void {
    const settlement = this.serial(() => this.settleTask(runId, outcome));
    void settlement.then(
      (): void => undefined,
      (): void => this.deps.safeActivityProjection?.markUnavailable(runId),
    );
  }

  private async settleTask(runId: string, outcome: CodingRuntimeTaskOutcome): Promise<void> {
    const current = this.current();
    if (current?.runId !== runId) return;
    if (await this.continueForDelivery(current, outcome)) return;
    this.captureHistory(runId);
    const stopped = await this.stopForSettlement(runId, outcome);
    const live = this.current();
    if (live?.runId !== runId) return;
    const terminalResult = this.deps.manager.result(runId);
    if (!stopped || terminalResult?.status !== outcome) {
      this.transition(live, "recovery-required", "recovery-required");
      return;
    }
    const target = this.deliveryTruthfulOutcome(live, taskOutcomeState(outcome));
    if (!isLegalSettlementTarget(live, target)) {
      this.transition(live, "recovery-required", "recovery-required");
      return;
    }
    this.transition(live, target.state, target.failureCode);
  }

  /**
   * Durable delivery evidence: the store's last successful commit, or a delivered draft phase. The
   * commit reader fails closed on an oversized, malformed or foreign record by throwing; that throw is
   * an answer here ("unreadable"), never an escape from settlement: a settlement that threw before
   * stopping the runtime would leave it running with no recovery transition (owner review, PR #3452).
   */
  private deliveryEvidence(live: CodingRuntimeSnapshot): DeliveryEvidence {
    let hasVerifiedCommit: boolean;
    try {
      hasVerifiedCommit =
        this.deps.snapshots.getLastSuccessfulVerifiedCommit?.(live.runId) !== undefined;
    } catch (error) {
      return { readable: false, error };
    }
    return {
      readable: true,
      hasVerifiedCommit,
      hasDraftDelivery:
        live.draftDelivery !== undefined && isDeliveredDraftDeliveryPhase(live.draftDelivery.phase),
    };
  }

  private recordDeliveryEvidenceUnreadable(live: CodingRuntimeSnapshot, error: unknown): void {
    this.deps.activityLog?.write(
      activityLogEvent(
        CODING_RUNTIME_DELIVERY_EVIDENCE_UNREADABLE_OPERATION,
        {
          level: "warn",
          correlationId: runtimeDiagnosticCorrelationId(live.runId),
          errorKind: "unavailable",
        },
        {
          runId: live.runId,
          ...(live.issueBinding === undefined
            ? {}
            : { issueNumber: live.issueBinding.issueNumber }),
          ...runtimeDeliveryErrorFields(error),
        },
      ),
    );
  }

  // The one-based attempt a finished turn may continue with, or undefined when it settles: only a
  // turn that ended normally, in an issue-bound run under Full access, with continuation budget left.
  // Every other run settles exactly as before; `continueForDelivery` then asks whether delivery is
  // already evidenced.
  private deliveryContinuationAttempt(
    live: CodingRuntimeSnapshot,
    outcome: CodingRuntimeTaskOutcome,
  ): number | undefined {
    if (outcome !== "succeeded" || live.issueBinding === undefined) return undefined;
    if (this.activeRunId !== live.runId || this.activeEffectiveMode !== "autonomous-delivery")
      return undefined;
    const attempt = (this.deliveryContinuations.get(live.runId) ?? 0) + 1;
    return attempt > DELIVERY_CONTINUATION_MAX ? undefined : attempt;
  }

  // Dispatches the continuation into the live session in place of stopping it. A refused or failed
  // dispatch falls back to settlement, so a continuation can never keep a run alive on its own.
  private async continueForDelivery(
    live: CodingRuntimeSnapshot,
    outcome: CodingRuntimeTaskOutcome,
  ): Promise<boolean> {
    const attempt = this.deliveryContinuationAttempt(live, outcome);
    if (attempt === undefined) return false;
    const correlationId = runtimeDiagnosticCorrelationId(live.runId);
    const evidence = this.deliveryEvidence(live);
    if (!evidence.readable) {
      this.recordDeliveryContinuationRefused(
        live,
        attempt,
        correlationId,
        "evidence-unreadable",
        evidence.error,
      );
      return false;
    }
    if (evidence.hasVerifiedCommit || evidence.hasDraftDelivery) return false;
    const dispatched = await this.dispatchDeliveryContinuation(live, attempt, correlationId);
    if (dispatched === undefined) return false;
    // An operator's stop or takeover is not serialized with settlement: it has to stay immediate
    // even while a dispatch hangs. The run may therefore have ended or moved while this continuation
    // was dispatched; it is then abandoned, never recorded against a superseded revision, and the
    // stop or takeover owns the run's settlement (owner review, PR #3452).
    if (this.continuationSuperseded(live)) {
      this.recordDeliveryContinuationRefused(live, attempt, correlationId, "run-superseded");
      return true;
    }
    this.deliveryContinuations.set(live.runId, attempt);
    this.recordDeliveryContinued(live, attempt, correlationId);
    this.operations.observeContinuation(live.runId, dispatched.completion);
    this.advanceRevision(live, "task-submitted");
    return true;
  }

  private async dispatchDeliveryContinuation(
    live: CodingRuntimeSnapshot,
    attempt: number,
    correlationId: string,
  ): Promise<Extract<CodingRuntimeTaskDispatchResult, { readonly ok: true }> | undefined> {
    let dispatched: CodingRuntimeTaskDispatchResult;
    try {
      dispatched = await this.deps.taskDispatcher.dispatch({
        runId: live.runId,
        requestId: `delivery-continuation-${String(attempt)}`,
        expectedRevision: live.revision,
        taskIntent: DELIVERY_CONTINUATION_INTENT,
      });
    } catch (error) {
      this.recordDeliveryContinuationRefused(live, attempt, correlationId, "dispatch-threw", error);
      return undefined;
    }
    if (!dispatched.ok) {
      this.recordDeliveryContinuationRefused(live, attempt, correlationId, "dispatch-refused");
      return undefined;
    }
    return dispatched;
  }

  private continuationSuperseded(live: CodingRuntimeSnapshot): boolean {
    const current = this.current();
    if (current === undefined) return true;
    return (
      this.activeRunId !== live.runId ||
      current.runId !== live.runId ||
      current.revision !== live.revision
    );
  }

  private recordDeliveryContinued(
    live: CodingRuntimeSnapshot,
    attempt: number,
    correlationId: string,
  ): void {
    this.deps.activityLog?.write(
      activityLogEvent(
        CODING_RUNTIME_DELIVERY_CONTINUED_OPERATION,
        { level: "info", correlationId },
        deliveryContinuationExtra(live, attempt),
      ),
    );
  }

  // Every refusal names its reason; one that follows a thrown error also carries its errorKind and
  // body-free frames, like every other caught failure in this file (AGENTS.md §8).
  private recordDeliveryContinuationRefused(
    live: CodingRuntimeSnapshot,
    attempt: number,
    correlationId: string,
    reason: DeliveryContinuationRefusal,
    error?: unknown,
  ): void {
    this.deps.activityLog?.write(
      activityLogEvent(
        CODING_RUNTIME_DELIVERY_CONTINUATION_REFUSED_OPERATION,
        {
          level: "warn",
          correlationId,
          errorKind: reason === "run-superseded" ? "conflict" : "unavailable",
        },
        {
          ...deliveryContinuationExtra(live, attempt),
          reason,
          ...(error === undefined ? {} : runtimeDeliveryErrorFields(error)),
        },
      ),
    );
  }

  /**
   * A run started from an accepted GitHub issue is the product's delivery flow: the issue binds the
   * task branch, the base ref and the pull request the work is delivered through. Such a run may not
   * be reported as `succeeded` on the strength of the model having stopped emitting tool calls —
   * which is all `taskOutcomeState` knows. Run 10 of the Coding Workbench engagement (2026-09-10)
   * ended exactly that way: its verification was refused, it wrote files into the task workspace and
   * stopped, and the Workbench showed a green success for a run that had verified, committed, pushed
   * and delivered nothing.
   *
   * Delivery evidence is the durable server-owned kind: a verified-commit receipt, or a draft
   * delivery record. Either is enough — a run that committed but could not push has delivered
   * something and says so through its own facts. Neither means the terminal state is
   * `delivery-not-evidenced`, and the operator sees a truthful failure instead of a false success.
   *
   * Deliberately scoped to issue-bound runs: an ad-hoc task ("explain this module") legitimately
   * ends with no commit, and inferring delivery intent from free text would turn honest successes
   * into false failures.
   */
  private deliveryTruthfulOutcome(
    live: CodingRuntimeSnapshot,
    target: {
      readonly state: "failed" | "succeeded";
      readonly failureCode?: "runtime-failed" | undefined;
    },
  ):
    | {
        readonly state: "failed" | "succeeded";
        readonly failureCode?: CodingWorkbenchRuntimeFailureCode | undefined;
      }
    | undefined {
    if (target.state !== "succeeded" || live.issueBinding === undefined) return target;
    // Presence is not delivery. A `verifiedCommitResult` is persisted for every proposal outcome,
    // `verification-failed` and `blocked` included, and a `draftDelivery` record exists as soon as a
    // push is PROPOSED. Reading either as evidence would re-admit the false success this method
    // exists to close (owner review, PR #3452), so both sides ask the question that has a real
    // answer: the store's own last SUCCESSFUL commit, and a phase the contract classifies as
    // delivered.
    // Evidence that cannot be read settles nothing on a guess: the run asks for recovery instead.
    const evidence = this.deliveryEvidence(live);
    if (!evidence.readable) {
      this.recordDeliveryEvidenceUnreadable(live, evidence.error);
      return undefined;
    }
    const { hasVerifiedCommit, hasDraftDelivery } = evidence;
    if (hasVerifiedCommit || hasDraftDelivery) return target;
    this.deps.activityLog?.write(
      activityLogEvent(
        CODING_RUNTIME_DELIVERY_UNEVIDENCED_OPERATION,
        {
          level: "warn",
          correlationId: runtimeDiagnosticCorrelationId(live.runId),
          errorKind: "validation-failed",
        },
        {
          runId: live.runId,
          issueNumber: live.issueBinding.issueNumber,
          hasVerifiedCommit,
          hasDraftDelivery,
          reportedOutcome: "succeeded",
          continuations: this.deliveryContinuations.get(live.runId) ?? 0,
        },
      ),
    );
    return { state: "failed", failureCode: "delivery-not-evidenced" };
  }

  private async stopForSettlement(
    runId: string,
    outcome: CodingRuntimeTaskOutcome,
  ): Promise<boolean> {
    try {
      return (await this.deps.manager.stop(runId, outcome)).ok;
    } catch {
      return false;
    }
  }

  private publishOrRecover(
    current: CodingRuntimeSnapshot,
    eventKind: CodingWorkbenchRuntimeEvent["kind"],
    auxiliary?: AuxiliaryEventFacts,
  ): CodingRuntimeOrchestratorResult {
    return this.projection.publish(current, eventKind, auxiliary)
      ? { ok: true, snapshot: this.publicSnapshotWithDescription(current) }
      : this.transition(current, "recovery-required", "recovery-required");
  }

  /** Startup containment: persisted nonterminal executions are never replayed. */
  startupReconcile(): Promise<void> {
    return this.serial(() => {
      this.startupReconcileNow();
      return Promise.resolve();
    });
  }

  /** Synchronous bootstrap boundary used before the HTTP dependency graph becomes observable. */
  startupReconcileNow(): void {
    this.deps.snapshots.markNonterminalRecoveryRequired(this.now().toISOString());
    // #3401: a description attempt still `dispatched` from a prior process has no live promise to
    // resume — it is reconciled to a closed blocked status, never silently re-run or lost.
    this.reconcileInterruptedDescriptionJobs(this.description);
    for (const snapshot of this.deps.snapshots
      .listRecentActive(1)
      .filter(({ state }) => state === "recovery-required")) {
      this.deps.evidence.observe(snapshot.runId, {
        kind: "state-transition",
        state: "recovery-required",
        failureCode: "recovery-required",
      });
      this.deps.evidence.settle({
        runId: snapshot.runId,
        state: "recovery-required",
        revision: snapshot.revision,
        settledAt: snapshot.updatedAt,
        failureCode: "recovery-required",
        taskDigest: snapshot.taskDigest,
        workspaceDigest: snapshot.workspaceDigest,
        operatorDigest: snapshot.operatorDigest,
        authorityDigest: snapshot.authorityDigest,
        bindingDigest: snapshot.bindingDigest,
        provenanceDigest: snapshot.provenanceDigest,
      });
      this.deps.safeActivityProjection?.markUnavailable(snapshot.runId);
    }
    this.pruneSettled();
    this.activeRunId = this.deps.snapshots.listRecentActive(1)[0]?.runId;
    this.settledRunId =
      this.activeRunId === undefined ? latestSettledRunId(this.deps.snapshots) : undefined;
  }
  /**
   * Ends the live run because the SERVER is going away, not because an operator asked. Both take the
   * same stop path, so the settled evidence is identical — `state: "cancelled"`, `reason: "stop"` —
   * and a customer log could not tell "the user pressed Stop" from "the machine shut the app down"
   * (run 9, 2026-09-10). This names the cause under the RUN's own correlation id, so
   * `keiko support analyze --correlation-id <run>` reads it alongside that run's terminal line.
   *
   * The line is written AFTER the attempt and reports what the attempt achieved. Writing it before
   * asserted an outcome the code had not reached: `end()` refuses outright for a run in
   * `recovery-required` (no transition, no terminal line), so a shutdown then left behind a cause
   * for an ending that never happened, and the troubleshooting entry told the operator to read it as
   * confirmation (owner review, PR #3452).
   */
  async shutdown(correlationId?: string): Promise<CodingRuntimeOrchestratorResult> {
    const current = this.current();
    if (current === undefined) {
      this.deps.safeActivityProjection?.purgeAll("shutdown", correlationId);
      return { ok: true, snapshot: this.projection.idle() };
    }
    const result = await this.end("stop", current.runId, { requestId: current.runId });
    this.deps.activityLog?.write(
      activityLogEvent(
        CODING_RUNTIME_RUN_SHUTDOWN_OPERATION,
        {
          level: "warn",
          correlationId: runtimeDiagnosticCorrelationId(current.runId),
          ...(result.ok ? {} : { errorKind: "conflict" as const }),
        },
        {
          runId: current.runId,
          stateBefore: current.state,
          revision: current.revision,
          reason: "server-shutdown",
          // What the shutdown actually achieved for this run: it ended, or the orchestrator
          // refused to end it and the run keeps whatever state it had.
          outcome: result.ok ? "ended" : "refused",
          ...(result.ok ? {} : { failureCode: result.failureCode }),
        },
      ),
    );
    return result;
  }

  // A proof that could not run (IDENTITY_PROOF_FAILED, logged at its source) is an authority the
  // start cannot resolve right now — fail closed, never launch against an unproven workspace.
  private activeWorkspaceOrUndefined(): ActiveWorkspaceView | undefined {
    try {
      return this.deps.workspaceLifecycle.getActive();
    } catch (error) {
      if (isIdentityProofFailure(error)) return undefined;
      throw error;
    }
  }

  public getHistory(): CodingRuntimeHistory | undefined {
    return this.deps.history;
  }

  private async startFresh(
    input: unknown,
    predecessorRunId?: string,
    correlationId?: string,
  ): Promise<CodingRuntimeOrchestratorResult> {
    const parsed = parseCodingWorkbenchRuntimeStartRequest(input);
    if (!parsed.ok || this.activeRunId)
      return this.fail(parsed.ok ? "active-run-conflict" : "invalid-intent");
    // A proof that could not run (IDENTITY_PROOF_FAILED, logged at its source) is an authority the
    // start cannot resolve right now — fail closed, never launch against an unproven workspace.
    const scope = this.historyStartScope(parsed.value);
    if (scope === undefined) return this.fail("authority-resolution-failed");
    const { active, principal } = scope;
    let { request } = scope;
    const runId = this.newRunId();
    const issue = await this.admitIssue(request, active, runId, predecessorRunId);
    if (!issue.ok) return { ...issue, runId };
    request = this.requestWithContextPurpose(request, issue.contextBinding);
    const resolved = await this.resolveLaunch(
      request,
      active,
      principal,
      runId,
      issue.binding,
      correlationId,
    );
    if (!resolved.ok) return { ...resolved, runId };
    const launch = resolved.launch;
    const initialSnapshot = this.buildStartSnapshot(
      request,
      active,
      principal,
      runId,
      launch,
      predecessorRunId,
      { issueBinding: issue.binding, issueContextBinding: issue.contextBinding },
    );
    const selection = this.selectStartPredecessor(initialSnapshot, predecessorRunId);
    const snapshot = selection.snapshot;
    this.deps.snapshots.create(snapshot);
    this.activateStartedRun(runId, launch, selection);
    this.recordIssueAdmission(request, runId, issue.attachment);
    if (predecessorRunId !== undefined) this.settlePredecessorRecovery(predecessorRunId);
    this.projection.publish(snapshot);
    if (!this.beginHistory(request, active, runId))
      return this.transitionActive("failed", "runtime-failed");
    const started = await this.startManagedRuntime(request, active, runId, launch);
    if (started !== undefined) return started;
    return this.runInitialTurn(request, active, runId, issue.attachment);
  }

  private activateStartedRun(
    runId: string,
    launch: ReturnType<CodingRuntimeLaunchResolver["resolve"]>,
    selection: PredecessorSelection,
  ): void {
    this.activeRunId = runId;
    this.settledRunId = undefined;
    this.activeEffectiveMode = launch.effectiveMode;
    recordRuntimeRunStarted(
      this.deps.activityLog,
      selection.snapshot,
      launch.effectiveMode,
      selection.reason,
    );
  }

  private requestWithContextPurpose(
    request: CodingWorkbenchRuntimeStartRequest,
    binding: CodingWorkbenchIssueBinding | undefined,
  ): CodingWorkbenchRuntimeStartRequest {
    return binding === undefined ? request : { ...request, issuePurpose: "context" };
  }

  private captureHistory(runId: string): void {
    this.deps.history?.capture(runId, this.deps.safeActivityProjection?.currentContent());
  }

  private beginHistory(
    request: CodingWorkbenchRuntimeStartRequest,
    active: ActiveWorkspaceView,
    runId: string,
  ): boolean {
    try {
      this.deps.history?.begin(request, active, runId);
      return true;
    } catch (error) {
      recordRuntimeStartFailure(this.deps.diagnostics, runId, "history-initialization", error);
      return false;
    }
  }

  private historyStartScope(request: CodingWorkbenchRuntimeStartRequest):
    | {
        readonly active: ActiveWorkspaceView;
        readonly principal: string;
        readonly request: CodingWorkbenchRuntimeStartRequest;
      }
    | undefined {
    const active = this.activeWorkspaceOrUndefined();
    const principal = this.deps.serverPrincipal();
    if (!active || !principal) return undefined;
    if (request.conversationId === undefined) return { active, principal, request };
    if (!this.deps.history?.admits(request.conversationId, active)) return undefined;
    const priorId = this.deps.history.previousRunId(request.conversationId);
    const prior = priorId === undefined ? undefined : this.deps.snapshots.get(priorId);
    if (prior === undefined) return undefined;
    return { active, principal, request: this.continuedIssueRequest(request, prior) };
  }

  private continuedIssueRequest(
    request: CodingWorkbenchRuntimeStartRequest,
    prior: CodingRuntimeSnapshot,
  ): CodingWorkbenchRuntimeStartRequest {
    const issue = prior.issueBinding ?? prior.issueContextBinding;
    if (issue === undefined) return request;
    return {
      ...request,
      issueRef: `#${String(issue.issueNumber)}`,
      expectedIssueBindingDigest: issue.bindingDigest,
      issuePurpose: prior.issueContextBinding === undefined ? "delivery" : "context",
    };
  }

  private selectStartPredecessor(
    snapshot: CodingRuntimeSnapshot,
    requested: string | undefined,
  ): PredecessorSelection {
    if (requested !== undefined) return { snapshot, reason: "acknowledged-recovery" };
    const failed = this.failedSuccessorLineagePredecessor(snapshot);
    if (failed !== undefined)
      return {
        snapshot: { ...snapshot, predecessorRunId: failed },
        reason: "failed-successor-lineage",
      };
    const historical = this.uniqueHistoricalDraftPredecessor(snapshot);
    return historical === undefined
      ? { snapshot, reason: "no-bounded-lineage" }
      : {
          snapshot: { ...snapshot, predecessorRunId: historical },
          reason: "historical-local-draft",
        };
  }

  private failedSuccessorLineagePredecessor(snapshot: CodingRuntimeSnapshot): string | undefined {
    const candidate =
      this.settledRunId === undefined ? undefined : this.deps.snapshots.get(this.settledRunId);
    if (!eligibleFailedLineageCandidate(snapshot, candidate)) return undefined;
    const lineage = draftDeliveryLineageRecord(candidate, (runId) =>
      this.deps.snapshots.get(runId),
    );
    if (!isAcknowledgedDraftLineage(lineage) || lineage === undefined) return undefined;
    const source = this.deps.snapshots.getLastSuccessfulVerifiedCommit?.(lineage.snapshot.runId);
    return localDraftDeliverySource(lineage.snapshot, lineage.record, source) === undefined
      ? undefined
      : candidate.runId;
  }

  private uniqueHistoricalDraftPredecessor(snapshot: CodingRuntimeSnapshot): string | undefined {
    const matches = this.deps.snapshots
      .listAll(DRAFT_DELIVERY_RECOVERY_MAX_PREDECESSORS)
      .filter((candidate) => this.isHistoricalDraftPredecessor(snapshot, candidate));
    return matches.length === 1 ? matches[0]?.runId : undefined;
  }

  private isHistoricalDraftPredecessor(
    snapshot: CodingRuntimeSnapshot,
    candidate: CodingRuntimeSnapshot,
  ): boolean {
    const draft = candidate.draftDelivery;
    if (
      draft?.pullRequest === undefined ||
      candidate.state !== "recovery-required" ||
      candidate.terminalAt === undefined ||
      candidate.recoveryAcknowledgedAt === undefined ||
      !sameDraftRecoveryTask(snapshot, candidate)
    )
      return false;
    const source = this.deps.snapshots.getLastSuccessfulVerifiedCommit?.(candidate.runId);
    return localDraftDeliverySource(candidate, draft, source) !== undefined;
  }

  private admitIssue(
    request: CodingWorkbenchRuntimeStartRequest,
    active: ActiveWorkspaceView,
    runId: string,
    predecessorRunId?: string,
  ): ReturnType<typeof admitCodingRuntimeIssue> {
    return admitCodingRuntimeIssue({
      request,
      active,
      runId,
      priorBinding:
        predecessorRunId === undefined
          ? undefined
          : this.deps.snapshots.get(predecessorRunId)?.issueBinding,
      priorContextBinding:
        predecessorRunId === undefined
          ? undefined
          : this.deps.snapshots.get(predecessorRunId)?.issueContextBinding,
      intake: this.deps.issueIntake,
      activityLog: this.deps.activityLog,
      deploymentCeiling: this.deps.deploymentCeiling,
    });
  }

  private recordIssueAdmission(
    request: CodingWorkbenchRuntimeStartRequest,
    runId: string,
    attachment: CodingRuntimeIssueAttachment | undefined,
  ): void {
    if (attachment !== undefined) {
      this.deps.activityLog?.write(
        activityLogEvent(
          CODING_RUNTIME_ISSUE_CONTEXT_ATTACHED_OPERATION,
          { correlationId: runId },
          {
            runId,
            issueNumber: attachment.issueNumber,
            itemCount: attachment.itemCount,
            linkedIssueCount: attachment.linkedIssueCount,
            byteCount: attachment.byteCount,
            issuePurpose: issuePurposeOf(request),
          },
        ),
      );
    }
  }

  private async runInitialTurn(
    request: CodingWorkbenchRuntimeStartRequest,
    active: ActiveWorkspaceView,
    runId: string,
    attachment?: CodingRuntimeIssueAttachment,
  ): Promise<CodingRuntimeOrchestratorResult> {
    const ready = this.transitionActive("ready");
    if (!ready.ok) return ready;
    // #3390: this orchestrator-local snapshot is a separate object from runtimeAuthorityService's
    // runtimeState (synced independently by productionCodingRuntimePorts.ts's
    // startProductionRuntime, well before this method runs) -- moving this transition earlier
    // does NOT itself admit the reservePromptTokens race; that race is closed in
    // runtimeAuthorityService.ts (PROMPT_RESERVATION_ADMISSIBLE_STATES, which now also admits
    // "starting", the actual runtimeState during the managed runtime's own start()). What this
    // move does fix is the run's own public projection: settling into "running" BEFORE dispatch,
    // instead of only after the sidecar accepts, means an operator never observes "ready" while
    // this orchestrator has already asked the sidecar to run a model turn. "running" is a legal
    // target out of "ready" (LEGAL_TRANSITIONS), and "running" itself still has legal "failed" /
    // "recovery-required" exits, so the dispatch-failure branches below are unaffected.
    const running = this.transitionActive("running");
    if (!running.ok) return running;
    // Captured now, not re-read after the dispatch: this is the exact internal snapshot the
    // dispatch below is admitted against (running.snapshot.revision), so advancing FROM it on
    // acceptance is guaranteed to move the live revision exactly one step past what the dispatch
    // consumed.
    const runningInternal = this.current();
    if (!isExactRunRevision(runningInternal, runId, running.snapshot.revision)) {
      return this.transitionActive("recovery-required", "recovery-required");
    }
    const initialContext = await this.initialContextFor(request, active, runId, attachment);
    const initialTurn = await this.operations.startInitialTurn({
      runId,
      requestId: request.requestId,
      expectedRevision: runningInternal.revision,
      taskIntent: request.taskIntent,
      ...(initialContext === undefined ? {} : { initialContext }),
    });
    // Every OTHER guarded mutation (follow-up dispatch, question answer/reject) advances the live
    // revision in the SAME call that commits its production-guard reservation
    // (codingRuntimeOperationCoordinator.ts's submitFollowUp/applyAnswer via advanceRevision) --
    // the per-run ProductionRuntimeOperationGuard (productionCodingRuntimePorts.ts) depends on that
    // invariant: it marks the committed expectedRevision as consumed and admits only a STRICTLY
    // newer revision afterward (any read or mutation included -- #2386's own regression pin
    // spells this out: "the mutation consumed revision 3: stale reads and stale mutations both
    // stay rejected"). The initial turn's own dispatch is a guarded mutation exactly like those,
    // but used to return the unchanged `running` snapshot on acceptance -- the one guarded mutation
    // that never advanced the live revision. That left every read (question listing) or write
    // (answer/reject) issued at the run's own still-current revision permanently rejected as
    // authority-resolution-failed, from the moment the initial turn was accepted onward (epic
    // #3384). Advancing here restores the same one-bump-per-accepted-dispatch invariant every
    // other guarded mutation already provides.
    if (initialTurn === "accepted") return this.advanceRevision(runningInternal, "task-submitted");
    if (initialTurn === "failed") {
      recordRuntimeStartFailure(this.deps.diagnostics, runId, "initial-turn-dispatch");
      return this.transitionActive("failed", "runtime-failed");
    }
    recordRuntimeStartFailure(this.deps.diagnostics, runId, "initial-turn-recovery");
    return this.transitionActive("recovery-required", "recovery-required");
  }

  private async initialContextFor(
    request: CodingWorkbenchRuntimeStartRequest,
    active: ActiveWorkspaceView,
    runId: string,
    attachment?: CodingRuntimeIssueAttachment,
  ): Promise<string | undefined> {
    const issueContext =
      attachment === undefined ? undefined : renderInitialTurnContext(attachment);
    const memoryContext = await this.projectMemoryInitialContext(request, active, runId);
    return composeCodingRuntimeInitialContext([
      issueContext,
      memoryContext,
      this.deps.history?.initialContext(runId),
    ]);
  }

  private async projectMemoryInitialContext(
    request: CodingWorkbenchRuntimeStartRequest,
    active: ActiveWorkspaceView,
    runId: string,
  ): Promise<string | undefined> {
    if (request.projectMemory?.enabled === false) {
      recordRuntimeProjectMemoryContext(this.deps.activityLog, runId, "disabled");
      return undefined;
    }
    if (this.deps.projectMemory === undefined) {
      recordRuntimeProjectMemoryContext(this.deps.activityLog, runId, "unavailable");
      return undefined;
    }
    try {
      const context = await this.deps.projectMemory.getContextForRun({
        runId,
        taskIntent: request.taskIntent,
        scopes: codingRuntimeProjectMemoryScopes(active.instance.repositoryRoot),
      });
      const rendered = renderCodingRuntimeProjectMemoryContext(context);
      recordRuntimeProjectMemoryContext(
        this.deps.activityLog,
        runId,
        rendered === undefined ? "empty" : "included",
        context.includedMemoryIds.length,
      );
      return rendered;
    } catch (error) {
      recordRuntimeProjectMemoryFailure(this.deps.diagnostics, runId, error);
      recordRuntimeProjectMemoryContext(this.deps.activityLog, runId, "failed");
      return undefined;
    }
  }

  private async resolveLaunch(
    request: CodingWorkbenchRuntimeStartRequest,
    active: ActiveWorkspaceView,
    principal: string,
    runId: string,
    issueBinding?: CodingWorkbenchIssueBinding,
    correlationId?: string,
  ): Promise<
    | { readonly ok: true; readonly launch: ReturnType<CodingRuntimeLaunchResolver["resolve"]> }
    | {
        readonly ok: false;
        readonly failureCode: CodingWorkbenchRuntimeFailureCode;
        readonly modelRefusalReason?: CodingWorkbenchModelRefusalReason;
      }
  > {
    try {
      const input = {
        runId,
        requestId: request.requestId,
        taskIntent: request.taskIntent,
        requestedMode: request.requestedMode,
        ...(request.runtimePreference ? { runtimePreference: request.runtimePreference } : {}),
        ...(request.modelId ? { modelId: request.modelId } : {}),
        ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
        projectMemoryEnabled: request.projectMemory?.enabled ?? true,
        workspaceId: active.instance.workspaceId,
        workspaceRoot: active.binding.activeRoot,
        serverPrincipal: principal,
        ...(correlationId === undefined ? {} : { correlationId }),
        ...(issueBinding === undefined ? {} : { issueBinding }),
      };
      await this.deps.launchResolver.prepare?.(input);
      const launch = this.deps.launchResolver.resolve(input);
      return { ok: true, launch };
    } catch (error) {
      // Never a bare `catch {}`: a rejected launch used to lose its identity here and surface as
      // `authority-resolution-failed` whatever the real cause was (KEIKO-0150).
      recordRuntimeStartFailure(this.deps.diagnostics, runId, "launch-resolution", error);
      return refusedLaunch(error);
    }
  }

  private buildStartSnapshot(
    request: CodingWorkbenchRuntimeStartRequest,
    active: ActiveWorkspaceView,
    principal: string,
    runId: string,
    launch: ReturnType<CodingRuntimeLaunchResolver["resolve"]>,
    predecessorRunId?: string,
    issue: Pick<CodingRuntimeSnapshot, "issueBinding" | "issueContextBinding"> = {},
  ): CodingRuntimeSnapshot {
    const now = this.now().toISOString();
    return {
      schemaVersion: "1",
      runId,
      state: "starting",
      revision: 1,
      requestedMode: request.requestedMode,
      runtimeSource: launch.runtimeSource,
      modelSource: launch.modelSource,
      createdAt: now,
      updatedAt: now,
      taskDigest: DIGEST(launch.taskRef),
      workspaceDigest: DIGEST(active.binding.activeRoot),
      operatorDigest: DIGEST(principal),
      authorityDigest: DIGEST(launch.treeBindingId),
      bindingDigest: DIGEST(active.instance.workspaceId),
      provenanceDigest: DIGEST(`${launch.adapterKind}:${launch.executablePath}`),
      toolCallCount: 0,
      patchByteCount: 0,
      modelRequestCount: 0,
      ...(predecessorRunId ? { predecessorRunId } : {}),
      ...(issue.issueBinding === undefined ? {} : { issueBinding: issue.issueBinding }),
      ...(issue.issueContextBinding === undefined
        ? {}
        : { issueContextBinding: issue.issueContextBinding }),
    };
  }

  /** Returns the failure transition when the managed runtime did not reach a trusted start. */
  private async startManagedRuntime(
    request: CodingWorkbenchRuntimeStartRequest,
    active: ActiveWorkspaceView,
    runId: string,
    launch: ReturnType<CodingRuntimeLaunchResolver["resolve"]>,
  ): Promise<CodingRuntimeOrchestratorResult | undefined> {
    let result: Awaited<ReturnType<CodingRuntimeManager["start"]>>;
    try {
      result = await this.deps.manager.start({
        ...launch,
        runId,
        workspaceRoot: active.binding.activeRoot,
        requestedMode: request.requestedMode,
      });
    } catch (error) {
      recordRuntimeStartFailure(this.deps.diagnostics, runId, "manager-exception", error);
      // Recovery-required remains the only safe projection when host containment cannot be proven.
      await this.reconcileQuietly(runId);
      return this.transitionActive("recovery-required", "recovery-required");
    }
    if (result.ok && result.runId !== runId) {
      recordRuntimeStartFailure(this.deps.diagnostics, runId, "run-mismatch");
      // A mismatched host success cannot be trusted; recovery remains fail-closed.
      await this.reconcileQuietly(result.runId);
      return this.transitionActive("recovery-required", "recovery-required");
    }
    if (!result.ok) {
      recordRuntimeStartFailure(this.deps.diagnostics, runId, result.failureCode);
      return this.transitionActive("failed", "runtime-failed");
    }
    return undefined;
  }

  private async reconcileQuietly(runId: string): Promise<void> {
    try {
      await this.deps.manager.reconcile(runId);
    } catch {
      // Recovery-required remains the only safe projection when host containment cannot be proven.
    }
  }

  private advanceRevision(
    current: CodingRuntimeSnapshot,
    eventKind?: CodingWorkbenchRuntimeEvent["kind"],
  ): CodingRuntimeOrchestratorResult {
    const next = this.deps.snapshots.transition(current.runId, {
      state: current.state,
      revision: current.revision + 1,
      updatedAt: this.now().toISOString(),
    });
    return this.projection.publish(next, eventKind)
      ? { ok: true, snapshot: this.publicSnapshotWithDescription(next) }
      : this.transition(next, "recovery-required", "recovery-required");
  }

  private async end(
    kind: "stop" | "takeover",
    runId: string,
    input: unknown,
  ): Promise<CodingRuntimeOrchestratorResult> {
    const parsed = this.parseEndRequest(kind, input);
    const current = this.current();
    if (!this.isEndRequestConsistent(parsed, runId, current)) return this.fail("invalid-intent");
    if (!current) return this.stopSettledRun(kind, runId);
    if (current.state === "recovery-required") return this.fail("recovery-required");
    this.captureHistory(runId);
    this.deps.safeActivityProjection?.purge(runId, kind === "stop" ? "stop" : "takeover");
    const stopping = this.createEndStoppingTransition(kind, current);
    if (!stopping.ok) return stopping;
    const result = await this.executeEndRequest(kind, current.runId);
    return this.completeEndRequest(kind, runId, result);
  }

  private stopSettledRun(
    kind: "stop" | "takeover",
    runId: string,
  ): CodingRuntimeOrchestratorResult {
    const settled = kind === "stop" ? this.deps.snapshots.get(runId) : undefined;
    if (settled === undefined || !TERMINAL_STATES.has(settled.state)) {
      return { ok: true, snapshot: this.projection.idle() };
    }
    this.deps.safeActivityProjection?.purge(runId, "stop");
    return { ok: true, snapshot: this.projection.idle() };
  }

  private completeEndRequest(
    kind: "stop" | "takeover",
    runId: string,
    result: Awaited<ReturnType<CodingRuntimeManager["stop"]>> | undefined,
  ): CodingRuntimeOrchestratorResult {
    if (this.hasActiveRunChanged(runId)) return this.fail("runtime-failed");
    if (result?.ok) {
      const settled = this.endSettledResult(runId);
      if (settled !== undefined) return settled;
      return this.transitionActive(this.endSuccessState(kind));
    }
    return this.transitionActive("recovery-required", "recovery-required");
  }

  private parseEndRequest(
    kind: "stop" | "takeover",
    input: unknown,
  ):
    | ReturnType<typeof parseCodingWorkbenchRuntimeStopRequest>
    | ReturnType<typeof parseCodingWorkbenchRuntimeTakeoverRequest> {
    return kind === "stop"
      ? parseCodingWorkbenchRuntimeStopRequest(input)
      : parseCodingWorkbenchRuntimeTakeoverRequest(input);
  }

  private isEndRequestConsistent(
    parsed:
      | ReturnType<typeof parseCodingWorkbenchRuntimeStopRequest>
      | ReturnType<typeof parseCodingWorkbenchRuntimeTakeoverRequest>,
    runId: string,
    current: CodingRuntimeSnapshot | undefined,
  ): boolean {
    if (!parsed.ok || parsed.value.requestId !== runId) return false;
    return current === undefined || current.runId === runId;
  }

  private createEndStoppingTransition(
    kind: "stop" | "takeover",
    current: CodingRuntimeSnapshot,
  ): CodingRuntimeOrchestratorResult {
    return kind === "stop"
      ? this.transition(current, "stopping")
      : { ok: true as const, snapshot: this.publicSnapshotWithDescription(current) };
  }

  private async executeEndRequest(
    kind: "stop" | "takeover",
    runId: string,
  ): Promise<Awaited<ReturnType<CodingRuntimeManager["stop"]>> | undefined> {
    try {
      return kind === "stop"
        ? await this.deps.manager.stop(runId)
        : await this.deps.manager.takeover(runId);
    } catch {
      this.recordEndRequestException(runId);
      // Recovery-required remains the only safe projection when stop/takeover cannot be trusted.
      return undefined;
    }
  }

  private recordEndRequestException(runId: string): void {
    this.deps.evidence.observe(runId, {
      kind: "state-transition",
      state: "recovery-required",
      failureCode: "recovery-required",
    });
  }

  private hasActiveRunChanged(runId: string): boolean {
    return this.activeRunId !== undefined && this.activeRunId !== runId;
  }

  private endSettledResult(runId: string): CodingRuntimeOrchestratorResult | undefined {
    const settled = this.deps.snapshots.get(runId);
    if (
      this.activeRunId === undefined &&
      settled !== undefined &&
      TERMINAL_STATES.has(settled.state)
    ) {
      return { ok: true, snapshot: this.publicSnapshotWithDescription(settled) };
    }
    return undefined;
  }

  private endSuccessState(kind: "stop" | "takeover"): CodingWorkbenchRuntimeStateName {
    return kind === "stop" ? "cancelled" : "taken-over";
  }

  private transitionActive(
    state: CodingWorkbenchRuntimeStateName,
    failureCode?: CodingWorkbenchRuntimeFailureCode,
  ): CodingRuntimeOrchestratorResult {
    const current = this.current();
    return current ? this.transition(current, state, failureCode) : this.fail("runtime-failed");
  }
  private transition(
    current: CodingRuntimeSnapshot,
    state: CodingWorkbenchRuntimeStateName,
    failureCode?: CodingWorkbenchRuntimeFailureCode,
    pauseReason?: CodingWorkbenchOperatorDecision,
  ): CodingRuntimeOrchestratorResult {
    if (!isLegalCodingWorkbenchRuntimeTransition(current.state, state)) {
      return this.fail("invalid-intent");
    }
    const next = this.createTransitionSnapshot(current, state, failureCode, pauseReason);
    const published = this.publishTransition(next);
    this.recordTransitionEvidence(next, state, failureCode);
    if (this.shouldTransitionToRecoveryRequired(published, state)) {
      return this.transition(next, "recovery-required", "recovery-required");
    }
    this.finalizeTransitionIfTerminal(next, state, failureCode);
    return { ok: true, snapshot: this.publicSnapshotWithDescription(next) };
  }

  private createTransitionSnapshot(
    current: CodingRuntimeSnapshot,
    state: CodingWorkbenchRuntimeStateName,
    failureCode?: CodingWorkbenchRuntimeFailureCode,
    pauseReason?: CodingWorkbenchOperatorDecision,
  ): CodingRuntimeSnapshot {
    const result = TERMINAL_STATES.has(state) ? this.deps.manager.result(current.runId) : undefined;
    return this.deps.snapshots.transition(current.runId, {
      state,
      revision: current.revision + 1,
      updatedAt: this.now().toISOString(),
      ...(failureCode ? { failureCode } : {}),
      ...(pauseReason === undefined ? {} : { pauseReason }),
      ...(result === undefined ? {} : { result }),
    });
  }

  private publishTransition(next: CodingRuntimeSnapshot): boolean {
    return this.projection.publish(next);
  }

  private recordTransitionEvidence(
    next: CodingRuntimeSnapshot,
    state: CodingWorkbenchRuntimeStateName,
    failureCode?: CodingWorkbenchRuntimeFailureCode,
  ): void {
    this.deps.evidence.observe(next.runId, {
      kind: "state-transition",
      state,
      ...(failureCode ? { failureCode } : {}),
    });
  }

  private shouldTransitionToRecoveryRequired(
    published: boolean,
    state: CodingWorkbenchRuntimeStateName,
  ): boolean {
    return !published && !TERMINAL_STATES.has(state) && state !== "recovery-required";
  }

  private finalizeTransitionIfTerminal(
    next: CodingRuntimeSnapshot,
    state: CodingWorkbenchRuntimeStateName,
    failureCode?: CodingWorkbenchRuntimeFailureCode,
  ): void {
    if (state === "recovery-required") {
      this.deps.safeActivityProjection?.markUnavailable(next.runId);
    } else if (!TERMINAL_STATES.has(state)) {
      return;
    } else {
      this.purgeExplicitlyEndedActivity(next.runId, state);
    }
    recordRuntimeRunSettled(this.deps.activityLog, next, state, failureCode);
    this.publishSettlement(next, state, failureCode);
    if (state === "succeeded") this.dispatchDescriptionIfEligible(next);
  }

  /**
   * #3401: overlays the durable description status onto every public snapshot projection. The
   * underlying value is read fresh from the job store on every call (never cached on
   * `CodingRuntimeSnapshot`), so a status written by an in-flight dispatch after `next`/`current`
   * was captured is still visible on the very next poll or transition response.
   */
  private publicSnapshotWithDescription(
    snapshot: CodingRuntimeSnapshot | undefined,
  ): PublicSnapshot {
    const projected = this.projection.publicSnapshot(snapshot);
    const history = snapshot === undefined ? undefined : this.deps.history?.forRun(snapshot.runId);
    const base = history === undefined ? projected : { ...projected, conversationId: history.id };
    const persisted =
      snapshot === undefined ? undefined : this.description?.jobs.current(snapshot.runId);
    const status =
      snapshot === undefined || persisted === undefined
        ? persisted
        : this.reconcileDescriptionProposal(snapshot, persisted);
    return status === undefined ? base : { ...base, descriptionStatus: status };
  }

  private reconcileDescriptionProposal(
    snapshot: CodingRuntimeSnapshot,
    status: WorkbenchDescriptionStatus,
  ): WorkbenchDescriptionStatus {
    if (status.proposalId === undefined || status.snapshotDigest === null) return status;
    const support = this.description;
    const scope = this.descriptionScope(snapshot);
    if (
      isRetainedDescriptionProposal(
        support,
        scope,
        status,
        status.proposalId,
        status.snapshotDigest,
      )
    ) {
      return status;
    }
    const reason = lostProposalReason(status, scope);
    const stale = support?.jobs.markProposalLost(
      snapshot.runId,
      status.proposalId,
      reason,
      this.now().toISOString(),
    );
    if (stale?.reason === reason && stale.proposalId === undefined) {
      this.logDescriptionEvent(scope ?? { runId: snapshot.runId }, "stale", {
        reason,
        proposalRetained: false,
      });
    }
    return stale ?? status;
  }

  /**
   * #3401 AC "a repaired head after CI repair regenerates": the CI-repair loop (#3388) pushes a new
   * verified commit for an ALREADY-succeeded run, well after this orchestrator's one-time terminal
   * transition already fired. That owner calls this after recording the new successful commit so
   * the same dedup/coalesce/supersede path in `dispatchDescriptionIfEligible` reconsiders the
   * bound run's description job for the new head — a public seam rather than a second dispatcher.
   */
  notifyVerifiedHeadAdvanced(runId: string): void {
    const snapshot = this.deps.snapshots.get(runId);
    if (snapshot !== undefined) this.dispatchDescriptionIfEligible(snapshot);
  }

  /** Returns an exact transient generic draft only while its durable status remains current. */
  reviewDescriptionDraft(
    runId: string,
    proposalId: string,
    snapshotDigest: string,
  ): PrDescriptionDraftPreview | undefined {
    const support = this.description;
    if (support === undefined) return undefined;
    const snapshot = this.deps.snapshots.get(runId);
    if (snapshot === undefined) return undefined;
    const status = support.jobs.current(runId);
    if (!matchesDescriptionProposal(status, proposalId, snapshotDigest)) return undefined;
    const scope = this.descriptionScope(snapshot);
    if (scope === undefined || scope.applicationTarget !== undefined) return undefined;
    if (!isRetainedDescriptionProposal(support, scope, status, proposalId, snapshotDigest))
      return undefined;
    const reviewDraft = support.dispatcher?.reviewDraft;
    if (reviewDraft === undefined) return undefined;
    const review = reviewDraft(scope, proposalId, snapshotDigest);
    if (review !== undefined)
      this.logDescriptionEvent(scope, "reviewed", { proposalRetained: true });
    return review;
  }

  /**
   * #3401 composition seam: `createCodingRuntimeOrchestrator`'s constructor is called from
   * `codingRuntimeControlPlane.ts` before the real dispatcher (deps.ts's snapshot capture +
   * description authority + Model Gateway generation chain) can be composed, so production wiring
   * cannot pass `description` at construction time. This lets deps.ts attach it immediately after
   * control-plane construction instead. Runs the SAME startup reconciliation
   * `startupReconcileNow` already ran with `description` absent, so an attempt left `dispatched` by
   * a prior process is still closed to `blocked`/`interrupted` exactly once, never resumed or lost
   * regardless of how late in composition the real support arrives.
   */
  attachDescriptionSupport(support: CodingRuntimeDescriptionSupport): void {
    this.description = support;
    this.reconcileInterruptedDescriptionJobs(support);
  }

  private reconcileInterruptedDescriptionJobs(
    support: CodingRuntimeDescriptionSupport | undefined,
  ): void {
    for (const runId of support?.jobs.reconcileInterrupted(this.now().toISOString()) ?? []) {
      this.logDescriptionEvent({ runId }, "blocked", { reason: "interrupted" });
    }
  }

  // #3401: fires only for a stable succeeded head with a persisted VerifiedCommitResult (correction
  // 5 — the workspace's best-effort `lastVerifiedHead` is never the trigger). Dispatches AT MOST
  // ONE generation attempt per (runId, remoteDigest, baseSha, headSha); a repeated identical signal
  // or a still-in-flight attempt for the same head coalesces, and a new head supersedes.
  private dispatchDescriptionIfEligible(next: CodingRuntimeSnapshot): void {
    const support = this.description;
    if (support === undefined) return;
    const scope = this.descriptionScope(next);
    if (scope === undefined) return;
    const nowIso = this.now().toISOString();
    const decision = support.jobs.beginDispatch(scope, nowIso);
    if (decision.kind === "coalesced") {
      this.logDescriptionEvent(
        scope,
        "coalesced",
        decision.status?.generationVersion === undefined
          ? {}
          : { generationVersion: decision.status.generationVersion },
      );
      return;
    }
    if (decision.kind === "budget-exhausted") {
      support.jobs.recordBudgetExhausted(scope, nowIso);
      this.logDescriptionEvent(scope, "blocked", { reason: "budget-exhausted" as const });
      return;
    }
    if (decision.supersededPriorAttempt) this.logDescriptionEvent(scope, "superseded", {});
    this.runDescriptionDispatch(
      support,
      scope,
      decision.generationVersion,
      decision.revision,
      nowIso,
    );
  }

  private descriptionScope(next: CodingRuntimeSnapshot): WorkbenchDescriptionScope | undefined {
    if (next.state !== "succeeded") return undefined;
    const commit = this.deps.snapshots.getLastSuccessfulVerifiedCommit?.(next.runId);
    if (commit?.headSha === undefined) return undefined;
    const workspace = this.activeWorkspaceOrUndefined();
    const applicationTarget = descriptionApplicationTarget(next, workspace, commit.headSha);
    const acceptedMode = this.settledEffectiveModes.get(next.runId);
    return {
      runId: next.runId,
      remoteDigest: commit.repositoryDigest,
      baseSha: commit.baseSha,
      headSha: commit.headSha,
      ...(acceptedMode === undefined ? {} : { acceptedMode }),
      ...descriptionComparisonRefs(next, workspace, {
        baseRef: commit.baseSha,
        headRef: commit.headSha,
      }),
      generationBinding: descriptionGenerationBinding(next),
      ...(applicationTarget === undefined ? {} : { applicationTarget }),
    };
  }

  private runDescriptionDispatch(
    support: CodingRuntimeDescriptionSupport,
    scope: WorkbenchDescriptionScope,
    generationVersion: number,
    revision: number,
    nowIso: string,
  ): void {
    this.logDescriptionEvent(scope, "dispatched", { generationVersion });
    if (support.dispatcher === undefined) {
      support.jobs.recordBlocked(
        scope,
        "generation-unavailable",
        generationVersion,
        revision,
        nowIso,
      );
      this.logDescriptionEvent(scope, "blocked", { reason: "generation-unavailable" as const });
      return;
    }
    const controller = new AbortController();
    this.descriptionDispatchAbort.get(scope.runId)?.abort();
    this.descriptionDispatchAbort.set(scope.runId, controller);
    support.dispatcher
      .generate(scope, controller.signal)
      .then((outcome) => {
        this.settleDescriptionDispatch(support, scope, generationVersion, revision, outcome);
      })
      .catch((error: unknown) => {
        const accepted = support.jobs.recordBlocked(
          scope,
          "provider-failed",
          generationVersion,
          revision,
          this.now().toISOString(),
        );
        this.logDescriptionEvent(scope, accepted ? "blocked" : "superseded", {
          reason: "provider-failed" as const,
          ...runtimeDeliveryErrorFields(error),
        });
      });
  }

  private isDescriptionScopeCurrent(scope: WorkbenchDescriptionScope): boolean {
    const current = this.deps.snapshots.get(scope.runId);
    const commit = this.deps.snapshots.getLastSuccessfulVerifiedCommit?.(scope.runId);
    return (
      current?.state === "succeeded" &&
      commit?.headSha === scope.headSha &&
      commit.baseSha === scope.baseSha &&
      commit.repositoryDigest === scope.remoteDigest &&
      canonicalise(descriptionGenerationBinding(current)) === canonicalise(scope.generationBinding)
    );
  }

  private settleDescriptionDispatch(
    support: CodingRuntimeDescriptionSupport,
    scope: WorkbenchDescriptionScope,
    generationVersion: number,
    revision: number,
    outcome: WorkbenchDescriptionDispatchOutcome,
  ): void {
    const observedAt = this.now().toISOString();
    const reason = this.isDescriptionScopeCurrent(scope) ? outcome.reason : "stale-snapshot";
    const status: WorkbenchDescriptionStatus = {
      schemaVersion: "1",
      runId: scope.runId,
      remoteDigest: scope.remoteDigest,
      baseSha: scope.baseSha,
      headSha: scope.headSha,
      ...(scope.generationBinding === undefined
        ? {}
        : { generationBinding: scope.generationBinding }),
      generationVersion,
      state: WORKBENCH_DESCRIPTION_REASON_STATES[reason],
      reason,
      snapshotDigest: outcome.snapshotDigest ?? null,
      draftDigest: outcome.draftDigest ?? null,
      artifactOutcome: outcome.artifactOutcome ?? null,
      ...(reason === outcome.reason && outcome.proposalId !== undefined
        ? { proposalId: outcome.proposalId }
        : {}),
      observedAt,
    };
    const accepted = support.jobs.settle(scope, generationVersion, revision, status, observedAt);
    this.logDescriptionEvent(scope, accepted ? descriptionSettleOp(reason) : "superseded", {
      generationVersion,
      reason,
    });
  }

  // #3401 review: `op` used to be a template literal (`coding-runtime.description.${event}`),
  // which the op-catalog generator cannot resolve to a fixed set of literals and which
  // `support-analyze.ts`'s issue-to-PR journey phase map cannot recognise under any name. One
  // fixed literal op with `event` carried in `extra` (mirroring how every other dispatch-lifecycle
  // event on this file's sibling ops is distinguished by an `extra` field, not by the op string
  // itself) keeps this catalog-resolvable and journey-reconstructable.
  private logDescriptionEvent(
    identity: Pick<WorkbenchDescriptionScope, "runId" | "generationBinding"> & {
      readonly remoteDigest?: string;
    },
    event: DescriptionLogEvent,
    extra: DescriptionLogFields,
  ): void {
    const errorKind = descriptionLogErrorKind(event, extra.reason);
    this.deps.activityLog?.write(
      activityLogEvent(
        CODING_RUNTIME_DESCRIPTION_OPERATION,
        {
          correlationId: runtimeDiagnosticCorrelationId(identity.runId),
          ...(errorKind === undefined ? {} : { errorKind }),
        },
        {
          runId: identity.runId,
          ...(identity.remoteDigest === undefined ? {} : { remoteDigest: identity.remoteDigest }),
          event,
          ...extra,
          ...(identity.generationBinding === undefined
            ? {}
            : {
                generationBindingDigest: sha256Hex(canonicalise(identity.generationBinding)),
              }),
        },
      ),
    );
  }

  private purgeExplicitlyEndedActivity(
    runId: string,
    state: CodingWorkbenchRuntimeStateName,
  ): void {
    if (state !== "cancelled" && state !== "taken-over") return;
    this.deps.safeActivityProjection?.purge(runId, state === "taken-over" ? "takeover" : "stop");
  }

  private publishSettlement(
    next: CodingRuntimeSnapshot,
    state: CodingWorkbenchRuntimeStateName,
    failureCode?: CodingWorkbenchRuntimeFailureCode,
  ): void {
    this.deps.evidence.settle({
      runId: next.runId,
      state,
      revision: next.revision,
      settledAt: next.updatedAt,
      ...(failureCode ? { failureCode } : {}),
      taskDigest: next.taskDigest,
      workspaceDigest: next.workspaceDigest,
      operatorDigest: next.operatorDigest,
      authorityDigest: next.authorityDigest,
      bindingDigest: next.bindingDigest,
      provenanceDigest: next.provenanceDigest,
    });
    if (TERMINAL_STATES.has(state)) {
      if (this.activeEffectiveMode !== undefined) {
        this.settledEffectiveModes.set(next.runId, this.activeEffectiveMode);
      }
      this.activeRunId = undefined;
      this.settledRunId = next.runId;
    }
    if (TERMINAL_STATES.has(state) || state === "recovery-required")
      this.activeEffectiveMode = undefined;
    this.approvals.delete(next.runId);
    this.queuedApprovals.delete(next.runId);
    // Every settlement ends a run's continuation budget, not only the task-settlement path: a
    // continued run that is stopped, taken over or moved to recovery must not keep its entry.
    this.deliveryContinuations.delete(next.runId);
    this.operations.clear(next.runId);
    this.pruneSettled();
  }
  private pruneSettled(): void {
    const pruned = this.deps.snapshots.listPrunableSettled();
    if (pruned.length > 0) {
      this.deps.evidence.deletePruned(pruned);
      this.deps.eventHub.deleteRuns(pruned);
      this.deps.snapshots.deletePruned(pruned);
      // #3401 review: descriptionDispatchAbort is per-run bookkeeping like the three stores above
      // and must not outlive a pruned run. #3401 review finding F7: a dispatch still in flight for
      // a pruned run must be cancelled, not merely forgotten, mirroring the supersede path above
      // (this.descriptionDispatchAbort.get(scope.runId)?.abort()) — otherwise the outstanding
      // Model Gateway/snapshot-capture call keeps running to completion after nothing references
      // it any more.
      for (const runId of pruned) {
        this.descriptionDispatchAbort.get(runId)?.abort();
        this.descriptionDispatchAbort.delete(runId);
        this.settledEffectiveModes.delete(runId);
      }
    }
  }
  private current(): CodingRuntimeSnapshot | undefined {
    return this.activeRunId ? this.deps.snapshots.get(this.activeRunId) : undefined;
  }
  private fail(failureCode: CodingWorkbenchRuntimeFailureCode): CodingRuntimeOrchestratorResult {
    return { ok: false, failureCode };
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private serialValue<T>(work: () => T): Promise<T> {
    return this.serial(() => Promise.resolve(work()));
  }
}

/**
 * F66 (Coding Workbench run 22, 2026-09-11): the bounded continuation an issue-bound run under Full
 * access gets when its model ends a turn before delivery is evidenced. The operator authorized the
 * run to deliver without per-action approval, and run 22's model stopped one step short — build
 * verification passed, its own result named `stage-then-verify` — and the run settled
 * `delivery-not-evidenced` at once. The continuation restates only the accepted task's delivery
 * goal; every effect still goes through the governed tools, and nothing widens authority.
 */
export const DELIVERY_CONTINUATION_MAX = 2;
export const DELIVERY_CONTINUATION_INTENT =
  "Delivery is not evidenced yet: this issue-bound run has no verified commit and no delivered draft pull request. Continue with the next action your last tool results named, such as staging the changed files, verifying the staged candidate, committing, pushing and opening the draft pull request. Stop only when the delivery is evidenced or a governed tool refuses.";

function taskOutcomeState(outcome: CodingRuntimeTaskOutcome): {
  readonly state: "failed" | "succeeded";
  readonly failureCode?: "runtime-failed" | undefined;
} {
  return outcome === "succeeded"
    ? { state: "succeeded" }
    : { state: "failed", failureCode: "runtime-failed" };
}

function effectiveModeAfterResume(
  result: CodingRuntimeOrchestratorResult,
  effectiveMode: CodingWorkbenchMode,
): CodingWorkbenchMode | undefined {
  return result.ok &&
    (result.snapshot.state === "running" || result.snapshot.state === "awaiting-approval")
    ? effectiveMode
    : undefined;
}

function resumeAdmission(
  current: CodingRuntimeSnapshot | undefined,
  runId: string,
  input: unknown,
  activeEffectiveMode: CodingWorkbenchMode | undefined,
): ResumeAdmission | undefined {
  const parsed = parseCodingWorkbenchRuntimeResumeRequest(input);
  if (!parsed.ok || parsed.value.requestId !== runId || current?.state !== "paused") {
    return undefined;
  }
  // A run paused for a human decision has a governed tool waiting in place for that decision, and
  // the runtime was never itself paused. Resuming it would return the run to `running` while the
  // tool still waits, and the operator's real action — making the decision — would then arrive at a
  // run no longer recorded as waiting for it. The decision resumes the run; Resume does not.
  if (current.pauseReason !== undefined) return undefined;
  return {
    current,
    requestedMode: parsed.value.requestedMode ?? activeEffectiveMode ?? current.requestedMode,
  };
}

export function createCodingRuntimeOrchestrator(
  deps: CodingRuntimeOrchestratorDeps,
  description?: CodingRuntimeDescriptionSupport,
): CodingRuntimeOrchestrator {
  return new CodingRuntimeOrchestrator(deps, description);
}

/** The most recently updated terminal row, if any — the run a restarted BFF still shows as settled. */
function latestSettledRunId(
  snapshots: Pick<CodingRuntimeSnapshotStore, "listAll">,
): string | undefined {
  return snapshots.listAll(1).find((row) => row.terminalAt !== undefined)?.runId;
}
