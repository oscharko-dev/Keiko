import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, runMigrations } from "./schema.js";
import { describe, expect, it, vi } from "vitest";
import {
  insertPreV17MemoryRow,
  makeRecord,
  memId,
  openTestDb,
  TEST_CIPHER,
  TEST_SEALING,
} from "./_support.js";
import {
  deleteMemoryRow,
  insertMemoryRow,
  updateMemoryRow,
  listMemoriesAcrossScopeRows,
  listMemoriesByScopeRows,
  listMemoryMetadataByScopeRows,
} from "./memories.js";

describe("persisted source message filter", () => {
  it("matches exact array membership within scope before applying a page limit", () => {
    const db = openTestDb();
    try {
      const base = makeRecord({ id: memId("source-target") });
      const target = {
        ...base,
        provenance: { ...base.provenance, sourceMessageIds: ["message-1", "message-2"] },
      };
      insertMemoryRow(db, target, TEST_SEALING);
      insertMemoryRow(
        db,
        {
          ...base,
          id: memId("source-newer"),
          createdAt: base.createdAt + 1,
          updatedAt: base.updatedAt + 1,
          provenance: { ...base.provenance, sourceMessageIds: ["message-10"] },
        },
        TEST_SEALING,
      );
      insertMemoryRow(
        db,
        { ...target, id: memId("source-other-scope"), scope: { kind: "global" } },
        TEST_SEALING,
      );
      const options = { sourceMessageId: "message-1", limit: 1, includeExpired: true };
      expect(
        listMemoriesByScopeRows(db, base.scope, options, base.createdAt, TEST_CIPHER).map(
          (record) => record.id,
        ),
      ).toEqual([base.id]);
      expect(
        listMemoriesAcrossScopeRows(db, [base.scope], options, base.createdAt, TEST_CIPHER).map(
          (record) => record.id,
        ),
      ).toEqual([base.id]);
      expect(
        listMemoryMetadataByScopeRows(db, base.scope, options, base.createdAt).map(
          (record) => record.id,
        ),
      ).toEqual([base.id]);
    } finally {
      db.close();
    }
  });

  it("keeps expiry and status explicit so source identity can include stored history", () => {
    const db = openTestDb();
    try {
      const base = makeRecord({ id: memId("source-expired"), status: "superseded" });
      insertMemoryRow(
        db,
        {
          ...base,
          validity: { validFrom: 100, validUntil: 200 },
          provenance: { ...base.provenance, sourceMessageIds: ["historical-source"] },
        },
        TEST_SEALING,
      );
      expect(
        listMemoriesByScopeRows(
          db,
          base.scope,
          { sourceMessageId: "historical-source" },
          300,
          TEST_CIPHER,
        ),
      ).toEqual([]);
      expect(
        listMemoriesByScopeRows(
          db,
          base.scope,
          { sourceMessageId: "historical-source", includeExpired: true },
          300,
          TEST_CIPHER,
        ).map((record) => record.id),
      ).toEqual([base.id]);
      expect(
        listMemoriesByScopeRows(
          db,
          base.scope,
          { sourceMessageId: "historical-source", includeExpired: true, status: ["accepted"] },
          300,
          TEST_CIPHER,
        ),
      ).toEqual([]);
    } finally {
      db.close();
    }
  });
});

function openV15Database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const migration of MIGRATIONS.filter(({ version }) => version <= 15)) db.exec(migration.sql);
  db.exec("PRAGMA user_version=15");
  return db;
}

