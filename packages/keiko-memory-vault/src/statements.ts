import type { DatabaseSync } from "node:sqlite";

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
