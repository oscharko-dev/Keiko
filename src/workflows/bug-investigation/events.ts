// The BugInvestigationEvent discriminated union and its BugWorkflowEventSink (ADR-0009 D5). The
// envelope reuses the harness BaseEvent field shape ({ schemaVersion, runId, fingerprint, seq,
// ts }) by STRUCTURAL convention — NOT a TypeScript import — so the #10 audit ledger and #13 UI can
// narrow these events with the same envelope logic they apply to HarnessEvent. This union is
// SEPARATE from both HarnessEvent and the unit-test WorkflowEvent. Every member name is DISTINCT
// from the unit-test workflow's (ADR-0009 D5) so the package-root re-export does not collide. No
// runtime logic lives here. Members carry COUNTS/FLAGS only — never prose, diff, or raw paths;
// the one SENSITIVE field (failure message) is redacted before emit.

import type { VerificationStatus } from "../../verification/index.js";
import type { BugWorkflowLimits, BugWorkflowStatus } from "./types.js";

interface BaseBugEvent {
  readonly schemaVersion: "1";
  readonly runId: string;
  readonly fingerprint: string;
  readonly seq: number;
  readonly ts: number;
}

// Emitted once at pipeline start. Counts/flags only.
export interface BugInvestigationStartedEvent extends BaseBugEvent {
  readonly type: "bug:started";
  readonly workflowId: "bug-investigation";
  readonly modelId: string;
  readonly applyEnabled: boolean;
  readonly limits: BugWorkflowLimits;
}

// How many failure frames the parser extracted. No paths, no messages.
export interface FailureParsedEvent extends BaseBugEvent {
  readonly type: "bug:failure:parsed";
  readonly frameCount: number;
  readonly messageCount: number;
}

// How many context entries were selected and bytes used. No file content.
export interface BugContextSelectedEvent extends BaseBugEvent {
  readonly type: "bug:context:selected";
  readonly entryCount: number;
  readonly usedBytes: number;
  readonly budgetBytes: number;
  readonly droppedForBudget: number;
}

// Model call attempt number and context size. No content.
export interface BugModelCallStartedEvent extends BaseBugEvent {
  readonly type: "bug:model:call:started";
  readonly attempt: number;
  readonly contextBytes: number;
}

// Model call result: metadata only; no content.
export interface BugModelCallCompletedEvent extends BaseBugEvent {
  readonly type: "bug:model:call:completed";
  readonly attempt: number;
  readonly finishReason: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly latencyMs: number;
}

// Emitted once when a root-cause hypothesis is parsed. Flags only — no prose.
export interface RootCauseProposedEvent extends BaseBugEvent {
  readonly type: "bug:rootcause:proposed";
  readonly hasPatch: boolean;
  readonly confidence?: "low" | "medium" | "high" | undefined;
}

// Patch validation + scope-guard result. ok=false includes a rejection reason code (never text).
export interface BugPatchValidatedEvent extends BaseBugEvent {
  readonly type: "bug:patch:validated";
  readonly ok: boolean;
  readonly patchBytes: number;
  readonly filesChanged: number;
  // Present when ok=false; a #6 PatchRejectionCode or "out-of-scope" for the scope guard.
  readonly rejectionCode?: string | undefined;
}

// Emitted after successful apply. File counts only — no paths.
export interface BugPatchAppliedEvent extends BaseBugEvent {
  readonly type: "bug:patch:applied";
  readonly changedFiles: number;
  readonly created: number;
  readonly deleted: number;
}

// Verification summary at the workflow boundary. Output-text-free.
export interface BugVerificationResultEvent extends BaseBugEvent {
  readonly type: "bug:verification:result";
  readonly overallStatus: VerificationStatus;
  readonly stepCount: number;
  readonly passedCount: number;
  readonly durationMs: number;
}

// Terminal success/terminal-state event.
export interface BugInvestigationCompletedEvent extends BaseBugEvent {
  readonly type: "bug:completed";
  readonly status: BugWorkflowStatus;
  readonly durationMs: number;
}

// Terminal failure event. message is SENSITIVE: redacted before emit.
export interface BugInvestigationFailedEvent extends BaseBugEvent {
  readonly type: "bug:failed";
  readonly errorCode: string;
  readonly message: string;
}

export type BugInvestigationEvent =
  | BugInvestigationStartedEvent
  | FailureParsedEvent
  | BugContextSelectedEvent
  | BugModelCallStartedEvent
  | BugModelCallCompletedEvent
  | RootCauseProposedEvent
  | BugPatchValidatedEvent
  | BugPatchAppliedEvent
  | BugVerificationResultEvent
  | BugInvestigationCompletedEvent
  | BugInvestigationFailedEvent;

export interface BugWorkflowEventSink {
  readonly emit: (event: BugInvestigationEvent) => void;
}
