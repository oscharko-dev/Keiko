import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createMemoryContentCipher, NO_KEYCHAIN, resolveVaultKey } from "./cipher.js";
import { MemoryStorageError } from "./errors.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keiko-cipher-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveVaultKey — env tier", () => {
  it("uses KEIKO_MEMORY_KEY when it decodes to 32 bytes", () => {
    const raw = randomBytes(32);
    const env = { KEIKO_MEMORY_KEY: raw.toString("base64") };
    const resolved = resolveVaultKey(env, dir);
    expect(resolved.source).toBe("env");
    expect(resolved.key.equals(raw)).toBe(true);
  });

  it("throws when KEIKO_MEMORY_KEY decodes to the wrong length", () => {
    const env = { KEIKO_MEMORY_KEY: randomBytes(16).toString("base64") };
    expect(() => resolveVaultKey(env, dir)).toThrow(MemoryStorageError);
  });

  it("throws when KEIKO_MEMORY_KEY is not valid base64 of 32 bytes", () => {
    const env = { KEIKO_MEMORY_KEY: "not-a-real-key" };
    expect(() => resolveVaultKey(env, dir)).toThrow(MemoryStorageError);
  });

  it("env tier wins over the keyfile tier", () => {
    const raw = randomBytes(32);
    resolveVaultKey({}, dir, NO_KEYCHAIN); // materialise a keyfile first
    const resolved = resolveVaultKey({ KEIKO_MEMORY_KEY: raw.toString("base64") }, dir);
    expect(resolved.source).toBe("env");
    expect(resolved.key.equals(raw)).toBe(true);
  });
});

describe("resolveVaultKey — keyfile tier", () => {
  it("generates a 32-byte keyfile at 0600 on first use", () => {
    const resolved = resolveVaultKey({}, dir, NO_KEYCHAIN);
    expect(resolved.source).toBe("keyfile");
    expect(resolved.key.length).toBe(32);
    const keyfile = join(dir, "vault.key");
    const decoded = Buffer.from(readFileSync(keyfile, "utf8").trim(), "base64");
    expect(decoded.equals(resolved.key)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(keyfile).mode & 0o777).toBe(0o600);
    }
  });

  it("reuses the same key on the second call (stable across opens)", () => {
    const first = resolveVaultKey({}, dir, NO_KEYCHAIN);
    const second = resolveVaultKey({}, dir, NO_KEYCHAIN);
    expect(second.source).toBe("keyfile");
    expect(second.key.equals(first.key)).toBe(true);
  });
});

describe("createMemoryContentCipher", () => {
  it("seals and opens a string bound to the resolved key", () => {
    const cipher = createMemoryContentCipher(randomBytes(32));
    const sealed = cipher.sealString("body text");
    expect(cipher.isSealed(sealed)).toBe(true);
    expect(cipher.openString(sealed)).toBe("body text");
  });

  it("openString passes legacy plaintext through unchanged (lazy migration)", () => {
    const cipher = createMemoryContentCipher(randomBytes(32));
    expect(cipher.openString("legacy plaintext body")).toBe("legacy plaintext body");
  });

  it("seals and opens binary buffers", () => {
    const cipher = createMemoryContentCipher(randomBytes(32));
    const buf = randomBytes(64);
    const sealed = cipher.sealBytes(buf);
    expect(sealed.equals(buf)).toBe(false);
    expect(cipher.openBytes(sealed).equals(buf)).toBe(true);
  });

  it("fails to open a string sealed under a different key", () => {
    const a = createMemoryContentCipher(randomBytes(32));
    const b = createMemoryContentCipher(randomBytes(32));
    const sealed = a.sealString("secret");
    expect(() => b.openString(sealed)).toThrow();
  });
});
