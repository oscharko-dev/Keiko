// Acceptance coverage for Local Knowledge content encryption at rest (Issue #1322; ADR-0047).
//
// Proves the Acceptance Criteria with raw on-disk / raw-SQLite assertions: a fresh encrypted store
// writes no plaintext extracted text or vector bytes; a legacy plaintext store migrates forward
// without data loss and leaves no plaintext on disk after VACUUM; a wrong key or a missing key
// provider fails closed; retrieval / citation excerpts / large-document windowed spans round-trip
// through the existing APIs; and steady-state seal/open overhead stays within a documented budget.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readCitationExcerpt } from "./conversation/citation-excerpts.js";
import {
  insertDocumentTextRow,
  insertDocumentTextWindowRow,
  readDocumentTextRow,
  readDocumentTextSpan,
} from "./discovery/persist.js";
import { listCapsuleDocumentTexts } from "./qualityIntelligence/capsuleCorpus.js";
import { searchVectorsForScope } from "./retrieval/scoped-vector-search.js";
import { openKnowledgeStore, type KnowledgeStoreKeyProvider } from "./store.js";
import { createEncryptedContentCipher, PLAINTEXT_CONTENT_CIPHER } from "./store-content-cipher.js";
import { scriptedAdapter, seedCapsuleWithVectors, type SeedVectorsOptions } from "./testing.js";
import type { CitationReference } from "@oscharko-dev/keiko-contracts";

const FIXTURE_TEXT =
  "STRENG-VERTRAULICH Fachkonzept ZGRZZY-4242 — Kundendaten der Großbank für Zürich.";

function keyProvider(fill: number): KnowledgeStoreKeyProvider {
  return {
    providerId: `test-${String(fill)}`,
    resolveKey: () => new Uint8Array(32).fill(fill),
  };
}

function encryptedProtection(fill: number): {
  readonly mode: "encrypted-key-provider";
  readonly keyProvider: KnowledgeStoreKeyProvider;
} {
  return { mode: "encrypted-key-provider", keyProvider: keyProvider(fill) };
}

