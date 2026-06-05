// buildCorrection — single-call builder that pairs a `correction`-type MemoryProposal
// with the matching MemorySupersession linking the old MemoryId to the freshly-minted
// MemoryId of the corrected fact.
//
// Flow at the caller:
//   1. Caller mints a fresh proposalId AND the prospective newMemoryId (e.g. uuid v7).
//   2. Caller invokes buildCorrection(olderMemory, correctedBody, ctx, ids, sensitivity?).
//   3. Caller persists the proposal via the vault (#206); on acceptance the vault SHOULD
//      accept with `mintedMemoryId === newMemoryId` (the prospective id is stable).
//   4. Caller applies the supersession to the vault and audit ledger.
//
// The builder validates BOTH envelopes through the contracts validators before returning,
// so a structurally-invalid envelope cannot cross the public API. The supersession edge
// kind is pinned to the literal "supersedes" per the contracts type.

import type {
  MemoryId,
  MemoryProposal,
  MemoryProposalId,
  MemoryRecord,
  MemorySensitivity,
  MemorySupersession,
} from "@oscharko-dev/keiko-contracts/memory";
import {
  validateMemoryProposal,
  validateMemorySupersession,
} from "@oscharko-dev/keiko-contracts/memory";

import { GovernanceError } from "./errors.js";
import type { GovernanceContext } from "./types.js";

export interface BuildCorrectionInput {
  readonly olderMemory: MemoryRecord;
  readonly correctedBody: string;
  readonly context: GovernanceContext;
  readonly newProposalId: MemoryProposalId;
  readonly newMemoryId: MemoryId;
  readonly sensitivity?: MemorySensitivity;
  readonly reason?: string;
}

export interface CorrectionEnvelopes {
  readonly proposal: MemoryProposal;
  readonly supersession: MemorySupersession;
}

const DEFAULT_REASON = "user-issued correction";

function buildProposal(input: BuildCorrectionInput): MemoryProposal {
  const { olderMemory, correctedBody, context, newProposalId, sensitivity } = input;
  const provenance: MemoryProposal["provenance"] = {
    sourceKind: "accepted-correction",
    capturedAt: context.nowMs,
    confidence: olderMemory.provenance.confidence,
    sensitivity: sensitivity ?? olderMemory.provenance.sensitivity,
  };
  return {
    schemaVersion: "1",
    proposalId: newProposalId,
    proposedAt: context.nowMs,
    scope: olderMemory.scope,
    type: "correction",
    body: correctedBody,
    tags: olderMemory.tags,
    provenance,
    validity: { validFrom: context.nowMs },
    initialStatus: "proposed",
    captureReason: input.reason ?? DEFAULT_REASON,
  };
}

function buildSupersession(input: BuildCorrectionInput): MemorySupersession {
  return {
    schemaVersion: "1",
    oldMemoryId: input.olderMemory.id,
    newMemoryId: input.newMemoryId,
    reviewerId: input.context.reviewerId,
    supersededAt: input.context.nowMs,
    reason: input.reason ?? DEFAULT_REASON,
    edgeKind: "supersedes",
  };
}

function assertOldNewDiffer(oldId: MemoryId, newId: MemoryId): void {
  if (oldId === newId) {
    throw new GovernanceError(
      "invalid-resolution",
      "correction supersession requires oldMemoryId !== newMemoryId",
    );
  }
}

export function buildCorrection(input: BuildCorrectionInput): CorrectionEnvelopes {
  assertOldNewDiffer(input.olderMemory.id, input.newMemoryId);
  const proposal = buildProposal(input);
  const supersession = buildSupersession(input);
  const pValid = validateMemoryProposal(proposal);
  if (!pValid.ok) {
    throw new GovernanceError(
      "envelope-validation-failed",
      "correction proposal failed contracts validation",
      pValid.errors,
    );
  }
  const sValid = validateMemorySupersession(supersession);
  if (!sValid.ok) {
    throw new GovernanceError(
      "envelope-validation-failed",
      "correction supersession failed contracts validation",
      sValid.errors,
    );
  }
  return { proposal, supersession };
}
