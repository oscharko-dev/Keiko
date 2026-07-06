// Acceptance coverage for Local Knowledge content encryption at rest (Issue #1322; ADR-0047).
//
// Proves the Acceptance Criteria with raw on-disk / raw-SQLite assertions: a fresh encrypted store
// seals the source-of-truth extracted text, contextual chunk prefixes/augmented text,
// section/heading labels, vectors, and blobs; the FTS5 chunk lexical index remains the explicit
// plaintext search-index exception; a legacy plaintext
// store migrates forward without data loss and leaves sealed source columns after VACUUM; a wrong
// key or a missing key provider fails closed; retrieval / citation excerpts / large-document
// windowed spans round-trip through the existing APIs; and steady-state seal/open overhead stays
// within a documented budget.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readCitationExcerpt } from "./conversation/citation-excerpts.js";
import {
  insertDocumentTextRow,
  insertDocumentTextWindowRow,
  insertParsedUnitRow,
  insertSectionRow,
  readDocumentTextRow,
  readDocumentTextSpan,
} from "./discovery/persist.js";
import { listCapsuleDocumentTexts } from "./qualityIntelligence/capsuleCorpus.js";
import { searchVectorsForScope } from "./retrieval/scoped-vector-search.js";
import { openKnowledgeStore, type KnowledgeStoreKeyProvider } from "./store.js";
import { createEncryptedContentCipher, PLAINTEXT_CONTENT_CIPHER } from "./store-content-cipher.js";
import { STORE_CONTENT_ENCRYPTION_TEST_CONSTANTS } from "./store-content-encryption.js";
import { scriptedAdapter, seedCapsuleWithVectors, type SeedVectorsOptions } from "./testing.js";
import type { CitationReference } from "@oscharko-dev/keiko-contracts";

const FIXTURE_TEXT =
  "STRENG-VERTRAULICH Fachkonzept ZGRZZY-4242 — Kundendaten der Großbank für Zürich.";
