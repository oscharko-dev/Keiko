import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecretboxError } from "./errors/secretbox.js";
import {
  NO_LOCAL_VAULT_KEYCHAIN,
  SecretVaultStoreError,
  createKeychainVaultKeyAccess,
  createLocalSecretVault,
  createShardedLocalSecretVault,
  readLocalVaultReferences,
  resolveLocalVaultKey,
} from "./secret-vault.js";

// A stable 32-byte key used for vault-CRUD tests — same pattern as figmaTokenStore.test.ts.
const KEY = Buffer.alloc(32, 7);

// On macOS /var/folders is a symlink to /private/var/folders. The vault's symlink guard
// (assertNoSymlinkedPathSegments) rejects paths through symlinks, so we resolve the real path of
// the system temp dir once here and use it for every test directory.
const REAL_TMPDIR = realpathSync(tmpdir());

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(REAL_TMPDIR, "secret-vault-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// resolveLocalVaultKey — key-precedence tests
// ---------------------------------------------------------------------------

describe("resolveLocalVaultKey — ENV tier", () => {
  it("decodes a valid base64-32-byte env var and returns source=env", () => {
    const raw = Buffer.alloc(32, 5).toString("base64");
    const resolved = resolveLocalVaultKey({
      env: { KEIKO_TEST_VAULT_KEY: raw },
      vaultDir: dir,
      envVarName: "KEIKO_TEST_VAULT_KEY",
      keychainService: "keiko-test-vault",
      keyfileName: "test-vault.key",
      keychainAccess: NO_LOCAL_VAULT_KEYCHAIN,
    });
    expect(resolved.source).toBe("env");
    expect(resolved.key.equals(Buffer.alloc(32, 5))).toBe(true);
  });

  it("throws when the env key base64 decodes to a length other than 32 bytes", () => {
    // 16 bytes of data — too short.
    const raw = Buffer.alloc(16, 3).toString("base64");
    expect(() =>
      resolveLocalVaultKey({
        env: { KEIKO_TEST_VAULT_KEY: raw },
        vaultDir: dir,
        envVarName: "KEIKO_TEST_VAULT_KEY",
        keychainService: "keiko-test-vault",
        keyfileName: "test-vault.key",
        keychainAccess: NO_LOCAL_VAULT_KEYCHAIN,
      }),
    ).toThrow("32 bytes");
  });
});

describe("resolveLocalVaultKey — KEYCHAIN tier", () => {
  it("returns source=keychain when env tier is absent and keychainAccess returns a key", () => {
    const keychainKey = Buffer.alloc(32, 9);
    const resolved = resolveLocalVaultKey({
      env: {},
      vaultDir: dir,
      envVarName: "KEIKO_TEST_VAULT_KEY",
      keychainService: "keiko-test-vault",
      keyfileName: "test-vault.key",
      keychainAccess: () => keychainKey,
    });
    expect(resolved.source).toBe("keychain");
    expect(resolved.key.equals(keychainKey)).toBe(true);
  });

  it("prefers env tier over keychain when both are present", () => {
    const envKey = Buffer.alloc(32, 5);
    const keychainKey = Buffer.alloc(32, 9);
    const resolved = resolveLocalVaultKey({
      env: { KEIKO_TEST_VAULT_KEY: envKey.toString("base64") },
      vaultDir: dir,
      envVarName: "KEIKO_TEST_VAULT_KEY",
      keychainService: "keiko-test-vault",
      keyfileName: "test-vault.key",
      keychainAccess: () => keychainKey,
    });
    expect(resolved.source).toBe("env");
    expect(resolved.key.equals(envKey)).toBe(true);
  });
});

describe("resolveLocalVaultKey — KEYFILE tier", () => {
  it("generates a keyfile and returns source=keyfile when env and keychain are absent", () => {
    const keyfileName = "test-vault.key";
    const resolved = resolveLocalVaultKey({
      env: {},
      vaultDir: dir,
      envVarName: "KEIKO_TEST_VAULT_KEY",
      keychainService: "keiko-test-vault",
      keyfileName,
      keychainAccess: NO_LOCAL_VAULT_KEYCHAIN,
    });
    expect(resolved.source).toBe("keyfile");

    const keyfilePath = join(dir, keyfileName);
    expect(existsSync(keyfilePath)).toBe(true);

    if (process.platform !== "win32") {
      expect(statSync(keyfilePath).mode & 0o777).toBe(0o600);
    }

    // The keyfile must base64-decode to exactly 32 bytes.
    const stored = Buffer.from(readFileSync(keyfilePath, "utf8").trim(), "base64");
    expect(stored).toHaveLength(32);
    expect(resolved.key.equals(stored)).toBe(true);
  });

  it("reuses the same keyfile key on a second resolveLocalVaultKey call", () => {
    const opts = {
      env: {},
      vaultDir: dir,
      envVarName: "KEIKO_TEST_VAULT_KEY",
      keychainService: "keiko-test-vault",
      keyfileName: "test-vault.key",
      keychainAccess: NO_LOCAL_VAULT_KEYCHAIN,
    } as const;
    const first = resolveLocalVaultKey(opts);
    const second = resolveLocalVaultKey(opts);
    expect(first.key.equals(second.key)).toBe(true);
  });

  it("rejects a keyfile path through a symlinked directory segment", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const realSub = join(dir, "real-key-dir");
    mkdirSync(realSub);
    const linkSub = join(dir, "link-key-dir");
    symlinkSync(realSub, linkSub);

    expect(() =>
      resolveLocalVaultKey({
        env: {},
        vaultDir: linkSub,
        envVarName: "KEIKO_TEST_VAULT_KEY",
        keychainService: "keiko-test-vault",
        keyfileName: "test-vault.key",
        keychainAccess: NO_LOCAL_VAULT_KEYCHAIN,
      }),
    ).toThrow("symlinked path");
  });

  it("rejects a final keyfile path that is itself a symlink", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    writeFileSync(join(dir, "real-test-vault.key"), Buffer.alloc(32, 4).toString("base64"));
    symlinkSync(join(dir, "real-test-vault.key"), join(dir, "test-vault.key"));

    expect(() =>
      resolveLocalVaultKey({
        env: {},
        vaultDir: dir,
        envVarName: "KEIKO_TEST_VAULT_KEY",
        keychainService: "keiko-test-vault",
        keyfileName: "test-vault.key",
        keychainAccess: NO_LOCAL_VAULT_KEYCHAIN,
      }),
    ).toThrow("symlinked path");
  });
});

