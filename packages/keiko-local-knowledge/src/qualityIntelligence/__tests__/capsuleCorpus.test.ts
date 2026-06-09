// Tests for listCapsuleDocumentTexts (Epic #710, Issue #717).
//
// Seeds a fresh in-memory store with capsule + document_texts rows, then asserts the reader
// returns documents in document_id order and skips empty-text entries.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import { createCapsule } from "../../capsule-lifecycle.js";
import { listCapsuleDocumentTexts } from "../capsuleCorpus.js";
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

  // Insert a minimal capsule_sources row (source 'src-1' for capsule).
  db.prepare(
    "INSERT OR IGNORE INTO capsule_sources (id, capsule_id, display_name, tags_json, scope_kind, scope_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("src-1", capsuleId, "Source 1", "[]", "folder", "{}", now, now);

  // Insert a minimal documents row.
  db.prepare(
    "INSERT OR IGNORE INTO documents (id, capsule_id, source_id, document_path, size_bytes, media_type, content_hash, parser_id, parser_version, last_extracted_at, status, safe_display_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    documentId,
    capsuleId,
    "src-1",
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
