// Tests for listCapsuleDocumentTexts (Epic #710, Issue #717).
//
// Seeds a fresh in-memory store with capsule + document_texts rows, then asserts the reader
// returns documents in document_id order and skips empty-text entries.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CapsuleSetId, KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import { createCapsule } from "../../capsule-lifecycle.js";
import { createCapsuleSet } from "../../capsule-set-lifecycle.js";
import { listCapsuleDocumentTexts, listCapsuleSetDocumentTexts } from "../capsuleCorpus.js";
import { freshStore, sampleCapsuleInput } from "../../_support.js";
import type { KnowledgeStore } from "../../store.js";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

let store: KnowledgeStore;
let cleanup: () => void;

beforeEach(() => {
  const fresh = freshStore();
  store = fresh.store;
  cleanup = fresh.cleanup;
});

afterEach(() => {
  cleanup();
});

const CAP_ID = "cap-corpus-1" as KnowledgeCapsuleId;

function seedDocumentText(capsuleId: string, documentId: string, text: string): void {
  // document_texts requires a parent documents row due to the FK.
  // Seed documents first (requires capsule_sources row first for FK constraint).
  const db = store._internal.db;
  const now = store._internal.now();
  const sourceId = `src-${capsuleId}`;

  // Insert a minimal capsule_sources row (one source per capsule).
  db.prepare(
    "INSERT OR IGNORE INTO capsule_sources (id, capsule_id, display_name, tags_json, scope_kind, scope_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(sourceId, capsuleId, "Source 1", "[]", "folder", "{}", now, now);

  // Insert a minimal documents row.
  db.prepare(
    "INSERT OR IGNORE INTO documents (id, capsule_id, source_id, document_path, size_bytes, media_type, content_hash, parser_id, parser_version, last_extracted_at, status, safe_display_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    documentId,
    capsuleId,
    sourceId,
    `/docs/${documentId}`,
    text.length,
    "text/plain",
    `hash-${documentId}`,
    "text",
    "1",
    now,
    "ready",
    documentId,
  );

  // Insert the document_texts row.
  db.prepare(
    "INSERT INTO document_texts (capsule_id, document_id, normalized_text) VALUES (?, ?, ?)",
  ).run(capsuleId, documentId, text);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("listCapsuleDocumentTexts", () => {
  it("returns an empty array when the capsule has no documents", () => {
    createCapsule(store, sampleCapsuleInput({ id: CAP_ID }));
    const result = listCapsuleDocumentTexts(store, CAP_ID);
    expect(result).toHaveLength(0);
  });

  it("returns all non-empty document texts ordered by document_id", () => {
    createCapsule(store, sampleCapsuleInput({ id: CAP_ID }));
    seedDocumentText(CAP_ID, "doc-b", "Body of document B.");
    seedDocumentText(CAP_ID, "doc-a", "Body of document A.");

    const result = listCapsuleDocumentTexts(store, CAP_ID);
    expect(result).toHaveLength(2);
    expect(result[0]?.documentId).toBe("doc-a");
    expect(result[0]?.text).toBe("Body of document A.");
    expect(result[1]?.documentId).toBe("doc-b");
    expect(result[1]?.text).toBe("Body of document B.");
  });

  it("skips documents whose normalized_text is empty", () => {
    createCapsule(store, sampleCapsuleInput({ id: CAP_ID }));
    seedDocumentText(CAP_ID, "doc-empty", "");
    seedDocumentText(CAP_ID, "doc-ok", "Some useful content.");

    const result = listCapsuleDocumentTexts(store, CAP_ID);
    expect(result).toHaveLength(1);
    expect(result[0]?.documentId).toBe("doc-ok");
  });

  it("returns nothing for an unknown capsule (no rows match the filter)", () => {
    createCapsule(store, sampleCapsuleInput({ id: CAP_ID }));
    const result = listCapsuleDocumentTexts(store, "unknown-capsule-id");
    expect(result).toHaveLength(0);
  });

  it("each entry has both documentId and text properties", () => {
    createCapsule(store, sampleCapsuleInput({ id: CAP_ID }));
    seedDocumentText(CAP_ID, "doc-1", "Hello world");

    const [entry] = listCapsuleDocumentTexts(store, CAP_ID);
    expect(entry).toMatchObject({ documentId: "doc-1", text: "Hello world" });
  });
});

describe("listCapsuleSetDocumentTexts (Epic #710, Issue #716)", () => {
  const CAP_A = "cap-set-a" as KnowledgeCapsuleId;
  const CAP_B = "cap-set-b" as KnowledgeCapsuleId;
  const SET_ID = "set-corpus-1" as CapsuleSetId;

  it("returns an empty array for an unknown capsule-set", () => {
    expect(listCapsuleSetDocumentTexts(store, "no-such-set")).toHaveLength(0);
  });

  it("concatenates the corpus of every member capsule in membership order", () => {
    createCapsule(store, sampleCapsuleInput({ id: CAP_A }));
    createCapsule(store, sampleCapsuleInput({ id: CAP_B }));
    seedDocumentText(CAP_A, "a-doc", "Capsule A content.");
    seedDocumentText(CAP_B, "b-doc", "Capsule B content.");
    createCapsuleSet(store, {
      id: SET_ID,
      displayName: "Composed set",
      tags: [],
      capsuleIds: [CAP_A, CAP_B],
    });

    const result = listCapsuleSetDocumentTexts(store, SET_ID);
    expect(result.map((d) => d.documentId)).toEqual(["a-doc", "b-doc"]);
    expect(result.map((d) => d.text)).toEqual(["Capsule A content.", "Capsule B content."]);
  });

  it("returns an empty array when the set's members have no indexed content", () => {
    createCapsule(store, sampleCapsuleInput({ id: CAP_A }));
    createCapsuleSet(store, {
      id: SET_ID,
      displayName: "Empty set",
      tags: [],
      capsuleIds: [CAP_A],
    });
    expect(listCapsuleSetDocumentTexts(store, SET_ID)).toHaveLength(0);
  });
});
