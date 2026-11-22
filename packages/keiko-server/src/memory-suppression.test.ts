import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryId, MemoryRecord, UserId } from "@oscharko-dev/keiko-contracts/memory";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import { isSuppressedByRejection } from "./memory-suppression.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function makeVault(): MemoryVaultStore {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-mem-suppression-"));
  const vault = createMemoryVault({
    memoryDir: dir,
    env: { KEIKO_MEMORY_DIR: dir },
    vaultKey: Buffer.alloc(32, 3),
  });
  cleanups.push(() => {
    vault.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return vault;
}

function record(
  id: string,
  body: string,
  status: MemoryRecord["status"],
  at: number,
): MemoryRecord {
  return {
    id: id as MemoryId,
    schemaVersion: "1",
    scope: { kind: "user", userId: "local-operator" as UserId },
    type: "semantic-fact",
    body,
    provenance: {
      sourceKind: "system-default",
      capturedAt: at,
      confidence: 0.6,
      sensitivity: "public",
    },
    validity: { validFrom: at },
    status,
    pinned: false,
    tags: [],
    createdAt: at,
    updatedAt: at,
  };
}

describe("isSuppressedByRejection (#4223)", () => {
  it("keeps refusing a rejected fact however many newer rejections the scope holds", () => {
    const vault = makeVault();
    const start = Date.now() - 1_000_000;
    vault.insertMemory(record("old", "The user plays the oboe.", "rejected", start));
    for (let index = 0; index < 210; index += 1) {
      const at = start + 1 + index;
      vault.insertMemory(
        record(`newer-${String(index)}`, `rejected fact ${String(index)}`, "rejected", at),
      );
    }

    expect(
      isSuppressedByRejection(vault, record("again", "the user plays the OBOE", "accepted", start)),
    ).toBe(true);
  });

  it("is not refused by the same fact while it is accepted", () => {
    const vault = makeVault();
    const at = Date.now();
    vault.insertMemory(record("kept", "The user plays the oboe.", "accepted", at));

    expect(
      isSuppressedByRejection(vault, record("again", "The user plays the oboe.", "proposed", at)),
    ).toBe(false);
  });
});
