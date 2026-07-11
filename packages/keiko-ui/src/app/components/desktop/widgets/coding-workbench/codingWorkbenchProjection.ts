import {
  CODING_WORKBENCH_SCHEMA_VERSION,
  type CodingWorkbenchAuthorityEnvelope,
  type CodingWorkbenchMode,
  type CodingWorkbenchPermissionRequest,
  type CodingWorkbenchRuntimeEvent,
  type CodingWorkbenchRuntimeHealth,
} from "@oscharko-dev/keiko-contracts";
import { AUTONOMOUS_DELIVERY_PROJECTIONS } from "./codingWorkbenchAutonomousDeliveryProjection";
import { GOVERNED_ASSIST_PROJECTIONS } from "./codingWorkbenchGovernedAssistProjection";

export type CodingWorkbenchRunState =
  | "empty"
  | "running"
  | "approval-required"
  | "approved"
  | "denied"
  | "stopped"
  | "blocked"
  | "governed-assist"
  | "governed-assist-blocked"
  | "failed"
  | "completed";

export interface CodingWorkbenchModeOption {
  readonly mode: CodingWorkbenchMode;
  readonly enabled: boolean;
  readonly reason?: string;
}

export interface CodingWorkbenchProgressSummary {
  readonly completed: number;
  readonly total: number;
  readonly label: string;
}

export interface CodingWorkbenchDiffSummary {
  readonly fileCount: number;
  readonly addedLines: number;
  readonly deletedLines: number;
  readonly label: string;
}

export interface CodingWorkbenchVerificationSummary {
  readonly status: "not-started" | "running" | "passed" | "failed" | "partial";
  readonly label: string;
  readonly passedCount: number;
  readonly failedCount: number;
  readonly skippedCount: number;
}

export interface CodingWorkbenchProjection {
  readonly runState: CodingWorkbenchRunState;
  readonly title: string;
  readonly taskRef: string;
  readonly currentStep: string;
  readonly sidecarHealth: CodingWorkbenchRuntimeHealth;
  readonly authority: CodingWorkbenchAuthorityEnvelope;
  readonly modeOptions: readonly CodingWorkbenchModeOption[];
  readonly progress: CodingWorkbenchProgressSummary;
  readonly diff: CodingWorkbenchDiffSummary;
  readonly verification: CodingWorkbenchVerificationSummary;
  readonly deliveryStatus: string;
  readonly policyDenials: readonly string[];
  readonly timeline: readonly CodingWorkbenchRuntimeEvent[];
  readonly permissionRequest?: CodingWorkbenchPermissionRequest;
}

const RUN_ID = "run-1990";
const SUPERVISED_RUN_ID = "run-1992";

const MODE_OPTIONS: readonly CodingWorkbenchModeOption[] = Object.freeze([
  { mode: "governed-assist", enabled: true },
  { mode: "supervised-coding", enabled: true },
  {
    mode: "autonomous-delivery",
    enabled: false,
    reason: "Disabled by deployment policy until the delivery envelope is confirmed.",
  },
]);

