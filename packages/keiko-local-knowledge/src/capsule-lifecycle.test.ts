// capsule-lifecycle.test.ts — CRUD round-trips plus the mutation-robust cascade test.

import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createCapsule,
  deleteCapsule,
  getCapsule,
  listCapsules,
  updateCapsuleState,
} from "./capsule-lifecycle.js";
import { KnowledgeNotFoundError, KnowledgeStoreError } from "./errors.js";
import { freshStore, sampleCapsuleInput } from "./_support.js";
import type { KnowledgeStore } from "./store.js";

interface CountRow {
  readonly n: number;
}

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

describe("createCapsule + getCapsule", () => {
  it("round-trips every contract field", () => {
    const input = sampleCapsuleInput({
      description: "engineering corpus",
      sourceRoutingInstructions: "always go through alpha",
      alwaysQuery: true,
      tags: ["x", "y"],
    });
    const created = createCapsule(store, input);
    expect(created.id).toBe(input.id);
    expect(created.displayName).toBe(input.displayName);
    expect(created.description).toBe("engineering corpus");
    expect(created.tags).toStrictEqual(["x", "y"]);
    expect(created.sourceIds).toStrictEqual([]);
    expect(created.sourceRoutingInstructions).toBe("always go through alpha");
    expect(created.alwaysQuery).toBe(true);
    expect(created.retrievalEffort).toBe(input.retrievalEffort);
    expect(created.outputMode).toBe(input.outputMode);
    expect(created.answerGroundingPolicy).toBe(input.answerGroundingPolicy);
    expect(created.embeddingModelIdentity).toStrictEqual(input.embeddingModelIdentity);
    expect(created.lifecycleState).toBe("draft");
    expect(created.storageReference).toBe(input.storageReference);
    expect(typeof created.createdAt).toBe("number");
    expect(created.updatedAt).toBe(created.createdAt);

    const readback = getCapsule(store, input.id);
    expect(readback).toStrictEqual(created);
  });

  it("omits absent optional fields (exactOptionalPropertyTypes)", () => {
    const created = createCapsule(store, sampleCapsuleInput());
    expect("description" in created).toBe(false);
    expect("sourceRoutingInstructions" in created).toBe(false);
    expect("alwaysQuery" in created).toBe(false);
    expect("modelRevision" in created.embeddingModelIdentity).toBe(false);
  });

  it("rejects duplicate capsule id with a typed error", () => {
    createCapsule(store, sampleCapsuleInput());
    expect(() => createCapsule(store, sampleCapsuleInput())).toThrow(KnowledgeStoreError);
  });
});

describe("listCapsules", () => {
  it("returns empty before any insert", () => {
    expect(listCapsules(store)).toStrictEqual([]);
  });

  it("returns rows ordered by created_at ascending", () => {
    const clock = (() => {
      let t = 100;
      return (): number => {
        t += 1;
        return t;
      };
    })();
    // Swap the store clock for deterministic timestamps.
    const orig = store._internal.now;
    Object.defineProperty(store._internal, "now", {
      value: clock,
      configurable: true,
    });
    try {
      createCapsule(store, sampleCapsuleInput({ id: "a" as KnowledgeCapsuleId }));
      createCapsule(
        store,
        sampleCapsuleInput({ id: "b" as KnowledgeCapsuleId, storageReference: "b" }),
      );
      createCapsule(
        store,
        sampleCapsuleInput({ id: "c" as KnowledgeCapsuleId, storageReference: "c" }),
      );
    } finally {
      Object.defineProperty(store._internal, "now", { value: orig, configurable: true });
    }
    const ids = listCapsules(store).map((c) => c.id);
    expect(ids).toStrictEqual(["a", "b", "c"]);
  });
});

describe("updateCapsuleState", () => {
  it("changes lifecycle_state and bumps updated_at", () => {
    let t = 100;
    Object.defineProperty(store._internal, "now", { value: (): number => t, configurable: true });
    const created = createCapsule(store, sampleCapsuleInput());
    expect(created.createdAt).toBe(100);
    t = 250;
    const updated = updateCapsuleState(store, created.id, "indexing");
    expect(updated.lifecycleState).toBe("indexing");
    expect(updated.updatedAt).toBe(250);
    expect(updated.createdAt).toBe(100);
  });

  it("raises KnowledgeNotFoundError for an unknown id", () => {
    expect(() => updateCapsuleState(store, "ghost" as KnowledgeCapsuleId, "ready")).toThrow(
      KnowledgeNotFoundError,
    );
  });
});

describe("deleteCapsule + cascade", () => {
  it("returns undefined from getCapsule and clears every dependent table", () => {
    // Two capsules so we can verify the unrelated one is untouched.
    const a = createCapsule(store, sampleCapsuleInput({ id: "cap-a" as KnowledgeCapsuleId }));
    const b = createCapsule(
      store,
      sampleCapsuleInput({ id: "cap-b" as KnowledgeCapsuleId, storageReference: "b" }),
    );

    seedFullLineage(store, a.id, "a");
    seedFullLineage(store, b.id, "b");

    const before = countAll(store);
    expect(before.capsules).toBe(2);
    for (const table of ALL_DEPENDENT_TABLES) {
      expect(before[table]).toBeGreaterThanOrEqual(1);
    }

    deleteCapsule(store, a.id);

    expect(getCapsule(store, a.id)).toBeUndefined();

    // Capsule B's rows survive
    for (const table of ALL_DEPENDENT_TABLES) {
      const row = store._internal.db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE capsule_id = :c`)
        .get({ c: b.id }) as unknown as CountRow;
      expect(row.n).toBeGreaterThanOrEqual(1);
    }

    // Capsule A's rows gone
    for (const table of ALL_DEPENDENT_TABLES) {
      const row = store._internal.db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE capsule_id = :c`)
        .get({ c: a.id }) as unknown as CountRow;
      expect(row.n).toBe(0);
    }
  });

  it("raises KnowledgeNotFoundError when deleting a missing capsule", () => {
    expect(() => { deleteCapsule(store, "ghost" as KnowledgeCapsuleId); }).toThrow(
      KnowledgeNotFoundError,
    );
  });
});