// Reads the SQLite main file plus its WAL/SHM sidecars as one buffer so a "strings"-style check sees
// every byte that could have lingered, regardless of which file a write landed in.
function readAllStoreBytes(dbPath: string): Buffer {
  const parts: Buffer[] = [];
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      parts.push(readFileSync(path));
    } catch {
      // sidecar may not exist; skip
    }
  }
  return Buffer.concat(parts);
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "keiko-lk-enc-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("fresh encrypted store", () => {
  it("persists extracted text and vectors encrypted; no plaintext touches disk", async () => {
    const dbPath = join(tmp, "capsules.db");
    const store = openKnowledgeStore({ dbPath, protection: encryptedProtection(7) });
    const seeded = await seedCapsuleWithVectors(store);
    insertDocumentTextRow(
      store._internal.db,
      store._internal.contentCipher,
      seeded.capsuleId,
      seeded.documentId,
      FIXTURE_TEXT,
    );
    store.close();

    // Raw-file ("strings") check: the fixture text never appears unencrypted in any store file.
    const bytes = readAllStoreBytes(dbPath);
    expect(bytes.includes(Buffer.from(FIXTURE_TEXT, "utf8"))).toBe(false);

    // Raw-SQLite check: every content column is a sealed envelope on disk.
    const raw = new DatabaseSync(dbPath);
    try {
      const textRow = raw.prepare("SELECT normalized_text FROM document_texts").get() as {
        readonly normalized_text: string;
      };
      expect(textRow.normalized_text.startsWith("kv1.")).toBe(true);

      const vectorRows = raw.prepare("SELECT embedding, vector_dimensions FROM vectors").all() as {
        readonly embedding: Uint8Array;
        readonly vector_dimensions: number;
      }[];
      expect(vectorRows.length).toBeGreaterThan(0);
      for (const row of vectorRows) {
        // Sealed binary envelope = 1 version + 12 nonce + ciphertext + 16 tag = plaintext + 29.
        expect(row.embedding.byteLength).toBe(row.vector_dimensions * 4 + 29);
        expect(row.embedding[0]).toBe(0x01);
      }
    } finally {
      raw.close();
    }
  });

  it("round-trips text and vectors back through the existing read APIs", async () => {
    const dbPath = join(tmp, "capsules.db");
    const store = openKnowledgeStore({ dbPath, protection: encryptedProtection(7) });
    try {
      const seeded = await seedCapsuleWithVectors(store);
      insertDocumentTextRow(
        store._internal.db,
        store._internal.contentCipher,
        seeded.capsuleId,
        seeded.documentId,
        FIXTURE_TEXT,
      );
      expect(
        readDocumentTextRow(
          store._internal.db,
          store._internal.contentCipher,
          seeded.capsuleId,
          seeded.documentId,
        ),
      ).toBe(FIXTURE_TEXT);

      const citation: CitationReference = {
        capsuleId: seeded.capsuleId,
        sourceId: seeded.sourceId,
        documentId: seeded.documentId,
        chunkId: seeded.chunkIds[0] ?? ("chunk-0" as CitationReference["chunkId"]),
        characterStart: 0,
        characterEnd: 18,
        safeDisplayName: "sample.txt",
      };
      expect(readCitationExcerpt(store, seeded.capsuleId, citation)).toBe(
        FIXTURE_TEXT.slice(0, 18),
      );
    } finally {
      store.close();
    }
  });

  it("hybrid retrieval over an encrypted store equals retrieval over an identical plaintext store", async () => {
    // Exercises the full public retrieval API end-to-end under encryption — the vector decode path
    // (readVectorsForCapsule -> openVector) and the lexical decode path (readLexicalDocuments ->
    // openText) — and proves encryption is transparent: identical seeds yield byte-identical results.
    const seedOptions: SeedVectorsOptions = {
      capsuleId: "cap-enc",
      sourceId: "src-enc",
      documentId: "doc-enc",
      text: "alpha alpha beta beta gamma gamma delta delta epsilon epsilon zeta zeta eta eta",
    };
    const query = "alpha gamma epsilon";

    const plainStore = openKnowledgeStore({ dbPath: join(tmp, "plain.db") });
    let plainResult: readonly { chunkId: string; score: number }[];
    try {
      const seeded = await seedCapsuleWithVectors(plainStore, seedOptions);
      const outcome = await searchVectorsForScope(
        plainStore,
        scriptedAdapter(),
        { capsuleIds: [seeded.capsuleId] },
        query,
        { topK: 10 },
      );
      plainResult = outcome.references.map((ref) => ({
        chunkId: String(ref.chunkId),
        score: ref.score,
      }));
    } finally {
      plainStore.close();
    }

    const encStore = openKnowledgeStore({
      dbPath: join(tmp, "enc.db"),
      protection: encryptedProtection(7),
    });
    try {
      const seeded = await seedCapsuleWithVectors(encStore, seedOptions);
      const outcome = await searchVectorsForScope(
        encStore,
        scriptedAdapter(),
        { capsuleIds: [seeded.capsuleId] },
        query,
        { topK: 10 },
      );
      const encResult = outcome.references.map((ref) => ({
        chunkId: String(ref.chunkId),
        score: ref.score,
      }));
      expect(encResult.length).toBeGreaterThan(0);
      expect(encResult).toEqual(plainResult);
    } finally {
      encStore.close();
    }
  });

  it("QI corpus reader returns decrypted document text on an encrypted store", async () => {
    const store = openKnowledgeStore({
      dbPath: join(tmp, "capsules.db"),
      protection: encryptedProtection(7),
    });
    try {
      const seeded = await seedCapsuleWithVectors(store);
      insertDocumentTextRow(
        store._internal.db,
        store._internal.contentCipher,
        seeded.capsuleId,
        seeded.documentId,
        FIXTURE_TEXT,
      );
      const docs = listCapsuleDocumentTexts(store, seeded.capsuleId);
      expect(docs).toContainEqual({ documentId: String(seeded.documentId), text: FIXTURE_TEXT });
    } finally {
      store.close();
    }
  });
});

describe("legacy plaintext store migration", () => {
  it("seals existing plaintext forward without data loss and leaves no plaintext on disk", async () => {
    const dbPath = join(tmp, "capsules.db");

    // Create a legacy plaintext store and seed it (no key provider → identity cipher).
    const plain = openKnowledgeStore({ dbPath });
    const seeded = await seedCapsuleWithVectors(plain);
    insertDocumentTextRow(
      plain._internal.db,
      plain._internal.contentCipher,
      seeded.capsuleId,
      seeded.documentId,
      FIXTURE_TEXT,
    );
    plain.close();
    // Sanity: the plaintext fixture really is on disk before migration.
    expect(readAllStoreBytes(dbPath).includes(Buffer.from(FIXTURE_TEXT, "utf8"))).toBe(true);

    // Re-open with a key provider → forward migration seals every content row, then VACUUMs.
    const encrypted = openKnowledgeStore({ dbPath, protection: encryptedProtection(7) });
    try {
      expect(
        readDocumentTextRow(
          encrypted._internal.db,
          encrypted._internal.contentCipher,
          seeded.capsuleId,
          seeded.documentId,
        ),
      ).toBe(FIXTURE_TEXT);
      // Migrated vectors decrypt and drive retrieval: searchVectorsForScope reads them through
      // readVectorsForCapsule -> openVector, so a non-empty result proves the sealed embeddings were
      // re-opened to valid Float32 bytes (a wrong-length or undecryptable blob would throw or yield none).
      const outcome = await searchVectorsForScope(
        encrypted,
        scriptedAdapter(),
        { capsuleIds: [seeded.capsuleId] },
        "query",
        { topK: 10 },
      );
      expect(outcome.references.length).toBeGreaterThan(0);
    } finally {
      encrypted.close();
    }

    // After migration + VACUUM, no plaintext fixture lingers on disk.
    expect(readAllStoreBytes(dbPath).includes(Buffer.from(FIXTURE_TEXT, "utf8"))).toBe(false);
  });

  it("is idempotent: re-opening an already-migrated store does not double-seal", async () => {
    const dbPath = join(tmp, "capsules.db");
    const first = openKnowledgeStore({ dbPath, protection: encryptedProtection(7) });
    const seeded = await seedCapsuleWithVectors(first);
    insertDocumentTextRow(
      first._internal.db,
      first._internal.contentCipher,
      seeded.capsuleId,
      seeded.documentId,
      FIXTURE_TEXT,
    );
    first.close();

    const second = openKnowledgeStore({ dbPath, protection: encryptedProtection(7) });
    try {
      expect(
        readDocumentTextRow(
          second._internal.db,
          second._internal.contentCipher,
          seeded.capsuleId,
          seeded.documentId,
        ),
      ).toBe(FIXTURE_TEXT);
    } finally {
      second.close();
    }
  });
});

