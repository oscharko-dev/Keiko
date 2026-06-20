import {
  DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY,
  largeDocumentPolicyFingerprint,
} from "@oscharko-dev/keiko-contracts";
import type {
  CheckpointFingerprint,
  DocumentId,
  EmbeddingModelIdentity,
  ExtractionCheckpointRecord,
  KnowledgeCapsuleId,
} from "@oscharko-dev/keiko-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCapsule } from "../capsule-lifecycle.js";
import { freshStore, sampleCapsuleInput } from "../_support.js";
import type { KnowledgeStore } from "../store.js";

import {
  deleteExtractionCheckpoint,
  listExtractionCheckpoints,
  selectExtractionCheckpoint,
  upsertExtractionCheckpoint,
} from "./checkpoint-persist.js";
import {
  checkpointToProgress,
  isResumableCheckpoint,
  listResumableDocuments,
  resolveExtractionResume,
} from "./checkpoint-resume.js";

const IDENTITY: EmbeddingModelIdentity = {
  provider: "keiko",
  modelId: "embed-1",
  vectorDimensions: 1536,
  vectorMetric: "cosine",
};

function fingerprint(overrides: Partial<CheckpointFingerprint> = {}): CheckpointFingerprint {
  return {
    sourceContentHash: "abc123",
    parserVersion: "progressive-pdf@1",
    policyFingerprint: largeDocumentPolicyFingerprint(DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY),
    chunkingStrategyVersion: "chunker@2",
    embeddingIdentity: IDENTITY,
    ...overrides,
  };
}

