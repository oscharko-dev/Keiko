import { describe, expect, it } from "vitest";
import { makeRecord, memId, openTestDb, TEST_CIPHER } from "./_support.js";
import {
  insertMemoryRow,
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
      insertMemoryRow(db, target, TEST_CIPHER);
      insertMemoryRow(
        db,
        {
          ...base,
          id: memId("source-newer"),
          createdAt: base.createdAt + 1,
          updatedAt: base.updatedAt + 1,
          provenance: { ...base.provenance, sourceMessageIds: ["message-10"] },
        },
        TEST_CIPHER,
      );
      insertMemoryRow(
        db,
        { ...target, id: memId("source-other-scope"), scope: { kind: "global" } },
        TEST_CIPHER,
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
        TEST_CIPHER,
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
