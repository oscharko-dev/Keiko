import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  createMemoryContentCipher,
  keyFromKeychain,
  NO_KEYCHAIN,
  resolveVaultKey,
} from "./cipher.js";
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
    expect(resolved.key).toHaveLength(32);
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

  it("falls through to the keyfile when the keychain never answers, instead of hanging the boot path", () => {
    // Stands in for `security` blocked on a macOS unlock dialog: it returns nothing until a human
    // acts. resolveVaultKey is on the server boot path, so an unbounded wait here is a start that
    // never completes — observed against the shipped portable app during the 0.3.0 rehearsal.
    const fakeDir = mkdtempSync(join(tmpdir(), "keiko-keychain-"));
    try {
      const hangs = join(fakeDir, "security");
      writeFileSync(hangs, "#!/bin/sh\nsleep 30\n");
      chmodSync(hangs, 0o700);

      const started = process.hrtime.bigint();
      const resolved = resolveVaultKey({}, dir, () =>
        keyFromKeychain({ executable: hangs, timeoutMs: 250, platform: "darwin" }),
      );
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

      // Against the previous unbounded spawn this blocks for 30s and fails on the suite timeout.
      // The elapsed-time assertion IS the proof; the 20x margin between the 250ms bound and this
      // 5s ceiling is what keeps it insensitive to runner scheduling.
      expect(elapsedMs).toBeLessThan(5_000);
      expect(resolved.source).toBe("keyfile");
      expect(resolved.key).toHaveLength(32);
    } finally {
      rmSync(fakeDir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("resolveVaultKey — keychain tier", () => {
  // A stand-in for `/usr/bin/security` covering both subcommands the tier uses. `find` answers with
  // `found`, or exits 44 (errSecItemNotFound, measured against the shipped binary) when `found` is
  // empty; `add` consumes the piped secret and reports the given status.
  function fakeSecurity(found: string, addStatus = 0): string {
    const scriptDir = mkdtempSync(join(tmpdir(), "keiko-keychain-tier-"));
    fakes.push(scriptDir);
    const path = join(scriptDir, "security");
    writeFileSync(
      path,
      [
        "#!/bin/sh",
        'case "$1" in',
        found.length > 0
          ? `find-generic-password) printf %s '${found}' ;;`
          : "find-generic-password) exit 44 ;;",
        `add-generic-password) cat > /dev/null; exit ${String(addStatus)} ;;`,
        "esac",
      ].join("\n"),
    );
    chmodSync(path, 0o700);
    return path;
  }

  const fakes: string[] = [];
  afterEach(() => {
    for (const f of fakes.splice(0)) rmSync(f, { recursive: true, force: true });
  });

  const stored = Buffer.alloc(32, 3);

  it("uses a stored keychain key in preference to a keyfile", () => {
    const security = fakeSecurity(stored.toString("base64"));
    const resolved = resolveVaultKey({}, dir, () =>
      keyFromKeychain({ executable: security, platform: "darwin" }),
    );
    expect(resolved.source).toBe("keychain");
    expect(resolved.key.equals(stored)).toBe(true);
  });

  it("replaces a stored value that does not decode to 32 bytes", () => {
    // Pre-existing behaviour, preserved: an undecodable stored key is regenerated rather than
    // bricking the vault. The generated key is what the caller receives.
    const security = fakeSecurity("not-a-32-byte-key");
    const resolved = resolveVaultKey({}, dir, () =>
      keyFromKeychain({ executable: security, platform: "darwin" }),
    );
    expect(resolved.source).toBe("keychain");
    expect(resolved.key).toHaveLength(32);
    expect(resolved.key.equals(stored)).toBe(false);
  });

  it("generates and stores a key on the first run, when the keychain has none", () => {
    const security = fakeSecurity("");
    const resolved = resolveVaultKey({}, dir, () =>
      keyFromKeychain({ executable: security, platform: "darwin" }),
    );
    expect(resolved.source).toBe("keychain");
    expect(resolved.key).toHaveLength(32);
  });

  it("falls through to the keyfile when the keychain has none and will not store one", () => {
    const security = fakeSecurity("", 1);
    const resolved = resolveVaultKey({}, dir, () =>
      keyFromKeychain({ executable: security, platform: "darwin" }),
    );
    expect(resolved.source).toBe("keyfile");
    expect(resolved.key).toHaveLength(32);
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
