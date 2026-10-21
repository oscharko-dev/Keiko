import { DatabaseSync } from "node:sqlite";
import { sqliteErrorLike } from "./sqlite-corruption.js";

/** The caller validates the stable private path. Never raw-read or unlink its SQLite inode. */
export function acquireSqliteFileGuard(
  path: string,
  afterOpen?: () => void,
): DatabaseSync | undefined {
  const guard = new DatabaseSync(path);
  try {
    afterOpen?.();
    guard.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    return guard;
  } catch (error) {
    guard.close();
    if (sqliteErrorLike(error).errcode === 5) return undefined;
    throw error;
  }
}
