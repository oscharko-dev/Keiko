import { DatabaseSync, type StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import type { KnowledgeStore } from "../../store.js";
import { listScopeDocumentInventory } from "../documentInventory.js";

const databases: DatabaseSync[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
});

function fixture(): { db: DatabaseSync; store: KnowledgeStore; rows: { returned: number } } {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, capsule_id TEXT, source_id TEXT, document_path TEXT,
      safe_display_name TEXT, content_hash TEXT, media_type TEXT, status TEXT
    );
    CREATE INDEX idx_documents_capsule_source ON documents(capsule_id, source_id, status);
    CREATE INDEX idx_documents_capsule_status ON documents(capsule_id, status);
  `);
  const rows = { returned: 0 };
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (sql.includes("safe_display_name")) countRows(statement, rows);
    return statement;
  });
  return { db, store: { _internal: { db } } as KnowledgeStore, rows };
}

function countRows(statement: StatementSync, rows: { returned: number }): void {
  const all = statement.all.bind(statement);
  vi.spyOn(statement, "all").mockImplementation((...args) => {
    const result = all(...args);
    rows.returned += result.length;
    return result;
  });
  const iterate = statement.iterate.bind(statement);
  vi.spyOn(statement, "iterate").mockImplementation(function* (...args) {
    for (const row of iterate(...args)) {
      rows.returned++;
      yield row;
    }
    return undefined;
  });
}

function seed(db: DatabaseSync, count: number): void {
  db.exec(`WITH RECURSIVE sequence(i) AS (
    SELECT 0 UNION ALL SELECT i + 1 FROM sequence WHERE i < ${String(count - 1)}
  ) INSERT INTO documents
    SELECT printf('doc-%05d', i), 'pod', 'selected', printf('file-%05d', i),
      'document', 'digest', 'text/plain', 'extracted' FROM sequence;`);
}

it("counts a large Pod exactly while returning only the bounded metadata page to JavaScript", () => {
  const { db, store, rows } = fixture();
  seed(db, 10_001);
  const inventory = listScopeDocumentInventory(store, { capsuleIds: ["pod" as never] }, 20);
  expect(inventory).toMatchObject({ totalCount: 10_001, omittedCount: 9981 });
  expect(inventory.documents).toHaveLength(20);
  expect(inventory.documents.map((entry) => entry.documentId)).toEqual(
    Array.from({ length: 20 }, (_, index) => `doc-${String(index).padStart(5, "0")}`),
  );
  expect(rows.returned).toBe(20);
});

it("applies source filters before the bound and keeps capsule, path, and identifier order", () => {
  const { db, store, rows } = fixture();
  db.exec(`INSERT INTO documents VALUES
    ('hidden', 'first', 'denied', 'a', 'hidden', 'digest', 'text/plain', 'extracted'),
    ('z', 'first', 'selected', 'b', 'failed', 'digest', 'text/plain', 'failed'),
    ('a', 'first', 'selected', 'b', 'image', 'digest', 'image/png', 'unsupported'),
    ('next', 'second', 'selected', 'a', 'next', 'digest', 'text/plain', 'extracted'),
    ('outside', 'unselected', 'selected', 'a', 'outside', 'digest', 'text/plain', 'extracted');`);
  const scope = {
    capsuleIds: ["first" as never, "second" as never],
    sourceFilter: ["selected" as never],
  };
  const inventory = listScopeDocumentInventory(store, scope, 2);
  expect(inventory).toMatchObject({ totalCount: 3, omittedCount: 1 });
  expect(inventory.documents.map((entry) => [entry.documentId, entry.extractionStatus])).toEqual([
    ["a", "unsupported"],
    ["z", "failed"],
  ]);
  expect(rows.returned).toBe(2);
  expect(listScopeDocumentInventory(store, { ...scope, sourceFilter: [] }, 2)).toEqual({
    documents: [],
    totalCount: 0,
    omittedCount: 0,
  });
});

it.each([0, -1, Number.NaN])(
  "counts every selected document at bound %s without materializing metadata",
  (bound) => {
    const { db, store, rows } = fixture();
    seed(db, 10_001);
    expect(listScopeDocumentInventory(store, { capsuleIds: ["pod" as never] }, bound)).toEqual({
      documents: [],
      totalCount: 10_001,
      omittedCount: 10_001,
    });
    expect(rows.returned).toBe(0);
  },
);

it.each([undefined, 10_002])("retains the 10,000-document ceiling at bound %s", (bound) => {
  const { db, store, rows } = fixture();
  seed(db, 10_001);
  const inventory = listScopeDocumentInventory(store, { capsuleIds: ["pod" as never] }, bound);
  expect(inventory).toMatchObject({ totalCount: 10_001, omittedCount: 1 });
  expect(inventory.documents).toHaveLength(10_000);
  expect(rows.returned).toBe(10_000);
});