const AUTHORITY: CodingWorkbenchAuthorityEnvelope = {
  schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
  runId: RUN_ID,
  localUser: "local-operator",
  taskRefs: ["issue-1990"],
  workspace: {
    workspaceId: "workspace-keiko",
    rootLabel: "keiko-workspace",
    rootDigest: "a".repeat(64),
  },
  branch: {
    baseRef: "dev",
    headRef: "issue/1990-coding-workbench-ui",
    allowDetachedHead: false,
    allowedPrefixes: ["issue/", "codex/"],
  },
  requestedMode: "supervised-coding",
  deploymentCeiling: "supervised-coding",
  effectiveMode: "supervised-coding",
  runtimeSource: "codex-cli-adapter",
  actionClasses: [
    "workspace-read",
    "workspace-write",
    "command-execution",
    "verification",
    "connector-access",
  ],
  connectorScopes: ["source-control.read", "issue-tracker.read"],
  modelProfile: {
    profileId: "profile-codex-subscription-redacted",
    source: "chatgpt-codex-subscription-profile",
    supportsStreaming: true,
    supportsToolCalling: true,
  },
  commandPolicy: {
    mode: "governed",
    allow: ["npm", "node"],
    deny: ["curl"],
    maxCommandTimeoutMs: 600_000,
    requirePerCommandApproval: true,
  },
  networkPolicy: {
    mode: "deny-all",
    allowLoopback: false,
    connectorScopes: [],
  },
  gates: ["human-approval", "branch-allowlist", "verification-green", "policy-review"],
  budget: {
    maxRuntimeMs: 7_200_000,
    maxToolCalls: 120,
    maxPromptTokens: 200_000,
    maxPatchBytes: 500_000,
  },
  expiresAt: "2026-07-08T00:00:00.000Z",
  approvalProofDigest: "d".repeat(64),
};

const SUPERVISED_AUTHORITY: CodingWorkbenchAuthorityEnvelope = {
  ...AUTHORITY,
  runId: SUPERVISED_RUN_ID,
  taskRefs: ["issue-1992"],
  branch: {
    ...AUTHORITY.branch,
    headRef: "issue/1992-supervised-coding",
  },
  commandPolicy: {
    mode: "allowlisted",
    allow: ["npm", "node"],
    deny: ["unknown-command-denied", "mutating-command-denied"],
    maxCommandTimeoutMs: 600_000,
    requirePerCommandApproval: false,
  },
  approvalProofDigest: "f".repeat(64),
};

function eventForRun(
  runId: string,
  eventPrefix: string,
  hour: string,
  sequence: number,
  kind: CodingWorkbenchRuntimeEvent["kind"],
  patch: Partial<CodingWorkbenchRuntimeEvent> = {},
): CodingWorkbenchRuntimeEvent {
  const baseEvent = {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    eventId: `${eventPrefix}-${String(sequence)}`,
    runId,
    occurredAt: `2026-07-07T${hour}:${String(10 + sequence).padStart(2, "0")}:00.000Z`,
    kind,
  };
  return kind === "observation-streamed"
    ? { ...baseEvent, sequence, ...patch }
    : { ...baseEvent, ...patch };
}

function event(
  sequence: number,
  kind: CodingWorkbenchRuntimeEvent["kind"],
  patch: Partial<CodingWorkbenchRuntimeEvent> = {},
): CodingWorkbenchRuntimeEvent {
  return eventForRun(RUN_ID, "evt-1990", "18", sequence, kind, patch);
}

function supervisedEvent(
  sequence: number,
  kind: CodingWorkbenchRuntimeEvent["kind"],
  patch: Partial<CodingWorkbenchRuntimeEvent> = {},
): CodingWorkbenchRuntimeEvent {
  return eventForRun(SUPERVISED_RUN_ID, "evt-1992", "21", sequence, kind, patch);
}

const RUNNING_TIMELINE: readonly CodingWorkbenchRuntimeEvent[] = Object.freeze([
  event(1, "task-submitted", {
    taskRef: "issue-1990",
    requestedMode: "supervised-coding",
    effectiveMode: "supervised-coding",
  }),
  event(2, "runtime-started", {
    runtimeSource: "codex-cli-adapter",
    modelSource: "chatgpt-codex-subscription-profile",
    requestedMode: "supervised-coding",
    effectiveMode: "supervised-coding",
  }),
  event(3, "observation-streamed", {
    channel: "status",
    byteCount: 0,
    truncated: false,
  }),
  event(4, "diff-summarized", {
    fileCount: 6,
    addedLines: 420,
    deletedLines: 24,
  }),
]);

