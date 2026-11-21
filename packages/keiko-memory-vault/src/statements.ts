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

// A closed vocabulary keyed by its stored spelling. A lookup returns the typed member, so a stored
// value outside the vocabulary is absent instead of being asserted into the member type.
export type ClosedVocabulary<T extends string> = ReadonlyMap<string, T>;

export function closedVocabulary<T extends string>(members: readonly T[]): ClosedVocabulary<T> {
  return new Map(members.map((member): [string, T] => [member, member]));
}

export function vocabularyMember<T extends string>(
  vocabulary: ClosedVocabulary<T>,
  value: string,
): T {
  const member = vocabulary.get(value);
  if (member === undefined) throw columnTypeMismatch();
  return member;
}

export function vocabularyColumn<T extends string>(
  row: VaultSqlRow,
  column: string,
  vocabulary: ClosedVocabulary<T>,
): T {
  return vocabularyMember(vocabulary, textColumn(row, column));
}

export function nullableVocabularyColumn<T extends string>(
  row: VaultSqlRow,
  column: string,
  vocabulary: ClosedVocabulary<T>,
): T | null {
  return row[column] === null ? null : vocabularyColumn(row, column, vocabulary);
}

// A branded id is a plain string at runtime. `isId` states the whole runtime definition of the
// brand, so a stored value it refuses fails closed instead of being asserted into the brand.
export function storedId<T extends string>(value: string, isId: (value: string) => value is T): T {
  if (!isId(value)) throw columnTypeMismatch();
  return value;
}

export function idColumn<T extends string>(
  row: VaultSqlRow,
  column: string,
  isId: (value: string) => value is T,
): T {
  return storedId(textColumn(row, column), isId);
}

export function nullableIdColumn<T extends string>(
  row: VaultSqlRow,
  column: string,
  isId: (value: string) => value is T,
): T | null {
  return row[column] === null ? null : idColumn(row, column, isId);
}
