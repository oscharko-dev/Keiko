// Public types for keiko-memory-capture (Epic #204 child #207).
//
// Capture is purely deterministic: the caller injects clock (`nowMs`) and id factories (`newId`,
// `newProposalId`) via `CaptureContext`, so the same input + context produces a byte-identical
// outcome. This keeps the evaluation harness (#215) and audit ledger (#214) reproducible.

import type {
  ConversationId,
  MemoryForget,
  MemoryId,
  MemoryProposal,
  MemoryProposalId,
  MemoryScope,
  MemoryScopeKind,
  MemorySensitivity,
  MemorySupersession,
  MemoryUpdate,
  ProjectId,
  UserId,
  WorkflowDefinitionId,
  WorkflowRunId,
  WorkspaceId,
} from "@oscharko-dev/keiko-contracts/memory";

import type { RejectionReason } from "./errors.js";

// Capture context — the caller's slice of identity and clock for one capture call.
//
// Optional coordinates are explicit: a capture made inside a project chat carries `projectId`;
// a capture from a workflow run carries `workflowDefinitionId` and `sourceWorkflowRunId`. Scope
// inference reads these to decide where the candidate memory should live.
export interface CaptureContext {
  readonly userId: UserId;
  readonly workspaceId?: WorkspaceId;
  readonly projectId?: ProjectId;
  readonly workflowDefinitionId?: WorkflowDefinitionId;
  readonly sourceWorkflowRunId?: WorkflowRunId;
  readonly conversationId?: ConversationId;
  // Epoch milliseconds. Caller-supplied so the layer stays pure; the audit ledger pins this as
  // the capture timestamp on the resulting envelope's provenance.
  readonly nowMs: number;
  // Per-call ID factories. Caller decides whether ids are uuids, ulids, or monotonic counters.
  readonly newMemoryId: () => MemoryId;
  readonly newProposalId: () => MemoryProposalId;
}

// Caller-side resolver used by the forget/update intent extractors to detect ambiguity.
// Returns the list of memory ids that match a free-form target phrase (e.g. "the test runner
// preference"). Returning 0 matches => no candidate to operate on; 1 match => proceed; >1 matches
// => the extractor emits a `rejected` outcome with `ambiguous-{forget,update}`.
//
// Kept callback-shaped (not async, not Promise) so capture stays a pure-function layer; the BFF
// route that owns the resolver may resolve the lookup synchronously from a pre-loaded scope view.
export type CaptureMemoryResolver = (target: string, scope: MemoryScope) => readonly MemoryId[];

// Caller policy knobs. All optional with conservative defaults; the type pins the shape.
export interface CapturePolicyOptions {
  // Additional rejection patterns the deployment knows about (e.g. customer names that must never
  // be memorised). Each matcher is a RegExp — the caller is responsible for ReDoS safety per the
  // security package conventions. Matched candidates reject with `customer-identifier`.
  readonly customerIdentifierMatchers?: readonly RegExp[];
  // Sensitivity assigned when the body shows no PII/confidentiality markers. Defaults to "public".
  // Set to "confidential" to force every candidate to require explicit approval.
  readonly defaultSensitivity?: MemorySensitivity;
  // Forget/update ambiguity resolver. When omitted, forget/update emit candidates WITHOUT
  // ambiguity checking — the storage acceptance layer remains free to perform its own check.
  readonly resolver?: CaptureMemoryResolver;
  // Whether `{ kind: "global" }` scope is allowed. Defaults to false (fail-closed) so a stray
  // scope hint cannot silently elevate a candidate to a cross-user fact.
  readonly allowGlobalScope?: boolean;
  // Optional override for the scope kind. When unset, scope-inference picks the most specific
  // coordinate available on the context (project > workspace > workflow > user).
  readonly scopeKind?: MemoryScopeKind;
  // Hard cap on body length BEFORE secret scanning. Captures longer than this reject with
  // `exceeds-length-limit`. The default mirrors the contract validator's body cap.
  readonly maxBodyChars?: number;
}

// Structured workflow outcome handed to the workflow extractor. Local to this package; full
// workflow contracts live elsewhere. The structured report is a short caller-rendered summary
// (a few hundred chars) — NOT the raw run log.
export interface WorkflowOutcomeInput {
  readonly runId: WorkflowRunId;
  readonly outcomeKind: "success" | "corrected" | "failed";
  readonly structuredReport: string;
  readonly capturedAt: number;
}

// Discriminated outcome union. Every kind carries the minimum payload the next layer needs.
// `kind:"candidate"` always carries `requiresApproval` so the BFF route can immediately decide
// whether to display a confirmation prompt without re-reading the proposal's sensitivity.
export type CaptureOutcome =
  | {
      readonly kind: "candidate";
      readonly proposal: MemoryProposal;
      readonly requiresApproval: boolean;
    }
  | { readonly kind: "update"; readonly operation: MemoryUpdate }
  | {
      readonly kind: "forget";
      readonly operation: MemoryForget;
      readonly requiresConfirmation: boolean;
    }
  | { readonly kind: "supersession"; readonly operation: MemorySupersession }
  | { readonly kind: "rejected"; readonly reason: RejectionReason };
