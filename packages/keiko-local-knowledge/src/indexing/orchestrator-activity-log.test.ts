// Activity Log proofs for `emitIndexingActivity` (#3532).
//
// `emitIndexingActivity` is the exact function every `indexing.*` operation registers as its
// `emitter` in `orchestrator-activity-log.ts`. It is a pure reducer: given a caller-supplied
// `IndexingActivity` domain event carrying its own `IndexingLogContext`, it derives the
// registered fields (capsule/document digests from context, correlation id from the job id,
// classified error kinds) and writes the ONE resulting registered event through
// `emitKnowledgeLogEvent`. Driving it directly — rather than restating its output by hand — is
// driving the production emitter itself, per AGENTS.md §7.
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
import { emitIndexingActivity, type IndexingActivity } from "./orchestrator-activity-log.js";

// 16 lowercase hex characters: satisfies every `*Digest` field's `ACTIVITY_LOG_DIGEST_VALUE`
// pattern (`/^[a-f0-9]{8,128}$/`) and every declared `maxLength` (16 or 64) on these operations.
const DIGEST = "0123456789abcdef";

const JOB_CONTEXT: IndexingLogContext = {
  jobId: "orchestrator-activity-log-proof-job",
  capsuleIdDigest: DIGEST,
};

// Structurally identical to the module-private `DocumentContext` (`IndexingLogContext` plus a
// required `documentIdDigest`) that every per-document `IndexingActivity` variant requires —
// TypeScript's structural typing accepts this local shape wherever that interface is expected.
const DOCUMENT_CONTEXT: IndexingLogContext & { readonly documentIdDigest: string } = {
  ...JOB_CONTEXT,
  documentIdDigest: DIGEST,
};

function capturingSink(): {
  readonly sink: KnowledgeLogSink;
  readonly events: KnowledgeLogEvent[];
} {
  const events: KnowledgeLogEvent[] = [];
  return { sink: { write: (event): void => void events.push(event) }, events };
}

function emitAndCapture(event: IndexingActivity): readonly KnowledgeLogEvent[] {
  const { sink, events } = capturingSink();
  emitIndexingActivity(sink, event);
  return events;
}

function persistedLineFor(op: string, events: readonly KnowledgeLogEvent[]): string {
  const line = events.find((event) => event.op === op);
  expect(line, `expected ${op} to have been emitted`).toBeDefined();
  return formatActivityLogProofLine(line ?? {});
}

