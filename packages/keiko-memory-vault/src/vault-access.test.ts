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
    });
    v2.close();
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
