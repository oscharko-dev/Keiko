/**
 * Local mirror of the BFF↔UI contract types (ADR-0011 D5).
 * Do NOT import from src/ — these are declaration mirrors only.
 * Keep in sync with the seam types in src/gateway, src/harness, src/audit, src/workflows.
 */

// ---------------------------------------------------------------------------
// Gateway — model capability registry
// ---------------------------------------------------------------------------

export type CostClass = "low" | "medium" | "high";
export type LatencyClass = "fast" | "standard" | "slow";
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
// Gateway — safe config (no apiKey or provider baseUrl)
// ---------------------------------------------------------------------------

export interface SafeProviderConfig {
  readonly modelId: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly retryBaseDelayMs: number;
}

export interface SafeCircuitBreakerConfig {
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  readonly halfOpenProbes: number;
}

export interface SafeGatewayConfig {
  readonly providers: readonly SafeProviderConfig[];
  readonly circuitBreaker: SafeCircuitBreakerConfig;
  readonly capabilities?: readonly ModelCapability[];
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
  defaultLimits: Record<string, unknown>;
}

export interface VerifyInputSpec {
  inputs: Array<{ name: string; type: WorkflowInputType; required: boolean }>;
  defaultLimits: Record<string, unknown>;
}

export interface WorkflowsResponse {
  descriptors: WorkflowDescriptor[];
  explainPlan: ExplainPlanInputSpec;
  verify: VerifyInputSpec;
}

// ---------------------------------------------------------------------------
// Workspace — redacted workspace summary
// ---------------------------------------------------------------------------

export type WorkspaceLanguage = "typescript" | "javascript";
export type TestFramework = "vitest" | "jest" | "mocha" | "unknown";

export interface DiscoveryStats {
  discovered: number;
  denied: number;
  ignored: number;
}

export type SelectionReason =
  | "entrypoint"
  | "manifest"
  | "documentation"
  | "config"
  | "source"
  | "test";

export interface ContextEntrySummary {
  path: string;
  sizeBytes: number;
  excerptBytes: number;
  selectionReason: SelectionReason;
  truncated: boolean;
  excerpt: string;
}

export interface ContextPackSummary {
  totalCandidates: number;
  usedBytes: number;
  budgetBytes: number;
  droppedForBudget: number;
  entries: readonly ContextEntrySummary[];
}

export interface WorkspaceSummary {
  root: string;
  name: string | undefined;
  version: string | undefined;
  testFramework: TestFramework;
  sourceDirs: readonly string[];
  testDirs: readonly string[];
  languages: readonly WorkspaceLanguage[];
  counts: DiscoveryStats;
  context: ContextPackSummary | undefined;
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
      type: "sandbox:configured";
      envAllowlist: readonly string[];
      network: "inherit" | "none";
      maxOutputBytes: number;
      timeoutMs: number;
      terminationGraceMs: number;
      cwdRequested: boolean;
    })
  | (BaseEvent & {
      type: "patch:applied";
      changedFiles: number;
      created: number;
      deleted: number;
    })
  // Unit-test workflow events (src/workflows/unit-tests/events.ts)
  | (BaseEvent & {
      type: "workflow:started";
      workflowId: string;
      modelId: string;
      applyEnabled: boolean;
      limits: Record<string, unknown>;
    })
  | (BaseEvent & {
      type: "conventions:detected";
      framework: string;
      testDirs: readonly string[];
      fileNamingStyle: string;
    })
  | (BaseEvent & {
      type: "context:selected";
      entryCount: number;
      usedBytes: number;
      budgetBytes: number;
      droppedForBudget: number;
    })
  | (BaseEvent & { type: "workflow:model:call:started"; attempt: number; contextBytes: number })
  | (BaseEvent & {
      type: "workflow:model:call:completed";
      attempt: number;
      finishReason: string;
      promptTokens: number;
      completionTokens: number;
      latencyMs: number;
    })
  | (BaseEvent & {
      type: "patch:validated";
      ok: boolean;
      patchBytes: number;
      filesChanged: number;
      rejectionCode?: string;
    })
  | (BaseEvent & {
      type: "workflow:patch:applied";
      changedFiles: number;
      created: number;
      deleted: number;
    })
  | (BaseEvent & {
      type: "workflow:verification:result";
      overallStatus: string;
      stepCount: number;
      passedCount: number;
      durationMs: number;
    })
  | (BaseEvent & { type: "workflow:completed"; status: string; durationMs: number })
  | (BaseEvent & { type: "workflow:failed"; errorCode: string; message: string })
  // Bug-investigation workflow events (src/workflows/bug-investigation/events.ts)
  | (BaseEvent & {
      type: "bug:started";
      workflowId: string;
      modelId: string;
      applyEnabled: boolean;
      limits: Record<string, unknown>;
    })
  | (BaseEvent & { type: "bug:failure:parsed"; frameCount: number; messageCount: number })
  | (BaseEvent & {
      type: "bug:context:selected";
      entryCount: number;
      usedBytes: number;
      budgetBytes: number;
      droppedForBudget: number;
    })
  | (BaseEvent & { type: "bug:model:call:started"; attempt: number; contextBytes: number })
  | (BaseEvent & {
      type: "bug:model:call:completed";
      attempt: number;
      finishReason: string;
      promptTokens: number;
      completionTokens: number;
      latencyMs: number;
    })
  | (BaseEvent & {
      type: "bug:rootcause:proposed";
      hasPatch: boolean;
      confidence?: "low" | "medium" | "high";
    })
  | (BaseEvent & {
      type: "bug:patch:validated";
      ok: boolean;
      patchBytes: number;
      filesChanged: number;
      rejectionCode?: string;
    })
  | (BaseEvent & {
      type: "bug:patch:applied";
      changedFiles: number;
      created: number;
      deleted: number;
    })
  | (BaseEvent & {
      type: "bug:verification:result";
      overallStatus: string;
      stepCount: number;
      passedCount: number;
      durationMs: number;
    })
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
  "sandbox:configured",
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

