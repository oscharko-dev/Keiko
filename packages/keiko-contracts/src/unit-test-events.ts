// The WorkflowEvent discriminated union and its BaseWorkflowEvent envelope (ADR-0008 D4) plus the
// sibling status / limits / file-naming-style names the event types reference. The envelope reuses
// the harness BaseEvent field shape ({ schemaVersion, runId, fingerprint, seq, ts }) by structural
// convention — NOT a TypeScript import — so the #10 audit ledger and #13 UI can narrow workflow
// events with the same envelope logic they apply to HarnessEvent. This union is SEPARATE from
// HarnessEvent because the workflow does not pass through the harness state machine. No runtime
// logic lives here beyond the frozen DEFAULT_WORKFLOW_LIMITS table. Every SENSITIVE field is
// redacted before emit.

import type { TestFramework } from "./workspace.js";
import type { VerificationStatus } from "./verification.js";

// ─── Status (D2/D8) ────────────────────────────────────────────────────────────────

export type WorkflowStatus =
  | "completed" // patch applied and verification ran (apply mode)
  | "dry-run" // dry-run mode: diff produced, no files written
  | "rejected" // model produced an invalid or out-of-scope patch after all retries
  | "cancelled" // AbortSignal fired
  | "failed"; // unexpected error at an IO boundary

// ─── Conventions (D7) ──────────────────────────────────────────────────────────────

export type FileNamingStyle = "sibling" | "mirrored" | "unknown";

// ─── Limits (D2/D8) ────────────────────────────────────────────────────────────────

export interface WorkflowLimits {
  // Maximum model calls for this workflow run including retries. Default: 3.
  readonly maxModelCalls: number;
  // Maximum retries on empty / invalid / out-of-scope patch. Default: 2.
  readonly maxRetries: number;
  // Context pack byte budget fed to #5 buildContextPack. Default: 65_536.
  readonly contextBudgetBytes: number;
  // Max bytes per file in context pack. Default: 8_192.
  readonly maxBytesPerFile: number;
}

export const DEFAULT_WORKFLOW_LIMITS: WorkflowLimits = {
  maxModelCalls: 3,
  maxRetries: 2,
  contextBudgetBytes: 65_536,
  maxBytesPerFile: 8_192,
} as const;

// ─── Event envelope ────────────────────────────────────────────────────────────────

interface BaseWorkflowEvent {
  readonly schemaVersion: "1";
  readonly runId: string;
  readonly fingerprint: string;
  readonly seq: number;
  readonly ts: number;
}

// Emitted once at pipeline start. Counts/flags only — no source text, no file content.
export interface WorkflowStartedEvent extends BaseWorkflowEvent {
  readonly type: "workflow:started";
  readonly workflowId: "unit-test-generation";
  readonly modelId: string;
  readonly applyEnabled: boolean;
  readonly limits: WorkflowLimits;
}

// Framework, testDir style, naming style. No file content.
export interface ConventionsDetectedEvent extends BaseWorkflowEvent {
  readonly type: "conventions:detected";
  readonly framework: TestFramework;
  readonly testDirs: readonly string[];
  readonly fileNamingStyle: FileNamingStyle;
}

// How many entries were selected and bytes used. No file content.
export interface ContextSelectedEvent extends BaseWorkflowEvent {
  readonly type: "context:selected";
  readonly entryCount: number;
  readonly usedBytes: number;
  readonly budgetBytes: number;
  readonly droppedForBudget: number;
}

// Model call attempt number and context size. No content.
export interface ModelCallStartedEvent extends BaseWorkflowEvent {
  readonly type: "workflow:model:call:started";
  readonly attempt: number;
  readonly contextBytes: number;
}

// Model call result: metadata only; no content.
export interface ModelCallCompletedEvent extends BaseWorkflowEvent {
  readonly type: "workflow:model:call:completed";
  readonly attempt: number;
  readonly finishReason: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly latencyMs: number;
}

// Patch validation result. ok=false includes a rejection reason code (never message text).
export interface PatchValidatedEvent extends BaseWorkflowEvent {
  readonly type: "patch:validated";
  readonly ok: boolean;
  readonly patchBytes: number;
  readonly filesChanged: number;
  // Present when ok=false; a stable PatchRejectionCode or "out-of-scope" for the production guard.
  readonly rejectionCode?: string | undefined;
}

// Emitted after successful apply. File counts only — no paths.
export interface PatchAppliedEvent extends BaseWorkflowEvent {
  readonly type: "workflow:patch:applied";
  readonly changedFiles: number;
  readonly created: number;
  readonly deleted: number;
}

// Verification summary at the workflow boundary. Output-text-free.
export interface VerificationResultEvent extends BaseWorkflowEvent {
  readonly type: "workflow:verification:result";
  readonly overallStatus: VerificationStatus;
  readonly stepCount: number;
  readonly passedCount: number;
  readonly durationMs: number;
}

// Terminal success/terminal-state event.
export interface WorkflowCompletedEvent extends BaseWorkflowEvent {
  readonly type: "workflow:completed";
  readonly status: WorkflowStatus;
  readonly durationMs: number;
}

// Terminal failure event. message is SENSITIVE: redacted before emit.
export interface WorkflowFailedEvent extends BaseWorkflowEvent {
  readonly type: "workflow:failed";
  readonly errorCode: string;
  readonly message: string;
}

export type WorkflowEvent =
  | WorkflowStartedEvent
  | ConventionsDetectedEvent
  | ContextSelectedEvent
  | ModelCallStartedEvent
  | ModelCallCompletedEvent
  | PatchValidatedEvent
  | PatchAppliedEvent
  | VerificationResultEvent
  | WorkflowCompletedEvent
  | WorkflowFailedEvent;

export interface WorkflowEventSink {
  readonly emit: (event: WorkflowEvent) => void;
}