// ---------------------------------------------------------------------------
// createLocalSecretVault — CRUD behaviour
// ---------------------------------------------------------------------------

function vaultAt(storePath: string): ReturnType<typeof createLocalSecretVault> {
  return createLocalSecretVault({ key: KEY, storePath });
}

function expectStoreFault(
  action: () => unknown,
  code: SecretVaultStoreError["code"],
): SecretVaultStoreError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(SecretVaultStoreError);
    expect((error as SecretVaultStoreError).code).toBe(code);
    return error as SecretVaultStoreError;
  }
  throw new Error("expected secret vault store operation to fail");
}

describe("createLocalSecretVault — round-trip", () => {
  it("set then get returns the exact secret", () => {
    const vault = vaultAt(join(dir, "vault.enc.json"));
    vault.set("cred:a", "secret-A");
    expect(vault.get("cred:a")).toBe("secret-A");
  });

  it("get on a missing reference returns undefined", () => {
    const vault = vaultAt(join(dir, "vault.enc.json"));
    expect(vault.get("missing")).toBeUndefined();
  });
});

describe("createLocalSecretVault — multi-entry", () => {
  it("set two refs, list returns both (order-insensitive), has is correct, get returns each", () => {
    const vault = vaultAt(join(dir, "vault.enc.json"));
    vault.set("cred:a", "secret-A");
    vault.set("cred:b", "secret-B");

    expect(vault.list().slice().sort()).toEqual(["cred:a", "cred:b"]);
    expect(vault.has("cred:a")).toBe(true);
    expect(vault.has("cred:b")).toBe(true);
    expect(vault.has("cred:missing")).toBe(false);
    expect(vault.get("cred:a")).toBe("secret-A");
    expect(vault.get("cred:b")).toBe("secret-B");
  });
});