describe("emitIndexingActivity — Activity Log proofs", () => {
  it("resolves indexing.chunking.failed.body-free", () => {
    const events = emitAndCapture({
      op: "indexing.chunking.failed",
      context: DOCUMENT_CONTEXT,
      lane: "bounded",
      failureKind: "CANCELLED",
      sourceTextLength: 1200,
      cancelled: true,
      policyRejection: false,
    });
    const persisted = expectActivityLogProof(
      "indexing.chunking.failed.body-free",
      persistedLineFor("indexing.chunking.failed", events),
    );
    expect(persisted).toMatchObject({ lane: "bounded", cancelled: true });
  });

  it("resolves indexing.document.embedding-started.counts", () => {
    const events = emitAndCapture({
      op: "indexing.document.embedding-started",
      context: DOCUMENT_CONTEXT,
      chunkCount: 10,
      batchCount: 2,
      batchSize: 5,
    });
    const persisted = expectActivityLogProof(
      "indexing.document.embedding-started.counts",
      persistedLineFor("indexing.document.embedding-started", events),
    );
    expect(persisted).toMatchObject({ chunkCount: 10, batchCount: 2, batchSize: 5 });
  });

  it("resolves indexing.document.skipped.reason", () => {
    const events = emitAndCapture({
      op: "indexing.document.skipped",
      context: DOCUMENT_CONTEXT,
      reason: "unchanged",
      skippedDocuments: 1,
      preservedChunkCount: 4,
      documentStatus: "extracted",
    });
    const persisted = expectActivityLogProof(
      "indexing.document.skipped.reason",
      persistedLineFor("indexing.document.skipped", events),
    );
    expect(persisted).toMatchObject({ reason: "unchanged", skippedDocuments: 1 });
  });

  it("resolves indexing.document.extraction-failed.kind", () => {
    const events = emitAndCapture({
      op: "indexing.document.extraction-failed",
      context: DOCUMENT_CONTEXT,
      failedDocuments: 1,
      failureKind: "read-failed",
    });
    const persisted = expectActivityLogProof(
      "indexing.document.extraction-failed.kind",
      persistedLineFor("indexing.document.extraction-failed", events),
    );
    expect(persisted).toMatchObject({ failedDocuments: 1, failureKind: "read-failed" });
  });

  it("resolves indexing.document.extracted.lifecycle", () => {
    const events = emitAndCapture({ op: "indexing.document.extracted", context: DOCUMENT_CONTEXT });
    const persisted = expectActivityLogProof(
      "indexing.document.extracted.lifecycle",
      persistedLineFor("indexing.document.extracted", events),
    );
    expect(persisted).toMatchObject({ documentIdDigest: DIGEST });
  });

  it("resolves indexing.document.chunked.count", () => {
    const events = emitAndCapture({
      op: "indexing.document.chunked",
      context: DOCUMENT_CONTEXT,
      chunkCount: 8,
    });
    const persisted = expectActivityLogProof(
      "indexing.document.chunked.count",
      persistedLineFor("indexing.document.chunked", events),
    );
    expect(persisted).toMatchObject({ chunkCount: 8 });
  });

  it("resolves indexing.document.failed.class", () => {
    const events = emitAndCapture({
      op: "indexing.document.failed",
      context: DOCUMENT_CONTEXT,
      failureKind: "unavailable",
      failureClass: "transient",
      consecutiveTransientEmbedFailures: 2,
    });
    const persisted = expectActivityLogProof(
      "indexing.document.failed.class",
      persistedLineFor("indexing.document.failed", events),
    );
    expect(persisted).toMatchObject({
      failureClass: "transient",
      consecutiveTransientEmbedFailures: 2,
    });
  });

  it("resolves indexing.document.embedded.counts", () => {
    const events = emitAndCapture({
      op: "indexing.document.embedded",
      context: DOCUMENT_CONTEXT,
      vectorCount: 8,
      vectorsPersistedSoFar: 40,
      processedDocuments: 5,
    });
    const persisted = expectActivityLogProof(
      "indexing.document.embedded.counts",
      persistedLineFor("indexing.document.embedded", events),
    );
    expect(persisted).toMatchObject({ vectorCount: 8, vectorsPersistedSoFar: 40 });
  });

  it("resolves indexing.document.extraction-started.counts", () => {
    const events = emitAndCapture({
      op: "indexing.document.extraction-started",
      context: DOCUMENT_CONTEXT,
      discoveredCount: 12,
      sizeBytes: 2048,
    });
    const persisted = expectActivityLogProof(
      "indexing.document.extraction-started.counts",
      persistedLineFor("indexing.document.extraction-started", events),
    );
    expect(persisted).toMatchObject({ discoveredCount: 12, sizeBytes: 2048 });
  });

  it("resolves indexing.discovery.scope-error.kind", () => {
    const events = emitAndCapture({
      op: "indexing.discovery.scope-error",
      context: JOB_CONTEXT,
      failureKind: "PERMISSION_DENIED",
      scopedToFile: false,
      discoveryFailedDocuments: 1,
    });
    const persisted = expectActivityLogProof(
      "indexing.discovery.scope-error.kind",
      persistedLineFor("indexing.discovery.scope-error", events),
    );
    expect(persisted).toMatchObject({ scopedToFile: false, discoveryFailedDocuments: 1 });
  });

  it("resolves indexing.source.started.scope", () => {
    const events = emitAndCapture({
      op: "indexing.source.started",
      context: JOB_CONTEXT,
      sourceIdDigest: DIGEST,
      scopeKind: "folder",
    });
    const persisted = expectActivityLogProof(
      "indexing.source.started.scope",
      persistedLineFor("indexing.source.started", events),
    );
    expect(persisted).toMatchObject({ scopeKind: "folder" });
  });

  it("resolves indexing.source.completed.counts", () => {
    const events = emitAndCapture({
      op: "indexing.source.completed",
      context: JOB_CONTEXT,
      durationMs: 300,
      sourceIdDigest: DIGEST,
      discoveredCount: 10,
      failedCount: 1,
      walkCompleted: true,
      cancelled: false,
      sawScopeError: false,
    });
    const persisted = expectActivityLogProof(
      "indexing.source.completed.counts",
      persistedLineFor("indexing.source.completed", events),
    );
    expect(persisted).toMatchObject({ discoveredCount: 10, failedCount: 1, walkCompleted: true });
  });

  it("resolves indexing.discovery.limit-reached.bounds", () => {
    const events = emitAndCapture({
      op: "indexing.discovery.limit-reached",
      context: JOB_CONTEXT,
      discoveredCount: 500,
      maxFiles: 500,
      maxDepth: 10,
    });
    const persisted = expectActivityLogProof(
      "indexing.discovery.limit-reached.bounds",
      persistedLineFor("indexing.discovery.limit-reached", events),
    );
    expect(persisted).toMatchObject({ maxFiles: 500, maxDepth: 10 });
  });

  it("resolves indexing.job.started.profile", () => {
    const events = emitAndCapture({
      op: "indexing.job.started",
      context: JOB_CONTEXT,
      sourceCount: 3,
      batchSize: 16,
      concurrency: 2,
      force: false,
      resume: true,
      contextualRetrieval: true,
      minChunkTokens: 200,
      maxChunkTokens: 800,
      overlapTokens: 50,
      tokenizerKind: "tokenizer",
      endpointDigest: DIGEST,
    });
    const persisted = expectActivityLogProof(
      "indexing.job.started.profile",
      persistedLineFor("indexing.job.started", events),
    );
    expect(persisted).toMatchObject({ sourceCount: 3, tokenizerKind: "tokenizer", resume: true });
  });

  it("resolves indexing.job.received.prologue", () => {
    const events = emitAndCapture({
      op: "indexing.job.received",
      context: JOB_CONTEXT,
      sourceIdFilterCount: 0,
      force: false,
      resume: false,
    });
    const persisted = expectActivityLogProof(
      "indexing.job.received.prologue",
      persistedLineFor("indexing.job.received", events),
    );
    expect(persisted).toMatchObject({ sourceIdFilterCount: 0, force: false, resume: false });
  });

  it("resolves indexing.job.finished.counts", () => {
    const events = emitAndCapture({
      op: "indexing.job.finished",
      context: JOB_CONTEXT,
      durationMs: 5000,
      jobStatus: "succeeded",
      totalDocuments: 10,
      processedDocuments: 9,
      failedDocuments: 1,
      skippedDocuments: 0,
      vectorsPersisted: 90,
    });
    const persisted = expectActivityLogProof(
      "indexing.job.finished.counts",
      persistedLineFor("indexing.job.finished", events),
    );
    expect(persisted).toMatchObject({ jobStatus: "succeeded", vectorsPersisted: 90 });
  });
});
