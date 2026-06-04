// Schema-validity and lineage-invariant tests for the Local Knowledge Connector capsule
// store (Epic #189, Issue #265). The test file uses `node:sqlite` to prove the DDL applies
// cleanly to a fresh in-memory database — production source in this package never touches
// `node:sqlite` (the leaf-package rule under ADR-0019 still holds because test files are
// excluded from the dist build via the package's tsconfig). Node 22.22+ ships SQLite
// without the `--experimental-sqlite` flag.

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  DELETE_CAPSULE_SQL,
  KNOWLEDGE_CAPSULE_DDL,
  KNOWLEDGE_CAPSULE_INDEXES,
  KNOWLEDGE_CAPSULE_INDEX_NAMES,
  KNOWLEDGE_CAPSULE_MIGRATIONS,
  KNOWLEDGE_CAPSULE_TABLES,
  LOCAL_KNOWLEDGE_DB_SCHEMA_VERSION,
} from "./local-knowledge-schema.js";
import {
  redactPathInDiagnostic,
  validateCapsuleRowShape,
} from "./local-knowledge-schema-validation.js";
import { LOCAL_KNOWLEDGE_SCHEMA_VERSION } from "./local-knowledge.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────────
// All helpers return primitives; they exist so the per-test arrangement stays focused on
// the assertion rather than INSERT boilerplate. Each capsule/source/document/chunk/vector
// inserted by `seedFullLineage` shares the same id-string base so cascades are easy to
// observe.

function openSchemaDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const migration of KNOWLEDGE_CAPSULE_MIGRATIONS) {
    for (const stmt of migration.up) {
      db.exec(stmt);
    }
  }
  db.exec(`PRAGMA user_version = ${String(LOCAL_KNOWLEDGE_DB_SCHEMA_VERSION)}`);
  return db;
}

interface SeedHandles {
  readonly capsuleId: string;
  readonly sourceId: string;
  readonly documentId: string;
  readonly parsedUnitId: string;
  readonly chunkId: string;
  readonly vectorId: string;
}

interface SeedOverrides {
  readonly capsuleId?: string;
  readonly sourceId?: string;
  readonly documentId?: string;
}

