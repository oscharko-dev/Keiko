import { describe, expect, it } from "vitest";

import { isStoreFingerprint, type StoreFingerprint } from "./store-fingerprint.js";

function validFingerprint(): StoreFingerprint {
  return {
    store: "local-knowledge",
    schemaVersion: 7,
    migrationsApplied: ["0001-initial", "0002-add-index"],
    tableRowCounts: { documents: 12, chunks: 480 },
    quickCheckOk: true,
    encryptionMode: "encrypted",
    keySource: "keychain",
  };
}

describe("isStoreFingerprint", () => {
  it("accepts a fully-populated, valid fingerprint", () => {
    expect(isStoreFingerprint(validFingerprint())).toBe(true);
  });

  it("accepts a valid fingerprint with keySource omitted (plaintext store)", () => {
    // exactOptionalPropertyTypes forbids `keySource: undefined`; destructure-to-exclude instead.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { keySource: _keySource, ...rest } = validFingerprint();
    expect(isStoreFingerprint({ ...rest, encryptionMode: "plaintext" })).toBe(true);
  });

  it("accepts every closed-vocabulary store value", () => {
    for (const store of ["ui", "local-knowledge", "memory-vault"] as const) {
      expect(isStoreFingerprint({ ...validFingerprint(), store })).toBe(true);
    }
  });

  it("accepts every closed-vocabulary encryptionMode value paired with a consistent keySource", () => {
    for (const encryptionMode of ["encrypted", "migrating"] as const) {
      expect(isStoreFingerprint({ ...validFingerprint(), encryptionMode })).toBe(true);
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { keySource: _keySource, ...rest } = validFingerprint();
    expect(isStoreFingerprint({ ...rest, encryptionMode: "plaintext" })).toBe(true);
  });

  it("accepts every closed-vocabulary keySource value", () => {
    for (const keySource of ["env", "keychain", "keyfile"] as const) {
      expect(isStoreFingerprint({ ...validFingerprint(), keySource })).toBe(true);
    }
  });

  it("rejects a plaintext fingerprint that still carries a keySource", () => {
    // A `"plaintext"` store never resolved a key, so `keySource` riding along on it is the exact
    // contradictory state `encryptionMode`'s own doc comment rules out.
    expect(
      isStoreFingerprint({
        ...validFingerprint(),
        encryptionMode: "plaintext",
        keySource: "keychain",
      }),
    ).toBe(false);
  });

  it("rejects a non-object, null, and an array", () => {
    expect(isStoreFingerprint(undefined)).toBe(false);
    expect(isStoreFingerprint(null)).toBe(false);
    expect(isStoreFingerprint("not an object")).toBe(false);
    expect(isStoreFingerprint([validFingerprint()])).toBe(false);
  });

  it("rejects an unknown store, encryptionMode, or keySource value", () => {
    expect(isStoreFingerprint({ ...validFingerprint(), store: "vector-db" })).toBe(false);
    expect(isStoreFingerprint({ ...validFingerprint(), encryptionMode: "unknown" })).toBe(false);
    expect(isStoreFingerprint({ ...validFingerprint(), keySource: "hsm" })).toBe(false);
  });

  it("rejects a non-integer, negative, or non-finite schemaVersion", () => {
    expect(isStoreFingerprint({ ...validFingerprint(), schemaVersion: 1.5 })).toBe(false);
    expect(isStoreFingerprint({ ...validFingerprint(), schemaVersion: -1 })).toBe(false);
    expect(isStoreFingerprint({ ...validFingerprint(), schemaVersion: Number.NaN })).toBe(false);
    expect(isStoreFingerprint({ ...validFingerprint(), schemaVersion: Infinity })).toBe(false);
  });

  it("rejects a migrationsApplied entry that is not a bounded identifier", () => {
    expect(
      isStoreFingerprint({
        ...validFingerprint(),
        migrationsApplied: ["a whole sentence with spaces"],
      }),
    ).toBe(false);
    expect(isStoreFingerprint({ ...validFingerprint(), migrationsApplied: ["0001", 42] })).toBe(
      false,
    );
    expect(
      isStoreFingerprint({
        ...validFingerprint(),
        migrationsApplied: Array.from({ length: 513 }, (_unused, index) => `m${String(index)}`),
      }),
    ).toBe(false);
  });

  it("rejects a tableRowCounts entry with a bad table name or a bad count", () => {
    expect(
      isStoreFingerprint({
        ...validFingerprint(),
        tableRowCounts: { "not a valid table name": 1 },
      }),
    ).toBe(false);
    expect(isStoreFingerprint({ ...validFingerprint(), tableRowCounts: { documents: -1 } })).toBe(
      false,
    );
    expect(isStoreFingerprint({ ...validFingerprint(), tableRowCounts: { documents: 1.5 } })).toBe(
      false,
    );
    expect(
      isStoreFingerprint({ ...validFingerprint(), tableRowCounts: { documents: Number.NaN } }),
    ).toBe(false);
  });

  it("rejects tableRowCounts given as an array instead of a record", () => {
    expect(isStoreFingerprint({ ...validFingerprint(), tableRowCounts: [1, 2, 3] })).toBe(false);
  });

  it("rejects a non-boolean quickCheckOk", () => {
    expect(isStoreFingerprint({ ...validFingerprint(), quickCheckOk: 1 })).toBe(false);
  });

  it("rejects an unexpected field riding along on an otherwise-valid fingerprint", () => {
    expect(isStoreFingerprint({ ...validFingerprint(), extra: "smuggled" })).toBe(false);
  });

  it("rejects an object missing a required field", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { store: _store, ...withoutStore } = validFingerprint();
    expect(isStoreFingerprint(withoutStore)).toBe(false);
  });

  it("fails closed instead of throwing when top-level key enumeration is hostile", () => {
    const hostile = new Proxy(
      { ...validFingerprint() },
      {
        ownKeys(): never {
          throw new Error("hostile ownKeys trap");
        },
      },
    );
    expect(isStoreFingerprint(hostile)).toBe(false);
  });

  it("fails closed instead of throwing when a required field getter is hostile", () => {
    const hostile = new Proxy(
      { ...validFingerprint() },
      {
        get(target: object, prop: string | symbol, receiver: unknown): unknown {
          if (prop === "store") throw new Error("hostile store getter");
          return Reflect.get(target, prop, receiver);
        },
      },
    );
    expect(isStoreFingerprint(hostile)).toBe(false);
  });

  it("fails closed instead of throwing when tableRowCounts enumeration is hostile", () => {
    const hostileTableRowCounts = new Proxy(
      {},
      {
        ownKeys(): never {
          throw new Error("hostile nested ownKeys trap");
        },
      },
    );
    expect(
      isStoreFingerprint({ ...validFingerprint(), tableRowCounts: hostileTableRowCounts }),
    ).toBe(false);
  });
});
