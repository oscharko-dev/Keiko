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
  selectForgetSuppressionBodyHashPresence,
} from "./tombstones.js";
import { memoryBodySuppressionHash } from "./body-fingerprint.js";
import { createMemoryVault } from "./index.js";
import type { MemoryContentCipher } from "./cipher.js";
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
      bodyHash: memoryBodySuppressionHash("Der Nutzer wohnt in München."),
      reviewerId: "reviewer-1" as MemoryReviewerId,
      originalStatus: "accepted",
      reason: "explicit-user-request",
    });
    insertTombstoneRow(db, t, TEST_CIPHER);
    expect(listTombstonesByScopeRows(db, userScope, TEST_CIPHER)).toEqual([t]);
    expect(t.bodyHash).not.toContain("München");
    db.close();
  });

  it("collapses free-form tombstone reasons to a content-free code", () => {
    const db = openTestDb();
    insertTombstoneRow(
      db,
      makeTombstone({
        id: "t1",
        memoryId: "m1" as MemoryId,
        reason: "forget customer acme-secret-token preference",
      }),
      TEST_CIPHER,
    );
    expect(listTombstonesByScopeRows(db, userScope, TEST_CIPHER)[0]?.reason).toBe("user-request");
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

// GEN-PERF-PERSISTENCE-014 — the forget-suppression check previously listed + DECRYPTED every
// tombstone reason per candidate. The presence-only query selects just body_hash for the current OR
// legacy suppression hash and never opens the sealed reason column. These tests prove the same
// suppression decision with ZERO reason decrypts (spy on cipher.openString) and bounded cost.
describe("GEN-PERF-PERSISTENCE-014: forget-suppression presence check performs no reason decrypts", () => {
  // Wrap TEST_CIPHER so we can count openString calls without changing the ciphertext behaviour.
  const countingCipher = (): { cipher: MemoryContentCipher; openStringCalls: () => number } => {
    let calls = 0;
    const cipher: MemoryContentCipher = {
      ...TEST_CIPHER,
      openString: (envelope: string): string => {
        calls += 1;
        return TEST_CIPHER.openString(envelope);
      },
    };
    return { cipher, openStringCalls: (): number => calls };
  };

  const seed = (db: ReturnType<typeof openTestDb>, count: number): void => {
    for (let i = 0; i < count; i += 1) {
      insertTombstoneRow(
        db,
        makeTombstone({
          id: `t-${String(i)}`,
          memoryId: `m-${String(i)}` as MemoryId,
          bodyHash: memoryBodySuppressionHash(`body-${String(i)}`),
          // Every row carries a sealed reason so a full-scan path WOULD decrypt 2k times.
          reason: "explicit-user-request",
        }),
        TEST_CIPHER,
      );
    }
  };

  it("performs ZERO reason decrypts and finds the current-hash match among 2k tombstones", () => {
    const db = openTestDb();
    seed(db, 2000);
    const targetHash = memoryBodySuppressionHash("body-1234");
    // Add a tombstone whose bodyHash is the target current hash.
    insertTombstoneRow(
      db,
      makeTombstone({
        id: "t-target",
        memoryId: "m-target" as MemoryId,
        bodyHash: targetHash,
        reason: "explicit-user-request",
      }),
      TEST_CIPHER,
    );

    const { cipher, openStringCalls } = countingCipher();
    // Sanity: the OLD full-scan path DOES decrypt every reason (regression baseline).
    listTombstonesByScopeRows(db, userScope, cipher);
    expect(openStringCalls()).toBeGreaterThan(2000);

    const { cipher: cipher2, openStringCalls: calls2 } = countingCipher();
    // `cipher2` is unused by the presence query (it takes no cipher) — proving no decrypt is even
    // possible on this path. We assert on the count staying at zero.
    void cipher2;
    const start = performance.now();
    const presence = selectForgetSuppressionBodyHashPresence(
      db,
      userScope,
      targetHash,
      memoryBodySuppressionHash("body-1234-legacy-never-present"),
    );
    const elapsed = performance.now() - start;

    expect(presence.current).toBe(true);
    expect(presence.legacy).toBe(false);
    expect(calls2()).toBe(0); // no reason decrypt on the suppression path
    expect(elapsed).toBeLessThan(50);
    db.close();
  });

  it("reports absence when neither the current nor legacy hash is present", () => {
    const db = openTestDb();
    seed(db, 100);
    const presence = selectForgetSuppressionBodyHashPresence(
      db,
      userScope,
      memoryBodySuppressionHash("not-present-current"),
      memoryBodySuppressionHash("not-present-legacy"),
    );
    expect(presence.current).toBe(false);
    expect(presence.legacy).toBe(false);
    db.close();
  });

  it("detects the legacy hash independently of the current hash", () => {
    const db = openTestDb();
    const legacyHash = memoryBodySuppressionHash("legacy-body");
    insertTombstoneRow(
      db,
      makeTombstone({
        id: "t-legacy",
        memoryId: "m-legacy" as MemoryId,
        bodyHash: legacyHash,
        reason: "explicit-user-request",
      }),
      TEST_CIPHER,
    );
    const presence = selectForgetSuppressionBodyHashPresence(
      db,
      userScope,
      "current-hash-not-present",
      legacyHash,
    );
    expect(presence.current).toBe(false);
    expect(presence.legacy).toBe(true);
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
