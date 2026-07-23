// SQLite TEMP-storage placement for the capsule store (ADR-0153 D2).
//
// The vec0 ANN index is a TEMP virtual table, so its pages live in SQLite's TEMP database. Left at
// the default, SQLite materialises that database into a file under its temp directory as soon as the
// TEMP page cache overflows — and on an encrypted store those pages are decrypted vectors. That file
// is exactly the second on-disk plaintext vector copy ADR-0047 forbids, and it is invisible after
// the fact: on POSIX hosts SQLite unlinks the temp file immediately after opening it.
//
// Pinning `temp_store` to MEMORY removes the file entirely rather than trying to protect it. The
// cost is that the index is now bounded by RAM instead of disk, which is why enabling the index also
// bounds its size (`vector-index.ts`); the two are one decision and must not be separated.
//
// The pragma is connection-scoped and SQLite drops existing TEMP tables when it changes, so it is
// applied once at open, before anything creates a TEMP table.

import type { DatabaseSync } from "node:sqlite";

// SQLite's `temp_store` enumeration: 0 = compile-time default, 1 = FILE, 2 = MEMORY.
const TEMP_STORE_MEMORY = 2;

export function pinTempStoreToMemory(db: DatabaseSync): void {
  db.exec("PRAGMA temp_store = MEMORY");
}

// The pragma row is narrowed rather than asserted. This value decides whether decrypted vectors may
// be held in a TEMP structure, so an unexpected driver or pragma result shape must resolve to "not
// proven" — a type assertion would let a malformed row through as if it had been read successfully.
function tempStoreValue(row: unknown): number | undefined {
  if (typeof row !== "object" || row === null || !("temp_store" in row)) return undefined;
  const value: unknown = row.temp_store;
  return typeof value === "number" ? value : undefined;
}

// Reads the value actually in force on this connection rather than trusting that the pin was
// applied. A build compiled with SQLITE_TEMP_STORE=0 ignores the pragma, and a caller can open a
// store without the vector runtime configured and supply one at search time; both leave the
// guarantee unmet, and callers that depend on it must be able to tell.
export function tempStoreIsMemory(db: DatabaseSync): boolean {
  try {
    return tempStoreValue(db.prepare("PRAGMA temp_store").get()) === TEMP_STORE_MEMORY;
  } catch {
    // An unreadable pragma is an unproven guarantee, which fails closed exactly like an unpinned one.
    return false;
  }
}