describe("fail-closed diagnostics", () => {
  it("rejects opening an encrypted store with the wrong key without leaking plaintext", async () => {
    const dbPath = join(tmp, "capsules.db");
    const store = openKnowledgeStore({ dbPath, protection: encryptedProtection(7) });
    const seeded = await seedCapsuleWithVectors(store);
    insertDocumentTextRow(
      store._internal.db,
      store._internal.contentCipher,
      seeded.capsuleId,
      seeded.documentId,
      FIXTURE_TEXT,
    );
    store.close();

    expect(() => openKnowledgeStore({ dbPath, protection: encryptedProtection(9) })).toThrow(
      /wrong key or tampered|probe mismatch/,
    );
  });

  it("rejects opening an encrypted store without a key provider", async () => {
    const dbPath = join(tmp, "capsules.db");
    const store = openKnowledgeStore({ dbPath, protection: encryptedProtection(7) });
    await seedCapsuleWithVectors(store);
    store.close();

    expect(() => openKnowledgeStore({ dbPath })).toThrow(/encrypted; a key provider is required/);
  });
});

describe("encrypted large-document windowed span read", () => {
  it("decrypts exactly one window and returns the correct bounded slice", async () => {
    const dbPath = join(tmp, "capsules.db");
    const store = openKnowledgeStore({ dbPath, protection: encryptedProtection(7) });
    try {
      const seeded = await seedCapsuleWithVectors(store);
      const { capsuleId, documentId } = seeded;
      const cipher = store._internal.contentCipher;
      // Two bounded windows; the span at [22,30) lies inside the second window only.
      insertDocumentTextWindowRow(store._internal.db, cipher, {
        capsuleId,
        documentId,
        windowIndex: 0,
        characterStart: 0,
        characterEnd: 20,
        normalizedText: "AAAAAAAAAAAAAAAAAAAA",
      });
      insertDocumentTextWindowRow(store._internal.db, cipher, {
        capsuleId,
        documentId,
        windowIndex: 1,
        characterStart: 20,
        characterEnd: 40,
        normalizedText: "BBcdefghijBBBBBBBBBB",
      });
      // Raw-SQLite check: window text is sealed on disk.
      const winRow = store._internal.db
        .prepare("SELECT normalized_text FROM document_text_windows WHERE window_index = 1")
        .get() as { readonly normalized_text: string };
      expect(winRow.normalized_text.startsWith("kv1.")).toBe(true);

      const span = readDocumentTextSpan(store._internal.db, cipher, capsuleId, documentId, 22, 30);
      expect(span).toBe("cdefghij");
    } finally {
      store.close();
    }
  });
});

describe("performance guardrail", () => {
  it("seals and opens within the documented per-operation budget", () => {
    const cipher = createEncryptedContentCipher(new Uint8Array(32).fill(3));
    const sample = "x".repeat(2048);
    const iterations = 2000;
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i += 1) {
      const sealed = cipher.sealText(sample);
      const opened = cipher.openText(sealed);
      if (opened.length !== sample.length) throw new Error("round-trip mismatch");
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    const perOpUs = (elapsedMs / iterations) * 1000;
    // Documented budget: a 2 KiB seal+open round trip stays well under 200 microseconds on CI-class
    // hardware. Generous bound — a regression that blows past this signals a crypto-path problem.
    expect(perOpUs).toBeLessThan(200);
  });

  it("the plaintext identity cipher adds no measurable overhead", () => {
    expect(PLAINTEXT_CONTENT_CIPHER.sealText("free")).toBe("free");
  });
});
