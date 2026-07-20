// ADR-0153 D2. These assertions read the pragma actually in force on a live connection rather than
// checking that the code intended to set it: a pin that silently failed to apply would leave the
// no-spill guarantee unmet while every call site still looked correct.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  openKnowledgeStore,
  type KnowledgeStore,
  type KnowledgeStoreProtectionOptions,
} from "./store.js";
import { pinTempStoreToMemory, tempStoreIsMemory } from "./store-temp-store.js";
import type { VectorIndexOptions } from "./retrieval/vector-index.js";

const SQLITE_TEMP_STORE_MEMORY = 2;

interface Fixture {
  readonly store: KnowledgeStore;
  readonly cleanup: () => void;
}

function readTempStore(store: KnowledgeStore): number | undefined {
  const row = store._internal.db.prepare("PRAGMA temp_store").get() as unknown as
    { readonly temp_store: number } | undefined;
  return row?.temp_store;
}

function encryptedProtection(): KnowledgeStoreProtectionOptions {
  return {
    mode: "encrypted-key-provider",
    keyProvider: {
      providerId: "temp-store-test-key",
      resolveKey: (): Uint8Array => new Uint8Array(32).fill(23),
    },
  };
}

// A vector runtime counts as configured only when an active mode is paired with a way to load it.
// An injected module is the hermetic form of that pairing; it never has to be loadable here, because
// `openKnowledgeStore` decides the pin from the configuration, not from a successful load.
function configuredVectorIndex(): VectorIndexOptions {
  return { mode: "sqlite-vec", sqliteVec: { load: (): void => undefined } };
}

function fixtureFor(
  vectorIndex?: VectorIndexOptions,
  protection?: KnowledgeStoreProtectionOptions,
): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "keiko-lk-temp-store-"));
  const store = openKnowledgeStore({
    dbPath: join(dir, "capsules.db"),
    ...(vectorIndex !== undefined ? { vectorIndex } : {}),
    ...(protection !== undefined ? { protection } : {}),
  });
  return {
    store,
    cleanup: (): void => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("temp-store placement", () => {
  it("pins TEMP storage to memory on a store that enables the vector index", () => {
    const fixture = fixtureFor(configuredVectorIndex());
    try {
      expect(readTempStore(fixture.store)).toBe(SQLITE_TEMP_STORE_MEMORY);
      expect(tempStoreIsMemory(fixture.store._internal.db)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it("pins TEMP storage on an encrypted vector-index store, which is where the invariant bites", () => {
    const fixture = fixtureFor(configuredVectorIndex(), encryptedProtection());
    try {
      expect(fixture.store._internal.contentCipher.isEncrypted).toBe(true);
      expect(readTempStore(fixture.store)).toBe(SQLITE_TEMP_STORE_MEMORY);
    } finally {
      fixture.cleanup();
    }
  });

  // The pin is scoped to stores that can build an index. Every other store keeps SQLite's default,
  // so this change cannot alter the memory profile of the stores that make up the shipped default.
  it("leaves TEMP storage at the SQLite default when no vector runtime is configured", () => {
    for (const vectorIndex of [
      undefined,
      { mode: "disabled" } as VectorIndexOptions,
      // An active mode with nothing to load is not a configured runtime.
      { mode: "sqlite-vec" } as VectorIndexOptions,
    ]) {
      const fixture = fixtureFor(vectorIndex);
      try {
        expect(readTempStore(fixture.store)).not.toBe(SQLITE_TEMP_STORE_MEMORY);
        expect(tempStoreIsMemory(fixture.store._internal.db)).toBe(false);
      } finally {
        fixture.cleanup();
      }
    }
  });

  it("reports the pin through tempStoreIsMemory once applied to a bare connection", () => {
    const dir = mkdtempSync(join(tmpdir(), "keiko-lk-temp-store-bare-"));
    const db = new DatabaseSync(join(dir, "bare.db"));
    try {
      expect(tempStoreIsMemory(db)).toBe(false);
      pinTempStoreToMemory(db);
      expect(tempStoreIsMemory(db)).toBe(true);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // An unreadable pragma is an unproven guarantee. Callers must not be able to mistake "could not
  // ask" for "yes".
  it("treats an unreadable pragma as unpinned", () => {
    const throwing = {
      prepare: (): never => {
        throw new Error("pragma unavailable");
      },
    } as unknown as DatabaseSync;
    expect(tempStoreIsMemory(throwing)).toBe(false);
  });
});
