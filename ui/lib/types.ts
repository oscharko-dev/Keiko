/**
 * Local mirror of the BFF↔UI contract types (ADR-0011 D5).
 * Do NOT import from src/ — these are declaration mirrors only.
 * Keep in sync with the seam types in src/gateway, src/harness, src/audit, src/workflows.
 */

// ---------------------------------------------------------------------------
// Gateway — model capability registry
// ---------------------------------------------------------------------------

export type CostClass = "low" | "medium" | "high";
export type LatencyClass = "fast" | "medium" | "slow";
export type ModelKind = "chat" | "embedding" | "ocr-vision";

export interface ModelCapability {
  id: string;
  kind: ModelKind;
  contextWindow: number;
  maxOutputTokens: number;
  toolCalling: boolean;
  structuredOutput: boolean;
  streaming: boolean;
  costClass: CostClass;
  latencyClass: LatencyClass;
  throughputHint: string;
  preferredUseCases: readonly string[];
  knownLimitations: readonly string[];
}

// ---------------------------------------------------------------------------
// Gateway — safe config (no apiKey)
// ---------------------------------------------------------------------------

export interface SafeProviderConfig {
  readonly name: string;
  readonly modelId: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly retries: number;
}

export interface SafeGatewayConfig {
  readonly providers: readonly SafeProviderConfig[];
}

// ---------------------------------------------------------------------------
// Workflows — descriptors
// ---------------------------------------------------------------------------

export type WorkflowInputType = "string" | "boolean" | "string[]" | "object";

export interface WorkflowInputSpec {
  name: string;
  type: WorkflowInputType;
  required: boolean;
  description: string;
  defaultValue?: unknown;
}

export interface WorkflowModelOptions {
  arbitrary: boolean;
  preferredCostClass: CostClass;
}

export interface WorkflowDescriptor {
  workflowId: string;
  name: string;
  description: string;
  inputs: WorkflowInputSpec[];
  defaultLimits: Record<string, unknown>;
  modelSelectionOptions: WorkflowModelOptions;
  supportsDryRun: boolean;
  supportsApply: boolean;
}

export interface ExplainPlanInputSpec {
  inputs: Array<{ name: string; type: WorkflowInputType; required: boolean }>;
}

export interface WorkflowsResponse {
  descriptors: WorkflowDescriptor[];
  explainPlan: ExplainPlanInputSpec;
}

// ---------------------------------------------------------------------------
// Harness — HarnessEvent union
// ---------------------------------------------------------------------------

type BaseEvent = {
  schemaVersion: "1";
  runId: string;
  fingerprint: string;
  seq: number;
  ts: string;
};

export type UsageMetadata = {
  requestId: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
};

export type HarnessEvent =
  | (BaseEvent & {
      type: "run:started";
      taskType: string;
      modelId: string;
      limits: Record<string, number>;
    })
  | (BaseEvent & {
      type: "state:transition";
      from: string;
      to: string;
      reason?: string;
    })
  | (BaseEvent & {
      type: "model:call:started";
      modelId: string;
      messageCount: number;
      contextBytes: number;
    })
  | (BaseEvent & {
      type: "model:call:completed";
      modelId: string;
      finishReason: string;
      toolCallCount: number;
      usage: UsageMetadata;
    })
  | (BaseEvent & {
      type: "model:call:failed";
      modelId: string;
      errorCode: string;
      message: string;
    })
  | (BaseEvent & {
      type: "tool:call:started";
      toolName: string;
      toolCallId: string;
    })
  | (BaseEvent & {
      type: "tool:call:completed";
      toolName: string;
      toolCallId: string;
      durationMs: number;
    })
  | (BaseEvent & {
      type: "tool:call:failed";
      toolName: string;
      toolCallId: string;
      errorCode: string;
      message: string;
    })
  | (BaseEvent & {
      type: "reasoning:trace";
      phase: string;
      rationale?: string;
      modelResponse?: string;
    })
  | (BaseEvent & {
      type: "patch:proposed";
      targetFile: string;
      patchBytes: number;
      diff?: string;
    })
  | (BaseEvent & {
      type: "verification:result";
      passed: boolean;
      detail: string;
    })
  | (BaseEvent & {
      type: "run:completed";
      report?: unknown;
      patchDiff?: string;
    })
  | (BaseEvent & {
      type: "run:cancelled";
      atState: string;
      reason?: string;
    })
  | (BaseEvent & {
      type: "run:failed";
      failure: { category: string; message: string; detail?: string };
      atState: string;
    });

