import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { MemoryStorageError } from "./errors.js";

type PreparedStatement = ReturnType<DatabaseSync["prepare"]>;

const STATEMENTS_BY_DB = new WeakMap<DatabaseSync, Map<string, PreparedStatement>>();

export function cachedPrepare(db: DatabaseSync, sql: string): PreparedStatement {
  let statements = STATEMENTS_BY_DB.get(db);
  if (statements === undefined) {
    statements = new Map<string, PreparedStatement>();
    STATEMENTS_BY_DB.set(db, statements);
  }
  const existing = statements.get(sql);
  if (existing !== undefined) return existing;
  const prepared = db.prepare(sql);
  statements.set(sql, prepared);
  return prepared;
}

// node:sqlite types every row as an open record of SQLOutputValue. The STRICT schema pins each
// column's storage class; these readers check the value against that declared type, so a column
// missing from the SELECT or a drifted schema fails closed with a schema-mismatch error instead of
// reaching a typed row.
export type VaultSqlRow = Readonly<Record<string, SQLOutputValue>>;

function columnTypeMismatch(): MemoryStorageError {
  return new MemoryStorageError(
    "schema-mismatch",
    "A stored memory vault column holds a value of an unexpected type.",
  );
}

export function textColumn(row: VaultSqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw columnTypeMismatch();
  return value;
}

export function nullableTextColumn(row: VaultSqlRow, column: string): string | null {
  return row[column] === null ? null : textColumn(row, column);
}

export function numberColumn(row: VaultSqlRow, column: string): number {
  const value = row[column];
  if (typeof value !== "number") throw columnTypeMismatch();
  return value;
}

export function nullableNumberColumn(row: VaultSqlRow, column: string): number | null {
  return row[column] === null ? null : numberColumn(row, column);
}

export function blobColumn(row: VaultSqlRow, column: string): Uint8Array {
  const value = row[column];
  if (!(value instanceof Uint8Array)) throw columnTypeMismatch();
  return value;
}
