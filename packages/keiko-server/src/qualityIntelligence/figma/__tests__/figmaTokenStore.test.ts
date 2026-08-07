import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NO_FIGMA_KEYCHAIN,
  createFigmaTokenStore,
  keyFromKeychain,
  resolveFigmaVaultKey,
} from "../figmaTokenStore.js";
import { FigmaConnectorError } from "../figmaConnectorErrors.js";

const TOKEN = "figd_unit-test-secret-pat-value-9f3a";
const ROTATED = "figd_rotated-pat-value-abcd-1234";
const KEY = Buffer.alloc(32, 7);
const REAL_TMPDIR = realpathSync(tmpdir());

let dir: string;
const keychainFakes: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(REAL_TMPDIR, "figma-vault-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const fake of keychainFakes.splice(0)) rmSync(fake, { recursive: true, force: true });
});

const storeAt = (): ReturnType<typeof createFigmaTokenStore> =>
  createFigmaTokenStore({ key: KEY, storePath: join(dir, "figma-token.enc") });

function expectFigmaInternal(action: () => void): void {
  try {
    action();
    throw new Error("expected FigmaConnectorError");
  } catch (error) {
    expect(error).toBeInstanceOf(FigmaConnectorError);
    expect((error as FigmaConnectorError).code).toBe("FIGMA_INTERNAL");
  }
}

function expectPrivateModeIfSupported(
  path: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "win32") {
    expect(existsSync(path)).toBe(true);
    return;
  }
  expect(statSync(path).mode & 0o777).toBe(0o600);
}

describe("createFigmaTokenStore round-trip", () => {
  it("stores then reads back the exact token", () => {
    const store = storeAt();
    store.store(TOKEN);
    expect(store.read()).toBe(TOKEN);
  });

  it("returns undefined when no entry has been written", () => {
    expect(storeAt().read()).toBeUndefined();
  });

  it("returns undefined (not throw) when the stored file is not a sealed kv1 envelope", () => {
    // Pins the `!isSealed(envelope)` guard: a mutant dropping it would call openString() on a
    // non-sealed string and throw, breaking the "no entry → undefined" contract.
    const storePath = join(dir, "figma-token.enc");
    writeFileSync(storePath, "plaintext-not-a-kv1-envelope");
    expect(createFigmaTokenStore({ key: KEY, storePath }).read()).toBeUndefined();
  });

  it("returns undefined (not throw) when the stored file is empty", () => {
    // Pins the `envelope.length === 0` guard against a mutant that removes it.
    const storePath = join(dir, "figma-token.enc");
    writeFileSync(storePath, "");
    expect(createFigmaTokenStore({ key: KEY, storePath }).read()).toBeUndefined();
  });

  it("never writes the plaintext token to disk", () => {
    const storePath = join(dir, "figma-token.enc");
    createFigmaTokenStore({ key: KEY, storePath }).store(TOKEN);
    const raw = readFileSync(storePath);
    expect(raw.includes(Buffer.from(TOKEN, "utf8"))).toBe(false);
    expect(raw.toString("utf8").startsWith("kv1.")).toBe(true);
  });

  it("writes the store file with 0600 permissions", () => {
    const storePath = join(dir, "figma-token.enc");
    createFigmaTokenStore({ key: KEY, storePath }).store(TOKEN);
    expectPrivateModeIfSupported(storePath);
  });

  it("defers file permissions to inherited ACLs on Windows", () => {
    const storePath = join(dir, "figma-token.enc");
    createFigmaTokenStore({ key: KEY, storePath }).store(TOKEN);
    expectPrivateModeIfSupported(storePath, "win32");
  });
});

describe("rotation-by-replacement", () => {
  it("overwrites the previous token in place with no second entry", () => {
    const storePath = join(dir, "figma-token.enc");
    const store = createFigmaTokenStore({ key: KEY, storePath });
    store.store(TOKEN);
    store.store(ROTATED);
    expect(store.read()).toBe(ROTATED);
    const raw = readFileSync(storePath);
    expect(raw.includes(Buffer.from(TOKEN, "utf8"))).toBe(false);
    expect(
      raw
        .toString("utf8")
        .split("\n")
        .filter((l) => l.length > 0),
    ).toHaveLength(1);
  });
});

