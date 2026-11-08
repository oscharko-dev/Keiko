import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalSecretVault, createShardedLocalSecretVault } from "./secret-vault.js";

const directories: string[] = [];
function location(): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "vault-cas-"));
  directories.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe("existing sealed vault atomic ownership", () => {
  it.each(["file", "sharded"] as const)(
    "rejects a stale claim across independent %s owners",
    (layout) => {
      const path = join(location(), "secrets");
      const key = Buffer.alloc(32, 19);
      const open = () =>
        layout === "file"
          ? createLocalSecretVault({ key, storePath: path })
          : createShardedLocalSecretVault({ key, storeDir: path });
      const first = open();
      const second = open();
      first.set("one-use", "synthetic ready");
      const stale = second.get("one-use");
      expect(first.compareAndSet?.("one-use", "synthetic ready", "consumed")).toBe(true);
      expect(second.compareAndSet?.("one-use", stale, "another consumed claim")).toBe(false);
      second.set("unrelated", "unrelated synthetic value");
      expect(first.get("one-use")).toBe("consumed");
      expect(first.compareAndSet?.("missing", undefined, "pending")).toBe(true);
      expect(second.compareAndSet?.("missing", undefined, "replace pending")).toBe(false);
    },
  );
  it("holds a session lease across owner instances until explicit release", () => {
    const storePath = join(location(), "secrets");
    const key = Buffer.alloc(32, 19);
    const first = createLocalSecretVault({ key, storePath });
    const second = createLocalSecretVault({ key, storePath });
    const release = first.acquireLease?.("session-context");
    if (release === undefined) throw new TypeError("Expected private session lease");
    expect(second.acquireLease?.("session-context")).toBeUndefined();
    first.set("independent-input", "pending"); // The asynchronous session lease never holds the whole vault write lock.
    release();
    release();
    const next = second.acquireLease?.("session-context");
    expect(next).toBeTypeOf("function");
    next?.();
  });
  it("refuses writes while another process owns the same kernel guard, then recovers on exit", async () => {
    const storePath = join(location(), "secrets");
    const key = Buffer.alloc(32, 19);
    const vault = createLocalSecretVault({ key, storePath });
    vault.set("one-use", "synthetic ready");
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    const path = join(
      dirname(storePath),
      ".keiko-vault-guards",
      digest(storePath),
      `${digest("store-write")}.sqlite`,
    );
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
      process.stdout.write('owned');
      process.stdin.resume();
    `,
        path,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    try {
      await once(child.stdout, "data");
      expect(() => vault.compareAndSet?.("one-use", "synthetic ready", "consumed")).toThrow(
        "already in progress",
      );
      expect(() => vault.set("one-use", "replacement")).toThrow("already in progress");
      expect(vault.get("one-use")).toBe("synthetic ready");
    } finally {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    expect(vault.compareAndSet?.("one-use", "synthetic ready", "consumed")).toBe(true);
  });
});
