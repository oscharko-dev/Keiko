import { randomUUID } from "node:crypto";
import type { CaptureOutcome } from "@oscharko-dev/keiko-memory-capture";
import type {
  MemoryEdgeId,
  MemoryId,
  MemoryProposalId,
  MemoryRecord,
} from "@oscharko-dev/keiko-contracts/memory";

// The memory contracts brand every id as a plain string, and the brands are erased at runtime.
// The vault's record and edge gates admit an id only when it is non-empty after trimming, so that
// is the check that moves a string into one of these brands here.
function isAdmittedIdText(value: string): boolean {
  return value.trim().length > 0;
}

function isAdmittedMemoryId(value: string): value is MemoryId {
  return isAdmittedIdText(value);
}

function isAdmittedProposalId(value: string): value is MemoryProposalId {
  return isAdmittedIdText(value);
}

function isAdmittedEdgeId(value: string): value is MemoryEdgeId {
  return isAdmittedIdText(value);
}

/** A captured candidate is persisted under its proposal id. */
export function memoryIdOfProposal(proposalId: MemoryProposalId): MemoryId {
  if (isAdmittedMemoryId(proposalId)) return proposalId;
  throw new TypeError("A memory proposal id must be non-empty after trimming.");
}

/** The capture wire reports the id of the memory a candidate persisted as its proposal id. */
export function proposalIdOfMemory(memoryId: MemoryId): MemoryProposalId {
  if (isAdmittedProposalId(memoryId)) return memoryId;
  throw new TypeError("A memory id must be non-empty after trimming.");
}

/** Mints the id of a new memory edge. */
export function newMemoryEdgeId(): MemoryEdgeId {
  const id = randomUUID();
  if (isAdmittedEdgeId(id)) return id;
  throw new TypeError("A minted memory edge id must be non-empty.");
}

export function buildMemoryRecordFromProposal(
  proposalId: MemoryId,
  outcome: Extract<CaptureOutcome, { readonly kind: "candidate" }>,
): MemoryRecord;
export function buildMemoryRecordFromProposal(
  proposalId: MemoryId,
  outcome: CaptureOutcome,
): MemoryRecord | null;
export function buildMemoryRecordFromProposal(
  proposalId: MemoryId,
  outcome: CaptureOutcome,
): MemoryRecord | null {
  if (outcome.kind !== "candidate") return null;
  const { proposal } = outcome;
  return {
    id: proposalId,
    schemaVersion: proposal.schemaVersion,
    scope: proposal.scope,
    type: proposal.type,
    body: proposal.body,
    tags: proposal.tags,
    provenance: proposal.provenance,
    validity: proposal.validity,
    status: proposal.initialStatus,
    pinned: false,
    createdAt: proposal.proposedAt,
    updatedAt: proposal.proposedAt,
  };
}