export type EvidenceOutcome = "completed" | "cancelled" | "failed" | "limit-exceeded";

export interface EvidenceListEntry {
  runId: string;
  taskType: string;
  outcome: EvidenceOutcome;
  /** Epoch-ms timestamp from the audit layer (src/audit/index-api.ts startedAt: number). */
  startedAt: number;
  /** Epoch-ms timestamp from the audit layer (src/audit/index-api.ts finishedAt: number). */
  finishedAt: number;
  modelId: string;
  workspaceRoot?: string;
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
  changedFiles: number;
  created: number;
  deleted: number;
  redactedDiff?: string;
}

export interface EvidenceReasoningEntry {
  seq: number;
  ts: string;
  phase: string;
  rationale?: string;
  modelResponse?: string;
}

export interface EvidenceBrowserViewportPx {
  width: number;
  height: number;
}

export interface EvidenceBrowserEvent {
  schemaVersion: "1";
  type: string;
  sessionId: string;
  seq: number;
  ts: number;
  originOnly?: string;
  httpStatus?: number | null;
  captureSeq?: number;
  persisted?: boolean;
  viewportPx?: EvidenceBrowserViewportPx;
  path?: string;
  sha256?: string;
  bytes?: number;
  byteLength?: number;
  reason?: string;
  warning?: string;
  code?: string;
  message?: string;
}

export interface EvidenceBrowserScreenshot {
  seq: number;
  path: string;
  sha256: string;
  bytes: number;
  capturedAt: number;
  viewportPx: EvidenceBrowserViewportPx;
}

export interface EvidenceBrowserContentCapture {
  seq: number;
  byteLength: number;
  capturedAt: number;
  redactedHtml: string;
}

export interface EvidenceBrowserCapture {
  sessionId: string;
  cdpPort: number;
  targetId: string;
  status: "open" | "closed";
  startedAt: number;
  closedAt?: number;
  closeReason?: string;
  lastOriginOnly?: string;
  events: EvidenceBrowserEvent[];
  screenshots?: EvidenceBrowserScreenshot[];
  contentCaptures?: EvidenceBrowserContentCapture[];
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
  browser?: EvidenceBrowserCapture;
}

// ---------------------------------------------------------------------------
// BFF run report projection
// ---------------------------------------------------------------------------

export type RunStatus =
  | "running"
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
  report?: string;
  overallStatus?: string;
  results?: Array<{ kind: string; status: string; command: string; durationMs?: number }>;
  proposedDiff?: string;
  dryRunPreview?: string;
  changedFiles?: ChangedFile[];
  addedTestFiles?: Array<{ path: string; estimatedTestCount?: number }>;
  coveredBehavior?: string;
  knownGaps?: string;
  verificationSkipReason?: string;
  nextActions?: string[];
  failureReason?: string;
  hypothesis?: {
    rootCause?: string;
    regressionTestStrategy?: string;
    uncertainty?: string;
    confidence?: string;
  };
  verificationSummary?: VerificationAuditSummary;
  usage?: UsageMetadata;
  applyReport?: RunReport;
  appliedAt?: number;
}