describe("indexed source membership lifecycle", () => {
  it("seeks the source and the corresponding memory without scanning the scope", () => {
    const db = openTestDb();
    try {
      const record = makeRecord({ id: memId("seek"), scope: { kind: "global" } });
      insertMemoryRow(
        db,
        { ...record, provenance: { ...record.provenance, sourceMessageIds: ["sought"] } },
        TEST_SEALING,
      );
      const prepare = vi.spyOn(db, "prepare");
      expect(
        listMemoryMetadataByScopeRows(
          db,
          record.scope,
          { sourceMessageId: "sought", includeExpired: true },
          record.createdAt,
        ).map((row) => row.id),
      ).toEqual([record.id]);
      const query = prepare.mock.calls.find(
        ([sql]) => sql.startsWith("SELECT") && sql.includes("CROSS JOIN memories"),
      )?.[0];
      if (query === undefined) throw new Error("missing indexed source lookup");
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN ${query}`)
        .all("global", "", "sought", "sought")
        .map((step) => String(step.detail));
      expect(plan.some((step) => step.includes("idx_memory_message_source_lookup"))).toBe(true);
      expect(
        plan.some((step) =>
          step.includes("SEARCH memories USING INDEX sqlite_autoindex_memories_1"),
        ),
      ).toBe(true);
      expect(plan.some((step) => /^SCAN (membership|memories)\b/u.test(step))).toBe(false);
    } finally {
      db.close();
    }
  });

  it("backfills v15 provenance once and keeps writes, rollback and physical Forget consistent", () => {
    const db = openV15Database();
    try {
      const base = makeRecord({ id: memId("source-upgrade") });
      const record = {
        ...base,
        provenance: {
          ...base.provenance,
          sourceMessageIds: ["duplicate", "duplicate", 'escaped"source'],
        },
      };
      insertPreV17MemoryRow(db, record);
      const sealed = (): unknown =>
        db.prepare("SELECT body FROM memories WHERE id=?").get(record.id)?.body;
      const originalBody = sealed();
      runMigrations(db, TEST_CIPHER);
      runMigrations(db, TEST_CIPHER);
      const sources = (): readonly unknown[] =>
        db
          .prepare(
            "SELECT source_message_id FROM memory_message_sources WHERE memory_id=? ORDER BY source_message_id",
          )
          .all(record.id)
          .map((r) => r.source_message_id);
      expect(sources()).toEqual(["duplicate", 'escaped"source']);
      expect(sealed()).toBe(originalBody);
      const changed = {
        ...record,
        provenance: { ...record.provenance, sourceMessageIds: ["replacement"] },
      };
      db.exec("BEGIN");
      updateMemoryRow(db, changed, TEST_SEALING);
      expect(sources()).toEqual(["replacement"]);
      db.exec("ROLLBACK");
      expect(sources()).toEqual(["duplicate", 'escaped"source']);
      updateMemoryRow(db, changed, TEST_SEALING);
      expect(sources()).toEqual(["replacement"]);
      updateMemoryRow(db, { ...changed, body: "Edited body." }, TEST_SEALING);
      expect(sources()).toEqual(["replacement"]);
      expect(deleteMemoryRow(db, record.id)).toBe(true);
      expect(sources()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("keeps unrelated scopes readable in the presence of malformed stored provenance", () => {
    const db = openV15Database();
    try {
      const base = makeRecord({ id: memId("corrupt-source") });
      const healthy = {
        ...base,
        id: memId("healthy-source"),
        scope: { kind: "global" } as const,
        provenance: { ...base.provenance, sourceMessageIds: ["readable"] },
      };
      insertPreV17MemoryRow(db, base);
      insertPreV17MemoryRow(db, healthy);
      db.prepare("UPDATE memories SET source_message_ids_json = ? WHERE id = ?").run("[", base.id);
      runMigrations(db, TEST_CIPHER);
      expect(
        listMemoryMetadataByScopeRows(
          db,
          healthy.scope,
          { sourceMessageId: "readable" },
          base.createdAt,
        ).map((r) => r.id),
      ).toEqual([healthy.id]);
      expect(() =>
        listMemoryMetadataByScopeRows(
          db,
          base.scope,
          { sourceMessageId: "readable" },
          base.createdAt,
        ),
      ).toThrow();
      updateMemoryRow(
        db,
        { ...base, provenance: { ...base.provenance, sourceMessageIds: ["repaired"] } },
        TEST_SEALING,
      );
      expect(
        listMemoryMetadataByScopeRows(
          db,
          base.scope,
          { sourceMessageId: "repaired" },
          base.createdAt,
        ).map((r) => r.id),
      ).toEqual([base.id]);
    } finally {
      db.close();
    }
  });
});
