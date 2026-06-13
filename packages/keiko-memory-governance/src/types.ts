// Public type surface for @oscharko-dev/keiko-memory-governance (Epic #204 child #209).
// Pure types only — no IO, no clock, no randomness. Every function exported from this
// package consumes a `GovernanceContext` instead of reading the wall clock or generating
// a reviewer id internally; the caller (BFF route handler, MemoriaViva UI, workflow
// orchestrator) is the authoritative source of both.

import type {
  ConversationId,
  MemoryId,
  MemoryReviewerId,
  MemoryScope,
  MemoryStatus,
  MemoryType,
} from "@oscharko-dev/keiko-contracts/memory";

// ─── Governance context ───────────────────────────────────────────────────────
// Passed into every public builder. `reviewerId` is the durable identity recorded on the
// resulting envelope; `nowMs` is the epoch ms timestamp the envelope carries. Optional
// `reason` and `reviewerNote` are surfaced verbatim onto the envelope when the validator
// allows them — bounded by the contracts-side string length budgets.
export interface GovernanceContext {
  readonly reviewerId: MemoryReviewerId;
  readonly nowMs: number;
}

// ─── Forget selectors ─────────────────────────────────────────────────────────
// The forget API is a SELECTION pure function (`selectMemoriesForForget`) followed by a
// MAPPING pure function (`buildForgetOperations`). The discriminated union below pins
// the supported selection axes; an unknown `kind` is a compile error and a runtime
// `GovernanceError("unsupported-selector")`.
//
// `by-time-window` is inclusive of the boundary: a record whose `createdAt` is exactly
// `nowMs - olderThanMs` is selected. `olderThanMs` MUST be a finite non-negative number;
// the selector function throws otherwise.
export type ForgetSelector =
  | { readonly kind: "by-id"; readonly memoryId: MemoryId }
  | { readonly kind: "by-scope"; readonly scope: MemoryScope }
  | { readonly kind: "by-type"; readonly scope: MemoryScope; readonly type: MemoryType }
  | {
      readonly kind: "by-source-conversation";
      readonly scope: MemoryScope;
      readonly sourceConversationId: ConversationId;
    }
  | { readonly kind: "by-time-window"; readonly scope: MemoryScope; readonly olderThanMs: number };

export type ForgetSelectorKind = ForgetSelector["kind"];

// ─── Status transitions ───────────────────────────────────────────────────────
// `buildConflictTransitions` returns one of these per loser. The contracts validator
// `checkStatusTransition` is consulted at construction time; a transition that would be
// illegal under MEMORY_STATUS_TRANSITIONS surfaces as a GovernanceError instead of being
// silently emitted.
export interface StatusTransition {
  readonly memoryId: MemoryId;
  readonly from: MemoryStatus;
  readonly to: MemoryStatus;
  readonly transitionedAt: number;
}

// ─── Conflict-detection result ────────────────────────────────────────────────
export type ConflictReason = "negation-flip" | "polarity-mismatch" | "value-mismatch";

export interface ConflictPair {
  readonly hasConflict: boolean;
  readonly reason?: ConflictReason;
}

// ─── Conflict resolution input ────────────────────────────────────────────────
// `winner` is the surviving MemoryId; `losers` are demoted to `conflicted`. The losers
// list MUST be non-empty and MUST NOT contain the winner. Construction throws a
// GovernanceError otherwise.
export interface ConflictResolution {
  readonly winner: MemoryId;
  readonly losers: readonly MemoryId[];
}

// ─── Forget option flags ──────────────────────────────────────────────────────
// `protectPinned` defaults to TRUE at the call site of `selectMemoriesForForget` — pinned
// memories are excluded unless the caller explicitly opts in. `protectArchived` defaults
// to FALSE: an archived record is already not in active retrieval, so a re-selection by
// a retention sweep is acceptable.
export interface SelectMemoriesForForgetOptions {
  readonly nowMs: number;
  readonly protectPinned?: boolean;
  readonly protectArchived?: boolean;
}

export interface BuildForgetOperationsOptions {
  // The contracts type literally pins `userAcknowledgedDestructive` to `true`, so this
  // flag is set unconditionally on the produced envelope. The boolean lives on the option
  // bundle so the BFF can use the type-level pin as a compile-time gate at the call site
  // (e.g. require the request-level acknowledgement to be threaded into this options
  // bundle rather than hard-coded somewhere downstream).
  readonly writeTombstone: boolean;
  readonly reason?: string;
}

// ─── Correction options ───────────────────────────────────────────────────────
// `buildCorrection` produces both a `correction`-type MemoryProposal AND a
// MemorySupersession linking the old MemoryId to the new one. The caller persists the
// proposal first (mint a new MemoryId at acceptance) and then applies the supersession
// once it knows the freshly-minted id.
//
// We require the caller to supply `newMemoryIdHint`: the supersession envelope needs the
// NEW memory id at construction time. The "correct" architecture would be a two-phase
// commit — propose, accept-and-mint, supersede — but a single function returning both
// envelopes is the operating contract #209 asks for. The hint is a placeholder that the
// caller MUST replace with the real minted id before sending the supersession to the
// audit ledger; the GovernanceError("supersession-needs-real-id") at the storage seam
// catches a caller that forgets.
//
// The proposal carries a `proposalId` distinct from `newMemoryIdHint`; both flow through
// the caller-supplied `newProposalId` and `newMemoryIdHint` factories so the builder
// stays pure.

// ─── Re-export the selector kind list at runtime ──────────────────────────────
// Frozen at the value level so a downstream switch can iterate it without re-deriving the
// literal set.
export const FORGET_SELECTOR_KINDS: readonly ForgetSelectorKind[] = [
  "by-id",
  "by-scope",
  "by-type",
  "by-source-conversation",
  "by-time-window",
] as const;
