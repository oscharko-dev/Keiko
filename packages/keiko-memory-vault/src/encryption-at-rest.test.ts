// Encryption-at-rest acceptance tests (ADR-0035). These exercise the WHOLE stack through the public
// factory with a deterministic injected key: no plaintext content on disk, lazy + eager migration of
// legacy plaintext, and loud failure on a wrong key. The on-disk checks read the raw SQLite file
// bytes directly (the `strings`-equivalent) so they prove secrecy at the storage layer, not just at
// the API.

import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryId, MemoryRecord, UserId } from "@oscharko-dev/keiko-contracts/memory";
import { createMemoryVault, MEMORY_VAULT_SCHEMA_VERSION } from "./index.js";
import type { MemoryVaultStore } from "./types.js";

const KEY_A = Buffer.alloc(32, 7);
const KEY_B = Buffer.alloc(32, 9);
const BODY_MARKER = "TOP-SECRET-BODY-需要加密-9f2a";
const TAG_MARKER = "TOP-SECRET-TAG-1234";
const RATIONALE_MARKER = "TOP-SECRET-RATIONALE-zzz";

const cleanups: string[] = [];

afterEach(() => {
  for (const path of cleanups.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "keiko-mem-enc-"));
  cleanups.push(dir);
  return dir;
}

function openVault(dir: string, key: Buffer): MemoryVaultStore {
  return createMemoryVault({
    memoryDir: dir,
    env: { KEIKO_MEMORY_DIR: dir },
    vaultKey: key,
    now: () => 1_700_000_000_000,
  });
}

function secretMemory(id: string): MemoryRecord {
  const t = 1_700_000_000_000;
  return {
    id: id as MemoryId,
    schemaVersion: "1",
    scope: { kind: "user", userId: "u-1" as UserId },
    type: "preference",
    body: BODY_MARKER,
    payload: { kind: "string-list", items: [RATIONALE_MARKER] },
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: t,
      confidence: 0.9,
      sensitivity: "confidential",
      captureRationale: RATIONALE_MARKER,
    },
    validity: { validFrom: t },
    status: "accepted",
    pinned: false,
    tags: [TAG_MARKER],
    staleReason: RATIONALE_MARKER,
    createdAt: t,
    updatedAt: t,
  };
}

// Read every byte SQLite may have written for this DB (main file + WAL sidecar) — the storage-layer
// equivalent of `strings db db-wal | grep <marker>`. Returns a Buffer so the marker search is
// byte-exact (markers contain multibyte UTF-8, which a string decode would mangle).
function rawDbBytes(dir: string): Buffer {
  const dbPath = join(dir, "keiko-memory.db");
  let bytes = readFileSync(dbPath);
  for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      bytes = Buffer.concat([bytes, readFileSync(sidecar)]);
    } catch {
      // sidecar may not exist after a clean close; that's fine.
    }
  }
  return bytes;
}

function onDiskContains(dir: string, marker: string): boolean {
  return rawDbBytes(dir).includes(Buffer.from(marker, "utf8"));
}

describe("on-disk secrecy", () => {
  it("writes no plaintext content marker to the SQLite file or WAL", () => {
    const dir = freshDir();
    const vault = openVault(dir, KEY_A);
    vault.insertMemory(secretMemory("m1"));
    for (const marker of [BODY_MARKER, TAG_MARKER, RATIONALE_MARKER]) {
      expect(onDiskContains(dir, marker)).toBe(false);
    }
    vault.close();
  });

  it("round-trips every content field back to the identical record", () => {
    const dir = freshDir();
    const vault = openVault(dir, KEY_A);
    const record = secretMemory("m1");
    vault.insertMemory(record);
    expect(vault.getMemory("m1" as MemoryId)).toEqual(record);
    vault.close();
  });

  it("keeps scope metadata cleartext on disk (for the UI scope display)", () => {
    const dir = freshDir();
    const vault = openVault(dir, KEY_A);
    vault.insertMemory(secretMemory("m1"));
    // The user-scope coordinate is an index column, so it stays readable without a key.
    expect(onDiskContains(dir, "u-1")).toBe(true);
    vault.close();
  });
});

describe("wrong key fails loudly", () => {
  it("throws when reopening with a different key (no silent corruption)", () => {
    const dir = freshDir();
    const first = openVault(dir, KEY_A);
    first.insertMemory(secretMemory("m1"));
    first.close();

    const second = openVault(dir, KEY_B);
    expect(() => second.getMemory("m1" as MemoryId)).toThrow();
    second.close();
  });
});

// Simulate a pre-encryption (v1) DB by writing plaintext content directly into the columns and
// resetting user_version to 1, then reopening through the vault so the eager sweep runs.
function downgradeToLegacyPlaintext(dir: string): void {
  const dbPath = join(dir, "keiko-memory.db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.prepare("UPDATE memories SET body = ?, tags_json = ?, capture_rationale = ? WHERE id = ?").run(
    BODY_MARKER,
    JSON.stringify([TAG_MARKER]),
    RATIONALE_MARKER,
    "m1",
  );
  // A genuine v1 (pre-encryption) DB predates the v3 access table; drop it so the reopen applies
  // the v3 DDL cleanly instead of colliding with an already-present table.
  db.exec("DROP TABLE IF EXISTS memory_access");
  db.exec("PRAGMA user_version = 1");
  db.close();
}

describe("legacy plaintext migration", () => {
  it("re-encrypts existing plaintext on open and still reads it back", () => {
    const dir = freshDir();
    const seed = openVault(dir, KEY_A);
    seed.insertMemory(secretMemory("m1"));
    seed.close();

    downgradeToLegacyPlaintext(dir);
    // Confirm the downgrade actually left plaintext on disk (otherwise the test proves nothing).
    expect(onDiskContains(dir, BODY_MARKER)).toBe(true);

    const migrated = openVault(dir, KEY_A);
    // After the eager sweep the plaintext is gone from disk but the value still reads back.
    expect(onDiskContains(dir, BODY_MARKER)).toBe(false);
    const back = migrated.getMemory("m1" as MemoryId);
    expect(back?.body).toBe(BODY_MARKER);
    expect(back?.tags).toEqual([TAG_MARKER]);
    expect(back?.provenance.captureRationale).toBe(RATIONALE_MARKER);
    // The eager encryption sweep runs as part of the v1 -> head migration; the DB lands on the
    // current schema head (access table added), not on the encryption version in isolation.
    const version = readUserVersion(dir);
    expect(version).toBe(MEMORY_VAULT_SCHEMA_VERSION);
    migrated.close();
  });

  it("is idempotent: a second open does not double-encrypt", () => {
    const dir = freshDir();
    const seed = openVault(dir, KEY_A);
    seed.insertMemory(secretMemory("m1"));
    seed.close();
    downgradeToLegacyPlaintext(dir);

    const first = openVault(dir, KEY_A);
    first.close();
    const second = openVault(dir, KEY_A);
    expect(second.getMemory("m1" as MemoryId)?.body).toBe(BODY_MARKER);
    second.close();
  });
});

function readUserVersion(dir: string): number {
  const db = new DatabaseSync(join(dir, "keiko-memory.db"));
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number };
  db.close();
  return row.user_version ?? 0;
}
