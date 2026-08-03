import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryId, MemoryRecord, MemoryUserId } from "@oscharko-dev/keiko-contracts";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import { persistCapturedMemory } from "./memory-capture-persistence.js";

const roots: string[] = [];
const vaults: MemoryVaultStore[] = [];

afterEach(() => {
  for (const vault of vaults.splice(0)) vault.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function vault(): MemoryVaultStore {
  const memoryDir = mkdtempSync(join(tmpdir(), "keiko-capture-persistence-"));
  roots.push(memoryDir);
  const store = createMemoryVault({ memoryDir, redactString: (value) => value });
  vaults.push(store);
  return store;
}

function record(
  status: "proposed" | "accepted",
  updatedAt = 100,
  id = "canonical-memory",
): MemoryRecord {
  return {
    id: id as MemoryId,
    schemaVersion: "1",
    scope: { kind: "user", userId: "operator" as MemoryUserId },
    type: "preference",
    body: "Use deterministic capture persistence.",
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: updatedAt,
      confidence: 0.9,
      sensitivity: "public",
    },
    validity: { validFrom: updatedAt },
    status,
    pinned: false,
    tags: [],
    createdAt: 100,
    updatedAt,
  };
}

describe("persistCapturedMemory", () => {
  it("reuses an identical canonical candidate without inserting it twice", () => {
    const store = vault();
    expect(persistCapturedMemory(store, record("proposed"), true).inserted).toBe(true);

    expect(persistCapturedMemory(store, record("proposed"), true)).toMatchObject({
      inserted: false,
      promoted: false,
      memory: { status: "proposed" },
    });
  });

  it("promotes a replayed canonical proposal exactly once", () => {
    const store = vault();
    persistCapturedMemory(store, record("proposed"), true);

    expect(persistCapturedMemory(store, record("accepted", 200), true)).toMatchObject({
      inserted: false,
      promoted: true,
      memory: { status: "accepted", updatedAt: 200 },
    });
    expect(persistCapturedMemory(store, record("accepted", 300), true).promoted).toBe(false);
  });

  it("reuses an exact scoped body produced under a different capture id", () => {
    const store = vault();
    persistCapturedMemory(store, record("accepted", 100, "first-capture"), true);

    expect(
      persistCapturedMemory(store, record("accepted", 200, "later-capture"), true),
    ).toMatchObject({
      inserted: false,
      promoted: false,
      memory: { id: "first-capture", status: "accepted" },
    });
    expect(store.listMemoriesByScope(record("accepted").scope)).toHaveLength(1);
  });
});