const SUPERVISED_TIMELINE: readonly CodingWorkbenchRuntimeEvent[] = Object.freeze([
  supervisedEvent(1, "task-submitted", {
    taskRef: "issue-1992",
    requestedMode: "supervised-coding",
    effectiveMode: "supervised-coding",
  }),
  supervisedEvent(2, "runtime-started", {
    runtimeSource: "codex-cli-adapter",
    modelSource: "chatgpt-codex-subscription-profile",
    requestedMode: "supervised-coding",
    effectiveMode: "supervised-coding",
  }),
  supervisedEvent(3, "observation-streamed", {
    channel: "status",
    byteCount: 0,
    truncated: false,
  }),
  supervisedEvent(4, "diff-summarized", {
    fileCount: 4,
    addedLines: 180,
    deletedLines: 12,
  }),
]);

const PERMISSION_REQUEST: CodingWorkbenchPermissionRequest = Object.freeze({
  requestId: "perm-1990-write",
  kind: "workspace-write",
  actionClass: "workspace-write",
  reasonCode: "approval-required",
  actionKind: "file-edit",
  scopeLabel: "workspace-scope",
  risk: "medium",
  policyReason: "approval-required",
  commandLabel: "workspace-write",
  expiresAt: "2026-07-07T19:30:00.000Z",
});

const SUPERVISED_DELIVERY_PERMISSION_REQUEST: CodingWorkbenchPermissionRequest = Object.freeze({
  requestId: "perm-1992-push",
  kind: "delivery-substrate",
  actionClass: "delivery-substrate",
  reasonCode: "approval-required",
  actionKind: "push",
  scopeLabel: "workspace-scope",
  risk: "high",
  policyReason: "approval-required",
  commandLabel: "push",
  expiresAt: "2026-07-07T23:10:00.000Z",
});

function projection(
  patch: Omit<CodingWorkbenchProjection, "authority" | "modeOptions">,
  authority: CodingWorkbenchAuthorityEnvelope = AUTHORITY,
): CodingWorkbenchProjection {
  return {
    authority,
    modeOptions: MODE_OPTIONS,
    ...patch,
  };
}

function supervisedProjection(
  patch: Omit<CodingWorkbenchProjection, "authority" | "modeOptions">,
): CodingWorkbenchProjection {
  return projection(patch, SUPERVISED_AUTHORITY);
}

