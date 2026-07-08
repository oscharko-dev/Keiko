import {
  CODING_WORKBENCH_SCHEMA_VERSION,
  type CodingWorkbenchAuthorityEnvelope,
  type CodingWorkbenchRuntimeEvent,
} from "@oscharko-dev/keiko-contracts";
import type {
  CodingWorkbenchModeOption,
  CodingWorkbenchProjection,
} from "./codingWorkbenchProjection";

const RUN_ID = "cw-issue-1994";
const DIGEST = "9".repeat(64);

const AUTONOMOUS_MODE_OPTIONS: readonly CodingWorkbenchModeOption[] = Object.freeze([
  { mode: "governed-assist", enabled: true },
  { mode: "supervised-coding", enabled: true },
  { mode: "autonomous-delivery", enabled: true },
]);

const AUTONOMOUS_AUTHORITY = {
  schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
  runId: RUN_ID,
  localUser: "local-operator",
  taskRefs: ["github:issue/1994"],
  workspace: {
    workspaceId: "workspace-keiko-redacted",
    rootLabel: "Keiko",
    rootDigest: DIGEST,
  },
  branch: {
    baseRef: "epic/coding-workbench-opencode-codex",
    headRef: "issue/1994-coding-autonomy-qa-matrix",
    allowDetachedHead: false,
    allowedPrefixes: ["issue/"],
  },
  requestedMode: "autonomous-delivery",
  deploymentCeiling: "autonomous-delivery",
  effectiveMode: "autonomous-delivery",
  runtimeSource: "delivery-runner",
  actionClasses: [
    "workspace-read",
    "workspace-write",
    "command-execution",
    "verification",
    "connector-access",
    "network-egress",
    "delivery-substrate",
  ],
  connectorScopes: ["source-control.read", "source-control.write", "issue-tracker.write"],
  modelProfile: {
    profileId: "profile-gateway-redacted",
    source: "keiko-model-gateway",
    supportsStreaming: true,
    supportsToolCalling: true,
  },
  commandPolicy: {
    mode: "governed",
    allow: ["typecheck", "lint", "test", "arch-check"],
    deny: ["unknown-command-denied", "unguarded-secret-read"],
    maxCommandTimeoutMs: 600_000,
    requirePerCommandApproval: false,
  },
  networkPolicy: {
    mode: "connector-scoped-egress",
    allowLoopback: true,
    connectorScopes: ["source-control.read", "source-control.write", "issue-tracker.write"],
  },
  gates: ["human-approval", "branch-allowlist", "verification-green", "policy-review"],
  budget: {
    maxRuntimeMs: 7_200_000,
    maxToolCalls: 120,
    maxPromptTokens: 200_000,
    maxPatchBytes: 500_000,
  },
  expiresAt: "2026-07-08T23:59:59.000Z",
  approvalProofDigest: DIGEST,
} as const satisfies CodingWorkbenchAuthorityEnvelope;

function event(
  sequence: number,
  kind: CodingWorkbenchRuntimeEvent["kind"],
  patch: Partial<CodingWorkbenchRuntimeEvent> = {},
): CodingWorkbenchRuntimeEvent {
  return {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    eventId: `cw-1994-${String(sequence)}`,
    runId: RUN_ID,
    occurredAt: `2026-07-08T10:${String(10 + sequence).padStart(2, "0")}:00.000Z`,
    kind,
    sequence,
    ...patch,
  };
}

const BASE_TIMELINE: readonly CodingWorkbenchRuntimeEvent[] = Object.freeze([
  event(1, "task-submitted", {
    taskRef: "github:issue/1994",
    requestedMode: "autonomous-delivery",
    effectiveMode: "autonomous-delivery",
  }),
  event(2, "runtime-started", {
    runtimeSource: "delivery-runner",
    modelSource: "keiko-model-gateway",
  }),
  event(3, "observation-streamed", {
    channel: "status",
    byteCount: 0,
    truncated: false,
  }),
]);

function autonomousProjection(
  patch: Omit<CodingWorkbenchProjection, "authority" | "modeOptions">,
): CodingWorkbenchProjection {
  return {
    authority: AUTONOMOUS_AUTHORITY,
    modeOptions: AUTONOMOUS_MODE_OPTIONS,
    ...patch,
  };
}

