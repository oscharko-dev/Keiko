import type { DatabaseSync } from "node:sqlite";

/** Keep nested store operations in the caller's atomic write without committing its transaction. */
export function withImmediateTransaction<T>(db: DatabaseSync, operation: () => T): T {
  const nested = db.isTransaction;
  db.exec(nested ? "SAVEPOINT keiko_store_write" : "BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec(nested ? "RELEASE keiko_store_write" : "COMMIT");
    return result;
  } catch (error) {
    if (nested) {
      db.exec("ROLLBACK TO keiko_store_write");
      db.exec("RELEASE keiko_store_write");
    } else db.exec("ROLLBACK");
    throw error;
  }
}
