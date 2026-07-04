// GEN-PERF-PERSISTENCE-011 regression: the PDF preview delivery layer opens a fresh reader per HTTP
// range request, and each open fully decrypts + SHA-256-verifies the whole blob. For one document a
// viewer issues many sequential range reads, so the same bytes were decrypted+verified repeatedly.
// The fix caches the ALREADY-VERIFIED decrypted bytes keyed by (capsule, contentHash), so N reads
// for one document decrypt at most once.
//
// Mechanism proof: spy on the store's contentCipher.openBlob — 10 sequential by-hash reads for one
// contentHash must open (decrypt) the blob at most once. Also proves: integrity is verified before
// caching (a hash-mismatch is never cached), and the TTL expiry forces a re-verify.

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DocumentId,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";

import { createCapsule } from "./capsule-lifecycle.js";
import { addSourceToCapsule } from "./source-lifecycle.js";
import { sampleCapsuleInput, sampleSourceInput } from "./_support.js";
import { openKnowledgeStore, type KnowledgeStoreKeyProvider } from "./store.js";
import {
  __resetVerifiedBlobCacheForTests,
  PDF_DOCUMENT_BLOB_MEDIA_TYPE,
  readPdfDocumentBlobByContentHash,
  writePdfDocumentBlob,
} from "./document-blob-store.js";

const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj<<>>\nendobj\ntrailer<<>>\n%%EOF\n", "utf8");

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function keyProvider(fill: number): KnowledgeStoreKeyProvider {
  return {
    providerId: `blob-decrypt-cache-${String(fill)}`,
    resolveKey: () => new Uint8Array(32).fill(fill),
  };
}

function seedEncryptedPdf(store: ReturnType<typeof openKnowledgeStore>): {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly documentId: DocumentId;
  readonly contentHash: string;
} {
  const capsule = createCapsule(
    store,
    sampleCapsuleInput({ id: "cap-blob-cache" as KnowledgeCapsuleId }),
  );
  const source = addSourceToCapsule(store, capsule.id, sampleSourceInput("src-blob-cache"));
  const documentId = "doc-blob-cache" as DocumentId;
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
  writePdfDocumentBlob(store, {
    capsuleId: capsule.id,
    sourceId: source.id,
    documentId,
    contentHash,
    byteLength: PDF_BYTES.byteLength,
    mediaType: PDF_DOCUMENT_BLOB_MEDIA_TYPE,
    bytes: PDF_BYTES,
  });
  return { capsuleId: capsule.id, sourceId: source.id, documentId, contentHash };
}

let tmp: string | undefined;

afterEach(() => {
  __resetVerifiedBlobCacheForTests();
  vi.restoreAllMocks();
  if (tmp !== undefined) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

function openEncrypted(): ReturnType<typeof openKnowledgeStore> {
  tmp = mkdtempSync(join(tmpdir(), "keiko-lk-blob-cache-"));
  return openKnowledgeStore({
    dbPath: join(tmp, "capsules.db"),
    protection: { mode: "encrypted-key-provider", keyProvider: keyProvider(9) },
  });
}

describe("PDF verified-blob decrypt cache (GEN-PERF-PERSISTENCE-011)", () => {
  it("decrypts at most once across 10 sequential by-hash range reads for one contentHash", () => {
    __resetVerifiedBlobCacheForTests();
    const store = openEncrypted();
    try {
      const seeded = seedEncryptedPdf(store);
      const openBlobSpy = vi.spyOn(store._internal.contentCipher, "openBlob");

      for (let i = 0; i < 10; i += 1) {
        const result = readPdfDocumentBlobByContentHash(
          store,
          seeded.capsuleId,
          seeded.contentHash,
        );
        expect(result.kind).toBe("ok");
        if (result.kind === "ok") {
          expect(Buffer.from(result.blob.bytes).equals(PDF_BYTES)).toBe(true);
        }
      }

      // PRE-FIX: 10 opens (one decrypt per range read). POST-FIX: at most one.
      expect(openBlobSpy).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
    }
  });

  it("re-decrypts after the TTL expires (bounded, in-process only)", () => {
    let clock = 1_000_000;
    __resetVerifiedBlobCacheForTests(() => clock);
    const store = openEncrypted();
    try {
      const seeded = seedEncryptedPdf(store);
      const openBlobSpy = vi.spyOn(store._internal.contentCipher, "openBlob");

      readPdfDocumentBlobByContentHash(store, seeded.capsuleId, seeded.contentHash);
      readPdfDocumentBlobByContentHash(store, seeded.capsuleId, seeded.contentHash);
      expect(openBlobSpy).toHaveBeenCalledTimes(1);

      // Advance past the 3-minute TTL -> next read re-decrypts + re-verifies.
      clock += 3 * 60 * 1000 + 1;
      const result = readPdfDocumentBlobByContentHash(store, seeded.capsuleId, seeded.contentHash);
      expect(result.kind).toBe("ok");
      expect(openBlobSpy).toHaveBeenCalledTimes(2);
    } finally {
      store.close();
    }
  });

  it("never caches (or serves) tampered bytes — integrity is verified before caching", () => {
    __resetVerifiedBlobCacheForTests();
    const store = openEncrypted();
    try {
      const seeded = seedEncryptedPdf(store);
      // Corrupt the sealed blob so decrypt yields hash-mismatched bytes.
      store._internal.db
        .prepare(
          "UPDATE document_blobs SET blob_bytes = ? WHERE capsule_id = ? AND content_hash = ?",
        )
        .run(
          Buffer.from("garbage-not-the-pdf", "utf8"),
          String(seeded.capsuleId),
          seeded.contentHash,
        );

      const first = readPdfDocumentBlobByContentHash(store, seeded.capsuleId, seeded.contentHash);
      expect(first.kind).toBe("unreadable");
      // A second read must ALSO be unreadable — the failure was not cached as a positive result.
      const second = readPdfDocumentBlobByContentHash(store, seeded.capsuleId, seeded.contentHash);
      expect(second.kind).toBe("unreadable");
    } finally {
      store.close();
    }
  });
});
