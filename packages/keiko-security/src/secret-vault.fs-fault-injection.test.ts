// Isolated in its own file so the `node:fs` module mock below never leaks into the rest of the
// secret-vault suite (secret-vault.test.ts): `vi.mock` is hoisted and applies to the WHOLE file's
// module graph, so keeping the blast radius to two narrow, precisely-targeted scenarios is
// deliberate. Both mocked functions pass every other call straight through to the real
// implementation, so nothing outside the exact matched path/flags combination is affected.
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ACTIVITY_LOG_UNKNOWN_CORRELATION_ID } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecurityLogEvent } from "./log-port.js";
import {
  createLocalSecretVault,
  createShardedLocalSecretVault,
  type LocalSecretVaultDeps,
} from "./secret-vault.js";

let blockedOpenDir = "";
let blockedRenameDest = "";
let blockedOpenSyncHits = 0;
const blockedRenameAfterHits = new Map<string, number>();
const renameHits = new Map<string, number>();

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
        blockedOpenSyncHits += 1;
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
      const destination = String(newPath);
      const hits = (renameHits.get(destination) ?? 0) + 1;
      renameHits.set(destination, hits);
      const allowedHits = blockedRenameAfterHits.get(destination);
      if (newPath === blockedRenameDest || (allowedHits !== undefined && hits > allowedHits)) {
        throw Object.assign(new Error("simulated: rename destination refused"), {
          code: "EACCES",
        });
      }
      (actual.renameSync as (...args: unknown[]) => void)(oldPath, newPath);
    },
  };
});

const KEY = Buffer.alloc(32, 7);
const VAULT_FRAME_PATTERN = /^packages\/keiko-security\/(?:dist|src)\/.+\.(?:js|ts):\d+:\d+$/u;
const REAL_TMPDIR = realpathSync(tmpdir());
const dirs: string[] = [];

function isVaultFrameArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((frame: unknown) => typeof frame === "string" && VAULT_FRAME_PATTERN.test(frame))
  );
}

afterEach(() => {
  blockedOpenDir = "";
  blockedRenameDest = "";
  blockedOpenSyncHits = 0;
  blockedRenameAfterHits.clear();
  renameHits.clear();
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
    // Prove the injected fault actually fired: without this, a path mismatch (e.g. a realpath
    // difference between `blockedOpenDir` and the directory `fsyncDirectory` actually opens) would
    // silently skip the throwing branch and this test would still pass for the wrong reason.
    expect(blockedOpenSyncHits).toBeGreaterThan(0);
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
    // Same discrimination as the single-file case above: the fault must have actually fired.
    expect(blockedOpenSyncHits).toBeGreaterThan(0);
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

describe("createShardedLocalSecretVault — rollback failure evidence", () => {
  it("emits body-free frames when a failed batch cannot restore an earlier shard", () => {
    const dir = tempDir("secret-vault-rollback-fail-");
    const storeDir = join(dir, "sharded");
    const events: SecurityLogEvent[] = [];
    const vault = createShardedLocalSecretVault({
      key: KEY,
      storeDir,
      sink: { write: (event): void => void events.push(event) },
    });
    vault.set("cred:a", "original-a");
    const pathA = join(storeDir, `entry-${Buffer.from("cred:a").toString("hex")}.sealed`);
    const pathB = join(storeDir, `entry-${Buffer.from("cred:b").toString("hex")}.sealed`);
    renameHits.clear();
    blockedRenameAfterHits.set(resolve(pathA), 1);
    blockedRenameAfterHits.set(resolve(pathB), 0);

    expect(() => {
      vault.setMany(
        new Map([
          ["cred:a", "updated-a"],
          ["cred:b", "never-stored"],
        ]),
      );
    }).toThrow("simulated: rename destination refused");

    const rollback = events.find((event) => event.op === "security.vault.entries-rollback-failed");
    expect(rollback).toMatchObject({
      level: "error",
      correlationId: ACTIVITY_LOG_UNKNOWN_CORRELATION_ID,
      errorKind: "durability-failed",
      extra: {
        count: 1,
        failureKind: "EACCES",
      },
    });
    expect(isVaultFrameArray(rollback?.extra?.frames)).toBe(true);
    expect(JSON.stringify(rollback)).not.toContain("rename destination refused");
    expect(JSON.stringify(rollback)).not.toContain(storeDir);
    expect(
      events.find((event) => event.op === "security.vault.entries-merge-failed"),
    ).toBeDefined();
  });
});
