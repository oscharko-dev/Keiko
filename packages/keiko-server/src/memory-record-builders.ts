import type { CaptureOutcome } from "@oscharko-dev/keiko-memory-capture";
import type { MemoryId, MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";

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