export const AUTONOMOUS_DELIVERY_PROJECTIONS = Object.freeze({
  confirmed: autonomousProjection({
    runState: "running",
    title: "Issue #1994 Autonomous Delivery confirmed envelope",
    taskRef: "github:issue/1994",
    currentStep: "Executing bounded issue-to-PR delivery inside the confirmed envelope.",
    sidecarHealth: "busy",
    progress: { completed: 5, total: 8, label: "Envelope-bound steps running" },
    diff: { fileCount: 5, addedLines: 260, deletedLines: 18, label: "Content-free change summary" },
    verification: {
      status: "running",
      label: "Governed verification running",
      passedCount: 24,
      failedCount: 0,
      skippedCount: 0,
    },
    deliveryStatus: "Governed PR gateway handoff pending",
    policyDenials: [],
    timeline: [
      ...BASE_TIMELINE,
      event(4, "diff-summarized", { fileCount: 5, addedLines: 260, deletedLines: 18 }),
      event(5, "verification-summarized", {
        verificationKind: "matrix",
        verificationStatus: "partial",
        passedCount: 24,
        failedCount: 0,
        skippedCount: 0,
      }),
    ],
  }),
  policyBlocked: autonomousProjection({
    runState: "blocked",
    title: "Issue #1994 Autonomous Delivery policy hold",
    taskRef: "github:issue/1994",
    currentStep: "Policy blocked delivery before connector or PR mutation.",
    sidecarHealth: "degraded",
    progress: { completed: 3, total: 8, label: "Run paused by policy" },
    diff: { fileCount: 2, addedLines: 48, deletedLines: 4, label: "Patch summary retained" },
    verification: {
      status: "partial",
      label: "Verification paused",
      passedCount: 12,
      failedCount: 0,
      skippedCount: 1,
    },
    deliveryStatus: "No provider write executed",
    policyDenials: ["authority-expired", "connector-scope-missing"],
    timeline: [
      ...BASE_TIMELINE,
      event(4, "failure-redacted", {
        failureCode: "authority-expired",
        failureSummary: "authority-expired",
        retryable: true,
      }),
    ],
  }),
  verificationFailed: autonomousProjection({
    runState: "failed",
    title: "Issue #1994 Autonomous Delivery verification failed",
    taskRef: "github:issue/1994",
    currentStep: "Verification failed, so delivery stopped before PR handoff.",
    sidecarHealth: "degraded",
    progress: { completed: 6, total: 8, label: "Verification gate failed" },
    diff: { fileCount: 5, addedLines: 260, deletedLines: 18, label: "Content-free change summary" },
    verification: {
      status: "failed",
      label: "Verification failed with redacted output",
      passedCount: 31,
      failedCount: 1,
      skippedCount: 0,
    },
    deliveryStatus: "PR creation blocked by verification",
    policyDenials: ["verification-failed"],
    timeline: [
      ...BASE_TIMELINE,
      event(4, "verification-summarized", {
        verificationKind: "test",
        verificationStatus: "failed",
        passedCount: 31,
        failedCount: 1,
        skippedCount: 0,
      }),
      event(5, "failure-redacted", {
        failureCode: "verification-failed",
        failureSummary: "verification-failed",
        retryable: true,
      }),
    ],
  }),
  completed: autonomousProjection({
    runState: "completed",
    title: "Issue #1994 Autonomous Delivery PR handoff",
    taskRef: "github:issue/1994",
    currentStep: "Draft PR handoff is ready with content-free verification evidence.",
    sidecarHealth: "ready",
    progress: { completed: 8, total: 8, label: "All envelope steps complete" },
    diff: { fileCount: 5, addedLines: 260, deletedLines: 18, label: "Content-free change summary" },
    verification: {
      status: "passed",
      label: "All closeout gates passed",
      passedCount: 42,
      failedCount: 0,
      skippedCount: 0,
    },
    deliveryStatus: "Draft PR created through governed PR gateway",
    policyDenials: [],
    timeline: [
      ...BASE_TIMELINE,
      event(4, "verification-summarized", {
        verificationKind: "matrix",
        verificationStatus: "passed",
        passedCount: 42,
        failedCount: 0,
        skippedCount: 0,
      }),
      event(5, "artifact-produced", {
        artifactKind: "pull-request",
        artifactLabel: "governed-pr-gateway-handoff",
        artifactDigest: DIGEST,
        artifactBytes: 0,
      }),
    ],
  }),
} as const satisfies Readonly<Record<string, CodingWorkbenchProjection>>);
