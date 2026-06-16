import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryId, MemoryRecord, UserId } from "@oscharko-dev/keiko-contracts/memory";
import { createMemoryVault, type MemoryVaultStore } from "./index.js";

const TEST_VAULT_KEY = Buffer.alloc(32, 7);
const cleanups: string[] = [];

afterEach(() => {
  for (const path of cleanups.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "keiko-mem-access-"));
  cleanups.push(dir);
  return dir;
}

function openVault(dir: string): MemoryVaultStore {
  return createMemoryVault({
    memoryDir: dir,
    env: { KEIKO_MEMORY_DIR: dir },
    vaultKey: TEST_VAULT_KEY,
  });
}

function makeMemory(id: string): MemoryRecord {
  const t = 1_700_000_000_000;
  return {
    id: id as MemoryId,
    schemaVersion: "1",
    scope: { kind: "user", userId: "u-1" as UserId },
    type: "preference",
    body: "prefers dark mode",
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

describe("vault access tracking through the public store", () => {
  it("records and reads back access stats", () => {
    const v = openVault(freshDir());
    v.insertMemory(makeMemory("m1"));
    v.recordAccess(["m1" as MemoryId], 1000);
    v.recordAccess(["m1" as MemoryId], 2000);
    expect(v.getAccessStats(["m1" as MemoryId]).get("m1" as MemoryId)).toEqual({
      lastAccessedAt: 2000,
      accessCount: 2,
      outcomeCount: 0,
      utilitySum: 0,
    });
    v.close();
  });

  it("persists access stats across close + reopen", () => {
    const dir = freshDir();
    const v1 = openVault(dir);
    v1.insertMemory(makeMemory("m1"));
    v1.recordAccess(["m1" as MemoryId], 4242);
    v1.close();
    const v2 = openVault(dir);
    expect(v2.getAccessStats().get("m1" as MemoryId)).toEqual({
      lastAccessedAt: 4242,
      accessCount: 1,
      outcomeCount: 0,
      utilitySum: 0,
    });
    v2.close();
  });

  it("records governed outcomes without disturbing the access counter (O-V1)", () => {
    const v = openVault(freshDir());
    v.insertMemory(makeMemory("m1"));
    v.recordAccess(["m1" as MemoryId], 1000);
    // A positive then a negative outcome: count climbs to 2, summed utility to 1, and neither the
    // recall count nor the last-access timestamp moves (outcomes are not accesses).
    v.recordOutcome(["m1" as MemoryId], 1, 2000);
    v.recordOutcome(["m1" as MemoryId], 0, 3000);
    expect(v.getAccessStats(["m1" as MemoryId]).get("m1" as MemoryId)).toEqual({
      lastAccessedAt: 1000,
      accessCount: 1,
      outcomeCount: 2,
      utilitySum: 1,
    });
    v.close();
  });

  it("records an outcome for a never-accessed memory as an access_count=0 row (O-V1)", () => {
    const v = openVault(freshDir());
    v.insertMemory(makeMemory("m1"));
    v.recordOutcome(["m1" as MemoryId], 0, 5000);
    expect(v.getAccessStats(["m1" as MemoryId]).get("m1" as MemoryId)).toEqual({
      lastAccessedAt: 5000,
      accessCount: 0,
      outcomeCount: 1,
      utilitySum: 0,
    });
    v.close();
  });

  it("drops the access row when the memory is forgotten (cascade)", () => {
    const v = openVault(freshDir());
    v.insertMemory(makeMemory("m1"));
    v.recordAccess(["m1" as MemoryId], 1000);
    v.deleteMemory("m1" as MemoryId, {
      tombstone: false,
      forgetterSurface: "test",
      nowMs: 2000,
    });
    expect(v.getAccessStats(["m1" as MemoryId]).size).toBe(0);
    v.close();
  });
});
