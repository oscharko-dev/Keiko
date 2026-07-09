import {
  CODING_WORKBENCH_SCHEMA_VERSION,
  type CodingWorkbenchAuthorityEnvelope,
  type CodingWorkbenchRuntimeEvent,
} from "@oscharko-dev/keiko-contracts";
import type {
  CodingWorkbenchModeOption,
  CodingWorkbenchProjection,
} from "./codingWorkbenchProjection";

const RUN_ID = "run-1991";

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
  taskRefs: ["issue-1991"],
  workspace: {
    workspaceId: "workspace-keiko",
    rootLabel: "keiko-workspace",
    rootDigest: "d".repeat(64),
  },
  branch: {
    baseRef: "dev",
    headRef: "issue/1991-governed",
    allowDetachedHead: false,
    allowedPrefixes: ["issue/", "codex/"],
  },
  requestedMode: "governed-assist",
  deploymentCeiling: "governed-assist",
  effectiveMode: "governed-assist",
  runtimeSource: "codex-cli-adapter",
  actionClasses: ["workspace-read", "verification", "connector-access"],
  connectorScopes: ["source-control.read", "issue-tracker.read"],
  modelProfile: {
    profileId: "profile-codex-subscription-redacted",
    source: "chatgpt-codex-subscription-profile",
    supportsStreaming: true,
    supportsToolCalling: true,
  },
  commandPolicy: {
    mode: "deny",
    allow: [],
    deny: ["curl"],
    maxCommandTimeoutMs: 600_000,
    requirePerCommandApproval: true,
  },
  networkPolicy: {
    mode: "deny-all",
    allowLoopback: false,
    connectorScopes: [],
  },
  gates: ["human-approval", "policy-review", "artifact-review"],
  budget: {
    maxRuntimeMs: 1_800_000,
    maxToolCalls: 40,
    maxPromptTokens: 120_000,
    maxPatchBytes: 240_000,
  },
  expiresAt: "2026-07-08T00:00:00.000Z",
  approvalProofDigest: "e".repeat(64),
};

function event(
  sequence: number,
  kind: CodingWorkbenchRuntimeEvent["kind"],
  patch: Partial<CodingWorkbenchRuntimeEvent> = {},
): CodingWorkbenchRuntimeEvent {
  const baseEvent = {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    eventId: `evt-1991-${String(sequence)}`,
    runId: RUN_ID,
    occurredAt: `2026-07-07T20:${String(10 + sequence).padStart(2, "0")}:00.000Z`,
    kind,
  };
  return kind === "observation-streamed"
    ? { ...baseEvent, sequence, ...patch }
    : { ...baseEvent, ...patch };
}

const TIMELINE: readonly CodingWorkbenchRuntimeEvent[] = Object.freeze([
  event(1, "task-submitted", {
    taskRef: "issue-1991",
    requestedMode: "governed-assist",
    effectiveMode: "governed-assist",
  }),
  event(2, "runtime-started", {
    runtimeSource: "codex-cli-adapter",
    modelSource: "chatgpt-codex-subscription-profile",
    requestedMode: "governed-assist",
    effectiveMode: "governed-assist",
  }),
  event(3, "diff-summarized", { fileCount: 3, addedLines: 120, deletedLines: 14 }),
]);

function projection(
  patch: Omit<CodingWorkbenchProjection, "authority" | "modeOptions">,
): CodingWorkbenchProjection {
  return { authority: AUTHORITY, modeOptions: MODE_OPTIONS, ...patch };
}

export const GOVERNED_ASSIST_PROJECTIONS = Object.freeze({
  proposed: projection({
    runState: "governed-assist",
    title: "Issue #1991 Governed Assist proposal",
    taskRef: "github:issue/1991",
    currentStep: "Planning and proposing a diff without applying workspace changes.",
    sidecarHealth: "busy",
    progress: { completed: 2, total: 4, label: "Proposed diff generated without mutation" },
    diff: { fileCount: 3, addedLines: 120, deletedLines: 14, label: "Proposed diff only" },
    verification: {
      status: "not-started",
      label: "Verification awaits operator-applied changes",
      passedCount: 0,
      failedCount: 0,
      skippedCount: 0,
    },
    deliveryStatus: "No file, Git, PR, merge, or external write authority",
    policyDenials: [],
    timeline: TIMELINE,
  }),
  blocked: projection({
    runState: "governed-assist-blocked",
    title: "Issue #1991 Governed Assist blocked action",
    taskRef: "github:issue/1991",
    currentStep: "Governed Assist blocked a write before mutation.",
    sidecarHealth: "degraded",
    progress: { completed: 2, total: 4, label: "Action denied before workspace mutation" },
    diff: { fileCount: 3, addedLines: 120, deletedLines: 14, label: "Proposed diff retained" },
    verification: {
      status: "partial",
      label: "Run held by read-only policy",
      passedCount: 0,
      failedCount: 0,
      skippedCount: 1,
    },
    deliveryStatus: "Blocked before commit, push, PR, merge, or external write",
    policyDenials: [
      "workspace-write denied in Governed Assist; review the proposed diff manually",
      "command-execution denied; mutating shell and Git actions require Supervised Coding",
      "connector-write denied; external systems stay read-only",
    ],
    timeline: [
      ...TIMELINE,
      event(4, "failure-redacted", {
        failureCode: "workspace-write-denied",
        failureSummary: "workspace-write-denied",
        retryable: false,
      }),
    ],
  }),
} as const);