describe("revocation by removal", () => {
  it("removes the entry so read() is undefined", () => {
    const store = storeAt();
    store.store(TOKEN);
    store.revoke();
    expect(store.read()).toBeUndefined();
  });

  it("is idempotent when no entry exists", () => {
    const store = storeAt();
    expect(() => {
      store.revoke();
    }).not.toThrow();
  });
});

describe("resolveFigmaVaultKey precedence", () => {
  it("uses KEIKO_FIGMA_KEY when present (env tier wins)", () => {
    const raw = Buffer.alloc(32, 5).toString("base64");
    const resolved = resolveFigmaVaultKey({ KEIKO_FIGMA_KEY: raw }, dir, NO_FIGMA_KEYCHAIN);
    expect(resolved.source).toBe("env");
    expect(resolved.key.equals(Buffer.alloc(32, 5))).toBe(true);
  });

  it("rejects a malformed env key (not 32 bytes)", () => {
    expect(() =>
      resolveFigmaVaultKey({ KEIKO_FIGMA_KEY: "deadbeef" }, dir, NO_FIGMA_KEYCHAIN),
    ).toThrow();
  });

  it("falls back to a generated 0600 keyfile when no env/keychain key", () => {
    const resolved = resolveFigmaVaultKey({}, dir, NO_FIGMA_KEYCHAIN);
    expect(resolved.source).toBe("keyfile");
    expect(resolved.key).toHaveLength(32);
    const keyfile = join(dir, "figma-vault.key");
    expectPrivateModeIfSupported(keyfile);
  });

  it("reuses the same keyfile on a second resolve", () => {
    const a = resolveFigmaVaultKey({}, dir, NO_FIGMA_KEYCHAIN);
    const b = resolveFigmaVaultKey({}, dir, NO_FIGMA_KEYCHAIN);
    expect(a.key.equals(b.key)).toBe(true);
  });

  it("prefers the keychain tier over the keyfile when available", () => {
    const fromKeychain = Buffer.alloc(32, 9);
    const resolved = resolveFigmaVaultKey({}, dir, () => fromKeychain);
    expect(resolved.source).toBe("keychain");
    expect(resolved.key.equals(fromKeychain)).toBe(true);
  });

  it("falls through to the keyfile when the keychain never answers", () => {
    // Proves this surface really is wired to the bounded shared owner, not just that the owner is
    // bounded: a `security` that returns nothing until a human acts must not stall the caller.
    const fakeDir = mkdtempSync(join(REAL_TMPDIR, "keiko-figma-keychain-"));
    try {
      const hangs = join(fakeDir, "security");
      writeFileSync(hangs, "#!/bin/sh\nsleep 30\n");
      chmodSync(hangs, 0o700);

      const started = process.hrtime.bigint();
      const resolved = resolveFigmaVaultKey({}, dir, () =>
        keyFromKeychain({ executable: hangs, timeoutMs: 250, platform: "darwin" }),
      );

      // Against the previous unbounded spawn this blocks and fails on the suite timeout. The 20x
      // margin between the 250ms bound and this 5s ceiling keeps it insensitive to scheduling.
      expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(5_000);
      expect(resolved.source).toBe("keyfile");
      expect(resolved.key).toHaveLength(32);
    } finally {
      rmSync(fakeDir, { recursive: true, force: true });
    }
  }, 15_000);

  // A stand-in for `/usr/bin/security` covering both subcommands the tier uses. `find` answers with
  // `found`, or exits 44 (errSecItemNotFound, measured against the shipped binary) when `found` is
  // empty; `add` consumes the piped secret and reports the given status.
  function fakeSecurity(found: string, addStatus = 0): string {
    const scriptDir = mkdtempSync(join(REAL_TMPDIR, "keiko-figma-tier-"));
    keychainFakes.push(scriptDir);
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

  it("uses a stored keychain key in preference to a keyfile", () => {
    const stored = Buffer.alloc(32, 3);
    const resolved = resolveFigmaVaultKey({}, dir, () =>
      keyFromKeychain({ executable: fakeSecurity(stored.toString("base64")), platform: "darwin" }),
    );
    expect(resolved.source).toBe("keychain");
    expect(resolved.key.equals(stored)).toBe(true);
  });

  it("replaces a stored value that does not decode to 32 bytes", () => {
    const resolved = resolveFigmaVaultKey({}, dir, () =>
      keyFromKeychain({ executable: fakeSecurity("not-a-32-byte-key"), platform: "darwin" }),
    );
    expect(resolved.source).toBe("keychain");
    expect(resolved.key).toHaveLength(32);
  });

  it("generates and stores a key when the keychain has none", () => {
    const resolved = resolveFigmaVaultKey({}, dir, () =>
      keyFromKeychain({ executable: fakeSecurity(""), platform: "darwin" }),
    );
    expect(resolved.source).toBe("keychain");
    expect(resolved.key).toHaveLength(32);
  });

  it("falls through to the keyfile when the keychain has none and will not store one", () => {
    const resolved = resolveFigmaVaultKey({}, dir, () =>
      keyFromKeychain({ executable: fakeSecurity("", 1), platform: "darwin" }),
    );
    expect(resolved.source).toBe("keyfile");
    expect(resolved.key).toHaveLength(32);
  });

  it("prefers the env key over the keychain tier when both are present", () => {
    // The env-tier test above injects NO_FIGMA_KEYCHAIN, so it cannot prove env BEATS keychain.
    // Provide BOTH a valid env key and a DIFFERENT keychain key: a mutant that checks keychain
    // before env would resolve source==='keychain' with the keychain key and fail here.
    const envKey = Buffer.alloc(32, 5);
    const keychainKey = Buffer.alloc(32, 9);
    const resolved = resolveFigmaVaultKey(
      { KEIKO_FIGMA_KEY: envKey.toString("base64") },
      dir,
      () => keychainKey,
    );
    expect(resolved.source).toBe("env");
    expect(resolved.key.equals(envKey)).toBe(true);
  });

  it("rejects a keyfile path through a symlinked directory segment", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const realSub = join(dir, "real-key-dir");
    mkdirSync(realSub);
    const linkSub = join(dir, "link-key-dir");
    symlinkSync(realSub, linkSub);

    expectFigmaInternal(() => {
      resolveFigmaVaultKey({}, linkSub, NO_FIGMA_KEYCHAIN);
    });
  });

  it("rejects a final keyfile path that is itself a symlink", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    writeFileSync(join(dir, "real-figma-vault.key"), Buffer.alloc(32, 4).toString("base64"));
    symlinkSync(join(dir, "real-figma-vault.key"), join(dir, "figma-vault.key"));

    expectFigmaInternal(() => {
      resolveFigmaVaultKey({}, dir, NO_FIGMA_KEYCHAIN);
    });
  });
});