describe("createLocalSecretVault — plaintext never on disk", () => {
  it("the store file does not contain the plaintext and starts as valid JSON with version 1", () => {
    const storePath = join(dir, "vault.enc.json");
    const vault = vaultAt(storePath);
    vault.set("cred:a", "SUPERSECRET");

    const raw = readFileSync(storePath, "utf8");
    expect(raw).not.toContain("SUPERSECRET");

    const parsed = JSON.parse(raw) as unknown;
    expect(typeof parsed).toBe("object");
    expect(parsed).not.toBeNull();
    expect((parsed as { version: unknown }).version).toBe(1);
  });

  it("the store file is written with 0600 permissions on non-windows", () => {
    const storePath = join(dir, "vault.enc.json");
    const vault = vaultAt(storePath);
    vault.set("cred:a", "SUPERSECRET");

    if (process.platform !== "win32") {
      expect(statSync(storePath).mode & 0o777).toBe(0o600);
    }
  });
});

describe("createLocalSecretVault — replaceAll", () => {
  it("replaceAll(new Map) keeps only the supplied refs and removes the old ones", () => {
    const storePath = join(dir, "vault.enc.json");
    const vault = vaultAt(storePath);
    vault.set("cred:a", "secret-A");
    vault.set("cred:b", "secret-B");

    vault.replaceAll(new Map([["cred:b", "B-new"]]));

    expect(vault.list()).toEqual(["cred:b"]);
    expect(vault.get("cred:b")).toBe("B-new");
    expect(vault.get("cred:a")).toBeUndefined();
  });

  it("replaceAll(empty Map) removes the store file and get returns undefined", () => {
    const storePath = join(dir, "vault.enc.json");
    const vault = vaultAt(storePath);
    vault.set("cred:a", "secret-A");

    vault.replaceAll(new Map());

    expect(existsSync(storePath)).toBe(false);
    expect(vault.get("cred:a")).toBeUndefined();
  });
});

describe("createLocalSecretVault — delete", () => {
  it("deletes one ref, the other remains intact", () => {
    const storePath = join(dir, "vault.enc.json");
    const vault = vaultAt(storePath);
    vault.set("cred:a", "secret-A");
    vault.set("cred:b", "secret-B");

    vault.delete("cred:a");

    expect(vault.has("cred:a")).toBe(false);
    expect(vault.get("cred:b")).toBe("secret-B");
  });

  it("deleting the last entry removes the store file", () => {
    const storePath = join(dir, "vault.enc.json");
    const vault = vaultAt(storePath);
    vault.set("cred:only", "only-value");

    vault.delete("cred:only");

    expect(existsSync(storePath)).toBe(false);
  });

  it("deleting a non-existent ref is a no-op", () => {
    const storePath = join(dir, "vault.enc.json");
    const vault = vaultAt(storePath);
    vault.set("cred:a", "secret-A");

    vault.delete("cred:never-existed");

    expect(vault.get("cred:a")).toBe("secret-A");
  });
});

describe("createLocalSecretVault — idempotent set", () => {
  it("setting the same ref twice returns the latest secret", () => {
    const vault = vaultAt(join(dir, "vault.enc.json"));
    vault.set("cred:a", "first-secret");
    vault.set("cred:a", "second-secret");
    expect(vault.get("cred:a")).toBe("second-secret");
  });
});