export type HarnessEventType = HarnessEvent["type"];
export type TerminalEventType = "run:completed" | "run:cancelled" | "run:failed";

export const TERMINAL_EVENT_TYPES = new Set<string>([
  "run:completed",
  "run:cancelled",
  "run:failed",
]);

// ---------------------------------------------------------------------------
// Audit / Evidence
// ---------------------------------------------------------------------------

export type EvidenceOutcome =
  | "completed"
  | "cancelled"
  | "failed"
  | "limit-exceeded";

export interface EvidenceListEntry {
  runId: string;
  taskType: string;
  outcome: EvidenceOutcome;
  startedAt: string;
  finishedAt: string;
}

export interface EvidenceRunIdentity {
  runId: string;
  fingerprint: string;
  harnessVersion: string;
  taskType: string;
  outcome: EvidenceOutcome;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export type VerificationStatus =
  | "passed"
  | "failed"
  | "skipped"
  | "denied"
  | "timed-out"
  | "cancelled"
  | "resource-exceeded";

export interface ResourceLimitDecision {
  dimension: "wall-time" | "output-size" | "memory" | "network";
  limit: number;
  enforced: boolean;
  note?: string;
  breached?: boolean;
}

export interface AuditResultEntry {
  kind: "test" | "targeted-test" | "typecheck" | "lint" | "build";
  scriptName?: string;
  command: string;
  status: VerificationStatus;
  exitCode: number;
  durationMs: number;
  truncated: boolean;
  appliedLimits: ResourceLimitDecision[];
}

export interface VerificationAuditSummary {
  workspaceRoot: string;
  overallStatus: VerificationStatus;
  durationMs: number;
  counts: Partial<Record<VerificationStatus, number>>;
  results: AuditResultEntry[];
}

export interface EvidencePatch {
  proposed: boolean;
  applied: boolean;
  targetFileCount: number;
  patchBytes: number;
  changedFiles: string[];
  created: string[];
  deleted: string[];
  redactedDiff?: string;
}

export interface EvidenceReasoningEntry {
  seq: number;
  ts: string;
  phase: string;
  rationale?: string;
  modelResponse?: string;
}

export interface EvidenceManifest {
  evidenceSchemaVersion: "1";
  run: EvidenceRunIdentity;
  model: { modelId: string; costClass: CostClass };
  usageTotals: {
    promptTokens: number;
    completionTokens: number;
    requestCount: number;
    totalLatencyMs: number;
  };
  context?: unknown;
  stateTransitions: Array<{ from: string; to: string; ts: string; reason?: string }>;
  toolCalls: Array<{ toolName: string; durationMs?: number; status: string }>;
  commandExecutions: Array<{ command: string; exitCode: number; durationMs: number }>;
  patch?: EvidencePatch;
  verification?: VerificationAuditSummary;
  failure?: { category: string; message: string };
  reasoning?: EvidenceReasoningEntry[];
}

// ---------------------------------------------------------------------------
// BFF run report projection
// ---------------------------------------------------------------------------

export type RunStatus =
  | "completed"
  | "dry-run"
  | "rejected"
  | "cancelled"
  | "failed"
  | "fix-applied"
  | "fix-proposed"
  | "investigation-only";

export interface ChangedFile {
  path: string;
  kind: string;
  addedLines: number;
  removedLines: number;
  elevatedReview: boolean;
}

export interface RunReport {
  status: RunStatus;
  modelId?: string;
  durationMs?: number;
  proposedDiff?: string;
  dryRunPreview?: string;
  changedFiles?: ChangedFile[];
  addedTestFiles?: Array<{ path: string; estimatedTestCount?: number }>;
  verificationSummary?: VerificationAuditSummary;
  usage?: UsageMetadata;
}

// ---------------------------------------------------------------------------
// BFF error envelope
// ---------------------------------------------------------------------------

export type BffErrorCode =
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "NOT_APPLIABLE"
  | "EVIDENCE_SCHEMA"
  | "INTERNAL";

export interface BffError {
  error: { code: BffErrorCode | string; message: string };
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

export type SseStatus = "connecting" | "live" | "terminal" | "error";
