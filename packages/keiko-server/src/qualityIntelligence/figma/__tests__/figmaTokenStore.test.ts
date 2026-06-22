import {
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
  resolveFigmaVaultKey,
} from "../figmaTokenStore.js";
import { FigmaConnectorError } from "../figmaConnectorErrors.js";

const TOKEN = "figd_unit-test-secret-pat-value-9f3a";
const ROTATED = "figd_rotated-pat-value-abcd-1234";
const KEY = Buffer.alloc(32, 7);
const REAL_TMPDIR = realpathSync(tmpdir());

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(REAL_TMPDIR, "figma-vault-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
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
    expect(statSync(storePath).mode & 0o777).toBe(0o600);
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
    expect(existsSync(keyfile)).toBe(true);
    expect(statSync(keyfile).mode & 0o777).toBe(0o600);
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

  it("rejects a keyfile path through a symlinked directory segment", () => {
    if (process.platform === "win32") return;
    const realSub = join(dir, "real-key-dir");
    mkdirSync(realSub);
    const linkSub = join(dir, "link-key-dir");
    symlinkSync(realSub, linkSub);

    expectFigmaInternal(() => {
      resolveFigmaVaultKey({}, linkSub, NO_FIGMA_KEYCHAIN);
    });
  });

  it("rejects a final keyfile path that is itself a symlink", () => {
    if (process.platform === "win32") return;
    writeFileSync(join(dir, "real-figma-vault.key"), Buffer.alloc(32, 4).toString("base64"));
    symlinkSync(join(dir, "real-figma-vault.key"), join(dir, "figma-vault.key"));

    expectFigmaInternal(() => {
      resolveFigmaVaultKey({}, dir, NO_FIGMA_KEYCHAIN);
    });
  });
});

describe("symlink guard", () => {
  it("rejects store/read/revoke through a symlinked directory segment", () => {
    if (process.platform === "win32") return;
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

  it("rejects a final store path that is itself a symlink", () => {
    if (process.platform === "win32") return;
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
