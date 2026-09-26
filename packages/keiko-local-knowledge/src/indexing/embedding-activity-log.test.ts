// Activity Log proofs for `emitEmbeddingActivity` (#3532).
//
// `emitEmbeddingActivity` is the exact function every `embedding.*` operation registers as its
// `emitter` in `embedding-activity-log.ts`. It is a pure reducer: given a caller-supplied
// `EmbeddingActivity` domain event, it derives the registered fields (context digests, forced
// transport labels, classified error kinds) and writes the ONE resulting registered event through
// `emitKnowledgeLogEvent`. Driving it directly here — rather than restating its output by hand —
// is driving the production emitter itself, exactly as AGENTS.md §7 requires: the mapping from a
// domain event to a wire-format line is owned by this module, never duplicated in the test.
//
// Each case below supplies a realistic domain event, captures the ONE line the reducer wrote
// through a recording `KnowledgeLogSink`, and proves that line is a valid production-persisted
// Activity Log record for the operation the proof id names.

import { describe, expect, it } from "vitest";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import type { KnowledgeLogEvent, KnowledgeLogSink } from "../knowledge-log.js";
import type { IndexingLogContext } from "./types.js";
import { emitEmbeddingActivity, type EmbeddingActivity } from "./embedding-activity-log.js";

// 16 lowercase hex characters: satisfies every `*Digest` field's `ACTIVITY_LOG_DIGEST_VALUE`
// pattern (`/^[a-f0-9]{8,128}$/`) and every declared `maxLength` (16 or 64) on these operations.
const DIGEST = "0123456789abcdef";

const CONTEXT: IndexingLogContext = {
  jobId: "embedding-activity-log-proof-job",
  capsuleIdDigest: DIGEST,
  documentIdDigest: DIGEST,
};

function capturingSink(): {
  readonly sink: KnowledgeLogSink;
  readonly events: KnowledgeLogEvent[];
} {
  const events: KnowledgeLogEvent[] = [];
  return { sink: { write: (event): void => void events.push(event) }, events };
}

function emitAndCapture(event: EmbeddingActivity): readonly KnowledgeLogEvent[] {
  const { sink, events } = capturingSink();
  emitEmbeddingActivity(sink, CONTEXT, event);
  return events;
}

function persistedLineFor(op: string, events: readonly KnowledgeLogEvent[]): string {
  const line = events.find((event) => event.op === op);
  expect(line, `expected ${op} to have been emitted`).toBeDefined();
  return formatActivityLogProofLine(line ?? {});
}

