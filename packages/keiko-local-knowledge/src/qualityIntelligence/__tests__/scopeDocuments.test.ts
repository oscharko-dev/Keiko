// Tests for the whole-document read of a resolved scope (#4179).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DocumentId, KnowledgeCapsuleId, ParsedUnit } from "@oscharko-dev/keiko-contracts";

import { freshStore } from "../../_support.js";
import { chunkDocument } from "../../chunking/chunker-runner.js";
import {
  seedCapsuleSourceAndDocument,
  seedParsedUnit,
  seedSection,
} from "../../chunking/_support.js";
import { insertDocumentTextRow } from "../../discovery/persist.js";
import { resolveEnumerationScope } from "../../retrieval/retrieval-runner.js";
import type { KnowledgeStore } from "../../store.js";
import { readScopeDocuments, referenceForSpan } from "../scopeDocuments.js";

const TEXT = [
  "# Lastenheft",
  "",
  "### LH-001 Anmeldung",
  "Das Portal unterstützt die Anmeldung.",
  "",
  "### LH-002 Status",
  "Das Portal zeigt den Status.",
].join("\n");

let store: KnowledgeStore;
let cleanup: () => void;
let capsuleId: KnowledgeCapsuleId;
const DOC = "doc-1" as DocumentId;

beforeEach(() => {
  const fresh = freshStore();
  store = fresh.store;
  cleanup = fresh.cleanup;
  capsuleId = seedCapsuleSourceAndDocument(store).capsuleId;
  insertDocumentTextRow(store._internal.db, store._internal.contentCipher, capsuleId, DOC, TEXT);
  const unit: ParsedUnit = {
    kind: "page",
    documentId: DOC,
    pageNumber: 2,
    characterStart: 0,
    characterEnd: TEXT.length,
  };
  seedParsedUnit(store, capsuleId, "u-1", unit);
  seedSection(store, capsuleId, DOC, {
    sectionPath: ["Lastenheft", "LH-001 Anmeldung"],
    characterStart: TEXT.indexOf("### LH-001"),
    characterEnd: TEXT.indexOf("### LH-002"),
  });
  chunkDocument(store, {
    capsuleId,
    sourceId: "src-1" as never,
    documentId: DOC,
    sourceText: TEXT,
  });
});

afterEach(() => {
  cleanup();
});

describe("readScopeDocuments", () => {
  it("reads the whole text, sections and version of every text-extracted document", () => {
    const read = readScopeDocuments(store, { capsuleIds: [capsuleId] });

    expect(read.documents).toHaveLength(1);
    const [document] = read.documents;
    expect(document?.text).toBe(TEXT);
    expect(document?.displayName).toBe("sample.txt");
    expect(document?.contentHash).toBe("a".repeat(64));
    expect(document?.sections.map((section) => section.sectionPath)).toEqual([
      ["Lastenheft", "LH-001 Anmeldung"],
    ]);
    expect(read).toMatchObject({ eligibleDocumentCount: 1, omittedByCountCount: 0 });
  });

  it("counts documents beyond the document bound and text beyond the character bound", () => {
    const byCount = readScopeDocuments(store, { capsuleIds: [capsuleId] }, { maxDocuments: 0 });
    const byText = readScopeDocuments(
      store,
      { capsuleIds: [capsuleId] },
      { maxCharsPerDocument: 10 },
    );
    const byTotal = readScopeDocuments(store, { capsuleIds: [capsuleId] }, { maxTotalChars: 10 });

    expect(byCount).toMatchObject({ documents: [], omittedByCountCount: 1, omittedByTextCount: 0 });
    expect(byText).toMatchObject({ documents: [], omittedByCountCount: 0, omittedByTextCount: 1 });
    expect(byTotal).toMatchObject({ documents: [], omittedByTextCount: 1 });
  });

  it("honours the source filter and skips documents that are not text-extracted", () => {
    const filtered = readScopeDocuments(store, {
      capsuleIds: [capsuleId],
      sourceFilter: ["other-source" as never],
    });
    store._internal.db.prepare("UPDATE documents SET status = 'failed'").run();
    const failed = readScopeDocuments(store, { capsuleIds: [capsuleId] });

    expect(filtered.eligibleDocumentCount).toBe(0);
    expect(failed.eligibleDocumentCount).toBe(0);
  });

  it("joins the text windows of a large document and refuses a gap", () => {
    store._internal.db.prepare("DELETE FROM document_texts").run();
    const insert = store._internal.db.prepare(
      "INSERT INTO document_text_windows (capsule_id, document_id, window_index, character_start, character_end, normalized_text) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const cut = 20;
    insert.run(
      capsuleId,
      DOC,
      0,
      0,
      cut,
      store._internal.contentCipher.sealText(TEXT.slice(0, cut)),
    );
    insert.run(
      capsuleId,
      DOC,
      1,
      cut,
      TEXT.length,
      store._internal.contentCipher.sealText(TEXT.slice(cut)),
    );
    expect(readScopeDocuments(store, { capsuleIds: [capsuleId] }).documents[0]?.text).toBe(TEXT);

    store._internal.db
      .prepare("UPDATE document_text_windows SET character_start = 25 WHERE window_index = 1")
      .run();
    expect(readScopeDocuments(store, { capsuleIds: [capsuleId] })).toMatchObject({
      documents: [],
      omittedByTextCount: 1,
    });
  });
});

describe("referenceForSpan", () => {
  it("cites the exact span through the chunk that covers it", () => {
    const [document] = readScopeDocuments(store, { capsuleIds: [capsuleId] }).documents;
    const start = TEXT.indexOf("### LH-002");
    const reference = referenceForSpan(store, document as never, {
      characterStart: start,
      characterEnd: TEXT.length,
      sectionPath: ["Lastenheft", "LH-002 Status"],
    });

    expect(reference?.citation).toMatchObject({
      documentId: DOC,
      safeDisplayName: "sample.txt",
      pageNumber: 2,
      characterStart: start,
      characterEnd: TEXT.length,
      sectionPath: ["Lastenheft", "LH-002 Status"],
    });
    expect(reference?.score).toBe(1);
  });

  it("returns undefined for a document without chunks", () => {
    const [document] = readScopeDocuments(store, { capsuleIds: [capsuleId] }).documents;
    store._internal.db.prepare("DELETE FROM chunks").run();

    expect(
      referenceForSpan(store, document as never, { characterStart: 0, characterEnd: 5 }),
    ).toBeUndefined();
  });
});

describe("scope resolution for a whole-document read", () => {
  it("resolves the scope and policy like a query and refuses an unknown scope", () => {
    expect(resolveEnumerationScope(store, { capsuleId })).toMatchObject({
      ok: true,
      policy: "require-citations",
    });
    expect(resolveEnumerationScope(store, { capsuleId: "missing" as KnowledgeCapsuleId })).toEqual({
      ok: false,
      reason: "no-scope",
    });
  });

  it("counts the documents of the scope that are not text-extracted", () => {
    store._internal.db.prepare("UPDATE documents SET status = 'unsupported'").run();

    expect(readScopeDocuments(store, { capsuleIds: [capsuleId] })).toMatchObject({
      eligibleDocumentCount: 0,
      notExtractedDocumentCount: 1,
    });
  });
});
