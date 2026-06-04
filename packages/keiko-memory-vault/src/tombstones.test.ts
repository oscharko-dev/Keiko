import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type {
  MemoryId,
  MemoryScope,
  UserId,
  WorkspaceId,
} from "@oscharko-dev/keiko-contracts/memory";
import { runMigrations } from "./schema.js";
import type { MemoryTombstone } from "./types.js";
import { insertTombstoneRow, listTombstonesByScopeRows } from "./tombstones.js";

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  return db;
}

function makeTombstone(
  overrides: Partial<MemoryTombstone> & Pick<MemoryTombstone, "id" | "memoryId">,
): MemoryTombstone {
  return {
    scopeKind: "user",
    scopeCoordinate: "u-1",
    type: "preference",
    forgottenAt: 1_700_000_000_000,
    forgetterSurface: "test",
    ...overrides,
  };
}

const userScope: MemoryScope = { kind: "user", userId: "u-1" as UserId };
const workspaceScope: MemoryScope = { kind: "workspace", workspaceId: "u-1" as WorkspaceId };

describe("tombstones", () => {
  it("inserts and lists in forgotten_at ASC order", () => {
    const db = openDb();
    insertTombstoneRow(
      db,
      makeTombstone({ id: "t2", memoryId: "m2" as MemoryId, forgottenAt: 200 }),
    );
    insertTombstoneRow(
      db,
      makeTombstone({ id: "t1", memoryId: "m1" as MemoryId, forgottenAt: 100 }),
    );
    const rows = listTombstonesByScopeRows(db, userScope);
    expect(rows.map((r) => r.id)).toEqual(["t1", "t2"]);
    db.close();
  });

  it("preserves all fields on round-trip when reason is set", () => {
    const db = openDb();
    const t = makeTombstone({
      id: "t1",
      memoryId: "m1" as MemoryId,
      reason: "explicit user-requested deletion",
    });
    insertTombstoneRow(db, t);
    expect(listTombstonesByScopeRows(db, userScope)).toEqual([t]);
    db.close();
  });

  it("omits reason on round-trip when absent (exactOptionalPropertyTypes)", () => {
    const db = openDb();
    insertTombstoneRow(db, makeTombstone({ id: "t1", memoryId: "m1" as MemoryId }));
    const [back] = listTombstonesByScopeRows(db, userScope);
    expect(back).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(back, "reason")).toBe(false);
    db.close();
  });

  it("enforces scope-kind isolation (user u-1 cannot see workspace u-1)", () => {
    const db = openDb();
    insertTombstoneRow(
      db,
      makeTombstone({
        id: "tu",
        memoryId: "mu" as MemoryId,
        scopeKind: "user",
        scopeCoordinate: "u-1",
      }),
    );
    insertTombstoneRow(
      db,
      makeTombstone({
        id: "tw",
        memoryId: "mw" as MemoryId,
        scopeKind: "workspace",
        scopeCoordinate: "u-1",
      }),
    );
    expect(listTombstonesByScopeRows(db, userScope).map((r) => r.id)).toEqual(["tu"]);
    expect(listTombstonesByScopeRows(db, workspaceScope).map((r) => r.id)).toEqual(["tw"]);
    db.close();
  });

  it("does NOT have a foreign key to memories — survives the memory being absent", () => {
    const db = openDb();
    insertTombstoneRow(db, makeTombstone({ id: "t1", memoryId: "never-existed" as MemoryId }));
    expect(listTombstonesByScopeRows(db, userScope).map((r) => r.memoryId)).toEqual([
      "never-existed",
    ]);
    db.close();
  });

  it("returns an empty list for a scope with no tombstones", () => {
    const db = openDb();
    expect(listTombstonesByScopeRows(db, userScope)).toEqual([]);
    db.close();
  });
});
