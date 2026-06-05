// Internal envelope builders. Each helper takes the resolved scope, the body, and the policy
// decision and emits the contract envelope with deterministic, redaction-aware defaults.
//
// `_` prefix marks this file as package-private — index.ts never re-exports it. Callers stay
// at the top-level capture API; this module exists to keep envelope-shape decisions in one
// place so a contract evolution (e.g. a new optional provenance field) is a one-file edit.

import type {
  MemoryForget,
  MemoryId,
  MemoryProposal,
  MemoryReviewerId,
  MemoryScope,
  MemorySensitivity,
  MemorySourceKind,
  MemoryType,
  MemoryUpdate,
  WorkflowRunId,
} from "@oscharko-dev/keiko-contracts/memory";

import type { CaptureContext } from "./types.js";

interface ProposalBuildInput {
  readonly context: CaptureContext;
  readonly scope: MemoryScope;
  readonly body: string;
  readonly type: MemoryType;
  readonly sensitivity: MemorySensitivity;
  readonly sourceKind: MemorySourceKind;
  readonly captureRationale?: string;
  readonly sourceWorkflowRunId?: WorkflowRunId;
}

// Builds a MemoryProposal in the canonical "proposed, no expiry, no payload, no tags" shape.
// Capture deliberately emits a thin envelope: enriching it with payload/tags/validity is a
// downstream concern that should not introduce capture-time data the user did not say.
//
// `confidence` is hard-coded to 1.0 for explicit user intents (the user said it; we trust the
// signal fully) and 0.6 for workflow-derived candidates. Splitting that choice up to the caller
// keeps the rule explicit at the call site rather than buried here.
export function buildProposal(input: ProposalBuildInput, confidence: number): MemoryProposal {
  const proposal: MemoryProposal = {
    schemaVersion: "1",
    proposalId: input.context.newProposalId(),
    proposedAt: input.context.nowMs,
    scope: input.scope,
    type: input.type,
    body: input.body,
    tags: [],
    provenance: {
      sourceKind: input.sourceKind,
      capturedAt: input.context.nowMs,
      confidence,
      sensitivity: input.sensitivity,
      ...(input.captureRationale !== undefined && { captureRationale: input.captureRationale }),
      ...(input.context.conversationId !== undefined && {
        sourceConversationId: input.context.conversationId,
      }),
      ...(input.sourceWorkflowRunId !== undefined && {
        sourceWorkflowRunId: input.sourceWorkflowRunId,
      }),
    },
    validity: { validFrom: input.context.nowMs },
    initialStatus: "proposed",
  };
  return proposal;
}

// Reviewer id used for capture-emitted forget/update operations. Capture is the candidate-
// generator; the actual reviewer (the human accepting the candidate) attaches their id at the
// acceptance step. Stamping a synthetic capture-side reviewer here keeps the envelope
// well-formed for the validator without misrepresenting authorship.
const CAPTURE_REVIEWER_ID = "capture:proposed" as MemoryReviewerId;

interface ForgetBuildInput {
  readonly context: CaptureContext;
  readonly memoryId: MemoryId;
  readonly reason: string;
}

export function buildForget(input: ForgetBuildInput): MemoryForget {
  return {
    schemaVersion: "1",
    memoryId: input.memoryId,
    reviewerId: CAPTURE_REVIEWER_ID,
    forgottenAt: input.context.nowMs,
    reason: input.reason,
    userAcknowledgedDestructive: true,
  };
}

interface UpdateBuildInput {
  readonly context: CaptureContext;
  readonly memoryId: MemoryId;
  readonly bodyPatch: string;
  readonly reviewerNote?: string;
}

export function buildUpdate(input: UpdateBuildInput): MemoryUpdate {
  return {
    schemaVersion: "1",
    memoryId: input.memoryId,
    reviewerId: CAPTURE_REVIEWER_ID,
    updatedAt: input.context.nowMs,
    bodyPatch: input.bodyPatch,
    ...(input.reviewerNote !== undefined && { reviewerNote: input.reviewerNote }),
  };
}
