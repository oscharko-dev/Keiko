import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MemoryId,
  MemoryRecord,
  MemoryReviewerId,
  MemoryScope,
  UserId,
  WorkspaceId,
} from "@oscharko-dev/keiko-contracts/memory";
import type { MemoryTombstone } from "./types.js";
import {
  deleteTombstonesByScopeBeforeRows,
  insertTombstoneRow,
  listTombstonesByScopeRows,
} from "./tombstones.js";
import { createMemoryVault } from "./index.js";
import { openTestDb, TEST_CIPHER } from "./_support.js";

const TEST_VAULT_KEY = Buffer.alloc(32, 7);

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
    const db = openTestDb();
    insertTombstoneRow(
      db,
      makeTombstone({ id: "t2", memoryId: "m2" as MemoryId, forgottenAt: 200 }),
      TEST_CIPHER,
    );
    insertTombstoneRow(
      db,
      makeTombstone({ id: "t1", memoryId: "m1" as MemoryId, forgottenAt: 100 }),
      TEST_CIPHER,
    );
    const rows = listTombstonesByScopeRows(db, userScope, TEST_CIPHER);
    expect(rows.map((r) => r.id)).toEqual(["t1", "t2"]);
    db.close();
  });

  it("preserves all fields on round-trip when reason is set", () => {
    const db = openTestDb();
    const t = makeTombstone({
      id: "t1",
      memoryId: "m1" as MemoryId,
      reviewerId: "reviewer-1" as MemoryReviewerId,
      originalStatus: "accepted",
      reason: "explicit user-requested deletion",
    });
    insertTombstoneRow(db, t, TEST_CIPHER);
    expect(listTombstonesByScopeRows(db, userScope, TEST_CIPHER)).toEqual([t]);
    db.close();
  });

  it("omits reason on round-trip when absent (exactOptionalPropertyTypes)", () => {
    const db = openTestDb();
    insertTombstoneRow(db, makeTombstone({ id: "t1", memoryId: "m1" as MemoryId }), TEST_CIPHER);
    const [back] = listTombstonesByScopeRows(db, userScope, TEST_CIPHER);
    expect(back).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(back, "reason")).toBe(false);
    db.close();
  });

  it("enforces scope-kind isolation (user u-1 cannot see workspace u-1)", () => {
    const db = openTestDb();
    insertTombstoneRow(
      db,
      makeTombstone({
        id: "tu",
        memoryId: "mu" as MemoryId,
        scopeKind: "user",
        scopeCoordinate: "u-1",
      }),
      TEST_CIPHER,
    );
    insertTombstoneRow(
      db,
      makeTombstone({
        id: "tw",
        memoryId: "mw" as MemoryId,
        scopeKind: "workspace",
        scopeCoordinate: "u-1",
      }),
      TEST_CIPHER,
    );
    expect(listTombstonesByScopeRows(db, userScope, TEST_CIPHER).map((r) => r.id)).toEqual(["tu"]);
    expect(listTombstonesByScopeRows(db, workspaceScope, TEST_CIPHER).map((r) => r.id)).toEqual([
      "tw",
    ]);
    db.close();
  });

  it("does NOT have a foreign key to memories — survives the memory being absent", () => {
    const db = openTestDb();
    insertTombstoneRow(
      db,
      makeTombstone({ id: "t1", memoryId: "never-existed" as MemoryId }),
      TEST_CIPHER,
    );
    expect(listTombstonesByScopeRows(db, userScope, TEST_CIPHER).map((r) => r.memoryId)).toEqual([
      "never-existed",
    ]);
    db.close();
  });

  it("returns an empty list for a scope with no tombstones", () => {
    const db = openTestDb();
    expect(listTombstonesByScopeRows(db, userScope, TEST_CIPHER)).toEqual([]);
    db.close();
  });

  it("deletes tombstones older than the scope-specific cutoff", () => {
    const db = openTestDb();
    insertTombstoneRow(
      db,
      makeTombstone({ id: "old-user", memoryId: "old-user" as MemoryId, forgottenAt: 100 }),
      TEST_CIPHER,
    );
    insertTombstoneRow(
      db,
      makeTombstone({ id: "fresh-user", memoryId: "fresh-user" as MemoryId, forgottenAt: 200 }),
      TEST_CIPHER,
    );
    insertTombstoneRow(
      db,
      makeTombstone({
        id: "old-workspace",
        memoryId: "old-workspace" as MemoryId,
        scopeKind: "workspace",
        scopeCoordinate: "u-1",
        forgottenAt: 100,
      }),
      TEST_CIPHER,
    );
    expect(deleteTombstonesByScopeBeforeRows(db, userScope, 150)).toBe(1);
    expect(listTombstonesByScopeRows(db, userScope, TEST_CIPHER).map((t) => t.id)).toEqual([
      "fresh-user",
    ]);
    expect(listTombstonesByScopeRows(db, workspaceScope, TEST_CIPHER).map((t) => t.id)).toEqual([
      "old-workspace",
    ]);
    db.close();
  });
});

const factoryCleanups: string[] = [];

afterEach(() => {
  for (const path of factoryCleanups.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function freshFactoryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "keiko-tomb-ac4-"));
  factoryCleanups.push(dir);
  return dir;
}

function happyRecord(id: string): MemoryRecord {
  const t = 1_700_000_000_000;
  return {
    id: id as MemoryId,
    schemaVersion: "1",
    scope: { kind: "user", userId: "u-1" as UserId },
    type: "preference",
    body: "body",
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: t,
      confidence: 0.9,
      sensitivity: "confidential",
    },
    validity: { validFrom: t },
    status: "accepted",
    pinned: false,
    tags: [],
    createdAt: t,
    updatedAt: t,
  };
}

describe("AC4: hard delete leaves the tombstones table empty", () => {
  it("deleteMemory with tombstone:false writes NO tombstone row", () => {
    const dir = freshFactoryDir();
    const vault = createMemoryVault({
      memoryDir: dir,
      env: { KEIKO_MEMORY_DIR: dir },
      vaultKey: TEST_VAULT_KEY,
      now: () => 1_700_000_000_000,
      newTombstoneId: () => "t-never",
    });
    vault.insertMemory(happyRecord("m-1"));
    vault.deleteMemory("m-1" as MemoryId, {
      tombstone: false,
      forgetterSurface: "test",
      reviewerId: "reviewer-1" as MemoryReviewerId,
      nowMs: 1_700_000_000_001,
    });
    expect(vault.listTombstonesByScope(userScope)).toEqual([]);
    expect(vault.getMemory("m-1" as MemoryId)).toBeUndefined();
    vault.close();
  });
});
