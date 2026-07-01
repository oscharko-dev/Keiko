import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type {
  DocumentId,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";

import { createCapsule } from "./capsule-lifecycle.js";
import { insertDocumentRow } from "./discovery/persist.js";
import { addSourceToCapsule } from "./source-lifecycle.js";
import { freshStore, sampleCapsuleInput, sampleSourceInput } from "./_support.js";
import { openKnowledgeStore, type KnowledgeStoreKeyProvider } from "./store.js";

import {
  MAX_PDF_DOCUMENT_BLOB_BYTES,
  PDF_DOCUMENT_BLOB_MEDIA_TYPE,
  readPdfDocumentBlob,
  readPdfDocumentBlobByContentHash,
  writePdfDocumentBlob,
} from "./document-blob-store.js";

const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj<<>>\nendobj\ntrailer<<>>\n%%EOF\n", "utf8");

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function keyProvider(fill: number): KnowledgeStoreKeyProvider {
  return {
    providerId: `blob-test-${String(fill)}`,
    resolveKey: () => new Uint8Array(32).fill(fill),
  };
}

function encryptedProtection(fill: number): {
  readonly mode: "encrypted-key-provider";
  readonly keyProvider: KnowledgeStoreKeyProvider;
} {
  return { mode: "encrypted-key-provider", keyProvider: keyProvider(fill) };
}

function seedPdfDocument(store: ReturnType<typeof openKnowledgeStore>): {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly documentId: DocumentId;
  readonly contentHash: string;
} {
  const capsule = createCapsule(
    store,
    sampleCapsuleInput({ id: "cap-blob" as KnowledgeCapsuleId }),
  );
  const source = addSourceToCapsule(store, capsule.id, sampleSourceInput("src-blob"));
  const documentId = "doc-blob" as DocumentId;
  const contentHash = sha256Hex(PDF_BYTES);
  store._internal.db
    .prepare(
      [
        "INSERT INTO documents (",
        "  id, capsule_id, source_id, document_path, size_bytes, media_type, content_hash,",
        "  parser_id, parser_version, last_extracted_at, status, safe_display_name",
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ].join(" "),
    )
    .run(
      String(documentId),
      String(capsule.id),
      String(source.id),
      "docs/policy.pdf",
      PDF_BYTES.byteLength,
      PDF_DOCUMENT_BLOB_MEDIA_TYPE,
      contentHash,
      "pdf",
      "1.0.0",
      1000,
      "extracted",
      "policy.pdf",
    );
  return { capsuleId: capsule.id, sourceId: source.id, documentId, contentHash };
}

let tmp: string | undefined;

afterEach(() => {
  if (tmp !== undefined) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

describe("PDF document blob store", () => {
  it("stores and reads PDF bytes through a content-addressed capsule-local blob", () => {
    const fresh = freshStore();
    try {
      const seeded = seedPdfDocument(fresh.store);
      const stored = writePdfDocumentBlob(fresh.store, {
        capsuleId: seeded.capsuleId,
        sourceId: seeded.sourceId,
        documentId: seeded.documentId,
        contentHash: seeded.contentHash,
        byteLength: PDF_BYTES.byteLength,
        mediaType: PDF_DOCUMENT_BLOB_MEDIA_TYPE,
        bytes: PDF_BYTES,
      });
      expect(stored.kind).toBe("stored");
      const docRow = fresh.store._internal.db
        .prepare("SELECT blob_ref FROM documents WHERE capsule_id = ? AND id = ?")
        .get(String(seeded.capsuleId), String(seeded.documentId)) as
        { readonly blob_ref: string | null } | undefined;
      expect(docRow?.blob_ref).toBe(seeded.contentHash);

      const loaded = readPdfDocumentBlob(fresh.store, seeded.capsuleId, seeded.documentId);
      expect(loaded.kind).toBe("ok");
      if (loaded.kind !== "ok") return;
      expect(Buffer.from(loaded.blob.bytes).equals(PDF_BYTES)).toBe(true);
      expect(loaded.blob.contentHash).toBe(seeded.contentHash);
      expect(loaded.blob.storageKind).toBe("plaintext");
    } finally {
      fresh.cleanup();
    }
  });

  it("skips oversized blobs before materializing an unbounded payload", () => {
    const fresh = freshStore();
    try {
      const seeded = seedPdfDocument(fresh.store);
      const stored = writePdfDocumentBlob(fresh.store, {
        capsuleId: seeded.capsuleId,
        sourceId: seeded.sourceId,
        documentId: seeded.documentId,
        contentHash: seeded.contentHash,
        byteLength: MAX_PDF_DOCUMENT_BLOB_BYTES + 1,
        mediaType: PDF_DOCUMENT_BLOB_MEDIA_TYPE,
        bytes: PDF_BYTES,
      });
      expect(stored).toEqual({ kind: "skipped", reason: "oversized" });
      const row = fresh.store._internal.db
        .prepare("SELECT blob_ref FROM documents WHERE capsule_id = ? AND id = ?")
        .get(String(seeded.capsuleId), String(seeded.documentId)) as
        { readonly blob_ref: string | null } | undefined;
      expect(row?.blob_ref).toBeNull();
    } finally {
      fresh.cleanup();
    }
  });

  it("round-trips encrypted PDF blobs without storing plaintext bytes", () => {
    tmp = mkdtempSync(join(tmpdir(), "keiko-lk-blob-"));
    const dbPath = join(tmp, "capsules.db");
    const store = openKnowledgeStore({ dbPath, protection: encryptedProtection(7) });
    const seeded = seedPdfDocument(store);
    const stored = writePdfDocumentBlob(store, {
      capsuleId: seeded.capsuleId,
      sourceId: seeded.sourceId,
      documentId: seeded.documentId,
      contentHash: seeded.contentHash,
      byteLength: PDF_BYTES.byteLength,
      mediaType: PDF_DOCUMENT_BLOB_MEDIA_TYPE,
      bytes: PDF_BYTES,
    });
    expect(stored.kind).toBe("stored");
    const raw = store._internal.db
      .prepare("SELECT storage_kind, seal_version, blob_bytes FROM document_blobs")
      .get() as {
      readonly storage_kind: string;
      readonly seal_version: string | null;
      readonly blob_bytes: Uint8Array;
    };
    expect(raw.storage_kind).toBe("sealed");
    expect(raw.seal_version).toBe("aes-256-gcm/v1");
    expect(Buffer.from(raw.blob_bytes).equals(PDF_BYTES)).toBe(false);
    store.close();

    const reopened = openKnowledgeStore({ dbPath, protection: encryptedProtection(7) });
    try {
      const loaded = readPdfDocumentBlob(reopened, seeded.capsuleId, seeded.documentId);
      expect(loaded.kind).toBe("ok");
      if (loaded.kind !== "ok") return;
      expect(Buffer.from(loaded.blob.bytes).equals(PDF_BYTES)).toBe(true);
      expect(loaded.blob.storageKind).toBe("sealed");
    } finally {
      reopened.close();
    }
  });

  it("rejects tampered blob bytes instead of delivering mismatched content", () => {
    const fresh = freshStore();
    try {
      const seeded = seedPdfDocument(fresh.store);
      writePdfDocumentBlob(fresh.store, {
        capsuleId: seeded.capsuleId,
        sourceId: seeded.sourceId,
        documentId: seeded.documentId,
        contentHash: seeded.contentHash,
        byteLength: PDF_BYTES.byteLength,
        mediaType: PDF_DOCUMENT_BLOB_MEDIA_TYPE,
        bytes: PDF_BYTES,
      });
      fresh.store._internal.db
        .prepare(
          "UPDATE document_blobs SET blob_bytes = ? WHERE capsule_id = ? AND content_hash = ?",
        )
        .run(
          Buffer.from("not the indexed pdf", "utf8"),
          String(seeded.capsuleId),
          seeded.contentHash,
        );
      expect(readPdfDocumentBlob(fresh.store, seeded.capsuleId, seeded.documentId)).toEqual({
        kind: "unreadable",
        reason: "hash-mismatch",
      });
    } finally {
      fresh.cleanup();
    }
  });

  it("preserves historical PDF blobs when a document row is upserted with a new hash", () => {
    const fresh = freshStore();
    try {
      const seeded = seedPdfDocument(fresh.store);
      writePdfDocumentBlob(fresh.store, {
        capsuleId: seeded.capsuleId,
        sourceId: seeded.sourceId,
        documentId: seeded.documentId,
        contentHash: seeded.contentHash,
        byteLength: PDF_BYTES.byteLength,
        mediaType: PDF_DOCUMENT_BLOB_MEDIA_TYPE,
        bytes: PDF_BYTES,
      });

      const changedBytes = Buffer.from("%PDF-1.4\nchanged\n%%EOF\n", "utf8");
      insertDocumentRow(fresh.store._internal.db, {
        id: seeded.documentId,
        capsuleId: seeded.capsuleId,
        sourceId: String(seeded.sourceId),
        documentPath: "docs/policy.pdf",
        sizeBytes: changedBytes.byteLength,
        mediaType: PDF_DOCUMENT_BLOB_MEDIA_TYPE,
        contentHash: sha256Hex(changedBytes),
        parserId: "pdf",
        parserVersion: "1.0.0",
        lastExtractedAt: 2000,
        status: "extracted",
        safeDisplayName: "policy.pdf",
      });

      const current = readPdfDocumentBlob(fresh.store, seeded.capsuleId, seeded.documentId);
      expect(current.kind).toBe("missing");
      const historical = readPdfDocumentBlobByContentHash(
        fresh.store,
        seeded.capsuleId,
        seeded.contentHash,
        {
          documentId: seeded.documentId,
          fileName: "policy.pdf",
          sourceId: seeded.sourceId,
        },
      );
      expect(historical.kind).toBe("ok");
      if (historical.kind !== "ok") return;
      expect(Buffer.from(historical.blob.bytes).equals(PDF_BYTES)).toBe(true);
      expect(historical.blob.documentId).toBe(String(seeded.documentId));
      expect(historical.blob.sourceId).toBe(String(seeded.sourceId));
    } finally {
      fresh.cleanup();
    }
  });
});