export type AgentWorkflowId =
  | "verify"
  | "explain-plan"
  | "unit-test-generation"
  | "bug-investigation";

export type UnitTestTargetKind = "file" | "module" | "changedFiles";

export interface AgentVerifyInput {
  readonly targetFiles?: readonly string[];
}

export interface AgentExplainPlanInput {
  readonly filePath: string;
  readonly question?: string;
}

export interface AgentUnitTestInput {
  readonly targetKind: UnitTestTargetKind;
  readonly filePath?: string;
  readonly moduleDir?: string;
  readonly filePaths?: readonly string[];
}

export interface AgentBugInvestigationInput {
  readonly description?: string;
  readonly failingOutput?: string;
  readonly stackTrace?: string;
  readonly targetFiles?: readonly string[];
}

// ---------------------------------------------------------------------------
// BFF error envelope
// ---------------------------------------------------------------------------

export type BffErrorCode =
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "NOT_APPLIABLE"
  | "EVIDENCE_SCHEMA"
  | "WORKSPACE_FILE_TOO_LARGE"
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_PATH_DENIED"
  | "WORKSPACE_PATH_ESCAPE"
  | "WORKSPACE_READ_FAILED"
  | "INTERNAL";

export interface BffError {
  error: { code: BffErrorCode | string; message: string };
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

export type SseStatus = "connecting" | "live" | "terminal" | "error";

// ---------------------------------------------------------------------------
// UI-local persistence (ADR-0013) — wire-shape mirrors of src/ui/store types.
// ---------------------------------------------------------------------------

export interface Project {
  readonly path: string;
  readonly name: string;
  readonly favorite: boolean;
  readonly createdAt: number;
  readonly lastOpenedAt: number;
}

export interface ProjectWithAvailability extends Project {
  readonly available: boolean;
}

export type ChatStatus = "open" | "closed";

export interface Chat {
  readonly id: string;
  readonly projectPath: string;
  readonly title: string;
  readonly selectedModel: string;
  readonly branchLabel?: string;
  readonly status?: ChatStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type ChatMessageRole = "user" | "assistant" | "system";
// Issue #66 — chat-side workflow status. `cancelled` matches src/ui/runs.ts RunStatus so the
// chat can faithfully record a terminal cancellation.
export type ChatWorkflowStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface ChatMessage {
  readonly id: string;
  readonly chatId: string;
  readonly role: ChatMessageRole;
  readonly content: string;
  readonly timestamp: number;
  readonly runId?: string;
  readonly workflowId?: string;
  readonly workflowStatus?: ChatWorkflowStatus;
  readonly shortResult?: string;
  /** Issue #66 — labels non-workflow harness task runs (verify, explain-plan). */
  readonly taskType?: string;
}

// Issue #66 — partial PATCH body for /api/chats/messages?id=...
export interface PatchChatMessageBody {
  readonly workflowStatus?: ChatWorkflowStatus;
  readonly shortResult?: string;
  readonly taskType?: string;
}

export interface PatchMessageResponse {
  readonly message: ChatMessage;
}

export interface ProjectsResponse {
  readonly projects: readonly ProjectWithAvailability[];
}

export interface ProjectResponse {
  readonly project: ProjectWithAvailability;
}

export interface ChatsResponse {
  readonly chats: readonly Chat[];
}

export interface ChatResponse {
  readonly chat: Chat;
}

export interface MessagesResponse {
  readonly messages: readonly ChatMessage[];
}

export interface MessageResponse {
  readonly message: ChatMessage;
}

export interface DesktopChatBootstrapResponse {
  readonly project: ProjectWithAvailability;
  readonly chat: Chat;
  readonly messages: readonly ChatMessage[];
  readonly projects: readonly ProjectWithAvailability[];
  readonly chats: readonly Chat[];
}

export interface DesktopChatSendResponse {
  readonly chat: Chat;
  readonly messages: readonly ChatMessage[];
  readonly usage?: UsageMetadata;
}

// ---------------------------------------------------------------------------
// Desktop terminal — ADR-0018 bounded permitted-command execution contract
// ---------------------------------------------------------------------------

export interface TerminalPolicySummary {
  readonly commands: readonly string[];
  readonly limits: {
    readonly maxOutputBytes: number;
    readonly defaultTimeoutMs: number;
  };
}

export interface TerminalDirectoryRoot {
  readonly label: string;
  readonly path: string;
}

export interface TerminalDirectoryEntry {
  readonly name: string;
  readonly path: string;
}

export interface TerminalDirectoryListing {
  readonly path: string;
  readonly parent: string | null;
  readonly entries: readonly TerminalDirectoryEntry[];
  readonly roots: readonly TerminalDirectoryRoot[];
}

export interface TerminalExecutionInput {
  readonly projectId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly requestId?: string;
}

export interface TerminalExecutionResult {
  readonly executionId: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly truncated: boolean;
  readonly timedOut: boolean;
}

export type TerminalEventKind =
  | "execution-started"
  | "execution-completed"
  | "execution-failed"
  | "execution-cancelled";

export interface TerminalEventEnvelope {
  readonly kind: TerminalEventKind;
  readonly executionId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Desktop files — read-only registered-project filesystem browser contract
// ---------------------------------------------------------------------------

export interface FilesDirectoryRoot {
  readonly label: string;
  readonly path: string;
}

export interface FilesDirectoryEntry {
  readonly name: string;
  readonly path: string;
}

export interface FilesDirectoryListing {
  readonly path: string;
  readonly parent: string | null;
  readonly entries: readonly FilesDirectoryEntry[];
  readonly roots: readonly FilesDirectoryRoot[];
}

export type FilesEntryKind = "directory" | "file" | "symlink";

export interface FilesTreeEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: FilesEntryKind;
  readonly sizeBytes: number;
  readonly modifiedAt: number;
  readonly extension: string | null;
  readonly symlink: boolean;
  readonly readable: boolean;
}

export interface FilesTreeResponse {
  readonly root: string;
  readonly path: string;
  readonly entries: readonly FilesTreeEntry[];
  readonly truncated: boolean;
}

export interface FilesPreviewBase {
  readonly root: string;
  readonly path: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly modifiedAt: number;
  readonly extension: string | null;
  readonly mime: string;
  readonly symlink: boolean;
}

export type FilesPreviewResponse =
  | (FilesPreviewBase & {
      readonly kind: "text";
      readonly content: string;
      readonly truncated: boolean;
      readonly maxBytes: number;
    })
  | (FilesPreviewBase & {
      readonly kind: "image";
      readonly dataUrl: string;
      readonly maxBytes: number;
    })
  | (FilesPreviewBase & {
      readonly kind: "binary";
      readonly reason: "unsupported" | "too_large";
      readonly maxBytes?: number;
    });

// ---------------------------------------------------------------------------
// Browser tool (ADR-0017)
// ---------------------------------------------------------------------------

export interface BrowserViewportPx {
  readonly width: number;
  readonly height: number;
}

export interface CdpReachability {
  readonly reachable: boolean;
  readonly userAgent: string | null;
  readonly browserVersion: string | null;
  readonly webSocketDebuggerUrl: string | null;
}

export interface BrowserSessionMeta {
  readonly sessionId: string;
  readonly cdpPort: number;
  readonly targetId: string;
  readonly status: "open" | "closed";
  readonly createdAt: number;
}

export interface BrowserNavigateResult {
  readonly originOnly: string;
  readonly httpStatus: number | null;
}

export type BrowserScreenshotResult =
  | {
      readonly seq: number;
      readonly viewportPx: BrowserViewportPx;
      readonly dataBase64: string;
      readonly persisted: false;
    }
  | {
      readonly seq: number;
      readonly viewportPx: BrowserViewportPx;
      readonly persisted: true;
      readonly path: string;
      readonly sha256: string;
      readonly bytes: number;
    };

export interface BrowserContentResult {
  readonly seq: number;
  readonly byteLength: number;
  readonly redactedHtml: string;
}

export type BrowserEventKind =
  | "session-opened"
  | "navigated"
  | "screenshot-captured"
  | "page-content-captured"
  | "session-closed"
  | "trust-warning"
  | "error";

export interface BrowserEventEnvelope {
  readonly schemaVersion?: "1";
  readonly type?: string;
  readonly runId?: string;
  readonly fingerprint?: string;
  readonly seq?: number;
  readonly ts?: number;
  readonly kind: BrowserEventKind;
  readonly sessionId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}
