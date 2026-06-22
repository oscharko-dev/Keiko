import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { MemoryId } from "@oscharko-dev/keiko-contracts/memory";
import { getAccessStatsRows, recordAccessRows, recordOutcomeRows } from "./access.js";
import { insertMemoryRow } from "./memories.js";
import { makeRecord, memId, openTestDb, TEST_CIPHER } from "./_support.js";

function seedMemory(db: DatabaseSync, value: string): MemoryId {
  insertMemoryRow(db, makeRecord({ id: memId(value) }), TEST_CIPHER);
  return memId(value);
}

function id(value: string): MemoryId {
  return memId(value);
}

describe("recordAccessRows", () => {
  it("inserts a fresh access row with count 1", () => {
    const db = openTestDb();
    const m1 = seedMemory(db, "m1");
    recordAccessRows(db, [m1], 1000);
    const stats = getAccessStatsRows(db, [m1]);
    expect(stats.get(m1)).toEqual({
      lastAccessedAt: 1000,
      accessCount: 1,
      outcomeCount: 0,
      utilitySum: 0,
    });
    db.close();
  });

  it("increments the count and advances the timestamp on a repeat access", () => {
    const db = openTestDb();
    const m1 = seedMemory(db, "m1");
    recordAccessRows(db, [m1], 1000);
    recordAccessRows(db, [m1], 2000);
    recordAccessRows(db, [m1], 3000);
    const stats = getAccessStatsRows(db, [m1]);
    expect(stats.get(m1)).toEqual({
      lastAccessedAt: 3000,
      accessCount: 3,
      outcomeCount: 0,
      utilitySum: 0,
    });
    db.close();
  });

  it("records each id in a multi-id batch exactly once", () => {
    const db = openTestDb();
    const m1 = seedMemory(db, "m1");
    const m2 = seedMemory(db, "m2");
    recordAccessRows(db, [m1, m2], 5000);
    const stats = getAccessStatsRows(db);
    expect(stats.get(m1)).toEqual({
      lastAccessedAt: 5000,
      accessCount: 1,
      outcomeCount: 0,
      utilitySum: 0,
    });
    expect(stats.get(m2)).toEqual({
      lastAccessedAt: 5000,
      accessCount: 1,
      outcomeCount: 0,
      utilitySum: 0,
    });
    db.close();
  });

  it("counts a duplicate id within a single batch as multiple accesses", () => {
    const db = openTestDb();
    const m1 = seedMemory(db, "m1");
    recordAccessRows(db, [m1, m1], 7000);
    const stats = getAccessStatsRows(db, [m1]);
    expect(stats.get(m1)).toEqual({
      lastAccessedAt: 7000,
      accessCount: 2,
      outcomeCount: 0,
      utilitySum: 0,
    });
    db.close();
  });

  it("does nothing for an empty id list", () => {
    const db = openTestDb();
    seedMemory(db, "m1");
    recordAccessRows(db, [], 1000);
    expect(getAccessStatsRows(db).size).toBe(0);
    db.close();
  });
});

describe("getAccessStatsRows", () => {
  it("returns an empty map when no rows exist", () => {
    const db = openTestDb();
    expect(getAccessStatsRows(db).size).toBe(0);
    db.close();
  });

  it("returns every row when no id filter is supplied", () => {
    const db = openTestDb();
    const m1 = seedMemory(db, "m1");
    const m2 = seedMemory(db, "m2");
    recordAccessRows(db, [m1], 1000);
    recordAccessRows(db, [m2], 2000);
    const stats = getAccessStatsRows(db);
    expect(stats.size).toBe(2);
    db.close();
  });

  it("filters to only the requested ids", () => {
    const db = openTestDb();
    const m1 = seedMemory(db, "m1");
    const m2 = seedMemory(db, "m2");
    recordAccessRows(db, [m1], 1000);
    recordAccessRows(db, [m2], 2000);
    const stats = getAccessStatsRows(db, [m1]);
    expect(stats.size).toBe(1);
    expect(stats.get(m1)).toEqual({
      lastAccessedAt: 1000,
      accessCount: 1,
      outcomeCount: 0,
      utilitySum: 0,
    });
    expect(stats.get(m2)).toBeUndefined();
    db.close();
  });

  it("omits ids that have no access row", () => {
    const db = openTestDb();
    const m1 = seedMemory(db, "m1");
    recordAccessRows(db, [m1], 1000);
    const stats = getAccessStatsRows(db, [m1, id("never-accessed")]);
    expect(stats.size).toBe(1);
    expect(stats.has(m1)).toBe(true);
    db.close();
  });

  it("returns an empty map for an empty id filter", () => {
    const db = openTestDb();
    const m1 = seedMemory(db, "m1");
    recordAccessRows(db, [m1], 1000);
    expect(getAccessStatsRows(db, []).size).toBe(0);
    db.close();
  });
});

describe("recordOutcomeRows (O-V1)", () => {
  it("inserts an outcome-only row with access_count 0 and the given utility", () => {
    const db = openTestDb();
    const m1 = seedMemory(db, "m1");
    recordOutcomeRows(db, [m1], 1, 9000);
    expect(getAccessStatsRows(db, [m1]).get(m1)).toEqual({
      lastAccessedAt: 9000,
      accessCount: 0,
      outcomeCount: 1,
      utilitySum: 1,
    });
    db.close();
  });

  it("accumulates outcome count and summed utility without touching the access counter", () => {
    const db = openTestDb();
    const m1 = seedMemory(db, "m1");
    recordAccessRows(db, [m1], 1000);
    recordAccessRows(db, [m1], 2000);
    recordOutcomeRows(db, [m1], 1, 3000);
    recordOutcomeRows(db, [m1], 0.5, 4000);
    expect(getAccessStatsRows(db, [m1]).get(m1)).toEqual({
      lastAccessedAt: 2000,
      accessCount: 2,
      outcomeCount: 2,
      utilitySum: 1.5,
    });
    db.close();
  });

  it("clamps a utility above 1 or below 0 into [0,1]", () => {
    const db = openTestDb();
    const m1 = seedMemory(db, "m1");
    const m2 = seedMemory(db, "m2");
    recordOutcomeRows(db, [m1], 5, 1000);
    recordOutcomeRows(db, [m2], -3, 1000);
    expect(getAccessStatsRows(db, [m1]).get(m1)?.utilitySum).toBe(1);
    expect(getAccessStatsRows(db, [m2]).get(m2)?.utilitySum).toBe(0);
    db.close();
  });

  it("counts a duplicate id within a single batch as multiple outcomes", () => {
    const db = openTestDb();
    const m1 = seedMemory(db, "m1");
    recordOutcomeRows(db, [m1, m1], 1, 1000);
    expect(getAccessStatsRows(db, [m1]).get(m1)?.outcomeCount).toBe(2);
    db.close();
  });

  it("does nothing for an empty id list", () => {
    const db = openTestDb();
    seedMemory(db, "m1");
    recordOutcomeRows(db, [], 1, 1000);
    expect(getAccessStatsRows(db).size).toBe(0);
    db.close();
  });
});

describe("cascade delete", () => {
  it("removes the access row when its memory is hard-deleted", () => {
    const db = openTestDb();
    const m1 = seedMemory(db, "m1");
    recordAccessRows(db, [m1], 1000);
    db.prepare("DELETE FROM memories WHERE id = ?").run(m1);
    expect(getAccessStatsRows(db, [m1]).size).toBe(0);
    db.close();
  });
});
