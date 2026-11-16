// What a learned fact does to what is stored: it replaces an older fact in one transaction, or waits
// as a correction for the person's approval when the mode asks for one. Reuses the `supersedes` edge,
// the `superseded` status and the closed validity of the human correction path (memory-handlers.ts).

import { randomUUID } from "node:crypto";

import type { MemoryEdgeId, MemoryId, MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";
import { supersededValidity } from "@oscharko-dev/keiko-memory-governance";
import { standingProfileSuccession } from "@oscharko-dev/keiko-memory-retrieval";
import type { MemoryGraphPrecondition, MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";

const LEARNED_SUPERSESSION_REASON = "A newer statement by the person replaced this fact.";

export interface LearnedSupersession {
  readonly record: MemoryRecord;
  // The fact it replaced. Absent when the record only waits for approval, or when the older fact is
  // gone by now and there is nothing left to replace.
  readonly superseded?: MemoryRecord;
  readonly edgeId?: MemoryEdgeId;
  readonly pendingApproval: boolean;
}

// How a stored fact stood when the learner read it, before the model call. The capture runs in the
// background, so the person may rewrite or decide on that fact meanwhile; a replacement is checked
// against this, never against a fresh read taken just before the write.
export interface SeenFact {
  readonly status: MemoryRecord["status"];
  readonly updatedAt: number;
}

// Only what Keiko learned gives way: what the person stated or rewrote stays until they change it.
export function isReplaceable(record: MemoryRecord | undefined): record is MemoryRecord {
  return (
    record !== undefined &&
    (record.status === "accepted" || record.status === "proposed") &&
    record.provenance.evidenceSpan !== undefined
  );
}

function unchangedSince(predecessor: MemoryRecord, seen: SeenFact): MemoryGraphPrecondition {
  return { id: predecessor.id, expectedStatus: seen.status, expectedUpdatedAt: seen.updatedAt };
}

function replaceInOneTransaction(
  vault: MemoryVaultStore,
  record: MemoryRecord,
  predecessor: MemoryRecord,
  seen: SeenFact,
): LearnedSupersession {
  const nowMs = record.createdAt;
  const validity = supersededValidity(predecessor, nowMs);
  const edgeId = randomUUID() as MemoryEdgeId;
  // The new fact takes the old one's place in the standing profile, or its removal from it.
  const successor = { ...record, ...standingProfileSuccession(predecessor, record) };
  const mutation = vault.applyGraphMutation({
    preconditions: [unchangedSince(predecessor, seen)],
    inserts: [successor],
    updates: [
      {
        id: predecessor.id,
        patch: {
          status: "superseded",
          staleReason: LEARNED_SUPERSESSION_REASON,
          ...(validity === null ? {} : { validity }),
        },
        nowMs,
        expectedStatus: seen.status,
        expectedUpdatedAt: seen.updatedAt,
      },
    ],
    edges: [
      {
        id: edgeId,
        schemaVersion: "1",
        fromMemoryId: predecessor.id,
        toMemoryId: record.id,
        kind: "supersedes",
        createdAt: nowMs,
        provenanceSummary: LEARNED_SUPERSESSION_REASON,
      },
    ],
  });
  const inserted = mutation.inserted[0] ?? successor;
  const superseded = mutation.memories[0] ?? predecessor;
  return { record: inserted, superseded, edgeId, pendingApproval: false };
}

// The older fact stays in force until the person accepts the correction; acceptance then commits the
// `supersedes` edge through the existing correction path.
function proposeCorrection(
  vault: MemoryVaultStore,
  record: MemoryRecord,
  predecessor: MemoryRecord,
  seen: SeenFact,
): LearnedSupersession {
  const correction: MemoryRecord = { ...record, type: "correction" };
  const mutation = vault.applyGraphMutation({
    preconditions: [unchangedSince(predecessor, seen)],
    inserts: [correction],
    updates: [],
    edges: [
      {
        id: randomUUID() as MemoryEdgeId,
        schemaVersion: "1",
        fromMemoryId: predecessor.id,
        toMemoryId: correction.id,
        kind: "corrects",
        createdAt: record.createdAt,
        provenanceSummary: LEARNED_SUPERSESSION_REASON,
      },
    ],
  });
  return { record: mutation.inserted[0] ?? correction, pendingApproval: true };
}

// A fact the learner never saw has no state to check against, so nothing is replaced for it.
export function applyLearnedSupersession(
  vault: MemoryVaultStore,
  record: MemoryRecord,
  predecessorId: MemoryId,
  seen: SeenFact | undefined,
): LearnedSupersession {
  const predecessor = vault.getMemory(predecessorId);
  if (seen === undefined || !isReplaceable(predecessor)) {
    return { record: vault.insertMemory(record), pendingApproval: false };
  }
  return record.status === "accepted"
    ? replaceInOneTransaction(vault, record, predecessor, seen)
    : proposeCorrection(vault, record, predecessor, seen);
}