export const CODING_WORKBENCH_PROJECTIONS = Object.freeze({
  empty: projection({
    runState: "empty",
    title: "Ready for a coding run",
    taskRef: "No task selected",
    currentStep: "Choose an authority mode, model source, and issue before starting.",
    sidecarHealth: "ready",
    progress: { completed: 0, total: 0, label: "No run active" },
    diff: { fileCount: 0, addedLines: 0, deletedLines: 0, label: "No file changes" },
    verification: {
      status: "not-started",
      label: "Verification has not started",
      passedCount: 0,
      failedCount: 0,
      skippedCount: 0,
    },
    deliveryStatus: "No delivery action queued",
    policyDenials: [],
    timeline: [],
  }),
  running: projection({
    runState: "running",
    title: "Issue #1990 Coding Workbench UI",
    taskRef: "github:issue/1990",
    currentStep: "Rendering governed workbench shell and timeline states.",
    sidecarHealth: "busy",
    progress: { completed: 3, total: 6, label: "3 of 6 work items complete" },
    diff: { fileCount: 6, addedLines: 420, deletedLines: 24, label: "6 files changed" },
    verification: {
      status: "running",
      label: "Local UI checks running",
      passedCount: 8,
      failedCount: 0,
      skippedCount: 0,
    },
    deliveryStatus: "Preparing issue branch evidence",
    policyDenials: [],
    timeline: RUNNING_TIMELINE,
  }),
  approvalRequired: projection({
    runState: "approval-required",
    title: "Issue #1990 Coding Workbench UI",
    taskRef: "github:issue/1990",
    currentStep: "Waiting for a supervised workspace-write approval.",
    sidecarHealth: "busy",
    progress: { completed: 3, total: 6, label: "Approval required before patch application" },
    diff: { fileCount: 6, addedLines: 420, deletedLines: 24, label: "Patch summary ready" },
    verification: {
      status: "partial",
      label: "Verification paused before write approval",
      passedCount: 8,
      failedCount: 0,
      skippedCount: 1,
    },
    deliveryStatus: "Blocked on just-in-time approval",
    policyDenials: [],
    permissionRequest: PERMISSION_REQUEST,
    timeline: [
      ...RUNNING_TIMELINE,
      event(5, "permission-requested", { permissionRequest: PERMISSION_REQUEST }),
    ],
  }),
  supervisedApprovalRequired: supervisedProjection({
    runState: "approval-required",
    title: "Issue #1992 Supervised Coding approval",
    taskRef: "github:issue/1992",
    currentStep: "Waiting for approval before delivery.",
    sidecarHealth: "busy",
    progress: { completed: 4, total: 7, label: "Scoped checks complete" },
    diff: { fileCount: 4, addedLines: 180, deletedLines: 12, label: "Scoped edit summary" },
    verification: {
      status: "passed",
      label: "Allowlisted checks passed",
      passedCount: 18,
      failedCount: 0,
      skippedCount: 0,
    },
    deliveryStatus: "Push requires one-time approval",
    policyDenials: [],
    permissionRequest: SUPERVISED_DELIVERY_PERMISSION_REQUEST,
    timeline: [
      ...SUPERVISED_TIMELINE,
      supervisedEvent(5, "verification-summarized", {
        verificationKind: "verification",
        verificationStatus: "passed",
        passedCount: 18,
        failedCount: 0,
        skippedCount: 0,
      }),
      supervisedEvent(6, "permission-requested", {
        permissionRequest: SUPERVISED_DELIVERY_PERMISSION_REQUEST,
      }),
    ],
  }),
  supervisedApproved: supervisedProjection({
    runState: "approved",
    title: "Issue #1992 Supervised Coding approved",
    taskRef: "github:issue/1992",
    currentStep: "Approval accepted.",
    sidecarHealth: "busy",
    progress: { completed: 5, total: 7, label: "Approval accepted" },
    diff: { fileCount: 4, addedLines: 180, deletedLines: 12, label: "Scoped edit summary" },
    verification: {
      status: "passed",
      label: "Verification stayed green",
      passedCount: 18,
      failedCount: 0,
      skippedCount: 0,
    },
    deliveryStatus: "Approved once for this scope",
    policyDenials: [],
    timeline: [
      ...SUPERVISED_TIMELINE,
      supervisedEvent(5, "artifact-produced", {
        artifactKind: "approval",
        artifactLabel: "approval-proof-accepted",
        artifactDigest: "f".repeat(64),
        artifactBytes: 0,
      }),
    ],
  }),
  supervisedDenied: supervisedProjection({
    runState: "denied",
    title: "Issue #1992 Supervised Coding denied",
    taskRef: "github:issue/1992",
    currentStep: "Operator denied delivery before execution.",
    sidecarHealth: "ready",
    progress: { completed: 4, total: 7, label: "Delivery action denied" },
    diff: { fileCount: 4, addedLines: 180, deletedLines: 12, label: "Scoped edit summary" },
    verification: {
      status: "passed",
      label: "Verification retained",
      passedCount: 18,
      failedCount: 0,
      skippedCount: 0,
    },
    deliveryStatus: "Denied before mutation",
    policyDenials: ["operator-denied"],
    timeline: [
      ...SUPERVISED_TIMELINE,
      supervisedEvent(5, "failure-redacted", {
        failureCode: "operator-denied",
        failureSummary: "operator-denied",
        retryable: false,
      }),
    ],
  }),
  supervisedStopped: supervisedProjection({
    runState: "stopped",
    title: "Issue #1992 Supervised Coding stopped",
    taskRef: "github:issue/1992",
    currentStep: "Operator stopped before approval.",
    sidecarHealth: "stopped",
    progress: { completed: 4, total: 7, label: "Run stopped" },
    diff: { fileCount: 4, addedLines: 180, deletedLines: 12, label: "Scoped edit summary" },
    verification: {
      status: "partial",
      label: "Checks stopped before closeout",
      passedCount: 12,
      failedCount: 0,
      skippedCount: 1,
    },
    deliveryStatus: "Stopped before mutation",
    policyDenials: ["operator-stopped"],
    timeline: [
      ...SUPERVISED_TIMELINE,
      supervisedEvent(5, "runtime-stopped", {
        runtimeSource: "codex-cli-adapter",
        modelSource: "chatgpt-codex-subscription-profile",
        health: "stopped",
        effectiveMode: "supervised-coding",
      }),
    ],
  }),
  supervisedFailed: supervisedProjection({
    runState: "failed",
    title: "Issue #1992 Supervised Coding failed",
    taskRef: "github:issue/1992",
    currentStep: "Redacted verification failure stopped delivery.",
    sidecarHealth: "degraded",
    progress: { completed: 4, total: 7, label: "Failure recorded" },
    diff: { fileCount: 4, addedLines: 180, deletedLines: 12, label: "Scoped edit summary" },
    verification: {
      status: "failed",
      label: "Verification failed with redacted output",
      passedCount: 17,
      failedCount: 1,
      skippedCount: 0,
    },
    deliveryStatus: "Delivery blocked by verification",
    policyDenials: ["redacted-failure"],
    timeline: [
      ...SUPERVISED_TIMELINE,
      supervisedEvent(5, "verification-summarized", {
        verificationKind: "verification",
        verificationStatus: "failed",
        passedCount: 17,
        failedCount: 1,
        skippedCount: 0,
      }),
      supervisedEvent(6, "failure-redacted", {
        failureCode: "redacted-failure",
        failureSummary: "redacted-failure",
        retryable: true,
      }),
    ],
  }),
  blocked: projection({
    runState: "blocked",
    title: "Issue #1990 Coding Workbench UI",
    taskRef: "github:issue/1990",
    currentStep: "Policy denied a network-egress request outside connector scope.",
    sidecarHealth: "degraded",
    progress: { completed: 3, total: 6, label: "Run paused by policy" },
    diff: { fileCount: 6, addedLines: 420, deletedLines: 24, label: "Patch summary retained" },
    verification: {
      status: "partial",
      label: "Verification waiting for policy resolution",
      passedCount: 8,
      failedCount: 0,
      skippedCount: 1,
    },
    deliveryStatus: "Delivery held by policy review",
    policyDenials: ["network-egress denied outside connector-scoped policy"],
    timeline: [
      ...RUNNING_TIMELINE,
      event(5, "failure-redacted", {
        failureCode: "policy-denied",
        failureSummary: "policy-denied",
        retryable: true,
      }),
    ],
  }),
  governedAssist: GOVERNED_ASSIST_PROJECTIONS.proposed,
  governedAssistBlocked: GOVERNED_ASSIST_PROJECTIONS.blocked,
  autonomousConfirmed: AUTONOMOUS_DELIVERY_PROJECTIONS.confirmed,
  autonomousPolicyBlocked: AUTONOMOUS_DELIVERY_PROJECTIONS.policyBlocked,
  autonomousVerificationFailed: AUTONOMOUS_DELIVERY_PROJECTIONS.verificationFailed,
  autonomousCompleted: AUTONOMOUS_DELIVERY_PROJECTIONS.completed,
  failed: projection({
    runState: "failed",
    title: "Issue #1990 Coding Workbench UI",
    taskRef: "github:issue/1990",
    currentStep: "Runtime stopped before verification completed.",
    sidecarHealth: "stopped",
    progress: { completed: 4, total: 6, label: "Run failed before closeout" },
    diff: { fileCount: 6, addedLines: 420, deletedLines: 24, label: "Patch summary available" },
    verification: {
      status: "failed",
      label: "One verification gate failed",
      passedCount: 10,
      failedCount: 1,
      skippedCount: 0,
    },
    deliveryStatus: "Needs operator repair",
    policyDenials: [],
    timeline: [
      ...RUNNING_TIMELINE,
      event(5, "verification-summarized", {
        verificationKind: "verification",
        verificationStatus: "failed",
        passedCount: 10,
        failedCount: 1,
        skippedCount: 0,
      }),
    ],
  }),
  completed: projection({
    runState: "completed",
    title: "Issue #1990 Coding Workbench UI",
    taskRef: "github:issue/1990",
    currentStep: "Run completed and delivery evidence is ready for review.",
    sidecarHealth: "ready",
    progress: { completed: 6, total: 6, label: "All work items complete" },
    diff: { fileCount: 6, addedLines: 420, deletedLines: 24, label: "Patch summary complete" },
    verification: {
      status: "passed",
      label: "All local checks passed",
      passedCount: 12,
      failedCount: 0,
      skippedCount: 0,
    },
    deliveryStatus: "Ready for issue PR handoff",
    policyDenials: [],
    timeline: [
      ...RUNNING_TIMELINE,
      event(5, "verification-summarized", {
        verificationKind: "verification",
        verificationStatus: "passed",
        passedCount: 12,
        failedCount: 0,
        skippedCount: 0,
      }),
      event(6, "artifact-produced", {
        artifactKind: "artifact",
        artifactLabel: "verification-green",
        artifactDigest: "8".repeat(64),
        artifactBytes: 2048,
      }),
    ],
  }),
} as const);