describe("emitEmbeddingActivity — Activity Log proofs", () => {
  it("resolves embedding.chunk.retry.attempt", () => {
    const events = emitAndCapture({
      op: "embedding.chunk.retry",
      attempt: 1,
      maxRetries: 3,
      delayMs: 250,
      transport: "scalar",
      endpointDigest: DIGEST,
      failureKind: "timeout",
    });
    const persisted = expectActivityLogProof(
      "embedding.chunk.retry.attempt",
      persistedLineFor("embedding.chunk.retry", events),
    );
    expect(persisted).toMatchObject({
      attempt: 1,
      maxRetries: 3,
      transport: "scalar",
      failureKind: "timeout",
    });
  });

  it("resolves embedding.chunk.retry-exhausted.attempt", () => {
    const events = emitAndCapture({
      op: "embedding.chunk.retry-exhausted",
      attempt: 3,
      maxRetries: 3,
      transport: "scalar",
      failureKind: "rate-limited",
    });
    const persisted = expectActivityLogProof(
      "embedding.chunk.retry-exhausted.attempt",
      persistedLineFor("embedding.chunk.retry-exhausted", events),
    );
    expect(persisted).toMatchObject({ attempt: 3, maxRetries: 3, failureKind: "rate-limited" });
  });

  it("resolves embedding.batch.partial-progress.counts", () => {
    const events = emitAndCapture({
      op: "embedding.batch.partial-progress",
      attempt: 2,
      maxRetries: 5,
      delayMs: 500,
      zeroProgressRetries: 1,
      remainingCount: 3,
      completedCount: 2,
      transport: "array-batch",
      failureKind: "unavailable",
    });
    const persisted = expectActivityLogProof(
      "embedding.batch.partial-progress.counts",
      persistedLineFor("embedding.batch.partial-progress", events),
    );
    expect(persisted).toMatchObject({
      remainingCount: 3,
      completedCount: 2,
      transport: "array-batch",
    });
  });

  it("resolves embedding.batch.retry.counts", () => {
    const events = emitAndCapture({
      op: "embedding.batch.retry",
      attempt: 1,
      maxRetries: 5,
      delayMs: 750,
      zeroProgressRetries: 0,
      remainingCount: 6,
      completedCount: 0,
      transport: "array-batch",
      failureKind: "unavailable",
    });
    const persisted = expectActivityLogProof(
      "embedding.batch.retry.counts",
      persistedLineFor("embedding.batch.retry", events),
    );
    expect(persisted).toMatchObject({ attempt: 1, maxRetries: 5, remainingCount: 6 });
  });

  it("resolves embedding.batch.transport-unavailable.count", () => {
    const events = emitAndCapture({ op: "embedding.batch.transport-unavailable", itemCount: 7 });
    const persisted = expectActivityLogProof(
      "embedding.batch.transport-unavailable.count",
      persistedLineFor("embedding.batch.transport-unavailable", events),
    );
    expect(persisted).toMatchObject({ itemCount: 7, transport: "array-batch" });
  });

  it("resolves embedding.identity.rejected.dimensions", () => {
    const events = emitAndCapture({
      op: "embedding.identity.rejected",
      pinnedDimensions: 1536,
      observedDimensions: 768,
      pinnedNormalization: "l2",
      failureKind: "INCOMPATIBLE_EMBEDDING_IDENTITY",
    });
    const persisted = expectActivityLogProof(
      "embedding.identity.rejected.dimensions",
      persistedLineFor("embedding.identity.rejected", events),
    );
    expect(persisted).toMatchObject({ pinnedDimensions: 1536, observedDimensions: 768 });
  });

  it("resolves embedding.batch.failed.class", () => {
    const events = emitAndCapture({
      op: "embedding.batch.failed",
      itemCount: 10,
      failureClass: "transient",
      endpointDigest: DIGEST,
      failureKind: "unavailable",
    });
    const persisted = expectActivityLogProof(
      "embedding.batch.failed.class",
      persistedLineFor("embedding.batch.failed", events),
    );
    expect(persisted).toMatchObject({ itemCount: 10, failureClass: "transient" });
  });

  it("resolves embedding.batch.budgeting-failed.count", () => {
    const events = emitAndCapture({
      op: "embedding.batch.budgeting-failed",
      uniqueChunkCount: 42,
      failureKind: "validation-failed",
    });
    const persisted = expectActivityLogProof(
      "embedding.batch.budgeting-failed.count",
      persistedLineFor("embedding.batch.budgeting-failed", events),
    );
    expect(persisted).toMatchObject({ uniqueChunkCount: 42 });
  });

  it("resolves embedding.batch.grouped.counts", () => {
    const events = emitAndCapture({
      op: "embedding.batch.grouped",
      uniqueChunkCount: 20,
      batchCount: 4,
      concurrency: 2,
      endpointDigest: DIGEST,
    });
    const persisted = expectActivityLogProof(
      "embedding.batch.grouped.counts",
      persistedLineFor("embedding.batch.grouped", events),
    );
    expect(persisted).toMatchObject({ uniqueChunkCount: 20, batchCount: 4, concurrency: 2 });
  });

  it("resolves embedding.batch.transport-selected.profile", () => {
    const events = emitAndCapture({
      op: "embedding.batch.transport-selected",
      transport: "array-batch",
      chunkCount: 20,
      uniqueChunkCount: 18,
      dedupedCount: 2,
      concurrency: 3,
      endpointDigest: DIGEST,
    });
    const persisted = expectActivityLogProof(
      "embedding.batch.transport-selected.profile",
      persistedLineFor("embedding.batch.transport-selected", events),
    );
    expect(persisted).toMatchObject({ transport: "array-batch", chunkCount: 20, dedupedCount: 2 });
  });

  it("resolves embedding.batch.persist-failed.counts", () => {
    const events = emitAndCapture({
      op: "embedding.batch.persist-failed",
      chunkCount: 5,
      vectorCount: 5,
      errorCount: 1,
      failureKind: "write-failed",
    });
    const persisted = expectActivityLogProof(
      "embedding.batch.persist-failed.counts",
      persistedLineFor("embedding.batch.persist-failed", events),
    );
    expect(persisted).toMatchObject({ chunkCount: 5, vectorCount: 5, errorCount: 1 });
  });

  it("resolves embedding.batch.completed.counts", () => {
    const events = emitAndCapture({
      op: "embedding.batch.completed",
      chunkCount: 5,
      vectorCount: 5,
      errorCount: 0,
      level: "info",
      durationMs: 120,
    });
    const persisted = expectActivityLogProof(
      "embedding.batch.completed.counts",
      persistedLineFor("embedding.batch.completed", events),
    );
    expect(persisted).toMatchObject({ chunkCount: 5, vectorCount: 5, errorCount: 0 });
  });

  it("resolves embedding.batch.rejected.counts", () => {
    const events = emitAndCapture({
      op: "embedding.batch.rejected",
      chunkCount: 3,
      vectorCount: 0,
      errorCount: 3,
      failureKind: "INCOMPATIBLE_EMBEDDING_IDENTITY",
    });
    const persisted = expectActivityLogProof(
      "embedding.batch.rejected.counts",
      persistedLineFor("embedding.batch.rejected", events),
    );
    expect(persisted).toMatchObject({ chunkCount: 3, errorCount: 3 });
  });

  it("resolves embedding.batch.cancelled.counts", () => {
    const events = emitAndCapture({
      op: "embedding.batch.cancelled",
      chunkCount: 2,
      vectorCount: 1,
      errorCount: 0,
      failureKind: "CANCELLED",
    });
    const persisted = expectActivityLogProof(
      "embedding.batch.cancelled.counts",
      persistedLineFor("embedding.batch.cancelled", events),
    );
    expect(persisted).toMatchObject({ chunkCount: 2, vectorCount: 1 });
  });
});