function seedFullLineage(db: DatabaseSync, overrides: SeedOverrides = {}): SeedHandles {
  const capsuleId = overrides.capsuleId ?? "cap-1";
  const sourceId = overrides.sourceId ?? "src-1";
  const documentId = overrides.documentId ?? "doc-1";
  const suffix = capsuleId === "cap-1" ? "1" : capsuleId.replace(/^cap-/, "");
  const parsedUnitId = `unit-${suffix}`;
  const chunkId = `chunk-${suffix}`;
  const vectorId = `vec-${suffix}`;
  db.prepare(
    `INSERT INTO capsules (
       id, display_name, tags_json, retrieval_effort, output_mode, answer_grounding_policy,
       embedding_model_provider, embedding_model_id, vector_dimensions, vector_metric,
       lifecycle_state, storage_reference, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    capsuleId,
    "Demo capsule",
    "[]",
    "default",
    "answers",
    "require-citations",
    "openai",
    "text-embedding-3-small",
    1536,
    "cosine",
    "ready",
    "capsules/cap-1",
    1000,
    1000,
  );
  db.prepare(
    `INSERT INTO capsule_sources (
       id, capsule_id, display_name, tags_json, scope_kind, scope_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(sourceId, capsuleId, "Demo source", "[]", "folder", "{}", 1000, 1000);
  db.prepare(
    `INSERT INTO documents (
       id, capsule_id, source_id, document_path, size_bytes, media_type, content_hash,
       parser_id, parser_version, last_extracted_at, status, safe_display_name
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    documentId,
    capsuleId,
    sourceId,
    "docs/intro.md",
    1024,
    "text/markdown",
    "deadbeef",
    "markdown",
    "1.0.0",
    1000,
    "extracted",
    "intro.md",
  );
  db.prepare(
    `INSERT INTO document_texts (capsule_id, document_id, normalized_text) VALUES (?, ?, ?)`,
  ).run(capsuleId, documentId, "normalized body");
  db.prepare(
    `INSERT INTO parsed_units (id, capsule_id, document_id, kind) VALUES (?, ?, ?, ?)`,
  ).run(parsedUnitId, capsuleId, documentId, "section");
  db.prepare(
    `INSERT INTO pages (capsule_id, document_id, page_number, character_start, character_end) VALUES (?, ?, ?, ?, ?)`,
  ).run(capsuleId, documentId, 1, 0, 100);
  db.prepare(
    `INSERT INTO sections (capsule_id, document_id, section_path_json, character_start, character_end) VALUES (?, ?, ?, ?, ?)`,
  ).run(capsuleId, documentId, '["Chapter 1"]', 0, 100);
  db.prepare(
    `INSERT INTO parser_diagnostics (id, capsule_id, document_id, severity, code, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(`diag-${suffix}`, capsuleId, documentId, "warning", "WARN_FOO", "msg", 1000);
  db.prepare(
    `INSERT INTO indexing_jobs (id, capsule_id, source_ids_json, started_at, status, total_documents, processed_documents, failed_documents, skipped_documents) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(`job-${suffix}`, capsuleId, `["${sourceId}"]`, 1000, "succeeded", 1, 1, 0, 0);
  db.prepare(
    `INSERT INTO chunks (
       id, capsule_id, source_id, document_id, parsed_unit_id, order_index, token_count,
       safe_excerpt_hash
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(chunkId, capsuleId, sourceId, documentId, parsedUnitId, 0, 256, "abc");
  const embedding = new Uint8Array(1536 * 4);
  db.prepare(
    `INSERT INTO vectors (
       id, capsule_id, source_id, document_id, chunk_id, embedding,
       embedding_model_provider, embedding_model_id, vector_dimensions, vector_metric,
       storage_reference, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    vectorId,
    capsuleId,
    sourceId,
    documentId,
    chunkId,
    embedding,
    "openai",
    "text-embedding-3-small",
    1536,
    "cosine",
    "store-ref-1",
    1000,
  );
  return { capsuleId, sourceId, documentId, parsedUnitId, chunkId, vectorId };
}

function countRows(db: DatabaseSync, table: string): number {
  // table is a server-controlled constant from KNOWLEDGE_CAPSULE_TABLES; no user input.
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: number };
  return typeof row.n === "number" ? row.n : 0;
}

function listSqliteMaster(db: DatabaseSync, type: "table" | "index"): readonly string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%'`)
    .all(type) as { name?: string }[];
  return rows.map((r) => r.name ?? "").filter((name) => name.length > 0);
}

// ─── Tests ───────────────────────────────────────────────────────────────────────
describe("LOCAL_KNOWLEDGE_DB_SCHEMA_VERSION", () => {
  it("is the integer 5 and is distinct from the contract-surface string version", () => {
    expect(LOCAL_KNOWLEDGE_DB_SCHEMA_VERSION).toBe(5);
    expect(typeof LOCAL_KNOWLEDGE_DB_SCHEMA_VERSION).toBe("number");
    expect(typeof LOCAL_KNOWLEDGE_SCHEMA_VERSION).toBe("string");
    // Same numeric meaning, different *types* — the test pins the distinct kinds so a
    // future refactor that collapses them to one identifier breaks this assertion.
    expect((LOCAL_KNOWLEDGE_DB_SCHEMA_VERSION as unknown) !== LOCAL_KNOWLEDGE_SCHEMA_VERSION).toBe(
      true,
    );
  });
});

describe("KNOWLEDGE_CAPSULE_DDL", () => {
  it("has PRAGMA foreign_keys = ON as the first statement", () => {
    expect(KNOWLEDGE_CAPSULE_DDL[0]).toBe("PRAGMA foreign_keys = ON;");
  });

  it("applies to a fresh in-memory database and lists every expected table and index", () => {
    const db = openSchemaDb();
    try {
      const tables = listSqliteMaster(db, "table");
      for (const expected of KNOWLEDGE_CAPSULE_TABLES) {
        expect(tables).toContain(expected);
      }
      const indexes = listSqliteMaster(db, "index");
      for (const expected of KNOWLEDGE_CAPSULE_INDEX_NAMES) {
        expect(indexes).toContain(expected);
      }
      expect(KNOWLEDGE_CAPSULE_INDEXES.length).toBe(KNOWLEDGE_CAPSULE_INDEX_NAMES.length);
    } finally {
      db.close();
    }
  });

  it("sets PRAGMA user_version to LOCAL_KNOWLEDGE_DB_SCHEMA_VERSION after applying", () => {
    const db = openSchemaDb();
    try {
      const row = db.prepare("PRAGMA user_version").get() as { user_version?: number };
      expect(row.user_version).toBe(LOCAL_KNOWLEDGE_DB_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("denormalises embedding identity columns onto the vectors table for stale detection", () => {
    const db = openSchemaDb();
    try {
      const columns = db.prepare("PRAGMA table_info('vectors')").all() as {
        name?: string;
        type?: string;
        notnull?: number;
      }[];
      const byName = new Map(columns.map((c) => [c.name ?? "", c]));
      expect(byName.get("embedding")?.type).toBe("BLOB");
      expect(byName.get("embedding")?.notnull).toBe(1);
      expect(byName.get("embedding_model_provider")?.type).toBe("TEXT");
      expect(byName.get("embedding_model_provider")?.notnull).toBe(1);
      expect(byName.get("embedding_model_id")?.notnull).toBe(1);
      expect(byName.get("vector_dimensions")?.type).toBe("INTEGER");
      expect(byName.get("vector_dimensions")?.notnull).toBe(1);
      expect(byName.get("vector_metric")?.notnull).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe("lineage enforcement", () => {
  it("rejects a chunk row without a capsule_id (NOT NULL constraint)", () => {
    const db = openSchemaDb();
    try {
      expect(() =>
        db
          .prepare(
            `INSERT INTO chunks (id, capsule_id, source_id, document_id, parsed_unit_id, order_index, token_count, safe_excerpt_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run("c", null, "s", "d", "u", 0, 0, "h"),
      ).toThrow(/NOT NULL/);
    } finally {
      db.close();
    }
  });

  it("rejects a vector row without a document_id (NOT NULL constraint)", () => {
    const db = openSchemaDb();
    try {
      const embedding = new Uint8Array(4);
      expect(() =>
        db
          .prepare(
            `INSERT INTO vectors (id, capsule_id, source_id, document_id, chunk_id, embedding, embedding_model_provider, embedding_model_id, vector_dimensions, vector_metric, storage_reference, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run("v", "c", "s", null, "ch", embedding, "p", "m", 4, "cosine", "ref", 1),
      ).toThrow(/NOT NULL/);
    } finally {
      db.close();
    }
  });

  it("rejects a chunk that mixes capsule_id from one capsule with document_id from another (composite FK, #265 Copilot)", () => {
    const db = openSchemaDb();
    try {
      // Seed capsule A with a complete lineage chain.
      const a = seedFullLineage(db, { capsuleId: "cap-A", sourceId: "src-A", documentId: "doc-A" });
      // Seed capsule B independently — different capsule, different document.
      seedFullLineage(db, { capsuleId: "cap-B", sourceId: "src-B", documentId: "doc-B" });
      // Attempting to insert a chunk that claims to belong to cap-A but references doc-B
      // (which actually belongs to cap-B) must fail the composite (capsule_id, document_id)
      // foreign key. Without the composite FK, this insert would silently succeed and the
      // lineage invariant would be broken.
      expect(() =>
        db
          .prepare(
            `INSERT INTO chunks (id, capsule_id, source_id, document_id, parsed_unit_id, order_index, token_count, safe_excerpt_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run("chunk-x", "cap-A", a.sourceId, "doc-B", a.parsedUnitId, 0, 1, "h"),
      ).toThrow(/FOREIGN KEY/);
    } finally {
      db.close();
    }
  });

  it("rejects a vector that mixes capsule_id with a chunk_id from another capsule (composite FK, #265 Copilot)", () => {
    const db = openSchemaDb();
    try {
      const a = seedFullLineage(db, { capsuleId: "cap-A", sourceId: "src-A", documentId: "doc-A" });
      const b = seedFullLineage(db, { capsuleId: "cap-B", sourceId: "src-B", documentId: "doc-B" });
      const embedding = new Uint8Array(4);
      expect(() =>
        db
          .prepare(
            `INSERT INTO vectors (id, capsule_id, source_id, document_id, chunk_id, embedding, embedding_model_provider, embedding_model_id, vector_dimensions, vector_metric, storage_reference, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "vec-x",
            "cap-A",
            a.sourceId,
            a.documentId,
            b.chunkId,
            embedding,
            "p",
            "m",
            4,
            "cosine",
            "ref",
            1,
          ),
      ).toThrow(/FOREIGN KEY/);
    } finally {
      db.close();
    }
  });

  it("rejects a document whose source_id belongs to another capsule (composite FK, #265 Copilot)", () => {
    const db = openSchemaDb();
    try {
      const a = seedFullLineage(db, { capsuleId: "cap-A", sourceId: "src-A", documentId: "doc-A" });
      const b = seedFullLineage(db, { capsuleId: "cap-B", sourceId: "src-B", documentId: "doc-B" });
      expect(() =>
        db
          .prepare(
            `INSERT INTO documents (id, capsule_id, source_id, document_path, size_bytes, media_type, content_hash, parser_id, parser_version, last_extracted_at, status, safe_display_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "doc-x",
            a.capsuleId,
            b.sourceId,
            "/some/path",
            1,
            "text/plain",
            "deadbeef",
            "p",
            "1",
            1,
            "extracted",
            "n",
          ),
      ).toThrow(/FOREIGN KEY/);
    } finally {
      db.close();
    }
  });

  it("cascades capsule deletion to every dependent row in one statement", () => {
    const db = openSchemaDb();
    try {
      const handles = seedFullLineage(db);
      const dependents = [
        "capsule_sources",
        "documents",
        "document_texts",
        "pages",
        "sections",
        "parsed_units",
        "chunks",
        "vectors",
        "parser_diagnostics",
        "indexing_jobs",
      ];
      for (const table of dependents) {
        expect(countRows(db, table)).toBe(1);
      }
      db.prepare(DELETE_CAPSULE_SQL).run({ capsule_id: handles.capsuleId });
      // Cascade reaches every dependent table; the capsule row itself is gone too.
      expect(countRows(db, "capsules")).toBe(0);
      for (const table of dependents) {
        expect(countRows(db, table)).toBe(0);
      }
    } finally {
      db.close();
    }
  });
});

describe("STRICT mode", () => {
  it("rejects inserting a string into an INTEGER column (vector_dimensions)", () => {
    const db = openSchemaDb();
    try {
      const embedding = new Uint8Array(4);
      expect(() =>
        db
          .prepare(
            `INSERT INTO vectors (id, capsule_id, source_id, document_id, chunk_id, embedding, embedding_model_provider, embedding_model_id, vector_dimensions, vector_metric, storage_reference, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "v",
            "c",
            "s",
            "d",
            "ch",
            embedding,
            "p",
            "m",
            "not-an-integer" as unknown as number,
            "cosine",
            "ref",
            1,
          ),
      ).toThrow(/INTEGER/);
    } finally {
      db.close();
    }
  });
});

describe("KNOWLEDGE_CAPSULE_MIGRATIONS", () => {
  it("starts at version 1 and is strictly increasing", () => {
    expect(KNOWLEDGE_CAPSULE_MIGRATIONS.length).toBeGreaterThan(0);
    expect(KNOWLEDGE_CAPSULE_MIGRATIONS[0]?.version).toBe(1);
    let previous = 0;
    for (const entry of KNOWLEDGE_CAPSULE_MIGRATIONS) {
      expect(entry.version).toBeGreaterThan(previous);
      previous = entry.version;
    }
  });

  it("applying all migrations in order matches a fresh full-schema apply", () => {
    // Every post-v1 migration is a *delta* — applying every migration in order to a virgin
    // database must end at the same on-disk shape as openSchemaDb. The forward-only chain
    // is what gives existing stores a safe upgrade path.
    const db = new DatabaseSync(":memory:");
    try {
      for (const entry of KNOWLEDGE_CAPSULE_MIGRATIONS) {
        for (const stmt of entry.up) db.exec(stmt);
      }
      const tables = listSqliteMaster(db, "table");
      for (const expected of KNOWLEDGE_CAPSULE_TABLES) {
        expect(tables).toContain(expected);
      }
    } finally {
      db.close();
    }
  });

  it("applies v2's delta on top of a v1-only database without re-creating v1 objects", () => {
    // Real-world upgrade case: an installed v1 store opens after this release. The runtime
    // applies only entries whose version > current user_version. Verify the v2 delta is
    // valid against a database that already holds the v1 schema.
    const db = new DatabaseSync(":memory:");
    try {
      const v1 = KNOWLEDGE_CAPSULE_MIGRATIONS.find((m) => m.version === 1);
      const v2 = KNOWLEDGE_CAPSULE_MIGRATIONS.find((m) => m.version === 2);
      if (v1 === undefined || v2 === undefined) {
        throw new Error("expected v1 and v2 migrations");
      }
      for (const stmt of v1.up) db.exec(stmt);
      for (const stmt of v2.up) db.exec(stmt);
      const tables = listSqliteMaster(db, "table");
      expect(tables).toContain("capsule_membership_changes");
      const indexes = listSqliteMaster(db, "index");
      expect(indexes).toContain("idx_capsule_membership_changes_capsule_time");
    } finally {
      db.close();
    }
  });

  it("applies v5 on top of a v4 database and preserves existing audit rows", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const v5 = KNOWLEDGE_CAPSULE_MIGRATIONS.find((m) => m.version === 5);
      if (v5 === undefined) {
        throw new Error("expected v5 migration");
      }
      for (const entry of KNOWLEDGE_CAPSULE_MIGRATIONS) {
        if (entry.version >= 5) break;
        for (const stmt of entry.up) db.exec(stmt);
      }
      seedFullLineage(db);
      db.prepare(
        "INSERT INTO capsule_membership_changes (id, capsule_id, change_kind, source_id, occurred_at) VALUES (?, ?, ?, ?, ?)",
      ).run("c-1", "cap-1", "add-source", "src-new", 1234);
      db.prepare(
        "INSERT INTO capsule_audit_events (id, capsule_id, kind, occurred_at) VALUES (?, ?, ?, ?)",
      ).run("a-1", "cap-1", "capsule-deleted", 1235);

      for (const stmt of v5.up) db.exec(stmt);
      db.prepare(DELETE_CAPSULE_SQL).run({ capsule_id: "cap-1" });

      expect(countRows(db, "capsule_membership_changes")).toBe(1);
      expect(countRows(db, "capsule_audit_events")).toBe(1);
    } finally {
      db.close();
    }
  });

  it("v2 audit table rejects an unknown change_kind via CHECK constraint", () => {
    const db = openSchemaDb();
    try {
      seedFullLineage(db);
      expect(() =>
        db
          .prepare(
            "INSERT INTO capsule_membership_changes (id, capsule_id, change_kind, occurred_at) VALUES (?, ?, ?, ?)",
          )
          .run("c-1", "cap-1", "rename-source", 1234),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it("metadata-only audit rows survive capsule deletion", () => {
    const db = openSchemaDb();
    try {
      seedFullLineage(db);
      db.prepare(
        "INSERT INTO capsule_membership_changes (id, capsule_id, change_kind, source_id, occurred_at) VALUES (?, ?, ?, ?, ?)",
      ).run("c-1", "cap-1", "add-source", "src-new", 1234);
      db.prepare(
        "INSERT INTO capsule_audit_events (id, capsule_id, kind, occurred_at) VALUES (?, ?, ?, ?)",
      ).run("a-1", "cap-1", "capsule-deleted", 1235);
      expect(countRows(db, "capsule_membership_changes")).toBe(1);
      expect(countRows(db, "capsule_audit_events")).toBe(1);
      db.prepare(DELETE_CAPSULE_SQL).run({ capsule_id: "cap-1" });
      expect(countRows(db, "capsule_membership_changes")).toBe(1);
      expect(countRows(db, "capsule_audit_events")).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe("redactPathInDiagnostic", () => {
  it("rewrites a HOME-prefixed POSIX path to `~/…`", () => {
    expect(redactPathInDiagnostic("/Users/foo/secret.txt", { homePrefix: "/Users/foo" })).toBe(
      "~/secret.txt",
    );
  });

  it("returns just `~` when the path equals the HOME prefix", () => {
    expect(redactPathInDiagnostic("/Users/foo", { homePrefix: "/Users/foo" })).toBe("~");
  });

  it("tolerates a HOME prefix passed with a trailing separator", () => {
    expect(redactPathInDiagnostic("/Users/foo/secret", { homePrefix: "/Users/foo/" })).toBe(
      "~/secret",
    );
  });

  it("does not collapse `/Users/foobar` into `/Users/foo` (prefix-with-separator gate)", () => {
    expect(redactPathInDiagnostic("/Users/foobar/x", { homePrefix: "/Users/foo" })).toBe(
      "/Users/foobar/x",
    );
  });

  it("rewrites a Windows drive prefix to `<drive>/…` and normalises separators", () => {
    expect(redactPathInDiagnostic("C:\\Users\\victim\\file.txt")).toBe(
      "<drive>/Users/victim/file.txt",
    );
  });

  it("truncates at the first NUL byte", () => {
    expect(redactPathInDiagnostic("safe\0badpart")).toBe("safe");
  });

  it("strips ASCII control characters", () => {
    expect(redactPathInDiagnostic("abc")).toBe("abc");
  });

  it("caps the output at the documented length and appends an ellipsis on overflow", () => {
    const huge = "x".repeat(4096);
    const out = redactPathInDiagnostic(huge);
    expect(out.length).toBe(1025);
    expect(out.endsWith("…")).toBe(true);
  });

  it("passes through inputs that do not match any redaction pattern", () => {
    expect(redactPathInDiagnostic("relative/path.txt")).toBe("relative/path.txt");
  });

  it("returns the empty string when called with a non-string at runtime", () => {
    expect(redactPathInDiagnostic(undefined as unknown as string)).toBe("");
  });
});

describe("validateCapsuleRowShape", () => {
  it("accepts a row that mirrors the capsules table after JS-side mapping", () => {
    const row = {
      id: "cap-1",
      displayName: "Demo",
      vectorDimensions: 1536,
      vectorMetric: "cosine",
      embeddingModelProvider: "openai",
      embeddingModelId: "text-embedding-3-small",
      lifecycleState: "ready",
      storageReference: "capsules/cap-1",
      createdAt: 1,
      updatedAt: 1,
    };
    const result = validateCapsuleRowShape(row);
    expect(result.ok).toBe(true);
  });

  it("rejects a non-object input with a single object-shape error", () => {
    const result = validateCapsuleRowShape("not-a-row");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(["capsuleRow must be an object"]);
    }
  });

  it("rejects a row with vectorDimensions of the wrong type", () => {
    const result = validateCapsuleRowShape({
      id: "cap-1",
      displayName: "Demo",
      vectorDimensions: "1536",
      vectorMetric: "cosine",
      embeddingModelProvider: "openai",
      embeddingModelId: "m",
      lifecycleState: "ready",
      storageReference: "capsules/cap-1",
      createdAt: 1,
      updatedAt: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("vectorDimensions"))).toBe(true);
    }
  });

  it("rejects a row missing the lifecycle_state JS field", () => {
    const result = validateCapsuleRowShape({
      id: "cap-1",
      displayName: "Demo",
      vectorDimensions: 1536,
      vectorMetric: "cosine",
      embeddingModelProvider: "openai",
      embeddingModelId: "m",
      storageReference: "capsules/cap-1",
      createdAt: 1,
      updatedAt: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("lifecycleState"))).toBe(true);
    }
  });
});
