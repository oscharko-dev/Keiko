// GEN-PERF-CHAT-004 regression: decoded vectors must survive the fresh-store-per-request
// boundary. The grounded-ask path opens a NEW KnowledgeStore per request (openStoreForDeps
// -> close in finally). Before the fix the decoded-vector / ANN caches were WeakMaps keyed
// by store IDENTITY, so a second request against the same dbPath opened a distinct store
// object, missed the cache, and re-SELECTed + re-decrypted (AES-GCM openVector) every row.
//
// This test seeds an ENCRYPTED store, closes it, then opens a SECOND fresh store at the
// SAME dbPath and searches it — exactly the per-request lifecycle. With the cache keyed by
// dbPath the second store's cipher.openVector is NOT called for the vector decode (the
// decoded set is served from the module cache). Pre-fix the spy would fire once per vector
// row on the second store. We also assert content-change invalidation still re-decrypts.
//
// Security invariants asserted here: (1) encryption stays on — the store is opened with a
// real key provider and vectors are AES-GCM sealed at rest; (2) the cache holds only
// already-decrypted vectors in-process (never persisted); (3) an indexing write that bumps
// the capsule content stamp forces a fresh decode so stale plaintext can never be served.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";

import {
  openKnowledgeStore,
  type KnowledgeStore,
  type KnowledgeStoreKeyProvider,
} from "../store.js";
import { searchVectorsForScope } from "./scoped-vector-search.js";
import { scriptedAdapter, seedCapsuleWithVectors } from "./_support.js";

const FIXED_KEY = new Uint8Array(32).fill(7);

const keyProvider: KnowledgeStoreKeyProvider = {
  providerId: "test-fixed-key",
  resolveKey: (): Uint8Array => FIXED_KEY,
};

interface OpenedStore {
  readonly store: KnowledgeStore;
  readonly close: () => void;
}

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    fn?.();
  }
  vi.restoreAllMocks();
});

function openEncryptedStore(dbPath: string): OpenedStore {
  const store = openKnowledgeStore({
    dbPath,
    protection: { mode: "encrypted-key-provider", keyProvider },
  });
  const opened: OpenedStore = {
    store,
    close: (): void => {
      store.close();
    },
  };
  cleanups.push(opened.close);
  return opened;
}

function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "keiko-lk-cache-"));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return join(dir, "capsules.db");
}

async function runSearch(store: KnowledgeStore, capsuleId: KnowledgeCapsuleId): Promise<number> {
  const outcome = await searchVectorsForScope(
    store,
    scriptedAdapter(),
    { capsuleIds: [capsuleId] },
    "query",
    { topK: 10 },
  );
  return outcome.references.length;
}

describe("scoped-vector-search decoded-vector cache (GEN-PERF-CHAT-004)", () => {
  it("does not re-decrypt vectors on a second store opened at the same dbPath", async () => {
    const dbPath = freshDbPath();

    // Request 1: seed + search on a fresh store, then close it (mirrors close-in-finally).
    const first = openEncryptedStore(dbPath);
    const seeded = await seedCapsuleWithVectors(first.store, { capsuleId: "cap-cache" });
    expect(seeded.chunkIds.length).toBeGreaterThan(0);
    const firstCount = await runSearch(first.store, seeded.capsuleId);
    expect(firstCount).toBeGreaterThan(0);
    first.close();
    cleanups.splice(cleanups.indexOf(first.close), 1);

    // Request 2: brand-new store object at the SAME dbPath — the real per-request pattern.
    const second = openEncryptedStore(dbPath);
    const openVectorSpy = vi.spyOn(second.store._internal.contentCipher, "openVector");
    const secondCount = await runSearch(second.store, seeded.capsuleId);

    // Behaviour preserved: identical result count.
    expect(secondCount).toBe(firstCount);
    // The load-bearing assertion: ZERO vector decrypts on the second request because the
    // decoded set is served from the dbPath-keyed cache. Pre-fix (WeakMap by store
    // identity) this spy fired once per seeded chunk row.
    expect(openVectorSpy).toHaveBeenCalledTimes(0);
  });

  it("re-decrypts after a content-stamp change (conservative invalidation preserved)", async () => {
    const dbPath = freshDbPath();

    const first = openEncryptedStore(dbPath);
    const seeded = await seedCapsuleWithVectors(first.store, { capsuleId: "cap-cache-inv" });
    await runSearch(first.store, seeded.capsuleId);
    first.close();
    cleanups.splice(cleanups.indexOf(first.close), 1);

    // Mutate a vector row's created_at → the capsule content stamp (n, max_created_at)
    // changes, so the inner cache key changes and a fresh decode MUST occur. This proves
    // any indexing write invalidates the cache (no stale plaintext served).
    const second = openEncryptedStore(dbPath);
    second.store._internal.db
      .prepare("UPDATE vectors SET created_at = created_at + 1000 WHERE capsule_id = :c")
      .run({ c: String(seeded.capsuleId) });

    const openVectorSpy = vi.spyOn(second.store._internal.contentCipher, "openVector");
    const count = await runSearch(second.store, seeded.capsuleId);
    expect(count).toBeGreaterThan(0);
    // Stamp changed → cache miss → each seeded row re-decrypted exactly once.
    expect(openVectorSpy).toHaveBeenCalledTimes(seeded.chunkIds.length);
  });

  it("keeps in-memory stores isolated (no cross-store aliasing)", async () => {
    // Two independent encrypted stores at DIFFERENT dbPaths must not share decoded vectors
    // — the dbPath key namespaces them. A search on store B must decode B's own rows.
    const seededCap = "cap-iso" as KnowledgeCapsuleId;
    const a = openEncryptedStore(freshDbPath());
    const seededA = await seedCapsuleWithVectors(a.store, { capsuleId: seededCap });
    await runSearch(a.store, seededA.capsuleId);

    const b = openEncryptedStore(freshDbPath());
    await seedCapsuleWithVectors(b.store, { capsuleId: seededCap });
    const openVectorSpyB = vi.spyOn(b.store._internal.contentCipher, "openVector");
    const countB = await runSearch(b.store, seededCap);
    expect(countB).toBeGreaterThan(0);
    // B is a distinct dbPath → its rows were never cached → decode fires for B's rows.
    expect(openVectorSpyB.mock.calls.length).toBeGreaterThan(0);
  });
});
