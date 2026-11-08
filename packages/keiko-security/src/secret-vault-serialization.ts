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

/** Stable, body-free guard files preserve the vault owner's flat custody directory. */
export function secretVaultGuardPath(storePath: string, scope: string): string {
  const store = createHash("sha256").update(storePath).digest("hex");
  const selected = createHash("sha256").update(scope).digest("hex");
  return join(dirname(storePath), `.keiko-vault-guard-${store}-${selected}.sqlite`);
}
function acquire(storePath: string, scope: string): (() => void) | undefined {
  const path = secretVaultGuardPath(storePath, scope);
  assertSqliteStatePath(path);
  ensureDirHardened(dirname(path));
  assertSqliteStatePath(path);
  // Stable zero-data SQLite inode; never unlink it or reclaim by a PID/timeout guess.
  const guard = acquireSqliteFileGuard(path, () => {
    chmodIfPresent(path, FILE_MODE);
  });
  if (guard === undefined) return undefined;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      guard.close();
    }
  };
}
function underWriteGuard<T>(
  storePath: string,
  assertSafePath: (path: string) => void,
  operation: () => T,
): T {
  // The vault's own symlink refusal precedes the guard's generic SQLite path refusal, so the
  // specific unsafe-target error (or a raw lstat failure) is what a caller observes. Both fail closed.
  assertSafePath(storePath);
  const release = acquire(storePath, "store-write");
  if (release === undefined) throw new Error("Secret vault write is already in progress");
  try {
    return operation();
  } finally {
    release();
  }
}
function assertLeaseScope(scope: unknown): asserts scope is "record" | "collection" {
  if (scope !== "record" && scope !== "collection")
    throw new TypeError("Invalid secret vault lease scope");
}
/** One owner for every writer and CAS, including separate BFFs using the same vault path. */
export function serializedSecretVault(
  storePath: string,
  assertSafePath: (path: string) => void,
  build: (guarded: <T>(operation: () => T) => T) => LocalSecretVault,
): LocalSecretVault {
  const guarded = <T>(operation: () => T): T =>
    underWriteGuard(storePath, assertSafePath, operation);
  const raw = build(guarded);
  return {
    get: raw.get,
    has: raw.has,
    list: raw.list,
    set: (reference, value) => guarded(() => raw.set(reference, value)),
    // Batch writes take the guard inside their own logging wrapper, so a refusal is still recorded
    // as the operation's failure event.
    setMany: raw.setMany,
    replaceAll: (entries) => guarded(() => raw.replaceAll(entries)),
    delete: (reference) => guarded(() => raw.delete(reference)),
    deleteMany: raw.deleteMany,
    compareAndSet: (reference, expected, next) =>
      guarded(() => {
        if (raw.get(reference) !== expected) return false;
        if (next === undefined) raw.delete(reference);
        else raw.set(reference, next);
        return true;
      }),
    acquireLease: (
      reference,
      scope: "record" | "collection" = "record",
    ): (() => void) | undefined => {
      if (typeof reference !== "string" || reference.length === 0 || reference.length > 512)
        throw new TypeError("Invalid secret vault lease reference");
      assertLeaseScope(scope);
      // A fixed 256 stripes per scope bounds stable lock inodes over the lifetime of the vault.
      // Hash collisions conservatively report busy; no owner is displaced or lock file unlinked.
      const stripe = createHash("sha256").update(reference).digest("hex").slice(0, 2);
      return acquire(storePath, `lease:${scope}:${stripe}`);
    },
  };
}