describe("createLocalSecretVault — wrong key tamper", () => {
  it("a vault opened with a different key over the same storePath throws on get", () => {
    const storePath = join(dir, "vault.enc.json");

    const vaultA = createLocalSecretVault({ key: Buffer.alloc(32, 7), storePath });
    vaultA.set("cred:a", "PLAINTEXT_SHOULD_NOT_LEAK");

    const vaultB = createLocalSecretVault({ key: Buffer.alloc(32, 13), storePath });

    let caughtError: unknown;
    try {
      vaultB.get("cred:a");
      throw new Error("expected get() to throw on wrong key");
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(SecretboxError);
    expect(String(caughtError)).not.toContain("PLAINTEXT_SHOULD_NOT_LEAK");
  });
});

describe("createLocalSecretVault — corrupt store", () => {
  it("non-JSON store file fails closed and is preserved", () => {
    const storePath = join(dir, "vault.enc.json");
    writeFileSync(storePath, "this-is-not-json!!!");

    const vault = vaultAt(storePath);
    const error = expectStoreFault(() => vault.get("any-ref"), "SECRET_VAULT_STORE_INVALID_JSON");
    expect(error.storePath).toBe(storePath);
    expect(String(error)).not.toContain("this-is-not-json");
    expectStoreFault(() => vault.list(), "SECRET_VAULT_STORE_INVALID_JSON");
    expect(readFileSync(storePath, "utf8")).toBe("this-is-not-json!!!");
  });

  it("a store file with wrong version number fails closed", () => {
    const storePath = join(dir, "vault.enc.json");
    writeFileSync(storePath, JSON.stringify({ version: 99, entries: { "cred:a": "kv1.x.y" } }));

    const vault = vaultAt(storePath);
    expectStoreFault(() => vault.list(), "SECRET_VAULT_STORE_INVALID_SCHEMA");
    expectStoreFault(() => vault.get("cred:a"), "SECRET_VAULT_STORE_INVALID_SCHEMA");
  });

  it("a store file with entries that are not strings fails closed", () => {
    const storePath = join(dir, "vault.enc.json");
    writeFileSync(storePath, JSON.stringify({ version: 1, entries: { "cred:a": 42 } }));

    const vault = vaultAt(storePath);
    expectStoreFault(() => vault.list(), "SECRET_VAULT_STORE_INVALID_SCHEMA");
  });

  it("set refuses to overwrite an unreadable existing store", () => {
    const storePath = join(dir, "vault.enc.json");
    const vault = vaultAt(storePath);
    vault.set("cred:a", "secret-A");
    vault.set("cred:b", "secret-B");
    writeFileSync(storePath, "{not valid json", "utf8");

    expectStoreFault(() => {
      vault.set("cred:c", "secret-C");
    }, "SECRET_VAULT_STORE_INVALID_JSON");

    expect(readFileSync(storePath, "utf8")).toBe("{not valid json");
  });

  it("replaceAll refuses to overwrite an unreadable existing store", () => {
    const storePath = join(dir, "vault.enc.json");
    const vault = vaultAt(storePath);
    vault.set("cred:a", "secret-A");
    writeFileSync(storePath, JSON.stringify({ version: 1, entries: null }), "utf8");

    expectStoreFault(() => {
      vault.replaceAll(new Map([["cred:b", "secret-B"]]));
    }, "SECRET_VAULT_STORE_INVALID_SCHEMA");

    expect(readFileSync(storePath, "utf8")).toBe(JSON.stringify({ version: 1, entries: null }));
  });

  it("replaceAll(empty) refuses to delete an unreadable existing store", () => {
    const storePath = join(dir, "vault.enc.json");
    const vault = vaultAt(storePath);
    vault.set("cred:a", "secret-A");
    writeFileSync(storePath, "null", "utf8");

    expectStoreFault(() => {
      vault.replaceAll(new Map());
    }, "SECRET_VAULT_STORE_INVALID_SCHEMA");

    expect(readFileSync(storePath, "utf8")).toBe("null");
  });

  it("readLocalVaultReferences fails closed over an unreadable reference index", () => {
    const storePath = join(dir, "vault.enc.json");
    writeFileSync(storePath, "not-json", "utf8");

    expectStoreFault(() => readLocalVaultReferences(storePath), "SECRET_VAULT_STORE_INVALID_JSON");
  });
});

describe("createLocalSecretVault — symlink guard", () => {
  it("throws when the storePath contains a symlinked directory segment", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    // Build a real sub-directory and a symlink to it.
    const realSub = join(dir, "real-sub");
    mkdirSync(realSub);
    const linkSub = join(dir, "link-sub");
    symlinkSync(realSub, linkSub);

    const vault = createLocalSecretVault({
      key: KEY,
      storePath: join(linkSub, "vault.enc.json"),
    });
    expect(() => {
      vault.set("cred:a", "value");
    }).toThrow("symlinked path");
  });

  it("throws on read paths through a symlinked directory segment", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const realSub = join(dir, "real-read-sub");
    mkdirSync(realSub);
    const linkSub = join(dir, "link-read-sub");
    symlinkSync(realSub, linkSub);

    const vault = createLocalSecretVault({
      key: KEY,
      storePath: join(linkSub, "vault.enc.json"),
    });

    expect(() => vault.get("cred:a")).toThrow("symlinked path");
    expect(() => vault.has("cred:a")).toThrow("symlinked path");
    expect(() => vault.list()).toThrow("symlinked path");
  });

  it("throws when the final store file path is itself a symlink", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const realStore = join(dir, "real-vault.enc.json");
    vaultAt(realStore).set("cred:a", "secret-A");
    const linkStore = join(dir, "link-vault.enc.json");
    symlinkSync(realStore, linkStore);

    const vault = createLocalSecretVault({ key: KEY, storePath: linkStore });

    expect(() => vault.list()).toThrow("symlinked path");
    expect(() => {
      vault.set("cred:b", "secret-B");
    }).toThrow("symlinked path");
  });

  it("throws before deleting an empty replacement through a symlinked directory segment", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const realSub = join(dir, "real-delete-sub");
    mkdirSync(realSub);
    const linkSub = join(dir, "link-delete-sub");
    symlinkSync(realSub, linkSub);

    const vault = createLocalSecretVault({
      key: KEY,
      storePath: join(linkSub, "vault.enc.json"),
    });

    expect(() => {
      vault.replaceAll(new Map());
    }).toThrow("symlinked path");
  });
});