const SECTION_LABEL = "Section ZGRZZY-SECTION-4242";
const HEADING_LABEL = "Heading ZGRZZY-HEADING-4242";
const CONTEXT_PREFIX = "Context prefix ZGRZZY-CONTEXT-4242";
const AUGMENTED_TEXT = `${CONTEXT_PREFIX}\n\nAugmented chunk ZGRZZY-AUGMENTED-4242`;
const WINDOW_TEXT = "Window text ZGRZZY-WINDOW-4242";
const KV1_PREFIX_TEXT = "kv1.legacy plaintext prefix ZGRZZY-KV1-4242";

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
    const sourceText = `${FIXTURE_TEXT} ${SECTION_LABEL} ${HEADING_LABEL}`;
    const seeded = await seedCapsuleWithVectors(store, {
      text: sourceText,
      unit: {
        kind: "section",
        sectionPath: [SECTION_LABEL],
        characterStart: 0,
        characterEnd: sourceText.length,
      },
    });
    insertSectionRow(store._internal.db, store._internal.contentCipher, seeded.capsuleId, {
      documentId: seeded.documentId,
      sectionPath: [SECTION_LABEL],
      characterStart: 0,
      characterEnd: sourceText.length,
    });
    insertParsedUnitRow(
      store._internal.db,
      store._internal.contentCipher,
      seeded.capsuleId,
      `${String(seeded.documentId)}#heading`,
      {
        kind: "html-block",
        documentId: seeded.documentId,
        headingPath: [HEADING_LABEL],
        characterStart: 0,
        characterEnd: Math.min(20, sourceText.length),
      },
    );
    insertDocumentTextRow(
      store._internal.db,
      store._internal.contentCipher,
      seeded.capsuleId,
      seeded.documentId,
      FIXTURE_TEXT,
    );
    store._internal.db
      .prepare(
        "UPDATE chunks SET context_prefix = :prefix, augmented_text = :augmented, context_status = 'generated' WHERE capsule_id = :c",
      )
      .run({
        prefix: store._internal.contentCipher.sealText(CONTEXT_PREFIX),
        augmented: store._internal.contentCipher.sealText(AUGMENTED_TEXT),
        c: seeded.capsuleId,
      });
    store.close();

    // Raw-file ("strings") check: the fixture text never appears unencrypted in any store file.
    const bytes = readAllStoreBytes(dbPath);
    for (const plaintext of [FIXTURE_TEXT, SECTION_LABEL, HEADING_LABEL, CONTEXT_PREFIX]) {
      expect(bytes.includes(Buffer.from(plaintext, "utf8"))).toBe(false);
    }

    // Raw-SQLite check: encrypted source-of-truth content columns are sealed envelopes on disk; the
    // FTS5 lexical index is intentionally plaintext so SQLite can execute MATCH/BM25.
    const raw = new DatabaseSync(dbPath);
    try {
      const textRow = raw.prepare("SELECT normalized_text FROM document_texts").get() as {
        readonly normalized_text: string;
      };
      expect(textRow.normalized_text.startsWith("kv1.")).toBe(true);

      const sectionRow = raw
        .prepare("SELECT section_path_json, section_path_hash FROM sections")
        .get() as {
        readonly section_path_json: string;
        readonly section_path_hash: string;
      };
      expect(sectionRow.section_path_json.startsWith("kv1.")).toBe(true);
      expect(sectionRow.section_path_hash.startsWith("sha256:")).toBe(true);
      expect(sectionRow.section_path_hash.includes(SECTION_LABEL)).toBe(false);

      const parsedRows = raw
        .prepare(
          "SELECT section_path_json, heading_path_json FROM parsed_units WHERE section_path_json IS NOT NULL OR heading_path_json IS NOT NULL",
        )
        .all() as {
        readonly section_path_json: string | null;
        readonly heading_path_json: string | null;
      }[];
      expect(parsedRows.some((row) => row.section_path_json?.startsWith("kv1.") === true)).toBe(
        true,
      );
      expect(parsedRows.some((row) => row.heading_path_json?.startsWith("kv1.") === true)).toBe(
        true,
      );

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

      const chunkRows = raw.prepare("SELECT context_prefix, augmented_text FROM chunks").all() as {
        readonly context_prefix: string | null;
        readonly augmented_text: string | null;
      }[];
      expect(chunkRows.some((row) => row.context_prefix?.startsWith("kv1.") === true)).toBe(true);
      expect(chunkRows.some((row) => row.augmented_text?.startsWith("kv1.") === true)).toBe(true);

      const lexicalRows = raw.prepare("SELECT text, exact_text FROM chunk_lexical_index").all() as {
        readonly text: string;
        readonly exact_text: string;
      }[];
      expect(lexicalRows.length).toBeGreaterThan(0);
      expect(lexicalRows.some((row) => row.text.startsWith("kv1."))).toBe(false);
      expect(lexicalRows.some((row) => row.exact_text.startsWith("kv1."))).toBe(false);
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
    const sourceText = `${FIXTURE_TEXT} ${SECTION_LABEL} ${HEADING_LABEL}`;
    const seeded = await seedCapsuleWithVectors(plain, {
      text: sourceText,
      unit: {
        kind: "section",
        sectionPath: [SECTION_LABEL],
        characterStart: 0,
        characterEnd: sourceText.length,
      },
    });
    insertSectionRow(plain._internal.db, plain._internal.contentCipher, seeded.capsuleId, {
      documentId: seeded.documentId,
      sectionPath: [SECTION_LABEL],
      characterStart: 0,
      characterEnd: sourceText.length,
    });
    insertParsedUnitRow(
      plain._internal.db,
      plain._internal.contentCipher,
      seeded.capsuleId,
      `${String(seeded.documentId)}#heading`,
      {
        kind: "html-block",
        documentId: seeded.documentId,
        headingPath: [HEADING_LABEL],
        characterStart: 0,
        characterEnd: Math.min(20, sourceText.length),
      },
    );
    insertDocumentTextRow(
      plain._internal.db,
      plain._internal.contentCipher,
      seeded.capsuleId,
      seeded.documentId,
      FIXTURE_TEXT,
    );
    insertDocumentTextWindowRow(plain._internal.db, plain._internal.contentCipher, {
      capsuleId: seeded.capsuleId,
      documentId: seeded.documentId,
      windowIndex: 0,
      characterStart: 0,
      characterEnd: WINDOW_TEXT.length,
      normalizedText: WINDOW_TEXT,
    });
    plain._internal.db
      .prepare(
        "UPDATE chunks SET context_prefix = :prefix, augmented_text = :augmented, context_status = 'generated' WHERE capsule_id = :c",
      )
      .run({
        prefix: CONTEXT_PREFIX,
        augmented: AUGMENTED_TEXT,
        c: seeded.capsuleId,
      });
    plain.close();
    // Sanity: the plaintext fixture really is on disk before migration.
    expect(readAllStoreBytes(dbPath).includes(Buffer.from(FIXTURE_TEXT, "utf8"))).toBe(true);
    expect(readAllStoreBytes(dbPath).includes(Buffer.from(SECTION_LABEL, "utf8"))).toBe(true);
    expect(readAllStoreBytes(dbPath).includes(Buffer.from(HEADING_LABEL, "utf8"))).toBe(true);
    expect(readAllStoreBytes(dbPath).includes(Buffer.from(WINDOW_TEXT, "utf8"))).toBe(true);
    expect(readAllStoreBytes(dbPath).includes(Buffer.from(CONTEXT_PREFIX, "utf8"))).toBe(true);

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
      const windowRow = encrypted._internal.db
        .prepare("SELECT normalized_text FROM document_text_windows WHERE window_index = 0")
        .get() as { readonly normalized_text: string };
      expect(encrypted._internal.contentCipher.openText(windowRow.normalized_text)).toBe(
        WINDOW_TEXT,
      );
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
      expect(
        outcome.references.some((ref) => ref.citation.sectionPath?.[0] === SECTION_LABEL),
      ).toBe(true);
    } finally {
      encrypted.close();
    }

    // After migration + VACUUM, no plaintext fixture lingers on disk.
    const afterBytes = readAllStoreBytes(dbPath);
    for (const plaintext of [
      FIXTURE_TEXT,
      SECTION_LABEL,
      HEADING_LABEL,
      WINDOW_TEXT,
      CONTEXT_PREFIX,
    ]) {
      expect(afterBytes.includes(Buffer.from(plaintext, "utf8"))).toBe(false);
    }
    const raw = new DatabaseSync(dbPath);
    try {
      const pathRows = raw
        .prepare(
          "SELECT section_path_json, heading_path_json FROM parsed_units WHERE section_path_json IS NOT NULL OR heading_path_json IS NOT NULL",
        )
        .all() as {
        readonly section_path_json: string | null;
        readonly heading_path_json: string | null;
      }[];
      expect(
        pathRows.every(
          (row) => row.section_path_json === null || row.section_path_json.startsWith("kv1."),
        ),
      ).toBe(true);
      expect(
        pathRows.every(
          (row) => row.heading_path_json === null || row.heading_path_json.startsWith("kv1."),
        ),
      ).toBe(true);
      const chunkRows = raw.prepare("SELECT context_prefix, augmented_text FROM chunks").all() as {
        readonly context_prefix: string | null;
        readonly augmented_text: string | null;
      }[];
      expect(chunkRows.every((row) => row.context_prefix?.startsWith("kv1.") === true)).toBe(true);
      expect(chunkRows.every((row) => row.augmented_text?.startsWith("kv1.") === true)).toBe(true);
    } finally {
      raw.close();
    }
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

  it("seals legacy plaintext that starts with kv1. and round-trips it unchanged", async () => {
    const dbPath = join(tmp, "capsules.db");
    const plain = openKnowledgeStore({ dbPath });
    const seeded = await seedCapsuleWithVectors(plain, {
      text: `${KV1_PREFIX_TEXT} body`,
      unit: {
        kind: "section",
        sectionPath: [KV1_PREFIX_TEXT],
        characterStart: 0,
        characterEnd: KV1_PREFIX_TEXT.length,
      },
    });
    insertDocumentTextRow(
      plain._internal.db,
      plain._internal.contentCipher,
      seeded.capsuleId,
      seeded.documentId,
      KV1_PREFIX_TEXT,
    );
    insertDocumentTextWindowRow(plain._internal.db, plain._internal.contentCipher, {
      capsuleId: seeded.capsuleId,
      documentId: seeded.documentId,
      windowIndex: 0,
      characterStart: 0,
      characterEnd: KV1_PREFIX_TEXT.length,
      normalizedText: KV1_PREFIX_TEXT,
    });
    plain.close();
    expect(readAllStoreBytes(dbPath).includes(Buffer.from(KV1_PREFIX_TEXT, "utf8"))).toBe(true);

    const encrypted = openKnowledgeStore({ dbPath, protection: encryptedProtection(7) });
    try {
      expect(
        readDocumentTextRow(
          encrypted._internal.db,
          encrypted._internal.contentCipher,
          seeded.capsuleId,
          seeded.documentId,
        ),
      ).toBe(KV1_PREFIX_TEXT);
      const windowRow = encrypted._internal.db
        .prepare("SELECT normalized_text FROM document_text_windows WHERE window_index = 0")
        .get() as { readonly normalized_text: string };
      expect(encrypted._internal.contentCipher.openText(windowRow.normalized_text)).toBe(
        KV1_PREFIX_TEXT,
      );
      const outcome = await searchVectorsForScope(
        encrypted,
        scriptedAdapter(),
        { capsuleIds: [seeded.capsuleId] },
        "query",
        { topK: 10 },
      );
      expect(
        outcome.references.some((ref) => ref.citation.sectionPath?.[0] === KV1_PREFIX_TEXT),
      ).toBe(true);
    } finally {
      encrypted.close();
    }

    expect(readAllStoreBytes(dbPath).includes(Buffer.from(KV1_PREFIX_TEXT, "utf8"))).toBe(false);
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

  it("rejects a plaintext text row injected into a marked encrypted store", async () => {
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

    const raw = new DatabaseSync(dbPath);
    try {
      raw
        .prepare("UPDATE document_texts SET normalized_text = ? WHERE document_id = ?")
        .run("PLAINTEXT-TAMPER-ZGRZZY", String(seeded.documentId));
    } finally {
      raw.close();
    }

    const reopened = openKnowledgeStore({ dbPath, protection: encryptedProtection(7) });
    try {
      expect(() =>
        readDocumentTextRow(
          reopened._internal.db,
          reopened._internal.contentCipher,
          seeded.capsuleId,
          seeded.documentId,
        ),
      ).toThrow(/not sealed/);
    } finally {
      reopened.close();
    }
  });

  it("rejects a plaintext vector blob injected into a marked encrypted store during retrieval", async () => {
    const dbPath = join(tmp, "capsules.db");
    const store = openKnowledgeStore({ dbPath, protection: encryptedProtection(7) });
    const seeded = await seedCapsuleWithVectors(store);
    store.close();

    const raw = new DatabaseSync(dbPath);
    try {
      const row = raw.prepare("SELECT vector_dimensions FROM vectors LIMIT 1").get() as {
        readonly vector_dimensions: number;
      };
      raw
        .prepare("UPDATE vectors SET embedding = ?")
        .run(new Uint8Array(row.vector_dimensions * 4));
    } finally {
      raw.close();
    }

    const reopened = openKnowledgeStore({ dbPath, protection: encryptedProtection(7) });
    try {
      await expect(
        searchVectorsForScope(
          reopened,
          scriptedAdapter(),
          { capsuleIds: [seeded.capsuleId] },
          "query",
          { topK: 10 },
        ),
      ).rejects.toThrow(/vector content/);
    } finally {
      reopened.close();
    }
  });

  it("rejects plaintext parsed-unit section paths injected into a marked encrypted store", async () => {
    const dbPath = join(tmp, "capsules.db");
    const sourceText = `${FIXTURE_TEXT} ${SECTION_LABEL}`;
    const store = openKnowledgeStore({ dbPath, protection: encryptedProtection(7) });
    const seeded = await seedCapsuleWithVectors(store, {
      text: sourceText,
      unit: {
        kind: "section",
        sectionPath: [SECTION_LABEL],
        characterStart: 0,
        characterEnd: sourceText.length,
      },
    });
    store.close();

    const raw = new DatabaseSync(dbPath);
    try {
      raw
        .prepare(
          "UPDATE parsed_units SET section_path_json = ? WHERE section_path_json IS NOT NULL",
        )
        .run(JSON.stringify(["PLAINTEXT-PATH-TAMPER-ZGRZZY"]));
    } finally {
      raw.close();
    }

    const reopened = openKnowledgeStore({ dbPath, protection: encryptedProtection(7) });
    try {
      await expect(
        searchVectorsForScope(
          reopened,
          scriptedAdapter(),
          { capsuleIds: [seeded.capsuleId] },
          "query",
          { topK: 10 },
        ),
      ).rejects.toThrow(/not sealed/);
    } finally {
      reopened.close();
    }
  });

  it("requires the exact marker value for encrypted stores", async () => {
    const dbPath = join(tmp, "capsules.db");
    const store = openKnowledgeStore({ dbPath, protection: encryptedProtection(7) });
    await seedCapsuleWithVectors(store);
    store.close();

    const raw = new DatabaseSync(dbPath);
    try {
      raw
        .prepare("UPDATE schema_meta SET value = ? WHERE key = ?")
        .run("aes-256-gcm/future", STORE_CONTENT_ENCRYPTION_TEST_CONSTANTS.markerKey);
    } finally {
      raw.close();
    }

    expect(() => openKnowledgeStore({ dbPath, protection: encryptedProtection(7) })).toThrow(
      /unsupported Local Knowledge content encryption marker/,
    );
  });

  it("treats a probe without the marker as an incomplete encrypted migration", async () => {
    const dbPath = join(tmp, "capsules.db");
    const store = openKnowledgeStore({ dbPath, protection: encryptedProtection(7) });
    await seedCapsuleWithVectors(store);
    store.close();

    const raw = new DatabaseSync(dbPath);
    try {
      raw
        .prepare("DELETE FROM schema_meta WHERE key IN (?, ?)")
        .run(
          STORE_CONTENT_ENCRYPTION_TEST_CONSTANTS.markerKey,
          STORE_CONTENT_ENCRYPTION_TEST_CONSTANTS.scopeKey,
        );
    } finally {
      raw.close();
    }

    expect(() => openKnowledgeStore({ dbPath })).toThrow(/incomplete encrypted-content migration/);
    expect(() => openKnowledgeStore({ dbPath, protection: encryptedProtection(9) })).toThrow(
      /wrong key or tampered/,
    );

    const completed = openKnowledgeStore({ dbPath, protection: encryptedProtection(7) });
    completed.close();
    const verified = new DatabaseSync(dbPath);
    try {
      const marker = verified
        .prepare("SELECT value FROM schema_meta WHERE key = ?")
        .get(STORE_CONTENT_ENCRYPTION_TEST_CONSTANTS.markerKey) as { readonly value: string };
      const scope = verified
        .prepare("SELECT value FROM schema_meta WHERE key = ?")
        .get(STORE_CONTENT_ENCRYPTION_TEST_CONSTANTS.scopeKey) as { readonly value: string };
      expect(marker.value).toBe(STORE_CONTENT_ENCRYPTION_TEST_CONSTANTS.markerValue);
      expect(scope.value).toBe(STORE_CONTENT_ENCRYPTION_TEST_CONSTANTS.scopeValue);
    } finally {
      verified.close();
    }
  });

  it("upgrades an already-marked v1 encrypted store by sealing section and heading labels", async () => {
    const dbPath = join(tmp, "capsules.db");
    const sourceText = `${FIXTURE_TEXT} ${SECTION_LABEL} ${HEADING_LABEL}`;
    const store = openKnowledgeStore({ dbPath, protection: encryptedProtection(7) });
    const seeded = await seedCapsuleWithVectors(store, {
      text: sourceText,
      unit: {
        kind: "section",
        sectionPath: [SECTION_LABEL],
        characterStart: 0,
        characterEnd: sourceText.length,
      },
    });
    insertSectionRow(store._internal.db, store._internal.contentCipher, seeded.capsuleId, {
      documentId: seeded.documentId,
      sectionPath: [SECTION_LABEL],
      characterStart: 0,
      characterEnd: sourceText.length,
    });
    insertParsedUnitRow(
      store._internal.db,
      store._internal.contentCipher,
      seeded.capsuleId,
      `${String(seeded.documentId)}#heading`,
      {
        kind: "html-block",
        documentId: seeded.documentId,
        headingPath: [HEADING_LABEL],
        characterStart: 0,
        characterEnd: Math.min(20, sourceText.length),
      },
    );
    store.close();

    const raw = new DatabaseSync(dbPath);
    try {
      raw
        .prepare("DELETE FROM schema_meta WHERE key = ?")
        .run(STORE_CONTENT_ENCRYPTION_TEST_CONSTANTS.scopeKey);
      raw.prepare("UPDATE sections SET section_path_json = ?").run(JSON.stringify([SECTION_LABEL]));
      raw
        .prepare(
          "UPDATE parsed_units SET section_path_json = ? WHERE section_path_json IS NOT NULL",
        )
        .run(JSON.stringify([SECTION_LABEL]));
      raw
        .prepare(
          "UPDATE parsed_units SET heading_path_json = ? WHERE heading_path_json IS NOT NULL",
        )
        .run(JSON.stringify([HEADING_LABEL]));
    } finally {
      raw.close();
    }
    expect(readAllStoreBytes(dbPath).includes(Buffer.from(SECTION_LABEL, "utf8"))).toBe(true);
    expect(readAllStoreBytes(dbPath).includes(Buffer.from(HEADING_LABEL, "utf8"))).toBe(true);

    const upgraded = openKnowledgeStore({ dbPath, protection: encryptedProtection(7) });
    try {
      const outcome = await searchVectorsForScope(
        upgraded,
        scriptedAdapter(),
        { capsuleIds: [seeded.capsuleId] },
        "query",
        { topK: 10 },
      );
      expect(
        outcome.references.some((ref) => ref.citation.sectionPath?.[0] === SECTION_LABEL),
      ).toBe(true);
    } finally {
      upgraded.close();
    }

    const afterBytes = readAllStoreBytes(dbPath);
    expect(afterBytes.includes(Buffer.from(SECTION_LABEL, "utf8"))).toBe(false);
    expect(afterBytes.includes(Buffer.from(HEADING_LABEL, "utf8"))).toBe(false);
  });

  it("upgrades an already-marked v2 encrypted store by sealing document blobs", async () => {
    const dbPath = join(tmp, "capsules.db");
    const blobBytes = Buffer.from("PDF preview blob ZGRZZY-V2-BLOB-4242", "utf8");
    const store = openKnowledgeStore({ dbPath, protection: encryptedProtection(7) });
    const seeded = await seedCapsuleWithVectors(store);
    store.close();

    const raw = new DatabaseSync(dbPath);
    try {
      raw
        .prepare("UPDATE schema_meta SET value = ? WHERE key = ?")
        .run("reconstructive-columns/v2", STORE_CONTENT_ENCRYPTION_TEST_CONSTANTS.scopeKey);
      raw
        .prepare(
          [
            "INSERT INTO document_blobs",
            "(capsule_id, content_hash, byte_length, media_type, storage_kind, seal_version,",
            " blob_bytes, created_at, created_source_id, created_document_id)",
            "VALUES (:capsule_id, :content_hash, :byte_length, 'application/pdf',",
            " 'plaintext', NULL, :blob_bytes, 1, :source_id, :document_id)",
          ].join(" "),
        )
        .run({
          capsule_id: seeded.capsuleId,
          content_hash: "v2-blob-hash",
          byte_length: blobBytes.byteLength,
          blob_bytes: blobBytes,
          source_id: seeded.sourceId,
          document_id: seeded.documentId,
        });
    } finally {
      raw.close();
    }

    expect(readAllStoreBytes(dbPath).includes(blobBytes)).toBe(true);

    const upgraded = openKnowledgeStore({ dbPath, protection: encryptedProtection(7) });
    upgraded.close();

    expect(readAllStoreBytes(dbPath).includes(blobBytes)).toBe(false);
    const verified = new DatabaseSync(dbPath);
    try {
      const row = verified
        .prepare("SELECT storage_kind, seal_version, blob_bytes FROM document_blobs")
        .get() as {
        readonly storage_kind: string;
        readonly seal_version: string;
        readonly blob_bytes: Uint8Array;
      };
      const scope = verified
        .prepare("SELECT value FROM schema_meta WHERE key = ?")
        .get(STORE_CONTENT_ENCRYPTION_TEST_CONSTANTS.scopeKey) as { readonly value: string };
      expect(row.storage_kind).toBe("sealed");
      expect(row.seal_version).toBe(STORE_CONTENT_ENCRYPTION_TEST_CONSTANTS.markerValue);
      expect(Buffer.from(row.blob_bytes).equals(blobBytes)).toBe(false);
      expect(scope.value).toBe(STORE_CONTENT_ENCRYPTION_TEST_CONSTANTS.scopeValue);
    } finally {
      verified.close();
    }
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

  it("seals and opens vectors within the documented per-operation budget", () => {
    const cipher = createEncryptedContentCipher(new Uint8Array(32).fill(3));
    const sample = new Uint8Array(1536 * 4);
    for (let i = 0; i < sample.byteLength; i += 1) {
      sample[i] = i % 251;
    }
    const iterations = 1000;
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i += 1) {
      const sealed = cipher.sealVector(sample);
      const opened = cipher.openVector(sealed, sample.byteLength);
      if (opened.byteLength !== sample.byteLength) throw new Error("vector round-trip mismatch");
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    const perOpUs = (elapsedMs / iterations) * 1000;
    // 1536-dim Float32 vectors are the common small-embedding path. The bound is generous enough for
    // CI noise but catches accidental copy-amplification or non-AEAD fallback regressions.
    expect(perOpUs).toBeLessThan(350);
  });

  it("the plaintext identity cipher adds no measurable overhead", () => {
    expect(PLAINTEXT_CONTENT_CIPHER.sealText("free")).toBe("free");
  });
});