function checkpoint(
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
  overrides: Partial<ExtractionCheckpointRecord> = {},
): ExtractionCheckpointRecord {
  return {
    capsuleId,
    documentId,
    jobId: "job-1",
    strategy: "progressive-pdf",
    phase: "embedding",
    pageCursor: 12,
    sectionCursor: 0,
    objectCursor: 4096,
    extractedTextBytes: 65_536,
    chunkCursor: 40,
    embeddedChunkCursor: 24,
    lastEmbeddedChunkId: "doc#u3#24" as ExtractionCheckpointRecord["lastEmbeddedChunkId"],
    retryCount: 1,
    coverage: "partial",
    fingerprint: fingerprint(),
    terminalDiagnostics: [],
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

interface Fixture {
  readonly store: KnowledgeStore;
  readonly cleanup: () => void;
  readonly capsuleId: KnowledgeCapsuleId;
}

function buildFixture(): Fixture {
  const { store, cleanup } = freshStore();
  const capsuleId = "cap-ckpt" as KnowledgeCapsuleId;
  createCapsule(store, sampleCapsuleInput({ id: capsuleId }));
  return { store, cleanup, capsuleId };
}

describe("extraction checkpoint persistence", () => {
  let fixture: Fixture;
  beforeEach(() => {
    fixture = buildFixture();
  });
  afterEach(() => {
    fixture.cleanup();
  });

  it("round-trips a checkpoint", () => {
    const doc = "doc-1" as DocumentId;
    const record = checkpoint(fixture.capsuleId, doc);
    upsertExtractionCheckpoint(fixture.store._internal.db, record);
    const read = selectExtractionCheckpoint(fixture.store._internal.db, fixture.capsuleId, doc);
    expect(read).toEqual(record);
  });

  it("upserts in place, preserving created_at and updating phase/cursors", () => {
    const doc = "doc-1" as DocumentId;
    upsertExtractionCheckpoint(fixture.store._internal.db, checkpoint(fixture.capsuleId, doc));
    upsertExtractionCheckpoint(
      fixture.store._internal.db,
      checkpoint(fixture.capsuleId, doc, {
        phase: "complete",
        embeddedChunkCursor: 40,
        updatedAt: 300,
      }),
    );
    const read = selectExtractionCheckpoint(fixture.store._internal.db, fixture.capsuleId, doc);
    expect(read?.phase).toBe("complete");
    expect(read?.embeddedChunkCursor).toBe(40);
    expect(read?.createdAt).toBe(100);
    expect(read?.updatedAt).toBe(300);
    // Still exactly one row.
    expect(listExtractionCheckpoints(fixture.store._internal.db, fixture.capsuleId)).toHaveLength(
      1,
    );
  });

  it("persists a checkpoint with no lastEmbeddedChunkId", () => {
    const doc = "doc-2" as DocumentId;
    const record = checkpoint(fixture.capsuleId, doc, {
      phase: "extracted",
      lastEmbeddedChunkId: undefined,
    });
    upsertExtractionCheckpoint(fixture.store._internal.db, record);
    const read = selectExtractionCheckpoint(fixture.store._internal.db, fixture.capsuleId, doc);
    expect(read?.lastEmbeddedChunkId).toBeUndefined();
  });

  it("deletes a checkpoint", () => {
    const doc = "doc-3" as DocumentId;
    upsertExtractionCheckpoint(fixture.store._internal.db, checkpoint(fixture.capsuleId, doc));
    deleteExtractionCheckpoint(fixture.store._internal.db, fixture.capsuleId, doc);
    expect(
      selectExtractionCheckpoint(fixture.store._internal.db, fixture.capsuleId, doc),
    ).toBeUndefined();
  });

  it("cascades on capsule deletion", () => {
    const doc = "doc-4" as DocumentId;
    upsertExtractionCheckpoint(fixture.store._internal.db, checkpoint(fixture.capsuleId, doc));
    fixture.store._internal.db
      .prepare("DELETE FROM capsules WHERE id = :id")
      .run({ id: String(fixture.capsuleId) });
    expect(listExtractionCheckpoints(fixture.store._internal.db, fixture.capsuleId)).toHaveLength(
      0,
    );
  });
});

describe("resolveExtractionResume", () => {
  let fixture: Fixture;
  beforeEach(() => {
    fixture = buildFixture();
  });
  afterEach(() => {
    fixture.cleanup();
  });

  it("returns no-checkpoint when none exists", () => {
    const decision = resolveExtractionResume(
      fixture.store,
      fixture.capsuleId,
      "doc-x" as DocumentId,
      fingerprint(),
    );
    expect(decision.kind).toBe("no-checkpoint");
  });

  it("resumes a compatible mid-flight checkpoint", () => {
    const doc = "doc-1" as DocumentId;
    upsertExtractionCheckpoint(
      fixture.store._internal.db,
      checkpoint(fixture.capsuleId, doc, { phase: "embedding" }),
    );
    const decision = resolveExtractionResume(fixture.store, fixture.capsuleId, doc, fingerprint());
    expect(decision.kind).toBe("resume");
  });

  it("skips a completed checkpoint", () => {
    const doc = "doc-1" as DocumentId;
    upsertExtractionCheckpoint(
      fixture.store._internal.db,
      checkpoint(fixture.capsuleId, doc, { phase: "complete" }),
    );
    const decision = resolveExtractionResume(fixture.store, fixture.capsuleId, doc, fingerprint());
    expect(decision.kind).toBe("complete");
  });

  it.each([
    ["source-hash", fingerprint({ sourceContentHash: "deadbeef" })],
    ["parser-version", fingerprint({ parserVersion: "progressive-pdf@2" })],
    ["resource-policy", fingerprint({ policyFingerprint: "ldp1:0" })],
    ["chunking-strategy", fingerprint({ chunkingStrategyVersion: "chunker@9" })],
    [
      "embedding-identity",
      fingerprint({ embeddingIdentity: { ...IDENTITY, vectorDimensions: 3072 } }),
    ],
  ] as const)("refuses an incompatible checkpoint (%s)", (reason, current) => {
    const doc = "doc-1" as DocumentId;
    upsertExtractionCheckpoint(
      fixture.store._internal.db,
      checkpoint(fixture.capsuleId, doc, { phase: "chunking" }),
    );
    const decision = resolveExtractionResume(fixture.store, fixture.capsuleId, doc, current);
    expect(decision.kind).toBe("incompatible");
    if (decision.kind === "incompatible") {
      expect(decision.reasons).toContain(reason);
    }
  });
});

describe("resume projections", () => {
  let fixture: Fixture;
  beforeEach(() => {
    fixture = buildFixture();
  });
  afterEach(() => {
    fixture.cleanup();
  });

  it("classifies resumable vs terminal checkpoints", () => {
    expect(
      isResumableCheckpoint(
        checkpoint(fixture.capsuleId, "d" as DocumentId, { phase: "embedding" }),
      ),
    ).toBe(true);
    expect(
      isResumableCheckpoint(
        checkpoint(fixture.capsuleId, "d" as DocumentId, { phase: "cancelled" }),
      ),
    ).toBe(true);
    expect(
      isResumableCheckpoint(
        checkpoint(fixture.capsuleId, "d" as DocumentId, { phase: "complete" }),
      ),
    ).toBe(false);
    expect(
      isResumableCheckpoint(checkpoint(fixture.capsuleId, "d" as DocumentId, { phase: "failed" })),
    ).toBe(false);
  });

  it("lists only resumable documents and maps progress", () => {
    upsertExtractionCheckpoint(
      fixture.store._internal.db,
      checkpoint(fixture.capsuleId, "doc-a" as DocumentId, { phase: "embedding" }),
    );
    upsertExtractionCheckpoint(
      fixture.store._internal.db,
      checkpoint(fixture.capsuleId, "doc-b" as DocumentId, { phase: "complete" }),
    );
    const resumable = listResumableDocuments(fixture.store, fixture.capsuleId);
    expect(resumable).toEqual(["doc-a"]);

    const progress = checkpointToProgress(
      checkpoint(fixture.capsuleId, "doc-a" as DocumentId, { phase: "embedding", pageCursor: 7 }),
      "report.pdf",
    );
    expect(progress.processedPages).toBe(7);
    expect(progress.resumable).toBe(true);
    expect(progress.safeDisplayName).toBe("report.pdf");
  });
});
