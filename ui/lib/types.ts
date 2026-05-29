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
    })
  // Harness tool-pipeline audit events (S-M1 — counts/flags only, no content)
  | (BaseEvent & {
      type: "command:executed";
      executable: string;
      argCount: number;
      exitCode: number | null;
      timedOut: boolean;
      durationMs: number;
    })
  | (BaseEvent & {
      type: "patch:applied";
      changedFiles: number;
      created: number;
      deleted: number;
    })
  // Unit-test workflow events (src/workflows/unit-tests/events.ts)
  | (BaseEvent & { type: "workflow:started"; workflowId: string; modelId: string; applyEnabled: boolean; limits: Record<string, unknown> })
  | (BaseEvent & { type: "conventions:detected"; framework: string; testDirs: readonly string[]; fileNamingStyle: string })
  | (BaseEvent & { type: "context:selected"; entryCount: number; usedBytes: number; budgetBytes: number; droppedForBudget: number })
  | (BaseEvent & { type: "workflow:model:call:started"; attempt: number; contextBytes: number })
  | (BaseEvent & { type: "workflow:model:call:completed"; attempt: number; finishReason: string; promptTokens: number; completionTokens: number; latencyMs: number })
  | (BaseEvent & { type: "patch:validated"; ok: boolean; patchBytes: number; filesChanged: number; rejectionCode?: string })
  | (BaseEvent & { type: "workflow:patch:applied"; changedFiles: number; created: number; deleted: number })
  | (BaseEvent & { type: "workflow:verification:result"; overallStatus: string; stepCount: number; passedCount: number; durationMs: number })
  | (BaseEvent & { type: "workflow:completed"; status: string; durationMs: number })
  | (BaseEvent & { type: "workflow:failed"; errorCode: string; message: string })
  // Bug-investigation workflow events (src/workflows/bug-investigation/events.ts)
  | (BaseEvent & { type: "bug:started"; workflowId: string; modelId: string; applyEnabled: boolean; limits: Record<string, unknown> })
  | (BaseEvent & { type: "bug:failure:parsed"; frameCount: number; messageCount: number })
  | (BaseEvent & { type: "bug:context:selected"; entryCount: number; usedBytes: number; budgetBytes: number; droppedForBudget: number })
  | (BaseEvent & { type: "bug:model:call:started"; attempt: number; contextBytes: number })
  | (BaseEvent & { type: "bug:model:call:completed"; attempt: number; finishReason: string; promptTokens: number; completionTokens: number; latencyMs: number })
  | (BaseEvent & { type: "bug:rootcause:proposed"; hasPatch: boolean; confidence?: "low" | "medium" | "high" })
  | (BaseEvent & { type: "bug:patch:validated"; ok: boolean; patchBytes: number; filesChanged: number; rejectionCode?: string })
  | (BaseEvent & { type: "bug:patch:applied"; changedFiles: number; created: number; deleted: number })
  | (BaseEvent & { type: "bug:verification:result"; overallStatus: string; stepCount: number; passedCount: number; durationMs: number })
  | (BaseEvent & { type: "bug:completed"; status: string; durationMs: number })
  | (BaseEvent & { type: "bug:failed"; errorCode: string; message: string })
  // Synthetic BFF sentinel emitted on stream open
  | (BaseEvent & { type: "ready" });

export type HarnessEventType = HarnessEvent["type"];

/**
 * All SSE event type strings the BFF can emit. Centralised here so useSSE and
 * tests share one authoritative list — adding a new workflow event type here is
 * the only change needed to cover it end-to-end.
 *
 * SSE `event:` framing means EventSource only delivers a named event to a
 * listener registered for that exact name. Missing any type here silently drops
 * those events. Derived from:
 *   - src/harness/types.ts         (HarnessEvent union)
 *   - src/workflows/unit-tests/events.ts  (WorkflowEvent union)
 *   - src/workflows/bug-investigation/events.ts  (BugInvestigationEvent union)
 *   - synthetic "ready" sentinel emitted by the BFF on stream open
 */
export const ALL_SSE_EVENT_TYPES: readonly HarnessEventType[] = [
  // Harness core
  "run:started",
  "state:transition",
  "model:call:started",
  "model:call:completed",
  "model:call:failed",
  "tool:call:started",
  "tool:call:completed",
  "tool:call:failed",
  "reasoning:trace",
  "patch:proposed",
  "verification:result",
  "run:completed",
  "run:cancelled",
  "run:failed",
  // Harness tool-pipeline (S-M1)
  "command:executed",
  "patch:applied",
  // Unit-test workflow
  "workflow:started",
  "conventions:detected",
  "context:selected",
  "workflow:model:call:started",
  "workflow:model:call:completed",
  "patch:validated",
  "workflow:patch:applied",
  "workflow:verification:result",
  "workflow:completed",
  "workflow:failed",
  // Bug-investigation workflow
  "bug:started",
  "bug:failure:parsed",
  "bug:context:selected",
  "bug:model:call:started",
  "bug:model:call:completed",
  "bug:rootcause:proposed",
  "bug:patch:validated",
  "bug:patch:applied",
  "bug:verification:result",
  "bug:completed",
  "bug:failed",
  // Synthetic BFF sentinel
  "ready",
] as const;

export type TerminalEventType =
  | "run:completed"
  | "run:cancelled"
  | "run:failed"
  | "workflow:completed"
  | "workflow:failed"
  | "bug:completed"
  | "bug:failed";

export const TERMINAL_EVENT_TYPES = new Set<string>([
  // Harness terminals
  "run:completed",
  "run:cancelled",
  "run:failed",
  // Unit-test workflow terminals
  "workflow:completed",
  "workflow:failed",
  // Bug-investigation workflow terminals
  "bug:completed",
  "bug:failed",
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
  /** Epoch-ms timestamp from the audit layer (src/audit/index-api.ts startedAt: number). */
  startedAt: number;
  /** Epoch-ms timestamp from the audit layer (src/audit/index-api.ts finishedAt: number). */
  finishedAt: number;
}

export interface EvidenceRunIdentity {
  runId: string;
  fingerprint: string;
  harnessVersion: string;
  taskType: string;
  outcome: EvidenceOutcome;
  /** Epoch-ms timestamp (src/audit/types.ts startedAt: number). */
  startedAt: number;
  /** Epoch-ms timestamp (src/audit/types.ts finishedAt: number). */
  finishedAt: number;
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
