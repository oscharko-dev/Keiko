// Unit coverage for the store content cipher (Issue #1322; ADR-0047). Verifies round-trips, legacy
// plaintext tolerance, plaintext-vs-sealed detection, and fail-loud behavior on a wrong key — the
// invariants the row layer relies on.

import { describe, expect, it } from "vitest";

import { KnowledgeStoreError } from "./errors.js";
import { createEncryptedContentCipher, PLAINTEXT_CONTENT_CIPHER } from "./store-content-cipher.js";

const KEY_A = new Uint8Array(32).fill(11);
const KEY_B = new Uint8Array(32).fill(22);

describe("PLAINTEXT_CONTENT_CIPHER", () => {
  it("is an identity cipher that reports it is not encrypted", () => {
    expect(PLAINTEXT_CONTENT_CIPHER.isEncrypted).toBe(false);
    expect(PLAINTEXT_CONTENT_CIPHER.sealText("hello")).toBe("hello");
    expect(PLAINTEXT_CONTENT_CIPHER.openText("hello")).toBe("hello");
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(PLAINTEXT_CONTENT_CIPHER.sealVector(bytes)).toBe(bytes);
    expect(PLAINTEXT_CONTENT_CIPHER.openVector(bytes, 4)).toBe(bytes);
    expect(PLAINTEXT_CONTENT_CIPHER.isSealed("hello")).toBe(false);
  });
});

describe("createEncryptedContentCipher", () => {
  it("rejects a key that is not 32 bytes", () => {
    expect(() => createEncryptedContentCipher(new Uint8Array(16))).toThrow(KnowledgeStoreError);
    expect(() => createEncryptedContentCipher(new Uint8Array(16))).toThrow(/exactly 32 bytes/);
  });

  it("round-trips text through seal/open and marks the envelope sealed", () => {
    const cipher = createEncryptedContentCipher(KEY_A);
    const plaintext = "vertrauliches Fachkonzept — Zürich, Größe 42";
    const sealed = cipher.sealText(plaintext);
    expect(sealed).not.toBe(plaintext);
    expect(cipher.isSealed(sealed)).toBe(true);
    expect(cipher.openText(sealed)).toBe(plaintext);
  });

  it("openText tolerates legacy plaintext by returning it verbatim", () => {
    const cipher = createEncryptedContentCipher(KEY_A);
    expect(cipher.openText("not-sealed-legacy-text")).toBe("not-sealed-legacy-text");
  });

  it("round-trips a vector and never alters the plaintext byte layout", () => {
    const cipher = createEncryptedContentCipher(KEY_A);
    const vector = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253]);
    const sealed = cipher.sealVector(vector);
    expect(sealed.byteLength).toBeGreaterThan(vector.byteLength);
    const opened = cipher.openVector(sealed, vector.byteLength);
    expect(Array.from(opened)).toEqual(Array.from(vector));
  });

  it("openVector returns legacy plaintext bytes when the stored length matches the plaintext length", () => {
    const cipher = createEncryptedContentCipher(KEY_A);
    const plaintextVector = new Uint8Array([9, 8, 7, 6]);
    expect(cipher.openVector(plaintextVector, plaintextVector.byteLength)).toBe(plaintextVector);
  });

  it("throws on a wrong-key text open (no silent plaintext)", () => {
    const sealed = createEncryptedContentCipher(KEY_A).sealText("secret");
    expect(() => createEncryptedContentCipher(KEY_B).openText(sealed)).toThrow();
  });

  it("throws on a wrong-key vector open", () => {
    const vector = new Uint8Array([1, 2, 3, 4]);
    const sealed = createEncryptedContentCipher(KEY_A).sealVector(vector);
    expect(() =>
      createEncryptedContentCipher(KEY_B).openVector(sealed, vector.byteLength),
    ).toThrow();
  });

  it("copies the key so a later mutation of the caller's array cannot change it", () => {
    const mutableKey = new Uint8Array(32).fill(5);
    const cipher = createEncryptedContentCipher(mutableKey);
    const sealed = cipher.sealText("pinned");
    mutableKey.fill(99);
    expect(cipher.openText(sealed)).toBe("pinned");
  });
});
