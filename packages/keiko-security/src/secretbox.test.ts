import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { isSealed, openBytes, openString, sealBytes, sealString } from "./secretbox.js";
import { SecretboxError } from "./errors/secretbox.js";

function key(): Buffer {
  return randomBytes(32);
}

describe("sealString / openString", () => {
  it("round-trips a string under the same key", () => {
    const k = key();
    const plaintext = "prefers dark mode — confidential body";
    const envelope = sealString(k, plaintext);
    expect(openString(k, envelope)).toBe(plaintext);
  });

  it("produces an envelope with the kv1 prefix and three dot-separated parts", () => {
    const envelope = sealString(key(), "x");
    const parts = envelope.split(".");
    expect(parts[0]).toBe("kv1");
    expect(parts).toHaveLength(3);
  });

  it("round-trips empty string and unicode", () => {
    const k = key();
    expect(openString(k, sealString(k, ""))).toBe("");
    const unicode = "café — 日本語 — 🔐";
    expect(openString(k, sealString(k, unicode))).toBe(unicode);
  });

  it("uses a fresh nonce per call (two seals of the same plaintext differ)", () => {
    const k = key();
    const a = sealString(k, "same");
    const b = sealString(k, "same");
    expect(a).not.toBe(b);
    const nonceA = a.split(".")[1];
    const nonceB = b.split(".")[1];
    expect(nonceA).not.toBe(nonceB);
  });

  it("throws SecretboxError when opened with the wrong key", () => {
    const envelope = sealString(key(), "secret");
    expect(() => openString(key(), envelope)).toThrow(SecretboxError);
  });

  it("throws SecretboxError when the ciphertext is tampered", () => {
    const k = key();
    const [prefix, nonce, ctPart] = sealString(k, "secret").split(".");
    const ct = Buffer.from(ctPart ?? "", "base64url");
    ct[0] = (ct[0] ?? 0) ^ 0xff; // flip a bit in the ciphertext
    const tampered = `${prefix ?? ""}.${nonce ?? ""}.${ct.toString("base64url")}`;
    expect(() => openString(k, tampered)).toThrow(SecretboxError);
  });

  it("throws SecretboxError on a malformed envelope (wrong prefix)", () => {
    expect(() => openString(key(), "nope.aaaa.bbbb")).toThrow(SecretboxError);
  });

  it("throws SecretboxError on a malformed envelope (too few parts)", () => {
    expect(() => openString(key(), "kv1.onlytwo")).toThrow(SecretboxError);
  });

  it("throws SecretboxError when the nonce is the wrong length", () => {
    const k = key();
    const [prefix, , ctPart] = sealString(k, "x").split(".");
    const shortNonce = Buffer.alloc(8).toString("base64url");
    const envelope = `${prefix ?? ""}.${shortNonce}.${ctPart ?? ""}`;
    expect(() => openString(k, envelope)).toThrow(SecretboxError);
  });
});

describe("sealBytes / openBytes", () => {
  it("round-trips a binary buffer", () => {
    const k = key();
    const buf = randomBytes(512);
    const sealed = sealBytes(k, buf);
    expect(sealed.equals(buf)).toBe(false);
    expect(openBytes(k, sealed).equals(buf)).toBe(true);
  });

  it("round-trips an empty buffer", () => {
    const k = key();
    const sealed = sealBytes(k, Buffer.alloc(0));
    expect(openBytes(k, sealed).length).toBe(0);
  });

  it("prefixes the binary envelope with version byte 0x01", () => {
    const sealed = sealBytes(key(), Buffer.from([1, 2, 3]));
    expect(sealed[0]).toBe(0x01);
  });

  it("uses a fresh nonce per call (two seals of the same bytes differ)", () => {
    const k = key();
    const a = sealBytes(k, Buffer.from([9, 9, 9]));
    const b = sealBytes(k, Buffer.from([9, 9, 9]));
    expect(a.equals(b)).toBe(false);
  });

  it("throws SecretboxError when opened with the wrong key", () => {
    const sealed = sealBytes(key(), randomBytes(32));
    expect(() => openBytes(key(), sealed)).toThrow(SecretboxError);
  });

  it("throws SecretboxError when the binary envelope is tampered", () => {
    const k = key();
    const sealed = sealBytes(k, randomBytes(32));
    sealed[sealed.length - 1] = (sealed[sealed.length - 1] ?? 0) ^ 0xff;
    expect(() => openBytes(k, sealed)).toThrow(SecretboxError);
  });

  it("throws SecretboxError on an unknown version byte", () => {
    const k = key();
    const sealed = sealBytes(k, Buffer.from([1]));
    sealed[0] = 0x02;
    expect(() => openBytes(k, sealed)).toThrow(SecretboxError);
  });

  it("throws SecretboxError when the binary envelope is too short", () => {
    expect(() => openBytes(key(), Buffer.from([0x01, 0x00]))).toThrow(SecretboxError);
  });
});

describe("isSealed", () => {
  it("detects a sealed string by its kv1 prefix", () => {
    expect(isSealed(sealString(key(), "x"))).toBe(true);
  });

  it("returns false for legacy plaintext", () => {
    expect(isSealed("plain body text")).toBe(false);
    expect(isSealed("")).toBe(false);
    expect(isSealed("kv1")).toBe(false);
    expect(isSealed("kv1x.a.b")).toBe(false);
  });
});
