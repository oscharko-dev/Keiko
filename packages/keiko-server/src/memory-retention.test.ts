// Tests for the memory retention policy enforcer (#214). Each test wires the function to
// a real in-memory vault and asserts the resulting deletions, decision counts, and the
// per-reason histogram. Pinned-immunity has a dedicated test.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type {
  MemoryId,
  MemoryRecord,
  MemoryScope,
  MemoryUserId,
} from "@oscharko-dev/keiko-contracts";
import { applyMemoryRetention, type MemoryRetentionPolicy } from "./memory-retention.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

function brandedMemoryId(value: string): MemoryId {
  const u: unknown = value;
  return u as MemoryId;
}

function brandedMemoryUserId(value: string): MemoryUserId {
  const u: unknown = value;
  return u as MemoryUserId;
}

const USER_ID = brandedMemoryUserId("u-retention");
const SCOPE: MemoryScope = { kind: "user", userId: USER_ID };

let tmpDir = "";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keiko-mem-retention-"));
});

afterEach(() => {
  if (tmpDir !== "") {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  }
});

function makeVault(): MemoryVaultStore {
  return createMemoryVault({
    memoryDir: tmpDir,
    env: { KEIKO_MEMORY_DIR: tmpDir },
    redactString: (s) => s,
  });
}

interface MakeRecordOptions {
  readonly id: string;
  readonly updatedAt: number;
  readonly status?: MemoryRecord["status"];
  readonly pinned?: boolean;
}

function insertRecord(vault: MemoryVaultStore, options: MakeRecordOptions): MemoryRecord {
  const record: MemoryRecord = {
    id: brandedMemoryId(options.id),
    schemaVersion: "1",
    scope: SCOPE,
    type: "preference",
    body: `record ${options.id}`,
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: options.updatedAt,
      confidence: 0.9,
      sensitivity: "public",
    },
    validity: { validFrom: options.updatedAt },
    status: options.status ?? "accepted",
    pinned: options.pinned ?? false,
    tags: [],
    createdAt: options.updatedAt,
    updatedAt: options.updatedAt,
  };
  return vault.insertMemory(record);
}

const NOW = 2_000_000_000_000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// ── maxAgeMs ──────────────────────────────────────────────────────────────────

describe("applyMemoryRetention — maxAgeMs", () => {
  it("forgets records older than maxAgeMs and keeps the rest", () => {
    const vault = makeVault();
    insertRecord(vault, { id: "old-1", updatedAt: NOW - 10 * ONE_DAY_MS });
    insertRecord(vault, { id: "old-2", updatedAt: NOW - 8 * ONE_DAY_MS });
    insertRecord(vault, { id: "fresh-1", updatedAt: NOW - ONE_DAY_MS });
    const policy: MemoryRetentionPolicy = { maxAgeMs: 7 * ONE_DAY_MS };
    const result = applyMemoryRetention({ vault, scopes: [SCOPE], policy, nowMs: NOW });
    expect(result.evaluated).toBe(3);
    expect(result.forgotten).toHaveLength(2);
    expect(result.byReason["expire-age"]).toBe(2);
    expect(result.kept).toBe(1);
    expect(vault.getMemory(brandedMemoryId("fresh-1"))).toBeDefined();
    expect(vault.getMemory(brandedMemoryId("old-1"))).toBeUndefined();
    expect(vault.getMemory(brandedMemoryId("old-2"))).toBeUndefined();
  });

  it("applies age expiry deterministically across accepted, archived, and expired records", () => {
    const vault = makeVault();
    insertRecord(vault, {
      id: "old-accepted",
      updatedAt: NOW - 10 * ONE_DAY_MS,
      status: "accepted",
    });
    insertRecord(vault, {
      id: "old-archived",
      updatedAt: NOW - 10 * ONE_DAY_MS,
      status: "archived",
    });
    insertRecord(vault, {
      id: "old-expired",
      updatedAt: NOW - 10 * ONE_DAY_MS,
      status: "expired",
    });
    const policy: MemoryRetentionPolicy = { maxAgeMs: 7 * ONE_DAY_MS };
    const result = applyMemoryRetention({ vault, scopes: [SCOPE], policy, nowMs: NOW });
    expect(result.forgotten.map((decision) => decision.status).sort()).toEqual([
      "accepted",
      "archived",
      "expired",
    ]);
    expect(result.byReason["expire-age"]).toBe(3);
    expect(vault.getMemory(brandedMemoryId("old-accepted"))).toBeUndefined();
    expect(vault.getMemory(brandedMemoryId("old-archived"))).toBeUndefined();
    expect(vault.getMemory(brandedMemoryId("old-expired"))).toBeUndefined();
    expect(vault.listTombstonesByScope(SCOPE)).toHaveLength(3);
  });

  it("never forgets pinned records even when past maxAgeMs", () => {
    const vault = makeVault();
    insertRecord(vault, { id: "pinned-old", updatedAt: NOW - 10 * ONE_DAY_MS, pinned: true });
    insertRecord(vault, { id: "unpinned-old", updatedAt: NOW - 10 * ONE_DAY_MS, pinned: false });
    const policy: MemoryRetentionPolicy = { maxAgeMs: 7 * ONE_DAY_MS };
    const result = applyMemoryRetention({ vault, scopes: [SCOPE], policy, nowMs: NOW });
    expect(result.forgotten).toHaveLength(1);
    expect(result.forgotten[0]?.memoryId).toBe(brandedMemoryId("unpinned-old"));
    expect(vault.getMemory(brandedMemoryId("pinned-old"))).toBeDefined();
  });
});

