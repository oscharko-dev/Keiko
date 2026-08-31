// Isolated so the `node:fs` mock never leaks into secret-vault.test.ts. Counts how many times
// writeStore commits the vault file: persistVaultEntries used to call set() per credential, and
// each set() is one whole-file rewrite. setMany must commit that file once for N entries (#3346).
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalSecretVault } from "./secret-vault.js";

const renameDestinations: string[] = [];

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (oldPath: unknown, newPath: unknown): void => {
      renameDestinations.push(String(newPath));
      (actual.renameSync as (...args: unknown[]) => void)(oldPath, newPath);
    },
  };
});

const KEY = Buffer.alloc(32, 7);
const REAL_TMPDIR = realpathSync(tmpdir());
const dirs: string[] = [];

afterEach(() => {
  renameDestinations.length = 0;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("createLocalSecretVault — setMany write cost (#3346)", () => {
  it("commits the store file once when sealing N new entries", () => {
    const dir = realpathSync(mkdtempSync(join(REAL_TMPDIR, "secret-vault-set-many-io-")));
    dirs.push(dir);
    const storePath = resolve(join(dir, "vault.enc.json"));
    const vault = createLocalSecretVault({ key: KEY, storePath });
    const batch = new Map(
      Array.from({ length: 20 }, (_unused, index) => [
        `cred:m${String(index)}`,
        `secret-${String(index)}`,
      ]),
    );

    renameDestinations.length = 0;
    vault.setMany(batch);

    expect(renameDestinations.filter((path) => path === storePath)).toHaveLength(1);
    expect(vault.list()).toHaveLength(20);
    expect(vault.get("cred:m0")).toBe("secret-0");
    expect(vault.get("cred:m19")).toBe("secret-19");
  });

  it("commits the store file once when deleteMany drops N entries", () => {
    const dir = realpathSync(mkdtempSync(join(REAL_TMPDIR, "secret-vault-delete-many-io-")));
    dirs.push(dir);
    const storePath = resolve(join(dir, "vault.enc.json"));
    const vault = createLocalSecretVault({ key: KEY, storePath });
    vault.setMany(
      new Map([
        ["cred:a", "secret-a"],
        ["cred:b", "secret-b"],
        ["cred:keep", "secret-keep"],
      ]),
    );

    renameDestinations.length = 0;
    vault.deleteMany(["cred:a", "cred:b"]);

    expect(renameDestinations.filter((path) => path === storePath)).toHaveLength(1);
    expect(vault.list()).toEqual(["cred:keep"]);
  });
});