describe("createLocalSecretVault — additional isStoreFile branches", () => {
  it("a store file containing JSON null fails closed", () => {
    const storePath = join(dir, "vault.enc.json");
    writeFileSync(storePath, "null");

    const vault = vaultAt(storePath);
    expectStoreFault(() => vault.list(), "SECRET_VAULT_STORE_INVALID_SCHEMA");
  });

  it("a store file with entries=[] (array, not an object) fails closed", () => {
    const storePath = join(dir, "vault.enc.json");
    writeFileSync(storePath, JSON.stringify({ version: 1, entries: [] }));

    const vault = vaultAt(storePath);
    expectStoreFault(() => vault.list(), "SECRET_VAULT_STORE_INVALID_SCHEMA");
  });

  it("a store file with entries=null fails closed", () => {
    const storePath = join(dir, "vault.enc.json");
    writeFileSync(storePath, JSON.stringify({ version: 1, entries: null }));

    const vault = vaultAt(storePath);
    expectStoreFault(() => vault.list(), "SECRET_VAULT_STORE_INVALID_SCHEMA");
  });
});

describe("createKeychainVaultKeyAccess", () => {
  const originalPlatform = process.platform;

  function setPlatform(value: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", { value, configurable: true });
  }

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("returns undefined off macOS without invoking the security CLI", () => {
    setPlatform("linux");
    let called = false;
    const runner = (): string => {
      called = true;
      return "";
    };
    expect(createKeychainVaultKeyAccess("svc", runner)()).toBeUndefined();
    expect(called).toBe(false);
  });

  it("reads an existing 32-byte key from the keychain (read hit)", () => {
    setPlatform("darwin");
    const stored = Buffer.alloc(32, 5).toString("base64");
    const runner = (args: readonly string[]): string => {
      if (args[0] === "find-generic-password") return `${stored}\n`;
      throw new Error("unexpected command");
    };
    const key = createKeychainVaultKeyAccess("svc", runner)();
    expect(key).toBeInstanceOf(Buffer);
    expect(key?.length).toBe(32);
  });

  it("generates and stores a new key when the keychain has none (read miss → add)", () => {
    setPlatform("darwin");
    const commands: string[][] = [];
    const runner = (args: readonly string[]): string => {
      commands.push([...args]);
      if (args[0] === "find-generic-password") throw new Error("not found");
      return "";
    };
    const key = createKeychainVaultKeyAccess("svc", runner)();
    expect(key?.length).toBe(32);
    expect(commands.map((c) => c[0])).toEqual(["find-generic-password", "add-generic-password"]);
    // The key persisted to the keychain (the `-w` value of add-generic-password) must be exactly the
    // key returned to the caller, so a later read resolves the same vault key.
    const addArgs = commands[1] ?? [];
    const storedKey = addArgs[addArgs.indexOf("-w") + 1] ?? "";
    expect(Buffer.from(storedKey, "base64")).toEqual(key);
  });

  it("returns undefined when generating the key fails (add error)", () => {
    setPlatform("darwin");
    const runner = (): string => {
      throw new Error("security unavailable");
    };
    expect(createKeychainVaultKeyAccess("svc", runner)()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createShardedLocalSecretVault — one sealed file per entry (#2616)
// ---------------------------------------------------------------------------

function shardedVaultAt(storeDir: string): ReturnType<typeof createShardedLocalSecretVault> {
  return createShardedLocalSecretVault({ key: KEY, storeDir });
}

describe("createShardedLocalSecretVault — CRUD parity with the single-file layout", () => {
  it("round-trips, reports membership, lists references, and deletes one entry", () => {
    const vault = shardedVaultAt(join(dir, "sharded"));
    vault.set("cred:a", "secret-A");
    vault.set("cred:b", "secret-B");

    expect(vault.get("cred:a")).toBe("secret-A");
    expect(vault.get("cred:b")).toBe("secret-B");
    expect(vault.get("cred:missing")).toBeUndefined();
    expect(vault.has("cred:a")).toBe(true);
    expect(vault.has("cred:missing")).toBe(false);
    expect([...vault.list()].sort()).toEqual(["cred:a", "cred:b"]);

    vault.delete("cred:a");
    expect(vault.get("cred:a")).toBeUndefined();
    expect(vault.list()).toEqual(["cred:b"]);
    // Deleting an absent reference is a no-op, never a throw.
    expect(() => {
      vault.delete("cred:a");
    }).not.toThrow();
  });

  it("replaces a value in place and replaceAll drops references not supplied", () => {
    const vault = shardedVaultAt(join(dir, "sharded"));
    vault.set("cred:a", "first");
    vault.set("cred:a", "second");
    expect(vault.get("cred:a")).toBe("second");
    expect(vault.list()).toEqual(["cred:a"]);

    vault.set("cred:stale", "gone");
    vault.replaceAll(new Map([["cred:kept", "kept-value"]]));
    expect([...vault.list()].sort()).toEqual(["cred:kept"]);
    expect(vault.get("cred:kept")).toBe("kept-value");
  });

  it("writes one 0600 file per entry into a 0700 directory and never plaintext", () => {
    const storeDir = join(dir, "sharded");
    const vault = shardedVaultAt(storeDir);
    vault.set("cred:a", "plaintext-marker-A");
    vault.set("cred:b", "plaintext-marker-B");

    const files = readdirSync(storeDir);
    expect(files).toHaveLength(2);
    for (const name of files) {
      const filePath = join(storeDir, name);
      expect(readFileSync(filePath, "utf8")).not.toContain("plaintext-marker");
      expect(readFileSync(filePath, "utf8").startsWith("kv1.")).toBe(true);
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
    }
    expect(statSync(storeDir).mode & 0o777).toBe(0o700);
  });

  it("ignores foreign and malformed filenames instead of reporting them as references", () => {
    const storeDir = join(dir, "sharded");
    const vault = shardedVaultAt(storeDir);
    vault.set("cred:a", "secret-A");
    writeFileSync(join(storeDir, "README.txt"), "not an entry", "utf8");
    writeFileSync(join(storeDir, "entry-zz.sealed"), "not hex", "utf8");
    writeFileSync(join(storeDir, "entry-616.sealed"), "odd length", "utf8");
    writeFileSync(join(storeDir, "entry-.sealed"), "empty", "utf8");
    // Valid hex that UTF-8 cannot represent: it would decode to a reference whose own filename is
    // a different one, so it is not a reference this vault could have written.
    writeFileSync(join(storeDir, "entry-eda080.sealed"), "lone surrogate", "utf8");

    expect(vault.list()).toEqual(["cred:a"]);
  });

  it("returns undefined for an entry file that is not a sealed envelope", () => {
    const storeDir = join(dir, "sharded");
    const vault = shardedVaultAt(storeDir);
    vault.set("cred:a", "secret-A");
    const [name] = readdirSync(storeDir);
    writeFileSync(join(storeDir, name ?? "missing"), "tampered-not-sealed", "utf8");

    expect(vault.get("cred:a")).toBeUndefined();
    expect(vault.has("cred:a")).toBe(false);
  });

  it("lists nothing before the first write", () => {
    const vault = shardedVaultAt(join(dir, "sharded"));
    expect(vault.list()).toEqual([]);
    expect(vault.get("cred:a")).toBeUndefined();
  });

  it("refuses to STORE a reference no filename can represent, and treats it as absent on read", () => {
    const vault = shardedVaultAt(join(dir, "sharded"));
    // A lone surrogate is not UTF-8 encodable: Buffer substitutes U+FFFD, so two distinct
    // references would land on ONE file and silently serve each other's secret. Over-long
    // references cannot be named at all. Both are refused on the way in.
    for (const reference of ["\uD800", "\uDC00", "r".repeat(97)]) {
      expect(() => {
        vault.set(reference, "unstorable");
      }).toThrow(/cannot be stored/u);
      expect(() => {
        vault.replaceAll(new Map([[reference, "unstorable"]]));
      }).toThrow(/cannot be stored/u);
    }

    // A reference that can hold no entry reports absent rather than throwing, exactly as the
    // single-file layout does for any unknown reference.
    vault.set("\uFFFD", "replacement-character-is-storable");
    expect(vault.get("\uD800")).toBeUndefined();
    expect(vault.has("\uD800")).toBe(false);
    expect(() => {
      vault.delete("\uD800");
    }).not.toThrow();
    expect(vault.get("\uFFFD")).toBe("replacement-character-is-storable");
  });

  it("reports an unreadable entry as absent instead of throwing a raw fs error", () => {
    const storeDir = join(dir, "sharded");
    const vault = shardedVaultAt(storeDir);
    vault.set("cred:a", "secret-A");
    const [name] = readdirSync(storeDir);
    // A directory where the entry file belongs makes readFileSync raise EISDIR. One unreadable
    // entry says nothing about the others, so it reports absent — which is what get/has promise.
    rmSync(join(storeDir, name ?? "missing"));
    mkdirSync(join(storeDir, name ?? "missing"), { recursive: true });

    expect(vault.get("cred:a")).toBeUndefined();
    expect(vault.has("cred:a")).toBe(false);
  });

  it("never lists a filename it would refuse to read or delete under that reference", () => {
    const storeDir = join(dir, "sharded");
    const vault = shardedVaultAt(storeDir);
    vault.set("cred:a", "secret-A");
    // Well-formed hex, but the reference it decodes to is past the byte bound, so this vault would
    // never store it under this name. Listing it would name a body no caller could ever reclaim.
    const overLong = Buffer.from("r".repeat(97), "utf8").toString("hex");
    writeFileSync(join(storeDir, `entry-${overLong}.sealed`), "unreachable", "utf8");

    expect(vault.list()).toEqual(["cred:a"]);
  });

  it("refuses to enumerate through a symlinked store directory", () => {
    const storeDir = join(dir, "sharded-list");
    mkdirSync(join(dir, "foreign"), { recursive: true });
    shardedVaultAt(join(dir, "foreign")).set("cred:foreign", "not mine");
    symlinkSync(join(dir, "foreign"), storeDir);

    // The single-file list() reads through readStore, which refuses a symlinked path; the sharded
    // one must not become the one operation a hostile redirect can enumerate.
    expect(() => shardedVaultAt(storeDir).list()).toThrow(/symlinked path/u);
  });

  it("leaves no temp file behind when the commit rename fails", () => {
    const storeDir = join(dir, "sharded");
    const reference = "cred:blocked";
    const shardName = `entry-${Buffer.from(reference, "utf8").toString("hex")}.sealed`;
    // A non-empty directory sitting on the entry's own path makes renameSync fail after the temp
    // file is written and fsynced, which is the only way into the cleanup branch.
    mkdirSync(join(storeDir, shardName), { recursive: true });
    writeFileSync(join(storeDir, shardName, "occupant"), "blocks the rename", "utf8");

    expect(() => {
      shardedVaultAt(storeDir).set(reference, "secret-A");
    }).toThrow();
    expect(readdirSync(storeDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses to write through a symlinked path segment", () => {
    const storeDir = join(dir, "sharded");
    mkdirSync(join(dir, "elsewhere"), { recursive: true });
    symlinkSync(join(dir, "elsewhere"), storeDir);

    expect(() => {
      shardedVaultAt(storeDir).set("cred:a", "secret-A");
    }).toThrow(/symlinked path/u);
  });
});