const PROJECTION_BY_STATE: ReadonlyMap<string, CodingWorkbenchProjection> = new Map([
  ["running", CODING_WORKBENCH_PROJECTIONS.running],
  ["approval-required", CODING_WORKBENCH_PROJECTIONS.approvalRequired],
  ["supervised-approval-required", CODING_WORKBENCH_PROJECTIONS.supervisedApprovalRequired],
  ["supervised-approved", CODING_WORKBENCH_PROJECTIONS.supervisedApproved],
  ["supervised-denied", CODING_WORKBENCH_PROJECTIONS.supervisedDenied],
  ["supervised-stopped", CODING_WORKBENCH_PROJECTIONS.supervisedStopped],
  ["supervised-failed", CODING_WORKBENCH_PROJECTIONS.supervisedFailed],
  ["blocked", CODING_WORKBENCH_PROJECTIONS.blocked],
  ["governed-assist", CODING_WORKBENCH_PROJECTIONS.governedAssist],
  ["governed-assist-blocked", CODING_WORKBENCH_PROJECTIONS.governedAssistBlocked],
  ["autonomous-confirmed", CODING_WORKBENCH_PROJECTIONS.autonomousConfirmed],
  ["autonomous-policy-blocked", CODING_WORKBENCH_PROJECTIONS.autonomousPolicyBlocked],
  ["autonomous-verification-failed", CODING_WORKBENCH_PROJECTIONS.autonomousVerificationFailed],
  ["autonomous-completed", CODING_WORKBENCH_PROJECTIONS.autonomousCompleted],
  ["failed", CODING_WORKBENCH_PROJECTIONS.failed],
  ["completed", CODING_WORKBENCH_PROJECTIONS.completed],
]);

export function codingWorkbenchProjectionForState(
  state: string | undefined,
): CodingWorkbenchProjection {
  if (state === undefined) return CODING_WORKBENCH_PROJECTIONS.empty;
  return PROJECTION_BY_STATE.get(state) ?? CODING_WORKBENCH_PROJECTIONS.empty;
}
