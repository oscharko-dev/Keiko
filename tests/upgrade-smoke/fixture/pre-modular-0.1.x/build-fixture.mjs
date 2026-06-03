// Deterministic builder for the binary SQLite fixture at home/.keiko/keiko-ui.db.
//
// Re-run after a schema change so the committed .db tracks the current migration set.
// Usage (from this directory):
//   node --experimental-sqlite build-fixture.mjs
//
// Why a build script and not a captured 0.1.x customer DB:
//   * 0.1.x and post-modular use the same schema (issue #175 explorer verdict).
//   * Reproducibility: a reviewer can regenerate the binary and diff it.
//   * No customer data: every seeded value is a literal placeholder.

import { DatabaseSync } from "node:sqlite";
import { rmSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const OUT = resolve(import.meta.dirname, "home/.keiko/keiko-ui.db");

const SCHEMA_V1 = `
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

const SCHEMA_V2 = `
ALTER TABLE chat_messages ADD COLUMN task_type TEXT;
`;

// Stable placeholder values so the binary file is byte-stable across rebuilds.
const PROJECT_PATH = "/keiko-fixture-project";
const PROJECT_NAME = "fixture-project";
const PROJECT_TIMESTAMP = 1700000000000;

const CHAT_ID = "chat-fixture-0001";
const CHAT_TITLE = "fixture chat";
const CHAT_MODEL = "fixture-model";

const MESSAGE_ID = "msg-fixture-0001";
const MESSAGE_CONTENT = "fixture chat message body";

if (existsSync(OUT)) rmSync(OUT);
mkdirSync(dirname(OUT), { recursive: true });

const db = new DatabaseSync(OUT);
db.exec("PRAGMA foreign_keys = ON");
db.exec("BEGIN");
db.exec(SCHEMA_V1);
db.exec("PRAGMA user_version = 1");
db.exec(SCHEMA_V2);
db.exec("PRAGMA user_version = 2");

db.prepare(
  "INSERT INTO projects (path, name, favorite, created_at, last_opened_at) VALUES (?, ?, 0, ?, ?)",
).run(PROJECT_PATH, PROJECT_NAME, PROJECT_TIMESTAMP, PROJECT_TIMESTAMP);

db.prepare(
  "INSERT INTO chats (id, project_path, title, selected_model, branch_label, status, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)",
).run(CHAT_ID, PROJECT_PATH, CHAT_TITLE, CHAT_MODEL, PROJECT_TIMESTAMP, PROJECT_TIMESTAMP);

db.prepare(
  "INSERT INTO chat_messages (id, chat_id, role, content, timestamp, run_id, workflow_id, workflow_status, short_result, task_type) VALUES (?, ?, 'user', ?, ?, NULL, NULL, NULL, NULL, NULL)",
).run(MESSAGE_ID, CHAT_ID, MESSAGE_CONTENT, PROJECT_TIMESTAMP);

db.exec("COMMIT");
db.close();

console.log(`built ${OUT}`);