// ── maxRecordsPerScope ────────────────────────────────────────────────────────

describe("applyMemoryRetention — maxRecordsPerScope", () => {
  it("evicts the oldest non-pinned records once the cap is exceeded", () => {
    const vault = makeVault();
    insertRecord(vault, { id: "r-1", updatedAt: NOW - 4 * ONE_DAY_MS });
    insertRecord(vault, { id: "r-2", updatedAt: NOW - 3 * ONE_DAY_MS });
    insertRecord(vault, { id: "r-3", updatedAt: NOW - 2 * ONE_DAY_MS });
    insertRecord(vault, { id: "r-4", updatedAt: NOW - ONE_DAY_MS });
    const policy: MemoryRetentionPolicy = { maxRecordsPerScope: 2 };
    const result = applyMemoryRetention({ vault, scopes: [SCOPE], policy, nowMs: NOW });
    expect(result.forgotten).toHaveLength(2);
    expect(result.byReason["evict-overflow"]).toBe(2);
    expect(vault.getMemory(brandedMemoryId("r-1"))).toBeUndefined();
    expect(vault.getMemory(brandedMemoryId("r-2"))).toBeUndefined();
    expect(vault.getMemory(brandedMemoryId("r-3"))).toBeDefined();
    expect(vault.getMemory(brandedMemoryId("r-4"))).toBeDefined();
  });

  it("uses memory id as a deterministic tie-breaker when updatedAt values match", () => {
    const vault = makeVault();
    insertRecord(vault, { id: "same-c", updatedAt: NOW - ONE_DAY_MS });
    insertRecord(vault, { id: "same-a", updatedAt: NOW - ONE_DAY_MS });
    insertRecord(vault, { id: "same-b", updatedAt: NOW - ONE_DAY_MS });
    const policy: MemoryRetentionPolicy = { maxRecordsPerScope: 1 };
    const result = applyMemoryRetention({ vault, scopes: [SCOPE], policy, nowMs: NOW });
    expect(result.forgotten.map((decision) => decision.memoryId)).toEqual([
      brandedMemoryId("same-a"),
      brandedMemoryId("same-b"),
    ]);
    expect(vault.getMemory(brandedMemoryId("same-a"))).toBeUndefined();
    expect(vault.getMemory(brandedMemoryId("same-b"))).toBeUndefined();
    expect(vault.getMemory(brandedMemoryId("same-c"))).toBeDefined();
    expect(vault.listTombstonesByScope(SCOPE)).toHaveLength(2);
  });

  it("does not count pinned records toward the cap and never evicts them", () => {
    const vault = makeVault();
    insertRecord(vault, { id: "pin-1", updatedAt: NOW - 5 * ONE_DAY_MS, pinned: true });
    insertRecord(vault, { id: "pin-2", updatedAt: NOW - 4 * ONE_DAY_MS, pinned: true });
    insertRecord(vault, { id: "free-1", updatedAt: NOW - 3 * ONE_DAY_MS });
    insertRecord(vault, { id: "free-2", updatedAt: NOW - 2 * ONE_DAY_MS });
    insertRecord(vault, { id: "free-3", updatedAt: NOW - ONE_DAY_MS });
    const policy: MemoryRetentionPolicy = { maxRecordsPerScope: 1 };
    const result = applyMemoryRetention({ vault, scopes: [SCOPE], policy, nowMs: NOW });
    // Two non-pinned over the cap of 1 should evict the two oldest non-pinned.
    expect(result.forgotten).toHaveLength(2);
    expect(vault.getMemory(brandedMemoryId("pin-1"))).toBeDefined();
    expect(vault.getMemory(brandedMemoryId("pin-2"))).toBeDefined();
    expect(vault.getMemory(brandedMemoryId("free-3"))).toBeDefined();
  });

  it("issues no deletes when the non-pinned working set is at or below the cap", () => {
    const vault = makeVault();
    insertRecord(vault, { id: "k-1", updatedAt: NOW - 2 * ONE_DAY_MS });
    insertRecord(vault, { id: "k-2", updatedAt: NOW - ONE_DAY_MS });
    const policy: MemoryRetentionPolicy = { maxRecordsPerScope: 5 };
    const result = applyMemoryRetention({ vault, scopes: [SCOPE], policy, nowMs: NOW });
    expect(result.forgotten).toHaveLength(0);
    expect(result.kept).toBe(2);
  });
});