// ─── Local helpers ────────────────────────────────────────────────────────────

const ALL_DEPENDENT_TABLES = [
  "capsule_sources",
  "documents",
  "pages",
  "sections",
  "parsed_units",
  "chunks",
  "vectors",
  "parser_diagnostics",
  "indexing_jobs",
] as const;

interface CountMap {
  readonly capsules: number;
  readonly capsule_sources: number;
  readonly documents: number;
  readonly pages: number;
  readonly sections: number;
  readonly parsed_units: number;
  readonly chunks: number;
  readonly vectors: number;
  readonly parser_diagnostics: number;
  readonly indexing_jobs: number;
}

function countAll(s: KnowledgeStore): CountMap {
  const c = (table: string): number =>
    (s._internal.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as unknown as CountRow).n;
  return {
    capsules: c("capsules"),
    capsule_sources: c("capsule_sources"),
    documents: c("documents"),
    pages: c("pages"),
    sections: c("sections"),
    parsed_units: c("parsed_units"),
    chunks: c("chunks"),
    vectors: c("vectors"),
    parser_diagnostics: c("parser_diagnostics"),
    indexing_jobs: c("indexing_jobs"),
  };
}

function seedFullLineage(s: KnowledgeStore, capsuleId: string, suffix: string): void {
  const db = s._internal.db;
  const sourceId = `src-${suffix}`;
  const documentId = `doc-${suffix}`;
  const parsedUnitId = `pu-${suffix}`;
  const chunkId = `ch-${suffix}`;
  const vectorId = `vec-${suffix}`;
  const diagId = `diag-${suffix}`;
  const jobId = `job-${suffix}`;

  db.prepare(
    "INSERT INTO capsule_sources (id, capsule_id, display_name, tags_json, scope_kind, scope_json, created_at, updated_at) VALUES (:id, :c, 'src', '[]', 'folder', '{}', 1, 1)",
  ).run({ id: sourceId, c: capsuleId });

  db.prepare(
    "INSERT INTO documents (id, capsule_id, source_id, document_path, size_bytes, media_type, content_hash, parser_id, parser_version, last_extracted_at, status, safe_display_name) VALUES (:id, :c, :s, '/a.md', 1, 'text/markdown', 'h', 'p', '1', 1, 'ready', 'a.md')",
  ).run({ id: documentId, c: capsuleId, s: sourceId });

  db.prepare(
    "INSERT INTO pages (capsule_id, document_id, page_number, character_start, character_end) VALUES (:c, :d, 1, 0, 100)",
  ).run({ c: capsuleId, d: documentId });

  db.prepare(
    "INSERT INTO sections (capsule_id, document_id, section_path_json, character_start, character_end) VALUES (:c, :d, '[]', 0, 100)",
  ).run({ c: capsuleId, d: documentId });

  db.prepare(
    "INSERT INTO parsed_units (id, capsule_id, document_id, kind) VALUES (:id, :c, :d, 'paragraph')",
  ).run({ id: parsedUnitId, c: capsuleId, d: documentId });

  db.prepare(
    "INSERT INTO chunks (id, capsule_id, source_id, document_id, parsed_unit_id, order_index, token_count, safe_excerpt_hash) VALUES (:id, :c, :s, :d, :p, 0, 10, 'hash')",
  ).run({ id: chunkId, c: capsuleId, s: sourceId, d: documentId, p: parsedUnitId });

  db.prepare(
    "INSERT INTO vectors (id, capsule_id, source_id, document_id, chunk_id, embedding, embedding_model_provider, embedding_model_id, vector_dimensions, vector_metric, storage_reference, created_at) VALUES (:id, :c, :s, :d, :ch, :emb, 'openai', 'text-embedding-3-small', 1536, 'cosine', 'r', 1)",
  ).run({
    id: vectorId,
    c: capsuleId,
    s: sourceId,
    d: documentId,
    ch: chunkId,
    emb: new Uint8Array([1, 2, 3]),
  });

  db.prepare(
    "INSERT INTO parser_diagnostics (id, capsule_id, document_id, severity, code, message, created_at) VALUES (:id, :c, :d, 'info', 'OK', 'fine', 1)",
  ).run({ id: diagId, c: capsuleId, d: documentId });

  db.prepare(
    "INSERT INTO indexing_jobs (id, capsule_id, source_ids_json, started_at, status, total_documents, processed_documents, failed_documents, skipped_documents) VALUES (:id, :c, '[]', 1, 'pending', 0, 0, 0, 0)",
  ).run({ id: jobId, c: capsuleId });
}
