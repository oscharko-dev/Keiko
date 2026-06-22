// Resume decision for interrupted large-document jobs (Epic #1160, Issue #1286).
//
// Given a durable checkpoint and the current fingerprint (source hash, parser version, policy
// fingerprint, chunking strategy, embedding identity), decide whether a document can continue from
// where it stopped. A compatible non-terminal checkpoint resumes; an incompatible one restarts
// cleanly with a precise reason; a completed checkpoint is skipped.

import type {
  CheckpointFingerprint,
  CheckpointIncompatibilityReason,
  DocumentId,
  ExtractionCheckpointRecord,
  KnowledgeCapsuleId,
  LargeDocumentJobProgress,
} from "@oscharko-dev/keiko-contracts";
import { checkpointCompatibility } from "@oscharko-dev/keiko-contracts";

import { listExtractionCheckpoints, selectExtractionCheckpoint } from "./checkpoint-persist.js";
import type { KnowledgeStore } from "../store.js";

export type CheckpointResumeDecision =
  | { readonly kind: "no-checkpoint" }
  | { readonly kind: "resume"; readonly checkpoint: ExtractionCheckpointRecord }
  | { readonly kind: "complete"; readonly checkpoint: ExtractionCheckpointRecord }
  | {
      readonly kind: "incompatible";
      readonly checkpoint: ExtractionCheckpointRecord;
      readonly reasons: readonly CheckpointIncompatibilityReason[];
    };

export function resolveExtractionResume(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
  currentFingerprint: CheckpointFingerprint,
): CheckpointResumeDecision {
  const checkpoint = selectExtractionCheckpoint(store._internal.db, capsuleId, documentId);
  if (checkpoint === undefined) {
    return { kind: "no-checkpoint" };
  }
  const compat = checkpointCompatibility(checkpoint.fingerprint, currentFingerprint);
  if (!compat.compatible) {
    return { kind: "incompatible", checkpoint, reasons: compat.reasons };
  }
  if (checkpoint.phase === "complete") {
    return { kind: "complete", checkpoint };
  }
  return { kind: "resume", checkpoint };
}

// A checkpoint is resumable for UI/BFF purposes when it carries progress that is neither complete
// nor a hard failure (i.e. it stopped mid-flight or was cancelled).
export function isResumableCheckpoint(checkpoint: ExtractionCheckpointRecord): boolean {
  if (checkpoint.phase === "complete" || checkpoint.phase === "failed") return false;
  return true;
}

export function checkpointToProgress(
  checkpoint: ExtractionCheckpointRecord,
  safeDisplayName: string,
): LargeDocumentJobProgress {
  return {
    documentId: checkpoint.documentId,
    safeDisplayName,
    strategy: checkpoint.strategy,
    phase: checkpoint.phase,
    processedPages: checkpoint.pageCursor,
    extractedTextBytes: checkpoint.extractedTextBytes,
    chunkCount: checkpoint.chunkCursor,
    embeddedChunkCount: checkpoint.embeddedChunkCursor,
    retryCount: checkpoint.retryCount,
    coverage: checkpoint.coverage,
    resumable: isResumableCheckpoint(checkpoint),
  };
}

// Lists every document in the capsule that holds a resumable (mid-flight or cancelled) checkpoint.
export function listResumableDocuments(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
): readonly DocumentId[] {
  return listExtractionCheckpoints(store._internal.db, capsuleId)
    .filter(isResumableCheckpoint)
    .map((checkpoint) => checkpoint.documentId);
}
