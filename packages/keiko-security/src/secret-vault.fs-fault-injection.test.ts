// Isolated in its own file so the `node:fs` module mock below never leaks into the rest of the
// secret-vault suite (secret-vault.test.ts): `vi.mock` is hoisted and applies to the WHOLE file's
// module graph, so keeping the blast radius to two narrow, precisely-targeted scenarios is
// deliberate. Both mocked functions pass every other call straight through to the real
// implementation, so nothing outside the exact matched path/flags combination is affected.
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLocalSecretVault,
  createShardedLocalSecretVault,
  type LocalSecretVaultDeps,
} from "./secret-vault.js";

let blockedOpenDir = "";
let blockedRenameDest = "";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    // fsyncDirectory's `try { fd = openSync(dir, "r"); ... } finally { if (fd !== undefined) ... }`
    // (writeStore/writeShard's post-rename directory fsync) has a branch that is otherwise
    // unreachable hermetically: `fd` stays `undefined` only when `openSync(dir, "r")` itself
    // throws. Real permission tricks can't isolate that from the rest of the write —
    // `ensureDirHardened` re-chmods the directory to 0700 immediately before the write, undoing
    // any pre-set restriction. This scoped mock is the only hermetic way to exercise it.
    openSync: (path: unknown, flags: unknown, mode?: unknown): number => {
      if (path === blockedOpenDir && flags === "r") {
        throw Object.assign(new Error("simulated: directory cannot be opened for fsync"), {
          code: "EACCES",
        });
      }
      return (actual.openSync as (...args: unknown[]) => number)(path, flags, mode);
    },
    // writeStore's `finally { if (existsSync(tempPath)) { try { unlinkSync(tempPath); } ... } }`
    // cleanup only runs when the commit rename itself fails AFTER the temp file was written. For
    // the single-file layout that is hermetically unreachable by blocking the destination with a
    // real pre-existing path: `set()`/`replaceAll()`/`delete()` all call `readStore` on that exact
    // path FIRST, so a blocking directory or unreadable file there makes `readStore` throw before
    // `writeStore` (and its rename) is ever reached — proven by the sharded-layout version of this
    // proof (secret-vault.test.ts), which works because sharded `set()` never reads its target
    // first. This scoped mock fails only the rename itself, leaving the preceding read untouched.
    renameSync: (oldPath: unknown, newPath: unknown): void => {
      if (newPath === blockedRenameDest) {
        throw Object.assign(new Error("simulated: rename destination refused"), {
          code: "EACCES",
        });
      }
      (actual.renameSync as (...args: unknown[]) => void)(oldPath, newPath);
    },
  };
});

const KEY = Buffer.alloc(32, 7);
const REAL_TMPDIR = realpathSync(tmpdir());
const dirs: string[] = [];

afterEach(() => {
  blockedOpenDir = "";
  blockedRenameDest = "";
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const created = realpathSync(mkdtempSync(join(REAL_TMPDIR, prefix)));
  dirs.push(created);
  return created;
}

describe("fsyncDirectory — the directory itself cannot be opened for fsync", () => {
  it("single-file layout: set() still commits and returns the secret when the post-rename directory fsync fails to open", () => {
    const dir = tempDir("secret-vault-fsync-open-");
    blockedOpenDir = dir;

    const vault = createLocalSecretVault({ key: KEY, storePath: join(dir, "vault.enc.json") });
    expect(() => {
      vault.set("cred:a", "value");
    }).not.toThrow();
    expect(vault.get("cred:a")).toBe("value");
  });

  it("sharded layout: set() still commits and returns the secret when the post-rename directory fsync fails to open", () => {
    const dir = tempDir("secret-vault-fsync-open-shard-");
    const storeDir = join(dir, "sharded");
    blockedOpenDir = storeDir;

    const vault = createShardedLocalSecretVault({ key: KEY, storeDir });
    expect(() => {
      vault.set("cred:a", "value");
    }).not.toThrow();
    expect(vault.get("cred:a")).toBe("value");
  });
});

describe("createLocalSecretVault — writeStore leaves no temp file behind when the commit rename fails", () => {
  it("cleans up the temp file when renameSync cannot replace the store path", () => {
    const dir = tempDir("secret-vault-rename-fail-");
    const storePath = join(dir, "vault.enc.json");
    const deps: LocalSecretVaultDeps = { key: KEY, storePath };
    blockedRenameDest = resolve(storePath);

    const vault = createLocalSecretVault(deps);
    expect(() => {
      vault.set("cred:a", "value");
    }).toThrow("simulated: rename destination refused");
    // The temp file the failed rename left behind must not survive — best-effort cleanup runs in
    // writeStore's `finally`, exercising the branch where `existsSync(tempPath)` is true.
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});