describe("symlink guard", () => {
  it("rejects store/read/revoke through a symlinked directory segment", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const realSub = join(dir, "real-store-dir");
    mkdirSync(realSub);
    const linkSub = join(dir, "link-store-dir");
    symlinkSync(realSub, linkSub);

    const store = createFigmaTokenStore({ key: KEY, storePath: join(linkSub, "figma-token.enc") });

    expectFigmaInternal(() => {
      store.store(TOKEN);
    });
    expectFigmaInternal(() => {
      store.read();
    });
    expectFigmaInternal(() => {
      store.revoke();
    });
  });

  it("rejects a final store path that is itself a symlink", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const realStorePath = join(dir, "real-figma-token.enc");
    createFigmaTokenStore({ key: KEY, storePath: realStorePath }).store(TOKEN);
    const linkStorePath = join(dir, "link-figma-token.enc");
    symlinkSync(realStorePath, linkStorePath);

    const store = createFigmaTokenStore({ key: KEY, storePath: linkStorePath });

    expectFigmaInternal(() => {
      store.read();
    });
    expectFigmaInternal(() => {
      store.store(ROTATED);
    });
    expectFigmaInternal(() => {
      store.revoke();
    });
  });
});

describe("no token leakage", () => {
  it("never includes the token in a thrown error from a tampered envelope", () => {
    const storePath = join(dir, "figma-token.enc");
    createFigmaTokenStore({ key: KEY, storePath }).store(TOKEN);
    const wrongKey = Buffer.alloc(32, 1);
    const reader = createFigmaTokenStore({ key: wrongKey, storePath });
    try {
      reader.read();
      throw new Error("expected read() to throw on wrong key");
    } catch (error) {
      expect(String(error)).not.toContain(TOKEN);
    }
  });
});
