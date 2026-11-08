import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import {
  assertSqliteStatePath,
  chmodIfPresent,
  ensureDirHardened,
  FILE_MODE,
} from "./fs-hardening.js";
import { acquireSqliteFileGuard } from "./sqlite-file-guard.js";
import type { LocalSecretVault } from "./secret-vault.js";

function guardPath(storePath: string, scope: string): string {
  const store = createHash("sha256").update(storePath).digest("hex");
  const selected = createHash("sha256").update(scope).digest("hex");
  return join(dirname(storePath), ".keiko-vault-guards", store, `${selected}.sqlite`);
}
function acquire(storePath: string, scope: string): (() => void) | undefined {
  const path = guardPath(storePath, scope);
  assertSqliteStatePath(path);
  ensureDirHardened(dirname(path));
  assertSqliteStatePath(path);
  // Stable zero-data SQLite inode; never unlink it or reclaim by a PID/timeout guess.
  const guard = acquireSqliteFileGuard(path, () => chmodIfPresent(path, FILE_MODE));
  if (guard === undefined) return undefined;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      guard.close();
    }
  };
}
function underWriteGuard<T>(storePath: string, operation: () => T): T {
  const release = acquire(storePath, "store-write");
  if (release === undefined) throw new Error("Secret vault write is already in progress");
  try {
    return operation();
  } finally {
    release();
  }
}
/** One owner for every writer and CAS, including separate BFFs using the same vault path. */
export function serializedSecretVault(storePath: string, raw: LocalSecretVault): LocalSecretVault {
  return {
    get: raw.get,
    has: raw.has,
    list: raw.list,
    set: (reference, value) => underWriteGuard(storePath, () => raw.set(reference, value)),
    setMany: (entries) => underWriteGuard(storePath, () => raw.setMany(entries)),
    replaceAll: (entries) => underWriteGuard(storePath, () => raw.replaceAll(entries)),
    delete: (reference) => underWriteGuard(storePath, () => raw.delete(reference)),
    deleteMany: (references) => underWriteGuard(storePath, () => raw.deleteMany(references)),
    compareAndSet: (reference, expected, next) =>
      underWriteGuard(storePath, () => {
        if (raw.get(reference) !== expected) return false;
        if (next === undefined) raw.delete(reference);
        else raw.set(reference, next);
        return true;
      }),
    acquireLease: (reference, scope = "record") => {
      if (typeof reference !== "string" || reference.length === 0 || reference.length > 512)
        throw new TypeError("Invalid secret vault lease reference");
      if (scope !== "record" && scope !== "collection")
        throw new TypeError("Invalid secret vault lease scope");
      // A fixed 256 stripes per scope bounds stable lock inodes over the lifetime of the vault.
      // Hash collisions conservatively report busy; no owner is displaced or lock file unlinked.
      const stripe = createHash("sha256").update(reference).digest("hex").slice(0, 2);
      return acquire(storePath, `lease:${scope}:${stripe}`);
    },
  };
}