// ── expireProposalsAfterMs ───────────────────────────────────────────────────

describe("applyMemoryRetention — expireProposalsAfterMs", () => {
  it("expires only proposed records past the threshold", () => {
    const vault = makeVault();
    insertRecord(vault, {
      id: "stale-proposal",
      updatedAt: NOW - 10 * ONE_DAY_MS,
      status: "proposed",
    });
    insertRecord(vault, {
      id: "fresh-proposal",
      updatedAt: NOW - ONE_DAY_MS,
      status: "proposed",
    });
    insertRecord(vault, {
      id: "stale-accepted",
      updatedAt: NOW - 10 * ONE_DAY_MS,
      status: "accepted",
    });
    const policy: MemoryRetentionPolicy = { expireProposalsAfterMs: 7 * ONE_DAY_MS };
    const result = applyMemoryRetention({ vault, scopes: [SCOPE], policy, nowMs: NOW });
    expect(result.forgotten).toHaveLength(1);
    expect(result.forgotten[0]?.memoryId).toBe(brandedMemoryId("stale-proposal"));
    expect(result.byReason["expire-proposal"]).toBe(1);
    expect(vault.getMemory(brandedMemoryId("stale-accepted"))).toBeDefined();
    expect(vault.getMemory(brandedMemoryId("fresh-proposal"))).toBeDefined();
  });
});

// ── purgeForgottenAfterMs ────────────────────────────────────────────────────

describe("applyMemoryRetention — purgeForgottenAfterMs", () => {
  it("purges tombstones older than the threshold through the vault port", () => {
    const vault = makeVault();
    insertRecord(vault, { id: "old-tomb", updatedAt: NOW - 30 * ONE_DAY_MS });
    insertRecord(vault, { id: "fresh-tomb", updatedAt: NOW - ONE_DAY_MS });
    vault.deleteMemory(brandedMemoryId("old-tomb"), {
      tombstone: true,
      forgetterSurface: "retention",
      reason: "old test seed",
      nowMs: NOW - 30 * ONE_DAY_MS,
    });
    vault.deleteMemory(brandedMemoryId("fresh-tomb"), {
      tombstone: true,
      forgetterSurface: "retention",
      reason: "fresh test seed",
      nowMs: NOW - ONE_DAY_MS,
    });
    const policy: MemoryRetentionPolicy = { purgeForgottenAfterMs: 7 * ONE_DAY_MS };
    const result = applyMemoryRetention({ vault, scopes: [SCOPE], policy, nowMs: NOW });
    expect(result.forgottenPurgeBacklog).toBe(1);
    expect(vault.listTombstonesByScope(SCOPE)).toHaveLength(1);
    expect(vault.listTombstonesByScope(SCOPE)[0]?.memoryId).toBe(brandedMemoryId("fresh-tomb"));
  });
});

// ── result shape ──────────────────────────────────────────────────────────────

describe("applyMemoryRetention — result shape", () => {
  it("returns evaluated/forgotten/kept that always sum correctly", () => {
    const vault = makeVault();
    insertRecord(vault, { id: "a", updatedAt: NOW - 10 * ONE_DAY_MS });
    insertRecord(vault, { id: "b", updatedAt: NOW - ONE_DAY_MS });
    const policy: MemoryRetentionPolicy = { maxAgeMs: 7 * ONE_DAY_MS };
    const result = applyMemoryRetention({ vault, scopes: [SCOPE], policy, nowMs: NOW });
    expect(result.kept + result.forgotten.length).toBe(result.evaluated);
  });

  it("returns zero counts when no policy field is set", () => {
    const vault = makeVault();
    insertRecord(vault, { id: "alone", updatedAt: NOW - ONE_DAY_MS });
    const result = applyMemoryRetention({
      vault,
      scopes: [SCOPE],
      policy: {},
      nowMs: NOW,
    });
    expect(result.forgotten).toHaveLength(0);
    expect(result.evaluated).toBe(1);
    expect(result.kept).toBe(1);
  });

  it("deduplicates repeated scopes so the pass stays idempotent", () => {
    const vault = makeVault();
    insertRecord(vault, { id: "dup-old", updatedAt: NOW - 10 * ONE_DAY_MS });
    const result = applyMemoryRetention({
      vault,
      scopes: [SCOPE, SCOPE],
      policy: { maxAgeMs: 7 * ONE_DAY_MS },
      nowMs: NOW,
    });
    expect(result.evaluated).toBe(1);
    expect(result.forgotten).toHaveLength(1);
    expect(result.byReason["expire-age"]).toBe(1);
    expect(vault.getMemory(brandedMemoryId("dup-old"))).toBeUndefined();
  });
});
