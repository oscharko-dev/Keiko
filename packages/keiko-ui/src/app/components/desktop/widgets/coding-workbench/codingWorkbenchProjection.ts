import {
  CODING_WORKBENCH_SCHEMA_VERSION,
  type CodingWorkbenchAuthorityEnvelope,
  type CodingWorkbenchMode,
  type CodingWorkbenchPermissionRequest,
  type CodingWorkbenchRuntimeEvent,
  type CodingWorkbenchRuntimeHealth,
} from "@oscharko-dev/keiko-contracts";

export type CodingWorkbenchRunState =
  "empty" | "running" | "approval-required" | "blocked" | "failed" | "completed";

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

const RUN_ID = "cw-issue-1990";

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
  taskRefs: ["github:issue/1990"],
  workspace: {
    workspaceId: "workspace-keiko-redacted",
    rootLabel: "Keiko",
    rootDigest: "root-digest-redacted",
  },
  branch: {
    baseRef: "epic/coding-workbench-opencode-codex",
    headRef: "issue/1990-coding-workbench-ui",
    allowDetachedHead: false,
    allowedPrefixes: ["issue/", "epic/"],
  },
  requestedMode: "supervised-coding",
  deploymentCeiling: "supervised-coding",
  effectiveMode: "supervised-coding",
  runtimeSource: "codex-cli-adapter",
  actionClasses: ["workspace-read", "workspace-write", "command-execution", "verification"],
  connectorScopes: ["source-control.read", "issue-tracker.read"],
  modelProfile: {
    profileId: "profile-codex-subscription-redacted",
    source: "chatgpt-codex-subscription-profile",
    supportsStreaming: true,
    supportsToolCalling: true,
  },
  commandPolicy: {
    mode: "governed",
    allow: ["npm run typecheck", "npm run lint", "npm test"],
    deny: ["unguarded-secret-read", "unscoped-network-egress"],
    maxCommandTimeoutMs: 600_000,
    requirePerCommandApproval: true,
  },
  networkPolicy: {
    mode: "connector-scoped-egress",
    allowLoopback: true,
    connectorScopes: ["source-control.read", "issue-tracker.read"],
  },
  gates: ["human-approval", "branch-allowlist", "verification-green", "policy-review"],
  budget: {
    maxRuntimeMs: 7_200_000,
    maxToolCalls: 120,
    maxPromptTokens: 200_000,
    maxPatchBytes: 500_000,
  },
  expiresAt: "2026-07-08T00:00:00.000Z",
  approvalProofDigest: "approval-proof-redacted",
};

function event(
  sequence: number,
  kind: CodingWorkbenchRuntimeEvent["kind"],
  patch: Partial<CodingWorkbenchRuntimeEvent> = {},
): CodingWorkbenchRuntimeEvent {
  return {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    eventId: `cw-1990-${String(sequence)}`,
    runId: RUN_ID,
    occurredAt: `2026-07-07T18:${String(10 + sequence).padStart(2, "0")}:00.000Z`,
    kind,
    sequence,
    ...patch,
  };
}

const RUNNING_TIMELINE: readonly CodingWorkbenchRuntimeEvent[] = Object.freeze([
  event(1, "task-submitted", {
    taskRef: "github:issue/1990",
    requestedMode: "supervised-coding",
    effectiveMode: "supervised-coding",
  }),
  event(2, "runtime-started", {
    runtimeSource: "codex-cli-adapter",
    modelSource: "chatgpt-codex-subscription-profile",
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

const PERMISSION_REQUEST: CodingWorkbenchPermissionRequest = Object.freeze({
  requestId: "perm-1990-write",
  kind: "workspace-write",
  actionClass: "workspace-write",
  reasonCode: "apply-redacted-ui-patch",
  commandLabel: "workspace patch",
  expiresAt: "2026-07-07T19:30:00.000Z",
});

function projection(
  patch: Omit<CodingWorkbenchProjection, "authority" | "modeOptions">,
): CodingWorkbenchProjection {
  return {
    authority: AUTHORITY,
    modeOptions: MODE_OPTIONS,
    ...patch,
  };
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
        failureSummary: "Governance policy denied a privileged request.",
        retryable: true,
      }),
    ],
  }),
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
        verificationKind: "ui",
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
        verificationKind: "ui",
        verificationStatus: "passed",
        passedCount: 12,
        failedCount: 0,
        skippedCount: 0,
      }),
      event(6, "artifact-produced", {
        artifactKind: "evidence",
        artifactLabel: "content-free verification receipt",
        artifactDigest: "artifact-digest-redacted",
        artifactBytes: 2048,
      }),
    ],
  }),
} as const);

export function codingWorkbenchProjectionForState(
  state: string | undefined,
): CodingWorkbenchProjection {
  if (state === "running") return CODING_WORKBENCH_PROJECTIONS.running;
  if (state === "approval-required") return CODING_WORKBENCH_PROJECTIONS.approvalRequired;
  if (state === "blocked") return CODING_WORKBENCH_PROJECTIONS.blocked;
  if (state === "failed") return CODING_WORKBENCH_PROJECTIONS.failed;
  if (state === "completed") return CODING_WORKBENCH_PROJECTIONS.completed;
  return CODING_WORKBENCH_PROJECTIONS.empty;
}
