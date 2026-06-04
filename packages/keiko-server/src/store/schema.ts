// ADR-0013 D5 — Schema v1 + migration runner via PRAGMA user_version. Forward-only, idempotent,
// transactional. Each migration is a `.sql` string of one or more CREATE/ALTER statements; the
// runner applies migrations whose 1-based index > current user_version.

import type { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 2;

interface Migration {
  readonly version: number;
  readonly sql: string;
}

const V1_SQL = `
CREATE TABLE projects (
  path TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  favorite INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_opened_at INTEGER NOT NULL
) STRICT;

CREATE TABLE chats (
  id TEXT NOT NULL PRIMARY KEY,
  project_path TEXT NOT NULL REFERENCES projects(path) ON DELETE CASCADE,
  title TEXT NOT NULL,
  selected_model TEXT NOT NULL,
  branch_label TEXT,
  status TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE chat_messages (
  id TEXT NOT NULL PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  run_id TEXT,
  workflow_id TEXT,
  workflow_status TEXT,
  short_result TEXT
) STRICT;

CREATE INDEX idx_chats_project_path ON chats(project_path);
CREATE INDEX idx_messages_chat_id ON chat_messages(chat_id);
CREATE INDEX idx_messages_chat_ts ON chat_messages(chat_id, timestamp);
`;

// V2 (issue #66) adds an additive `task_type` column to chat_messages so the chat can label
// non-workflow task runs (verify, explain-plan) without overloading workflow_id. STRICT tables
// require an explicit type for ALTER ... ADD COLUMN; existing rows materialise NULL.
const V2_SQL = `
ALTER TABLE chat_messages ADD COLUMN task_type TEXT;
`;

const MIGRATIONS: readonly Migration[] = [
  { version: 1, sql: V1_SQL },
  { version: 2, sql: V2_SQL },
];

function currentUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return typeof row?.user_version === "number" ? row.user_version : 0;
}

function setUserVersion(db: DatabaseSync, v: number): void {
  // user_version cannot be parameterized; v is a server-controlled integer constant from MIGRATIONS.
  db.exec(`PRAGMA user_version = ${String(v)}`);
}

// Applies pending migrations inside a single transaction. Throws (and rolls back) on any failure.
export function runMigrations(db: DatabaseSync): void {
  const start = currentUserVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > start);
  if (pending.length === 0) return;
  db.exec("BEGIN");
  try {
    for (const m of pending) {
      db.exec(m.sql);
      setUserVersion(db, m.version);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
